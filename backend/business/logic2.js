"use strict";
/* BOLTIV Business Manager, Phase 2 pure rules: sale totals, VAT, payments/change/credit, stock arithmetic,
   validation helpers. No database, no network. All money is computed in integer kobo. */
const { toKobo, fromKobo } = require("./logic");

const PAY_METHODS = ["cash", "transfer", "pos", "other"];
const UNITS = ["pcs", "kg", "g", "l", "ml", "pack", "carton", "dozen", "bag", "bottle", "set", "other"];
const MAX_PRICE = 1e9; // naira
const q3 = n => Math.round(Number(n) * 1000) / 1000;
const isMoney = n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX_PRICE;

/* ---------- sale totals ---------- */
/* lines: [{unitPrice (naira), qty, discount (naira, whole line)}]; saleDiscount in naira.
   VAT: rate in percent. inclusive=true means prices already contain VAT. */
function computeSale({ lines, saleDiscount = 0, vatRate = 0, vatInclusive = false }) {
  if (!Array.isArray(lines) || !lines.length) throw new Error("Add at least one item.");
  let subtotal = 0, lineDiscounts = 0;
  const out = lines.map(l => {
    const qty = q3(l.qty);
    if (!(qty > 0) || qty > 1e6) throw new Error("Invalid quantity.");
    if (!isMoney(l.unitPrice)) throw new Error("Invalid price.");
    const gross = Math.round(toKobo(l.unitPrice) * qty);
    const disc = Math.min(gross, Math.max(0, toKobo(l.discount || 0)));
    subtotal += gross - disc; lineDiscounts += disc;
    return { qty, gross, discount: disc, net: gross - disc };
  });
  const sd = Math.min(subtotal, Math.max(0, toKobo(saleDiscount || 0)));
  const taxable = subtotal - sd;
  const rate = Math.min(25, Math.max(0, Number(vatRate) || 0));
  let tax = 0, total = taxable;
  if (rate > 0) {
    if (vatInclusive) tax = taxable - Math.round(taxable / (1 + rate / 100));
    else { tax = Math.round(taxable * rate / 100); total = taxable + tax; }
  }
  return { lines: out, subtotal: fromKobo(subtotal + lineDiscounts), discount: fromKobo(lineDiscounts + sd), tax: fromKobo(tax), total: fromKobo(total), totalKobo: total };
}

/* ---------- payments ---------- */
/* Overpayment is only allowed as cash and becomes change. Underpayment needs a customer (credit sale). */
function settlePayments({ totalKobo, payments, hasCustomer }) {
  const list = (payments || []).map(p => ({ method: String(p.method || "").toLowerCase(), kobo: toKobo(p.amount) }));
  for (const p of list) { if (!PAY_METHODS.includes(p.method)) throw new Error("Invalid payment method."); if (!(p.kobo > 0) || p.kobo > MAX_PRICE * 100) throw new Error("Invalid payment amount."); }
  const received = list.reduce((a, p) => a + p.kobo, 0);
  const cash = list.filter(p => p.method === "cash").reduce((a, p) => a + p.kobo, 0);
  const change = Math.max(0, received - totalKobo);
  if (change > cash) throw new Error("Only cash can be given back as change.");
  const net = []; let left = change;
  for (const p of list) { // change comes out of cash lines
    let k = p.kobo;
    if (p.method === "cash" && left > 0) { const t = Math.min(left, k); k -= t; left -= t; }
    if (k > 0) net.push({ method: p.method, amount: fromKobo(k) });
  }
  const paid = Math.min(received, totalKobo), due = totalKobo - paid;
  if (due > 0 && !hasCustomer) throw new Error("Select a customer to sell on credit, or collect the full amount.");
  return { payments: net, paid: fromKobo(paid), change: fromKobo(change), balanceDue: fromKobo(due), dueKobo: due };
}

/* ---------- stock ---------- */
const STOCK_TYPES = ["restock", "damage", "correction", "opening"];
/* returns the signed change to apply; throws if it would go below zero */
function stockDelta(type, qty, current) {
  if (!STOCK_TYPES.includes(type)) throw new Error("Invalid stock action.");
  const q = q3(qty), cur = q3(current);
  if (!(Number.isFinite(q) && q >= 0 && q <= 1e7)) throw new Error("Invalid quantity.");
  let delta;
  if (type === "restock" || type === "opening") { if (!(q > 0)) throw new Error("Quantity must be more than zero."); delta = q; }
  else if (type === "damage") { if (!(q > 0)) throw new Error("Quantity must be more than zero."); delta = -q; }
  else delta = q3(q - cur); // correction: q is the counted quantity
  if (q3(cur + delta) < 0) throw new Error("Not enough stock for that.");
  return q3(delta);
}

/* ---------- misc ---------- */
const receiptNo = n => "R-" + String(n).padStart(6, "0");
function normalizePhoneNG(p) {
  let d = String(p || "").replace(/[^\d]/g, "");
  if (d.startsWith("234") && d.length === 13) return d;
  if (d.startsWith("0") && d.length === 11) return "234" + d.slice(1);
  if (d.length === 10) return "234" + d;
  return "";
}
const str = (v, max) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);
function validateProduct(b, { partial = false } = {}) {
  const out = {}, errors = [], has = k => Object.prototype.hasOwnProperty.call(b, k);
  if (!partial || has("name")) { out.name = str(b.name, 120); if (out.name.length < 2) errors.push("Product name must be at least 2 characters."); }
  if (has("sku")) { out.sku = str(b.sku, 40); if (out.sku && !/^[A-Za-z0-9._\/-]+$/.test(out.sku)) errors.push("SKU may only use letters, numbers and . _ / -"); }
  if (has("barcode")) { out.barcode = str(b.barcode, 40); if (out.barcode && !/^[A-Za-z0-9-]+$/.test(out.barcode)) errors.push("Barcode may only use letters, numbers and dashes."); }
  if (has("category")) out.category = str(b.category, 40);
  if (has("unit")) { out.unit = str(b.unit, 12).toLowerCase() || "pcs"; if (!UNITS.includes(out.unit)) errors.push("Choose a valid unit."); }
  if (!partial || has("sellPrice")) { const n = Number(b.sellPrice); if (!isMoney(n)) errors.push("Enter a valid selling price."); else out.sell_price = Math.round(n * 100) / 100; }
  if (has("costPrice")) { const n = Number(b.costPrice || 0); if (!isMoney(n)) errors.push("Enter a valid cost price."); else out.cost_price = Math.round(n * 100) / 100; }
  if (has("reorderLevel")) { const n = Number(b.reorderLevel || 0); if (!(n >= 0 && n <= 1e7)) errors.push("Enter a valid reorder level."); else out.reorder_level = q3(n); }
  if (has("trackStock")) out.track_stock = b.trackStock !== false && b.trackStock !== "false";
  if (has("status")) { out.status = b.status === "archived" ? "archived" : "active"; }
  return { value: out, errors };
}
function validateCustomer(b, { partial = false } = {}) {
  const out = {}, errors = [], has = k => Object.prototype.hasOwnProperty.call(b, k);
  if (!partial || has("name")) { out.name = str(b.name, 80); if (out.name.length < 2) errors.push("Customer name must be at least 2 characters."); }
  if (has("phone")) { const raw = str(b.phone, 20); out.phone = raw ? normalizePhoneNG(raw) : ""; if (raw && !out.phone) errors.push("Enter a valid Nigerian phone number."); }
  if (has("email")) { out.email = str(b.email, 120).toLowerCase(); if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) errors.push("Enter a valid email address."); }
  if (has("address")) out.address = str(b.address, 200);
  if (has("notes")) out.notes = str(b.notes, 300);
  return { value: out, errors };
}

module.exports = { PAY_METHODS, UNITS, STOCK_TYPES, q3, computeSale, settlePayments, stockDelta, receiptNo, normalizePhoneNG, validateProduct, validateCustomer };
