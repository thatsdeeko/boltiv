"use strict";
/* Phase 2 gate tests: role and subscription checks on the new routes, using a stubbed database
   (no SQL is executed for real). They prove the wrong person/state is stopped BEFORE any write. */
const test = require("node:test");
const assert = require("node:assert/strict");
const create = require("./index");

function make({ role, subExpired = false, suspendedBiz = false, features = {} }) {
  const writes = [];
  const day = 86400000, now = Date.now();
  const db = async (sql) => {
    if (/FROM bm_businesses b\s+JOIN bm_members/.test(sql)) return { rows: [{ id: 1, owner_user_id: "o", name: "Shop", status: suspendedBiz ? "suspended" : "active", vat_rate: "0", vat_inclusive: false, member_id: 9, role, branch_ids: null }] };
    if (/FROM bm_subscriptions s JOIN bm_plans/.test(sql)) return { rows: [{ business_id: 1, plan_key: "growth", plan_name: "Growth", status: "active", starts_at: new Date(now - 30 * day), expires_at: new Date(now + (subExpired ? -30 : 20) * day), max_branches: 3, max_members: 10, features, price_monthly: "10000" }] };
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && !/bm_plans/.test(sql)) writes.push(sql);
    return { rows: [] };
  };
  const pool = { connect: async () => ({ query: async (sql) => { if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push(sql); return { rows: [] }; }, release() {} }) };
  const d = { db, pool, clean: v => String(v ?? "").trim(), send: (res, code, data) => { res.code = code; res.data = data; }, body: async req => req.__body || {},
    userFromToken: async () => ({ user_id: "u1", name: "U" }), adminFromToken: async () => null, requireAdminCsrf: async () => ({ success: false }),
    getPlatformSetting: async (k, f) => f, rateLimit: () => ({ allowed: true }), rateLimitedResponse() {}, verifyPassword: () => true, reference: p => p + "-X",
    addFinancialLedger: async () => {}, addNotification: async () => {} };
  return { bm: create(d), writes };
}
const run = async (bm, method, url, bodyObj) => { const res = {}; const req = { method, url, headers: { host: "x" }, socket: {}, __body: bodyObj }; await bm.handle(req, res, new URL(url, "http://x").pathname); return res; };
const SALE = { businessId: 1, branchId: 1, idempotencyKey: "abcdefgh1234", items: [{ productId: 1, qty: 1 }], payments: [{ method: "cash", amount: 100 }] };

test("a cashier can sell but cannot void, manage stock or edit products", async () => {
  const { bm, writes } = make({ role: "cashier" });
  assert.equal((await run(bm, "POST", "/api/business/sales/void", { businessId: 1, saleId: 1, reason: "mistake" })).code, 403);
  assert.equal((await run(bm, "POST", "/api/business/stock/adjust", { businessId: 1, branchId: 1, productId: 1, type: "restock", qty: 5 })).code, 403);
  assert.equal((await run(bm, "POST", "/api/business/products/save", { businessId: 1, name: "Rice", sellPrice: 100 })).code, 403);
  assert.equal(writes.length, 0);
});
test("accountant and staff cannot create sales", async () => {
  for (const role of ["accountant", "staff"]) { const { bm, writes } = make({ role }); assert.equal((await run(bm, "POST", "/api/business/sales/create", SALE)).code, 403, role); assert.equal(writes.length, 0); }
});
test("staff cannot see sales", async () => {
  const { bm } = make({ role: "staff" });
  assert.equal((await run(bm, "GET", "/api/business/sales?business_id=1")).code, 403);
});
test("an expired subscription blocks every write but not reads", async () => {
  const { bm, writes } = make({ role: "owner", subExpired: true });
  for (const [u, b] of [["/api/business/sales/create", SALE], ["/api/business/products/save", { businessId: 1, name: "Rice", sellPrice: 100 }], ["/api/business/customers/save", { businessId: 1, name: "Ngozi" }],
    ["/api/business/stock/adjust", { businessId: 1, branchId: 1, productId: 1, type: "restock", qty: 1 }], ["/api/business/sales/void", { businessId: 1, saleId: 1, reason: "test" }]]) {
    const r = await run(bm, "POST", u, b); assert.equal(r.code, 402, u); assert.equal(r.data.code, "subscription_required");
  }
  assert.equal(writes.length, 0);
  assert.equal((await run(bm, "GET", "/api/business/products?business_id=1")).code, 200);
});
test("a suspended business cannot sell", async () => {
  const { bm, writes } = make({ role: "owner", suspendedBiz: true });
  assert.equal((await run(bm, "POST", "/api/business/sales/create", SALE)).code, 403); assert.equal(writes.length, 0);
});
test("sale input is validated before anything is written", async () => {
  const { bm, writes } = make({ role: "owner" });
  assert.equal((await run(bm, "POST", "/api/business/sales/create", { ...SALE, idempotencyKey: "x" })).code, 400);
  assert.equal((await run(bm, "POST", "/api/business/sales/create", { ...SALE, items: [] })).code, 400);
  assert.equal((await run(bm, "POST", "/api/business/sales/create", { ...SALE, items: new Array(101).fill({ productId: 1, qty: 1 }) })).code, 400);
  assert.equal(writes.filter(w => /bm_sales/.test(w)).length, 0);
});
test("products/save rejects bad data with 400 before writing", async () => {
  const { bm, writes } = make({ role: "owner" });
  assert.equal((await run(bm, "POST", "/api/business/products/save", { businessId: 1, name: "R", sellPrice: 100 })).code, 400);
  assert.equal((await run(bm, "POST", "/api/business/products/save", { businessId: 1, name: "Rice", sellPrice: -1 })).code, 400);
  assert.equal(writes.length, 0);
});

/* ---------- Phase 3 gates ---------- */
const EXP = { businessId: 1, amount: 5000, category: "Rent", idempotencyKey: "abcdefgh1234" };
test("phase 3: cashier and staff cannot touch money records", async () => {
  for (const role of ["cashier", "staff"]) {
    const { bm, writes } = make({ role });
    for (const [m, u, b] of [["POST", "/api/business/expenses/save", EXP], ["POST", "/api/business/invoices/save", { businessId: 1, customerName: "X Ltd", items: [{ description: "a", qty: 1, unitPrice: 1 }], idempotencyKey: "abcdefgh1234" }],
      ["POST", "/api/business/purchases/create", { businessId: 1, branchId: 1, items: [{ productId: 1, qty: 1, unitCost: 1 }], idempotencyKey: "abcdefgh1234" }], ["POST", "/api/business/suppliers/save", { businessId: 1, name: "Dangote" }],
      ["GET", "/api/business/finance/summary?business_id=1"], ["GET", "/api/business/expenses?business_id=1"], ["GET", "/api/business/invoices?business_id=1"]]) {
      assert.equal((await run(bm, m, u, b)).code, 403, role + " " + u);
    }
    assert.equal(writes.length, 0);
  }
});
test("phase 3: accountant can record money but cannot receive stock or void sales", async () => {
  const { bm, writes } = make({ role: "accountant" });
  assert.equal((await run(bm, "POST", "/api/business/purchases/create", { businessId: 1, branchId: 1, items: [{ productId: 1, qty: 1, unitCost: 1 }], idempotencyKey: "abcdefgh1234" })).code, 403);
  assert.equal((await run(bm, "POST", "/api/business/sales/void", { businessId: 1, saleId: 1, reason: "x y z" })).code, 403);
  assert.equal(writes.length, 0);
  assert.equal((await run(bm, "POST", "/api/business/expenses/save", { ...EXP, amount: 0 })).code, 400);
});
test("phase 3: manager cannot be stopped by role but expired subscription blocks every money write", async () => {
  const { bm, writes } = make({ role: "owner", subExpired: true });
  for (const [u, b] of [["/api/business/expenses/save", EXP], ["/api/business/expenses/void", { businessId: 1, expenseId: 1, reason: "dup" }], ["/api/business/suppliers/payment", { businessId: 1, supplierId: 1, amount: 5, method: "cash", idempotencyKey: "abcdefgh1234" }],
    ["/api/business/purchases/create", { businessId: 1, branchId: 1, items: [{ productId: 1, qty: 1, unitCost: 1 }], idempotencyKey: "abcdefgh1234" }], ["/api/business/invoices/payment", { businessId: 1, invoiceId: 1, amount: 5, method: "cash", idempotencyKey: "abcdefgh1234" }],
    ["/api/business/invoices/void", { businessId: 1, invoiceId: 1, reason: "dup" }]]) {
    const r = await run(bm, "POST", u, b); assert.equal(r.code, 402, u);
  }
  assert.equal(writes.length, 0);
});
test("phase 3: bad input is refused before any write", async () => {
  const { bm, writes } = make({ role: "owner" });
  assert.equal((await run(bm, "POST", "/api/business/expenses/save", { ...EXP, idempotencyKey: "x" })).code, 400);
  assert.equal((await run(bm, "POST", "/api/business/expenses/save", { ...EXP, date: "2099-01-01" })).code, 400);
  assert.equal((await run(bm, "POST", "/api/business/expenses/save", { ...EXP, method: "bitcoin" })).code, 400);
  assert.equal((await run(bm, "POST", "/api/business/invoices/save", { businessId: 1, customerName: "X Ltd", items: [], idempotencyKey: "abcdefgh1234" })).code, 400);
  assert.equal((await run(bm, "POST", "/api/business/invoices/save", { businessId: 1, customerName: "X Ltd", issueDate: "2026-12-10", dueDate: "2026-12-01", items: [{ description: "a", qty: 1, unitPrice: 1 }], idempotencyKey: "abcdefgh1234" })).code, 400);
  assert.equal((await run(bm, "POST", "/api/business/purchases/create", { businessId: 1, branchId: 1, items: [], idempotencyKey: "abcdefgh1234" })).code, 400);
  assert.equal((await run(bm, "POST", "/api/business/suppliers/payment", { businessId: 1, supplierId: 1, amount: -5, method: "cash", idempotencyKey: "abcdefgh1234" })).code, 400);
  assert.equal((await run(bm, "GET", "/api/business/finance/summary?business_id=1&from=2025-01-01&to=2026-11-01")).code, 400);
  assert.equal((await run(bm, "GET", "/api/business/expenses?business_id=1&from=2026-11-10&to=2026-11-01")).code, 400);
  assert.equal(writes.length, 0);
});

/* ---------- Phase 4 gates ---------- */
const STARTER = { pos: true, basic_inventory: true, advanced_inventory: false, appointments: false, audit_export: false, reports: "basic" };
const GROWTH = { pos: true, basic_inventory: true, advanced_inventory: true, appointments: true, audit_export: false, reports: "full" };
const ENT = { ...GROWTH, audit_export: true };
const APPT = { businessId: 1, branchId: 1, customerName: "Ngozi", serviceName: "Braiding", date: "2099-01-01", time: "10:00", durationMin: 60, price: 5000, idempotencyKey: "abcdefgh1234" };

test("phase 4: Starter plan is blocked from Growth features, before anything is written", async () => {
  const { bm, writes } = make({ role: "owner", features: STARTER });
  for (const [m, u, b] of [["GET", "/api/business/appointments?business_id=1"], ["GET", "/api/business/services?business_id=1"], ["POST", "/api/business/appointments/save", APPT],
    ["POST", "/api/business/transfers/create", { businessId: 1, fromBranchId: 1, toBranchId: 2, items: [{ productId: 1, qty: 1 }], idempotencyKey: "abcdefgh1234" }], ["GET", "/api/business/transfers?business_id=1"],
    ["POST", "/api/business/lots/add", { businessId: 1, branchId: 1, productId: 1, qty: 1, expiry: "2027-01-01" }], ["GET", "/api/business/lots/expiry?business_id=1"], ["GET", "/api/business/stock/reorder?business_id=1"],
    ["POST", "/api/business/stock/adjust", { businessId: 1, branchId: 1, productId: 1, type: "restock", qty: 5, expiry: "2027-01-01" }], ["GET", "/api/business/audit/export?business_id=1"]]) {
    const r = await run(bm, m, u, b); assert.equal(r.code, 403, u); assert.equal(r.data.code, "plan_feature", u);
  }
  assert.equal(writes.length, 0);
});
test("phase 4: basic reports are limited to 31 days; audit export needs Enterprise", async () => {
  let r = await run(make({ role: "owner", features: STARTER }).bm, "GET", "/api/business/reports/sales?business_id=1&from=2026-01-01&to=2026-11-01"); assert.equal(r.code, 403); assert.equal(r.data.code, "plan_feature");
  r = await run(make({ role: "owner", features: GROWTH }).bm, "GET", "/api/business/reports/sales?business_id=1&from=2024-01-01&to=2026-11-01"); assert.equal(r.code, 400);
  r = await run(make({ role: "owner", features: GROWTH }).bm, "GET", "/api/business/audit/export?business_id=1"); assert.equal(r.code, 403);
  r = await run(make({ role: "owner", features: ENT }).bm, "GET", "/api/business/audit/export?business_id=1&from=2025-01-01&to=2026-11-01"); assert.equal(r.code, 400);
});
test("phase 4: only the right roles reach staff, payroll, reports and services", async () => {
  for (const role of ["cashier", "staff"]) { const { bm, writes } = make({ role, features: GROWTH });
    for (const [m, u, b] of [["GET", "/api/business/staff?business_id=1"], ["POST", "/api/business/staff/save", { businessId: 1, name: "Chidi Okeke" }], ["GET", "/api/business/payroll?business_id=1"], ["GET", "/api/business/reports/sales?business_id=1"], ["POST", "/api/business/services/save", { businessId: 1, name: "Cut", durationMin: 30 }]]) assert.equal((await run(bm, m, u, b)).code, 403, role + " " + u);
    assert.equal(writes.length, 0); }
  const acct = make({ role: "accountant", features: GROWTH });
  assert.equal((await run(acct.bm, "GET", "/api/business/staff?business_id=1")).code, 200);
  assert.equal((await run(acct.bm, "POST", "/api/business/staff/save", { businessId: 1, name: "Chidi Okeke" })).code, 403);
  assert.equal((await run(acct.bm, "GET", "/api/business/appointments?business_id=1")).code, 403);
  assert.equal((await run(acct.bm, "POST", "/api/business/payroll/pay", { businessId: 1, staffId: 1, period: "2026-11", amount: 0, idempotencyKey: "abcdefgh1234" })).code, 400);
  assert.equal(acct.writes.length, 0);
});
test("phase 4: cashiers and staff can manage appointments but not services or transfers", async () => {
  for (const role of ["cashier", "staff"]) { const { bm, writes } = make({ role, features: GROWTH });
    assert.equal((await run(bm, "POST", "/api/business/appointments/save", { ...APPT, date: "2020-01-01" })).code, 400, role);
    assert.equal((await run(bm, "POST", "/api/business/transfers/create", { businessId: 1, fromBranchId: 1, toBranchId: 2, items: [{ productId: 1, qty: 1 }], idempotencyKey: "abcdefgh1234" })).code, 403, role);
    assert.equal(writes.length, 0); }
});
test("phase 4: expired subscription blocks writes in every new module", async () => {
  const { bm, writes } = make({ role: "owner", subExpired: true, features: ENT });
  for (const [u, b] of [["/api/business/staff/save", { businessId: 1, name: "Chidi Okeke" }], ["/api/business/staff/attendance", { businessId: 1, date: "2026-11-16", entries: [{ staffId: 1, status: "present" }] }],
    ["/api/business/payroll/pay", { businessId: 1, staffId: 1, period: "2026-11", amount: 10, idempotencyKey: "abcdefgh1234" }], ["/api/business/payroll/void", { businessId: 1, paymentId: 1, reason: "dup" }], ["/api/business/appointments/save", APPT],
    ["/api/business/appointments/status", { businessId: 1, appointmentId: 1, status: "confirmed" }], ["/api/business/services/save", { businessId: 1, name: "Cut", durationMin: 30 }],
    ["/api/business/transfers/create", { businessId: 1, fromBranchId: 1, toBranchId: 2, items: [{ productId: 1, qty: 1 }], idempotencyKey: "abcdefgh1234" }], ["/api/business/transfers/receive", { businessId: 1, transferId: 1 }], ["/api/business/lots/add", { businessId: 1, branchId: 1, productId: 1, qty: 1, expiry: "2027-01-01" }]]) {
    const r = await run(bm, "POST", u, b); assert.equal(r.code, 402, u);
  }
  assert.equal(writes.length, 0);
});
test("phase 4: bad input is refused before any write", async () => {
  const { bm, writes } = make({ role: "owner", features: ENT });
  const bad = [["/api/business/staff/save", { businessId: 1, name: "C" }], ["/api/business/staff/save", { businessId: 1, name: "Chidi", payType: "hourly" }],
    ["/api/business/staff/attendance", { businessId: 1, date: "2099-01-01", entries: [{ staffId: 1, status: "present" }] }], ["/api/business/staff/attendance", { businessId: 1, date: "2026-11-16", entries: [{ staffId: 1, status: "sick" }] }],
    ["/api/business/payroll/pay", { businessId: 1, staffId: 1, period: "2026-11", amount: 100, deductions: 100, idempotencyKey: "abcdefgh1234" }], ["/api/business/payroll/pay", { businessId: 1, staffId: 1, period: "Nov", amount: 100, idempotencyKey: "abcdefgh1234" }],
    ["/api/business/payroll/pay", { businessId: 1, staffId: 1, period: "2026-11", amount: 100, idempotencyKey: "x" }], ["/api/business/appointments/save", { ...APPT, date: "2020-01-01" }], ["/api/business/appointments/save", { ...APPT, time: "99:00" }],
    ["/api/business/appointments/save", { ...APPT, idempotencyKey: "x" }], ["/api/business/appointments/status", { businessId: 1, appointmentId: 1, status: "booked" }],
    ["/api/business/transfers/create", { businessId: 1, fromBranchId: 1, toBranchId: 1, items: [{ productId: 1, qty: 1 }], idempotencyKey: "abcdefgh1234" }], ["/api/business/transfers/create", { businessId: 1, fromBranchId: 1, toBranchId: 2, items: [], idempotencyKey: "abcdefgh1234" }],
    ["/api/business/transfers/cancel", { businessId: 1, transferId: 1, reason: "" }], ["/api/business/lots/add", { businessId: 1, branchId: 1, productId: 1, qty: 0, expiry: "2027-01-01" }], ["/api/business/lots/add", { businessId: 1, branchId: 1, productId: 1, qty: 1, expiry: "soon" }],
    ["/api/business/services/save", { businessId: 1, name: "C", durationMin: 30 }], ["/api/business/services/save", { businessId: 1, name: "Cut", durationMin: 1 }], ["/api/business/customers/payment", { businessId: 1, customerId: 1, amount: 5, method: "cash" }]];
  for (const [u, b] of bad) assert.equal((await run(bm, "POST", u, b)).code, 400, u + " " + JSON.stringify(b).slice(0, 60));
  assert.equal(writes.length, 0);
});
