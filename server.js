"use strict";
require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const Database = require("better-sqlite3");

const PORT = Number(process.env.PORT || 3000);
const MODE = (process.env.PAYMENT_MODE || "razorpay").toLowerCase();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const REG_OPEN = new Date(process.env.REG_OPEN || "2026-11-01T00:00:00+05:30");
const REG_CLOSE = new Date(process.env.REG_CLOSE || "2026-12-20T23:59:59+05:30");
const DB_PATH = process.env.DB_PATH || "./data/registrations.db";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

// Prices live on the server only. The browser never decides the amount.
const PLANS = {
  team: { label: "Team of 3-4", amountPaise: 29900, minOthers: 2, maxOthers: 3 },
  solo: { label: "Solo", amountPaise: 9900, minOthers: 0, maxOthers: 0 },
};
const TRACKS = ["AI & Automation", "Product & Apps", "Growth & Media Tech"];

if (MODE !== "mock" && MODE !== "razorpay") {
  console.error('PAYMENT_MODE must be "razorpay" or "mock".');
  process.exit(1);
}
if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 16) {
  console.error("Set ADMIN_TOKEN in .env to a random string of at least 16 characters.");
  process.exit(1);
}

let razorpay = null;
if (MODE === "razorpay") {
  const need = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("Missing in .env: " + missing.join(", "));
    process.exit(1);
  }
  const Razorpay = require("razorpay");
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
} else {
  console.warn("PAYMENT_MODE=mock: payments are simulated. Do not use this for real registrations.");
}

// ---------- database ----------
fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS registrations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT UNIQUE,
    plan            TEXT NOT NULL,
    track           TEXT NOT NULL,
    team_name       TEXT,
    leader_name     TEXT NOT NULL,
    email           TEXT NOT NULL,
    phone           TEXT NOT NULL,
    college         TEXT NOT NULL,
    members         TEXT,
    amount_paise    INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    order_id        TEXT UNIQUE,
    payment_id      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    paid_at         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_reg_email ON registrations(email);
  CREATE INDEX IF NOT EXISTS idx_reg_status ON registrations(status);
`);

const q = {
  paidByEmail: db.prepare("SELECT id FROM registrations WHERE email = ? AND status = 'paid' LIMIT 1"),
  paidByPhone: db.prepare("SELECT id FROM registrations WHERE phone = ? AND status = 'paid' LIMIT 1"),
  insert: db.prepare(`INSERT INTO registrations
    (plan, track, team_name, leader_name, email, phone, college, members, amount_paise)
    VALUES (@plan, @track, @team_name, @leader_name, @email, @phone, @college, @members, @amount_paise)`),
  setOrder: db.prepare("UPDATE registrations SET order_id = ? WHERE id = ?"),
  byOrder: db.prepare("SELECT * FROM registrations WHERE order_id = ?"),
  markPaid: db.prepare(`UPDATE registrations
    SET status = 'paid', payment_id = ?, paid_at = datetime('now'),
        code = COALESCE(code, ?)
    WHERE order_id = ? AND status != 'paid'`),
  deleteById: db.prepare("DELETE FROM registrations WHERE id = ?"),
  all: db.prepare("SELECT * FROM registrations ORDER BY id DESC"),
  counts: db.prepare(`SELECT plan, COUNT(*) AS n FROM registrations WHERE status = 'paid' GROUP BY plan`),
};

function makeCode() {
  // e.g. SFX-7K4Q9M. No 0/O/1/I to avoid mix-ups when read out loud.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) out += chars[bytes[i] % chars.length];
  return "SFX-" + out;
}

function finalizePaid(orderId, paymentId) {
  // Safe to call many times (browser verify and webhook can both arrive).
  for (let tries = 0; tries < 5; tries++) {
    try {
      q.markPaid.run(paymentId || null, makeCode(), orderId);
      break;
    } catch (e) {
      if (!String(e.message).includes("UNIQUE")) throw e;
    }
  }
  return q.byOrder.get(orderId);
}

// ---------- app ----------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

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
app.post("/api/webhook/razorpay", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
  if (MODE !== "razorpay") return res.sendStatus(404);
  const signature = req.get("X-Razorpay-Signature") || "";
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(req.body)
    .digest("hex");
  if (!safeEqual(signature, expected)) return res.status(400).json({ error: "bad signature" });

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "bad json" });
  }
  const type = event.event;
  if (type === "payment.captured" || type === "order.paid") {
    const payment = event.payload && event.payload.payment && event.payload.payment.entity;
    const orderId = payment && payment.order_id;
    const row = orderId && q.byOrder.get(orderId);
    // Only accept it if the amount matches what we asked for.
    if (row && payment.amount === row.amount_paise) finalizePaid(orderId, payment.id);
  }
  res.json({ ok: true });
});

app.use(express.json({ limit: "20kb" }));

const registerLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const verifyLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function clean(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
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
  if (plan === "team") {
    team_name = clean(body.teamName, 60);
    if (team_name.length < 2) errors.push("Enter your team name.");
    const raw = Array.isArray(body.members) ? body.members : String(body.members || "").split(/[\n,]/);
    const list = raw.map((m) => clean(m, 80)).filter((m) => m.length > 1);
    if (list.length < cfg.minOthers || list.length > cfg.maxOthers) {
      errors.push("List the other 2 or 3 team members.");
    }
    members = JSON.stringify(list);
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
      amount_paise: cfg.amountPaise,
    },
  };
}

app.get("/api/config", (req, res) => {
  res.json({
    mode: MODE,
    keyId: MODE === "razorpay" ? process.env.RAZORPAY_KEY_ID : null,
    plans: { team: PLANS.team.amountPaise, solo: PLANS.solo.amountPaise },
    opensAt: REG_OPEN.toISOString(),
    closesAt: REG_CLOSE.toISOString(),
  });
});

app.post("/api/register", registerLimiter, async (req, res) => {
  const now = new Date();
  if (now < REG_OPEN) return res.status(403).json({ error: "Registration has not opened yet." });
  if (now > REG_CLOSE) return res.status(403).json({ error: "Registration is closed." });

  const { errors, value } = validate(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  if (q.paidByEmail.get(value.email) || q.paidByPhone.get(value.phone)) {
    return res.status(409).json({ error: "This email or phone number is already registered." });
  }

  const info = q.insert.run(value);
  const id = info.lastInsertRowid;
  try {
    let order;
    if (MODE === "razorpay") {
      order = await razorpay.orders.create({
        amount: value.amount_paise,
        currency: "INR",
        receipt: "reg_" + id,
        notes: { registration_id: String(id), plan: value.plan, email: value.email },
      });
    } else {
      order = { id: "order_mock_" + crypto.randomBytes(8).toString("hex"), amount: value.amount_paise };
    }
    q.setOrder.run(order.id, id);
    res.json({
      orderId: order.id,
      amount: value.amount_paise,
      currency: "INR",
      keyId: MODE === "razorpay" ? process.env.RAZORPAY_KEY_ID : null,
      mock: MODE === "mock",
      description: PLANS[value.plan].label + " entry, Scalefox Hack'26",
      prefill: { name: value.leader_name, email: value.email, contact: value.phone },
    });
  } catch (e) {
    q.deleteById.run(id);
    console.error("order create failed:", e && e.error ? e.error : e);
    res.status(502).json({ error: "Could not start the payment. Please try again in a minute." });
  }
});

app.post("/api/verify", verifyLimiter, (req, res) => {
  const orderId = clean(req.body.razorpay_order_id, 80);
  const paymentId = clean(req.body.razorpay_payment_id, 80);
  const signature = clean(req.body.razorpay_signature, 200);
  const row = q.byOrder.get(orderId);
  if (!row) return res.status(404).json({ error: "Unknown order." });

  let ok = false;
  if (MODE === "razorpay") {
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(orderId + "|" + paymentId)
      .digest("hex");
    ok = safeEqual(signature, expected);
  } else {
    ok = orderId.startsWith("order_mock_") && signature === "mock";
  }
  if (!ok) return res.status(400).json({ error: "Payment could not be verified." });

  const done = finalizePaid(orderId, paymentId || "mock_payment");
  res.json({ ok: true, code: done.code, plan: done.plan, email: done.email });
});

app.get("/api/stats", (req, res) => {
  const out = { team: 0, solo: 0 };
  for (const r of q.counts.all()) out[r.plan] = r.n;
  res.json(out);
});

// ---------- admin ----------
function adminOnly(req, res, next) {
  const header = req.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !safeEqual(token, ADMIN_TOKEN)) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function present(r) {
  return {
    id: r.id,
    code: r.code,
    status: r.status,
    plan: r.plan,
    track: r.track,
    teamName: r.team_name,
    leaderName: r.leader_name,
    email: r.email,
    phone: r.phone,
    college: r.college,
    members: r.members ? JSON.parse(r.members) : [],
    amount: r.amount_paise / 100,
    orderId: r.order_id,
    paymentId: r.payment_id,
    createdAt: r.created_at,
    paidAt: r.paid_at,
  };
}

app.get("/api/admin/registrations", adminLimiter, adminOnly, (req, res) => {
  const rows = q.all.all().map(present);
  const paid = rows.filter((r) => r.status === "paid");
  res.json({
    summary: {
      total: rows.length,
      paid: paid.length,
      pending: rows.length - paid.length,
      team: paid.filter((r) => r.plan === "team").length,
      solo: paid.filter((r) => r.plan === "solo").length,
      revenue: paid.reduce((s, r) => s + r.amount, 0),
    },
    rows,
  });
});

function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
}

app.get("/api/admin/export.csv", adminLimiter, adminOnly, (req, res) => {
  const onlyPaid = req.query.paid !== "0";
  const rows = q.all.all().map(present).filter((r) => !onlyPaid || r.status === "paid");
  const head = ["Code", "Status", "Plan", "Track", "Team", "Leader", "Email", "Phone", "College", "Members", "Amount INR", "Order", "Payment", "Created", "Paid"];
  const lines = [head.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [r.code, r.status, r.plan, r.track, r.teamName, r.leaderName, r.email, r.phone, r.college, r.members.join("; "), r.amount, r.orderId, r.paymentId, r.createdAt, r.paidAt]
        .map(csvCell)
        .join(",")
    );
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="scalefox-hack-registrations.csv"');
  res.send(lines.join("\r\n"));
});

// ---------- static site ----------
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
});

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => console.log("Scalefox Hack backend running on http://localhost:" + PORT + " (" + MODE + " mode)"));
}
module.exports = app;
