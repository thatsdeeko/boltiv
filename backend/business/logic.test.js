"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("./logic");

const plan = (key, price) => ({ key, price_monthly: price, max_branches: 1, max_members: 3 });
const D = { 6: 5, 12: 10 };
const now = new Date("2026-12-01T00:00:00Z");
const days = n => new Date(now.getTime() + n * L.DAY_MS).toISOString();

test("pricing: monthly, 6-month 5% off, yearly 10% off", () => {
  assert.equal(L.computeQuote({ sub: null, plan: plan("starter", 5000), months: 1, discounts: D, now }).amount, 5000);
  const six = L.computeQuote({ sub: null, plan: plan("starter", 5000), months: 6, discounts: D, now });
  assert.equal(six.listAmount, 30000); assert.equal(six.discountAmount, 1500); assert.equal(six.amount, 28500);
  const yr = L.computeQuote({ sub: null, plan: plan("growth", 10000), months: 12, discounts: D, now });
  assert.equal(yr.listAmount, 120000); assert.equal(yr.discountAmount, 12000); assert.equal(yr.amount, 108000);
  const ent = L.computeQuote({ sub: null, plan: plan("enterprise", 15000), months: 12, discounts: D, now });
  assert.equal(ent.amount, 162000);
});
test("pricing: rejects bad period, kobo rounding stays exact", () => {
  assert.throws(() => L.computeQuote({ sub: null, plan: plan("a", 5000), months: 3, discounts: D, now }));
  const q = L.computeQuote({ sub: null, plan: plan("a", 3333.33), months: 6, discounts: D, now });
  assert.ok(Math.abs(q.amount * 100 - Math.round(q.amount * 100)) < 1e-6);
  assert.equal(q.listAmount - q.discountAmount, q.amount);
});
test("renewal of same active plan extends and has no credit", () => {
  const sub = { plan_key: "starter", status: "active", starts_at: days(-10), expires_at: days(20), paid_amount: 5000 };
  const q = L.computeQuote({ sub, plan: plan("starter", 5000), months: 1, discounts: D, now });
  assert.equal(q.mode, "extend"); assert.equal(q.creditAmount, 0); assert.equal(q.amount, 5000);
});
test("plan switch credits the unused value of the old plan", () => {
  const sub = { plan_key: "starter", status: "active", starts_at: days(-15), expires_at: days(15), paid_amount: 5000 };
  const q = L.computeQuote({ sub, plan: plan("growth", 10000), months: 1, discounts: D, now });
  assert.equal(q.mode, "replace"); assert.equal(q.creditAmount, 2500); assert.equal(q.amount, 7500); assert.equal(q.heldValue, 10000);
});
test("credit never exceeds the new price", () => {
  const sub = { plan_key: "enterprise", status: "active", starts_at: days(-1), expires_at: days(364), paid_amount: 162000 };
  const q = L.computeQuote({ sub, plan: plan("starter", 5000), months: 1, discounts: D, now });
  assert.equal(q.amount, 0); assert.equal(q.creditAmount, 5000);
});
test("trial and expired subscriptions give no credit", () => {
  assert.equal(L.unusedCreditKobo({ status: "trial", starts_at: days(-1), expires_at: days(5), paid_amount: 0 }, now), 0);
  assert.equal(L.unusedCreditKobo({ status: "active", starts_at: days(-40), expires_at: days(-10), paid_amount: 5000 }, now), 0);
});
test("subscription state: active, grace, expired, suspended, none", () => {
  assert.equal(L.subscriptionState(null, now).writable, false);
  assert.equal(L.subscriptionState({ status: "active", expires_at: days(3) }, now).state, "active");
  assert.equal(L.subscriptionState({ status: "trial", expires_at: days(3) }, now).state, "trial");
  const g = L.subscriptionState({ status: "active", expires_at: days(-2) }, now, 7);
  assert.equal(g.state, "grace"); assert.equal(g.writable, true);
  const e = L.subscriptionState({ status: "active", expires_at: days(-8) }, now, 7);
  assert.equal(e.state, "expired"); assert.equal(e.writable, false);
  assert.equal(L.subscriptionState({ status: "suspended", expires_at: days(30) }, now).writable, false);
});
test("permissions per role", () => {
  assert.ok(L.hasPerm("owner", "billing.manage"));
  assert.ok(!L.hasPerm("manager", "billing.manage")); assert.ok(L.hasPerm("manager", "members.manage"));
  assert.ok(L.hasPerm("cashier", "sales.create")); assert.ok(!L.hasPerm("cashier", "expenses.create")); assert.ok(!L.hasPerm("cashier", "members.manage"));
  assert.ok(L.hasPerm("accountant", "finance.view")); assert.ok(!L.hasPerm("accountant", "pos.sell"));
  assert.ok(!L.hasPerm("staff", "audit.view")); assert.ok(!L.hasPerm("nobody", "business.view"));
});
test("role assignment rules", () => {
  assert.ok(L.canAssignRole("owner", "manager")); assert.ok(!L.canAssignRole("owner", "owner"));
  assert.ok(L.canAssignRole("manager", "cashier")); assert.ok(!L.canAssignRole("manager", "manager"));
  assert.ok(!L.canAssignRole("cashier", "staff")); assert.ok(!L.canAssignRole("owner", "admin"));
});
test("branch access", () => {
  assert.ok(L.canAccessBranch({ role: "cashier", branch_ids: null }, 5));
  assert.ok(L.canAccessBranch({ role: "cashier", branch_ids: ["2", "5"] }, 5));
  assert.ok(!L.canAccessBranch({ role: "cashier", branch_ids: [2] }, 5));
  assert.ok(L.canAccessBranch({ role: "owner", branch_ids: [2] }, 5));
});
test("downgrade guard", () => {
  assert.equal(L.fitsPlan({ max_branches: 3, max_members: 10 }, { branches: 3, members: 10 }).length, 0);
  assert.equal(L.fitsPlan({ max_branches: 1, max_members: 3 }, { branches: 2, members: 5 }).length, 2);
  assert.equal(L.fitsPlan({ max_branches: -1, max_members: -1 }, { branches: 99, members: 99 }).length, 0);
});
test("business validation", () => {
  assert.ok(L.validateBusiness({ name: "A" }).errors.length);
  assert.ok(L.validateBusiness({ name: "Ade Stores", phone: "08012345678", state: "Lagos", tin: "1234567-0001" }).errors.length === 0);
  assert.ok(L.validateBusiness({ name: "Ade", state: "Mars" }).errors.length);
  assert.ok(L.validateBusiness({ name: "Ade", email: "bad" }).errors.length);
  assert.equal(L.validateBusiness({ phone: "0801234567" }, { partial: true }).errors.length, 0);
});

test("phase 2 permissions", () => {
  assert.ok(L.hasPerm("cashier", "sales.create")); assert.ok(L.hasPerm("cashier", "pos.discount")); assert.ok(L.hasPerm("cashier", "customers.manage"));
  assert.ok(!L.hasPerm("cashier", "sales.void")); assert.ok(!L.hasPerm("cashier", "inventory.manage"));
  assert.ok(L.hasPerm("manager", "sales.void")); assert.ok(L.hasPerm("owner", "inventory.manage"));
  assert.ok(!L.hasPerm("accountant", "sales.create")); assert.ok(L.hasPerm("accountant", "sales.view"));
  assert.ok(!L.hasPerm("staff", "sales.view")); assert.ok(L.hasPerm("staff", "inventory.view"));
  assert.ok(L.validateBusiness({ name: "Ade", vatRate: 30 }).errors.length);
  assert.equal(L.validateBusiness({ name: "Ade", vatRate: 7.5, vatInclusive: true }).value.vat_rate, 7.5);
});
