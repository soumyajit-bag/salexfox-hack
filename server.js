"use strict";
require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);
const MODE = (process.env.PAYMENT_MODE || "razorpay").toLowerCase();
const NODE_ENV = process.env.NODE_ENV || "development";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const REG_OPEN = new Date(process.env.REG_OPEN || "2026-11-01T00:00:00+05:30");
const REG_CLOSE = new Date(process.env.REG_CLOSE || "2026-12-20T23:59:59+05:30");
const DATABASE_URL = process.env.DATABASE_URL || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

// Prices live on the server only. The browser never decides the amount.
const PLANS = {
  team: { label: "Team of 3-4", amountPaise: 29900, minOthers: 2, maxOthers: 3 },
  solo: { label: "Solo", amountPaise: 9900, minOthers: 0, maxOthers: 0 },
};
const TRACKS = ["AI & Automation", "Product & Apps", "Growth & Media Tech"];

// Production safety validations
if (MODE !== "mock" && MODE !== "razorpay") {
  console.error('PAYMENT_MODE must be "razorpay" or "mock".');
  process.exit(1);
}
if (NODE_ENV === "production" && MODE === "mock") {
  console.error("FATAL: PAYMENT_MODE=mock is forbidden in production environment.");
  process.exit(1);
}
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 16) {
  console.error("Set ADMIN_TOKEN in .env to a random string of at least 16 characters.");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("Set DATABASE_URL to a pooled Neon Postgres connection string.");
  process.exit(1);
}

let razorpay = null;
const missingPaymentConfig = MODE === "razorpay"
  ? ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"].filter((key) => !process.env[key])
  : [];
const PAYMENT_CONFIGURED = MODE === "mock" || missingPaymentConfig.length === 0;
if (MODE === "razorpay") {
  if (missingPaymentConfig.length) {
    console.error("Payments are unavailable; missing required environment variables: " + missingPaymentConfig.join(", "));
  } else {
    const Razorpay = require("razorpay");
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
} else {
  console.warn("PAYMENT_MODE=mock: payments are simulated. Do not use this for real registrations.");
}

// ---------- database ----------
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: process.env.VERCEL ? 1 : 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});
if (process.env.VERCEL) {
  try {
    require("@vercel/functions").attachDatabasePool(pool);
  } catch (err) {
    console.warn("Could not attach Vercel database pool helper:", err.message);
  }
}

async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Database rollback failed:", rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

const q = {
  async paidByEmail(email) {
    const result = await pool.query(
      "SELECT id FROM registrations WHERE email = $1 AND status = 'paid' LIMIT 1",
      [email]
    );
    return result.rows[0] || null;
  },

  async paidByPhone(phone) {
    const result = await pool.query(
      "SELECT id FROM registrations WHERE phone = $1 AND status = 'paid' LIMIT 1",
      [phone]
    );
    return result.rows[0] || null;
  },

  async insertRegistration(value) {
    return withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO registrations
          (plan, track, team_name, leader_name, email, phone, college, members, member_count, amount_paise, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
         RETURNING *`,
        [
          value.plan,
          value.track,
          value.team_name,
          value.leader_name,
          value.email,
          value.phone,
          value.college,
          value.members,
          value.member_count,
          value.amount_paise,
        ]
      );
      const registration = result.rows[0];

      for (let i = 0; i < (value.member_names || []).length; i++) {
        await client.query(
          "INSERT INTO team_members (registration_id, position, full_name) VALUES ($1, $2, $3)",
          [registration.id, i + 1, value.member_names[i]]
        );
      }

      await client.query(
        `INSERT INTO payments
          (registration_id, amount_paise, currency, status, verification_status)
         VALUES ($1, $2, 'INR', 'pending', 'unverified')`,
        [registration.id, value.amount_paise]
      );
      return registration;
    });
  },

  async attachOrder(registrationId, order) {
    return withTransaction(async (client) => {
      const registration = await client.query(
        "UPDATE registrations SET order_id = $1 WHERE id = $2 AND order_id IS NULL",
        [order.id, registrationId]
      );
      if (registration.rowCount !== 1) throw new Error("Could not attach the Razorpay order to its registration.");
      const result = await client.query(
        `UPDATE payments
         SET order_id = $1, amount_paise = $2, currency = $3, updated_at = NOW()
         WHERE registration_id = $4 AND order_id IS NULL AND status = 'pending'
         RETURNING id`,
        [order.id, order.amount, order.currency, registrationId]
      );
      if (result.rowCount !== 1) throw new Error("Could not attach the Razorpay order to its pending payment.");
    });
  },

  async failOrder(registrationId, orderId, reason) {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE payments
         SET status = 'failed', failure_reason = $1, updated_at = NOW()
         WHERE registration_id = $2 AND order_id = $3 AND status = 'pending'`,
        [reason, registrationId, orderId]
      );
      await client.query(
        "UPDATE registrations SET status = 'failed' WHERE id = $1 AND status = 'pending'",
        [registrationId]
      );
    });
  },

  async failOrderCreation(registrationId, reason) {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE payments
         SET status = 'failed', failure_reason = $1, updated_at = NOW()
         WHERE registration_id = $2 AND order_id IS NULL AND status = 'pending'`,
        [reason, registrationId]
      );
      await client.query(
        "UPDATE registrations SET status = 'failed' WHERE id = $1 AND status = 'pending'",
        [registrationId]
      );
    });
  },

  async byOrder(orderId, client = pool) {
    const result = await client.query(
      "SELECT * FROM registrations WHERE order_id = $1",
      [orderId]
    );
    return result.rows[0] || null;
  },

  async paymentByOrder(orderId, client = pool) {
    const result = await client.query(
      "SELECT * FROM payments WHERE order_id = $1 ORDER BY id DESC LIMIT 1",
      [orderId]
    );
    return result.rows[0] || null;
  },

  async paymentAttempts(registrationId, client = pool) {
    const result = await client.query(
      `SELECT id, order_id, payment_id, amount_paise, currency, status,
              verification_status, failure_reason, error_code, error_description,
              refund_id, refund_amount_paise, created_at, updated_at, paid_at, refunded_at,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'refund_id', pr.refund_id,
                  'amount_paise', pr.amount_paise,
                  'currency', pr.currency,
                  'created_at', pr.created_at
                ) ORDER BY pr.created_at DESC)
                FROM payment_refunds pr
                WHERE pr.payment_record_id = payments.id
              ), '[]'::JSON) AS refunds
       FROM payments
       WHERE registration_id = $1
       ORDER BY created_at DESC, id DESC`,
      [registrationId]
    );
    return result.rows;
  },

  async teamMembers(registrationId, client = pool) {
    const result = await client.query(
      `SELECT full_name, email, phone, college
       FROM team_members
       WHERE registration_id = $1
       ORDER BY position`,
      [registrationId]
    );
    return result.rows;
  },

  async all() {
    const result = await pool.query(
      `SELECT r.*,
              p.id AS payment_record_id,
              p.payment_id AS payment_record_payment_id,
              p.amount_paise AS payment_amount_paise,
              p.currency AS payment_currency,
              p.status AS payment_status,
              p.verification_status,
              p.failure_reason,
              p.error_code,
              p.error_description,
              p.refund_id,
              p.refund_amount_paise,
              p.created_at AS payment_created_at,
              p.paid_at AS payment_paid_at,
              p.refunded_at,
              COALESCE(m.names, r.members::JSON, '[]'::JSON) AS member_names
       FROM registrations r
       LEFT JOIN LATERAL (
         SELECT p.*
         FROM payments p
         WHERE p.registration_id = r.id
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT 1
       ) p ON TRUE
       LEFT JOIN LATERAL (
         SELECT json_agg(tm.full_name ORDER BY tm.position) AS names
         FROM team_members tm
         WHERE tm.registration_id = r.id
       ) m ON TRUE
       ORDER BY r.id DESC`
    );
    return result.rows;
  },

  async adminRegistration(id) {
    const result = await pool.query("SELECT * FROM registrations WHERE id = $1", [id]);
    return result.rows[0] || null;
  },

  async counts() {
    const result = await pool.query(
      "SELECT plan, COUNT(*) AS n FROM registrations WHERE status = 'paid' GROUP BY plan"
    );
    return result.rows;
  },

  async adminSummary() {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM registrations) AS total,
        (SELECT COUNT(*) FROM registrations WHERE status = 'paid') AS paid,
        (SELECT COUNT(*) FROM registrations WHERE status = 'pending') AS pending,
        (SELECT COUNT(*) FROM registrations WHERE plan = 'team') AS team,
        (SELECT COUNT(*) FROM registrations WHERE plan = 'solo') AS solo,
        (SELECT COUNT(*) FROM payments WHERE status = 'failed') AS failed,
        COALESCE((
          SELECT SUM(GREATEST(amount_paise - refund_amount_paise, 0))
          FROM payments
          WHERE status IN ('paid', 'refunded') AND verification_status = 'verified'
        ), 0) AS revenue_paise
    `);
    const r = result.rows[0];
    return {
      total: Number(r.total || 0),
      paid: Number(r.paid || 0),
      pending: Number(r.pending || 0),
      team: Number(r.team || 0),
      solo: Number(r.solo || 0),
      failed: Number(r.failed || 0),
      revenue: Number(r.revenue_paise || 0) / 100,
    };
  },
};

function makeCode() {
  // e.g. SFX-7K4Q9M. No 0/O/1/I to avoid mix-ups when read out loud.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) out += chars[bytes[i] % chars.length];
  return "SFX-" + out;
}

async function finalizePaid(orderId, paymentId, amountPaise, currency, client = null) {
  const apply = async (tx) => {
    const regResult = await tx.query(
      "SELECT * FROM registrations WHERE order_id = $1 FOR UPDATE",
      [orderId]
    );
    const registration = regResult.rows[0];
    if (!registration) throw new Error("Unknown registration order.");

    if (
      !Number.isSafeInteger(Number(amountPaise)) ||
      Number(amountPaise) !== Number(registration.amount_paise) ||
      String(currency).toUpperCase() !== "INR"
    ) {
      throw new Error("Verified payment amount or currency does not match the registration.");
    }

    let paymentResult = await tx.query(
      "SELECT * FROM payments WHERE payment_id = $1 FOR UPDATE",
      [paymentId]
    );
    let payment = paymentResult.rows[0];
    if (payment && (payment.registration_id !== registration.id || payment.order_id !== orderId)) {
      throw new Error("Payment is already associated with another registration or order.");
    }
    if (payment && payment.status === "refunded") return registration;

    if (!payment) {
      paymentResult = await tx.query(
        `SELECT * FROM payments
         WHERE order_id = $1 AND registration_id = $2 AND payment_id IS NULL AND status = 'pending'
         ORDER BY id DESC
         LIMIT 1
         FOR UPDATE`,
        [orderId, registration.id]
      );
      payment = paymentResult.rows[0];
    }

    if (
      payment &&
      (Number(payment.amount_paise) !== Number(amountPaise) ||
        String(payment.currency).toUpperCase() !== String(currency).toUpperCase())
    ) {
      throw new Error("Verified payment amount or currency does not match the stored Razorpay order.");
    }
    if (!payment) {
      const created = await tx.query(
        `INSERT INTO payments
          (registration_id, order_id, amount_paise, currency, status, verification_status)
         VALUES ($1, $2, $3, $4, 'pending', 'unverified')
         RETURNING *`,
        [registration.id, orderId, amountPaise, currency]
      );
      payment = created.rows[0];
    }

    let code = registration.code;
    if (!code) {
      for (let tries = 0; tries < 5; tries++) {
        const candidate = makeCode();
        const codeCheck = await tx.query("SELECT 1 FROM registrations WHERE code = $1", [candidate]);
        if (codeCheck.rowCount === 0) {
          code = candidate;
          break;
        }
      }
      if (!code) throw new Error("Could not allocate a unique registration code.");
    }

    await tx.query(
      `UPDATE payments
       SET payment_id = $1,
           status = 'paid',
           verification_status = 'verified',
           failure_reason = NULL,
           error_code = NULL,
           error_description = NULL,
           paid_at = COALESCE(paid_at, NOW()),
           updated_at = NOW()
       WHERE id = $2`,
      [paymentId, payment.id]
    );
    const updated = await tx.query(
      `UPDATE registrations
       SET status = CASE WHEN status = 'refunded' THEN status ELSE 'paid' END,
           payment_id = COALESCE(payment_id, $1),
           paid_at = COALESCE(paid_at, NOW()),
           code = COALESCE(code, $2)
       WHERE id = $3
       RETURNING *`,
      [paymentId, code, registration.id]
    );
    return updated.rows[0];
  };

  return client ? apply(client) : withTransaction(apply);
}

async function recordFailedPayment(client, orderId, data) {
  const regResult = await client.query(
    "SELECT * FROM registrations WHERE order_id = $1 FOR UPDATE",
    [orderId]
  );
  const registration = regResult.rows[0];
  if (!registration) return;
  if (
    Number(data.amount) !== Number(registration.amount_paise) ||
    String(data.currency).toUpperCase() !== "INR"
  ) {
    throw new Error("Failed payment amount or currency does not match the registration.");
  }

  let result = await client.query(
    "SELECT * FROM payments WHERE payment_id = $1 FOR UPDATE",
    [data.paymentId]
  );
  let payment = result.rows[0];
  if (payment && (payment.registration_id !== registration.id || payment.order_id !== orderId)) {
    throw new Error("Failed payment is already associated with another registration or order.");
  }
  if (payment && ["paid", "refunded"].includes(payment.status)) return;
  if (!payment) {
    result = await client.query(
      `SELECT * FROM payments
       WHERE order_id = $1 AND registration_id = $2 AND payment_id IS NULL AND status = 'pending'
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [orderId, registration.id]
    );
    payment = result.rows[0];
  }
  if (
    payment &&
    (Number(payment.amount_paise) !== Number(data.amount) ||
      String(payment.currency).toUpperCase() !== String(data.currency).toUpperCase())
  ) {
    throw new Error("Failed payment amount or currency does not match the stored Razorpay order.");
  }
  if (!payment) {
    const created = await client.query(
      `INSERT INTO payments
        (registration_id, order_id, payment_id, amount_paise, currency, status, verification_status)
       VALUES ($1, $2, $3, $4, $5, 'failed', 'verified')
       RETURNING id`,
      [registration.id, orderId, data.paymentId, data.amount, data.currency]
    );
    payment = { id: created.rows[0].id };
  }
  await client.query(
    `UPDATE payments
     SET payment_id = $1,
         status = 'failed',
         verification_status = 'verified',
         failure_reason = $2,
         error_code = $3,
         error_description = $4,
         updated_at = NOW()
     WHERE id = $5`,
    [data.paymentId, data.reason, data.code, data.description, payment.id]
  );
  await client.query(
    "UPDATE registrations SET status = 'failed' WHERE id = $1 AND status = 'pending'",
    [registration.id]
  );
}

async function recordRefund(client, refund) {
  const result = await client.query(
    "SELECT * FROM payments WHERE payment_id = $1 FOR UPDATE",
    [refund.paymentId]
  );
  const payment = result.rows[0];
  if (!payment) return;
  if (!["paid", "refunded"].includes(payment.status)) return;
  const duplicate = await client.query(
    "SELECT 1 FROM payment_refunds WHERE refund_id = $1",
    [refund.refundId]
  );
  if (duplicate.rowCount > 0) return;
  if (
    !Number.isSafeInteger(Number(refund.amount)) ||
    Number(refund.amount) <= 0 ||
    Number(payment.refund_amount_paise || 0) + Number(refund.amount) > Number(payment.amount_paise) ||
    (refund.currency && String(refund.currency).toUpperCase() !== String(payment.currency).toUpperCase())
  ) {
    throw new Error("Refund amount or currency does not match the verified payment.");
  }

  await client.query(
    `INSERT INTO payment_refunds (payment_record_id, refund_id, amount_paise, currency)
     VALUES ($1, $2, $3, $4)`,
    [payment.id, refund.refundId, refund.amount, refund.currency || payment.currency]
  );
  const refundTotal = Number(payment.refund_amount_paise || 0) + Number(refund.amount);
  const isRefunded = refundTotal >= Number(payment.amount_paise);
  await client.query(
    `UPDATE payments
     SET refund_id = $1,
         refund_amount_paise = $2,
         status = CASE WHEN $3 THEN 'refunded' ELSE status END,
         refunded_at = CASE WHEN $3 THEN COALESCE(refunded_at, NOW()) ELSE refunded_at END,
         updated_at = NOW()
     WHERE id = $4`,
    [refund.refundId, refundTotal, isRefunded, payment.id]
  );
  if (isRefunded) {
    const otherPaid = await client.query(
      "SELECT 1 FROM payments WHERE registration_id = $1 AND id != $2 AND status = 'paid' LIMIT 1",
      [payment.registration_id, payment.id]
    );
    if (otherPaid.rowCount === 0) {
      await client.query(
        "UPDATE registrations SET status = 'refunded' WHERE id = $1 AND status = 'paid'",
        [payment.registration_id]
      );
    }
  }
}

// ---------- app ----------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});

// Webhook needs the raw body to check the signature, so it is registered before express.json().
app.post(
  "/api/webhook/razorpay",
  express.raw({ type: "*/*", limit: "1mb" }),
  asyncRoute(async (req, res) => {
    if (MODE !== "razorpay") return res.sendStatus(404);
    if (!PAYMENT_CONFIGURED) {
      return res.status(503).json({ error: "Razorpay payments are not configured." });
    }
    const signature = req.get("X-Razorpay-Signature") || "";
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");
    if (!safeEqual(signature, expected)) return res.status(400).json({ error: "bad signature" });

    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "bad json" });
    }

    const type = clean(event.event, 100);
    const eventId = clean(req.get("X-Razorpay-Event-Id"), 200) ||
      crypto.createHash("sha256").update(rawBody).digest("hex");
    let payment = event.payload && event.payload.payment && event.payload.payment.entity;
    if (type === "order.paid" && !payment) {
      const order = event.payload && event.payload.order && event.payload.order.entity;
      if (order && order.id) {
        const fetched = await razorpay.orders.fetchPayments(order.id);
        const payments = Array.isArray(fetched && fetched.items) ? fetched.items : [];
        payment = payments.find((item) => item.order_id === order.id && item.status === "captured") || null;
      }
    }
    await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO webhook_events (event_id, event_type)
         VALUES ($1, $2)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [eventId, type || "unknown"]
      );
      if (inserted.rowCount === 0) return;

      let outcome = "ignored";
      if ((type === "payment.captured" || type === "order.paid") && payment) {
        if (payment.order_id && payment.id) {
          await finalizePaid(
            payment.order_id,
            payment.id,
            Number(payment.amount),
            payment.currency,
            client
          );
          outcome = "payment_captured";
        }
      } else if (type === "payment.failed" && payment) {
        if (payment.order_id && payment.id) {
          await recordFailedPayment(client, payment.order_id, {
            paymentId: payment.id,
            amount: Number(payment.amount),
            currency: payment.currency,
            reason: clean(payment.error_description || payment.error_reason || "Payment failed", 255),
            code: clean(payment.error_code, 50) || null,
            description: clean(payment.error_description, 255) || null,
          });
          outcome = "payment_failed";
        }
      } else if (type === "refund.processed") {
        const refund = event.payload && event.payload.refund && event.payload.refund.entity;
        if (refund && refund.id && refund.payment_id) {
          await recordRefund(client, {
            refundId: refund.id,
            paymentId: refund.payment_id,
            amount: Number(refund.amount),
            currency: refund.currency,
          });
          outcome = "refund_processed";
        }
      }

      await client.query(
        "UPDATE webhook_events SET processed_at = NOW(), outcome = $1 WHERE event_id = $2",
        [outcome, eventId]
      );
    });
    res.json({ ok: true });
  })
);

app.use(express.json({ limit: "20kb" }));

const registerLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const verifyLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function clean(v, max) {
  return String(v == null ? "" : v)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function validate(body) {
  const errors = [];
  const plan = clean(body.plan, 10);
  if (!PLANS[plan]) return { errors: ["Choose Team or Solo."] };
  const cfg = PLANS[plan];

  const track = clean(body.track, 40);
  if (!TRACKS.includes(track)) errors.push("Choose a valid track.");

  const leader_name = clean(body.leaderName, 80);
  if (leader_name.length < 2) errors.push(plan === "team" ? "Enter the team leader's name." : "Enter your name.");

  const email = clean(body.email, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.push("Enter a valid email address.");

  let phone = clean(body.phone, 20).replace(/[^0-9]/g, "");
  if (phone.length === 12 && phone.startsWith("91")) phone = phone.slice(2);
  if (phone.length === 11 && phone.startsWith("0")) phone = phone.slice(1);
  if (!/^[6-9][0-9]{9}$/.test(phone)) errors.push("Enter a valid 10-digit Indian mobile number.");

  const college = clean(body.college, 120);
  if (college.length < 2) errors.push("Enter your college name.");

  let team_name = null;
  let members = null;
  let member_count = 1;
  let member_names = [];

  if (plan === "team") {
    team_name = clean(body.teamName, 60);
    if (team_name.length < 2) errors.push("Enter your team name.");
    const raw = Array.isArray(body.members) ? body.members : String(body.members || "").split(/[\n,]/);
    const list = raw.map((m) => clean(m, 80)).filter((m) => m.length > 1);
    if (list.length < cfg.minOthers || list.length > cfg.maxOthers) {
      errors.push("List the other 2 or 3 team members.");
    }
    member_names = list;
    members = JSON.stringify(list);
    member_count = 1 + list.length;
  }

  return {
    errors,
    value: {
      plan,
      track,
      team_name,
      leader_name,
      email,
      phone,
      college,
      members,
      member_names,
      member_count,
      amount_paise: cfg.amountPaise,
    },
  };
}

app.get("/api/config", (req, res) => {
  res.json({
    mode: MODE,
    paymentsAvailable: PAYMENT_CONFIGURED,
    keyId: MODE === "razorpay" ? process.env.RAZORPAY_KEY_ID : null,
    plans: { team: PLANS.team.amountPaise, solo: PLANS.solo.amountPaise },
    opensAt: REG_OPEN.toISOString(),
    closesAt: REG_CLOSE.toISOString(),
  });
});

app.post(
  "/api/register",
  registerLimiter,
  asyncRoute(async (req, res) => {
    if (!PAYMENT_CONFIGURED) {
      return res.status(503).json({ error: "Online registration is temporarily unavailable while payments are being configured." });
    }
    const now = new Date();
    if (now < REG_OPEN) return res.status(403).json({ error: "Registration has not opened yet." });
    if (now > REG_CLOSE) return res.status(403).json({ error: "Registration is closed." });

    const { errors, value } = validate(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join(" ") });

    if ((await q.paidByEmail(value.email)) || (await q.paidByPhone(value.phone))) {
      return res.status(409).json({ error: "This email or phone number is already registered." });
    }

    const reg = await q.insertRegistration(value);
    let order;
    try {
      if (MODE === "razorpay") {
        order = await razorpay.orders.create({
          amount: value.amount_paise,
          currency: "INR",
          receipt: "reg_" + reg.id,
          notes: { registration_id: String(reg.id), plan: value.plan, email: value.email },
        });
      } else {
        order = {
          id: "order_mock_" + crypto.randomBytes(8).toString("hex"),
          amount: value.amount_paise,
          currency: "INR",
        };
      }
    } catch (error) {
      await q.failOrderCreation(reg.id, "Razorpay order creation failed.");
      console.error("Razorpay order creation failed:", error && error.statusCode ? error.statusCode : error.message);
      return res.status(502).json({
        error: "Your registration was saved, but payment could not be started. Contact the organizers with registration ID " + reg.id + ".",
        registrationId: reg.id,
      });
    }

    const storedOrder = {
      id: clean(order && order.id, 80),
      amount: Number(order && order.amount),
      currency: clean(order && order.currency, 3).toUpperCase(),
    };
    if (!storedOrder.id || !Number.isSafeInteger(storedOrder.amount) || !storedOrder.currency) {
      await q.failOrderCreation(reg.id, "Razorpay returned an invalid order.");
      return res.status(502).json({
        error: "Your registration was saved, but the payment order could not be validated. Contact the organizers with registration ID " + reg.id + ".",
        registrationId: reg.id,
      });
    }

    await q.attachOrder(reg.id, storedOrder);
    if (storedOrder.amount !== value.amount_paise || storedOrder.currency !== "INR") {
      await q.failOrder(reg.id, storedOrder.id, "Razorpay order amount or currency did not match the registration.");
      return res.status(502).json({
        error: "Your registration was saved, but the payment order could not be validated. Contact the organizers with registration ID " + reg.id + ".",
        registrationId: reg.id,
      });
    }

    res.json({
      registrationId: reg.id,
      orderId: storedOrder.id,
      amount: storedOrder.amount,
      currency: storedOrder.currency,
      keyId: MODE === "razorpay" ? process.env.RAZORPAY_KEY_ID : null,
      mock: MODE === "mock",
      description: PLANS[value.plan].label + " entry, Scalefox Hack'26",
      prefill: { name: value.leader_name, email: value.email, contact: value.phone },
    });
  })
);

app.post(
  "/api/verify",
  verifyLimiter,
  asyncRoute(async (req, res) => {
    if (!PAYMENT_CONFIGURED) {
      return res.status(503).json({ error: "Razorpay payments are not configured." });
    }
    const body = req.body || {};
    const orderId = clean(body.razorpay_order_id, 80);
    const paymentId = clean(body.razorpay_payment_id, 80);
    const signature = clean(body.razorpay_signature, 200);
    if (!orderId || !signature || (MODE === "razorpay" && !paymentId)) {
      return res.status(400).json({ error: "Payment verification details are incomplete." });
    }

    const row = await q.byOrder(orderId);
    if (!row) return res.status(404).json({ error: "Unknown order." });

    let verifiedPaymentId = paymentId;
    let verifiedAmount;
    let verifiedCurrency;
    if (MODE === "razorpay") {
      if (orderId.startsWith("order_mock_") || signature === "mock") {
        return res.status(400).json({ error: "Payment could not be verified." });
      }
      const expected = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(orderId + "|" + paymentId)
        .digest("hex");
      if (!safeEqual(signature, expected)) {
        return res.status(400).json({ error: "Payment could not be verified." });
      }

      let payment;
      try {
        payment = await razorpay.payments.fetch(paymentId);
      } catch (error) {
        console.error("Razorpay payment lookup failed:", error && error.statusCode ? error.statusCode : error.message);
        return res.status(502).json({ error: "Payment status could not be confirmed. Please retry." });
      }
      if (
        !payment ||
        payment.id !== paymentId ||
        payment.order_id !== orderId ||
        Number(payment.amount) !== Number(row.amount_paise) ||
        String(payment.currency).toUpperCase() !== "INR"
      ) {
        return res.status(400).json({ error: "Payment details do not match this registration." });
      }

      verifiedAmount = Number(payment.amount);
      verifiedCurrency = payment.currency;
      if (payment.status !== "captured") {
        if (payment.status === "failed") {
          await withTransaction((client) => recordFailedPayment(client, orderId, {
            paymentId,
            amount: verifiedAmount,
            currency: verifiedCurrency,
            reason: clean(payment.error_description || payment.error_reason || "Payment failed", 255),
            code: clean(payment.error_code, 50) || null,
            description: clean(payment.error_description, 255) || null,
          }));
        }
        return res.status(400).json({ error: "Payment has not been captured." });
      }
    } else {
      if (NODE_ENV === "production" || !orderId.startsWith("order_mock_") || signature !== "mock") {
        return res.status(400).json({ error: "Payment could not be verified." });
      }
      verifiedPaymentId = "mock_" + orderId;
      verifiedAmount = Number(row.amount_paise);
      verifiedCurrency = "INR";
    }

    const done = await finalizePaid(orderId, verifiedPaymentId, verifiedAmount, verifiedCurrency);
    if (done.status === "refunded") {
      return res.status(409).json({ error: "This payment has already been refunded." });
    }
    res.json({ ok: true, code: done.code, plan: done.plan, email: done.email });
  })
);

app.get(
  "/api/stats",
  asyncRoute(async (req, res) => {
    const out = { team: 0, solo: 0 };
    for (const r of await q.counts()) out[r.plan] = Number(r.n);
    res.json(out);
  })
);

app.get(
  ["/healthz", "/api/healthz"],
  asyncRoute(async (req, res) => {
    await pool.query("SELECT 1");
    if (!PAYMENT_CONFIGURED) {
      return res.status(503).json({
        ok: false,
        mode: MODE,
        db: "connected",
        payments: "not_configured",
        missingPaymentConfig,
      });
    }
    res.json({ ok: true, mode: MODE, db: "connected", payments: "configured" });
  })
);

// ---------- admin ----------
function adminOnly(req, res, next) {
  const header = req.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !safeEqual(token, ADMIN_TOKEN)) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function present(r) {
  let members = r.member_names;
  if (!Array.isArray(members)) {
    try {
      members = r.members ? JSON.parse(r.members) : [];
    } catch {
      members = [];
    }
  }
  return {
    id: r.id,
    registrationId: r.id,
    code: r.code,
    status: r.status,
    plan: r.plan,
    track: r.track,
    teamName: r.team_name,
    leaderName: r.leader_name,
    email: r.email,
    phone: r.phone,
    college: r.college,
    members,
    memberCount: r.member_count || (r.plan === "team" ? 3 : 1),
    amount: Number(r.payment_amount_paise == null ? r.amount_paise : r.payment_amount_paise) / 100,
    orderId: r.order_id,
    paymentId: r.payment_record_payment_id || r.payment_id,
    paymentStatus: r.payment_status || (r.status === "paid" ? "paid" : "pending"),
    verificationStatus: r.verification_status || "unverified",
    failureReason: r.failure_reason || null,
    errorCode: r.error_code || null,
    errorDescription: r.error_description || null,
    currency: r.payment_currency || "INR",
    createdAt: r.created_at,
    paymentAt: r.payment_paid_at || r.payment_created_at || r.paid_at,
    paidAt: r.payment_paid_at || r.paid_at,
    refundId: r.refund_id || null,
    refundAmount: Number(r.refund_amount_paise || 0) / 100,
    refundedAt: r.refunded_at || null,
  };
}

app.get(
  "/api/admin/registrations",
  adminLimiter,
  adminOnly,
  asyncRoute(async (req, res) => {
    const summary = await q.adminSummary();
    const rows = (await q.all()).map(present);
    res.setHeader("Cache-Control", "no-store");
    res.json({ summary, rows });
  })
);

app.get(
  "/api/admin/registrations/:id",
  adminLimiter,
  adminOnly,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid registration ID." });
    const registration = await q.adminRegistration(id);
    if (!registration) return res.status(404).json({ error: "Registration not found." });

    const [teamMembers, payments] = await Promise.all([
      q.teamMembers(id),
      q.paymentAttempts(id),
    ]);
    const latest = payments[0] || {};
    const details = present({
      ...registration,
      member_names: teamMembers.map((member) => member.full_name),
      payment_record_payment_id: latest.payment_id,
      payment_amount_paise: latest.amount_paise,
      payment_currency: latest.currency,
      payment_status: latest.status,
      verification_status: latest.verification_status,
      failure_reason: latest.failure_reason,
      error_code: latest.error_code,
      error_description: latest.error_description,
      payment_created_at: latest.created_at,
      payment_paid_at: latest.paid_at,
      refund_id: latest.refund_id,
      refund_amount_paise: latest.refund_amount_paise,
      refunded_at: latest.refunded_at,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ registration: details, teamMembers, payments });
  })
);

function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
}

app.get(
  "/api/admin/export.csv",
  adminLimiter,
  adminOnly,
  asyncRoute(async (req, res) => {
    const onlyPaid = req.query.paid !== "0";
    const rows = (await q.all()).map(present).filter((r) => !onlyPaid || r.status === "paid");
    const head = [
      "ID",
      "Code",
      "Status",
      "Plan",
      "Track",
      "Team",
      "Leader",
      "Email",
      "Phone",
      "College",
      "Member Count",
      "Members",
      "Amount INR",
      "Order ID",
      "Payment ID",
      "Payment Status",
      "Created At",
      "Paid At",
    ];
    const lines = [head.map(csvCell).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.id,
          r.code,
          r.status,
          r.plan,
          r.track,
          r.teamName,
          r.leaderName,
          r.email,
          r.phone,
          r.college,
          r.memberCount,
          r.members.join("; "),
          r.amount,
          r.orderId,
          r.paymentId,
          r.paymentStatus,
          r.createdAt,
          r.paidAt,
        ]
          .map(csvCell)
          .join(",")
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="scalefox-hack-registrations.csv"');
    res.send(lines.join("\r\n"));
  })
);

// ---------- static site ----------
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
  if (res.headersSent) return next(err);
  const code = String(err && err.code || "");
  const unavailable =
    code.startsWith("08") ||
    ["28P01", "3D000", "53300", "57P01", "57P03", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(code);
  console.error("Request failed:", code || (err && err.name) || "Error", err && err.message ? err.message : "unknown error");
  if (unavailable) return res.status(503).json({ error: "Database temporarily unavailable. Please retry." });
  res.status(500).json({ error: "Something went wrong." });
});

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () =>
    console.log("Scalefox Hack backend running on http://localhost:" + PORT + " (" + MODE + " mode)")
  );
}

module.exports = app;
