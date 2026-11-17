"use strict";
/* BOLTIV Business Manager, Phase 2: products, stock, customers, POS sales, receipts.
   Mounted by index.js. Every route goes through getCtx() (membership, role, subscription) and every query is scoped by business_id.
   Stock rules: stock only changes inside a transaction together with a movement row; rows are locked in product-id order
   so two cashiers can never sell the same last item, and quantity can never go below zero (also a CHECK in the table).
   Prices always come from the server's product record, never from the browser. */
const L = require("./logic");
const C = require("./logic2");

module.exports = function createCommerce(h) {
  const { db, getCtx, audit, withTx, fail, posInt, out, body, clean, rateLimit, rateLimitedResponse, send, needFeature } = h;
  const A3 = require("./logic3");
  const num = v => Number(v);
  const dbClient = { query: (s, p) => db(s, p) };
  const canCost = ctx => L.hasPerm(ctx.role, "inventory.manage") || L.hasPerm(ctx.role, "finance.view");
  const likeSafe = s => clean(s).slice(0, 60).replace(/[%_\\]/g, "");
  const dateOk = d => /^\d{4}-\d{2}-\d{2}$/.test(d || "") && !isNaN(new Date(d + "T00:00:00Z"));
  const accessible = ctx => (ctx.role === "owner" || !ctx.member.branch_ids ? null : ctx.member.branch_ids.map(Number));

  async function branchFor(ctx, c, branchId) {
    const id = posInt(branchId); if (!id) fail(400, "Choose a branch.");
    const b = (await c.query(`SELECT id,name FROM bm_branches WHERE id=$1 AND business_id=$2 AND status='active'`, [id, ctx.business.id])).rows[0];
    if (!b) fail(404, "Branch not found.");
    if (!L.canAccessBranch(ctx.member, b.id)) fail(403, "You do not have access to this branch.");
    return b;
  }
  async function ensureStock(c, businessId, branchId, productId) {
    await c.query(`INSERT INTO bm_stock(business_id,branch_id,product_id,quantity) VALUES($1,$2,$3,0) ON CONFLICT(product_id,branch_id) DO NOTHING`, [businessId, branchId, productId]);
  }
  async function moveStock(c, ctx, { branchId, productId, delta, type, refType, refId, note }) {
    const r = await c.query(`UPDATE bm_stock SET quantity=quantity+$3,updated_at=NOW() WHERE product_id=$1 AND branch_id=$2 AND business_id=$4 RETURNING quantity`, [productId, branchId, delta, ctx.business.id]);
    if (!r.rows.length) fail(500, "Stock record missing.");
    await c.query(`INSERT INTO bm_stock_movements(business_id,branch_id,product_id,type,qty_change,balance_after,ref_type,ref_id,note,user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ctx.business.id, branchId, productId, type, delta, r.rows[0].quantity, refType || null, refId == null ? null : String(refId), note || null, ctx.uid]);
    return num(r.rows[0].quantity);
  }
  /* Expiry lot for goods that were just received (stock already added in the same transaction) */
  async function addLot(c, ctx, { productId, branchId, lotNo, expiry, qty, source, refId }) {
    const today = A3.lagosToday();
    if (!A3.isDate(expiry) || expiry < A3.addDays(today, -400) || expiry > A3.addDays(today, 3650)) fail(400, "Enter a valid expiry date.");
    await c.query(`INSERT INTO bm_lots(business_id,product_id,branch_id,lot_no,expiry_date,qty,source,ref_id,created_by) VALUES($1,$2,$3,$4,$5::date,$6,$7,$8,$9)`,
      [ctx.business.id, productId, branchId, clean(lotNo).slice(0, 40) || null, expiry, qty, source || "manual", refId == null ? null : String(refId), ctx.uid]);
  }
  const productView = (p, ctx, stock) => ({ id: num(p.id), name: p.name, sku: p.sku, barcode: p.barcode, category: p.category, unit: p.unit, sellPrice: num(p.sell_price),
    ...(canCost(ctx) ? { costPrice: num(p.cost_price) } : {}), trackStock: p.track_stock, reorderLevel: num(p.reorder_level), status: p.status,
    stock: p.track_stock ? num(stock ?? p.stock ?? 0) : null, low: p.track_stock && num(stock ?? p.stock ?? 0) <= num(p.reorder_level) });
  const customerView = c => ({ id: num(c.id), name: c.name, phone: c.phone, email: c.email, address: c.address, notes: c.notes, balance: num(c.balance), status: c.status });

  async function loadSale(c, businessId, saleId) {
    const s = (await c.query(`SELECT s.*, cu.name AS customer_name, cu.phone AS customer_phone, br.name AS branch_name FROM bm_sales s
      LEFT JOIN bm_customers cu ON cu.id=s.customer_id JOIN bm_branches br ON br.id=s.branch_id WHERE s.id=$1 AND s.business_id=$2`, [saleId, businessId])).rows[0];
    if (!s) return null;
    const items = (await c.query(`SELECT product_id,name,sku,unit,qty,unit_price,discount,line_total FROM bm_sale_items WHERE sale_id=$1 AND business_id=$2 ORDER BY id`, [saleId, businessId])).rows;
    const pays = (await c.query(`SELECT method,amount FROM bm_sale_payments WHERE sale_id=$1 AND business_id=$2 ORDER BY id`, [saleId, businessId])).rows;
    return { id: num(s.id), receiptNo: s.receipt_no, status: s.status, branchId: num(s.branch_id), branchName: s.branch_name, customerId: s.customer_id ? num(s.customer_id) : null,
      customerName: s.customer_name || null, customerPhone: s.customer_phone || null, cashier: s.cashier_name, subtotal: num(s.subtotal), discount: num(s.discount), tax: num(s.tax), total: num(s.total),
      paid: num(s.paid), change: num(s.change_given), balanceDue: num(s.balance_due), vatRate: num(s.vat_rate), vatInclusive: s.vat_inclusive, note: s.note, createdAt: s.created_at,
      voidedAt: s.voided_at, voidReason: s.void_reason,
      items: items.map(i => ({ productId: i.product_id ? num(i.product_id) : null, name: i.name, sku: i.sku, unit: i.unit, qty: num(i.qty), unitPrice: num(i.unit_price), discount: num(i.discount), lineTotal: num(i.line_total) })),
      payments: pays.map(p => ({ method: p.method, amount: num(p.amount) })) };
  }
  const receiptHeader = b => ({ name: b.name, address: b.address, phone: b.phone, email: b.email, tin: b.tin, footer: b.receipt_footer || null });

  async function handle(req, res, path, M, url, user, settings) {
    const q = url.searchParams, uid = String(user.user_id);

    /* ---------- products ---------- */
    if (M === "GET" && path === "/api/business/products") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "inventory.view", settings });
      let branchIds = accessible(ctx);
      if (q.get("branch_id")) { const br = await branchFor(ctx, dbClient, q.get("branch_id")); branchIds = [num(br.id)]; }
      const status = q.get("status") === "archived" ? "archived" : "active";
      const limit = Math.min(200, Math.max(1, num(q.get("limit")) || 100)), offset = Math.max(0, num(q.get("offset")) || 0);
      const search = likeSafe(q.get("search")), cat = likeSafe(q.get("category"));
      const r = await db(`SELECT * FROM (SELECT p.*, COALESCE((SELECT SUM(s.quantity) FROM bm_stock s WHERE s.product_id=p.id AND s.business_id=p.business_id AND ($3::bigint[] IS NULL OR s.branch_id=ANY($3::bigint[]))),0) AS stock
        FROM bm_products p WHERE p.business_id=$1 AND p.status=$2 AND ($4='' OR p.name ILIKE '%'||$4||'%' OR p.sku ILIKE '%'||$4||'%' OR p.barcode=$4) AND ($5='' OR p.category ILIKE $5)) t
        WHERE ($6::boolean=false OR (t.track_stock AND t.stock<=t.reorder_level)) ORDER BY lower(t.name) LIMIT $7 OFFSET $8`,
        [ctx.business.id, status, branchIds, search, cat, q.get("low") === "1", limit + 1, offset]);
      const cats = (await db(`SELECT DISTINCT category FROM bm_products WHERE business_id=$1 AND category IS NOT NULL ORDER BY 1 LIMIT 100`, [ctx.business.id])).rows.map(x => x.category);
      return out(res, { products: r.rows.slice(0, limit).map(p => productView(p, ctx)), hasMore: r.rows.length > limit, categories: cats, units: C.UNITS });
    }

    if (M === "POST" && path === "/api/business/products/save") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "inventory.manage", write: true, settings });
      const id = b.id ? posInt(b.id) : null;
      const v = C.validateProduct(b, { partial: !!id }); if (v.errors.length) fail(400, v.errors[0]);
      const val = v.value;
      for (const k of ["sku", "barcode", "category"]) if (k in val && val[k] === "") val[k] = null;
      try {
        const result = await withTx(async c => {
          if (id) {
            const cur = (await c.query(`SELECT * FROM bm_products WHERE id=$1 AND business_id=$2 FOR UPDATE`, [id, ctx.business.id])).rows[0];
            if (!cur) fail(404, "Product not found.");
            const keys = Object.keys(val).filter(k => String(cur[k] ?? "") !== String(val[k] ?? "") && !(typeof cur[k] === "string" && /^\d+(\.\d+)?$/.test(cur[k]) && num(cur[k]) === num(val[k])));
            if (!keys.length) return { id, changed: false };
            await c.query(`UPDATE bm_products SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(",")},updated_at=NOW() WHERE id=$1 AND business_id=$2`, [id, ctx.business.id, ...keys.map(k => val[k])]);
            await audit(c, req, ctx, "product.update", "product", id, Object.fromEntries(keys.map(k => [k, cur[k]])), Object.fromEntries(keys.map(k => [k, val[k]])));
            return { id, changed: true };
          }
          const p = (await c.query(`INSERT INTO bm_products(business_id,name,sku,barcode,category,unit,cost_price,sell_price,track_stock,reorder_level) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [ctx.business.id, val.name, val.sku ?? null, val.barcode ?? null, val.category ?? null, val.unit || "pcs", val.cost_price ?? 0, val.sell_price, val.track_stock !== false, val.reorder_level ?? 0])).rows[0];
          const os = b.openingStock;
          if (os && val.track_stock !== false && num(os.qty) > 0) {
            const br = await branchFor(ctx, c, os.branchId); await ensureStock(c, ctx.business.id, br.id, p.id);
            let d0; try { d0 = C.stockDelta("opening", os.qty, 0); } catch (e) { fail(400, e.message); }
            await moveStock(c, ctx, { branchId: br.id, productId: p.id, delta: d0, type: "opening", note: "Opening stock" });
          }
          await audit(c, req, ctx, "product.create", "product", p.id, null, { name: val.name, sell_price: val.sell_price });
          return { id: num(p.id), changed: true };
        });
        return out(res, { productId: result.id, message: result.changed ? "Product saved." : "Nothing to update." });
      } catch (e) { if (e.code === "23505") fail(409, "That SKU or barcode is already used by another product."); throw e; }
    }

    if (M === "POST" && path === "/api/business/stock/adjust") {
      const rl = rateLimit(req, "bm-stock:" + uid, 120, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "inventory.manage", write: true, settings });
      const type = clean(b.type), note = clean(b.note).slice(0, 200);
      if (["damage", "correction"].includes(type) && note.length < 3) fail(400, "Please add a short reason.");
      if (b.expiry) needFeature(ctx, "advanced_inventory", "Expiry tracking");
      const res2 = await withTx(async c => {
        const br = await branchFor(ctx, c, b.branchId);
        const p = (await c.query(`SELECT * FROM bm_products WHERE id=$1 AND business_id=$2 FOR UPDATE`, [posInt(b.productId), ctx.business.id])).rows[0];
        if (!p) fail(404, "Product not found."); if (!p.track_stock) fail(400, "This product does not track stock.");
        await ensureStock(c, ctx.business.id, br.id, p.id);
        const cur = (await c.query(`SELECT quantity FROM bm_stock WHERE product_id=$1 AND branch_id=$2 AND business_id=$3 FOR UPDATE`, [p.id, br.id, ctx.business.id])).rows[0];
        let delta; try { delta = C.stockDelta(type, b.qty, cur.quantity); } catch (e) { fail(400, e.message); }
        if (delta === 0) return { quantity: num(cur.quantity), unchanged: true };
        const quantity = await moveStock(c, ctx, { branchId: br.id, productId: p.id, delta, type, note });
        if (b.expiry && type === "restock") await addLot(c, ctx, { productId: p.id, branchId: br.id, lotNo: b.lotNo, expiry: clean(b.expiry).slice(0, 10), qty: delta, source: "restock" });
        await audit(c, req, ctx, "stock." + type, "product", p.id, { branch: br.name, quantity: num(cur.quantity) }, { quantity, note });
        return { quantity };
      });
      return out(res, { quantity: res2.quantity, message: res2.unchanged ? "Stock already matches." : "Stock updated." });
    }

    if (M === "GET" && path === "/api/business/stock/movements") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "inventory.view", settings });
      const pid = posInt(q.get("product_id")); if (!pid) fail(400, "Product is required.");
      const ids = accessible(ctx), limit = Math.min(100, Math.max(1, num(q.get("limit")) || 40));
      const r = await db(`SELECT m.id,m.type,m.qty_change,m.balance_after,m.note,m.created_at,m.ref_type,m.ref_id,br.name AS branch,u.name AS actor FROM bm_stock_movements m
        JOIN bm_branches br ON br.id=m.branch_id LEFT JOIN users u ON u.user_id=m.user_id
        WHERE m.business_id=$1 AND m.product_id=$2 AND ($3::bigint[] IS NULL OR m.branch_id=ANY($3::bigint[])) ORDER BY m.id DESC LIMIT $4`, [ctx.business.id, pid, ids, limit]);
      return out(res, { movements: r.rows.map(m => ({ id: num(m.id), type: m.type, change: num(m.qty_change), balance: num(m.balance_after), note: m.note, at: m.created_at, branch: m.branch, actor: m.actor, refType: m.ref_type, refId: m.ref_id })) });
    }

    /* ---------- customers ---------- */
    if (M === "GET" && path === "/api/business/customers") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "customers.view", settings });
      const limit = Math.min(200, Math.max(1, num(q.get("limit")) || 100)), offset = Math.max(0, num(q.get("offset")) || 0), search = likeSafe(q.get("search"));
      const r = await db(`SELECT * FROM bm_customers WHERE business_id=$1 AND status='active' AND ($2='' OR name ILIKE '%'||$2||'%' OR phone LIKE '%'||$2||'%') AND ($3::boolean=false OR balance>0)
        ORDER BY lower(name) LIMIT $4 OFFSET $5`, [ctx.business.id, search, q.get("owing") === "1", limit + 1, offset]);
      const tot = (await db(`SELECT COALESCE(SUM(balance) FILTER (WHERE balance>0),0) AS owed FROM bm_customers WHERE business_id=$1 AND status='active'`, [ctx.business.id])).rows[0];
      return out(res, { customers: r.rows.slice(0, limit).map(customerView), hasMore: r.rows.length > limit, totalOwed: num(tot.owed), canManage: L.hasPerm(ctx.role, "customers.manage") });
    }

    if (M === "POST" && path === "/api/business/customers/save") {
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "customers.manage", write: true, settings });
      const id = b.id ? posInt(b.id) : null, v = C.validateCustomer(b, { partial: !!id }); if (v.errors.length) fail(400, v.errors[0]);
      const val = v.value; for (const k of ["phone", "email", "address", "notes"]) if (k in val && val[k] === "") val[k] = null;
      try {
        const cid = await withTx(async c => {
          if (id) {
            const cur = (await c.query(`SELECT * FROM bm_customers WHERE id=$1 AND business_id=$2 FOR UPDATE`, [id, ctx.business.id])).rows[0]; if (!cur) fail(404, "Customer not found.");
            const keys = Object.keys(val).filter(k => (cur[k] ?? null) !== (val[k] ?? null)); if (!keys.length) return id;
            await c.query(`UPDATE bm_customers SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(",")},updated_at=NOW() WHERE id=$1 AND business_id=$2`, [id, ctx.business.id, ...keys.map(k => val[k])]);
            await audit(c, req, ctx, "customer.update", "customer", id, Object.fromEntries(keys.map(k => [k, cur[k]])), Object.fromEntries(keys.map(k => [k, val[k]]))); return id;
          }
          const n = (await c.query(`INSERT INTO bm_customers(business_id,name,phone,email,address,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.business.id, val.name, val.phone ?? null, val.email ?? null, val.address ?? null, val.notes ?? null])).rows[0];
          await audit(c, req, ctx, "customer.create", "customer", n.id, null, { name: val.name }); return num(n.id);
        });
        return out(res, { customerId: cid, message: "Customer saved." });
      } catch (e) { if (e.code === "23505") fail(409, "A customer with this phone number already exists."); throw e; }
    }

    if (M === "GET" && path === "/api/business/customers/detail") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "customers.view", settings });
      const cu = (await db(`SELECT * FROM bm_customers WHERE id=$1 AND business_id=$2`, [posInt(q.get("id")), ctx.business.id])).rows[0]; if (!cu) fail(404, "Customer not found.");
      const led = (await db(`SELECT id,type,amount,balance_after,method,note,sale_id,created_at FROM bm_customer_ledger WHERE customer_id=$1 AND business_id=$2 ORDER BY id DESC LIMIT 50`, [cu.id, ctx.business.id])).rows;
      const sales = (await db(`SELECT id,receipt_no,total,balance_due,status,created_at FROM bm_sales WHERE customer_id=$1 AND business_id=$2 ORDER BY id DESC LIMIT 20`, [cu.id, ctx.business.id])).rows;
      return out(res, { customer: customerView(cu), ledger: led.map(l => ({ id: num(l.id), type: l.type, amount: num(l.amount), balance: num(l.balance_after), method: l.method, note: l.note, saleId: l.sale_id ? num(l.sale_id) : null, at: l.created_at })),
        sales: sales.map(s => ({ id: num(s.id), receiptNo: s.receipt_no, total: num(s.total), balanceDue: num(s.balance_due), status: s.status, at: s.created_at })) });
    }

    if (M === "POST" && path === "/api/business/customers/payment") {
      const rl = rateLimit(req, "bm-custpay:" + uid, 60, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "customers.manage", write: true, settings });
      const method = clean(b.method).toLowerCase(), amt = num(b.amount), idem = clean(b.idempotencyKey).slice(0, 80);
      if (idem.length < 8) fail(400, "Missing request key. Please refresh and try again.");
      if (!C.PAY_METHODS.includes(method)) fail(400, "Choose a payment method.");
      if (!(amt > 0) || amt > 1e9) fail(400, "Enter a valid amount.");
      try { const bal = await withTx(async c => {
        const cu = (await c.query(`SELECT * FROM bm_customers WHERE id=$1 AND business_id=$2 FOR UPDATE`, [posInt(b.customerId), ctx.business.id])).rows[0]; if (!cu) fail(404, "Customer not found.");
        const k = L.toKobo(amt); if (k > L.toKobo(cu.balance)) fail(400, "That is more than the customer owes (" + num(cu.balance) + ").");
        const nb = (await c.query(`UPDATE bm_customers SET balance=balance-$3,updated_at=NOW() WHERE id=$1 AND business_id=$2 RETURNING balance`, [cu.id, ctx.business.id, L.fromKobo(k)])).rows[0].balance;
        await c.query(`INSERT INTO bm_customer_ledger(business_id,customer_id,type,amount,balance_after,method,note,user_id,idem) VALUES($1,$2,'payment',$3,$4,$5,$6,$7,$8)`, [ctx.business.id, cu.id, -L.fromKobo(k), nb, method, clean(b.note).slice(0, 200) || null, ctx.uid, idem]);
        await audit(c, req, ctx, "customer.payment", "customer", cu.id, { balance: num(cu.balance) }, { balance: num(nb), amount: L.fromKobo(k), method }); return num(nb);
      });
      return out(res, { balance: bal, message: "Payment recorded." });
      } catch (e) { if (e.code === "23505" && e.constraint === "bm_cust_ledger_idem_uq") return out(res, { already: true, message: "This payment was already recorded." }); throw e; }
    }

    /* ---------- sales ---------- */
    if (M === "POST" && path === "/api/business/sales/create") {
      const rl = rateLimit(req, "bm-sale:" + uid, 180, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "sales.create", write: true, settings });
      const idem = clean(b.idempotencyKey).slice(0, 80); if (idem.length < 8) fail(400, "Missing request key. Please refresh and try again.");
      const rawItems = Array.isArray(b.items) ? b.items : []; if (!rawItems.length || rawItems.length > 100) fail(400, "Add between 1 and 100 items.");
      const exists = async c => { const s = (await c.query(`SELECT id FROM bm_sales WHERE business_id=$1 AND idempotency_key=$2 AND cashier_user_id=$3`, [ctx.business.id, idem, ctx.uid])).rows[0]; return s ? loadSale(c, ctx.business.id, s.id) : null; };
      const done = (sale, already) => out(res, { sale, receipt: receiptHeader(ctx.business), already: !!already, message: already ? "This sale was already recorded." : "Sale completed." });
      const prior = await exists(dbClient); if (prior) return done(prior, true);
      let sale;
      try {
        sale = await withTx(async c => {
          const br = await branchFor(ctx, c, b.branchId);
          let cust = null;
          if (b.customerId) { cust = (await c.query(`SELECT * FROM bm_customers WHERE id=$1 AND business_id=$2 AND status='active' FOR UPDATE`, [posInt(b.customerId), ctx.business.id])).rows[0]; if (!cust) fail(404, "Customer not found."); }
          const pids = [...new Set(rawItems.filter(i => i.productId).map(i => posInt(i.productId)))];
          if (pids.some(x => !x)) fail(400, "Invalid product.");
          const prods = new Map((await c.query(`SELECT * FROM bm_products WHERE business_id=$1 AND id=ANY($2::bigint[]) AND status='active'`, [ctx.business.id, pids])).rows.map(p => [num(p.id), p]));
          if (prods.size !== pids.length) fail(409, "A product in this cart is no longer available.", { code: "product_unavailable" });
          const canDisc = L.hasPerm(ctx.role, "pos.discount"), canCustom = L.hasPerm(ctx.role, "pos.custom_item");
          const lines = [], needs = new Map();
          for (const it of rawItems) {
            const disc = num(it.discount || 0);
            if (disc > 0 && !canDisc) fail(403, "You cannot give discounts.");
            if (it.productId) {
              const p = prods.get(posInt(it.productId)); lines.push({ p, unitPrice: num(p.sell_price), qty: it.qty, discount: disc });
              if (p.track_stock) needs.set(num(p.id), C.q3((needs.get(num(p.id)) || 0) + C.q3(it.qty)));
            } else {
              if (!canCustom) fail(403, "You cannot add custom items.");
              const nm = clean(it.name).slice(0, 120); if (nm.length < 2) fail(400, "Custom items need a name.");
              lines.push({ p: null, name: nm, unitPrice: num(it.price), qty: it.qty, discount: disc });
            }
          }
          const saleDisc = num(b.discount || 0); if (saleDisc > 0 && !canDisc) fail(403, "You cannot give discounts.");
          let calc; try { calc = C.computeSale({ lines, saleDiscount: saleDisc, vatRate: num(ctx.business.vat_rate), vatInclusive: ctx.business.vat_inclusive }); } catch (e) { fail(400, e.message); }
          let pay; try { pay = C.settlePayments({ totalKobo: calc.totalKobo, payments: b.payments, hasCustomer: !!cust }); } catch (e) { fail(400, e.message); }
          // lock stock rows in product-id order, then check
          for (const pid of [...needs.keys()].sort((a, z) => a - z)) {
            await ensureStock(c, ctx.business.id, br.id, pid);
            const cur = (await c.query(`SELECT quantity FROM bm_stock WHERE product_id=$1 AND branch_id=$2 AND business_id=$3 FOR UPDATE`, [pid, br.id, ctx.business.id])).rows[0];
            if (num(cur.quantity) < needs.get(pid)) fail(409, `Not enough stock for ${prods.get(pid).name} (only ${num(cur.quantity)} left).`, { code: "insufficient_stock", productId: pid, available: num(cur.quantity) });
          }
          const rn = (await c.query(`INSERT INTO bm_counters(business_id,key,value) VALUES($1,'receipt',1) ON CONFLICT(business_id,key) DO UPDATE SET value=bm_counters.value+1 RETURNING value`, [ctx.business.id])).rows[0].value;
          const s = (await c.query(`INSERT INTO bm_sales(business_id,branch_id,receipt_no,customer_id,cashier_user_id,cashier_name,subtotal,discount,tax,total,paid,change_given,balance_due,vat_rate,vat_inclusive,note,idempotency_key)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
            [ctx.business.id, br.id, C.receiptNo(rn), cust ? cust.id : null, ctx.uid, ctx.user.name || ctx.user.email || null, calc.subtotal, calc.discount, calc.tax, calc.total, pay.paid, pay.change, pay.balanceDue,
              num(ctx.business.vat_rate), !!ctx.business.vat_inclusive, clean(b.note).slice(0, 200) || null, idem])).rows[0];
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i], cl = calc.lines[i];
            await c.query(`INSERT INTO bm_sale_items(business_id,sale_id,product_id,name,sku,unit,qty,unit_price,unit_cost,discount,line_total,tracked) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
              [ctx.business.id, s.id, l.p ? l.p.id : null, l.p ? l.p.name : l.name, l.p ? l.p.sku : null, l.p ? l.p.unit : "pcs", cl.qty, l.unitPrice, l.p ? l.p.cost_price : 0, L.fromKobo(cl.discount), L.fromKobo(cl.net), !!(l.p && l.p.track_stock)]);
          }
          for (const p of pay.payments) await c.query(`INSERT INTO bm_sale_payments(business_id,sale_id,method,amount) VALUES($1,$2,$3,$4)`, [ctx.business.id, s.id, p.method, p.amount]);
          for (const [pid, qty] of needs) await moveStock(c, ctx, { branchId: br.id, productId: pid, delta: -qty, type: "sale", refType: "sale", refId: s.id });
          if (pay.dueKobo > 0) {
            const nb = (await c.query(`UPDATE bm_customers SET balance=balance+$3,updated_at=NOW() WHERE id=$1 AND business_id=$2 RETURNING balance`, [cust.id, ctx.business.id, pay.balanceDue])).rows[0].balance;
            await c.query(`INSERT INTO bm_customer_ledger(business_id,customer_id,type,amount,balance_after,sale_id,user_id) VALUES($1,$2,'credit_sale',$3,$4,$5,$6)`, [ctx.business.id, cust.id, pay.balanceDue, nb, s.id, ctx.uid]);
          }
          await audit(c, req, ctx, "sale.create", "sale", s.id, null, { receipt: C.receiptNo(rn), total: calc.total, discount: calc.discount, items: lines.length, credit: pay.balanceDue || undefined });
          return loadSale(c, ctx.business.id, s.id);
        });
      } catch (e) {
        if (e.code === "23505" && e.constraint === "bm_sales_idem_uq") { const again = await exists(dbClient); if (again) return done(again, true); fail(409, "Duplicate request key. Please refresh and try again."); }
        throw e;
      }
      return done(sale, false);
    }

    if (M === "GET" && path === "/api/business/sales") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "sales.view", settings });
      let ids = accessible(ctx); if (q.get("branch_id")) { const br = await branchFor(ctx, dbClient, q.get("branch_id")); ids = [num(br.id)]; }
      const from = dateOk(q.get("from")) ? q.get("from") : null, to = dateOk(q.get("to")) ? q.get("to") : null;
      const limit = Math.min(100, Math.max(1, num(q.get("limit")) || 30)), offset = Math.max(0, num(q.get("offset")) || 0), search = likeSafe(q.get("search"));
      const status = ["completed", "void"].includes(q.get("status")) ? q.get("status") : null;
      const r = await db(`SELECT s.id,s.receipt_no,s.total,s.paid,s.balance_due,s.status,s.created_at,s.cashier_name,cu.name AS customer_name,br.name AS branch_name FROM bm_sales s
        LEFT JOIN bm_customers cu ON cu.id=s.customer_id JOIN bm_branches br ON br.id=s.branch_id
        WHERE s.business_id=$1 AND ($2::bigint[] IS NULL OR s.branch_id=ANY($2::bigint[])) AND ($3::text IS NULL OR s.cashier_user_id=$3)
        AND ($4::date IS NULL OR (s.created_at AT TIME ZONE 'Africa/Lagos')::date>=$4::date) AND ($5::date IS NULL OR (s.created_at AT TIME ZONE 'Africa/Lagos')::date<=$5::date)
        AND ($6::text IS NULL OR s.status=$6) AND ($7='' OR s.receipt_no ILIKE '%'||$7||'%' OR cu.name ILIKE '%'||$7||'%') ORDER BY s.id DESC LIMIT $8 OFFSET $9`,
        [ctx.business.id, ids, ctx.role === "cashier" ? ctx.uid : null, from, to, status, search, limit + 1, offset]);
      return out(res, { sales: r.rows.slice(0, limit).map(s => ({ id: num(s.id), receiptNo: s.receipt_no, total: num(s.total), paid: num(s.paid), balanceDue: num(s.balance_due), status: s.status, at: s.created_at, cashier: s.cashier_name, customer: s.customer_name, branch: s.branch_name })),
        hasMore: r.rows.length > limit, canVoid: L.hasPerm(ctx.role, "sales.void") });
    }

    if (M === "GET" && path === "/api/business/sales/detail") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "sales.view", settings });
      const sale = await loadSale(dbClient, ctx.business.id, posInt(q.get("id")));
      if (!sale || !L.canAccessBranch(ctx.member, sale.branchId)) fail(404, "Sale not found.");
      if (ctx.role === "cashier") { const own = (await db(`SELECT 1 FROM bm_sales WHERE id=$1 AND business_id=$2 AND cashier_user_id=$3`, [sale.id, ctx.business.id, ctx.uid])).rows[0]; if (!own) fail(404, "Sale not found."); }
      return out(res, { sale, receipt: receiptHeader(ctx.business), canVoid: L.hasPerm(ctx.role, "sales.void") });
    }

    if (M === "POST" && path === "/api/business/sales/void") {
      const rl = rateLimit(req, "bm-void:" + uid, 30, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
      const b = await body(req);
      const ctx = await getCtx(req, user, b.businessId, { perm: "sales.void", write: true, settings });
      const reason = clean(b.reason).slice(0, 200); if (reason.length < 3) fail(400, "Please give a reason for voiding this sale.");
      await withTx(async c => {
        const s = (await c.query(`SELECT * FROM bm_sales WHERE id=$1 AND business_id=$2 FOR UPDATE`, [posInt(b.saleId), ctx.business.id])).rows[0];
        if (!s || !L.canAccessBranch(ctx.member, s.branch_id)) fail(404, "Sale not found.");
        if (s.status !== "completed") fail(409, "This sale is already voided.");
        if (s.customer_id) await c.query(`SELECT 1 FROM bm_customers WHERE id=$1 AND business_id=$2 FOR UPDATE`, [s.customer_id, ctx.business.id]);
        const items = (await c.query(`SELECT product_id,qty FROM bm_sale_items WHERE sale_id=$1 AND business_id=$2 AND tracked`, [s.id, ctx.business.id])).rows;
        const back = new Map(); for (const i of items) back.set(num(i.product_id), C.q3((back.get(num(i.product_id)) || 0) + num(i.qty)));
        for (const pid of [...back.keys()].sort((a, z) => a - z)) { await ensureStock(c, ctx.business.id, s.branch_id, pid); await c.query(`SELECT 1 FROM bm_stock WHERE product_id=$1 AND branch_id=$2 AND business_id=$3 FOR UPDATE`, [pid, s.branch_id, ctx.business.id]); await moveStock(c, ctx, { branchId: s.branch_id, productId: pid, delta: back.get(pid), type: "void", refType: "sale", refId: s.id, note: reason }); }
        if (num(s.balance_due) > 0 && s.customer_id) {
          const nb = (await c.query(`UPDATE bm_customers SET balance=balance-$3,updated_at=NOW() WHERE id=$1 AND business_id=$2 RETURNING balance`, [s.customer_id, ctx.business.id, s.balance_due])).rows[0].balance;
          await c.query(`INSERT INTO bm_customer_ledger(business_id,customer_id,type,amount,balance_after,sale_id,note,user_id) VALUES($1,$2,'void_reversal',$3,$4,$5,$6,$7)`, [ctx.business.id, s.customer_id, -num(s.balance_due), nb, s.id, reason, ctx.uid]);
        }
        await c.query(`UPDATE bm_sales SET status='void',voided_at=NOW(),voided_by=$3,void_reason=$4 WHERE id=$1 AND business_id=$2`, [s.id, ctx.business.id, ctx.uid, reason]);
        await audit(c, req, ctx, "sale.void", "sale", s.id, { status: "completed", total: num(s.total) }, { status: "void", reason, receipt: s.receipt_no });
      });
      return out(res, { message: "Sale voided and stock returned." });
    }

    if (M === "GET" && path === "/api/business/sales/summary") {
      const ctx = await getCtx(req, user, q.get("business_id"), { perm: "sales.view", settings });
      let ids = accessible(ctx); if (q.get("branch_id")) { const br = await branchFor(ctx, dbClient, q.get("branch_id")); ids = [num(br.id)]; }
      const date = dateOk(q.get("date")) ? q.get("date") : null, mine = ctx.role === "cashier" ? ctx.uid : null;
      const args = [ctx.business.id, date, ids, mine];
      const day = `(s.created_at AT TIME ZONE 'Africa/Lagos')::date=COALESCE($2::date,(NOW() AT TIME ZONE 'Africa/Lagos')::date) AND ($3::bigint[] IS NULL OR s.branch_id=ANY($3::bigint[])) AND ($4::text IS NULL OR s.cashier_user_id=$4)`;
      const t = (await db(`SELECT COUNT(*) FILTER (WHERE s.status='completed')::int AS n, COALESCE(SUM(s.total) FILTER (WHERE s.status='completed'),0) AS total, COALESCE(SUM(s.discount) FILTER (WHERE s.status='completed'),0) AS discount,
        COALESCE(SUM(s.tax) FILTER (WHERE s.status='completed'),0) AS tax, COALESCE(SUM(s.balance_due) FILTER (WHERE s.status='completed'),0) AS credit, COUNT(*) FILTER (WHERE s.status='void')::int AS voided
        FROM bm_sales s WHERE s.business_id=$1 AND ${day}`, args)).rows[0];
      const m = (await db(`SELECT p.method, COALESCE(SUM(p.amount),0) AS amount FROM bm_sale_payments p JOIN bm_sales s ON s.id=p.sale_id AND s.business_id=p.business_id WHERE s.business_id=$1 AND s.status='completed' AND ${day} GROUP BY p.method`, args)).rows;
      return out(res, { count: t.n, total: num(t.total), discount: num(t.discount), tax: num(t.tax), credit: num(t.credit), voided: t.voided, byMethod: Object.fromEntries(m.map(x => [x.method, num(x.amount)])) });
    }

    return false;
  }
  return { handle, helpers: { branchFor, ensureStock, moveStock, accessible, likeSafe, addLot, canCost } };
};
