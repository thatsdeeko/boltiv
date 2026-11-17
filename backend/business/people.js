"use strict";
/* BOLTIV Business Manager, Phase 4: staff records, attendance, payroll.
   Paying salary creates a normal expense (category "Salaries & wages") in the same transaction, so Finance reports
   include it automatically. Pay amounts are only visible to roles with payroll access. */
const L = require("./logic");
const C = require("./logic2");
const A = require("./logic3");
const P4 = require("./logic4");

module.exports = function createPeople(h) {
  const { db, getCtx, audit, withTx, fail, posInt, out, body, clean, rateLimit, rateLimitedResponse, helpers } = h;
  const { branchFor, accessible, likeSafe } = helpers;
  const num = v => Number(v);
  const dbClient = { query: (s, p) => db(s, p) };
  const unrestricted = ctx => ctx.role === "owner" || !ctx.member.branch_ids;
  const dateStr = d => (d instanceof Date ? d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") : d ? String(d).slice(0, 10) : null);
  const canPay = ctx => L.hasPerm(ctx.role, "payroll.manage");
  const staffVisible = (ctx, row) => (row.branch_id ? L.canAccessBranch(ctx.member, row.branch_id) : unrestricted(ctx));
  const staffView = (s, ctx) => ({ id: num(s.id), name: s.name, phone: s.phone, email: s.email, jobTitle: s.job_title, branchId: s.branch_id ? num(s.branch_id) : null, branch: s.branch_name || null,
    ...(canPay(ctx) ? { payType: s.pay_type, payAmount: num(s.pay_amount) } : {}), startDate: dateStr(s.start_date), status: s.status, notes: s.notes });
  const payrollView = p => ({ id: num(p.id), staffId: num(p.staff_id), staff: p.staff_name, period: p.period, amount: num(p.amount), bonus: num(p.bonus), deductions: num(p.deductions), net: num(p.net), method: p.method, paidOn: dateStr(p.paid_on), note: p.note, status: p.status, voidReason: p.void_reason });

  async function handle(req, res, path, M, url, user, settings) {
    const q = url.searchParams, uid = String(user.user_id);

    if (M === "GET" && path === "/api/business/staff") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "staff.view", settings });
      const ids = accessible(ctx), search = likeSafe(q.get("search")), status = q.get("status") === "all" ? "" : q.get("status") === "inactive" ? "inactive" : "active";
      const r = await db(`SELECT s.*, br.name AS branch_name FROM bm_staff s LEFT JOIN bm_branches br ON br.id=s.branch_id WHERE s.business_id=$1 AND ($2::bigint[] IS NULL OR s.branch_id=ANY($2::bigint[])) AND ($3='' OR s.status=$3)
        AND ($4='' OR s.name ILIKE '%'||$4||'%' OR s.job_title ILIKE '%'||$4||'%') ORDER BY lower(s.name) LIMIT 300`, [ctx.business.id, ids, status, search]);
      return out(res, { staff: r.rows.map(s => staffView(s, ctx)), canManage: L.hasPerm(ctx.role, "staff.manage"), canPay: canPay(ctx), payTypes: P4.PAY_TYPES });
    }

    if (M === "POST" && path === "/api/business/staff/save") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "staff.manage", write: true, settings });
      const id = b.id ? posInt(b.id) : null, v = P4.validateStaff(b, { partial: !!id }); if (v.errors.length) fail(400, v.errors[0]);
      const val = v.value;
      if (!canPay(ctx)) { delete val.pay_type; delete val.pay_amount; }
      for (const k of ["phone", "email", "job_title", "start_date", "notes"]) if (k in val && val[k] === "") val[k] = null;
      const sid = await withTx(async c => {
        let branchId;
        if (b.branchId === undefined && id) branchId = undefined;
        else if (b.branchId === "" || b.branchId === null || b.branchId === undefined) { if (!unrestricted(ctx)) fail(400, "Choose a branch."); branchId = null; }
        else branchId = (await branchFor(ctx, c, b.branchId)).id;
        if (id) {
          const cur = (await c.query(`SELECT * FROM bm_staff WHERE id=$1 AND business_id=$2 FOR UPDATE`, [id, ctx.business.id])).rows[0];
          if (!cur || !staffVisible(ctx, cur)) fail(404, "Staff member not found.");
          const next = { ...val }; if (branchId !== undefined) next.branch_id = branchId;
          const norm = v => (v instanceof Date ? dateStr(v) : v);
          const keys = Object.keys(next).filter(k => String(norm(cur[k]) ?? "") !== String(next[k] ?? "") && !(k === "pay_amount" && num(cur[k]) === num(next[k])));
          if (!keys.length) return id;
          await c.query(`UPDATE bm_staff SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(",")},updated_at=NOW() WHERE id=$1 AND business_id=$2`, [id, ctx.business.id, ...keys.map(k => next[k])]);
          await audit(c, req, ctx, "staff.update", "staff", id, Object.fromEntries(keys.map(k => [k, cur[k]])), Object.fromEntries(keys.map(k => [k, next[k]]))); return id;
        }
        const n = (await c.query(`INSERT INTO bm_staff(business_id,branch_id,name,phone,email,job_title,pay_type,pay_amount,start_date,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11) RETURNING id`,
          [ctx.business.id, branchId ?? null, val.name, val.phone ?? null, val.email ?? null, val.job_title ?? null, val.pay_type || "monthly", val.pay_amount ?? 0, val.start_date ?? null, val.status || "active", val.notes ?? null])).rows[0];
        await audit(c, req, ctx, "staff.create", "staff", n.id, null, { name: val.name, job_title: val.job_title }); return num(n.id);
      });
      return out(res, { staffId: sid, message: "Staff member saved." });
    }

    if (M === "GET" && path === "/api/business/staff/attendance") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "staff.view", settings });
      const date = A.isDate(q.get("date")) ? q.get("date") : A.lagosToday(), ids = accessible(ctx);
      const r = await db(`SELECT s.id,s.name,s.job_title,br.name AS branch_name,a.status,a.note FROM bm_staff s LEFT JOIN bm_branches br ON br.id=s.branch_id
        LEFT JOIN bm_attendance a ON a.staff_id=s.id AND a.work_date=$2::date WHERE s.business_id=$1 AND s.status='active' AND ($3::bigint[] IS NULL OR s.branch_id=ANY($3::bigint[])) ORDER BY lower(s.name)`, [ctx.business.id, date, ids]);
      return out(res, { date, entries: r.rows.map(x => ({ staffId: num(x.id), name: x.name, jobTitle: x.job_title, branch: x.branch_name, status: x.status || null, note: x.note })), canManage: L.hasPerm(ctx.role, "staff.manage") });
    }

    if (M === "POST" && path === "/api/business/staff/attendance") {
      const rl = rateLimit(req, "bm-att:" + uid, 60, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "staff.manage", write: true, settings });
      const date = clean(b.date).slice(0, 10), entries = Array.isArray(b.entries) ? b.entries : [];
      const err = P4.validateAttendance(date, entries); if (err) fail(400, err);
      await withTx(async c => {
        const ids = [...new Set(entries.map(e => posInt(e.staffId)))]; if (ids.some(x => !x)) fail(400, "Invalid staff member.");
        const rows = (await c.query(`SELECT id,branch_id FROM bm_staff WHERE business_id=$1 AND id=ANY($2::bigint[]) AND status='active'`, [ctx.business.id, ids])).rows;
        if (rows.length !== ids.length || rows.some(r => !staffVisible(ctx, r))) fail(404, "Staff member not found.");
        for (const e of entries) await c.query(`INSERT INTO bm_attendance(business_id,staff_id,work_date,status,note,recorded_by) VALUES($1,$2,$3::date,$4,$5,$6)
          ON CONFLICT(staff_id,work_date) DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,recorded_by=EXCLUDED.recorded_by`, [ctx.business.id, posInt(e.staffId), date, e.status, clean(e.note).slice(0, 200) || null, ctx.uid]);
        await audit(c, req, ctx, "attendance.save", "attendance", date, null, { date, marked: entries.length });
      });
      return out(res, { message: "Attendance saved." });
    }

    if (M === "GET" && path === "/api/business/staff/detail") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "staff.view", settings });
      const s = (await db(`SELECT s.*, br.name AS branch_name FROM bm_staff s LEFT JOIN bm_branches br ON br.id=s.branch_id WHERE s.id=$1 AND s.business_id=$2`, [posInt(q.get("id")), ctx.business.id])).rows[0];
      if (!s || !staffVisible(ctx, s)) fail(404, "Staff member not found.");
      const month = P4.validPeriod(q.get("month")) ? q.get("month") : A.lagosToday().slice(0, 7), [y, m] = month.split("-").map(Number);
      const from = month + "-01", to = month + "-" + String(new Date(y, m, 0).getDate()).padStart(2, "0");
      const att = (await db(`SELECT status, COUNT(*)::int AS n FROM bm_attendance WHERE business_id=$1 AND staff_id=$2 AND work_date BETWEEN $3::date AND $4::date GROUP BY status`, [ctx.business.id, s.id, from, to])).rows;
      const pays = canPay(ctx) ? (await db(`SELECT p.*, s.name AS staff_name FROM bm_payroll p JOIN bm_staff s ON s.id=p.staff_id WHERE p.business_id=$1 AND p.staff_id=$2 ORDER BY p.id DESC LIMIT 12`, [ctx.business.id, s.id])).rows : [];
      return out(res, { staff: staffView(s, ctx), month, attendance: Object.fromEntries(att.map(x => [x.status, x.n])), payments: pays.map(payrollView) });
    }

    if (M === "GET" && path === "/api/business/payroll") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "payroll.manage", settings });
      const month = P4.validPeriod(q.get("month")) ? q.get("month") : A.lagosToday().slice(0, 7), ids = accessible(ctx);
      const r = await db(`SELECT p.*, s.name AS staff_name FROM bm_payroll p JOIN bm_staff s ON s.id=p.staff_id WHERE p.business_id=$1 AND p.period=$2 AND ($3::bigint[] IS NULL OR s.branch_id=ANY($3::bigint[])) ORDER BY p.id DESC LIMIT 300`, [ctx.business.id, month, ids]);
      const rows = r.rows.map(payrollView);
      const unpaid = (await db(`SELECT s.id,s.name,s.pay_type,s.pay_amount FROM bm_staff s WHERE s.business_id=$1 AND s.status='active' AND ($3::bigint[] IS NULL OR s.branch_id=ANY($3::bigint[])) AND NOT EXISTS (SELECT 1 FROM bm_payroll p WHERE p.staff_id=s.id AND p.period=$2 AND p.status='active') ORDER BY lower(s.name)`, [ctx.business.id, month, ids])).rows;
      return out(res, { month, payments: rows, total: rows.filter(x => x.status === "active").reduce((a, x) => a + x.net, 0), unpaid: unpaid.map(x => ({ id: num(x.id), name: x.name, payType: x.pay_type, payAmount: num(x.pay_amount) })) });
    }

    if (M === "POST" && path === "/api/business/payroll/pay") {
      const rl = rateLimit(req, "bm-pay:" + uid, 60, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "payroll.manage", write: true, settings });
      const idem = clean(b.idempotencyKey).slice(0, 80); if (idem.length < 8) fail(400, "Missing request key. Please refresh and try again.");
      const period = clean(b.period).slice(0, 7); if (!P4.validPeriod(period)) fail(400, "Choose the month this pay is for.");
      const method = clean(b.method).toLowerCase() || "cash"; if (!C.PAY_METHODS.includes(method)) fail(400, "Choose a payment method.");
      const today = A.lagosToday(), date = b.date ? clean(b.date).slice(0, 10) : today;
      if (!A.isDate(date) || date > A.addDays(today, 1)) fail(400, "Enter a valid payment date.");
      let calc; try { calc = P4.computePayroll({ amount: num(b.amount), bonus: num(b.bonus || 0), deductions: num(b.deductions || 0) }); } catch (e) { fail(400, e.message); }
      try {
        const row = await withTx(async c => {
          const s = (await c.query(`SELECT * FROM bm_staff WHERE id=$1 AND business_id=$2 FOR UPDATE`, [posInt(b.staffId), ctx.business.id])).rows[0];
          if (!s || !staffVisible(ctx, s)) fail(404, "Staff member not found.");
          if (b.force !== true) { const dup = (await c.query(`SELECT 1 FROM bm_payroll WHERE business_id=$1 AND staff_id=$2 AND period=$3 AND status='active' LIMIT 1`, [ctx.business.id, s.id, period])).rows[0]; if (dup) fail(409, "This person has already been paid for " + period + ". Pay again only if this is an extra payment.", { code: "duplicate_period" }); }
          const e = (await c.query(`INSERT INTO bm_expenses(business_id,branch_id,category,description,amount,method,expense_date,source,created_by,created_by_name) VALUES($1,$2,'Salaries & wages',$3,$4,$5,$6::date,'payroll',$7,$8) RETURNING id`,
            [ctx.business.id, s.branch_id, `Salary: ${s.name} (${period})`, calc.net, method, date, ctx.uid, ctx.user.name || ctx.user.email || null])).rows[0];
          const p = (await c.query(`INSERT INTO bm_payroll(business_id,staff_id,period,amount,bonus,deductions,net,method,paid_on,note,expense_id,idem,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13) RETURNING id`,
            [ctx.business.id, s.id, period, calc.amount, calc.bonus, calc.deductions, calc.net, method, date, clean(b.note).slice(0, 200) || null, e.id, idem, ctx.uid])).rows[0];
          await audit(c, req, ctx, "payroll.pay", "payroll", p.id, null, { staff: s.name, period, net: calc.net, method }); return num(p.id);
        });
        return out(res, { paymentId: row, net: calc.net, message: "Salary payment recorded." });
      } catch (e) { if (e.code === "23505" && e.constraint === "bm_payroll_idem_uq") return out(res, { already: true, message: "This payment was already recorded." }); throw e; }
    }

    if (M === "POST" && path === "/api/business/payroll/void") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "payroll.manage", write: true, settings });
      const reason = clean(b.reason).slice(0, 200); if (reason.length < 3) fail(400, "Please give a reason.");
      await withTx(async c => {
        const p = (await c.query(`SELECT p.*, s.branch_id FROM bm_payroll p JOIN bm_staff s ON s.id=p.staff_id WHERE p.id=$1 AND p.business_id=$2 FOR UPDATE OF p`, [posInt(b.paymentId), ctx.business.id])).rows[0];
        if (!p || !staffVisible(ctx, p)) fail(404, "Payment not found."); if (p.status !== "active") fail(409, "This payment is already voided.");
        await c.query(`UPDATE bm_payroll SET status='void',voided_at=NOW(),void_reason=$3 WHERE id=$1 AND business_id=$2`, [p.id, ctx.business.id, reason]);
        if (p.expense_id) await c.query(`UPDATE bm_expenses SET status='void',voided_at=NOW(),voided_by=$3,void_reason=$4,updated_at=NOW() WHERE id=$1 AND business_id=$2`, [p.expense_id, ctx.business.id, ctx.uid, "Payroll voided: " + reason]);
        await audit(c, req, ctx, "payroll.void", "payroll", p.id, { net: num(p.net), period: p.period }, { reason });
      });
      return out(res, { message: "Payment voided." });
    }

    return false;
  }
  return { handle };
};
