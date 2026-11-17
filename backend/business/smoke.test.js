"use strict";
/* Smoke test: wiring, auth gates, master switch and error handling, using stubbed dependencies (no database). */
const test = require("node:test");
const assert = require("node:assert/strict");
const create = require("./index");

function deps(over = {}) {
  const calls = [];
  const d = {
    db: async (sql, p) => { calls.push(sql); return { rows: [] }; }, pool: {}, clean: v => String(v ?? "").trim(),
    send: (res, code, data) => { res.code = code; res.data = data; }, body: async req => req.__body || {},
    userFromToken: async req => req.__user || null, adminFromToken: async req => req.__admin || null,
    requireAdminCsrf: async () => ({ success: false, statusCode: 403, message: "Invalid admin CSRF token." }),
    getPlatformSetting: async (k, f) => (k in (over.settings || {}) ? over.settings[k] : f),
    rateLimit: () => ({ allowed: true }), rateLimitedResponse: () => {}, verifyPassword: () => false, reference: p => p + "-X",
    addFinancialLedger: async () => {}, addNotification: async () => {}, ...over.deps
  };
  return { d, calls };
}
const R = (method, url, extra = {}) => ({ method, url, headers: { host: "x" }, socket: {}, ...extra });
const run = async (bm, req) => { const res = {}; const handled = await bm.handle(req, res, new URL(req.url, "http://x").pathname); return { handled, res }; };

test("ignores routes that are not Business Manager's", async () => {
  const { d } = deps(); const bm = create(d);
  assert.equal((await run(bm, R("GET", "/api/me"))).handled, false);
  assert.equal((await run(bm, R("GET", "/api/businessx"))).handled, false);
});
test("user routes require login", async () => {
  const { d } = deps(); const bm = create(d);
  for (const [m, u] of [["GET", "/api/business/plans"], ["GET", "/api/business/mine"], ["POST", "/api/business/create"], ["GET", "/api/business/detail?business_id=1"], ["POST", "/api/business/subscription/pay"]]) {
    const { res } = await run(bm, R(m, u)); assert.equal(res.code, 401, u);
  }
});
test("admin routes require admin, and POSTs require CSRF", async () => {
  const { d } = deps(); const bm = create(d);
  assert.equal((await run(bm, R("GET", "/api/admin/business/overview"))).res.code, 401);
  assert.equal((await run(bm, R("POST", "/api/admin/business/plans/update", { __admin: { id: 1 } }))).res.code, 403);
  assert.equal((await run(bm, R("GET", "/api/admin/business/plans", { __admin: { id: 1 } }))).res.code, 200);
});
test("master switch turns user routes off", async () => {
  const { d } = deps({ settings: { bm_enabled: false } }); const bm = create(d);
  const { res } = await run(bm, R("GET", "/api/business/plans", { __user: { user_id: "u1" } }));
  assert.equal(res.code, 503);
});
test("a non-member gets 404 and never sees the business", async () => {
  const { d } = deps(); const bm = create(d);
  const { res } = await run(bm, R("GET", "/api/business/detail?business_id=7", { __user: { user_id: "u1" } }));
  assert.equal(res.code, 404); assert.equal(res.data.message, "Business not found.");
});
test("bad ids and bad input are rejected before any write", async () => {
  const { d, calls } = deps(); const bm = create(d);
  assert.equal((await run(bm, R("GET", "/api/business/detail?business_id=abc", { __user: { user_id: "u1" } }))).res.code, 400);
  const before = calls.length;
  const { res } = await run(bm, R("POST", "/api/business/create", { __user: { user_id: "u1" }, __body: { name: "A" } }));
  assert.equal(res.code, 400); assert.equal(calls.slice(before).filter(s => /INSERT INTO bm_businesses/.test(s)).length, 0);
});
test("unexpected errors return a generic 500 without leaking details", async () => {
  const { d } = deps({ deps: { userFromToken: async () => { throw new Error("secret db detail"); } } }); const bm = create(d);
  const { res } = await run(bm, R("GET", "/api/business/plans"));
  assert.equal(res.code, 500); assert.ok(!/secret/.test(JSON.stringify(res.data)));
});

test("people who send too many requests get a 429 before anything runs", async () => {
  const { d } = deps({ deps: { rateLimit: () => ({ allowed: false, retryAfter: 30 }), rateLimitedResponse: (res) => { res.code = 429; } } }); const bm = create(d);
  const { res } = await run(bm, R("GET", "/api/business/plans", { __user: { user_id: "u1" } }));
  assert.equal(res.code, 429);
});
test("database errors become clear messages and never leak details", async () => {
  const cases = [["23514", 409, /invalid/], ["23503", 409, /no longer exists/], ["23505", 409, /already exists/], ["22003", 400, /too large/], ["22P02", 400, /not valid/], ["40P01", 409, /at once/], ["XX000", 500, /Something went wrong/]];
  for (const [code, status, re] of cases) {
    const { d } = deps({ deps: { userFromToken: async () => { throw Object.assign(new Error("secret table bm_stock detail"), { code }); } } }); const bm = create(d);
    const { res } = await run(bm, R("GET", "/api/business/plans"));
    assert.equal(res.code, status, code); assert.match(res.data.message, re); assert.ok(!/secret|bm_stock/.test(JSON.stringify(res.data)), code);
  }
});
