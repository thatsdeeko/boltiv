"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("./logic3");
const NOW = new Date("2026-11-16T10:00:00Z");

test("expense validation", () => {
  const ok = L.validateExpense({ amount: 15000.5, category: "Rent", date: "2026-11-10", method: "transfer" }, NOW);
  assert.equal(ok.errors.length, 0); assert.equal(ok.value.amount, 15000.5);
  assert.ok(L.validateExpense({ amount: 0, category: "Rent" }, NOW).errors.length);
  assert.ok(L.validateExpense({ amount: 10, category: "" }, NOW).errors.length);
  assert.ok(L.validateExpense({ amount: 10, category: "Rent", date: "2027-01-01" }, NOW).errors.length);
  assert.ok(L.validateExpense({ amount: 10, category: "Rent", date: "2026-02-30" }, NOW).errors.length);
  assert.ok(L.validateExpense({ amount: 10, category: "Rent", date: "2015-01-01" }, NOW).errors.length);
  assert.ok(L.validateExpense({ amount: 10, category: "Rent", method: "bitcoin" }, NOW).errors.length);
  assert.equal(L.validateExpense({ amount: 10, category: "Rent" }, NOW).value.expense_date, "2026-11-16");
});
test("purchase totals, part payment and credit", () => {
  const p = L.computePurchase({ lines: [{ qty: 10, unitCost: 6200 }, { qty: 2.5, unitCost: 100.1 }], paid: 50000, hasSupplier: true });
  assert.equal(p.total, 62000 + 250.25); assert.equal(p.paid, 50000); assert.equal(p.due, 12250.25);
  assert.throws(() => L.computePurchase({ lines: [{ qty: 1, unitCost: 100 }], paid: 0, hasSupplier: false }), /supplier/);
  assert.equal(L.computePurchase({ lines: [{ qty: 1, unitCost: 100 }], paid: 100, hasSupplier: false }).due, 0);
  assert.throws(() => L.computePurchase({ lines: [{ qty: 1, unitCost: 100 }], paid: 101, hasSupplier: true }), /more than/);
  assert.throws(() => L.computePurchase({ lines: [], paid: 0 })); assert.throws(() => L.computePurchase({ lines: [{ qty: 0, unitCost: 1 }] }));
  assert.throws(() => L.computePurchase({ lines: [{ qty: 1, unitCost: -1 }] }));
});
test("invoice validation and totals with VAT", () => {
  const v = L.validateInvoice({ customerName: "Bello Ltd", items: [{ description: "Website design", qty: 1, unitPrice: 250000 }] }, NOW);
  assert.equal(v.errors.length, 0); assert.equal(v.value.due_date, "2026-11-30");
  assert.ok(L.validateInvoice({ customerName: "x", items: [] }, NOW).errors.length);
  assert.ok(L.validateInvoice({ issueDate: "2026-11-20", dueDate: "2026-11-10", items: [{ description: "a", qty: 1, unitPrice: 1 }] }, NOW).errors.length);
  assert.ok(L.validateInvoice({ items: [{ description: "", qty: 1, unitPrice: 1 }] }, NOW).errors.length);
  const t = L.computeInvoice({ items: [{ qty: 2, unitPrice: 50000 }, { qty: 1, unitPrice: 25000 }], discount: 5000, vatRate: 7.5 });
  assert.equal(t.subtotal, 125000); assert.equal(t.discount, 5000); assert.equal(t.tax, 9000); assert.equal(t.total, 129000);
});
test("invoice status and overdue", () => {
  const today = "2026-11-16";
  assert.deepEqual(L.invoiceStatus({ status: "draft", total: 100, paid: 0 }, today), { status: "draft", overdue: false });
  assert.deepEqual(L.invoiceStatus({ status: "issued", total: 100, paid: 0, dueDate: "2026-11-20" }, today), { status: "unpaid", overdue: false });
  assert.deepEqual(L.invoiceStatus({ status: "issued", total: 100, paid: 0, dueDate: "2026-11-10" }, today), { status: "unpaid", overdue: true });
  assert.deepEqual(L.invoiceStatus({ status: "issued", total: 100, paid: 40, dueDate: "2026-11-10" }, today), { status: "partial", overdue: true });
  assert.deepEqual(L.invoiceStatus({ status: "issued", total: 100, paid: 100, dueDate: "2026-11-10" }, today), { status: "paid", overdue: false });
  assert.equal(L.invoiceStatus({ status: "void", total: 100, paid: 0 }, today).status, "void");
});
test("profit and loss arithmetic", () => {
  const r = L.buildPnL({ salesRevenue: 500000.5, invoiceRevenue: 250000, cogs: 300000.25, expenses: 120000, vat: 30000, cashIn: 600000, cashOut: 450000 });
  assert.equal(r.revenue, 750000.5); assert.equal(r.grossProfit, 450000.25); assert.equal(r.netProfit, 330000.25); assert.equal(r.marginPct, 44);
  assert.equal(r.netCash, 150000);
  assert.equal(L.buildPnL({}).marginPct, 0); assert.equal(L.buildPnL({ expenses: 10 }).netProfit, -10);
});
test("date ranges and helpers", () => {
  assert.deepEqual(L.dateRange(undefined, undefined, NOW), { from: "2026-11-01", to: "2026-11-16" });
  assert.deepEqual(L.dateRange("2026-10-01", "2026-10-31", NOW), { from: "2026-10-01", to: "2026-10-31" });
  assert.ok(L.dateRange("2026-11-10", "2026-11-01", NOW).error); assert.ok(L.dateRange("2024-01-01", "2026-11-01", NOW).error);
  assert.equal(L.docNo("INV", 7), "INV-000007"); assert.equal(L.addDays("2026-12-30", 3), "2027-01-02");
  assert.ok(L.isDate("2026-02-28")); assert.ok(!L.isDate("2026-02-29")); assert.ok(!L.isDate("11/16/2026"));
});
