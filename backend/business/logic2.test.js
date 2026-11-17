"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("./logic2");

test("totals without VAT, with line and sale discounts", () => {
  const r = L.computeSale({ lines: [{ unitPrice: 1500, qty: 2 }, { unitPrice: 250.5, qty: 3, discount: 50 }], saleDiscount: 100 });
  assert.equal(r.subtotal, 3000 + 751.5); assert.equal(r.discount, 150); assert.equal(r.tax, 0); assert.equal(r.total, 3000 + 751.5 - 50 - 100);
});
test("VAT 7.5% exclusive adds on top, inclusive extracts", () => {
  const ex = L.computeSale({ lines: [{ unitPrice: 10000, qty: 1 }], vatRate: 7.5 });
  assert.equal(ex.tax, 750); assert.equal(ex.total, 10750);
  const inc = L.computeSale({ lines: [{ unitPrice: 10750, qty: 1 }], vatRate: 7.5, vatInclusive: true });
  assert.equal(inc.total, 10750); assert.equal(inc.tax, 750);
});
test("VAT applies after discount; discounts cannot exceed the amount", () => {
  const r = L.computeSale({ lines: [{ unitPrice: 1000, qty: 1, discount: 99999 }], vatRate: 7.5 });
  assert.equal(r.total, 0); assert.equal(r.discount, 1000);
  const r2 = L.computeSale({ lines: [{ unitPrice: 10000, qty: 1 }], saleDiscount: 2000, vatRate: 7.5 });
  assert.equal(r2.tax, 600); assert.equal(r2.total, 8600);
});
test("decimal quantities round to the kobo", () => {
  const r = L.computeSale({ lines: [{ unitPrice: 1234.56, qty: 0.5 }] }); assert.equal(r.total, 617.28);
  const r2 = L.computeSale({ lines: [{ unitPrice: 333.33, qty: 3 }] }); assert.equal(r2.total, 999.99);
});
test("bad sale input is rejected", () => {
  assert.throws(() => L.computeSale({ lines: [] }));
  assert.throws(() => L.computeSale({ lines: [{ unitPrice: 100, qty: 0 }] }));
  assert.throws(() => L.computeSale({ lines: [{ unitPrice: -1, qty: 1 }] }));
  assert.throws(() => L.computeSale({ lines: [{ unitPrice: NaN, qty: 1 }] }));
});
test("payments: exact, split, change from cash, change only from cash", () => {
  const t = 5000 * 100;
  let p = L.settlePayments({ totalKobo: t, payments: [{ method: "cash", amount: 5000 }] });
  assert.equal(p.paid, 5000); assert.equal(p.change, 0); assert.equal(p.balanceDue, 0);
  p = L.settlePayments({ totalKobo: t, payments: [{ method: "cash", amount: 6000 }] });
  assert.equal(p.change, 1000); assert.deepEqual(p.payments, [{ method: "cash", amount: 5000 }]);
  p = L.settlePayments({ totalKobo: t, payments: [{ method: "transfer", amount: 3000 }, { method: "cash", amount: 3000 }] });
  assert.equal(p.change, 1000); assert.deepEqual(p.payments, [{ method: "transfer", amount: 3000 }, { method: "cash", amount: 2000 }]);
  assert.throws(() => L.settlePayments({ totalKobo: t, payments: [{ method: "transfer", amount: 6000 }] }), /change/);
});
test("underpayment is a credit sale and needs a customer", () => {
  assert.throws(() => L.settlePayments({ totalKobo: 500000, payments: [{ method: "cash", amount: 2000 }], hasCustomer: false }), /customer/);
  const p = L.settlePayments({ totalKobo: 500000, payments: [{ method: "cash", amount: 2000 }], hasCustomer: true });
  assert.equal(p.balanceDue, 3000); assert.equal(p.paid, 2000);
  const none = L.settlePayments({ totalKobo: 500000, payments: [], hasCustomer: true });
  assert.equal(none.balanceDue, 5000);
  assert.throws(() => L.settlePayments({ totalKobo: 500000, payments: [{ method: "crypto", amount: 5000 }] }));
  assert.throws(() => L.settlePayments({ totalKobo: 500000, payments: [{ method: "cash", amount: 0 }] }));
});
test("stock deltas", () => {
  assert.equal(L.stockDelta("restock", 10, 5), 10); assert.equal(L.stockDelta("damage", 2, 5), -2);
  assert.throws(() => L.stockDelta("damage", 6, 5), /Not enough/);
  assert.equal(L.stockDelta("correction", 8, 5), 3); assert.equal(L.stockDelta("correction", 2, 5), -3); assert.equal(L.stockDelta("correction", 0, 5), -5);
  assert.throws(() => L.stockDelta("restock", 0, 5)); assert.throws(() => L.stockDelta("sell", 1, 5)); assert.throws(() => L.stockDelta("restock", -1, 5));
  assert.equal(L.stockDelta("restock", 0.1, 0.2), 0.1);
});
test("receipt numbers and phone normalising", () => {
  assert.equal(L.receiptNo(42), "R-000042");
  assert.equal(L.normalizePhoneNG("0801 234 5678"), "2348012345678"); assert.equal(L.normalizePhoneNG("+234 801 234 5678"), "2348012345678");
  assert.equal(L.normalizePhoneNG("8012345678"), "2348012345678"); assert.equal(L.normalizePhoneNG("12345"), "");
});
test("product and customer validation", () => {
  assert.equal(L.validateProduct({ name: "Indomie", sellPrice: 300, unit: "pack", sku: "IND-01" }).errors.length, 0);
  assert.ok(L.validateProduct({ name: "x", sellPrice: 300 }).errors.length);
  assert.ok(L.validateProduct({ name: "Rice", sellPrice: -5 }).errors.length);
  assert.ok(L.validateProduct({ name: "Rice", sellPrice: 5, unit: "tonne" }).errors.length);
  assert.ok(L.validateProduct({ name: "Rice", sellPrice: 5, sku: "a b" }).errors.length);
  assert.equal(L.validateCustomer({ name: "Mrs Bello", phone: "08012345678" }).value.phone, "2348012345678");
  assert.ok(L.validateCustomer({ name: "Mrs Bello", phone: "123" }).errors.length);
});
