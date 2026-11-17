#!/usr/bin/env node
"use strict";
/* BOLTIV Business Manager: end-to-end smoke test for a STAGING server.
   It creates a throwaway business called "SMOKE ..." and exercises the paths that matter most for money and stock:
   idempotent retries, two cashiers racing for the last item, voids, credit sales, supplier purchases, invoices,
   branch transfers, payroll-to-expense, double-booking, and that the books add up afterwards.

   Usage (Node 18+):
     BOLTIV_API=https://your-staging-api  TOKEN=<bearer token of a staging test user>  node staging-smoke.js
   Optional:
     PIN=1234        the test user's Transaction PIN, so the script can buy a Growth plan from the wallet
                     (the wallet needs at least the plan price). Not needed if the business gets a free trial
                     or you subscribe it by hand in the app / admin dashboard first (BUSINESS_ID=<id>).
     BUSINESS_ID=12  reuse an existing, subscribed, EMPTY-ish test business instead of creating one
     TOKEN2=<token>  a second staging user, to prove one business cannot see another's data
   The script never touches real customers' data. Do not run it against production.
   Exit code is 0 only if every check passed. */

const API = (process.env.BOLTIV_API || "").replace(/\/$/, ""), TOKEN = process.env.TOKEN, TOKEN2 = process.env.TOKEN2, PIN = process.env.PIN;
if (!API || !TOKEN) { console.error("Set BOLTIV_API and TOKEN. See the notes at the top of this file."); process.exit(2); }
const uuid = () => globalThis.crypto.randomUUID();
let passed = 0, failed = 0; const failures = [];
const check = (name, ok, detail) => { if (ok) { passed++; console.log("  PASS  " + name); } else { failed++; failures.push(name); console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); } };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
async function call(method, path, body, token = TOKEN) {
  try {
    const r = await fetch(API + path, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await r.json(); } catch {}
    return { status: r.status, data, ok: r.ok && data.success !== false };
  } catch (e) { return { status: 0, data: { message: e.message }, ok: false }; }
}
const get = (p, t) => call("GET", p, null, t), post = (p, b, t) => call("POST", p, b, t);
const section = t => console.log("\n== " + t);
const msg = r => r.status + " " + (r.data && r.data.message);
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

(async () => {
  let biz = Number(process.env.BUSINESS_ID) || 0;
  section("Business and subscription");
  if (!biz) {
    const c = await post("/api/business/create", { name: "SMOKE " + new Date().toISOString().slice(0, 16), industry: "Other", state: "Lagos", phone: "08011112222" });
    check("create business", c.ok, msg(c)); if (!c.ok) return finish(); biz = c.data.businessId;
  }
  console.log("  business id:", biz);
  let det = await get("/api/business/detail?business_id=" + biz);
  if (det.ok && !det.data.subscription.writable && PIN) {
    const plans = await get("/api/business/plans"), g = (plans.data.plans || []).find(p => p.key === "growth") || (plans.data.plans || [])[0];
    const q = await post("/api/business/subscription/quote", { businessId: biz, planKey: g.key, months: 1 });
    check("quote subscription", q.ok, msg(q));
    if (q.ok && q.data.sufficient) { const pay = await post("/api/business/subscription/pay", { businessId: biz, planKey: g.key, months: 1, expectedAmount: q.data.quote.amount, transactionPin: PIN, idempotencyKey: uuid() }); check("pay subscription from wallet", pay.ok, msg(pay)); }
    else check("wallet has enough for the plan", false, "fund the test wallet or subscribe by hand");
    det = await get("/api/business/detail?business_id=" + biz);
  }
  if (!det.ok || !det.data.subscription.writable) { console.log("\n  The business is not subscribed, so nothing can be written. Subscribe it (or give PIN / enable a trial) and run again."); check("business is writable", false, det.data.subscription && det.data.subscription.state); return finish(); }
  const features = det.data.subscription.features || {};
  console.log("  plan:", det.data.subscription.planName, "| features:", JSON.stringify(features));
  const main = det.data.branches.find(b => b.isMain).id;

  section("Branches and products");
  const sb = await post("/api/business/branches/save", { businessId: biz, name: "Smoke Branch B" + Date.now() % 1000 }); check("create second branch", sb.ok, msg(sb));
  const branchB = sb.ok ? (await get("/api/business/detail?business_id=" + biz)).data.branches.find(b => !b.isMain && b.name.startsWith("Smoke Branch B")).id : null;
  const pr = await post("/api/business/products/save", { businessId: biz, name: "Smoke Rice " + Date.now() % 100000, sellPrice: 1000, costPrice: 700, unit: "pcs", trackStock: true, reorderLevel: 2, openingStock: { branchId: main, qty: 5 } });
  check("create product with opening stock 5", pr.ok, msg(pr)); const pid = pr.data.productId;
  const stock = async (branch = main) => { const l = await get("/api/business/products?business_id=" + biz + "&branch_id=" + branch + "&limit=200"); const p = (l.data.products || []).find(x => x.id === pid); return p ? Number(p.stock) : NaN; };
  check("stock reads 5", (await stock()) === 5);

  section("Sales: idempotency, race for the last item, void");
  const key1 = uuid(), sale = body => ({ businessId: biz, branchId: main, items: [{ productId: pid, qty: body.qty }], payments: body.payments || [{ method: "cash", amount: body.qty * 1000 }], idempotencyKey: body.key || uuid(), customerId: body.customerId });
  const s1 = await post("/api/business/sales/create", sale({ qty: 2, key: key1 })); check("sale of 2 succeeds", s1.ok, msg(s1));
  check("receipt number issued", /^R-\d{6}$/.test((s1.data.sale || {}).receiptNo || ""));
  check("total is exactly 2000", near((s1.data.sale || {}).total, 2000));
  const s1b = await post("/api/business/sales/create", sale({ qty: 2, key: key1 })); check("same key again returns the SAME sale, no double charge", s1b.ok && s1b.data.already === true && s1b.data.sale.id === s1.data.sale.id, msg(s1b));
  check("stock is 3 after one sale (not 1)", (await stock()) === 3);
  const [ra, rb] = await Promise.all([post("/api/business/sales/create", sale({ qty: 3 })), post("/api/business/sales/create", sale({ qty: 3 }))]);
  const winners = [ra, rb].filter(r => r.ok), losers = [ra, rb].filter(r => !r.ok);
  check("two cashiers, last 3 items: exactly one wins", winners.length === 1 && losers.length === 1, [ra, rb].map(msg).join(" | "));
  check("the loser is told stock ran out (409)", losers.length === 1 && losers[0].status === 409, losers[0] && msg(losers[0]));
  check("stock is exactly 0, never negative", (await stock()) === 0);
  const v = await post("/api/business/sales/void", { businessId: biz, saleId: winners[0] ? winners[0].data.sale.id : 0, reason: "smoke test void" }); check("void the 3-item sale", v.ok, msg(v));
  check("stock is back to 3 after the void", (await stock()) === 3);
  const v2 = await post("/api/business/sales/void", { businessId: biz, saleId: winners[0] ? winners[0].data.sale.id : 0, reason: "again" }); check("voiding twice is refused", !v2.ok && v2.status === 409);

  section("Customers and credit");
  const cu = await post("/api/business/customers/save", { businessId: biz, name: "Smoke Customer", phone: "080" + String(Date.now()).slice(-8) }); check("create customer", cu.ok, msg(cu));
  const credit = await post("/api/business/sales/create", sale({ qty: 1, payments: [{ method: "cash", amount: 400 }], customerId: cu.data.customerId })); check("credit sale (pay 400 of 1000)", credit.ok && near(credit.data.sale.balanceDue, 600), msg(credit));
  const cd = await get("/api/business/customers/detail?business_id=" + biz + "&id=" + cu.data.customerId); check("customer owes exactly 600", near(cd.data.customer && cd.data.customer.balance, 600));
  const pkey = uuid(), cp = await post("/api/business/customers/payment", { businessId: biz, customerId: cu.data.customerId, amount: 600, method: "transfer", idempotencyKey: pkey }); check("customer pays the 600", cp.ok && near(cp.data.balance, 0), msg(cp));
  const cp2 = await post("/api/business/customers/payment", { businessId: biz, customerId: cu.data.customerId, amount: 600, method: "transfer", idempotencyKey: pkey }); check("repeat tap with same key is not applied twice", cp2.ok && cp2.data.already === true, msg(cp2));
  const cp3 = await post("/api/business/customers/payment", { businessId: biz, customerId: cu.data.customerId, amount: 1, method: "cash", idempotencyKey: uuid() }); check("cannot overpay a zero balance", !cp3.ok && cp3.status === 400);

  section("Expenses");
  const ek = uuid(), ex = await post("/api/business/expenses/save", { businessId: biz, amount: 2500.5, category: "Transport", description: "smoke", idempotencyKey: ek }); check("record expense", ex.ok, msg(ex));
  const ex2 = await post("/api/business/expenses/save", { businessId: biz, amount: 2500.5, category: "Transport", idempotencyKey: ek }); check("repeat expense with same key is not duplicated", ex2.ok && ex2.data.already === true && ex2.data.expenseId === ex.data.expenseId);
  const ex3 = await post("/api/business/expenses/save", { businessId: biz, amount: 100, category: "Rent", idempotencyKey: uuid() }); const exv = await post("/api/business/expenses/void", { businessId: biz, expenseId: ex3.data.expenseId, reason: "smoke test" }); check("void an expense", exv.ok, msg(exv));

  section("Suppliers and purchases");
  const sp = await post("/api/business/suppliers/save", { businessId: biz, name: "Smoke Supplier", phone: "081" + String(Date.now()).slice(-8) }); check("create supplier", sp.ok, msg(sp));
  const po = await post("/api/business/purchases/create", { businessId: biz, branchId: main, supplierId: sp.data.supplierId, items: [{ productId: pid, qty: 10, unitCost: 100 }], paid: 400, method: "cash", idempotencyKey: uuid() }); check("purchase 10 units, paid 400 of 1000", po.ok && near(po.data.purchase.balanceDue, 600), msg(po));
  check("stock went up by 10", (await stock()) === 13 - 1 /* 3 minus the credit sale of 1, plus 10 */);
  let sd = await get("/api/business/suppliers/detail?business_id=" + biz + "&id=" + sp.data.supplierId); check("you owe the supplier 600", near(sd.data.supplier.balance, 600));
  const poVoid = await post("/api/business/purchases/void", { businessId: biz, purchaseId: po.data.purchase.id, reason: "smoke test" }); check("void the purchase (stock not yet sold)", poVoid.ok, msg(poVoid));
  check("stock back to 2", (await stock()) === 2); sd = await get("/api/business/suppliers/detail?business_id=" + biz + "&id=" + sp.data.supplierId); check("supplier balance back to 0", near(sd.data.supplier.balance, 0));
  const po2 = await post("/api/business/purchases/create", { businessId: biz, branchId: main, supplierId: sp.data.supplierId, items: [{ productId: pid, qty: 10, unitCost: 100 }], paid: 0, method: "cash", idempotencyKey: uuid() });
  const spk = uuid(), sp1 = await post("/api/business/suppliers/payment", { businessId: biz, supplierId: sp.data.supplierId, amount: 1000, method: "transfer", idempotencyKey: spk }); check("pay the supplier 1000", sp1.ok && near(sp1.data.balance, 0), msg(sp1));
  const sp2 = await post("/api/business/suppliers/payment", { businessId: biz, supplierId: sp.data.supplierId, amount: 1000, method: "transfer", idempotencyKey: spk }); check("repeat supplier payment is not applied twice", sp2.ok && sp2.data.already === true);
  check("stock is 12", (await stock()) === 12);

  section("Invoices");
  const ik = uuid(), iv = await post("/api/business/invoices/save", { businessId: biz, customerName: "Smoke Client Ltd", items: [{ description: "Consulting", qty: 2, unitPrice: 50000 }], issue: true, idempotencyKey: ik }); check("issue invoice", iv.ok && /^INV-\d{6}$/.test(iv.data.invoice.invoiceNo || ""), msg(iv));
  const iv2 = await post("/api/business/invoices/save", { businessId: biz, customerName: "Smoke Client Ltd", items: [{ description: "Consulting", qty: 2, unitPrice: 50000 }], issue: true, idempotencyKey: ik }); check("repeat save does not create a second invoice", iv2.ok && iv2.data.already === true && iv2.data.invoice.id === iv.data.invoice.id);
  const total = iv.data.invoice.total, ip = await post("/api/business/invoices/payment", { businessId: biz, invoiceId: iv.data.invoice.id, amount: 40000, method: "transfer", idempotencyKey: uuid() }); check("part payment makes it 'partial'", ip.ok && ip.data.invoice.status === "partial" && near(ip.data.invoice.balanceDue, total - 40000), msg(ip));
  const over = await post("/api/business/invoices/payment", { businessId: biz, invoiceId: iv.data.invoice.id, amount: total, method: "cash", idempotencyKey: uuid() }); check("cannot pay more than the balance", !over.ok && over.status === 400);
  const voidWith = await post("/api/business/invoices/void", { businessId: biz, invoiceId: iv.data.invoice.id, reason: "smoke" }); check("cannot void an invoice that has payments", !voidWith.ok && voidWith.status === 409);
  const pay = ip.data.invoice.payments.find(p => p.status === "active"), rm = await post("/api/business/invoices/payment/void", { businessId: biz, paymentId: pay.id, reason: "smoke test" }); check("remove the payment", rm.ok && near(rm.data.invoice.balanceDue, total), msg(rm));
  const vv = await post("/api/business/invoices/void", { businessId: biz, invoiceId: iv.data.invoice.id, reason: "smoke test" }); check("void the invoice", vv.ok, msg(vv));

  section("Branch transfer");
  if (features.advanced_inventory && branchB) {
    const before = await stock(main), tr = await post("/api/business/transfers/create", { businessId: biz, fromBranchId: main, toBranchId: branchB, items: [{ productId: pid, qty: 4 }], idempotencyKey: uuid() }); check("send 4 to branch B", tr.ok, msg(tr));
    check("main branch lost 4 immediately", (await stock(main)) === before - 4); check("branch B has nothing until received", (await stock(branchB)) === 0);
    const rc = await post("/api/business/transfers/receive", { businessId: biz, transferId: tr.data.transfer.id }); check("receive at branch B", rc.ok, msg(rc)); check("branch B now has 4", (await stock(branchB)) === 4);
    const rc2 = await post("/api/business/transfers/receive", { businessId: biz, transferId: tr.data.transfer.id }); check("receiving twice is refused", !rc2.ok && rc2.status === 409);
    const tr2 = await post("/api/business/transfers/create", { businessId: biz, fromBranchId: main, toBranchId: branchB, items: [{ productId: pid, qty: 2 }], idempotencyKey: uuid() }), cn = await post("/api/business/transfers/cancel", { businessId: biz, transferId: tr2.data.transfer.id, reason: "smoke test" });
    check("cancelled transfer returns stock to the sender", cn.ok && (await stock(main)) === before - 4, msg(cn));
  } else console.log("  (skipped: plan has no advanced inventory)");

  section("Staff, payroll, appointments");
  const st = await post("/api/business/staff/save", { businessId: biz, name: "Smoke Staff", jobTitle: "Stylist", payType: "monthly", payAmount: 60000, branchId: main }); check("create staff", st.ok, msg(st));
  const at = await post("/api/business/staff/attendance", { businessId: biz, date: today(), entries: [{ staffId: st.data.staffId, status: "present" }] }); check("mark attendance", at.ok, msg(at));
  const period = today().slice(0, 7), pk = uuid(), pp = await post("/api/business/payroll/pay", { businessId: biz, staffId: st.data.staffId, period, amount: 60000, bonus: 5000, deductions: 2500, method: "transfer", idempotencyKey: pk }); check("pay salary (net 62,500)", pp.ok && near(pp.data.net, 62500), msg(pp));
  const month = { from: period + "-01", to: today() }, exl = await get("/api/business/expenses?business_id=" + biz + "&from=" + month.from + "&to=" + month.to + "&limit=200");
  const salary = (exl.data.expenses || []).find(e => e.category === "Salaries & wages" && near(e.amount, 62500)); check("salary also appears as an expense", !!salary);
  const dup = await post("/api/business/payroll/pay", { businessId: biz, staffId: st.data.staffId, period, amount: 60000, method: "cash", idempotencyKey: uuid() }); check("paying the same month again needs confirmation (409)", !dup.ok && dup.status === 409 && dup.data.code === "duplicate_period");
  if (salary) { const editBlocked = await post("/api/business/expenses/void", { businessId: biz, expenseId: salary.id, reason: "smoke" }); check("salary expense cannot be voided directly", !editBlocked.ok && editBlocked.status === 409); }
  if (features.appointments) {
    const d = addDays(today(), 1), appt = k => post("/api/business/appointments/save", { businessId: biz, branchId: main, customerName: "Smoke Client", serviceName: "Braiding", date: d, time: "10:00", durationMin: 60, price: 5000, staffId: st.data.staffId, idempotencyKey: k });
    const [a1, a2] = await Promise.all([appt(uuid()), appt(uuid())]);
    check("two bookings for the same person and time: exactly one wins", [a1, a2].filter(r => r.ok).length === 1 && [a1, a2].filter(r => r.status === 409).length === 1, [a1, a2].map(msg).join(" | "));
  } else console.log("  (skipped: plan has no appointments)");
  const pv = await post("/api/business/payroll/void", { businessId: biz, paymentId: pp.data.paymentId, reason: "smoke test" }); check("void the payroll payment", pv.ok, msg(pv));
  const exl2 = await get("/api/business/expenses?business_id=" + biz + "&from=" + month.from + "&to=" + month.to + "&limit=200&voided=1");
  check("...and its salary expense is voided too", (exl2.data.expenses || []).some(e => e.id === (salary && salary.id) && e.status === "void"));

  section("The books add up");
  const fin = await get("/api/business/finance/summary?business_id=" + biz + "&from=" + month.from + "&to=" + month.to);
  if (fin.ok) {
    const listed = await get("/api/business/expenses?business_id=" + biz + "&from=" + month.from + "&to=" + month.to + "&limit=200");
    check("finance expenses equal the active expenses listed", near(fin.data.pnl.expenses, listed.data.total), fin.data.pnl.expenses + " vs " + listed.data.total);
    check("revenue is sales only here (invoice voided)", near(fin.data.pnl.revenue, fin.data.revenueParts.sales + fin.data.revenueParts.invoices));
    check("gross profit = revenue minus cost of goods", near(fin.data.pnl.grossProfit, fin.data.pnl.revenue - fin.data.pnl.cogs));
    check("net profit = gross profit minus expenses", near(fin.data.pnl.netProfit, fin.data.pnl.grossProfit - fin.data.pnl.expenses));
  } else check("finance summary loads", false, msg(fin));
  const mv = await get("/api/business/stock/movements?business_id=" + biz + "&product_id=" + pid + "&limit=100");
  if (mv.ok) {
    const bal = {}; for (const m of mv.data.movements) bal[m.branch] = (bal[m.branch] || 0) + m.change;
    const total = Object.values(bal).reduce((a, b) => a + b, 0), now = (await stock(main)) + (branchB ? await stock(branchB) : 0);
    check("stock on hand equals the sum of all stock movements", near(total, now), total + " vs " + now);
  }

  if (TOKEN2) {
    section("Isolation between businesses");
    const d2 = await get("/api/business/detail?business_id=" + biz, TOKEN2); check("another user cannot open this business (404)", d2.status === 404, msg(d2));
    const s2 = await get("/api/business/sales/detail?business_id=" + biz + "&id=" + (s1.data.sale || {}).id, TOKEN2); check("another user cannot read its sales (404)", s2.status === 404, msg(s2));
    const w2 = await post("/api/business/expenses/save", { businessId: biz, amount: 1, category: "Rent", idempotencyKey: uuid() }, TOKEN2); check("another user cannot write to it (404)", w2.status === 404, msg(w2));
  } else console.log("\n  (set TOKEN2 to also test isolation between two users)");
  finish();
})().catch(e => { console.error("\nUnexpected error:", e); failed++; finish(); });

function finish() {
  console.log("\n" + "=".repeat(52) + `\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log("Failed:\n - " + failures.join("\n - "));
  console.log("\nClean up: suspend the SMOKE business from the admin dashboard (Business Manager > Businesses) when you are done.");
  process.exit(failed ? 1 : 0);
}
