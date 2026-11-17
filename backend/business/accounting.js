"use strict";
/* BOLTIV Business Manager, Phase 3: expenses, suppliers and purchases, invoices, financial summary.
   Same rules as the other modules: every route passes getCtx() first, every query is scoped by business_id,
   money is computed on the server, creates are idempotent, and every change is audited. */
const L = require("./logic");
const C = require("./logic2");
const A = require("./logic3");

module.exports = function createAccounting(h) {
  const { db, getCtx, audit, withTx, fail, posInt, out, body, clean, rateLimit, rateLimitedResponse, helpers, needFeature } = h;
  const { branchFor, ensureStock, moveStock, accessible, likeSafe, addLot } = helpers;
  const num = v => Number(v);
  const dbClient = { query: (s, p) => db(s, p) };
  const unrestricted = ctx => ctx.role === "owner" || !ctx.member.branch_ids;
  /* pg turns a DATE column into a local-midnight Date, so read it back with local parts (correct on any server timezone) */
  const dateStr = d => (d instanceof Date ? d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") : String(d).slice(0, 10));
  const idemOf = b => { const k = clean(b.idempotencyKey).slice(0, 80); if (k.length < 8) fail(400, "Missing request key. Please refresh and try again."); return k; };
  /* branch for a record that may belong to the whole business (null). Restricted staff must pick one of their branches. */
  async function optBranch(ctx, c, raw) {
    if (raw === undefined || raw === null || raw === "") { if (!unrestricted(ctx)) fail(400, "Choose a branch."); return null; }
    return (await branchFor(ctx, c, raw)).id;
  }
  const rangeOf = q => { const r = A.dateRange(q.get("from"), q.get("to")); if (r.error) fail(400, r.error); return r; };
  const branchFilter = async (ctx, q) => { if (q.get("branch_id")) { const b = await branchFor(ctx, dbClient, q.get("branch_id")); return [num(b.id)]; } return accessible(ctx); };

  /* ---------- views ---------- */
  const expenseView = e => ({ id: num(e.id), category: e.category, description: e.description, amount: num(e.amount), method: e.method, date: dateStr(e.expense_date), branchId: e.branch_id ? num(e.branch_id) : null, branch: e.branch_name || null, status: e.status, by: e.created_by_name, voidReason: e.void_reason });
  const supplierView = s => ({ id: num(s.id), name: s.name, phone: s.phone, email: s.email, address: s.address, notes: s.notes, balance: num(s.balance), status: s.status });
  async function loadPurchase(c, bid, id) {
    const p = (await c.query(`SELECT p.*, sp.name AS supplier_name, br.name AS branch_name FROM bm_purchases p LEFT JOIN bm_suppliers sp ON sp.id=p.supplier_id JOIN bm_branches br ON br.id=p.branch_id WHERE p.id=$1 AND p.business_id=$2`, [id, bid])).rows[0];
    if (!p) return null;
    const items = (await c.query(`SELECT product_id,name,unit,qty,unit_cost,line_total FROM bm_purchase_items WHERE purchase_id=$1 AND business_id=$2 ORDER BY id`, [id, bid])).rows;
    return { id: num(p.id), purchaseNo: p.purchase_no, status: p.status, reference: p.reference, supplierId: p.supplier_id ? num(p.supplier_id) : null, supplier: p.supplier_name, branchId: num(p.branch_id), branch: p.branch_name,
      total: num(p.total), paid: num(p.paid), balanceDue: num(p.balance_due), payMethod: p.pay_method, updateCost: p.update_cost, note: p.note, createdAt: p.created_at, by: p.created_by_name, voidReason: p.void_reason,
      items: items.map(i => ({ productId: num(i.product_id), name: i.name, unit: i.unit, qty: num(i.qty), unitCost: num(i.unit_cost), lineTotal: num(i.line_total) })) };
  }
  async function loadInvoice(c, bid, id) {
    const v = (await c.query(`SELECT i.*, br.name AS branch_name FROM bm_invoices i LEFT JOIN bm_branches br ON br.id=i.branch_id WHERE i.id=$1 AND i.business_id=$2`, [id, bid])).rows[0];
    if (!v) return null;
    const items = (await c.query(`SELECT description,qty,unit_price,line_total FROM bm_invoice_items WHERE invoice_id=$1 AND business_id=$2 ORDER BY id`, [id, bid])).rows;
    const pays = (await c.query(`SELECT id,amount,method,paid_on,note,status,void_reason FROM bm_invoice_payments WHERE invoice_id=$1 AND business_id=$2 ORDER BY id`, [id, bid])).rows;
    return invoiceView(v, items, pays);
  }
  function invoiceView(v, items, pays) {
    const st = A.invoiceStatus({ status: v.status, total: v.total, paid: v.paid, dueDate: dateStr(v.due_date) }, A.lagosToday());
    return { id: num(v.id), invoiceNo: v.invoice_no, status: st.status, overdue: st.overdue, rawStatus: v.status, customerId: v.customer_id ? num(v.customer_id) : null, customerName: v.customer_name, customerPhone: v.customer_phone, customerEmail: v.customer_email,
      branchId: v.branch_id ? num(v.branch_id) : null, issueDate: dateStr(v.issue_date), dueDate: dateStr(v.due_date), subtotal: num(v.subtotal), discount: num(v.discount), tax: num(v.tax), total: num(v.total),
      paid: num(v.paid), balanceDue: num(v.balance_due), vatRate: num(v.vat_rate), vatInclusive: v.vat_inclusive, notes: v.notes, terms: v.terms, createdAt: v.created_at, voidReason: v.void_reason,
      ...(items ? { items: items.map(i => ({ description: i.description, qty: num(i.qty), unitPrice: num(i.unit_price), lineTotal: num(i.line_total) })) } : {}),
      ...(pays ? { payments: pays.map(p => ({ id: num(p.id), amount: num(p.amount), method: p.method, date: dateStr(p.paid_on), note: p.note, status: p.status })) } : {}) };
  }
  const receiptHeader = b => ({ name: b.name, address: b.address, phone: b.phone, email: b.email, tin: b.tin });

  async function handle(req, res, path, M, url, user, settings) {
    const q = url.searchParams, uid = String(user.user_id);

    /* ================= expenses ================= */
    if (M === "GET" && path === "/api/business/expenses") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "expenses.view", settings });
      const r = rangeOf(q), ids = await branchFilter(ctx, q), cat = clean(q.get("category")).slice(0, 40);
      const limit = Math.min(200, Math.max(1, num(q.get("limit")) || 100)), offset = Math.max(0, num(q.get("offset")) || 0);
      const args = [ctx.business.id, r.from, r.to, ids, cat];
      const list = await db(`SELECT e.*, br.name AS branch_name FROM bm_expenses e LEFT JOIN bm_branches br ON br.id=e.branch_id WHERE e.business_id=$1 AND e.expense_date BETWEEN $2::date AND $3::date
        AND ($4::bigint[] IS NULL OR e.branch_id=ANY($4::bigint[])) AND ($5='' OR e.category=$5) AND ($6::boolean OR e.status='active') ORDER BY e.expense_date DESC, e.id DESC LIMIT $7 OFFSET $8`,
        [...args, q.get("voided") === "1", limit + 1, offset]);
      const cats = await db(`SELECT category, SUM(amount) AS amt, COUNT(*)::int AS n FROM bm_expenses WHERE business_id=$1 AND status='active' AND expense_date BETWEEN $2::date AND $3::date AND ($4::bigint[] IS NULL OR branch_id=ANY($4::bigint[])) GROUP BY category ORDER BY 2 DESC`, args.slice(0, 4));
      return out(res, { range: r, expenses: list.rows.slice(0, limit).map(expenseView), hasMore: list.rows.length > limit, total: cats.rows.reduce((a, x) => a + num(x.amt), 0),
        byCategory: cats.rows.map(x => ({ category: x.category, amount: num(x.amt), count: x.n })), categories: A.EXPENSE_CATEGORIES, canManage: L.hasPerm(ctx.role, "expenses.manage"), restricted: !unrestricted(ctx) });
    }

    if (M === "POST" && path === "/api/business/expenses/save") {
      const rl = rateLimit(req, "bm-exp:" + uid, 120, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "expenses.manage", write: true, settings });
      const v = A.validateExpense(b); if (v.errors.length) fail(400, v.errors[0]);
      const id = b.id ? posInt(b.id) : null, val = v.value;
      if (id) {
        await withTx(async c => {
          const cur = (await c.query(`SELECT * FROM bm_expenses WHERE id=$1 AND business_id=$2 FOR UPDATE`, [id, ctx.business.id])).rows[0];
          if (!cur) fail(404, "Expense not found."); if (cur.status !== "active") fail(409, "A voided expense cannot be edited.");
          if (cur.source === "payroll") fail(409, "This expense comes from a salary payment. Void the payroll payment instead.");
          if (cur.branch_id && !L.canAccessBranch(ctx.member, cur.branch_id)) fail(404, "Expense not found.");
          if (!cur.branch_id && !unrestricted(ctx)) fail(404, "Expense not found.");
          const branchId = b.branchId === undefined ? cur.branch_id : await optBranch(ctx, c, b.branchId);
          await c.query(`UPDATE bm_expenses SET category=$3,description=$4,amount=$5,method=$6,expense_date=$7::date,branch_id=$8,updated_at=NOW() WHERE id=$1 AND business_id=$2`,
            [id, ctx.business.id, val.category, val.description || null, val.amount, val.method, val.expense_date, branchId]);
          await audit(c, req, ctx, "expense.update", "expense", id, { category: cur.category, amount: num(cur.amount), date: dateStr(cur.expense_date), method: cur.method }, { category: val.category, amount: val.amount, date: val.expense_date, method: val.method });
        });
        return out(res, { expenseId: id, message: "Expense updated." });
      }
      const idem = idemOf(b);
      const find = async c => (await c.query(`SELECT id FROM bm_expenses WHERE business_id=$1 AND idempotency_key=$2 AND created_by=$3`, [ctx.business.id, idem, ctx.uid])).rows[0];
      const dupe = await find(dbClient); if (dupe) return out(res, { expenseId: num(dupe.id), already: true, message: "This expense was already recorded." });
      try {
        const eid = await withTx(async c => {
          const branchId = await optBranch(ctx, c, b.branchId);
          const e = (await c.query(`INSERT INTO bm_expenses(business_id,branch_id,category,description,amount,method,expense_date,idempotency_key,created_by,created_by_name) VALUES($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10) RETURNING id`,
            [ctx.business.id, branchId, val.category, val.description || null, val.amount, val.method, val.expense_date, idem, ctx.uid, ctx.user.name || ctx.user.email || null])).rows[0];
          await audit(c, req, ctx, "expense.create", "expense", e.id, null, { category: val.category, amount: val.amount, date: val.expense_date, method: val.method });
          return num(e.id);
        });
        return out(res, { expenseId: eid, message: "Expense recorded." });
      } catch (e) { if (e.code === "23505" && e.constraint === "bm_expenses_idem_uq") { const again = await find(dbClient); if (again) return out(res, { expenseId: num(again.id), already: true, message: "This expense was already recorded." }); fail(409, "Duplicate request key. Please refresh and try again."); } throw e; }
    }

    if (M === "POST" && path === "/api/business/expenses/void") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "expenses.manage", write: true, settings });
      const reason = clean(b.reason).slice(0, 200); if (reason.length < 3) fail(400, "Please give a reason.");
      await withTx(async c => {
        const cur = (await c.query(`SELECT * FROM bm_expenses WHERE id=$1 AND business_id=$2 FOR UPDATE`, [posInt(b.expenseId), ctx.business.id])).rows[0];
        if (!cur || (cur.branch_id ? !L.canAccessBranch(ctx.member, cur.branch_id) : !unrestricted(ctx))) fail(404, "Expense not found.");
        if (cur.status !== "active") fail(409, "This expense is already voided.");
        if (cur.source === "payroll") fail(409, "This expense comes from a salary payment. Void the payroll payment instead.");
        await c.query(`UPDATE bm_expenses SET status='void',voided_at=NOW(),voided_by=$3,void_reason=$4,updated_at=NOW() WHERE id=$1 AND business_id=$2`, [cur.id, ctx.business.id, ctx.uid, reason]);
        await audit(c, req, ctx, "expense.void", "expense", cur.id, { amount: num(cur.amount), category: cur.category }, { reason });
      });
      return out(res, { message: "Expense voided." });
    }

    /* ================= suppliers ================= */
    if (M === "GET" && path === "/api/business/suppliers") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "suppliers.view", settings });
      const search = likeSafe(q.get("search")), limit = Math.min(200, Math.max(1, num(q.get("limit")) || 100)), offset = Math.max(0, num(q.get("offset")) || 0);
      const r = await db(`SELECT * FROM bm_suppliers WHERE business_id=$1 AND status='active' AND ($2='' OR name ILIKE '%'||$2||'%' OR phone LIKE '%'||$2||'%') AND ($3::boolean=false OR balance>0) ORDER BY lower(name) LIMIT $4 OFFSET $5`,
        [ctx.business.id, search, q.get("owing") === "1", limit + 1, offset]);
      const tot = (await db(`SELECT COALESCE(SUM(balance) FILTER (WHERE balance>0),0) AS owed FROM bm_suppliers WHERE business_id=$1 AND status='active'`, [ctx.business.id])).rows[0];
      return out(res, { suppliers: r.rows.slice(0, limit).map(supplierView), hasMore: r.rows.length > limit, totalOwed: num(tot.owed), canManage: L.hasPerm(ctx.role, "suppliers.manage") });
    }

    if (M === "POST" && path === "/api/business/suppliers/save") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "suppliers.manage", write: true, settings });
      const id = b.id ? posInt(b.id) : null, v = A.validateSupplier(b, { partial: !!id }); if (v.errors.length) fail(400, v.errors[0].replace("Customer", "Supplier"));
      const val = v.value; for (const k of ["phone", "email", "address", "notes"]) if (k in val && val[k] === "") val[k] = null;
      try {
        const sid = await withTx(async c => {
          if (id) {
            const cur = (await c.query(`SELECT * FROM bm_suppliers WHERE id=$1 AND business_id=$2 FOR UPDATE`, [id, ctx.business.id])).rows[0]; if (!cur) fail(404, "Supplier not found.");
            const keys = Object.keys(val).filter(k => (cur[k] ?? null) !== (val[k] ?? null)); if (!keys.length) return id;
            await c.query(`UPDATE bm_suppliers SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(",")},updated_at=NOW() WHERE id=$1 AND business_id=$2`, [id, ctx.business.id, ...keys.map(k => val[k])]);
            await audit(c, req, ctx, "supplier.update", "supplier", id, Object.fromEntries(keys.map(k => [k, cur[k]])), Object.fromEntries(keys.map(k => [k, val[k]]))); return id;
          }
          const n = (await c.query(`INSERT INTO bm_suppliers(business_id,name,phone,email,address,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.business.id, val.name, val.phone ?? null, val.email ?? null, val.address ?? null, val.notes ?? null])).rows[0];
          await audit(c, req, ctx, "supplier.create", "supplier", n.id, null, { name: val.name }); return num(n.id);
        });
        return out(res, { supplierId: sid, message: "Supplier saved." });
      } catch (e) { if (e.code === "23505") fail(409, "A supplier with this phone number already exists."); throw e; }
    }

    if (M === "GET" && path === "/api/business/suppliers/detail") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "suppliers.view", settings });
      const sp = (await db(`SELECT * FROM bm_suppliers WHERE id=$1 AND business_id=$2`, [posInt(q.get("id")), ctx.business.id])).rows[0]; if (!sp) fail(404, "Supplier not found.");
      const led = (await db(`SELECT id,type,amount,balance_after,method,note,purchase_id,created_at FROM bm_supplier_ledger WHERE supplier_id=$1 AND business_id=$2 ORDER BY id DESC LIMIT 50`, [sp.id, ctx.business.id])).rows;
      const pur = L.hasPerm(ctx.role, "purchases.view") ? (await db(`SELECT id,purchase_no,total,balance_due,status,created_at FROM bm_purchases WHERE supplier_id=$1 AND business_id=$2 ORDER BY id DESC LIMIT 20`, [sp.id, ctx.business.id])).rows : [];
      return out(res, { supplier: supplierView(sp), ledger: led.map(l => ({ id: num(l.id), type: l.type, amount: num(l.amount), balance: num(l.balance_after), method: l.method, note: l.note, purchaseId: l.purchase_id ? num(l.purchase_id) : null, at: l.created_at })),
        purchases: pur.map(p => ({ id: num(p.id), purchaseNo: p.purchase_no, total: num(p.total), balanceDue: num(p.balance_due), status: p.status, at: p.created_at })) });
    }

    if (M === "POST" && path === "/api/business/suppliers/payment") {
      const rl = rateLimit(req, "bm-suppay:" + uid, 60, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "suppliers.manage", write: true, settings });
      const method = clean(b.method).toLowerCase(), amt = num(b.amount), idem = idemOf(b);
      if (!C.PAY_METHODS.includes(method)) fail(400, "Choose a payment method."); if (!(amt > 0) || amt > 1e9) fail(400, "Enter a valid amount.");
      try {
        const bal = await withTx(async c => {
          const sp = (await c.query(`SELECT * FROM bm_suppliers WHERE id=$1 AND business_id=$2 FOR UPDATE`, [posInt(b.supplierId), ctx.business.id])).rows[0]; if (!sp) fail(404, "Supplier not found.");
          const k = L.toKobo(amt); if (k > L.toKobo(sp.balance)) fail(400, "That is more than you owe this supplier (" + num(sp.balance) + ").");
          const nb = (await c.query(`UPDATE bm_suppliers SET balance=balance-$3,updated_at=NOW() WHERE id=$1 AND business_id=$2 RETURNING balance`, [sp.id, ctx.business.id, L.fromKobo(k)])).rows[0].balance;
          await c.query(`INSERT INTO bm_supplier_ledger(business_id,supplier_id,type,amount,balance_after,method,note,user_id,idem) VALUES($1,$2,'payment',$3,$4,$5,$6,$7,$8)`, [ctx.business.id, sp.id, -L.fromKobo(k), nb, method, clean(b.note).slice(0, 200) || null, ctx.uid, idem]);
          await audit(c, req, ctx, "supplier.payment", "supplier", sp.id, { balance: num(sp.balance) }, { balance: num(nb), amount: L.fromKobo(k), method }); return num(nb);
        });
        return out(res, { balance: bal, message: "Payment recorded." });
      } catch (e) { if (e.code === "23505" && e.constraint === "bm_sup_ledger_idem_uq") return out(res, { already: true, message: "This payment was already recorded." }); throw e; }
    }

    /* ================= purchases (receiving stock from suppliers) ================= */
    if (M === "POST" && path === "/api/business/purchases/create") {
      const rl = rateLimit(req, "bm-po:" + uid, 60, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "purchases.manage", write: true, settings });
      const idem = idemOf(b), rawItems = Array.isArray(b.items) ? b.items : [];
      if (!rawItems.length || rawItems.length > 100) fail(400, "Add between 1 and 100 items.");
      const method = clean(b.method).toLowerCase() || "cash"; if (!C.PAY_METHODS.includes(method)) fail(400, "Choose a payment method.");
      if (rawItems.some(i => i.expiry)) needFeature(ctx, "advanced_inventory", "Expiry tracking");
      const find = async c => { const p = (await c.query(`SELECT id FROM bm_purchases WHERE business_id=$1 AND idempotency_key=$2 AND created_by=$3`, [ctx.business.id, idem, ctx.uid])).rows[0]; return p ? loadPurchase(c, ctx.business.id, p.id) : null; };
      const prior = await find(dbClient); if (prior) return out(res, { purchase: prior, already: true, message: "This purchase was already recorded." });
      let purchase;
      try {
        purchase = await withTx(async c => {
          const br = await branchFor(ctx, c, b.branchId);
          let sup = null;
          if (b.supplierId) { sup = (await c.query(`SELECT * FROM bm_suppliers WHERE id=$1 AND business_id=$2 AND status='active' FOR UPDATE`, [posInt(b.supplierId), ctx.business.id])).rows[0]; if (!sup) fail(404, "Supplier not found."); }
          const pids = [...new Set(rawItems.map(i => posInt(i.productId)))]; if (pids.some(x => !x)) fail(400, "Invalid product.");
          const prods = new Map((await c.query(`SELECT * FROM bm_products WHERE business_id=$1 AND id=ANY($2::bigint[]) AND status='active'`, [ctx.business.id, pids])).rows.map(p => [num(p.id), p]));
          if (prods.size !== pids.length) fail(409, "A product in this purchase is no longer available.");
          let calc; try { calc = A.computePurchase({ lines: rawItems.map(i => ({ qty: i.qty, unitCost: i.unitCost })), paid: num(b.paid || 0), hasSupplier: !!sup }); } catch (e) { fail(400, e.message); }
          const no = (await c.query(`INSERT INTO bm_counters(business_id,key,value) VALUES($1,'purchase',1) ON CONFLICT(business_id,key) DO UPDATE SET value=bm_counters.value+1 RETURNING value`, [ctx.business.id])).rows[0].value;
          const p = (await c.query(`INSERT INTO bm_purchases(business_id,branch_id,supplier_id,purchase_no,reference,total,paid,balance_due,pay_method,update_cost,note,idempotency_key,created_by,created_by_name)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
            [ctx.business.id, br.id, sup ? sup.id : null, A.docNo("PO", no), clean(b.reference).slice(0, 60) || null, calc.total, calc.paid, calc.due, calc.paid > 0 ? method : null, b.updateCost === true, clean(b.note).slice(0, 200) || null, idem, ctx.uid, ctx.user.name || ctx.user.email || null])).rows[0];
          const need = new Map(), lastCost = new Map();
          for (let i = 0; i < rawItems.length; i++) {
            const pr = prods.get(posInt(rawItems[i].productId)), cl = calc.lines[i];
            await c.query(`INSERT INTO bm_purchase_items(business_id,purchase_id,product_id,name,unit,qty,unit_cost,line_total,tracked) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [ctx.business.id, p.id, pr.id, pr.name, pr.unit, cl.qty, L.fromKobo(cl.unitCostKobo), L.fromKobo(cl.lineKobo), pr.track_stock]);
            if (pr.track_stock) need.set(num(pr.id), C.q3((need.get(num(pr.id)) || 0) + cl.qty));
            lastCost.set(num(pr.id), L.fromKobo(cl.unitCostKobo));
          }
          for (const pid of [...need.keys()].sort((a, z) => a - z)) {
            await ensureStock(c, ctx.business.id, br.id, pid);
            await c.query(`SELECT 1 FROM bm_stock WHERE product_id=$1 AND branch_id=$2 AND business_id=$3 FOR UPDATE`, [pid, br.id, ctx.business.id]);
            await moveStock(c, ctx, { branchId: br.id, productId: pid, delta: need.get(pid), type: "purchase", refType: "purchase", refId: p.id, note: A.docNo("PO", no) });
          }
          for (let i = 0; i < rawItems.length; i++) {
            const pr = prods.get(posInt(rawItems[i].productId));
            if (rawItems[i].expiry && pr.track_stock) await addLot(c, ctx, { productId: pr.id, branchId: br.id, lotNo: rawItems[i].lotNo, expiry: clean(rawItems[i].expiry).slice(0, 10), qty: calc.lines[i].qty, source: "purchase", refId: p.id });
          }
          if (b.updateCost === true) for (const [pid, cost] of lastCost) await c.query(`UPDATE bm_products SET cost_price=$3,updated_at=NOW() WHERE id=$1 AND business_id=$2`, [pid, ctx.business.id, cost]);
          if (sup) {
            let bal = num(sup.balance);
            bal = L.fromKobo(L.toKobo(bal) + calc.totalKobo);
            await c.query(`INSERT INTO bm_supplier_ledger(business_id,supplier_id,type,amount,balance_after,purchase_id,user_id) VALUES($1,$2,'purchase',$3,$4,$5,$6)`, [ctx.business.id, sup.id, calc.total, bal, p.id, ctx.uid]);
            if (calc.paid > 0) { bal = L.fromKobo(L.toKobo(bal) - L.toKobo(calc.paid)); await c.query(`INSERT INTO bm_supplier_ledger(business_id,supplier_id,type,amount,balance_after,purchase_id,method,user_id) VALUES($1,$2,'payment',$3,$4,$5,$6,$7)`, [ctx.business.id, sup.id, -calc.paid, bal, p.id, method, ctx.uid]); }
            await c.query(`UPDATE bm_suppliers SET balance=$3,updated_at=NOW() WHERE id=$1 AND business_id=$2`, [sup.id, ctx.business.id, bal]);
          }
          await audit(c, req, ctx, "purchase.create", "purchase", p.id, null, { no: A.docNo("PO", no), total: calc.total, paid: calc.paid, due: calc.due, items: rawItems.length });
          return loadPurchase(c, ctx.business.id, p.id);
        });
      } catch (e) {
        if (e.code === "23505" && e.constraint === "bm_purchases_idem_uq") { const again = await find(dbClient); if (again) return out(res, { purchase: again, already: true, message: "This purchase was already recorded." }); fail(409, "Duplicate request key. Please refresh and try again."); }
        throw e;
      }
      return out(res, { purchase, message: "Purchase recorded and stock updated." });
    }

    if (M === "GET" && path === "/api/business/purchases") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "purchases.view", settings });
      const ids = await branchFilter(ctx, q), limit = Math.min(100, Math.max(1, num(q.get("limit")) || 40)), offset = Math.max(0, num(q.get("offset")) || 0);
      const r = await db(`SELECT p.id,p.purchase_no,p.total,p.balance_due,p.status,p.created_at,sp.name AS supplier,br.name AS branch FROM bm_purchases p LEFT JOIN bm_suppliers sp ON sp.id=p.supplier_id JOIN bm_branches br ON br.id=p.branch_id
        WHERE p.business_id=$1 AND ($2::bigint[] IS NULL OR p.branch_id=ANY($2::bigint[])) AND ($3::bigint IS NULL OR p.supplier_id=$3) ORDER BY p.id DESC LIMIT $4 OFFSET $5`, [ctx.business.id, ids, q.get("supplier_id") ? posInt(q.get("supplier_id")) : null, limit + 1, offset]);
      return out(res, { purchases: r.rows.slice(0, limit).map(p => ({ id: num(p.id), purchaseNo: p.purchase_no, total: num(p.total), balanceDue: num(p.balance_due), status: p.status, at: p.created_at, supplier: p.supplier, branch: p.branch })), hasMore: r.rows.length > limit, canManage: L.hasPerm(ctx.role, "purchases.manage") });
    }

    if (M === "GET" && path === "/api/business/purchases/detail") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "purchases.view", settings });
      const p = await loadPurchase(dbClient, ctx.business.id, posInt(q.get("id")));
      if (!p || !L.canAccessBranch(ctx.member, p.branchId)) fail(404, "Purchase not found.");
      return out(res, { purchase: p, canManage: L.hasPerm(ctx.role, "purchases.manage") });
    }

    if (M === "POST" && path === "/api/business/purchases/void") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "purchases.manage", write: true, settings });
      const reason = clean(b.reason).slice(0, 200); if (reason.length < 3) fail(400, "Please give a reason.");
      await withTx(async c => {
        const p = (await c.query(`SELECT * FROM bm_purchases WHERE id=$1 AND business_id=$2 FOR UPDATE`, [posInt(b.purchaseId), ctx.business.id])).rows[0];
        if (!p || !L.canAccessBranch(ctx.member, p.branch_id)) fail(404, "Purchase not found."); if (p.status !== "received") fail(409, "This purchase is already voided.");
        if (p.supplier_id) await c.query(`SELECT 1 FROM bm_suppliers WHERE id=$1 AND business_id=$2 FOR UPDATE`, [p.supplier_id, ctx.business.id]);
        const items = (await c.query(`SELECT product_id,qty FROM bm_purchase_items WHERE purchase_id=$1 AND business_id=$2 AND tracked`, [p.id, ctx.business.id])).rows;
        const back = new Map(); for (const i of items) back.set(num(i.product_id), C.q3((back.get(num(i.product_id)) || 0) + num(i.qty)));
        for (const pid of [...back.keys()].sort((a, z) => a - z)) {
          await ensureStock(c, ctx.business.id, p.branch_id, pid);
          const cur = (await c.query(`SELECT quantity FROM bm_stock WHERE product_id=$1 AND branch_id=$2 AND business_id=$3 FOR UPDATE`, [pid, p.branch_id, ctx.business.id])).rows[0];
          if (num(cur.quantity) < back.get(pid)) fail(409, "Part of this stock has already been sold, so the purchase cannot be voided. Use a stock adjustment instead.");
          await moveStock(c, ctx, { branchId: p.branch_id, productId: pid, delta: -back.get(pid), type: "purchase_void", refType: "purchase", refId: p.id, note: reason });
        }
        if (p.supplier_id && num(p.balance_due) > 0) {
          const nb = (await c.query(`UPDATE bm_suppliers SET balance=balance-$3,updated_at=NOW() WHERE id=$1 AND business_id=$2 RETURNING balance`, [p.supplier_id, ctx.business.id, p.balance_due])).rows[0].balance;
          await c.query(`INSERT INTO bm_supplier_ledger(business_id,supplier_id,type,amount,balance_after,purchase_id,note,user_id) VALUES($1,$2,'void_reversal',$3,$4,$5,$6,$7)`, [ctx.business.id, p.supplier_id, -num(p.balance_due), nb, p.id, reason, ctx.uid]);
        }
        await c.query(`UPDATE bm_purchases SET status='void',voided_at=NOW(),voided_by=$3,void_reason=$4 WHERE id=$1 AND business_id=$2`, [p.id, ctx.business.id, ctx.uid, reason]);
        await audit(c, req, ctx, "purchase.void", "purchase", p.id, { total: num(p.total), no: p.purchase_no }, { reason });
      });
      return out(res, { message: "Purchase voided and stock removed." });
    }

    /* ================= invoices ================= */
    if (M === "GET" && path === "/api/business/invoices") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "invoices.view", settings });
      const ids = accessible(ctx), limit = Math.min(100, Math.max(1, num(q.get("limit")) || 40)), offset = Math.max(0, num(q.get("offset")) || 0), search = likeSafe(q.get("search"));
      const status = ["draft", "unpaid", "partial", "paid", "overdue", "void"].includes(q.get("status")) ? q.get("status") : "";
      const today = A.lagosToday();
      const r = await db(`SELECT i.* FROM bm_invoices i WHERE i.business_id=$1 AND ($2::bigint[] IS NULL OR i.branch_id=ANY($2::bigint[])) AND ($3='' OR i.invoice_no ILIKE '%'||$3||'%' OR i.customer_name ILIKE '%'||$3||'%')
        AND ($4='' OR ($4='draft' AND i.status='draft') OR ($4='void' AND i.status='void') OR ($4='unpaid' AND i.status='issued' AND i.paid=0 AND i.balance_due>0) OR ($4='partial' AND i.status='issued' AND i.paid>0 AND i.balance_due>0)
          OR ($4='paid' AND i.status='issued' AND i.balance_due<=0) OR ($4='overdue' AND i.status='issued' AND i.balance_due>0 AND i.due_date<$5::date)) ORDER BY i.id DESC LIMIT $6 OFFSET $7`,
        [ctx.business.id, ids, search, status, today, limit + 1, offset]);
      const tot = (await db(`SELECT COALESCE(SUM(balance_due) FILTER (WHERE status='issued' AND balance_due>0),0) AS outstanding, COALESCE(SUM(balance_due) FILTER (WHERE status='issued' AND balance_due>0 AND due_date<$2::date),0) AS overdue FROM bm_invoices WHERE business_id=$1`, [ctx.business.id, today])).rows[0];
      return out(res, { invoices: r.rows.slice(0, limit).map(v => invoiceView(v)), hasMore: r.rows.length > limit, outstanding: num(tot.outstanding), overdue: num(tot.overdue), canManage: L.hasPerm(ctx.role, "invoices.manage") });
    }

    if (M === "POST" && path === "/api/business/invoices/save") {
      const rl = rateLimit(req, "bm-inv:" + uid, 60, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "invoices.manage", write: true, settings });
      const id = b.id ? posInt(b.id) : null, issue = b.issue === true, idem = id ? null : idemOf(b);
      const v = A.validateInvoice(b); if (v.errors.length) fail(400, v.errors[0]);
      const find = async c => { const r = (await c.query(`SELECT id FROM bm_invoices WHERE business_id=$1 AND idempotency_key=$2 AND created_by=$3`, [ctx.business.id, idem, ctx.uid])).rows[0]; return r ? loadInvoice(c, ctx.business.id, r.id) : null; };
      if (idem) { const prior = await find(dbClient); if (prior) return out(res, { invoice: prior, already: true, message: "This invoice was already saved." }); }
      let inv;
      try {
        inv = await withTx(async c => {
          let cust = null;
          if (b.customerId) { cust = (await c.query(`SELECT * FROM bm_customers WHERE id=$1 AND business_id=$2 AND status='active'`, [posInt(b.customerId), ctx.business.id])).rows[0]; if (!cust) fail(404, "Customer not found."); }
          const name = v.value.customer_name || (cust ? cust.name : "");
          if (name.length < 2) fail(400, "Enter the customer's name.");
          let calc; try { calc = A.computeInvoice({ items: v.value.items, discount: num(b.discount || 0), vatRate: num(ctx.business.vat_rate), vatInclusive: ctx.business.vat_inclusive }); } catch (e) { fail(400, e.message); }
          const branchId = await optBranch(ctx, c, b.branchId);
          let cur = null;
          if (id) { cur = (await c.query(`SELECT * FROM bm_invoices WHERE id=$1 AND business_id=$2 FOR UPDATE`, [id, ctx.business.id])).rows[0]; if (!cur) fail(404, "Invoice not found."); if (cur.status !== "draft") fail(409, "Only drafts can be edited."); }
          const phone = clean(b.customerPhone).slice(0, 20) || (cust ? cust.phone : null), email = clean(b.customerEmail).slice(0, 120).toLowerCase() || (cust ? cust.email : null);
          let no = null; if (issue) no = A.docNo("INV", (await c.query(`INSERT INTO bm_counters(business_id,key,value) VALUES($1,'invoice',1) ON CONFLICT(business_id,key) DO UPDATE SET value=bm_counters.value+1 RETURNING value`, [ctx.business.id])).rows[0].value);
          const vals = [ctx.business.id, branchId, no, cust ? cust.id : null, name, phone || null, email || null, issue ? "issued" : "draft", v.value.issue_date, v.value.due_date, calc.subtotal, calc.discount, calc.tax, calc.total, calc.total, num(ctx.business.vat_rate), !!ctx.business.vat_inclusive, v.value.notes || null, v.value.terms || null];
          let iid;
          if (cur) {
            await c.query(`DELETE FROM bm_invoice_items WHERE invoice_id=$1 AND business_id=$2`, [cur.id, ctx.business.id]);
            await c.query(`UPDATE bm_invoices SET branch_id=$2,invoice_no=$3,customer_id=$4,customer_name=$5,customer_phone=$6,customer_email=$7,status=$8,issue_date=$9::date,due_date=$10::date,subtotal=$11,discount=$12,tax=$13,total=$14,balance_due=$15,vat_rate=$16,vat_inclusive=$17,notes=$18,terms=$19,updated_at=NOW() WHERE id=$1 AND business_id=$20`,
              [cur.id, ...vals.slice(1), ctx.business.id]);
            iid = cur.id;
          } else {
            iid = (await c.query(`INSERT INTO bm_invoices(business_id,branch_id,invoice_no,customer_id,customer_name,customer_phone,customer_email,status,issue_date,due_date,subtotal,discount,tax,total,balance_due,vat_rate,vat_inclusive,notes,terms,idempotency_key,created_by,created_by_name)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`, [...vals, idem, ctx.uid, ctx.user.name || ctx.user.email || null])).rows[0].id;
          }
          for (let i = 0; i < v.value.items.length; i++) await c.query(`INSERT INTO bm_invoice_items(business_id,invoice_id,description,qty,unit_price,line_total) VALUES($1,$2,$3,$4,$5,$6)`,
            [ctx.business.id, iid, v.value.items[i].description, calc.lines[i].qty, v.value.items[i].unitPrice, L.fromKobo(calc.lines[i].net)]);
          await audit(c, req, ctx, issue ? "invoice.issue" : (cur ? "invoice.update" : "invoice.create_draft"), "invoice", iid, cur ? { total: num(cur.total) } : null, { no, customer: name, total: calc.total });
          return loadInvoice(c, ctx.business.id, iid);
        });
      } catch (e) {
        if (e.code === "23505" && e.constraint === "bm_invoices_idem_uq") { const again = await find(dbClient); if (again) return out(res, { invoice: again, already: true, message: "This invoice was already saved." }); fail(409, "Duplicate request key. Please refresh and try again."); }
        throw e;
      }
      return out(res, { invoice: inv, message: issue ? "Invoice " + inv.invoiceNo + " issued." : "Draft saved." });
    }

    if (M === "POST" && path === "/api/business/invoices/issue") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "invoices.manage", write: true, settings });
      const inv = await withTx(async c => {
        const cur = (await c.query(`SELECT * FROM bm_invoices WHERE id=$1 AND business_id=$2 FOR UPDATE`, [posInt(b.invoiceId), ctx.business.id])).rows[0]; if (!cur) fail(404, "Invoice not found."); if (cur.status !== "draft") fail(409, "This invoice is already issued.");
        const no = A.docNo("INV", (await c.query(`INSERT INTO bm_counters(business_id,key,value) VALUES($1,'invoice',1) ON CONFLICT(business_id,key) DO UPDATE SET value=bm_counters.value+1 RETURNING value`, [ctx.business.id])).rows[0].value);
        await c.query(`UPDATE bm_invoices SET status='issued',invoice_no=$3,updated_at=NOW() WHERE id=$1 AND business_id=$2`, [cur.id, ctx.business.id, no]);
        await audit(c, req, ctx, "invoice.issue", "invoice", cur.id, { status: "draft" }, { no, total: num(cur.total) });
        return loadInvoice(c, ctx.business.id, cur.id);
      });
      return out(res, { invoice: inv, message: "Invoice " + inv.invoiceNo + " issued." });
    }

    if (M === "GET" && path === "/api/business/invoices/detail") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "invoices.view", settings });
      const inv = await loadInvoice(dbClient, ctx.business.id, posInt(q.get("id")));
      if (!inv || (inv.branchId && !L.canAccessBranch(ctx.member, inv.branchId))) fail(404, "Invoice not found.");
      return out(res, { invoice: inv, business: receiptHeader(ctx.business), canManage: L.hasPerm(ctx.role, "invoices.manage") });
    }

    if (M === "POST" && path === "/api/business/invoices/payment") {
      const rl = rateLimit(req, "bm-invpay:" + uid, 60, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "invoices.manage", write: true, settings });
      const method = clean(b.method).toLowerCase(), amt = num(b.amount), idem = idemOf(b), today = A.lagosToday();
      const date = b.date ? clean(b.date).slice(0, 10) : today;
      if (!C.PAY_METHODS.includes(method)) fail(400, "Choose a payment method."); if (!(amt > 0) || amt > 1e9) fail(400, "Enter a valid amount.");
      if (!A.isDate(date) || date > A.addDays(today, 1)) fail(400, "Enter a valid payment date.");
      try {
        const inv = await withTx(async c => {
          const cur = (await c.query(`SELECT * FROM bm_invoices WHERE id=$1 AND business_id=$2 FOR UPDATE`, [posInt(b.invoiceId), ctx.business.id])).rows[0];
          if (!cur || (cur.branch_id && !L.canAccessBranch(ctx.member, cur.branch_id))) fail(404, "Invoice not found.");
          if (cur.status !== "issued") fail(409, cur.status === "draft" ? "Issue the invoice before recording payments." : "This invoice is void.");
          const k = L.toKobo(amt); if (k > L.toKobo(cur.balance_due)) fail(400, "That is more than the balance on this invoice (" + num(cur.balance_due) + ").");
          await c.query(`INSERT INTO bm_invoice_payments(business_id,invoice_id,amount,method,paid_on,note,user_id,idem) VALUES($1,$2,$3,$4,$5::date,$6,$7,$8)`, [ctx.business.id, cur.id, L.fromKobo(k), method, date, clean(b.note).slice(0, 200) || null, ctx.uid, idem]);
          await c.query(`UPDATE bm_invoices SET paid=paid+$3,balance_due=balance_due-$3,updated_at=NOW() WHERE id=$1 AND business_id=$2`, [cur.id, ctx.business.id, L.fromKobo(k)]);
          await audit(c, req, ctx, "invoice.payment", "invoice", cur.id, { paid: num(cur.paid) }, { amount: L.fromKobo(k), method, date, no: cur.invoice_no });
          return loadInvoice(c, ctx.business.id, cur.id);
        });
        return out(res, { invoice: inv, message: inv.balanceDue <= 0 ? "Payment recorded. Invoice paid in full." : "Payment recorded." });
      } catch (e) { if (e.code === "23505" && e.constraint === "bm_invoice_pay_idem_uq") return out(res, { already: true, message: "This payment was already recorded." }); throw e; }
    }

    if (M === "POST" && path === "/api/business/invoices/payment/void") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "invoices.manage", write: true, settings });
      const reason = clean(b.reason).slice(0, 200); if (reason.length < 3) fail(400, "Please give a reason.");
      const inv = await withTx(async c => {
        const pay = (await c.query(`SELECT * FROM bm_invoice_payments WHERE id=$1 AND business_id=$2`, [posInt(b.paymentId), ctx.business.id])).rows[0]; if (!pay) fail(404, "Payment not found.");
        const cur = (await c.query(`SELECT * FROM bm_invoices WHERE id=$1 AND business_id=$2 FOR UPDATE`, [pay.invoice_id, ctx.business.id])).rows[0];
        if (!cur || (cur.branch_id && !L.canAccessBranch(ctx.member, cur.branch_id))) fail(404, "Payment not found.");
        const p2 = (await c.query(`UPDATE bm_invoice_payments SET status='void',voided_at=NOW(),void_reason=$3 WHERE id=$1 AND business_id=$2 AND status='active' RETURNING amount`, [pay.id, ctx.business.id, reason])).rows[0];
        if (!p2) fail(409, "This payment is already voided.");
        await c.query(`UPDATE bm_invoices SET paid=paid-$3,balance_due=balance_due+$3,updated_at=NOW() WHERE id=$1 AND business_id=$2`, [cur.id, ctx.business.id, p2.amount]);
        await audit(c, req, ctx, "invoice.payment_void", "invoice", cur.id, { amount: num(p2.amount) }, { reason, no: cur.invoice_no });
        return loadInvoice(c, ctx.business.id, cur.id);
      });
      return out(res, { invoice: inv, message: "Payment removed." });
    }

    if (M === "POST" && path === "/api/business/invoices/void") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "invoices.manage", write: true, settings });
      const reason = clean(b.reason).slice(0, 200); if (reason.length < 3) fail(400, "Please give a reason.");
      await withTx(async c => {
        const cur = (await c.query(`SELECT * FROM bm_invoices WHERE id=$1 AND business_id=$2 FOR UPDATE`, [posInt(b.invoiceId), ctx.business.id])).rows[0];
        if (!cur || (cur.branch_id && !L.canAccessBranch(ctx.member, cur.branch_id))) fail(404, "Invoice not found."); if (cur.status === "void") fail(409, "This invoice is already void.");
        if (L.toKobo(cur.paid) > 0) fail(409, "This invoice has payments. Remove the payments first, then void it.");
        await c.query(`UPDATE bm_invoices SET status='void',voided_at=NOW(),voided_by=$3,void_reason=$4,updated_at=NOW() WHERE id=$1 AND business_id=$2`, [cur.id, ctx.business.id, ctx.uid, reason]);
        await audit(c, req, ctx, "invoice.void", "invoice", cur.id, { status: cur.status, total: num(cur.total), no: cur.invoice_no }, { reason });
      });
      return out(res, { message: "Invoice voided." });
    }

    /* ================= financial summary ================= */
    if (M === "GET" && path === "/api/business/finance/summary") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "finance.view", settings });
      if (!unrestricted(ctx)) fail(403, "Financial records are only available to people with access to all branches.");
      const r = rangeOf(q); let branch = null;
      if (q.get("branch_id")) branch = num((await branchFor(ctx, dbClient, q.get("branch_id"))).id);
      const a = [ctx.business.id, r.from, r.to, branch];
      const sDay = `(s.created_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR s.branch_id=$4)`;
      const one = async (sql, args = a) => (await db(sql, args)).rows[0];
      const [sales, cogs, invs, exps, salePays, custPays, invPays, purchPaid, supPays, byDay, recv, owed, pay, inv] = await Promise.all([
        one(`SELECT COALESCE(SUM(s.total-s.tax),0) AS rev, COALESCE(SUM(s.tax),0) AS tax, COUNT(*)::int AS n FROM bm_sales s WHERE s.business_id=$1 AND s.status='completed' AND ${sDay}`),
        one(`SELECT COALESCE(SUM(i.qty*i.unit_cost),0) AS cogs FROM bm_sale_items i JOIN bm_sales s ON s.id=i.sale_id AND s.business_id=i.business_id WHERE s.business_id=$1 AND s.status='completed' AND ${sDay}`),
        one(`SELECT COALESCE(SUM(total-tax),0) AS rev, COALESCE(SUM(tax),0) AS tax, COUNT(*)::int AS n FROM bm_invoices WHERE business_id=$1 AND status='issued' AND issue_date BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR branch_id=$4)`),
        db(`SELECT category, SUM(amount) AS amt FROM bm_expenses WHERE business_id=$1 AND status='active' AND expense_date BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR branch_id=$4) GROUP BY category ORDER BY 2 DESC`, a),
        db(`SELECT p.method, SUM(p.amount) AS amt FROM bm_sale_payments p JOIN bm_sales s ON s.id=p.sale_id AND s.business_id=p.business_id WHERE s.business_id=$1 AND s.status='completed' AND ${sDay} GROUP BY p.method`, a),
        one(`SELECT COALESCE(SUM(-amount),0) AS amt FROM bm_customer_ledger WHERE business_id=$1 AND type='payment' AND $4::bigint IS NULL AND (created_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN $2::date AND $3::date`),
        one(`SELECT COALESCE(SUM(p.amount),0) AS amt FROM bm_invoice_payments p JOIN bm_invoices i ON i.id=p.invoice_id AND i.business_id=p.business_id WHERE p.business_id=$1 AND p.status='active' AND p.paid_on BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR i.branch_id=$4)`),
        one(`SELECT COALESCE(SUM(paid),0) AS amt FROM bm_purchases WHERE business_id=$1 AND status='received' AND (created_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR branch_id=$4)`),
        one(`SELECT COALESCE(SUM(-amount),0) AS amt FROM bm_supplier_ledger WHERE business_id=$1 AND type='payment' AND purchase_id IS NULL AND $4::bigint IS NULL AND (created_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN $2::date AND $3::date`),
        db(`SELECT d::text AS day, SUM(rev) AS rev, SUM(exp) AS exp FROM (
            SELECT (s.created_at AT TIME ZONE 'Africa/Lagos')::date AS d, (s.total-s.tax) AS rev, 0::numeric AS exp FROM bm_sales s WHERE s.business_id=$1 AND s.status='completed' AND ${sDay}
            UNION ALL SELECT issue_date, total-tax, 0 FROM bm_invoices WHERE business_id=$1 AND status='issued' AND issue_date BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR branch_id=$4)
            UNION ALL SELECT expense_date, 0, amount FROM bm_expenses WHERE business_id=$1 AND status='active' AND expense_date BETWEEN $2::date AND $3::date AND ($4::bigint IS NULL OR branch_id=$4)) x GROUP BY d ORDER BY d`, a),
        one(`SELECT COALESCE(SUM(balance) FILTER (WHERE balance>0),0) AS amt FROM bm_customers WHERE business_id=$1 AND status='active'`, [ctx.business.id]),
        one(`SELECT COALESCE(SUM(balance_due),0) AS amt FROM bm_invoices WHERE business_id=$1 AND status='issued' AND balance_due>0`, [ctx.business.id]),
        one(`SELECT COALESCE(SUM(balance) FILTER (WHERE balance>0),0) AS amt FROM bm_suppliers WHERE business_id=$1 AND status='active'`, [ctx.business.id]),
        one(`SELECT COALESCE(SUM(st.quantity*p.cost_price),0) AS amt FROM bm_stock st JOIN bm_products p ON p.id=st.product_id AND p.business_id=st.business_id WHERE st.business_id=$1 AND p.track_stock AND p.status='active' AND ($2::bigint IS NULL OR st.branch_id=$2)`, [ctx.business.id, branch])]);
      const expTotal = exps.rows.reduce((x, y) => x + L.toKobo(y.amt), 0), saleIn = salePays.rows.reduce((x, y) => x + L.toKobo(y.amt), 0);
      const pnl = A.buildPnL({ salesRevenue: num(sales.rev), invoiceRevenue: num(invs.rev), cogs: num(cogs.cogs), expenses: L.fromKobo(expTotal), vat: num(sales.tax) + num(invs.tax),
        cashIn: L.fromKobo(saleIn + L.toKobo(custPays.amt) + L.toKobo(invPays.amt)), cashOut: L.fromKobo(expTotal + L.toKobo(purchPaid.amt) + L.toKobo(supPays.amt)) });
      return out(res, { range: r, pnl, counts: { sales: sales.n, invoices: invs.n }, revenueParts: { sales: num(sales.rev), invoices: num(invs.rev) },
        expensesByCategory: exps.rows.map(x => ({ category: x.category, amount: num(x.amt) })),
        cash: { inByMethod: Object.fromEntries(salePays.rows.map(x => [x.method, num(x.amt)])), customerPayments: num(custPays.amt), invoicePayments: num(invPays.amt), out: { expenses: L.fromKobo(expTotal), purchases: num(purchPaid.amt), supplierPayments: num(supPays.amt) } },
        position: { customersOwe: num(recv.amt), invoicesOutstanding: num(owed.amt), youOweSuppliers: num(pay.amt), inventoryValue: num(inv.amt) },
        byDay: byDay.rows.map(x => ({ day: x.day, revenue: num(x.rev), expenses: num(x.exp) })), branchFiltered: !!branch });
    }

    return false;
  }
  return { handle };
};
