"use strict";
/* BOLTIV Business Manager, Phase 4: services and appointments (Growth plan and above).
   Times are Africa/Lagos. A staff member cannot be double-booked: the staff row is locked while checking for overlaps. */
const L = require("./logic");
const A = require("./logic3");
const P4 = require("./logic4");

module.exports = function createAppointments(h) {
  const { db, getCtx, audit, withTx, fail, posInt, out, body, clean, rateLimit, rateLimitedResponse, helpers, needFeature } = h;
  const { branchFor, accessible } = helpers;
  const num = v => Number(v);
  const dbClient = { query: (s, p) => db(s, p) };
  const unrestricted = ctx => ctx.role === "owner" || !ctx.member.branch_ids;
  const FEATURE = ["appointments", "Appointments"];
  const apptView = a => ({ id: num(a.id), branchId: num(a.branch_id), branch: a.branch_name, customerId: a.customer_id ? num(a.customer_id) : null, customerName: a.customer_name, customerPhone: a.customer_phone,
    serviceId: a.service_id ? num(a.service_id) : null, serviceName: a.service_name, staffId: a.staff_id ? num(a.staff_id) : null, staff: a.staff_name || null, date: a.d, start: a.t, end: a.t2,
    durationMin: Math.round((new Date(a.ends_at) - new Date(a.starts_at)) / 60000), price: num(a.price), status: a.status, notes: a.notes, saleId: a.sale_id ? num(a.sale_id) : null, cancelReason: a.cancel_reason });
  const SEL = `SELECT a.*, to_char(a.starts_at AT TIME ZONE 'Africa/Lagos','YYYY-MM-DD') AS d, to_char(a.starts_at AT TIME ZONE 'Africa/Lagos','HH24:MI') AS t, to_char(a.ends_at AT TIME ZONE 'Africa/Lagos','HH24:MI') AS t2,
    st.name AS staff_name, br.name AS branch_name FROM bm_appointments a LEFT JOIN bm_staff st ON st.id=a.staff_id JOIN bm_branches br ON br.id=a.branch_id`;
  async function loadAppt(c, bid, id) { return (await c.query(SEL + ` WHERE a.id=$1 AND a.business_id=$2`, [id, bid])).rows[0] || null; }

  async function handle(req, res, path, M, url, user, settings) {
    const q = url.searchParams, uid = String(user.user_id);

    if (M === "GET" && path === "/api/business/services") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "appointments.view", settings });
      needFeature(ctx, ...FEATURE);
      const mg = L.hasPerm(ctx.role, "services.manage");
      const r = await db(`SELECT * FROM bm_services WHERE business_id=$1 AND ($2::boolean OR status='active') ORDER BY lower(name)`, [ctx.business.id, mg]);
      return out(res, { services: r.rows.map(x => ({ id: num(x.id), name: x.name, durationMin: x.duration_min, price: num(x.price), status: x.status })), canManage: mg });
    }

    if (M === "POST" && path === "/api/business/services/save") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "services.manage", write: true, settings });
      needFeature(ctx, ...FEATURE);
      const name = clean(b.name).slice(0, 80), dur = num(b.durationMin), price = num(b.price || 0), status = b.status === "inactive" ? "inactive" : "active", id = b.id ? posInt(b.id) : null;
      if (name.length < 2) fail(400, "Service name must be at least 2 characters."); if (!(Number.isInteger(dur) && dur >= 5 && dur <= 720)) fail(400, "Duration must be between 5 minutes and 12 hours."); if (!(price >= 0 && price <= 1e9)) fail(400, "Enter a valid price.");
      try {
        const sid = await withTx(async c => {
          if (id) {
            const cur = (await c.query(`SELECT * FROM bm_services WHERE id=$1 AND business_id=$2 FOR UPDATE`, [id, ctx.business.id])).rows[0]; if (!cur) fail(404, "Service not found.");
            await c.query(`UPDATE bm_services SET name=$3,duration_min=$4,price=$5,status=$6,updated_at=NOW() WHERE id=$1 AND business_id=$2`, [id, ctx.business.id, name, dur, L.fromKobo(L.toKobo(price)), status]);
            await audit(c, req, ctx, "service.update", "service", id, { name: cur.name, price: num(cur.price), duration: cur.duration_min }, { name, price, duration: dur, status }); return id;
          }
          const n = (await c.query(`INSERT INTO bm_services(business_id,name,duration_min,price) VALUES($1,$2,$3,$4) RETURNING id`, [ctx.business.id, name, dur, L.fromKobo(L.toKobo(price))])).rows[0];
          await audit(c, req, ctx, "service.create", "service", n.id, null, { name, price, duration: dur }); return num(n.id);
        });
        return out(res, { serviceId: sid, message: "Service saved." });
      } catch (e) { if (e.code === "23505") fail(409, "You already have a service with this name."); throw e; }
    }

    if (M === "GET" && path === "/api/business/appointments") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "appointments.view", settings });
      needFeature(ctx, ...FEATURE);
      const today = A.lagosToday(), from = A.isDate(q.get("from")) ? q.get("from") : today, to = A.isDate(q.get("to")) ? q.get("to") : from;
      if (from > to) fail(400, "The start date is after the end date."); if ((Date.parse(to) - Date.parse(from)) / 86400000 > 62) fail(400, "Choose a range of up to 62 days.");
      let ids = accessible(ctx); if (q.get("branch_id")) ids = [num((await branchFor(ctx, dbClient, q.get("branch_id"))).id)];
      const status = P4.APPT_STATUSES.includes(q.get("status")) ? q.get("status") : "";
      const r = await db(SEL + ` WHERE a.business_id=$1 AND (a.starts_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN $2::date AND $3::date AND ($4::bigint[] IS NULL OR a.branch_id=ANY($4::bigint[]))
        AND ($5::bigint IS NULL OR a.staff_id=$5) AND ($6='' OR a.status=$6) ORDER BY a.starts_at LIMIT 300`, [ctx.business.id, from, to, ids, q.get("staff_id") ? posInt(q.get("staff_id")) : null, status]);
      const staff = L.hasPerm(ctx.role, "staff.view") || L.hasPerm(ctx.role, "appointments.manage")
        ? (await db(`SELECT id,name,branch_id FROM bm_staff WHERE business_id=$1 AND status='active' AND ($2::bigint[] IS NULL OR branch_id IS NULL OR branch_id=ANY($2::bigint[])) ORDER BY lower(name)`, [ctx.business.id, ids])).rows : [];
      const services = (await db(`SELECT id,name,duration_min,price FROM bm_services WHERE business_id=$1 AND status='active' ORDER BY lower(name)`, [ctx.business.id])).rows;
      return out(res, { from, to, appointments: r.rows.map(apptView), staff: staff.map(x => ({ id: num(x.id), name: x.name, branchId: x.branch_id ? num(x.branch_id) : null })),
        services: services.map(x => ({ id: num(x.id), name: x.name, durationMin: x.duration_min, price: num(x.price) })), canManage: L.hasPerm(ctx.role, "appointments.manage"), canManageServices: L.hasPerm(ctx.role, "services.manage") });
    }

    if (M === "POST" && path === "/api/business/appointments/save") {
      const rl = rateLimit(req, "bm-appt:" + uid, 120, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "appointments.manage", write: true, settings });
      needFeature(ctx, ...FEATURE);
      const id = b.id ? posInt(b.id) : null, idem = id ? null : clean(b.idempotencyKey).slice(0, 80);
      if (!id && idem.length < 8) fail(400, "Missing request key. Please refresh and try again.");
      const v = P4.validateAppointment({ ...b, customerName: clean(b.customerName) || (b.customerId ? "customer" : "") }); if (v.errors.length) fail(400, v.errors[0]);
      const val = v.value;
      const find = async c => { const r = (await c.query(`SELECT id FROM bm_appointments WHERE business_id=$1 AND idempotency_key=$2 AND created_by=$3`, [ctx.business.id, idem, ctx.uid])).rows[0]; return r ? loadAppt(c, ctx.business.id, r.id) : null; };
      if (idem) { const prior = await find(dbClient); if (prior) return out(res, { appointment: apptView(prior), already: true, message: "This appointment was already saved." }); }
      try {
        const row = await withTx(async c => {
          const br = await branchFor(ctx, c, b.branchId);
          let cust = null;
          if (b.customerId) { cust = (await c.query(`SELECT * FROM bm_customers WHERE id=$1 AND business_id=$2 AND status='active'`, [posInt(b.customerId), ctx.business.id])).rows[0]; if (!cust) fail(404, "Customer not found."); }
          const name = clean(b.customerName) || (cust ? cust.name : ""); if (name.length < 2) fail(400, "Enter the customer's name.");
          const phone = val.customer_phone || (cust ? cust.phone : null);
          let svc = null; if (b.serviceId) { svc = (await c.query(`SELECT * FROM bm_services WHERE id=$1 AND business_id=$2`, [posInt(b.serviceId), ctx.business.id])).rows[0]; if (!svc) fail(404, "Service not found."); }
          let staffId = null;
          if (b.staffId) {
            const st = (await c.query(`SELECT * FROM bm_staff WHERE id=$1 AND business_id=$2 AND status='active' FOR UPDATE`, [posInt(b.staffId), ctx.business.id])).rows[0]; if (!st) fail(404, "Staff member not found.");
            if (st.branch_id && String(st.branch_id) !== String(br.id)) fail(400, st.name + " works at a different branch.");
            staffId = st.id;
          }
          const t = (await c.query(`SELECT (($1::text||' '||$2::text)::timestamp AT TIME ZONE 'Africa/Lagos') AS s, (($1::text||' '||$2::text)::timestamp AT TIME ZONE 'Africa/Lagos') + make_interval(mins=>$3::int) AS e`, [val.date, val.time, val.duration_min])).rows[0];
          if (t.s < new Date(Date.now() - 15 * 60000)) fail(400, "That time has already passed.");
          if (staffId) {
            const clash = (await c.query(`SELECT id FROM bm_appointments WHERE business_id=$1 AND staff_id=$2 AND status IN ('booked','confirmed') AND id<>COALESCE($3::bigint,0) AND starts_at<$5::timestamptz AND ends_at>$4::timestamptz LIMIT 1`, [ctx.business.id, staffId, id, t.s, t.e])).rows[0];
            if (clash) fail(409, "That staff member already has an appointment at this time.", { code: "double_booking" });
          }
          let aid;
          if (id) {
            const cur = (await c.query(`SELECT * FROM bm_appointments WHERE id=$1 AND business_id=$2 FOR UPDATE`, [id, ctx.business.id])).rows[0];
            if (!cur || !L.canAccessBranch(ctx.member, cur.branch_id)) fail(404, "Appointment not found."); if (!["booked", "confirmed"].includes(cur.status)) fail(409, "This appointment can no longer be changed.");
            await c.query(`UPDATE bm_appointments SET branch_id=$3,customer_id=$4,customer_name=$5,customer_phone=$6,service_id=$7,service_name=$8,staff_id=$9,starts_at=$10,ends_at=$11,price=$12,notes=$13,updated_at=NOW() WHERE id=$1 AND business_id=$2`,
              [id, ctx.business.id, br.id, cust ? cust.id : null, name, phone || null, svc ? svc.id : null, val.service_name, staffId, t.s, t.e, val.price, val.notes || null]);
            aid = id; await audit(c, req, ctx, "appointment.update", "appointment", id, { start: cur.starts_at, status: cur.status }, { date: val.date, time: val.time, service: val.service_name });
          } else {
            aid = (await c.query(`INSERT INTO bm_appointments(business_id,branch_id,customer_id,customer_name,customer_phone,service_id,service_name,staff_id,starts_at,ends_at,price,notes,idempotency_key,created_by,created_by_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
              [ctx.business.id, br.id, cust ? cust.id : null, name, phone || null, svc ? svc.id : null, val.service_name, staffId, t.s, t.e, val.price, val.notes || null, idem, ctx.uid, ctx.user.name || ctx.user.email || null])).rows[0].id;
            await audit(c, req, ctx, "appointment.create", "appointment", aid, null, { date: val.date, time: val.time, service: val.service_name, customer: name });
          }
          return loadAppt(c, ctx.business.id, aid);
        });
        return out(res, { appointment: apptView(row), message: id ? "Appointment updated." : "Appointment booked." });
      } catch (e) {
        if (e.code === "23505" && e.constraint === "bm_appt_idem_uq") { const again = await find(dbClient); if (again) return out(res, { appointment: apptView(again), already: true, message: "This appointment was already saved." }); fail(409, "Duplicate request key. Please refresh and try again."); }
        throw e;
      }
    }

    if (M === "POST" && path === "/api/business/appointments/status") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "appointments.manage", write: true, settings });
      needFeature(ctx, ...FEATURE);
      const to = clean(b.status); if (!P4.APPT_STATUSES.includes(to) || to === "booked") fail(400, "Invalid status.");
      const reason = clean(b.reason).slice(0, 200);
      const row = await withTx(async c => {
        const cur = (await c.query(`SELECT * FROM bm_appointments WHERE id=$1 AND business_id=$2 FOR UPDATE`, [posInt(b.appointmentId), ctx.business.id])).rows[0];
        if (!cur || !L.canAccessBranch(ctx.member, cur.branch_id)) fail(404, "Appointment not found.");
        if (!P4.canMoveAppt(cur.status, to)) fail(409, "This appointment is already " + cur.status.replace("_", " ") + ".");
        let saleId = null;
        if (to === "completed" && b.saleId) { const s = (await c.query(`SELECT id FROM bm_sales WHERE id=$1 AND business_id=$2 AND status='completed'`, [posInt(b.saleId), ctx.business.id])).rows[0]; if (!s) fail(404, "Sale not found."); saleId = s.id; }
        await c.query(`UPDATE bm_appointments SET status=$3,sale_id=COALESCE($4,sale_id),cancel_reason=$5,updated_at=NOW() WHERE id=$1 AND business_id=$2`, [cur.id, ctx.business.id, to, saleId, ["cancelled", "no_show"].includes(to) ? (reason || null) : null]);
        await audit(c, req, ctx, "appointment." + to, "appointment", cur.id, { status: cur.status }, { status: to, saleId: saleId ? num(saleId) : undefined, reason: reason || undefined });
        return loadAppt(c, ctx.business.id, cur.id);
      });
      return out(res, { appointment: apptView(row), message: "Appointment marked " + to.replace("_", " ") + "." });
    }

    return false;
  }
  return { handle };
};
