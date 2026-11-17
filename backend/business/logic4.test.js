"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("./logic4");
const NOW = new Date("2026-11-16T10:00:00Z");

test("staff validation", () => {
  const ok = L.validateStaff({ name: "Chidi Okeke", phone: "08012345678", jobTitle: "Cashier", payType: "monthly", payAmount: 60000, startDate: "2026-01-05" });
  assert.equal(ok.errors.length, 0); assert.equal(ok.value.phone, "2348012345678"); assert.equal(ok.value.pay_amount, 60000);
  assert.ok(L.validateStaff({ name: "C" }).errors.length); assert.ok(L.validateStaff({ name: "Chidi", payType: "hourly" }).errors.length);
  assert.ok(L.validateStaff({ name: "Chidi", payAmount: -1 }).errors.length); assert.ok(L.validateStaff({ name: "Chidi", startDate: "2026-02-30" }).errors.length);
  assert.equal(L.validateStaff({ jobTitle: "Manager" }, { partial: true }).errors.length, 0);
});
test("payroll arithmetic", () => {
  assert.deepEqual(L.computePayroll({ amount: 60000, bonus: 5000, deductions: 2500.5 }), { amount: 60000, bonus: 5000, deductions: 2500.5, net: 62499.5 });
  assert.equal(L.computePayroll({ amount: 100 }).net, 100);
  assert.throws(() => L.computePayroll({ amount: 100, deductions: 100 }), /more than zero/); assert.throws(() => L.computePayroll({ amount: -5 })); assert.throws(() => L.computePayroll({ amount: 100, bonus: -1 }));
  assert.ok(L.validPeriod("2026-11")); assert.ok(!L.validPeriod("2026-13")); assert.ok(!L.validPeriod("Nov 2026"));
});
test("attendance validation", () => {
  const e = [{ staffId: 1, status: "present" }];
  assert.equal(L.validateAttendance("2026-11-16", e, NOW), ""); assert.ok(L.validateAttendance("2026-11-20", e, NOW)); assert.ok(L.validateAttendance("nope", e, NOW));
  assert.ok(L.validateAttendance("2026-11-16", [{ status: "sick" }], NOW)); assert.ok(L.validateAttendance("2026-11-16", [], NOW)); assert.ok(L.validateAttendance("2020-01-01", e, NOW));
});
test("appointment validation, overlap and status flow", () => {
  const ok = L.validateAppointment({ customerName: "Ngozi", customerPhone: "08011112222", serviceName: "Braiding", date: "2026-11-20", time: "14:30", durationMin: 120, price: 15000 }, NOW);
  assert.equal(ok.errors.length, 0); assert.equal(ok.value.customer_phone, "2348011112222");
  for (const bad of [{ date: "2026-11-10" }, { time: "25:00" }, { durationMin: 2 }, { price: -1 }, { serviceName: "x" }, { customerName: "" }]) assert.ok(L.validateAppointment({ customerName: "Ngozi", serviceName: "Braiding", date: "2026-11-20", time: "14:30", durationMin: 60, price: 1, ...bad }, NOW).errors.length, JSON.stringify(bad));
  assert.equal(L.toMin("14:30"), 870);
  assert.ok(L.rangesOverlap(600, 660, 630, 700)); assert.ok(!L.rangesOverlap(600, 660, 660, 720)); assert.ok(!L.rangesOverlap(600, 660, 500, 600)); assert.ok(L.rangesOverlap(600, 660, 610, 620));
  assert.ok(L.canMoveAppt("booked", "confirmed")); assert.ok(L.canMoveAppt("confirmed", "completed")); assert.ok(!L.canMoveAppt("completed", "cancelled")); assert.ok(!L.canMoveAppt("cancelled", "booked"));
});
test("transfer validation", () => {
  assert.equal(L.validateTransfer({ fromBranch: 1, toBranch: 2, items: [{ productId: 1, qty: 3 }] }), "");
  assert.ok(L.validateTransfer({ fromBranch: 1, toBranch: 1, items: [{ qty: 1 }] })); assert.ok(L.validateTransfer({ fromBranch: 1, toBranch: 2, items: [] }));
  assert.ok(L.validateTransfer({ fromBranch: 1, toBranch: 2, items: [{ qty: 0 }] })); assert.ok(L.validateTransfer({ fromBranch: 1, toBranch: null, items: [{ qty: 1 }] }));
});
test("expiry lots: oldest-expiring stock is assumed sold first", () => {
  const lots = [{ id: 1, expiry: "2026-12-01", qty: 10 }, { id: 2, expiry: "2027-03-01", qty: 20 }, { id: 3, expiry: "2026-11-20", qty: 5 }];
  let r = L.deriveLots(lots, 35); assert.deepEqual(r.map(x => x.remaining), [5, 10, 20]);
  r = L.deriveLots(lots, 28); assert.deepEqual(r.map(x => [x.id, x.remaining]), [[3, 0], [1, 8], [2, 20]]);
  r = L.deriveLots(lots, 20); assert.deepEqual(r.map(x => [x.id, x.remaining]), [[3, 0], [1, 0], [2, 20]]);
  r = L.deriveLots(lots, 0); assert.ok(r.every(x => x.remaining === 0));
  r = L.deriveLots(lots, 50); assert.deepEqual(r.map(x => x.remaining), [5, 10, 20]);
  assert.equal(L.lotStatus("2026-11-01", "2026-11-16"), "expired"); assert.equal(L.lotStatus("2026-12-01", "2026-11-16"), "soon"); assert.equal(L.lotStatus("2027-02-01", "2026-11-16"), "ok"); assert.equal(L.lotStatus("2026-11-16", "2026-11-16"), "soon");
});
test("reorder suggestions", () => {
  assert.equal(L.reorderSuggestion({ stock: 3, reorderLevel: 10 }), 17); assert.equal(L.reorderSuggestion({ stock: 0, reorderLevel: 5 }), 10);
  assert.equal(L.reorderSuggestion({ stock: 11, reorderLevel: 10 }), 0); assert.equal(L.reorderSuggestion({ stock: 0, reorderLevel: 0 }), 0); assert.equal(L.reorderSuggestion({ stock: 10, reorderLevel: 10 }), 10);
});
test("report ranges by plan", () => {
  assert.deepEqual(L.reportRange(undefined, undefined, "basic", NOW), { from: "2026-10-18", to: "2026-11-16", max: 31 });
  assert.equal(L.reportRange("2026-10-01", "2026-11-16", "basic", NOW).code, "plan_feature");
  assert.equal(L.reportRange("2026-10-17", "2026-11-16", "basic", NOW).error, undefined);
  assert.equal(L.reportRange("2026-01-01", "2026-11-16", "full", NOW).error, undefined);
  assert.ok(L.reportRange("2025-01-01", "2026-11-16", "full", NOW).error); assert.ok(L.reportRange("2026-11-10", "2026-11-01", "full", NOW).error);
});
test("plan feature editing is whitelisted", () => {
  const f = L.cleanFeatures({ appointments: true, reports: "full", evil: true, advanced_inventory: "true", audit_export: 1 }, { pos: true, appointments: false });
  assert.deepEqual(f, { pos: true, appointments: true, reports: "full", advanced_inventory: true, audit_export: false });
  assert.equal(L.cleanFeatures({ reports: "everything" }, { reports: "basic" }).reports, "basic");
});
