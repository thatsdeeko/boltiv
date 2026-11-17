"use strict";
/* BOLTIV Business Manager, Phase 4 pure rules: staff and payroll, appointments, branch transfers, expiry lots,
   reorder suggestions, report limits per plan. No database, no network. */
const { toKobo, fromKobo } = require("./logic");
const { q3, normalizePhoneNG } = require("./logic2");
const { isDate, addDays, lagosToday } = require("./logic3");

const str = (v, max) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);
const ATT_STATUSES = ["present", "late", "absent", "leave"];
const PAY_TYPES = ["monthly", "weekly", "daily"];
const APPT_STATUSES = ["booked", "confirmed", "completed", "cancelled", "no_show"];
const FEATURE_KEYS = { pos: "bool", basic_inventory: "bool", advanced_inventory: "bool", appointments: "bool", audit_export: "bool", reports: ["basic", "full"] };

/* ---------- staff and payroll ---------- */
function validateStaff(b, { partial = false } = {}) {
  const out = {}, errors = [], has = k => Object.prototype.hasOwnProperty.call(b, k);
  if (!partial || has("name")) { out.name = str(b.name, 80); if (out.name.length < 2) errors.push("Staff name must be at least 2 characters."); }
  if (has("phone")) { const raw = str(b.phone, 20); out.phone = raw ? normalizePhoneNG(raw) : ""; if (raw && !out.phone) errors.push("Enter a valid Nigerian phone number."); }
  if (has("email")) { out.email = str(b.email, 120).toLowerCase(); if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) errors.push("Enter a valid email address."); }
  if (has("jobTitle")) out.job_title = str(b.jobTitle, 60);
  if (has("payType")) { out.pay_type = str(b.payType, 10).toLowerCase(); if (!PAY_TYPES.includes(out.pay_type)) errors.push("Choose monthly, weekly or daily pay."); }
  if (has("payAmount")) { const n = Number(b.payAmount || 0); if (!(n >= 0 && n <= 1e9)) errors.push("Enter a valid pay amount."); else out.pay_amount = fromKobo(toKobo(n)); }
  if (has("startDate")) { const d = str(b.startDate, 10); if (d && !isDate(d)) errors.push("Enter a valid start date."); out.start_date = d || null; }
  if (has("status")) out.status = b.status === "inactive" ? "inactive" : "active";
  if (has("notes")) out.notes = str(b.notes, 300);
  return { value: out, errors };
}
/* net = base + bonus - deductions, all kobo; must be positive */
function computePayroll({ amount, bonus = 0, deductions = 0 }) {
  const a = toKobo(amount), b = toKobo(bonus || 0), d = toKobo(deductions || 0);
  for (const [n, v] of [["amount", amount], ["bonus", bonus || 0], ["deductions", deductions || 0]]) if (!(Number(v) >= 0 && Number(v) <= 1e9)) throw new Error("Enter a valid " + n + ".");
  const net = a + b - d;
  if (!(net > 0)) throw new Error("The net pay must be more than zero.");
  return { amount: fromKobo(a), bonus: fromKobo(b), deductions: fromKobo(d), net: fromKobo(net) };
}
const validPeriod = p => /^\d{4}-(0[1-9]|1[0-2])$/.test(p || "");
function validateAttendance(date, entries, now = new Date()) {
  const today = lagosToday(now);
  if (!isDate(date)) return "Enter a valid date.";
  if (date > today) return "You cannot record attendance for a future date.";
  if (date < addDays(today, -400)) return "That date is too far in the past.";
  if (!Array.isArray(entries) || !entries.length || entries.length > 500) return "Mark at least one person.";
  for (const e of entries) if (!ATT_STATUSES.includes(e.status)) return "Invalid attendance status.";
  return "";
}

/* ---------- appointments ---------- */
function validateAppointment(b, now = new Date()) {
  const errors = [], out = {}, today = lagosToday(now);
  out.customer_name = str(b.customerName, 80); out.customer_phone = str(b.customerPhone, 20);
  if (out.customer_phone && !normalizePhoneNG(out.customer_phone)) errors.push("Enter a valid Nigerian phone number."); else if (out.customer_phone) out.customer_phone = normalizePhoneNG(out.customer_phone);
  out.service_name = str(b.serviceName, 80); if (out.service_name.length < 2) errors.push("Choose or type the service.");
  out.date = str(b.date, 10); if (!isDate(out.date)) errors.push("Enter a valid date.");
  else if (out.date < today) errors.push("The date cannot be in the past."); else if (out.date > addDays(today, 730)) errors.push("The date is too far ahead.");
  out.time = str(b.time, 5); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.time)) errors.push("Enter a valid time.");
  const dur = Number(b.durationMin); if (!(Number.isInteger(dur) && dur >= 5 && dur <= 720)) errors.push("Duration must be between 5 minutes and 12 hours."); else out.duration_min = dur;
  const price = Number(b.price || 0); if (!(price >= 0 && price <= 1e9)) errors.push("Enter a valid price."); else out.price = fromKobo(toKobo(price));
  out.notes = str(b.notes, 300);
  if (out.customer_name.length < 2) errors.push("Enter the customer's name.");
  return { value: out, errors };
}
const toMin = hhmm => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const rangesOverlap = (s1, e1, s2, e2) => s1 < e2 && s2 < e1;
const APPT_NEXT = { booked: ["confirmed", "completed", "cancelled", "no_show"], confirmed: ["completed", "cancelled", "no_show"], completed: [], cancelled: [], no_show: [] };
const canMoveAppt = (from, to) => (APPT_NEXT[from] || []).includes(to);

/* ---------- transfers ---------- */
function validateTransfer({ fromBranch, toBranch, items }) {
  if (!fromBranch || !toBranch) return "Choose both branches.";
  if (String(fromBranch) === String(toBranch)) return "Choose two different branches.";
  if (!Array.isArray(items) || !items.length || items.length > 100) return "Add between 1 and 100 items.";
  for (const i of items) { const q = q3(i.qty); if (!(q > 0 && q <= 1e6)) return "Enter a valid quantity for every item."; }
  return "";
}

/* ---------- expiry lots ---------- */
/* Stock is the truth. Assume the oldest-expiring stock is sold first (FEFO): what has been used up
   (total lots received minus stock on hand) comes off the earliest-expiring lots first. */
function deriveLots(lots, stockQty) {
  const sorted = [...lots].sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)) || a.id - b.id);
  let used = Math.max(0, q3(sorted.reduce((s, l) => s + Number(l.qty), 0) - Number(stockQty)));
  return sorted.map(l => { const take = Math.min(used, Number(l.qty)); used = q3(used - take); return { ...l, remaining: q3(Number(l.qty) - take) }; });
}
function lotStatus(expiry, today, soonDays = 30) {
  if (expiry < today) return "expired";
  return expiry <= addDays(today, soonDays) ? "soon" : "ok";
}
function reorderSuggestion({ stock, reorderLevel }) {
  const s = Number(stock), r = Number(reorderLevel);
  if (!(r > 0) || s > r) return 0;
  return Math.max(1, Math.ceil(r * 2 - s));
}

/* ---------- reports ---------- */
function reportRange(from, to, level, now = new Date()) {
  const today = lagosToday(now), max = level === "full" ? 366 : 31;
  const t = isDate(to) ? to : today, f = isDate(from) ? from : addDays(t, -29);
  if (f > t) return { error: "The start date is after the end date." };
  if ((Date.parse(t) - Date.parse(f)) / 86400000 + 1 > max) return { error: level === "full" ? "Choose a range of up to 12 months." : "Your plan covers up to 31 days at a time. Upgrade for longer reports.", code: level === "full" ? undefined : "plan_feature" };
  return { from: f, to: t, max };
}
function cleanFeatures(input, current = {}) {
  const out = { ...current };
  for (const [k, kind] of Object.entries(FEATURE_KEYS)) {
    if (!input || !(k in input)) continue;
    if (kind === "bool") out[k] = input[k] === true || input[k] === "true";
    else if (kind.includes(input[k])) out[k] = input[k];
  }
  return out;
}

module.exports = { ATT_STATUSES, PAY_TYPES, APPT_STATUSES, FEATURE_KEYS, validateStaff, computePayroll, validPeriod, validateAttendance, validateAppointment, toMin, rangesOverlap, canMoveAppt, validateTransfer, deriveLots, lotStatus, reorderSuggestion, reportRange, cleanFeatures };
