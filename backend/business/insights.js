"use strict";
/* BOLTIV Business Manager, Phase 4: advanced inventory (branch transfers, expiry lots, reorder suggestions),
   sales and inventory reports, audit export. Advanced inventory and audit export are plan features; reports come in
   "basic" and "full" levels. Report queries never touch another business: everything is scoped by business_id and,
   for people limited to some branches, by those branches. */
const L = require("./logic");
const C = require("./logic2");
const A = require("./logic3");
const P4 = require("./logic4");

module.exports = function createInsights(h) {
  const { db, getCtx, audit, withTx, fail, posInt, out, body, clean, rateLimit, rateLimitedResponse, helpers, needFeature, featureOf } = h;
  const { branchFor, ensureStock, moveStock, accessible, likeSafe, canCost } = helpers;
  const num = v => Number(v);
  const dbClient = { query: (s, p) => db(s, p) };
  const ADV = ["advanced_inventory", "Advanced inventory"];
  const dateStr = d => (d instanceof Date ? d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") : String(d).slice(0, 10));
  const transferView = (t, items) => ({ id: num(t.id), transferNo: t.transfer_no, status: t.status, fromBranchId: num(t.from_branch_id), from: t.from_name, toBranchId: num(t.to_branch_id), to: t.to_name, note: t.note,
    createdAt: t.created_at, by: t.created_by_name, receivedAt: t.received_at, cancelReason: t.cancel_reason, ...(items ? { items: items.map(i => ({ productId: num(i.product_id), name: i.name, unit: i.unit, qty: num(i.qty) })) } : {}) });
  async function loadTransfer(c, bid, id) {
    const t = (await c.query(`SELECT t.*, f.name AS from_name, d.name AS to_name FROM bm_transfers t JOIN bm_branches f ON f.id=t.from_branch_id JOIN bm_branches d ON d.id=t.to_branch_id WHERE t.id=$1 AND t.business_id=$2`, [id, bid])).rows[0];
    if (!t) return null;
    return transferView(t, (await c.query(`SELECT product_id,name,unit,qty FROM bm_transfer_items WHERE transfer_id=$1 AND business_id=$2 ORDER BY id`, [id, bid])).rows);
  }
  const reportLevel = ctx => (featureOf(ctx, "reports") === "full" ? "full" : "basic");
  const idsFor = async (ctx, q) => { if (q.get("branch_id")) return [num((await branchFor(ctx, dbClient, q.get("branch_id"))).id)]; return accessible(ctx); };

  async function handle(req, res, path, M, url, user, settings) {
    const q = url.searchParams, uid = String(user.user_id);

    /* ================= branch transfers ================= */
    if (M === "POST" && path === "/api/business/transfers/create") {
      const rl = rateLimit(req, "bm-tr:" + uid, 60, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "inventory.manage", write: true, settings });
      needFeature(ctx, ...ADV);
      const idem = clean(b.idempotencyKey).slice(0, 80); if (idem.length < 8) fail(400, "Missing request key. Please refresh and try again.");
      const items = Array.isArray(b.items) ? b.items : [];
      const err = P4.validateTransfer({ fromBranch: b.fromBranchId, toBranch: b.toBranchId, items }); if (err) fail(400, err);
      const find = async c => { const r = (await c.query(`SELECT id FROM bm_transfers WHERE business_id=$1 AND idempotency_key=$2 AND created_by=$3`, [ctx.business.id, idem, ctx.uid])).rows[0]; return r ? loadTransfer(c, ctx.business.id, r.id) : null; };
      const prior = await find(dbClient); if (prior) return out(res, { transfer: prior, already: true, message: "This transfer was already recorded." });
      let tr;
      try {
        tr = await withTx(async c => {
          const from = await branchFor(ctx, c, b.fromBranchId);
          const to = (await c.query(`SELECT id,name FROM bm_branches WHERE id=$1 AND business_id=$2 AND status='active'`, [posInt(b.toBranchId), ctx.business.id])).rows[0]; if (!to) fail(404, "Destination branch not found.");
          const pids = [...new Set(items.map(i => posInt(i.productId)))]; if (pids.some(x => !x)) fail(400, "Invalid product.");
          const prods = new Map((await c.query(`SELECT * FROM bm_products WHERE business_id=$1 AND id=ANY($2::bigint[]) AND status='active' AND track_stock`, [ctx.business.id, pids])).rows.map(p => [num(p.id), p]));
          if (prods.size !== pids.length) fail(409, "Only active products that track stock can be transferred.");
          const need = new Map(); for (const i of items) need.set(posInt(i.productId), C.q3((need.get(posInt(i.productId)) || 0) + C.q3(i.qty)));
          for (const pid of [...need.keys()].sort((a, z) => a - z)) {
            await ensureStock(c, ctx.business.id, from.id, pid);
            const cur = (await c.query(`SELECT quantity FROM bm_stock WHERE product_id=$1 AND branch_id=$2 AND business_id=$3 FOR UPDATE`, [pid, from.id, ctx.business.id])).rows[0];
            if (num(cur.quantity) < need.get(pid)) fail(409, `Not enough ${prods.get(pid).name} at ${from.name} (only ${num(cur.quantity)} left).`, { code: "insufficient_stock", productId: pid });
          }
          const no = A.docNo("TR", (await c.query(`INSERT INTO bm_counters(business_id,key,value) VALUES($1,'transfer',1) ON CONFLICT(business_id,key) DO UPDATE SET value=bm_counters.value+1 RETURNING value`, [ctx.business.id])).rows[0].value);
          const t = (await c.query(`INSERT INTO bm_transfers(business_id,transfer_no,from_branch_id,to_branch_id,note,idempotency_key,created_by,created_by_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [ctx.business.id, no, from.id, to.id, clean(b.note).slice(0, 200) || null, idem, ctx.uid, ctx.user.name || ctx.user.email || null])).rows[0];
          for (const [pid, qty] of need) {
            const p = prods.get(pid);
            await c.query(`INSERT INTO bm_transfer_items(business_id,transfer_id,product_id,name,unit,qty) VALUES($1,$2,$3,$4,$5,$6)`, [ctx.business.id, t.id, pid, p.name, p.unit, qty]);
            await moveStock(c, ctx, { branchId: from.id, productId: pid, delta: -qty, type: "transfer_out", refType: "transfer", refId: t.id, note: no + " to " + to.name });
          }
          await audit(c, req, ctx, "transfer.create", "transfer", t.id, null, { no, from: from.name, to: to.name, items: need.size });
          return loadTransfer(c, ctx.business.id, t.id);
        });
      } catch (e) {
        if (e.code === "23505" && e.constraint === "bm_transfers_idem_uq") { const again = await find(dbClient); if (again) return out(res, { transfer: again, already: true, message: "This transfer was already recorded." }); fail(409, "Duplicate request key. Please refresh and try again."); }
        throw e;
      }
      return out(res, { transfer: tr, message: "Transfer sent. The stock is on its way." });
    }

    if (M === "POST" && (path === "/api/business/transfers/receive" || path === "/api/business/transfers/cancel")) {
      const b = await body(req), receive = path.endsWith("/receive");
      const ctx = await getCtx(req, user, b.businessId, { perm: "inventory.manage", write: true, settings });
      needFeature(ctx, ...ADV);
      const reason = clean(b.reason).slice(0, 200); if (!receive && reason.length < 3) fail(400, "Please give a reason.");
      const tr = await withTx(async c => {
        const t = (await c.query(`SELECT * FROM bm_transfers WHERE id=$1 AND business_id=$2 FOR UPDATE`, [posInt(b.transferId), ctx.business.id])).rows[0];
        if (!t) fail(404, "Transfer not found.");
        if (receive ? !L.canAccessBranch(ctx.member, t.to_branch_id) : !(L.canAccessBranch(ctx.member, t.to_branch_id) || L.canAccessBranch(ctx.member, t.from_branch_id))) fail(403, "You do not have access to this branch.");
        if (t.status !== "in_transit") fail(409, "This transfer is already " + t.status.replace("_", " ") + ".");
        const items = (await c.query(`SELECT product_id,qty FROM bm_transfer_items WHERE transfer_id=$1 AND business_id=$2`, [t.id, ctx.business.id])).rows;
        const branchId = receive ? t.to_branch_id : t.from_branch_id;
        for (const i of items.sort((a, z) => num(a.product_id) - num(z.product_id))) {
          await ensureStock(c, ctx.business.id, branchId, i.product_id);
          await c.query(`SELECT 1 FROM bm_stock WHERE product_id=$1 AND branch_id=$2 AND business_id=$3 FOR UPDATE`, [i.product_id, branchId, ctx.business.id]);
          await moveStock(c, ctx, { branchId, productId: i.product_id, delta: num(i.qty), type: receive ? "transfer_in" : "transfer_return", refType: "transfer", refId: t.id, note: t.transfer_no });
        }
        if (receive) await c.query(`UPDATE bm_transfers SET status='received',received_at=NOW(),received_by=$3 WHERE id=$1 AND business_id=$2`, [t.id, ctx.business.id, ctx.uid]);
        else await c.query(`UPDATE bm_transfers SET status='cancelled',cancelled_at=NOW(),cancelled_by=$3,cancel_reason=$4 WHERE id=$1 AND business_id=$2`, [t.id, ctx.business.id, ctx.uid, reason]);
        await audit(c, req, ctx, receive ? "transfer.receive" : "transfer.cancel", "transfer", t.id, { status: "in_transit" }, { status: receive ? "received" : "cancelled", reason: reason || undefined, no: t.transfer_no });
        return loadTransfer(c, ctx.business.id, t.id);
      });
      return out(res, { transfer: tr, message: receive ? "Stock received." : "Transfer cancelled. The stock went back to the sending branch." });
    }

    if (M === "GET" && path === "/api/business/transfers") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "inventory.view", settings });
      needFeature(ctx, ...ADV);
      const ids = accessible(ctx), status = ["in_transit", "received", "cancelled"].includes(q.get("status")) ? q.get("status") : "";
      const r = await db(`SELECT t.*, f.name AS from_name, d.name AS to_name FROM bm_transfers t JOIN bm_branches f ON f.id=t.from_branch_id JOIN bm_branches d ON d.id=t.to_branch_id
        WHERE t.business_id=$1 AND ($2::bigint[] IS NULL OR t.from_branch_id=ANY($2::bigint[]) OR t.to_branch_id=ANY($2::bigint[])) AND ($3='' OR t.status=$3) ORDER BY t.id DESC LIMIT 60`, [ctx.business.id, ids, status]);
      return out(res, { transfers: r.rows.map(t => transferView(t)), canManage: L.hasPerm(ctx.role, "inventory.manage") });
    }

    if (M === "GET" && path === "/api/business/transfers/detail") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "inventory.view", settings });
      needFeature(ctx, ...ADV);
      const t = await loadTransfer(dbClient, ctx.business.id, posInt(q.get("id")));
      if (!t || !(L.canAccessBranch(ctx.member, t.fromBranchId) || L.canAccessBranch(ctx.member, t.toBranchId))) fail(404, "Transfer not found.");
      return out(res, { transfer: t, canReceive: L.hasPerm(ctx.role, "inventory.manage") && t.status === "in_transit" && L.canAccessBranch(ctx.member, t.toBranchId), canCancel: L.hasPerm(ctx.role, "inventory.manage") && t.status === "in_transit" });
    }

    /* ================= expiry lots and reorder ================= */
    if (M === "POST" && path === "/api/business/lots/add") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "inventory.manage", write: true, settings });
      needFeature(ctx, ...ADV);
      const qty = C.q3(b.qty), expiry = clean(b.expiry).slice(0, 10), today = A.lagosToday();
      if (!(qty > 0 && qty <= 1e7)) fail(400, "Enter a valid quantity.");
      if (!A.isDate(expiry) || expiry < A.addDays(today, -400) || expiry > A.addDays(today, 3650)) fail(400, "Enter a valid expiry date.");
      await withTx(async c => {
        const br = await branchFor(ctx, c, b.branchId);
        const p = (await c.query(`SELECT * FROM bm_products WHERE id=$1 AND business_id=$2 AND status='active' FOR UPDATE`, [posInt(b.productId), ctx.business.id])).rows[0];
        if (!p || !p.track_stock) fail(404, "Product not found.");
        await ensureStock(c, ctx.business.id, br.id, p.id);
        const st = (await c.query(`SELECT quantity FROM bm_stock WHERE product_id=$1 AND branch_id=$2 AND business_id=$3 FOR UPDATE`, [p.id, br.id, ctx.business.id])).rows[0];
        const lots = (await c.query(`SELECT COALESCE(SUM(qty),0) AS q FROM bm_lots WHERE business_id=$1 AND product_id=$2 AND branch_id=$3`, [ctx.business.id, p.id, br.id])).rows[0];
        if (C.q3(num(lots.q) + qty) > num(st.quantity)) fail(409, `That is more than the stock on hand (${num(st.quantity)}). Add the stock first, then record its expiry.`);
        await c.query(`INSERT INTO bm_lots(business_id,product_id,branch_id,lot_no,expiry_date,qty,source,created_by) VALUES($1,$2,$3,$4,$5::date,$6,'manual',$7)`, [ctx.business.id, p.id, br.id, clean(b.lotNo).slice(0, 40) || null, expiry, qty, ctx.uid]);
        await audit(c, req, ctx, "lot.add", "product", p.id, null, { branch: br.name, lot: clean(b.lotNo).slice(0, 40) || null, expiry, qty });
      });
      return out(res, { message: "Expiry recorded." });
    }

    if (M === "GET" && path === "/api/business/lots/expiry") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "inventory.view", settings });
      needFeature(ctx, ...ADV);
      const ids = await idsFor(ctx, q), days = Math.min(365, Math.max(1, num(q.get("days")) || 60)), today = A.lagosToday(), cost = canCost(ctx);
      const r = await db(`SELECT l.id,l.product_id,l.branch_id,l.lot_no,l.expiry_date,l.qty,p.name,p.unit,p.cost_price,br.name AS branch,COALESCE(st.quantity,0) AS stock FROM bm_lots l
        JOIN bm_products p ON p.id=l.product_id AND p.business_id=l.business_id JOIN bm_branches br ON br.id=l.branch_id LEFT JOIN bm_stock st ON st.product_id=l.product_id AND st.branch_id=l.branch_id
        WHERE l.business_id=$1 AND ($2::bigint[] IS NULL OR l.branch_id=ANY($2::bigint[])) ORDER BY l.product_id,l.branch_id LIMIT 5000`, [ctx.business.id, ids]);
      const groups = new Map(); for (const x of r.rows) { const k = x.product_id + ":" + x.branch_id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
      const lots = [];
      for (const g of groups.values()) for (const l of P4.deriveLots(g.map(x => ({ id: num(x.id), expiry: dateStr(x.expiry_date), qty: num(x.qty), src: x })), num(g[0].stock))) {
        if (l.remaining <= 0 || l.expiry > A.addDays(today, days)) continue;
        const x = l.src;
        lots.push({ id: l.id, productId: num(x.product_id), product: x.name, unit: x.unit, branchId: num(x.branch_id), branch: x.branch, lotNo: x.lot_no, expiry: l.expiry, remaining: l.remaining, status: P4.lotStatus(l.expiry, today), ...(cost ? { value: L.fromKobo(Math.round(L.toKobo(x.cost_price) * l.remaining)) } : {}) });
      }
      lots.sort((a, z) => a.expiry.localeCompare(z.expiry));
      return out(res, { lots, days, today, estimated: true });
    }

    if (M === "GET" && path === "/api/business/stock/reorder") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "inventory.view", settings });
      needFeature(ctx, ...ADV);
      const ids = await idsFor(ctx, q), cost = canCost(ctx);
      const r = await db(`SELECT * FROM (SELECT p.id,p.name,p.unit,p.reorder_level,p.cost_price,COALESCE((SELECT SUM(s.quantity) FROM bm_stock s WHERE s.product_id=p.id AND s.business_id=p.business_id AND ($2::bigint[] IS NULL OR s.branch_id=ANY($2::bigint[]))),0) AS stock
        FROM bm_products p WHERE p.business_id=$1 AND p.status='active' AND p.track_stock AND p.reorder_level>0) t WHERE t.stock<=t.reorder_level ORDER BY (t.stock/NULLIF(t.reorder_level,0)) LIMIT 200`, [ctx.business.id, ids]);
      const items = r.rows.map(x => { const sug = P4.reorderSuggestion({ stock: num(x.stock), reorderLevel: num(x.reorder_level) }); return { productId: num(x.id), name: x.name, unit: x.unit, stock: num(x.stock), reorderLevel: num(x.reorder_level), suggested: sug, ...(cost ? { estCost: L.fromKobo(Math.round(L.toKobo(x.cost_price) * sug)) } : {}) }; });
      return out(res, { items, estTotal: cost ? items.reduce((a, x) => a + x.estCost, 0) : undefined });
    }

    /* ================= reports ================= */
    if (M === "GET" && path === "/api/business/reports/sales") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "reports.view", settings });
      const level = reportLevel(ctx), rg = P4.reportRange(q.get("from"), q.get("to"), level);
      if (rg.error) fail(rg.code ? 403 : 400, rg.error, rg.code ? { code: rg.code, feature: "reports" } : {});
      const ids = await idsFor(ctx, q), a = [ctx.business.id, rg.from, rg.to, ids];
      const day = `(s.created_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN $2::date AND $3::date AND ($4::bigint[] IS NULL OR s.branch_id=ANY($4::bigint[]))`;
      const full = level === "full", rows = async sql => (await db(sql, a)).rows;
      const [tot, daily, methods, top] = await Promise.all([
        db(`SELECT COUNT(*) FILTER (WHERE s.status='completed')::int AS n, COALESCE(SUM(s.total) FILTER (WHERE s.status='completed'),0) AS total, COALESCE(SUM(s.discount) FILTER (WHERE s.status='completed'),0) AS discount,
          COALESCE(SUM(s.tax) FILTER (WHERE s.status='completed'),0) AS tax, COALESCE(SUM(s.balance_due) FILTER (WHERE s.status='completed'),0) AS credit, COUNT(*) FILTER (WHERE s.status='void')::int AS voided FROM bm_sales s WHERE s.business_id=$1 AND ${day}`, a),
        rows(`SELECT (s.created_at AT TIME ZONE 'Africa/Lagos')::date::text AS day, COUNT(*)::int AS n, SUM(s.total) AS total FROM bm_sales s WHERE s.business_id=$1 AND s.status='completed' AND ${day} GROUP BY 1 ORDER BY 1`),
        rows(`SELECT p.method, SUM(p.amount) AS amount FROM bm_sale_payments p JOIN bm_sales s ON s.id=p.sale_id AND s.business_id=p.business_id WHERE s.business_id=$1 AND s.status='completed' AND ${day} GROUP BY 1 ORDER BY 2 DESC`),
        rows(`SELECT i.name, SUM(i.qty) AS qty, SUM(i.line_total) AS revenue, SUM(i.qty*i.unit_cost) AS cost FROM bm_sale_items i JOIN bm_sales s ON s.id=i.sale_id AND s.business_id=i.business_id WHERE s.business_id=$1 AND s.status='completed' AND ${day} GROUP BY COALESCE(i.product_id,0), i.name ORDER BY 3 DESC LIMIT 10`)]);
      const t = tot.rows[0], res2 = {
        level, range: { from: rg.from, to: rg.to }, totals: { count: t.n, total: num(t.total), discount: num(t.discount), tax: num(t.tax), credit: num(t.credit), voided: t.voided, average: t.n ? L.fromKobo(Math.round(L.toKobo(t.total) / t.n)) : 0 },
        daily: daily.map(x => ({ day: x.day, count: x.n, total: num(x.total) })), methods: methods.map(x => ({ method: x.method, amount: num(x.amount) })),
        topProducts: top.map(x => ({ name: x.name, qty: num(x.qty), revenue: num(x.revenue), profit: L.fromKobo(L.toKobo(x.revenue) - Math.round(L.toKobo(x.cost) ))})), locked: full ? [] : ["byCategory", "byCashier", "byBranch", "byHour", "topCustomers", "export"] };
      if (full) {
        const [cat, cash, br, hr, cu] = await Promise.all([
          rows(`SELECT COALESCE(p.category,'Uncategorised') AS k, SUM(i.qty) AS qty, SUM(i.line_total) AS revenue FROM bm_sale_items i JOIN bm_sales s ON s.id=i.sale_id AND s.business_id=i.business_id LEFT JOIN bm_products p ON p.id=i.product_id WHERE s.business_id=$1 AND s.status='completed' AND ${day} GROUP BY 1 ORDER BY 3 DESC LIMIT 12`),
          rows(`SELECT COALESCE(s.cashier_name,'Unknown') AS k, COUNT(*)::int AS n, SUM(s.total) AS total FROM bm_sales s WHERE s.business_id=$1 AND s.status='completed' AND ${day} GROUP BY 1 ORDER BY 3 DESC LIMIT 15`),
          rows(`SELECT br.name AS k, COUNT(*)::int AS n, SUM(s.total) AS total FROM bm_sales s JOIN bm_branches br ON br.id=s.branch_id WHERE s.business_id=$1 AND s.status='completed' AND ${day} GROUP BY 1 ORDER BY 3 DESC`),
          rows(`SELECT EXTRACT(hour FROM s.created_at AT TIME ZONE 'Africa/Lagos')::int AS k, COUNT(*)::int AS n, SUM(s.total) AS total FROM bm_sales s WHERE s.business_id=$1 AND s.status='completed' AND ${day} GROUP BY 1 ORDER BY 1`),
          rows(`SELECT cu.name AS k, COUNT(*)::int AS n, SUM(s.total) AS total FROM bm_sales s JOIN bm_customers cu ON cu.id=s.customer_id WHERE s.business_id=$1 AND s.status='completed' AND ${day} GROUP BY cu.id, cu.name ORDER BY 3 DESC LIMIT 10`)]);
        Object.assign(res2, { byCategory: cat.map(x => ({ name: x.k, qty: num(x.qty), revenue: num(x.revenue) })), byCashier: cash.map(x => ({ name: x.k, count: x.n, total: num(x.total) })), byBranch: br.map(x => ({ name: x.k, count: x.n, total: num(x.total) })),
          byHour: hr.map(x => ({ hour: x.k, count: x.n, total: num(x.total) })), topCustomers: cu.map(x => ({ name: x.k, count: x.n, total: num(x.total) })) });
      }
      return out(res, res2);
    }

    if (M === "GET" && path === "/api/business/reports/inventory") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "reports.view", settings });
      const level = reportLevel(ctx), ids = await idsFor(ctx, q), a = [ctx.business.id, ids];
      const val = await db(`SELECT br.name AS branch, COUNT(DISTINCT p.id)::int AS items, COALESCE(SUM(st.quantity*p.cost_price),0) AS cost, COALESCE(SUM(st.quantity*p.sell_price),0) AS retail FROM bm_stock st
        JOIN bm_products p ON p.id=st.product_id AND p.business_id=st.business_id JOIN bm_branches br ON br.id=st.branch_id WHERE st.business_id=$1 AND p.track_stock AND p.status='active' AND st.quantity>0 AND ($2::bigint[] IS NULL OR st.branch_id=ANY($2::bigint[])) GROUP BY br.name ORDER BY br.name`, a);
      const low = (await db(`SELECT COUNT(*)::int AS n FROM (SELECT p.id, COALESCE((SELECT SUM(s.quantity) FROM bm_stock s WHERE s.product_id=p.id AND s.business_id=p.business_id AND ($2::bigint[] IS NULL OR s.branch_id=ANY($2::bigint[]))),0) AS stock, p.reorder_level FROM bm_products p WHERE p.business_id=$1 AND p.status='active' AND p.track_stock AND p.reorder_level>0) t WHERE t.stock<=t.reorder_level`, a)).rows[0];
      const res2 = { level, valuation: val.rows.map(x => ({ branch: x.branch, items: x.items, cost: num(x.cost), retail: num(x.retail) })), lowStock: low.n, locked: level === "full" ? [] : ["deadStock", "export"] };
      if (level === "full") {
        const dead = await db(`SELECT p.id,p.name,p.unit,SUM(st.quantity) AS qty, SUM(st.quantity*p.cost_price) AS val FROM bm_products p JOIN bm_stock st ON st.product_id=p.id AND st.business_id=p.business_id
          WHERE p.business_id=$1 AND p.track_stock AND p.status='active' AND st.quantity>0 AND ($2::bigint[] IS NULL OR st.branch_id=ANY($2::bigint[]))
          AND NOT EXISTS (SELECT 1 FROM bm_sale_items i JOIN bm_sales s ON s.id=i.sale_id WHERE i.product_id=p.id AND i.business_id=p.business_id AND s.status='completed' AND s.created_at>NOW()-interval '60 days') GROUP BY p.id ORDER BY val DESC LIMIT 20`, a);
        res2.deadStock = dead.rows.map(x => ({ productId: num(x.id), name: x.name, unit: x.unit, qty: num(x.qty), value: num(x.val) }));
      }
      return out(res, res2);
    }

    /* ================= audit export (Enterprise) ================= */
    if (M === "GET" && path === "/api/business/audit/export") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "audit.view", settings });
      needFeature(ctx, "audit_export", "Audit log export");
      const rg = A.dateRange(q.get("from"), q.get("to")); if (rg.error) fail(400, rg.error);
      const r = await db(`SELECT id,actor_label,action,entity,entity_id,old_value,new_value,ip,created_at FROM bm_audit_logs WHERE business_id=$1 AND (created_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN $2::date AND $3::date ORDER BY id DESC LIMIT 5000`, [ctx.business.id, rg.from, rg.to]);
      return out(res, { range: rg, truncated: r.rows.length === 5000, logs: r.rows.map(x => ({ id: num(x.id), at: x.created_at, actor: x.actor_label, action: x.action, entity: x.entity, entityId: x.entity_id, oldValue: x.old_value, newValue: x.new_value, ip: x.ip })) });
    }

    return false;
  }
  return { handle };
};
