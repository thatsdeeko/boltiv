"use strict";
/* BOLTIV Business Manager, Phase 3 pure rules: expenses, supplier purchases, invoices, profit and loss.
   No database, no network. Money is integer kobo inside, naira outside. */
const { toKobo, fromKobo } = require("./logic");
const { PAY_METHODS, q3, computeSale, normalizePhoneNG, validateCustomer } = require("./logic2");

const EXPENSE_CATEGORIES = ["Rent", "Salaries & wages", "Transport", "Electricity & utilities", "Fuel & generator", "Internet & airtime", "Marketing", "Repairs & maintenance", "Supplies", "Taxes & levies", "Bank charges", "Licences & fees", "Other"];
const str = (v, max) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);
const lagosToday = (now = new Date()) => now.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && !isNaN(Date.parse(d + "T00:00:00Z")) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const docNo = (prefix, n) => prefix + "-" + String(n).padStart(6, "0");

/* ---------- expenses ---------- */
function validateExpense(b, now = new Date()) {
  const errors = [], out = {};
  const amt = Number(b.amount);
  if (!(amt > 0 && amt <= 1e9)) errors.push("Enter a valid amount."); else out.amount = fromKobo(toKobo(amt));
  out.category = str(b.category, 40); if (out.category.length < 2) errors.push("Choose a category.");
  out.description = str(b.description, 200);
  const today = lagosToday(now);
  out.expense_date = b.date ? str(b.date, 10) : today;
  if (!isDate(out.expense_date)) errors.push("Enter a valid date.");
  else if (out.expense_date > addDays(today, 1)) errors.push("The date cannot be in the future.");
  else if (out.expense_date < addDays(today, -1830)) errors.push("The date is too far in the past.");
  out.method = str(b.method, 12).toLowerCase() || "cash"; if (!PAY_METHODS.includes(out.method)) errors.push("Choose a payment method.");
  return { value: out, errors };
}

/* ---------- supplier purchases ---------- */
function computePurchase({ lines, paid = 0, hasSupplier }) {
  if (!Array.isArray(lines) || !lines.length) throw new Error("Add at least one item.");
  let total = 0;
  const out = lines.map(l => {
    const qty = q3(l.qty), cost = Number(l.unitCost);
    if (!(qty > 0) || qty > 1e6) throw new Error("Invalid quantity.");
    if (!(cost >= 0 && cost <= 1e9)) throw new Error("Invalid unit cost.");
    const line = Math.round(toKobo(cost) * qty); total += line;
    return { qty, unitCostKobo: toKobo(cost), lineKobo: line };
  });
  const paidK = toKobo(paid || 0);
  if (!(paidK >= 0)) throw new Error("Invalid payment amount.");
  if (paidK > total) throw new Error("You cannot pay more than the purchase total.");
  const due = total - paidK;
  if (due > 0 && !hasSupplier) throw new Error("Choose a supplier to buy on credit, or pay the full amount.");
  return { lines: out, total: fromKobo(total), paid: fromKobo(paidK), due: fromKobo(due), totalKobo: total, dueKobo: due };
}

/* ---------- invoices ---------- */
function validateInvoice(b, now = new Date()) {
  const errors = [], out = {};
  const today = lagosToday(now);
  out.customer_name = str(b.customerName, 80);
  out.issue_date = b.issueDate ? str(b.issueDate, 10) : today;
  out.due_date = b.dueDate ? str(b.dueDate, 10) : addDays(out.issue_date, 14);
  if (!isDate(out.issue_date)) errors.push("Enter a valid issue date.");
  else if (!isDate(out.due_date)) errors.push("Enter a valid due date.");
  else if (out.due_date < out.issue_date) errors.push("The due date cannot be before the issue date.");
  else if (out.issue_date > addDays(today, 30) || out.issue_date < addDays(today, -1830)) errors.push("The issue date is out of range.");
  out.notes = str(b.notes, 500); out.terms = str(b.terms, 500);
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length || items.length > 50) errors.push("Add between 1 and 50 items.");
  out.items = items.map(i => ({ description: str(i.description, 200), qty: i.qty, unitPrice: Number(i.unitPrice) }));
  if (out.items.some(i => i.description.length < 1)) errors.push("Every item needs a description.");
  return { value: out, errors };
}
function computeInvoice({ items, discount = 0, vatRate = 0, vatInclusive = false }) {
  return computeSale({ lines: items.map(i => ({ unitPrice: i.unitPrice, qty: i.qty, discount: 0 })), saleDiscount: discount, vatRate, vatInclusive });
}
/* status shown to people. A draft has no number; overdue is derived from the due date and what is still unpaid. */
function invoiceStatus({ status, total, paid, dueDate }, today) {
  if (status === "draft") return { status: "draft", overdue: false };
  if (status === "void") return { status: "void", overdue: false };
  const bal = toKobo(total) - toKobo(paid);
  if (bal <= 0) return { status: "paid", overdue: false };
  return { status: toKobo(paid) > 0 ? "partial" : "unpaid", overdue: !!dueDate && String(dueDate).slice(0, 10) < today };
}

/* ---------- profit and loss ---------- */
/* inputs are plain naira numbers already summed by the database */
function buildPnL(x) {
  const k = v => toKobo(v || 0);
  const revenue = k(x.salesRevenue) + k(x.invoiceRevenue);
  const gross = revenue - k(x.cogs);
  const net = gross - k(x.expenses);
  const margin = revenue > 0 ? Math.round(net * 1000 / revenue) / 10 : 0;
  const cashIn = k(x.cashIn), cashOut = k(x.cashOut);
  return { revenue: fromKobo(revenue), cogs: fromKobo(k(x.cogs)), grossProfit: fromKobo(gross), expenses: fromKobo(k(x.expenses)), netProfit: fromKobo(net), marginPct: margin,
    vatCollected: fromKobo(k(x.vat)), cashIn: fromKobo(cashIn), cashOut: fromKobo(cashOut), netCash: fromKobo(cashIn - cashOut) };
}
function dateRange(from, to, now = new Date(), maxDays = 366) {
  const today = lagosToday(now);
  const f = isDate(from) ? from : today.slice(0, 8) + "01", t = isDate(to) ? to : today;
  if (f > t) return { error: "The start date is after the end date." };
  if ((Date.parse(t) - Date.parse(f)) / 86400000 > maxDays) return { error: `Choose a range of up to ${maxDays} days.` };
  return { from: f, to: t };
}

module.exports = { EXPENSE_CATEGORIES, lagosToday, isDate, addDays, docNo, validateExpense, computePurchase, validateInvoice, computeInvoice, invoiceStatus, buildPnL, dateRange, validateSupplier: validateCustomer, normalizePhoneNG };
