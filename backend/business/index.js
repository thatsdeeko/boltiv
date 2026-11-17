"use strict";
/* BOLTIV Business Manager (Phase 1: businesses, branches, team roles, subscriptions, audit log).
   Self-contained module, wired into server.js with one require + one route hook (like payscribe-cards.js).
   Rules this module follows:
   - Every query that touches tenant data is scoped by business_id, and every request first passes getCtx()
     (membership + role + subscription check). No route reads a business without it.
   - Money is computed on the server only. The browser sends what it expects to pay; the server re-prices
     and refuses if it differs. Wallet debits are atomic, ledgered and idempotent. */
const crypto = require("node:crypto");
const L = require("./logic");
const P4 = require("./logic4");
const { createSchema } = require("./schema");
const createCommerce = require("./commerce");
const createAccounting = require("./accounting");
const createPeople = require("./people");
const createAppointments = require("./appointments");
const createInsights = require("./insights");

module.exports = function createBusinessManager(d) {
  const { db, pool, send, body, clean, userFromToken, verifyPassword, reference, addFinancialLedger, addNotification,
    addNotificationOnce, getPlatformSetting, rateLimit, rateLimitedResponse, adminFromToken, requireAdminCsrf, requestIp } = d;

  const ALL_PERMS = ["business.view", "business.edit", "branches.manage", "members.view", "members.manage", "billing.view", "billing.manage",
    "audit.view", "sales.void", "expenses.view", "expenses.manage", "suppliers.view", "suppliers.manage", "purchases.view", "purchases.manage", "invoices.view", "invoices.manage", "finance.view", "staff.view", "staff.manage", "payroll.manage", "appointments.view", "appointments.manage", "services.manage", "reports.view", "pos.sell", "pos.discount", "pos.custom_item", "sales.create", "sales.view", "inventory.view", "inventory.manage", "customers.view", "customers.manage",
    "expenses.manage", "finance.view", "invoices.manage", "reports.view", "suppliers.manage", "appointments.manage"];

  class Fail extends Error { constructor(code, message, extra) { super(message); this.code = code; this.extra = extra || {}; } }
  const fail = (code, message, extra) => { throw new Fail(code, message, extra); };
  const ip = req => (requestIp ? requestIp(req) : String(req.socket?.remoteAddress || ""));
  const posInt = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

  /* ---------- schema + settings ---------- */
  let tablesReady = null;
  function ensureTables() {
    if (!tablesReady) tablesReady = createSchema(db).catch(e => { tablesReady = null; throw e; });
    return tablesReady;
  }
  async function setSetting(key, value) {
    await db(`INSERT INTO platform_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`, [key, JSON.stringify(value)]);
  }
  async function cfg() {
    const g = async (k, f) => { try { const v = await getPlatformSetting(k, f); return v === null || v === undefined ? f : v; } catch { return f; } };
    const [en, d6, d12, grace, trialDays, trialPlan, maxBiz] = await Promise.all([
      g("bm_enabled", true), g("bm_discount_6", 5), g("bm_discount_12", 10), g("bm_grace_days", 7), g("bm_trial_days", 0), g("bm_trial_plan", "starter"), g("bm_max_businesses", 5)]);
    return {
      enabled: en !== false && en !== "false", discounts: { 6: L.discountPct(6, { 6: d6 }), 12: L.discountPct(12, { 12: d12 }) },
      graceDays: Math.min(60, Math.max(0, Number(grace) || 0)), trialDays: Math.min(90, Math.max(0, Number(trialDays) || 0)),
      trialPlan: clean(trialPlan) || "starter", maxBusinesses: Math.min(50, Math.max(1, Number(maxBiz) || 5))
    };
  }

  /* ---------- helpers ---------- */
  const qOf = c => (c ? (s, p) => c.query(s, p) : db);
  async function audit(c, req, ctx, action, entity, entityId, oldV, newV) {
    await qOf(c)(`INSERT INTO bm_audit_logs(business_id,user_id,actor_label,action,entity,entity_id,old_value,new_value,ip) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
      [ctx.business.id, ctx.uid, ctx.user.name || ctx.user.email || ctx.uid, action, entity || null, entityId == null ? null : String(entityId),
        oldV == null ? null : JSON.stringify(oldV), newV == null ? null : JSON.stringify(newV), ip(req)]);
  }
  async function getSub(businessId, c) {
    return (await qOf(c)(`SELECT s.*, p.name AS plan_name, p.max_branches, p.max_members, p.features, p.price_monthly, p.enabled AS plan_enabled
      FROM bm_subscriptions s JOIN bm_plans p ON p.key=s.plan_key WHERE s.business_id=$1`, [businessId])).rows[0] || null;
  }
  async function usage(businessId, c) {
    const r = await qOf(c)(`SELECT (SELECT COUNT(*) FROM bm_branches WHERE business_id=$1 AND status='active') AS branches,
      (SELECT COUNT(*) FROM bm_members WHERE business_id=$1 AND status='active') AS members`, [businessId]);
    return { branches: Number(r.rows[0].branches), members: Number(r.rows[0].members) };
  }
  async function checkPin(uid, pin) {
    const s = await db(`SELECT transaction_pin_hash FROM user_security WHERE user_id=$1 LIMIT 1`, [uid]);
    const h = s.rows[0]?.transaction_pin_hash;
    if (!h) return "Please set your Transaction PIN first.";
    if (!/^\d{4}$/.test(String(pin || "")) || !verifyPassword(String(pin), h)) return "Incorrect Transaction PIN.";
    return "";
  }
  async function withTx(fn) {
    const client = await pool.connect();
    try { await client.query("BEGIN"); const out = await fn(client); await client.query("COMMIT"); return out; }
    catch (e) { try { await client.query("ROLLBACK"); } catch {} throw e; }
    finally { client.release(); }
  }

  /* The single gate for tenant data. Returns {user,uid,business,role,member,sub,state,plan,cfg}.
     A user who is not an active member gets 404 (existence is not revealed). */
  async function getCtx(req, user, businessId, { perm, write = false, settings } = {}) {
    const id = posInt(businessId);
    if (!id) fail(400, "Business is required.");
    const uid = String(user.user_id);
    const r = await db(`SELECT b.*, m.id AS member_id, m.role, m.branch_ids FROM bm_businesses b
      JOIN bm_members m ON m.business_id=b.id AND m.user_id=$2 AND m.status='active' WHERE b.id=$1`, [id, uid]);
    const row = r.rows[0];
    if (!row) fail(404, "Business not found.");
    if (perm && !L.hasPerm(row.role, perm)) fail(403, "You do not have permission to do that.");
    const s = settings || await cfg();
    const sub = await getSub(id);
    const st = L.subscriptionState(sub, new Date(), s.graceDays);
    if (write) {
      if (row.status !== "active") fail(403, "This business is suspended. Contact BOLTIV support.", { code: "business_suspended" });
      if (!st.writable) fail(402, st.state === "suspended" ? "This subscription is suspended. Contact BOLTIV support." : "Your subscription is not active. Subscribe or renew to make changes.", { code: "subscription_required", state: st.state });
    }
    const { member_id, role, branch_ids, ...business } = row;
    return { user, uid, business, role, member: { id: member_id, role, branch_ids }, sub, state: st, cfg: s,
      plan: sub && { key: sub.plan_key, name: sub.plan_name, max_branches: sub.max_branches, max_members: sub.max_members, features: sub.features } };
  }
  const subView = (sub, st) => sub && ({ planKey: sub.plan_key, planName: sub.plan_name, status: sub.status, state: st.state, writable: st.writable,
    daysLeft: st.daysLeft ?? 0, graceEndsAt: st.graceEndsAt || null, startsAt: sub.starts_at, expiresAt: sub.expires_at, periodMonths: sub.period_months,
    limits: { branches: sub.max_branches, members: sub.max_members }, features: sub.features });
  const out = (res, data) => send(res, 200, { success: true, ...data });

  /* Plan features (set per plan by the admin). reports is "basic" or "full"; the others are on/off. */
  const featureOf = (ctx, key) => ((ctx.plan && ctx.plan.features) || {})[key];
  const needFeature = (ctx, key, label) => { if (!featureOf(ctx, key)) fail(403, `${label} is not included in your ${ctx.plan ? ctx.plan.name : "current"} plan. Upgrade to use it.`, { code: "plan_feature", feature: key }); };
  const base = { db, getCtx, audit, withTx, fail, posInt, out, body, clean, rateLimit, rateLimitedResponse, send, needFeature, featureOf };
  const commerce = createCommerce(base);
  const accounting = createAccounting({ ...base, helpers: commerce.helpers });
  const people = createPeople({ ...base, helpers: commerce.helpers });
  const appointments = createAppointments({ ...base, helpers: commerce.helpers });
  const insights = createInsights({ ...base, helpers: commerce.helpers });

  /* ---------- user routes ---------- */
  async function userRoutes(req, res, path, M, url) {
    const user = await userFromToken(req);
    if (!user) return send(res, 401, { success: false, message: "Please log in." });
    const uid = String(user.user_id);
    const settings = await cfg();
    if (!settings.enabled) return send(res, 503, { success: false, message: "BOLTIV Business Manager is temporarily unavailable." });
    const overall = rateLimit(req, "bm-api:" + uid, 1500, 300000); if (!overall.allowed) return rateLimitedResponse(res, overall);
    const q = url.searchParams;

    if (M === "GET" && path === "/api/business/plans") {
      const r = await db(`SELECT key,name,tagline,price_monthly,max_branches,max_members,features FROM bm_plans WHERE enabled ORDER BY sort_order, price_monthly`);
      return out(res, { plans: r.rows.map(p => ({ key: p.key, name: p.name, tagline: p.tagline, priceMonthly: Number(p.price_monthly), maxBranches: p.max_branches, maxMembers: p.max_members, features: p.features })),
        discounts: settings.discounts, periods: L.PERIODS, trialDays: settings.trialDays });
    }

    if (M === "GET" && path === "/api/business/mine") {
      const r = await db(`SELECT b.id,b.name,b.industry,b.status,m.role,s.plan_key,s.status AS sub_status,s.expires_at,p.name AS plan_name
        FROM bm_members m JOIN bm_businesses b ON b.id=m.business_id LEFT JOIN bm_subscriptions s ON s.business_id=b.id LEFT JOIN bm_plans p ON p.key=s.plan_key
        WHERE m.user_id=$1 AND m.status='active' ORDER BY b.created_at`, [uid]);
      return out(res, { businesses: r.rows.map(x => {
        const st = L.subscriptionState(x.plan_key ? { status: x.sub_status, expires_at: x.expires_at } : null, new Date(), settings.graceDays);
        return { id: Number(x.id), name: x.name, industry: x.industry, status: x.status, role: x.role, planName: x.plan_name || null, subscriptionState: st.state, daysLeft: st.daysLeft ?? 0, expiresAt: x.expires_at || null };
      }), canCreate: true });
    }

    if (M === "POST" && path === "/api/business/create") {
      const rl = rateLimit(req, "bm-create:" + uid, 5, 3600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const v = L.validateBusiness(b); if (v.errors.length) fail(400, v.errors[0]);
      const owned = await db(`SELECT COUNT(*)::int AS n, bool_or(lower(name)=lower($2)) AS dupe FROM bm_businesses WHERE owner_user_id=$1 AND status<>'closed'`, [uid, v.value.name]);
      if (owned.rows[0].dupe) fail(409, "You already have a business with this name.");
      if (owned.rows[0].n >= settings.maxBusinesses) fail(403, `You can register up to ${settings.maxBusinesses} businesses.`);
      const trialPlan = settings.trialDays > 0 ? (await db(`SELECT key FROM bm_plans WHERE key=$1 AND enabled`, [settings.trialPlan])).rows[0] : null;
      const created = await withTx(async c => {
        const bz = (await c.query(`INSERT INTO bm_businesses(owner_user_id,name,industry,phone,email,address,state,tin) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [uid, v.value.name, v.value.industry || null, v.value.phone || null, v.value.email || null, v.value.address || null, v.value.state || null, v.value.tin || null])).rows[0];
        await c.query(`INSERT INTO bm_branches(business_id,name,address,phone,is_main) VALUES($1,$2,$3,$4,TRUE)`, [bz.id, clean(b.branchName).slice(0, 60) || "Main Branch", v.value.address || null, v.value.phone || null]);
        await c.query(`INSERT INTO bm_members(business_id,user_id,role,added_by) VALUES($1,$2,'owner',$2)`, [bz.id, uid]);
        if (trialPlan) await c.query(`INSERT INTO bm_subscriptions(business_id,plan_key,status,period_months,starts_at,expires_at,paid_amount) VALUES($1,$2,'trial',1,NOW(),NOW()+make_interval(days=>$3),0)`, [bz.id, trialPlan.key, settings.trialDays]);
        await audit(c, req, { business: bz, uid, user }, "business.create", "business", bz.id, null, { name: bz.name, trial: !!trialPlan });
        return bz;
      });
      return out(res, { businessId: Number(created.id), trial: !!trialPlan, message: trialPlan ? `Business created. Your ${settings.trialDays}-day free trial has started.` : "Business created. Choose a plan to start using it." });
    }

    if (M === "GET" && path === "/api/business/detail") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "business.view", settings });
      const branches = (await db(`SELECT id,name,address,phone,is_main,status FROM bm_branches WHERE business_id=$1 ORDER BY is_main DESC, id`, [ctx.business.id])).rows
        .filter(x => L.canAccessBranch(ctx.member, x.id));
      return out(res, { business: { id: Number(ctx.business.id), name: ctx.business.name, industry: ctx.business.industry, phone: ctx.business.phone, email: ctx.business.email,
        address: ctx.business.address, state: ctx.business.state, tin: ctx.business.tin, currency: ctx.business.currency, status: ctx.business.status,
        vatRate: Number(ctx.business.vat_rate || 0), vatInclusive: !!ctx.business.vat_inclusive, receiptFooter: ctx.business.receipt_footer },
        branches: branches.map(x => ({ id: Number(x.id), name: x.name, address: x.address, phone: x.phone, isMain: x.is_main, status: x.status })),
        role: ctx.role, permissions: ALL_PERMS.filter(p => L.hasPerm(ctx.role, p)), subscription: subView(ctx.sub, ctx.state) || { state: "none", writable: false },
        usage: await usage(ctx.business.id) });
    }

    if (M === "POST" && path === "/api/business/update") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "business.edit", write: true, settings });
      const v = L.validateBusiness(b, { partial: true }); if (v.errors.length) fail(400, v.errors[0]);
      const same = k => (k === "vat_rate" ? Number(ctx.business[k] || 0) === v.value[k] : (ctx.business[k] ?? (typeof v.value[k] === "boolean" ? false : "")) === v.value[k]);
      const keys = Object.keys(v.value).filter(k => !same(k));
      if (!keys.length) return out(res, { message: "Nothing to update." });
      await withTx(async c => {
        await c.query(`UPDATE bm_businesses SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(",")}, updated_at=NOW() WHERE id=$1`, [ctx.business.id, ...keys.map(k => (v.value[k] === "" ? null : v.value[k]))]);
        await audit(c, req, ctx, "business.update", "business", ctx.business.id, Object.fromEntries(keys.map(k => [k, ctx.business[k]])), Object.fromEntries(keys.map(k => [k, v.value[k]])));
      });
      return out(res, { message: "Business updated." });
    }

    if (M === "POST" && path === "/api/business/branches/save") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "branches.manage", write: true, settings });
      const name = clean(b.name).slice(0, 60), address = clean(b.address).slice(0, 200), phone = clean(b.phone).slice(0, 20);
      if (name.length < 2) fail(400, "Branch name must be at least 2 characters.");
      if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) fail(400, "Enter a valid phone number.");
      try {
        await withTx(async c => {
          if (b.id) {
            const cur = (await c.query(`SELECT * FROM bm_branches WHERE id=$1 AND business_id=$2 FOR UPDATE`, [posInt(b.id), ctx.business.id])).rows[0];
            if (!cur) fail(404, "Branch not found.");
            const status = b.status === "inactive" ? "inactive" : "active";
            if (cur.is_main && status === "inactive") fail(400, "The main branch cannot be deactivated.");
            if (status === "active" && cur.status !== "active") {
              await c.query(`SELECT id FROM bm_businesses WHERE id=$1 FOR UPDATE`, [ctx.business.id]);
              const u = await usage(ctx.business.id, c);
              if (ctx.plan.max_branches >= 0 && u.branches >= ctx.plan.max_branches) fail(403, "Your plan's branch limit is reached. Upgrade to add more.", { code: "plan_limit" });
            }
            await c.query(`UPDATE bm_branches SET name=$3,address=$4,phone=$5,status=$6,updated_at=NOW() WHERE id=$1 AND business_id=$2`, [cur.id, ctx.business.id, name, address || null, phone || null, status]);
            await audit(c, req, ctx, "branch.update", "branch", cur.id, { name: cur.name, address: cur.address, phone: cur.phone, status: cur.status }, { name, address, phone, status });
          } else {
            await c.query(`SELECT id FROM bm_businesses WHERE id=$1 FOR UPDATE`, [ctx.business.id]);
            const u = await usage(ctx.business.id, c);
            if (ctx.plan.max_branches >= 0 && u.branches >= ctx.plan.max_branches) fail(403, "Your plan's branch limit is reached. Upgrade to add more.", { code: "plan_limit" });
            const nb = (await c.query(`INSERT INTO bm_branches(business_id,name,address,phone) VALUES($1,$2,$3,$4) RETURNING id`, [ctx.business.id, name, address || null, phone || null])).rows[0];
            await audit(c, req, ctx, "branch.create", "branch", nb.id, null, { name, address, phone });
          }
        });
      } catch (e) { if (e.code === "23505") fail(409, "A branch with this name already exists."); throw e; }
      return out(res, { message: "Branch saved." });
    }

    if (M === "GET" && path === "/api/business/members") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "members.view", settings });
      const r = await db(`SELECT m.id,m.user_id,m.role,m.branch_ids,m.status,m.created_at,u.name,u.email FROM bm_members m LEFT JOIN users u ON u.user_id=m.user_id
        WHERE m.business_id=$1 AND m.status<>'removed' ORDER BY (m.role='owner') DESC, m.id`, [ctx.business.id]);
      return out(res, { members: r.rows.map(x => ({ id: Number(x.id), name: x.name, email: x.email, role: x.role, branchIds: x.branch_ids ? x.branch_ids.map(Number) : null, status: x.status, isYou: x.user_id === ctx.uid })),
        canManage: L.hasPerm(ctx.role, "members.manage"), assignableRoles: L.ROLES.filter(r2 => L.canAssignRole(ctx.role, r2)) });
    }

    if (M === "POST" && path === "/api/business/members/add") {
      const rl = rateLimit(req, "bm-member-add:" + uid, 20, 3600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "members.manage", write: true, settings });
      const role = clean(b.role).toLowerCase(), email = clean(b.email).toLowerCase();
      if (!L.canAssignRole(ctx.role, role)) fail(403, "You cannot assign that role.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid email address.");
      const target = (await db(`SELECT user_id,name FROM users WHERE lower(email)=$1 AND status='active'`, [email])).rows[0];
      if (!target) fail(404, "No BOLTIV account found for that email. Ask them to sign up first.");
      await withTx(async c => {
        await c.query(`SELECT id FROM bm_businesses WHERE id=$1 FOR UPDATE`, [ctx.business.id]);
        const branchIds = Array.isArray(b.branchIds) && b.branchIds.length ? await validBranchIds(c, ctx.business.id, b.branchIds) : null;
        const ex = (await c.query(`SELECT id,status FROM bm_members WHERE business_id=$1 AND user_id=$2 FOR UPDATE`, [ctx.business.id, target.user_id])).rows[0];
        if (ex && ex.status === "active") fail(409, "This person is already on the team.");
        const u = await usage(ctx.business.id, c);
        if (ctx.plan.max_members >= 0 && u.members >= ctx.plan.max_members) fail(403, "Your plan's team limit is reached. Upgrade to add more people.", { code: "plan_limit" });
        const row = ex
          ? (await c.query(`UPDATE bm_members SET role=$3,branch_ids=$4::bigint[],status='active',added_by=$5,updated_at=NOW() WHERE id=$1 AND business_id=$2 RETURNING id`, [ex.id, ctx.business.id, role, branchIds, ctx.uid])).rows[0]
          : (await c.query(`INSERT INTO bm_members(business_id,user_id,role,branch_ids,added_by) VALUES($1,$2,$3,$4::bigint[],$5) RETURNING id`, [ctx.business.id, target.user_id, role, branchIds, ctx.uid])).rows[0];
        await audit(c, req, ctx, "member.add", "member", row.id, null, { email, role, branchIds });
      });
      try { await addNotification(target.user_id, "You were added to a business", `You now have the ${role} role at ${ctx.business.name} on BOLTIV Business Manager.`, "info"); } catch {}
      return out(res, { message: "Team member added." });
    }

    if (M === "POST" && (path === "/api/business/members/update" || path === "/api/business/members/remove")) {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "members.manage", write: true, settings });
      const remove = path.endsWith("/remove");
      await withTx(async c => {
        const cur = (await c.query(`SELECT * FROM bm_members WHERE id=$1 AND business_id=$2 FOR UPDATE`, [posInt(b.memberId), ctx.business.id])).rows[0];
        if (!cur || cur.status === "removed") fail(404, "Team member not found.");
        if (cur.role === "owner") fail(403, "The owner cannot be changed.");
        if (!L.canAssignRole(ctx.role, cur.role)) fail(403, "You cannot manage this person.");
        let role = cur.role, status = cur.status, branchIds = cur.branch_ids;
        if (remove) status = "removed";
        else {
          if (b.role !== undefined) { role = clean(b.role).toLowerCase(); if (!L.canAssignRole(ctx.role, role)) fail(403, "You cannot assign that role."); }
          if (b.status !== undefined) { if (!["active", "inactive"].includes(b.status)) fail(400, "Invalid status."); status = b.status; }
          if (b.branchIds !== undefined) branchIds = Array.isArray(b.branchIds) && b.branchIds.length ? await validBranchIds(c, ctx.business.id, b.branchIds) : null;
        }
        if (status === "active" && cur.status !== "active") {
          await c.query(`SELECT id FROM bm_businesses WHERE id=$1 FOR UPDATE`, [ctx.business.id]);
          const u = await usage(ctx.business.id, c);
          if (ctx.plan.max_members >= 0 && u.members >= ctx.plan.max_members) fail(403, "Your plan's team limit is reached.", { code: "plan_limit" });
        }
        await c.query(`UPDATE bm_members SET role=$3,status=$4,branch_ids=$5::bigint[],updated_at=NOW() WHERE id=$1 AND business_id=$2`, [cur.id, ctx.business.id, role, status, branchIds]);
        await audit(c, req, ctx, remove ? "member.remove" : "member.update", "member", cur.id,
          { role: cur.role, status: cur.status, branchIds: cur.branch_ids }, { role, status, branchIds });
      });
      return out(res, { message: remove ? "Team member removed." : "Team member updated." });
    }

    if (M === "GET" && path === "/api/business/subscription") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "billing.view", settings });
      const pays = (await db(`SELECT reference,plan_key,period_months,list_amount,discount_pct,discount_amount,credit_amount,amount,mode,starts_at,expires_at,created_at FROM bm_subscription_payments
        WHERE business_id=$1 ORDER BY id DESC LIMIT 20`, [ctx.business.id])).rows;
      return out(res, { subscription: subView(ctx.sub, ctx.state) || { state: "none", writable: false }, usage: await usage(ctx.business.id), canPay: L.hasPerm(ctx.role, "billing.manage"),
        discounts: settings.discounts, graceDays: settings.graceDays,
        payments: pays.map(p => ({ reference: p.reference, planKey: p.plan_key, months: p.period_months, listAmount: Number(p.list_amount), discountPct: Number(p.discount_pct), discountAmount: Number(p.discount_amount),
          creditAmount: Number(p.credit_amount), amount: Number(p.amount), mode: p.mode, startsAt: p.starts_at, expiresAt: p.expires_at, createdAt: p.created_at })) });
    }

    if (M === "POST" && (path === "/api/business/subscription/quote" || path === "/api/business/subscription/pay")) {
      const pay = path.endsWith("/pay");
      const rl = rateLimit(req, (pay ? "bm-pay:" : "bm-quote:") + uid, pay ? 10 : 60, pay ? 600000 : 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "billing.manage", settings });
      if (ctx.business.status !== "active") fail(403, "This business is suspended. Contact BOLTIV support.");
      const months = Number(b.months), planKey = clean(b.planKey);
      if (!L.PERIODS.includes(months)) fail(400, "Choose 1, 6 or 12 months.");
      if (!pay) {
        const plan = (await db(`SELECT * FROM bm_plans WHERE key=$1 AND enabled`, [planKey])).rows[0]; if (!plan) fail(404, "Plan not found.");
        const quote = L.computeQuote({ sub: ctx.sub, plan, months, discounts: settings.discounts, graceDays: settings.graceDays });
        const w = (await db(`SELECT balance FROM wallets WHERE user_id=$1`, [ctx.uid])).rows[0];
        const issues = L.fitsPlan(plan, await usage(ctx.business.id));
        return out(res, { quote, walletBalance: Number(w?.balance || 0), sufficient: Number(w?.balance || 0) >= quote.amount, blockedReason: issues.length ? `Reduce your team or branches first: ${issues.join(", ")}.` : null });
      }
      const pinErr = await checkPin(ctx.uid, b.transactionPin); if (pinErr) fail(400, pinErr);
      const idem = clean(b.idempotencyKey).slice(0, 80);
      const ref = idem ? "BMSUB-" + crypto.createHash("sha256").update(`${ctx.uid}|${ctx.business.id}|${idem}`).digest("hex").slice(0, 32).toUpperCase() : reference("BMSUB");
      const result = await withTx(async c => {
        await c.query(`SELECT id FROM bm_businesses WHERE id=$1 FOR UPDATE`, [ctx.business.id]);
        const dupe = (await c.query(`SELECT * FROM bm_subscription_payments WHERE reference=$1`, [ref])).rows[0];
        if (dupe) { if (String(dupe.business_id) !== String(ctx.business.id) || dupe.user_id !== ctx.uid) fail(409, "Duplicate request."); return { already: true, pay: dupe }; }
        const plan = (await c.query(`SELECT * FROM bm_plans WHERE key=$1 AND enabled`, [planKey])).rows[0]; if (!plan) fail(404, "Plan not found.");
        const sub = await getSub(ctx.business.id, c);
        const quote = L.computeQuote({ sub, plan, months, discounts: settings.discounts, graceDays: settings.graceDays });
        if (b.expectedAmount !== undefined && Math.abs(Number(b.expectedAmount) - quote.amount) > 0.001) fail(409, "The price changed. Please review the new amount.", { code: "price_changed", quote });
        const issues = L.fitsPlan(plan, await usage(ctx.business.id, c));
        if (issues.length) fail(409, `This plan is too small for your business: ${issues.join(", ")}.`, { code: "plan_too_small" });
        let balance = null;
        if (quote.amount > 0) {
          await c.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`, [ctx.uid]);
          const w = await c.query(`UPDATE wallets SET balance=balance-$1,updated_at=NOW() WHERE user_id=$2 AND balance>=$1 RETURNING balance`, [quote.amount, ctx.uid]);
          if (!w.rows.length) fail(400, "Insufficient wallet balance. Fund your wallet and try again.", { code: "insufficient_balance" });
          balance = Number(w.rows[0].balance);
          await addFinancialLedger(c, { accountType: "customer_wallet", ownerId: ctx.uid, direction: "debit", amount: -quote.amount, balanceAfter: balance, reference: `WALLET-${ref}`,
            category: "business_subscription", description: `BOLTIV Business ${plan.name} (${months} month${months > 1 ? "s" : ""})`, metadata: { business_id: Number(ctx.business.id), plan: plan.key, months } });
        }
        const upd = quote.mode === "extend"
          ? await c.query(`UPDATE bm_subscriptions SET period_months=$2,expires_at=expires_at+make_interval(months=>$2),paid_amount=paid_amount+$3,updated_at=NOW() WHERE business_id=$1 RETURNING starts_at,expires_at`, [ctx.business.id, months, quote.heldValue])
          : await c.query(`INSERT INTO bm_subscriptions(business_id,plan_key,status,period_months,starts_at,expires_at,paid_amount) VALUES($1,$2,'active',$3,NOW(),NOW()+make_interval(months=>$3),$4)
              ON CONFLICT(business_id) DO UPDATE SET plan_key=EXCLUDED.plan_key,status='active',period_months=EXCLUDED.period_months,starts_at=EXCLUDED.starts_at,expires_at=EXCLUDED.expires_at,paid_amount=EXCLUDED.paid_amount,updated_at=NOW()
              RETURNING starts_at,expires_at`, [ctx.business.id, plan.key, months, quote.heldValue]);
        const p = (await c.query(`INSERT INTO bm_subscription_payments(reference,business_id,user_id,plan_key,period_months,list_amount,discount_pct,discount_amount,credit_amount,amount,mode,starts_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [ref, ctx.business.id, ctx.uid, plan.key, months, quote.listAmount, quote.discountPct, quote.discountAmount, quote.creditAmount, quote.amount, quote.mode, upd.rows[0].starts_at, upd.rows[0].expires_at])).rows[0];
        await audit(c, req, ctx, "subscription.pay", "subscription", ctx.business.id, sub && { plan: sub.plan_key, expires_at: sub.expires_at },
          { plan: plan.key, months, amount: quote.amount, mode: quote.mode, expires_at: upd.rows[0].expires_at, reference: ref });
        return { pay: p, balance, planName: plan.name };
      });
      if (!result.already) { try { await addNotification(ctx.uid, "Business subscription active", `${ctx.business.name} is on the ${result.planName} plan until ${new Date(result.pay.expires_at).toDateString()}.`, "success"); } catch {} }
      return out(res, { already: !!result.already, message: result.already ? "This payment was already processed." : "Subscription activated.", reference: ref,
        amount: Number(result.pay.amount), expiresAt: result.pay.expires_at, balance: result.balance ?? null });
    }

    if (M === "GET" && path === "/api/business/audit") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "audit.view", settings });
      const limit = Math.min(100, Math.max(1, Number(q.get("limit")) || 30)), offset = Math.max(0, Number(q.get("offset")) || 0);
      const r = await db(`SELECT id,actor_label,action,entity,entity_id,old_value,new_value,created_at FROM bm_audit_logs WHERE business_id=$1 ORDER BY id DESC LIMIT $2 OFFSET $3`, [ctx.business.id, limit, offset]);
      return out(res, { logs: r.rows.map(x => ({ id: Number(x.id), actor: x.actor_label, action: x.action, entity: x.entity, entityId: x.entity_id, oldValue: x.old_value, newValue: x.new_value, at: x.created_at })), limit, offset });
    }

    if (await commerce.handle(req, res, path, M, url, user, settings) !== false) return;
    if (await accounting.handle(req, res, path, M, url, user, settings) !== false) return;
    for (const mod of [people, appointments, insights]) if (await mod.handle(req, res, path, M, url, user, settings) !== false) return;
    return send(res, 404, { success: false, message: "Route not found." });
  }

  async function validBranchIds(c, businessId, ids) {
    const want = [...new Set(ids.map(posInt).filter(Boolean))];
    if (!want.length) return null;
    const r = await c.query(`SELECT id FROM bm_branches WHERE business_id=$1 AND status='active' AND id=ANY($2::bigint[])`, [businessId, want]);
    if (r.rows.length !== want.length) fail(400, "One or more branches are invalid.");
    return want;
  }

  /* ---------- admin routes ---------- */
  async function adminRoutes(req, res, path, M, url) {
    const admin = await adminFromToken(req);
    if (admin) { const ar = rateLimit(req, "bm-admin:" + admin.id, 600, 300000); if (!ar.allowed) return rateLimitedResponse(res, ar); }
    if (!admin) return send(res, 401, { success: false, message: "Unauthorized." });
    if (M !== "GET") { const chk = await requireAdminCsrf(req); if (!chk.success) return send(res, chk.statusCode || 403, chk); }
    const q = url.searchParams;
    const adminAudit = (action, target, details) => db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details,ip) VALUES($1,$2,'business',$3,$4::jsonb,$5)`, [admin.id, action, String(target), JSON.stringify(details || {}), ip(req)]);

    if (M === "GET" && path === "/api/admin/business/overview") {
      const [b, bySub, rev, exp, members] = await Promise.all([
        db(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at>NOW()-interval '30 days')::int AS new30, COUNT(*) FILTER (WHERE status='suspended')::int AS suspended FROM bm_businesses`),
        db(`SELECT plan_key, COUNT(*)::int AS n FROM bm_subscriptions WHERE status IN('active','trial') AND expires_at>NOW() GROUP BY plan_key`),
        db(`SELECT COALESCE(SUM(amount),0) AS total, COALESCE(SUM(amount) FILTER (WHERE created_at>NOW()-interval '30 days'),0) AS d30, COUNT(*)::int AS n FROM bm_subscription_payments WHERE status='paid'`),
        db(`SELECT COUNT(*)::int AS n FROM bm_subscriptions WHERE status='active' AND expires_at BETWEEN NOW() AND NOW()+interval '7 days'`),
        db(`SELECT COUNT(*)::int AS n FROM bm_members WHERE status='active'`)]);
      return out(res, { businesses: b.rows[0], activeByPlan: Object.fromEntries(bySub.rows.map(x => [x.plan_key, x.n])), revenue: { total: Number(rev.rows[0].total), last30Days: Number(rev.rows[0].d30), payments: rev.rows[0].n },
        expiringIn7Days: exp.rows[0].n, activeMembers: members.rows[0].n });
    }

    if (M === "GET" && path === "/api/admin/business/plans") {
      const r = await db(`SELECT * FROM bm_plans ORDER BY sort_order, price_monthly`);
      return out(res, { plans: r.rows.map(p => ({ key: p.key, name: p.name, tagline: p.tagline, priceMonthly: Number(p.price_monthly), maxBranches: p.max_branches, maxMembers: p.max_members, features: p.features, enabled: p.enabled })) });
    }
    if (M === "POST" && path === "/api/admin/business/plans/update") {
      const b = await body(req);
      const key = clean(b.key).toLowerCase(); const cur = (await db(`SELECT * FROM bm_plans WHERE key=$1`, [key])).rows[0]; if (!cur) fail(404, "Plan not found.");
      const price = Number(b.priceMonthly), br = Number(b.maxBranches), mem = Number(b.maxMembers);
      if (!(price > 0 && price <= 10000000)) fail(400, "Price must be between 1 and 10,000,000.");
      if (!Number.isInteger(br) || br < -1 || br === 0 || br > 1000 || !Number.isInteger(mem) || mem < -1 || mem === 0 || mem > 10000) fail(400, "Limits must be a positive whole number, or -1 for unlimited.");
      const name = clean(b.name).slice(0, 40); if (name.length < 2) fail(400, "Plan name is required.");
      const features = P4.cleanFeatures(b.features && typeof b.features === "object" && !Array.isArray(b.features) ? b.features : {}, cur.features || {});
      await db(`UPDATE bm_plans SET name=$2,tagline=$3,price_monthly=$4,max_branches=$5,max_members=$6,features=$7::jsonb,enabled=$8,updated_at=NOW() WHERE key=$1`,
        [key, name, clean(b.tagline).slice(0, 100), Math.round(price * 100) / 100, br, mem, JSON.stringify(features), b.enabled !== false]);
      await adminAudit("bm_plan_update", key, { from: { price: Number(cur.price_monthly), branches: cur.max_branches, members: cur.max_members, enabled: cur.enabled }, to: { price, branches: br, members: mem, enabled: b.enabled !== false } });
      return out(res, { message: "Plan updated. New prices apply from each business's next payment." });
    }

    if (M === "GET" && path === "/api/admin/business/settings") return out(res, { settings: await cfg() });
    if (M === "POST" && path === "/api/admin/business/settings") {
      const b = await body(req); const changes = {};
      const num = (k, lo, hi) => { if (b[k] === undefined) return; const n = Number(b[k]); if (!(n >= lo && n <= hi)) fail(400, `${k} must be between ${lo} and ${hi}.`); return n; };
      if (b.enabled !== undefined) changes.bm_enabled = Boolean(b.enabled);
      const d6 = num("discount6", 0, 90), d12 = num("discount12", 0, 90), gr = num("graceDays", 0, 60), td = num("trialDays", 0, 90), mb = num("maxBusinesses", 1, 50);
      if (d6 !== undefined) changes.bm_discount_6 = d6; if (d12 !== undefined) changes.bm_discount_12 = d12;
      if (gr !== undefined) changes.bm_grace_days = Math.floor(gr); if (td !== undefined) changes.bm_trial_days = Math.floor(td); if (mb !== undefined) changes.bm_max_businesses = Math.floor(mb);
      if (b.trialPlan !== undefined) { const p = (await db(`SELECT key FROM bm_plans WHERE key=$1`, [clean(b.trialPlan)])).rows[0]; if (!p) fail(400, "Trial plan not found."); changes.bm_trial_plan = p.key; }
      for (const [k, v] of Object.entries(changes)) await setSetting(k, v);
      await adminAudit("bm_settings_update", "settings", changes);
      return out(res, { message: "Settings saved.", settings: await cfg() });
    }

    if (M === "GET" && path === "/api/admin/business/list") {
      const search = clean(q.get("search")).slice(0, 80), limit = Math.min(100, Math.max(1, Number(q.get("limit")) || 30)), offset = Math.max(0, Number(q.get("offset")) || 0);
      const r = await db(`SELECT b.id,b.name,b.status,b.created_at,u.email AS owner_email,u.name AS owner_name,s.plan_key,s.status AS sub_status,s.expires_at,
        (SELECT COUNT(*)::int FROM bm_branches WHERE business_id=b.id AND status='active') AS branches,(SELECT COUNT(*)::int FROM bm_members WHERE business_id=b.id AND status='active') AS members
        FROM bm_businesses b LEFT JOIN users u ON u.user_id=b.owner_user_id LEFT JOIN bm_subscriptions s ON s.business_id=b.id
        WHERE ($1='' OR b.name ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%') ORDER BY b.id DESC LIMIT $2 OFFSET $3`, [search.replace(/[%_\\]/g, ""), limit, offset]);
      const s = await cfg();
      return out(res, { businesses: r.rows.map(x => ({ id: Number(x.id), name: x.name, status: x.status, ownerEmail: x.owner_email, ownerName: x.owner_name, planKey: x.plan_key || null,
        subscriptionState: L.subscriptionState(x.plan_key ? { status: x.sub_status, expires_at: x.expires_at } : null, new Date(), s.graceDays).state, expiresAt: x.expires_at || null,
        branches: x.branches, members: x.members, createdAt: x.created_at })), limit, offset });
    }

    if (M === "POST" && path === "/api/admin/business/status") {
      const b = await body(req); const id = posInt(b.businessId); const status = b.status;
      if (!id || !["active", "suspended"].includes(status)) fail(400, "Invalid request.");
      const r = await db(`UPDATE bm_businesses SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING id`, [id, status]); if (!r.rows.length) fail(404, "Business not found.");
      await adminAudit("bm_business_status", id, { status });
      return out(res, { message: status === "suspended" ? "Business suspended." : "Business reactivated." });
    }

    if (M === "POST" && path === "/api/admin/business/subscription") {
      const b = await body(req); const id = posInt(b.businessId), action = clean(b.action);
      if (!id) fail(400, "Business is required.");
      await withTx(async c => {
        await c.query(`SELECT id FROM bm_businesses WHERE id=$1 FOR UPDATE`, [id]);
        const bz = (await c.query(`SELECT id FROM bm_businesses WHERE id=$1`, [id])).rows[0]; if (!bz) fail(404, "Business not found.");
        const sub = await getSub(id, c);
        if (action === "extend") {
          const days = Number(b.days); if (!Number.isInteger(days) || days < 1 || days > 3650) fail(400, "Days must be between 1 and 3650.");
          if (sub) await c.query(`UPDATE bm_subscriptions SET expires_at=GREATEST(expires_at,NOW())+make_interval(days=>$2),status=CASE WHEN status='trial' THEN 'trial' ELSE 'active' END,updated_at=NOW() WHERE business_id=$1`, [id, days]);
          else {
            const p = (await c.query(`SELECT key FROM bm_plans WHERE key=$1`, [clean(b.planKey)])).rows[0]; if (!p) fail(400, "Choose a plan for a business with no subscription.");
            await c.query(`INSERT INTO bm_subscriptions(business_id,plan_key,status,period_months,starts_at,expires_at,paid_amount) VALUES($1,$2,'active',1,NOW(),NOW()+make_interval(days=>$3),0)`, [id, p.key, days]);
          }
        } else if (action === "set_plan") {
          const p = (await c.query(`SELECT * FROM bm_plans WHERE key=$1`, [clean(b.planKey)])).rows[0]; if (!p) fail(400, "Plan not found.");
          if (!sub) fail(400, "This business has no subscription yet. Use extend with a plan.");
          const issues = L.fitsPlan(p, await usage(id, c)); if (issues.length && b.force !== true) fail(409, `Too large for this plan: ${issues.join(", ")}.`);
          await c.query(`UPDATE bm_subscriptions SET plan_key=$2,updated_at=NOW() WHERE business_id=$1`, [id, p.key]);
        } else if (action === "suspend") {
          if (!sub) fail(400, "No subscription to suspend."); await c.query(`UPDATE bm_subscriptions SET status='suspended',updated_at=NOW() WHERE business_id=$1`, [id]);
        } else if (action === "unsuspend") {
          if (!sub || sub.status !== "suspended") fail(400, "Subscription is not suspended.");
          await c.query(`UPDATE bm_subscriptions SET status=CASE WHEN paid_amount>0 THEN 'active' ELSE 'trial' END,updated_at=NOW() WHERE business_id=$1`, [id]);
        } else fail(400, "Unknown action.");
        await c.query(`INSERT INTO bm_audit_logs(business_id,user_id,actor_label,action,entity,entity_id,new_value,ip) VALUES($1,NULL,$2,$3,'subscription',$4,$5::jsonb,$6)`,
          [id, `BOLTIV admin`, "subscription.admin_" + action, String(id), JSON.stringify({ days: b.days, planKey: b.planKey }), ip(req)]);
      });
      await adminAudit("bm_subscription_" + action, id, { days: b.days, planKey: b.planKey });
      return out(res, { message: "Subscription updated." });
    }

    return send(res, 404, { success: false, message: "Route not found." });
  }

  /* ---------- reminders (3 days before expiry, and on expiry) ---------- */
  let sweepTimer = null;
  async function sweep() {
    try {
      await ensureTables();
      const s = await cfg();
      if (!s.enabled || !addNotificationOnce) return;
      const r = await db(`SELECT b.id,b.name,b.owner_user_id,s.expires_at FROM bm_subscriptions s JOIN bm_businesses b ON b.id=s.business_id
        WHERE s.status='active' AND s.expires_at BETWEEN NOW()-interval '1 day' AND NOW()+interval '3 days' LIMIT 500`);
      for (const x of r.rows) {
        const expired = new Date(x.expires_at) <= new Date(), tag = new Date(x.expires_at).toISOString().slice(0, 10);
        await addNotificationOnce(x.owner_user_id, expired ? "Business subscription expired" : "Business subscription ending soon",
          expired ? `${x.name}'s subscription has ended. Renew within ${s.graceDays} days to keep editing.` : `${x.name}'s subscription ends on ${new Date(x.expires_at).toDateString()}. Renew from your wallet to avoid interruption.`,
          "warning", `bm-${expired ? "exp" : "soon"}-${x.id}-${tag}`);
      }
    } catch (e) { console.error("BUSINESS SWEEP ERROR:", e && e.message); }
  }
  function startSweep() { if (!sweepTimer) { sweepTimer = setInterval(sweep, 6 * 3600 * 1000); sweepTimer.unref(); setTimeout(sweep, 60000).unref(); } }

  /* PostgreSQL errors a person can trigger (a stale screen, a huge number, two things at once) get a clear message
     instead of a generic failure. Anything else stays a plain 500 and is never described to the browser. */
  function dbErrorMessage(e) {
    switch (e && e.code) {
      case "23514": return { status: 409, message: "That change would make a quantity or amount invalid. Please refresh and try again." };
      case "23503": return { status: 409, message: "Something this refers to no longer exists. Please refresh and try again." };
      case "23505": return { status: 409, message: "This already exists. Please refresh and try again." };
      case "22P02": case "22003": case "22007": case "22008": case "22001": return { status: 400, message: "One of the values is not valid or is too long or too large." };
      case "40P01": case "40001": case "55P03": return { status: 409, message: "Many changes were happening at once. Please try again." };
      default: return null;
    }
  }

  /* ---------- entry point ---------- */
  async function handle(req, res, path) {
    if (!(path.startsWith("/api/business/") || path.startsWith("/api/admin/business/"))) return false;
    try {
      await ensureTables(); startSweep();
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`), M = req.method;
      if (path.startsWith("/api/admin/business/")) await adminRoutes(req, res, path, M, url);
      else await userRoutes(req, res, path, M, url);
    } catch (e) {
      if (e instanceof Fail) send(res, e.code, { success: false, message: e.message, ...e.extra });
      else if (e && e.expected) send(res, e.statusCode || 400, { success: false, message: e.message });
      else {
        const friendly = dbErrorMessage(e);
        console.error("BUSINESS ERROR:", path, (e && e.code) || "", (e && e.stack) || e);
        if (friendly) send(res, friendly.status, { success: false, message: friendly.message });
        else send(res, 500, { success: false, message: "Something went wrong. Please try again." });
      }
    }
    return true;
  }
  return { handle, init: () => { ensureTables().then(startSweep).catch(e => console.error("BUSINESS INIT ERROR:", e && e.message)); } };
};
