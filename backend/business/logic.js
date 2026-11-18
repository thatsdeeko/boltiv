"use strict";
/* BOLTIV Business Manager: pure business rules (no database, no network).
   Everything here is unit-tested in logic.test.js. Money is handled in integer kobo. */

const DAY_MS = 86400000;
const PERIODS = [1, 6, 12];
const ROLES = ["owner", "manager", "accountant", "cashier", "staff"];

const toKobo = n => Math.round(Number(n) * 100);
const fromKobo = k => Math.round(k) / 100;

/* ---------- permissions ---------- */
const ROLE_PERMS = {
  owner: { allow: ["*"], deny: [] },
  manager: { allow: ["*"], deny: ["billing.manage", "business.delete"] },
  accountant: { allow: ["business.view", "finance.*", "expenses.*", "invoices.*", "reports.*", "suppliers.*", "purchases.view", "staff.view", "payroll.*", "sales.view", "inventory.view", "customers.view", "billing.view"], deny: [] },
  cashier: { allow: ["business.view", "pos.*", "sales.create", "sales.view", "customers.*", "inventory.view", "appointments.*"], deny: [] },
  staff: { allow: ["business.view", "inventory.view", "customers.view", "appointments.*"], deny: [] }
};
function match(pattern, perm) {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return perm.startsWith(pattern.slice(0, -1));
  return pattern === perm;
}
function hasPerm(role, perm) {
  const r = ROLE_PERMS[role];
  if (!r || !perm) return false;
  if (r.deny.some(p => match(p, perm))) return false;
  return r.allow.some(p => match(p, perm));
}
/* Who may give which role. Nobody can create another owner. */
function canAssignRole(actorRole, targetRole) {
  if (!ROLES.includes(targetRole) || targetRole === "owner") return false;
  if (actorRole === "owner") return true;
  if (actorRole === "manager") return ["accountant", "cashier", "staff"].includes(targetRole);
  return false;
}
function canAccessBranch(member, branchId) {
  if (!member) return false;
  const ids = member.branch_ids;
  if (member.role === "owner" || ids === null || ids === undefined) return true;
  return ids.map(String).includes(String(branchId));
}

/* ---------- subscription state ---------- */
function subscriptionState(sub, now = new Date(), graceDays = 7) {
  if (!sub) return { state: "none", writable: false };
  const exp = new Date(sub.expires_at).getTime();
  const t = now.getTime();
  if (sub.status === "suspended") return { state: "suspended", writable: false };
  if (exp > t) return { state: sub.status === "trial" ? "trial" : "active", writable: true, daysLeft: Math.ceil((exp - t) / DAY_MS) };
  const graceEnd = exp + Math.max(0, graceDays) * DAY_MS;
  if (t < graceEnd) return { state: "grace", writable: true, graceEndsAt: new Date(graceEnd).toISOString(), daysLeft: 0 };
  return { state: "expired", writable: false };
}

/* ---------- pricing ---------- */
function discountPct(months, discounts) {
  const p = Number((discounts || {})[months] || 0);
  return Math.min(90, Math.max(0, p));
}
/* Value of the unused part of the current paid subscription (floored, in kobo). */
function unusedCreditKobo(sub, now = new Date()) {
  if (!sub || sub.status !== "active") return 0;
  const start = new Date(sub.starts_at).getTime(), end = new Date(sub.expires_at).getTime(), t = now.getTime();
  if (!(end > t) || !(end > start)) return 0;
  const paid = toKobo(sub.paid_amount || 0);
  return Math.max(0, Math.floor(paid * (end - t) / (end - start)));
}
/* mode "extend": same plan still running, the new period is added to the end.
   mode "replace": anything else; starts now, unused value of the old plan is credited. */
function computeQuote({ sub, plan, months, discounts, now = new Date(), graceDays = 7 }) {
  if (!PERIODS.includes(months)) throw new Error("Invalid billing period.");
  if (!plan) throw new Error("Unknown plan.");
  const state = subscriptionState(sub, now, graceDays).state;
  const monthlyKobo = toKobo(plan.price_monthly);
  const gross = monthlyKobo * months;
  const pct = discountPct(months, discounts);
  const discount = Math.round(gross * pct / 100);
  const net = gross - discount;
  const extend = !!sub && sub.plan_key === plan.key && sub.status === "active" && state === "active";
  const credit = extend ? 0 : Math.min(net, unusedCreditKobo(sub, now));
  const payable = net - credit;
  return {
    mode: extend ? "extend" : "replace", planKey: plan.key, months, discountPct: pct,
    listAmount: fromKobo(gross), discountAmount: fromKobo(discount), creditAmount: fromKobo(credit),
    amount: fromKobo(payable), heldValue: fromKobo(payable + credit)
  };
}
/* Downgrade guard: refuse a plan the business no longer fits inside. -1 means unlimited. */
function fitsPlan(plan, usage) {
  const issues = [];
  if (plan.max_branches >= 0 && usage.branches > plan.max_branches) issues.push(`${usage.branches} branches (limit ${plan.max_branches})`);
  if (plan.max_members >= 0 && usage.members > plan.max_members) issues.push(`${usage.members} team members (limit ${plan.max_members})`);
  return issues;
}

/* ---------- validation ---------- */
const NG_STATES = ["Abia","Adamawa","Akwa Ibom","Anambra","Bauchi","Bayelsa","Benue","Borno","Cross River","Delta","Ebonyi","Edo","Ekiti","Enugu","FCT","Gombe","Imo","Jigawa","Kaduna","Kano","Katsina","Kebbi","Kogi","Kwara","Lagos","Nasarawa","Niger","Ogun","Ondo","Osun","Oyo","Plateau","Rivers","Sokoto","Taraba","Yobe","Zamfara"];
const str = (v, max) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);
function validateBusiness(b, { partial = false } = {}) {
  const out = {}, errors = [];
  const has = k => Object.prototype.hasOwnProperty.call(b, k);
  if (!partial || has("name")) { out.name = str(b.name, 80); if (out.name.length < 2) errors.push("Business name must be at least 2 characters."); }
  if (has("industry")) out.industry = str(b.industry, 40);
  if (has("phone")) { out.phone = str(b.phone, 20); if (out.phone && !/^\+?[0-9 ()-]{7,20}$/.test(out.phone)) errors.push("Enter a valid phone number."); }
  if (has("email")) { out.email = str(b.email, 120).toLowerCase(); if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) errors.push("Enter a valid email address."); }
  if (has("address")) out.address = str(b.address, 200);
  if (has("state")) { out.state = str(b.state, 30); if (out.state && !NG_STATES.includes(out.state)) errors.push("Choose a valid state."); }
  if (has("vatRate")) { const n = Number(b.vatRate || 0); if (!(n >= 0 && n <= 25)) errors.push("VAT rate must be between 0 and 25."); else out.vat_rate = Math.round(n * 100) / 100; }
  if (has("vatInclusive")) out.vat_inclusive = b.vatInclusive === true || b.vatInclusive === "true";
  if (has("logo")) {
    const l = typeof b.logo === "string" ? b.logo.trim() : "";
    if (l.length > 140000) errors.push("Logo is too large. Choose a smaller image.");
    else if (l && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(l)) errors.push("Logo must be a PNG, JPG or WebP image.");
    else out.logo = l;
  }
  if (has("receiptFooter")) out.receipt_footer = str(b.receiptFooter, 120);
  if (has("tin")) { out.tin = str(b.tin, 20).toUpperCase(); if (out.tin && !/^[A-Z0-9-]{5,20}$/.test(out.tin)) errors.push("TIN may only contain letters, numbers and dashes."); }
  return { value: out, errors };
}

module.exports = { PERIODS, ROLES, ROLE_PERMS, NG_STATES, DAY_MS, toKobo, fromKobo, hasPerm, canAssignRole, canAccessBranch, subscriptionState, discountPct, unusedCreditKobo, computeQuote, fitsPlan, validateBusiness };
