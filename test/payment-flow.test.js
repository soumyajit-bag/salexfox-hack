"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const Module = require("node:module");
const path = require("node:path");
const { after, before, beforeEach, test } = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const razorpaySecret = "test-razorpay-secret";
const webhookSecret = "test-webhook-secret";

const store = {
  registrations: [],
  teamMembers: [],
  payments: [],
  webhookEvents: [],
  paymentRefunds: [],
  nextRegistrationId: 1,
  nextPaymentId: 1,
  nextTeamMemberId: 1,
};

function resetStore() {
  store.registrations = [];
  store.teamMembers = [];
  store.payments = [];
  store.webhookEvents = [];
  store.paymentRefunds = [];
  store.nextRegistrationId = 1;
  store.nextPaymentId = 1;
  store.nextTeamMemberId = 1;
  FakePool.failQueries = false;
  FakeRazorpay.paymentsById.clear();
  FakeRazorpay.nextOrderId = 1;
  if (FakeRazorpay.instance) {
    FakeRazorpay.instance.orders.create = async (order) => ({
      id: "order_test_" + FakeRazorpay.nextOrderId++,
      amount: order.amount,
      currency: order.currency,
    });
    FakeRazorpay.instance.orders.fetchPayments = async (orderId) => ({
      items: Array.from(FakeRazorpay.paymentsById.values())
        .filter((payment) => payment.order_id === orderId),
    });
  }
}

function result(rows = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPayment(values) {
  const payment = {
    id: store.nextPaymentId++,
    registration_id: values.registration_id,
    order_id: values.order_id || null,
    payment_id: values.payment_id || null,
    amount_paise: Number(values.amount_paise),
    currency: values.currency || "INR",
    status: values.status || "pending",
    verification_status: values.verification_status || "unverified",
    failure_reason: null,
    error_code: null,
    error_description: null,
    refund_id: null,
    refund_amount_paise: 0,
    refunded_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    paid_at: null,
  };
  store.payments.push(payment);
  return payment;
}

function queryStore(sql, params = []) {
  const query = String(sql).replace(/\s+/g, " ").trim();
  const normalized = query.toLowerCase();
  const now = new Date().toISOString();

  if (normalized === "select 1") return result([{ "?column?": 1 }]);

  if (normalized.startsWith("select id from registrations where email =")) {
    const row = store.registrations.find((entry) => entry.email === params[0] && entry.status === "paid");
    return result(row ? [{ id: row.id }] : []);
  }
  if (normalized.startsWith("select id from registrations where phone =")) {
    const row = store.registrations.find((entry) => entry.phone === params[0] && entry.status === "paid");
    return result(row ? [{ id: row.id }] : []);
  }
  if (normalized.startsWith("insert into registrations")) {
    const [plan, track, teamName, leaderName, email, phone, college, members, memberCount, amount] = params;
    const row = {
      id: store.nextRegistrationId++,
      code: null,
      plan,
      track,
      team_name: teamName,
      leader_name: leaderName,
      email,
      phone,
      college,
      members,
      member_count: memberCount,
      amount_paise: amount,
      status: "pending",
      order_id: null,
      payment_id: null,
      created_at: now,
      paid_at: null,
    };
    store.registrations.push(row);
    return result([row]);
  }
  if (normalized.startsWith("insert into team_members")) {
    const [registrationId, position, fullName] = params;
    const row = {
      id: store.nextTeamMemberId++,
      registration_id: registrationId,
      position,
      full_name: fullName,
      email: null,
      phone: null,
      college: null,
    };
    store.teamMembers.push(row);
    return result([row]);
  }
  if (normalized.includes("insert into payments") && normalized.includes("'pending', 'unverified'")) {
    if (normalized.includes("values ($1, $2, 'inr'")) {
      const [registrationId, amount] = params;
      return result([createPayment({ registration_id: registrationId, amount_paise: amount })]);
    }
    if (normalized.includes("values ($1, $2, $3, $4")) {
      const [registrationId, orderId, amount, currency] = params;
      return result([createPayment({ registration_id: registrationId, order_id: orderId, amount_paise: amount, currency })]);
    }
  }
  if (normalized.startsWith("update registrations set order_id =")) {
    const [orderId, id] = params;
    const row = store.registrations.find((entry) => entry.id === id && entry.order_id == null);
    if (!row) return result([], 0);
    row.order_id = orderId;
    return result([], 1);
  }
  if (normalized.startsWith("update payments set order_id =")) {
    const [orderId, amount, currency, registrationId] = params;
    const row = store.payments.find((entry) =>
      entry.registration_id === registrationId && entry.order_id == null && entry.status === "pending"
    );
    if (!row) return result([], 0);
    Object.assign(row, { order_id: orderId, amount_paise: amount, currency, updated_at: now });
    return result([{ id: row.id }], 1);
  }
  if (normalized.startsWith("update payments set status = 'failed', failure_reason =")) {
    const [reason, registrationId, orderId] = params;
    const matchesOrder = normalized.includes("order_id is null")
      ? (entry) => entry.order_id == null
      : (entry) => entry.order_id === orderId;
    const rows = store.payments.filter((entry) =>
      entry.registration_id === registrationId && matchesOrder(entry) && entry.status === "pending"
    );
    rows.forEach((entry) => Object.assign(entry, { status: "failed", failure_reason: reason, updated_at: now }));
    return result([], rows.length);
  }
  if (normalized.startsWith("update registrations set status = 'failed'")) {
    const row = store.registrations.find((entry) => entry.id === params[0] && entry.status === "pending");
    if (!row) return result([], 0);
    row.status = "failed";
    return result([], 1);
  }
  if (normalized.startsWith("select * from registrations where order_id =")) {
    const row = store.registrations.find((entry) => entry.order_id === params[0]);
    return result(row ? [row] : []);
  }
  if (normalized.startsWith("select * from registrations where id =")) {
    const row = store.registrations.find((entry) => entry.id === Number(params[0]));
    return result(row ? [row] : []);
  }
  if (normalized.startsWith("select * from payments where payment_id =")) {
    const row = store.payments.find((entry) => entry.payment_id === params[0]);
    return result(row ? [row] : []);
  }
  if (normalized.startsWith("select * from payments") && normalized.includes("payment_id is null")) {
    const [orderId, registrationId] = params;
    const row = store.payments
      .filter((entry) => entry.order_id === orderId && entry.registration_id === registrationId && entry.payment_id == null && entry.status === "pending")
      .sort((a, b) => b.id - a.id)[0];
    return result(row ? [row] : []);
  }
  if (normalized.startsWith("select 1 from registrations where code =")) {
    return result(store.registrations.some((entry) => entry.code === params[0]) ? [{ "?column?": 1 }] : []);
  }
  if (normalized.startsWith("select 1 from payment_refunds where refund_id =")) {
    return result(store.paymentRefunds.some((entry) => entry.refund_id === params[0]) ? [{ "?column?": 1 }] : []);
  }
  if (normalized.startsWith("insert into payment_refunds")) {
    const [paymentRecordId, refundId, amount, currency] = params;
    const refund = {
      id: store.paymentRefunds.length + 1,
      payment_record_id: paymentRecordId,
      refund_id: refundId,
      amount_paise: amount,
      currency,
      created_at: now,
    };
    store.paymentRefunds.push(refund);
    return result([refund]);
  }
  if (normalized.startsWith("update payments set refund_id =")) {
    const [refundId, refundAmount, refunded, id] = params;
    const row = store.payments.find((entry) => entry.id === id);
    if (!row) return result([], 0);
    Object.assign(row, {
      refund_id: refundId,
      refund_amount_paise: refundAmount,
      status: refunded ? "refunded" : row.status,
      refunded_at: refunded ? row.refunded_at || now : row.refunded_at,
      updated_at: now,
    });
    return result([], 1);
  }
  if (normalized.startsWith("select 1 from payments where registration_id =")) {
    const [registrationId, paymentId] = params;
    return result(store.payments.some((entry) =>
      entry.registration_id === registrationId && entry.id !== paymentId && entry.status === "paid"
    ) ? [{ "?column?": 1 }] : []);
  }
  if (normalized.startsWith("update registrations set status = 'refunded'")) {
    const row = store.registrations.find((entry) => entry.id === params[0] && entry.status === "paid");
    if (!row) return result([], 0);
    row.status = "refunded";
    return result([], 1);
  }
  if (normalized.startsWith("update payments set payment_id = $1, status = 'paid'")) {
    const [paymentId, id] = params;
    const row = store.payments.find((entry) => entry.id === id);
    if (!row) return result([], 0);
    Object.assign(row, {
      payment_id: paymentId,
      status: "paid",
      verification_status: "verified",
      failure_reason: null,
      error_code: null,
      error_description: null,
      paid_at: row.paid_at || now,
      updated_at: now,
    });
    return result([], 1);
  }
  if (normalized.startsWith("update registrations set status = case when status = 'refunded'")) {
    const [paymentId, code, id] = params;
    const row = store.registrations.find((entry) => entry.id === id);
    if (!row) return result([], 0);
    row.status = row.status === "refunded" ? "refunded" : "paid";
    row.payment_id = row.payment_id || paymentId;
    row.paid_at = row.paid_at || now;
    row.code = row.code || code;
    return result([row], 1);
  }
  if (normalized.startsWith("update payments set payment_id = $1, status = 'failed'")) {
    const [paymentId, reason, errorCode, description, id] = params;
    const row = store.payments.find((entry) => entry.id === id);
    if (!row) return result([], 0);
    Object.assign(row, {
      payment_id: paymentId,
      status: "failed",
      verification_status: "verified",
      failure_reason: reason,
      error_code: errorCode,
      error_description: description,
      updated_at: now,
    });
    return result([], 1);
  }
  if (normalized.startsWith("insert into payments") && normalized.includes("'failed', 'verified'")) {
    const [registrationId, orderId, paymentId, amount, currency] = params;
    return result([createPayment({
      registration_id: registrationId,
      order_id: orderId,
      payment_id: paymentId,
      amount_paise: amount,
      currency,
      status: "failed",
      verification_status: "verified",
    })]);
  }
  if (normalized.startsWith("insert into webhook_events")) {
    const [eventId, eventType] = params;
    if (store.webhookEvents.some((entry) => entry.event_id === eventId)) return result([], 0);
    store.webhookEvents.push({ event_id: eventId, event_type: eventType, outcome: null, processed_at: null });
    return result([{ event_id: eventId }], 1);
  }
  if (normalized.startsWith("update webhook_events")) {
    const [outcome, eventId] = params;
    const row = store.webhookEvents.find((entry) => entry.event_id === eventId);
    if (row) Object.assign(row, { outcome, processed_at: now });
    return result([], row ? 1 : 0);
  }
  if (normalized.startsWith("select full_name, email, phone, college from team_members")) {
    return result(store.teamMembers
      .filter((entry) => entry.registration_id === Number(params[0]))
      .sort((a, b) => a.position - b.position));
  }
  if (normalized.startsWith("select id, order_id, payment_id, amount_paise")) {
    return result(store.payments
      .filter((entry) => entry.registration_id === Number(params[0]))
      .sort((a, b) => b.id - a.id)
      .map((entry) => ({
        ...entry,
        refunds: store.paymentRefunds.filter((refund) => refund.payment_record_id === entry.id),
      })));
  }
  if (normalized.startsWith("select r.*")) {
    return result(store.registrations.slice().sort((a, b) => b.id - a.id).map((registration) => {
      const payment = store.payments.filter((entry) => entry.registration_id === registration.id).sort((a, b) => b.id - a.id)[0] || {};
      return {
        ...registration,
        payment_record_id: payment.id,
        payment_record_payment_id: payment.payment_id,
        payment_amount_paise: payment.amount_paise,
        payment_currency: payment.currency,
        payment_status: payment.status,
        verification_status: payment.verification_status,
        failure_reason: payment.failure_reason,
        error_code: payment.error_code,
        error_description: payment.error_description,
        refund_id: payment.refund_id,
        refund_amount_paise: payment.refund_amount_paise,
        payment_created_at: payment.created_at,
        payment_paid_at: payment.paid_at,
        refunded_at: payment.refunded_at,
        member_names: store.teamMembers
          .filter((member) => member.registration_id === registration.id)
          .sort((a, b) => a.position - b.position)
          .map((member) => member.full_name),
      };
    }));
  }
  if (normalized.startsWith("select (select count(*) from registrations) as total")) {
    return result([{
      total: String(store.registrations.length),
      paid: String(store.registrations.filter((entry) => entry.status === "paid").length),
      pending: String(store.registrations.filter((entry) => entry.status === "pending").length),
      team: String(store.registrations.filter((entry) => entry.plan === "team").length),
      solo: String(store.registrations.filter((entry) => entry.plan === "solo").length),
      failed: String(store.payments.filter((entry) => entry.status === "failed").length),
      revenue_paise: String(store.payments
        .filter((entry) => ["paid", "refunded"].includes(entry.status) && entry.verification_status === "verified")
        .reduce((sum, entry) => sum + entry.amount_paise - entry.refund_amount_paise, 0)),
    }]);
  }
  if (normalized.startsWith("select plan, count(*) as n from registrations")) {
    const counts = {};
    store.registrations.filter((entry) => entry.status === "paid").forEach((entry) => {
      counts[entry.plan] = (counts[entry.plan] || 0) + 1;
    });
    return result(Object.entries(counts).map(([plan, n]) => ({ plan, n })));
  }
  throw new Error("Unimplemented fake SQL query: " + query);
}

class FakeClient {
  constructor() {
    this.snapshot = null;
  }

  async query(sql, params) {
    if (FakePool.failQueries) throw Object.assign(new Error("Database unavailable"), { code: "ECONNREFUSED" });
    const command = String(sql).trim().toUpperCase();
    if (command === "BEGIN") {
      this.snapshot = copy(store);
      return result();
    }
    if (command === "COMMIT") {
      this.snapshot = null;
      return result();
    }
    if (command === "ROLLBACK") {
      if (this.snapshot) Object.assign(store, this.snapshot);
      this.snapshot = null;
      return result();
    }
    return queryStore(sql, params);
  }

  release() {}
}

class FakePool {
  constructor() {
    FakePool.current = this;
  }

  async query(sql, params) {
    if (FakePool.failQueries) throw Object.assign(new Error("Database unavailable"), { code: "ECONNREFUSED" });
    return queryStore(sql, params);
  }

  async connect() {
    return new FakeClient();
  }
}

FakePool.failQueries = false;

class FakeRazorpay {
  constructor() {
    this.orders = {
      create: async (order) => ({
        id: "order_test_" + FakeRazorpay.nextOrderId++,
        amount: order.amount,
        currency: order.currency,
      }),
      fetchPayments: async (orderId) => ({
        items: Array.from(FakeRazorpay.paymentsById.values())
          .filter((payment) => payment.order_id === orderId),
      }),
    };
    this.payments = {
      fetch: async (paymentId) => {
        const payment = FakeRazorpay.paymentsById.get(paymentId);
        if (!payment) throw new Error("Payment not found");
        return payment;
      },
    };
    FakeRazorpay.instance = this;
  }
}

FakeRazorpay.paymentsById = new Map();
FakeRazorpay.nextOrderId = 1;

process.env.NODE_ENV = "test";
process.env.PAYMENT_MODE = "razorpay";
process.env.DATABASE_URL = "postgres://test.invalid/test";
process.env.ADMIN_TOKEN = "test-admin-token-value";
process.env.RAZORPAY_KEY_ID = "rzp_test_id";
process.env.RAZORPAY_KEY_SECRET = razorpaySecret;
process.env.RAZORPAY_WEBHOOK_SECRET = webhookSecret;
process.env.REG_OPEN = "2026-01-01T00:00:00+05:30";
process.env.REG_CLOSE = "2027-01-01T00:00:00+05:30";

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "pg") return { Pool: FakePool };
  if (request === "razorpay") return FakeRazorpay;
  return originalLoad.call(this, request, parent, isMain);
};
const app = require("../server");
Module._load = originalLoad;

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(resetStore);

function registrationPayload(plan = "solo") {
  return {
    plan,
    track: "AI & Automation",
    teamName: plan === "team" ? "Test Team" : "",
    leaderName: "Test Leader",
    email: "entrant" + store.nextRegistrationId + "@example.com",
    phone: "9876543210",
    college: "Example College",
    members: plan === "team" ? "Member One\nMember Two" : "",
  };
}

async function postJson(route, body, headers = {}) {
  const response = await fetch(baseUrl + route, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function register(plan) {
  const { response, body } = await postJson("/api/register", registrationPayload(plan));
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

function checkoutSignature(orderId, paymentId) {
  return crypto.createHmac("sha256", razorpaySecret).update(orderId + "|" + paymentId).digest("hex");
}

function webhookSignature(rawBody) {
  return crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
}

async function verify(order, payment) {
  FakeRazorpay.paymentsById.set(payment.id, payment);
  return postJson("/api/verify", {
    razorpay_order_id: order.orderId,
    razorpay_payment_id: payment.id,
    razorpay_signature: checkoutSignature(order.orderId, payment.id),
  });
}

function capturedPayment(order, id = "pay_captured") {
  return {
    id,
    order_id: order.orderId,
    amount: order.amount,
    currency: order.currency,
    status: "captured",
    captured: true,
  };
}

async function sendWebhook(event, eventId) {
  const rawBody = JSON.stringify(event);
  return fetch(baseUrl + "/api/webhook/razorpay", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Razorpay-Signature": webhookSignature(rawBody),
      "X-Razorpay-Event-Id": eventId,
    },
    body: rawBody,
  });
}

async function adminRegistrations() {
  const response = await fetch(baseUrl + "/api/admin/registrations", {
    headers: { Authorization: "Bearer " + process.env.ADMIN_TOKEN },
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("persists and pays a Solo registration at the existing price", async () => {
  const order = await register("solo");
  assert.equal(order.amount, 9900);
  assert.equal(store.registrations.length, 1);
  assert.equal(store.payments.length, 1);
  assert.equal(store.registrations[0].plan, "solo");
  assert.equal(store.registrations[0].team_name, null);

  const { response, body } = await verify(order, capturedPayment(order));
  assert.equal(response.status, 200);
  assert.ok(body.code);
  const admin = await adminRegistrations();
  assert.equal(admin.rows[0].paymentStatus, "paid");
  assert.equal(admin.rows[0].paymentId, "pay_captured");
  assert.equal(admin.summary.revenue, 99);
});

test("persists Team members separately and returns complete protected details", async () => {
  const order = await register("team");
  assert.equal(order.amount, 29900);
  assert.equal(store.teamMembers.length, 2);
  assert.deepEqual(store.teamMembers.map((member) => member.full_name), ["Member One", "Member Two"]);

  const response = await fetch(baseUrl + "/api/admin/registrations/1", {
    headers: { Authorization: "Bearer " + process.env.ADMIN_TOKEN },
  });
  assert.equal(response.status, 200);
  const details = await response.json();
  assert.equal(details.registration.teamName, "Test Team");
  assert.equal(details.registration.memberCount, 3);
  assert.deepEqual(details.teamMembers.map((member) => member.full_name), ["Member One", "Member Two"]);

  const paymentResult = await verify(order, capturedPayment(order, "pay_team"));
  assert.equal(paymentResult.response.status, 200);
  assert.equal(store.registrations[0].status, "paid");
  assert.equal(store.payments[0].amount_paise, 29900);
});

test("keeps a registration and pending payment when checkout is abandoned", async () => {
  await register("solo");
  assert.equal(store.registrations[0].status, "pending");
  assert.equal(store.payments[0].status, "pending");
});

test("records signed payment.failed webhooks without deleting registrations", async () => {
  const order = await register("solo");
  const event = {
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: "pay_failed",
          order_id: order.orderId,
          amount: order.amount,
          currency: order.currency,
          error_code: "BAD_REQUEST_ERROR",
          error_description: "Payment declined",
        },
      },
    },
  };
  const response = await sendWebhook(event, "event_failed_1");
  assert.equal(response.status, 200);
  assert.equal(store.registrations.length, 1);
  assert.equal(store.registrations[0].status, "failed");
  assert.equal(store.payments[0].status, "failed");
  assert.equal(store.payments[0].failure_reason, "Payment declined");
});

test("repeated checkout verification does not create another payment", async () => {
  const order = await register("solo");
  const payment = capturedPayment(order);
  const first = await verify(order, payment);
  const second = await verify(order, payment);
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(store.payments.length, 1);
  assert.equal(store.registrations[0].status, "paid");
});

test("duplicate signed webhook delivery is idempotent", async () => {
  const order = await register("solo");
  const event = {
    event: "payment.captured",
    payload: { payment: { entity: capturedPayment(order, "pay_webhook") } },
  };
  assert.equal((await sendWebhook(event, "event_captured_1")).status, 200);
  assert.equal((await sendWebhook(event, "event_captured_1")).status, 200);
  assert.equal(store.webhookEvents.length, 1);
  assert.equal(store.payments.length, 1);
  assert.equal(store.payments[0].status, "paid");
});

test("supports order.paid webhooks that contain only the order entity", async () => {
  const order = await register("solo");
  FakeRazorpay.paymentsById.set("pay_order_paid", capturedPayment(order, "pay_order_paid"));
  const event = {
    event: "order.paid",
    payload: { order: { entity: { id: order.orderId } } },
  };
  assert.equal((await sendWebhook(event, "event_order_paid_1")).status, 200);
  assert.equal(store.registrations[0].status, "paid");
  assert.equal(store.payments[0].payment_id, "pay_order_paid");
});

test("records a verified full refund and removes it from collected revenue", async () => {
  const order = await register("solo");
  await verify(order, capturedPayment(order, "pay_refund"));
  const refund = {
    event: "refund.processed",
    payload: {
      refund: {
        entity: {
          id: "rf_test_1",
          payment_id: "pay_refund",
          amount: order.amount,
          currency: order.currency,
        },
      },
    },
  };
  assert.equal((await sendWebhook(refund, "event_refund_1")).status, 200);
  assert.equal(store.payments[0].status, "refunded");
  assert.equal(store.registrations[0].status, "refunded");
  assert.equal((await adminRegistrations()).summary.revenue, 0);
  assert.equal(store.paymentRefunds.length, 1);
});

test("does not record a refund for a payment that was never verified as paid", async () => {
  const order = await register("solo");
  const failedPayment = {
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: "pay_not_paid",
          order_id: order.orderId,
          amount: order.amount,
          currency: order.currency,
        },
      },
    },
  };
  await sendWebhook(failedPayment, "event_failed_before_refund");

  const refund = {
    event: "refund.processed",
    payload: {
      refund: {
        entity: {
          id: "rf_invalid_payment_state",
          payment_id: "pay_not_paid",
          amount: order.amount,
          currency: order.currency,
        },
      },
    },
  };
  assert.equal((await sendWebhook(refund, "event_refund_unpaid")).status, 200);
  assert.equal(store.payments[0].status, "failed");
  assert.equal(store.registrations[0].status, "failed");
  assert.equal(store.paymentRefunds.length, 0);
});

test("invalid checkout signatures do not alter payment status", async () => {
  const order = await register("solo");
  const response = await postJson("/api/verify", {
    razorpay_order_id: order.orderId,
    razorpay_payment_id: "pay_bad_sig",
    razorpay_signature: "invalid",
  });
  assert.equal(response.response.status, 400);
  assert.equal(store.registrations[0].status, "pending");
  assert.equal(store.payments[0].status, "pending");
});

test("rejects a payment amount that differs from the original registration", async () => {
  const order = await register("solo");
  const payment = capturedPayment(order, "pay_wrong_amount");
  payment.amount += 1;
  const { response } = await verify(order, payment);
  assert.equal(response.status, 400);
  assert.equal(store.registrations[0].status, "pending");
  assert.equal(store.payments[0].status, "pending");
});

test("does not allow a payment to be associated with another registration", async () => {
  const firstOrder = await register("solo");
  const secondOrder = await register("solo");
  const payment = capturedPayment(firstOrder, "pay_single_registration");
  assert.equal((await verify(firstOrder, payment)).response.status, 200);

  const reused = await postJson("/api/verify", {
    razorpay_order_id: secondOrder.orderId,
    razorpay_payment_id: payment.id,
    razorpay_signature: checkoutSignature(secondOrder.orderId, payment.id),
  });
  assert.equal(reused.response.status, 400);
  assert.equal(store.registrations[0].status, "paid");
  assert.equal(store.registrations[1].status, "pending");
  assert.equal(store.payments.length, 2);
});

test("rejects mock signatures when using the Razorpay payment mode", async () => {
  const order = await register("solo");
  const response = await postJson("/api/verify", {
    razorpay_order_id: order.orderId,
    razorpay_payment_id: "mock",
    razorpay_signature: "mock",
  });
  assert.equal(response.response.status, 400);
  assert.equal(store.registrations[0].status, "pending");
});

test("protects admin registration and detail endpoints with the bearer token", async () => {
  const list = await fetch(baseUrl + "/api/admin/registrations");
  const detail = await fetch(baseUrl + "/api/admin/registrations/1");
  assert.equal(list.status, 401);
  assert.equal(detail.status, 401);
});

test("reports database connection failures instead of a success-shaped response", async () => {
  FakePool.failQueries = true;
  const response = await fetch(baseUrl + "/healthz");
  FakePool.failQueries = false;
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Database temporarily unavailable. Please retry." });
});

test("refuses production startup with mock payment mode", () => {
  const child = spawnSync(process.execPath, ["-e", 'require("./server")'], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", PAYMENT_MODE: "mock" },
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /PAYMENT_MODE=mock is forbidden in production/);
});

test("keeps the production app available when Razorpay is not configured", () => {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PAYMENT_MODE: "razorpay",
    DATABASE_URL: "postgres://test.invalid/test",
    ADMIN_TOKEN: "test-admin-token-value",
  };
  delete env.RAZORPAY_KEY_ID;
  delete env.RAZORPAY_KEY_SECRET;
  delete env.RAZORPAY_WEBHOOK_SECRET;

  const child = spawnSync(process.execPath, ["-e", 'require("./server")'], {
    cwd: projectRoot,
    encoding: "utf8",
    env,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stderr, /Payments are unavailable/);
  assert.match(child.stderr, /RAZORPAY_KEY_ID/);
});

test("retains a registration when Razorpay order creation fails", async () => {
  FakeRazorpay.instance.orders.create = async () => {
    throw Object.assign(new Error("gateway unavailable"), { statusCode: 503 });
  };
  const { response, body } = await postJson("/api/register", registrationPayload("solo"));
  assert.equal(response.status, 502);
  assert.ok(body.registrationId);
  assert.equal(store.registrations.length, 1);
  assert.equal(store.payments.length, 1);
  assert.equal(store.payments[0].status, "failed");
});

test("rejects unsigned webhooks", async () => {
  const order = await register("solo");
  const rawBody = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: capturedPayment(order) } },
  });
  const response = await fetch(baseUrl + "/api/webhook/razorpay", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Razorpay-Signature": "invalid" },
    body: rawBody,
  });
  assert.equal(response.status, 400);
  assert.equal(store.registrations[0].status, "pending");
});
