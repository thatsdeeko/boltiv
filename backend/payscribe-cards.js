"use strict";
/* BOLTIV USD virtual cards via Payscribe.
   Self-contained module. Wired into server.js with one require + one route hook.
   Money rule: the customer's NGN wallet is debited first (atomically, with a ledger row);
   it is refunded automatically if Payscribe definitively fails, and left "pending" (never
   refunded blind) if the outcome is unknown, until a webhook or an admin settles it. */
const crypto = require("node:crypto");

module.exports = function createCards(d) {
  const { db, pool, send, body, clean, userFromToken, verifyPassword, reference, addFinancialLedger,
    addNotification, insertVTUTransaction, getPlatformSetting, rateLimit, rateLimitedResponse,
    adminFromToken, requireAdminCsrf, backendUrl } = d;

  const BASE = (process.env.PAYSCRIBE_BASE_URL || "https://api.payscribe.ng/api/v1").replace(/\/+$/, "");
  const KEY = process.env.PAYSCRIBE_API_KEY || "";
  const HASH_KEY = process.env.PAYSCRIBE_MERCHANT_HASH_KEY || "";
  const WEBHOOK_SECRET = process.env.PAYSCRIBE_WEBHOOK_SECRET || KEY;

  /* ---------- settings (admin-changeable via platform settings, env/defaults otherwise) ---------- */
  async function cfg() {
    const g = async (k, f) => { try { const v = await getPlatformSetting(k, f); return v === null || v === undefined ? f : v; } catch { return f; } };
    const [enabled, margin, fee, min, max, cacheMin, colPct, colCap, expMin, autoConv, rateMode, rateManual] = await Promise.all([
      g("card_enabled", true), g("card_margin_ngn", 100), g("card_creation_fee_usd", 2),
      g("card_min_usd", 1), g("card_max_usd", 500), g("card_rate_cache_min", 60),
      g("card_collection_fee_pct", 0.65), g("card_collection_fee_cap", 250), g("card_pay_expiry_min", 30), g("card_auto_convert", false), g("card_rate_mode", "auto"), g("card_rate_manual", 0)]);
    return { enabled: enabled !== false && enabled !== "false", margin: Number(margin), feeUsd: Number(fee),
      minUsd: Number(min), maxUsd: Number(max), cacheMin: Math.max(1, Number(cacheMin)),
      collectionPct: Math.max(0, Number(colPct)), collectionCap: Math.max(0, Number(colCap)), expiryMin: Math.max(5, Number(expMin)),
      autoConvert: autoConv === true || autoConv === "true", rateMode: rateMode === "manual" ? "manual" : "auto", rateManual: Number(rateManual) > 0 ? Number(rateManual) : 0 };
  }

  /* ---------- tables ---------- */
  let tablesReady = null;
  function ensureTables() {
    if (!tablesReady) tablesReady = (async () => {
      await db(`CREATE TABLE IF NOT EXISTS card_profiles(user_id TEXT PRIMARY KEY, payscribe_customer_id TEXT NOT NULL, holder_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db(`CREATE TABLE IF NOT EXISTS user_cards(user_id TEXT PRIMARY KEY, payscribe_card_id TEXT UNIQUE NOT NULL, brand TEXT, first_six TEXT, last_four TEXT, masked TEXT, holder_name TEXT, status TEXT NOT NULL DEFAULT 'active', balance_usd NUMERIC(14,2) NOT NULL DEFAULT 0, design TEXT NOT NULL DEFAULT 'dark', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db(`CREATE TABLE IF NOT EXISTS card_orders(id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, reference TEXT UNIQUE NOT NULL, idempotency_key TEXT, usd_amount NUMERIC(14,2) NOT NULL, fee_usd NUMERIC(14,2) NOT NULL DEFAULT 0, rate_ngn NUMERIC(14,4) NOT NULL, margin_ngn NUMERIC(14,2) NOT NULL, ngn_charged NUMERIC(14,2) NOT NULL, brand TEXT, status TEXT NOT NULL DEFAULT 'processing', payscribe_trans_id TEXT, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db(`CREATE UNIQUE INDEX IF NOT EXISTS card_orders_idem ON card_orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
      for (const col of ["collection_fee_ngn NUMERIC(14,2) NOT NULL DEFAULT 0", "design TEXT", "account_id TEXT", "account_number TEXT", "account_name TEXT", "bank_name TEXT",
        "expires_at TIMESTAMPTZ", "paid_ngn NUMERIC(14,2)", "paid_fee_ngn NUMERIC(14,2)", "conversion_status TEXT", "conversion_note TEXT"])
        await db(`ALTER TABLE card_orders ADD COLUMN IF NOT EXISTS ${col}`);
      await db(`DROP INDEX IF EXISTS card_orders_one_card`);
      await db(`DROP INDEX IF EXISTS card_orders_one_card2`);
      await db(`CREATE UNIQUE INDEX IF NOT EXISTS card_orders_one_card3 ON card_orders(user_id) WHERE kind='create' AND status IN ('awaiting_payment','paid','processing','pending','needs_review','needs_funding','success')`);
      await db(`CREATE INDEX IF NOT EXISTS card_orders_acct ON card_orders(account_id)`);
      await db(`CREATE TABLE IF NOT EXISTS card_webhook_events(event_id TEXT PRIMARY KEY, event_type TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db(`CREATE TABLE IF NOT EXISTS card_uploads(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mime TEXT NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    })().catch(e => { tablesReady = null; throw e; });
    return tablesReady;
  }

  /* ---------- Payscribe HTTP ---------- */
  // outcome: "success" | "failed" (definitive) | "unknown" (timeout / 5xx / 201 pending: never auto-refund)
  async function ps(method, path, payload) {
    if (!KEY) return { outcome: "failed", message: "Card service is not configured yet.", data: {} };
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(BASE + path, { method, signal: ctl.signal,
        headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json", Accept: "application/json" },
        body: payload ? JSON.stringify(payload) : undefined });
      let j = {}; try { j = await r.json(); } catch { }
      const code = Number(j.status_code || r.status);
      const message = clean(j.description || j.message?.description || (typeof j.message === "string" ? j.message : "")).replace(/payscribe/gi, "our card service");
      if (j.status === true && code === 200) return { outcome: "success", message, data: j };
      if (code === 201 || code >= 500 || r.status >= 500) return { outcome: "unknown", message, data: j };
      return { outcome: "failed", message: message || "Request was not accepted.", code, data: j };
    } catch (e) {
      return { outcome: "unknown", message: "No response from card provider.", data: {} };
    } finally { clearTimeout(t); }
  }

  /* ---------- live rate (cached: Payscribe gives only 20 free rate calls per day) ---------- */
  let rateCache = { v: 0, t: 0 }, lastRateError = null;
  let rateInfo = null;
  async function liveRate(c) {
    if (c.rateMode === "manual" && c.rateManual > 0) { rateInfo = { source: "manual", base: c.rateManual, at: Date.now() }; return c.rateManual; }
    if (rateCache.v && Date.now() - rateCache.t < c.cacheMin * 60000) return rateCache.v;
    const r = await ps("GET", "/fx/rate?from=USD&to=NGN");
    const rate = Number(r.data?.message?.details?.rate);
    if (r.outcome === "success" && rate > 0) { rateCache = { v: rate, t: Date.now() }; lastRateError = null; const dd = r.data?.message?.details || {}; rateInfo = { source: "payscribe", base: rate, mid: Number(dd.rate_mid) || null, spreadBps: Number(dd.spread_bps) || null, at: Date.now() }; return rate; }
    lastRateError = !KEY ? "PAYSCRIBE_API_KEY is not set on the server." : (r.outcome === "success" ? "Rate response had no usable rate." : `${r.code ? "HTTP/API " + r.code + ": " : ""}${r.message || r.outcome}`);
    console.error("CARD RATE ERROR:", lastRateError, "| base:", BASE);
    if (rateCache.v && Date.now() - rateCache.t < 3 * 3600000) return rateCache.v; // stale but recent
    return 0; // fail closed: never sell dollars at an unknown price
  }
  function price(usd, feeUsd, rate, margin, c) {
    const usdTotal = Number((usd + feeUsd).toFixed(2));
    const unit = Number((rate + margin).toFixed(2));
    const subtotal = Math.ceil(usdTotal * unit);
    const pct = (c?.collectionPct || 0) / 100;
    const col = pct > 0 && pct < 1 ? Math.min(Math.ceil(subtotal * pct / (1 - pct)), c.collectionCap || 0) : 0;
    return { usd, feeUsd, usdTotal, ratePerUsd: unit, subtotalNgn: subtotal, collectionFeeNgn: col, ngnTotal: subtotal + col };
  }

  let balCache = { v: null, t: 0 };
  async function usdBalance() {
    if (Date.now() - balCache.t < Number(process.env.PAYSCRIBE_BALANCE_CACHE_MS || 45000)) return balCache.v;
    const r = await ps("GET", "/my-account/balances"); let v = null;
    const list = r.data?.message?.details;
    if (r.outcome === "success" && Array.isArray(list)) { const x = list.find(y => String(y.currency || "").toUpperCase() === "USD"); if (x && Number.isFinite(Number(x.available_balance))) v = Number(x.available_balance); }
    balCache = { v, t: Date.now() }; return v;
  }

  /* ---------- helpers ---------- */
  const brandOk = b => ["VISA", "MASTERCARD"].includes(b);
  const designOk = x => ["dark", "light"].includes(x);
  const num2 = n => Number(Number(n).toFixed(2));
  async function checkPin(userId, pin) {
    const s = await db(`SELECT transaction_pin_hash FROM user_security WHERE user_id=$1 LIMIT 1`, [userId]);
    const h = s.rows[0]?.transaction_pin_hash;
    if (!h) return "Please set your Transaction PIN first.";
    if (!/^\d{4}$/.test(String(pin || "")) || !verifyPassword(String(pin), h)) return "Incorrect Transaction PIN.";
    return "";
  }
  async function getProfile(uid) { return (await db(`SELECT * FROM card_profiles WHERE user_id=$1`, [uid])).rows[0] || null; }
  async function getCard(uid) { return (await db(`SELECT * FROM user_cards WHERE user_id=$1`, [uid])).rows[0] || null; }
  function cardView(c) {
    return c && { brand: c.brand, last_four: c.last_four, first_six: c.first_six, masked: c.masked, holder_name: c.holder_name,
      status: c.status, balance_usd: Number(c.balance_usd), design: c.design };
  }
  function decrypt(sd) {
    const key = Buffer.from(HASH_KEY, "hex");
    const dc = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sd.iv, "base64"));
    dc.setAuthTag(Buffer.from(sd.tag, "base64")); dc.setAAD(Buffer.from(sd.aad, "utf8"));
    const out = Buffer.concat([dc.update(Buffer.from(sd.data, "base64")), dc.final()]);
    return JSON.parse(out.toString("utf8"));
  }

  /* ---------- order settlement (idempotent) ---------- */
  const NGN = n => `₦${Number(n).toLocaleString("en-NG")}`;
  function orderView(o) {
    return o ? { reference: o.reference, kind: o.kind, status: o.status, usd: Number(o.usd_amount), feeUsd: Number(o.fee_usd), collectionFeeNgn: Number(o.collection_fee_ngn || 0),
      ngnTotal: Number(o.ngn_charged), bank: o.bank_name, accountNumber: o.account_number, accountName: o.account_name, expiresAt: o.expires_at, error: o.error || null } : null;
  }
  async function expireStale(uid) { await db(`UPDATE card_orders SET status='expired', updated_at=NOW() WHERE user_id=$1 AND status='awaiting_payment' AND expires_at<NOW()`, [uid]); }
  // Refund goes to the customer's BOLTIV wallet (the money was received by transfer, so there is no card-side debit to reverse)
  async function refundOrder(ref, why) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const o = (await client.query(`UPDATE card_orders SET status='failed', error=$2, updated_at=NOW() WHERE reference=$1 AND status IN ('processing','pending','needs_review','needs_funding') RETURNING *`, [ref, clean(why).slice(0, 300)])).rows[0];
      if (!o) { await client.query("COMMIT"); return false; }
      const amt = Number(o.paid_ngn ?? o.ngn_charged);
      const w = await client.query(`INSERT INTO wallets(user_id,balance) VALUES($2,$1) ON CONFLICT(user_id) DO UPDATE SET balance=wallets.balance+$1, updated_at=NOW() RETURNING balance`, [amt, o.user_id]);
      if (!w.rows.length) throw new Error("Wallet could not be credited for card refund.");
      await addFinancialLedger(client, { accountType: "customer_wallet", ownerId: o.user_id, direction: "credit", amount: amt, balanceAfter: Number(w.rows[0].balance), reference: `WALLET-REFUND-${ref}`, category: "card_refund", description: `Refund for card ${o.kind}`, metadata: { reason: why } });
      await client.query("COMMIT");
      addNotification(o.user_id, "Card payment refunded", `We could not complete your card ${o.kind === "create" ? "creation" : "funding"}. ${NGN(amt)} was returned to your BOLTIV wallet.`, "transaction").catch(() => { });
      return true;
    } catch (e) { try { await client.query("ROLLBACK"); } catch { } throw e; } finally { client.release(); }
  }
  async function settleSuccess(ref, info = {}) {
    const o = (await db(`UPDATE card_orders SET status='success', payscribe_trans_id=COALESCE($2,payscribe_trans_id), updated_at=NOW() WHERE reference=$1 AND status IN ('processing','pending','paid') RETURNING *`, [ref, info.transId || null])).rows[0];
    if (!o) return null;
    await insertVTUTransaction({ userId: o.user_id, type: "debit", service: "card", amount: Number(o.ngn_charged), reference: o.reference, status: "successful", recipient: "BOLTIV USD Card", providerReference: info.transId || null,
      metadata: { provider: "payscribe", payment_method: "bank_transfer", kind: o.kind, usd_amount: Number(o.usd_amount), fee_usd: Number(o.fee_usd), collection_fee_ngn: Number(o.collection_fee_ngn || 0), rate_ngn: Number(o.rate_ngn), margin_ngn: Number(o.margin_ngn) } }).catch(e => console.error("CARD HISTORY ROW ERROR:", e.message));
    addNotification(o.user_id, o.kind === "create" ? "Your BOLTIV card is ready" : "Card funded", o.kind === "create" ? `Your USD virtual card is ready with $${Number(o.usd_amount).toFixed(2)}.` : `$${Number(o.usd_amount).toFixed(2)} was added to your card.`, "transaction").catch(() => { });
    return o;
  }

  /* ---------- create / top up: step 1, a one-time transfer account for the exact amount ---------- */
  async function runOrder(user, kind, b) {
    const uid = clean(user.user_id);
    const c = await cfg();
    if (!c.enabled) return { code: 503, message: "BOLTIV cards are temporarily unavailable." };
    const usd = num2(b.usd);
    if (!(usd >= c.minUsd && usd <= c.maxUsd)) return { code: 400, message: `Enter an amount between $${c.minUsd} and $${c.maxUsd}.` };
    const profile = await getProfile(uid); const card = await getCard(uid);
    const brand = clean(b.brand).toUpperCase();
    if (kind === "create") {
      if (!profile) return { code: 400, message: "Please complete card verification first." };
      if (card) return { code: 409, message: "You already have a BOLTIV card." };
      if (!brandOk(brand)) return { code: 400, message: "Choose Visa or Mastercard." };
    } else if (!card || card.status === "terminated") return { code: 400, message: "You do not have an active card." };
    await expireStale(uid);
    const open = (await db(`SELECT * FROM card_orders WHERE user_id=$1 AND status='awaiting_payment' ORDER BY id DESC LIMIT 1`, [uid])).rows[0];
    if (open) return { code: 200, status: "awaiting_payment", order: orderView(open), message: "You already have a payment waiting." };
    const busy = (await db(`SELECT 1 FROM card_orders WHERE user_id=$1 AND status IN ('paid','processing','pending','needs_review','needs_funding') LIMIT 1`, [uid])).rows[0];
    if (busy) return { code: 409, message: "Your previous card request is still being processed." };
    const idem = clean(b.idempotencyKey).slice(0, 80) || null;
    if (idem) {
      const ex = (await db(`SELECT * FROM card_orders WHERE user_id=$1 AND idempotency_key=$2`, [uid, idem])).rows[0];
      if (ex) return { code: 200, status: ex.status, order: orderView(ex), existing: true };
    }
    const pinErr = await checkPin(uid, b.transactionPin);
    if (pinErr) return { code: 400, message: pinErr };
    const rate = await liveRate(c);
    if (!rate) return { code: 503, message: "Card pricing is unavailable right now. Please try again shortly." };
    const p = price(usd, kind === "create" ? c.feeUsd : 0, rate, c.margin, c);
    if (!c.autoConvert) {
      const have = await usdBalance();
      if (have !== null && have < p.usdTotal) { console.error("CARD SALES PAUSED: USD wallet too low", have, "needed", p.usdTotal); return { code: 503, message: "The card service is temporarily unavailable. Please try again later." }; }
    }
    const ref = reference("BOLTIV-CARD");
    try {
      await db(`INSERT INTO card_orders(user_id,kind,reference,idempotency_key,usd_amount,fee_usd,rate_ngn,margin_ngn,ngn_charged,collection_fee_ngn,brand,design,status,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'awaiting_payment',NOW()+make_interval(mins=>$13))`,
        [uid, kind, ref, idem, usd, p.feeUsd, rate, c.margin, p.ngnTotal, p.collectionFeeNgn, kind === "create" ? brand : null, designOk(b.design) ? b.design : "dark", c.expiryMin]);
    } catch (e) { if (e.code === "23505") return { code: 409, message: "A card request is already in progress." }; throw e; }
    const r = await ps("POST", "/collections/virtual-accounts/create", { account_type: "dynamic", ref, currency: "NGN",
      order: { amount: p.ngnTotal, amount_type: "EXACT", description: `BOLTIV card ${kind === "create" ? "creation" : "funding"} ${ref}`, expiry: { duration: c.expiryMin, duration_type: "minutes" } },
      customer: { name: clean(user.name) || clean(profile?.holder_name) || "BOLTIV Customer", email: clean(user.email), phone: clean(user.phone) } });
    const acct = r.data?.message?.details?.account?.[0];
    if (r.outcome !== "success" || !acct?.account_number) {
      await db(`UPDATE card_orders SET status='failed', error=$2, updated_at=NOW() WHERE reference=$1`, [ref, clean(r.message || "Payment account could not be created.").slice(0, 300)]);
      return { code: r.outcome === "unknown" ? 503 : 400, message: "We could not set up your payment details. Please try again." };
    }
    const row = (await db(`UPDATE card_orders SET account_id=$2, account_number=$3, account_name=$4, bank_name=$5, updated_at=NOW() WHERE reference=$1 RETURNING *`,
      [ref, clean(acct.id), clean(acct.account_number), clean(acct.account_name), clean(acct.bank_name)])).rows[0];
    return { code: 200, status: "awaiting_payment", order: orderView(row) };
  }

  /* ---------- step 2: payment arrived (webhook) -> optional NGN->USD conversion -> create / top up the card ---------- */
  async function convert(netNgn) {
    if (!(netNgn >= 1)) return { status: "skipped", note: "nothing to convert" };
    const q = await ps("POST", "/currency-pair", { from: "NGN", to: "USD", amount: netNgn });
    const d = q.data?.message?.details;
    if (q.outcome !== "success" || !d?.quote_id || !d?.sig) return { status: "failed", note: q.message || "quote failed" };
    const e = await ps("POST", "/execute-quote", { quote_id: d.quote_id, sig: d.sig });
    return e.outcome === "success" ? { status: "done", note: `$${Number(d.amount_to).toFixed(2)} for ${NGN(netNgn)}` } : { status: "failed", note: e.message || "conversion failed" };
  }
  async function onPayment(p) {
    const acctId = clean(p.customer?.account_id), num = clean(p.customer?.number);
    if (!acctId && !num) return null;
    const o = (await db(`SELECT * FROM card_orders WHERE status IN ('awaiting_payment','expired') AND ((account_id IS NOT NULL AND account_id=$1) OR (account_number IS NOT NULL AND account_number=$2)) ORDER BY id DESC LIMIT 1`, [acctId || "-", num || "-"])).rows[0];
    if (!o) { console.error("CARD PAYMENT WEBHOOK: no matching open order", JSON.stringify({ account_id: acctId, number: num, amount: p.amount })); return null; }
    const amount = Number(p.amount), fee = Number(p.fee || 0), tid = clean(p.trans_id || p.event_id) || null;
    if (clean(p.currency || "NGN").toUpperCase() !== "NGN") return null;
    if (!(amount + 0.01 >= Number(o.ngn_charged))) {
      await db(`UPDATE card_orders SET status='needs_review', paid_ngn=$2, paid_fee_ngn=$3, error=$4, updated_at=NOW() WHERE id=$1 AND status IN ('awaiting_payment','expired')`, [o.id, amount, fee, `Received ${NGN(amount)} but ${NGN(o.ngn_charged)} was required`]);
      addNotification(o.user_id, "Payment needs review", `We received ${NGN(amount)} for your card request, which is less than ${NGN(o.ngn_charged)}. Our team will contact you or refund it to your wallet.`, "transaction").catch(() => { });
      return null;
    }
    return await claimPaid(o, amount, fee, tid);
  }
  async function claimPaid(o, amount, fee, tid) {
    return (await db(`UPDATE card_orders SET status='processing', paid_ngn=$2, paid_fee_ngn=$3, payscribe_trans_id=COALESCE($4,payscribe_trans_id), updated_at=NOW() WHERE id=$1 AND status IN ('awaiting_payment','expired') RETURNING *`, [o.id, amount, fee, tid])).rows[0] || null;
  }
  async function fulfillOrder(o) {
    const ref = o.reference, uid = o.user_id;
    try {
      const c = await cfg();
      if (c.autoConvert && !o.conversion_status) {
        const conv = await convert(Math.floor(Number(o.paid_ngn) - Number(o.paid_fee_ngn || 0)));
        await db(`UPDATE card_orders SET conversion_status=$2, conversion_note=$3 WHERE reference=$1`, [ref, conv.status, clean(conv.note).slice(0, 200)]);
      }
      const profile = await getProfile(uid), card = await getCard(uid), usd = Number(o.usd_amount);
      let r;
      if (o.kind === "create") {
        if (!profile) throw new Error("No verified card profile for this customer");
        r = await ps("POST", "/cards/create", { customer_id: profile.payscribe_customer_id, currency: "USD", brand: o.brand, amount: usd, type: "virtual", ref });
      } else {
        if (!card) throw new Error("No card found for this top-up");
        r = await ps("PATCH", `/cards/${card.payscribe_card_id}/topup`, { amount: usd, ref });
      }
      if (r.outcome === "failed" && r.code === 405) { await db(`UPDATE card_orders SET status='pending', error='Duplicate reference at provider: check the provider dashboard before refunding', updated_at=NOW() WHERE reference=$1 AND status='processing'`, [ref]); return; }
      if (r.outcome === "failed" && (r.code === 410 || /insufficient|can not be less than|not enough/i.test(r.message || ""))) {
        await db(`UPDATE card_orders SET status='needs_funding', error='Waiting for USD funds in the card wallet', updated_at=NOW() WHERE reference=$1 AND status='processing'`, [ref]);
        addNotification(uid, "Your card is being finalised", "We received your payment and are finalising your card. You will be notified as soon as it is ready.", "transaction").catch(() => { });
        console.error("CARD NEEDS USD FUNDING:", ref);
        return;
      }
      if (r.outcome === "failed") { await refundOrder(ref, r.message); return; }
      if (r.outcome === "unknown") { await db(`UPDATE card_orders SET status='pending', error=$2, updated_at=NOW() WHERE reference=$1 AND status='processing'`, [ref, clean(r.message).slice(0, 200)]); return; }
      const det = r.data?.message?.details || {};
      if (o.kind === "create") {
        const k = det.card || {};
        if (!k.id) { await db(`UPDATE card_orders SET status='pending', error='Provider returned no card id', payscribe_trans_id=$2, updated_at=NOW() WHERE reference=$1`, [ref, det.trans_id || null]); return; }
        await db(`INSERT INTO user_cards(user_id,payscribe_card_id,brand,first_six,last_four,masked,holder_name,status,balance_usd,design) VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9) ON CONFLICT(user_id) DO NOTHING`,
          [uid, k.id, clean(k.brand) || o.brand, clean(k.first_six), clean(k.last_four), clean(k.masked), clean(k.name) || profile.holder_name, usd, designOk(o.design) ? o.design : "dark"]);
      } else {
        const nb = Number(det.balance ?? det.card?.balance);
        await db(`UPDATE user_cards SET balance_usd=${Number.isFinite(nb) ? "$2" : "balance_usd+$2"}, updated_at=NOW() WHERE user_id=$1`, [uid, Number.isFinite(nb) ? nb : usd]);
      }
      await settleSuccess(ref, { transId: det.trans_id });
    } catch (e) {
      console.error("CARD FULFILL ERROR:", ref, e.message);
      await db(`UPDATE card_orders SET status='pending', error=$2, updated_at=NOW() WHERE reference=$1 AND status='processing'`, [ref, clean(e.message).slice(0, 200)]).catch(() => { });
    }
  }

  /* ---------- KYC image hosting (Payscribe needs public image URLs; deleted right after use) ---------- */
  async function saveUpload(uid, dataUrl) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
    if (!m) return null;
    const buf = Buffer.from(m[2], "base64");
    if (buf.length < 2000 || buf.length > 700 * 1024) return null;
    const id = crypto.randomBytes(24).toString("hex");
    await db(`INSERT INTO card_uploads(id,user_id,mime,data) VALUES($1,$2,$3,$4)`, [id, uid, m[1], buf]);
    return id;
  }
  const uploadUrl = id => `${backendUrl}/api/cards/file/${id}`;

  /* ---------- webhook ---------- */
  function readRaw(req) {
    return new Promise((resolve, reject) => { let s = ""; req.on("data", x => { s += x; if (s.length > 1024 * 1024) { req.destroy(); reject(new Error("too large")); } }); req.on("end", () => resolve(s)); req.on("error", reject); });
  }
  function sigOk(req, raw) {
    if (!WEBHOOK_SECRET) return false;
    const header = String(req.headers["x-payscribe-signature"] || "");
    const eid = String(req.headers["x-payscribe-event-id"] || ""), ts = String(req.headers["x-payscribe-timestamp"] || "");
    const safe = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
    if (header.startsWith("v1=") && eid && ts) {
      if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
      return safe(header.slice(3), crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${eid}.${raw}`).digest("hex"));
    }
    return safe(header, crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex")); // older card-page format
  }
  async function onEvent(type, p) {
    const k = p.card || p.data?.card || {};
    const cardId = clean(k.id || p.card_id);
    const custId = clean(p.customer?.id || p.customer_id);
    if (type === "cards.created") {
      const prof = custId ? (await db(`SELECT * FROM card_profiles WHERE payscribe_customer_id=$1`, [custId])).rows[0] : null;
      if (!prof || !k.id) return;
      await db(`INSERT INTO user_cards(user_id,payscribe_card_id,brand,first_six,last_four,masked,holder_name,status,balance_usd) VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8) ON CONFLICT DO NOTHING`, [prof.user_id, k.id, clean(k.brand), clean(k.first_six), clean(k.last_four), clean(k.masked), clean(k.name) || prof.holder_name, Number(k.balance || 0)]);
      const o = (await db(`SELECT reference FROM card_orders WHERE user_id=$1 AND kind='create' AND status IN ('processing','pending') ORDER BY id DESC LIMIT 1`, [prof.user_id])).rows[0];
      if (o) await settleSuccess(o.reference, { transId: p.trans_id });
      return;
    }
    if (!cardId) return;
    const row = (await db(`SELECT * FROM user_cards WHERE payscribe_card_id=$1`, [cardId])).rows[0];
    if (!row) return;
    if (type === "card.status.changed") {
      const s = clean(p.new_status).toLowerCase(); if (s) await db(`UPDATE user_cards SET status=$2, updated_at=NOW() WHERE payscribe_card_id=$1`, [cardId, s]);
      return;
    }
    const bal = Number(k.balance);
    if (Number.isFinite(bal)) await db(`UPDATE user_cards SET balance_usd=$2, updated_at=NOW() WHERE payscribe_card_id=$1`, [cardId, bal]);
    if (type === "cards.topup") {
      const o = (await db(`SELECT reference FROM card_orders WHERE user_id=$1 AND kind='topup' AND status='pending' ORDER BY id ASC LIMIT 1`, [row.user_id])).rows[0];
      if (o) await settleSuccess(o.reference, { transId: p.trans_id });
    }
  }

  /* ---------- router ---------- */
  async function handle(req, res, path) {
    const M = req.method;
    if (!(path.startsWith("/api/cards") || path === "/api/payscribe/webhook" || path.startsWith("/api/admin/cards"))) return false;
    await ensureTables();

    if (M === "POST" && path === "/api/payscribe/webhook") {
      const raw = await readRaw(req);
      if (!sigOk(req, raw)) { console.error("CARD WEBHOOK REJECTED: invalid signature", JSON.stringify({ hasSignature: !!req.headers["x-payscribe-signature"], hasTimestamp: !!req.headers["x-payscribe-timestamp"], hasEventId: !!req.headers["x-payscribe-event-id"], secretIsApiKey: !process.env.PAYSCRIBE_WEBHOOK_SECRET })); return send(res, 401, { success: false, message: "Invalid signature." }), true; }
      let p; try { p = JSON.parse(raw || "{}"); } catch { return send(res, 400, { success: false }), true; }
      const type = clean(req.headers["x-payscribe-event"] || p.event_type || p.event);
      const eid = clean(req.headers["x-payscribe-event-id"] || p.event_id) || null;
      if (eid) { const ins = await db(`INSERT INTO card_webhook_events(event_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id`, [eid, type]); if (!ins.rows.length) return send(res, 200, { success: true, duplicate: true }), true; }
      let claimed = null;
      try { if (/^cards?\./.test(type)) await onEvent(type, p); else if (type === "accounts.payment.status") claimed = await onPayment(p); }
      catch (e) { console.error("CARD WEBHOOK ERROR:", e.message); if (eid) await db(`DELETE FROM card_webhook_events WHERE event_id=$1`, [eid]).catch(() => { }); return send(res, 500, { success: false }), true; }
      send(res, 200, { success: true });
      if (claimed) fulfillOrder(claimed).catch(e => console.error("CARD FULFILL ERROR:", e.message));
      return true;
    }

    // public, unguessable image URL (Payscribe fetches it during verification)
    const fm = /^\/api\/cards\/file\/([a-f0-9]{48})$/.exec(path);
    if (M === "GET" && fm) {
      const f = (await db(`SELECT mime,data FROM card_uploads WHERE id=$1`, [fm[1]])).rows[0];
      if (!f) return send(res, 404, { success: false }), true;
      res.writeHead(200, { "Content-Type": f.mime, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(f.data); return true;
    }

    if (path.startsWith("/api/admin/cards")) {
      if (M === "GET" && path === "/api/admin/cards/overview") {
        const a = await adminFromToken(req); if (!a) return send(res, 401, { success: false, message: "Unauthorized." }), true;
        const c = await cfg(); await liveRate(c);
        const [cards, open, today, orders, bal] = await Promise.all([
          db(`SELECT COUNT(*)::int AS n FROM user_cards`),
          db(`SELECT COUNT(*)::int AS n FROM card_orders WHERE status IN ('pending','processing','needs_review','needs_funding')`),
          db(`SELECT COUNT(*)::int AS n, COALESCE(SUM(ngn_charged),0) AS ngn FROM card_orders WHERE status='success' AND created_at>=date_trunc('day',NOW())`),
          db(`SELECT o.reference,o.user_id,u.email,o.kind,o.usd_amount,o.fee_usd,o.ngn_charged,o.paid_ngn,o.account_number,o.bank_name,o.status,o.error,o.conversion_status,o.conversion_note,o.created_at FROM card_orders o LEFT JOIN users u ON u.user_id=o.user_id ORDER BY o.id DESC LIMIT 60`),
          ps("GET", "/my-account/balances")]);
        let usd = null;
        const list = bal.data?.message?.details;
        if (Array.isArray(list)) { const r = list.find(x => String(x.currency || "").toUpperCase() === "USD"); if (r) usd = Number(r.available_balance); }
        return send(res, 200, { success: true, settings: c, rate: rateInfo ? { ...rateInfo, ageMin: Math.round((Date.now() - rateInfo.at) / 60000), customerRate: Number((rateInfo.base + c.margin).toFixed(2)) } : null, configured: !!KEY, rateError: lastRateError, baseUrl: BASE, hashKeySet: /^[0-9a-f]{64}$/i.test(HASH_KEY), usdBalance: Number.isFinite(usd) ? usd : null,
          cards: cards.rows[0].n, open: open.rows[0].n, todayOrders: today.rows[0].n, todayNgn: Number(today.rows[0].ngn), orders: orders.rows }), true;
      }
      if (M === "POST" && path === "/api/admin/cards/settings") {
        const chk = await requireAdminCsrf(req); if (!chk.success) return send(res, chk.statusCode || 403, chk), true;
        const b = await body(req);
        const v = { card_enabled: b.enabled !== false && b.enabled !== "false", card_margin_ngn: Number(b.margin), card_creation_fee_usd: Number(b.feeUsd),
          card_min_usd: Number(b.minUsd), card_max_usd: Number(b.maxUsd), card_rate_cache_min: Number(b.cacheMin),
          card_collection_fee_pct: Number(b.collectionPct), card_collection_fee_cap: Number(b.collectionCap), card_pay_expiry_min: Number(b.expiryMin),
          card_auto_convert: b.autoConvert === true || b.autoConvert === "true", card_rate_mode: b.rateMode === "manual" ? "manual" : "auto", card_rate_manual: Number(b.rateManual) || 0 };
        const nums = ["card_margin_ngn", "card_creation_fee_usd", "card_min_usd", "card_max_usd", "card_rate_cache_min", "card_collection_fee_pct", "card_collection_fee_cap", "card_pay_expiry_min"];
        if (nums.some(k => !Number.isFinite(v[k]) || v[k] < 0) || v.card_min_usd < 1 || v.card_max_usd < v.card_min_usd || v.card_rate_cache_min < 1 || v.card_margin_ngn > 5000 || v.card_creation_fee_usd > 50 || v.card_collection_fee_pct > 5 || v.card_pay_expiry_min < 5 || v.card_pay_expiry_min > 240)
          return send(res, 400, { success: false, message: "Check the values: min $1 or more, max not below min, cache 1+ minute, expiry 5-240 minutes, collection fee under 5%." }), true;
        if (v.card_rate_mode === "manual" && !(v.card_rate_manual >= 100 && v.card_rate_manual <= 100000)) return send(res, 400, { success: false, message: "Enter the manual rate in naira per $1 (for example 1520)." }), true;
        for (const [k, val] of Object.entries(v)) await db(`INSERT INTO platform_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [k, JSON.stringify(val)]);
        rateCache = { v: 0, t: 0 }; rateInfo = null;
        return send(res, 200, { success: true, settings: await cfg() }), true;
      }
      if (M === "POST" && path === "/api/admin/cards/confirm") {
        const chk = await requireAdminCsrf(req); if (!chk.success) return send(res, chk.statusCode || 403, chk), true;
        const b = await body(req);
        const o = (await db(`SELECT * FROM card_orders WHERE reference=$1 AND status IN ('awaiting_payment','expired')`, [clean(b.reference)])).rows[0];
        if (!o) return send(res, 404, { success: false, message: "No awaiting order with that reference." }), true;
        let amount = Number(o.ngn_charged), fee = Number(o.collection_fee_ngn || 0), tid = null;
        const sid = clean(b.sessionId);
        if (sid) {
          const r = await ps("POST", "/collections/virtual-accounts/confirm-payment", { trans_id: "", session_id: sid, amount: Number(o.ngn_charged), account_number: o.account_number });
          const d = r.data?.message?.details;
          if (r.outcome !== "success" || !d) return send(res, 400, { success: false, message: "The payment could not be confirmed: " + (r.message || "no response") }), true;
          if (d.account?.number && clean(d.account.number) !== clean(o.account_number)) return send(res, 400, { success: false, message: "That payment belongs to a different account number." }), true;
          amount = Number(d.amount ?? d.transaction?.amount ?? amount); fee = Number(d.fee || 0); tid = clean(d.trans_id) || null;
          if (!(amount + 0.01 >= Number(o.ngn_charged))) return send(res, 400, { success: false, message: `Confirmed amount ${NGN(amount)} is less than the ${NGN(o.ngn_charged)} required.` }), true;
        } else if (b.attest !== true) return send(res, 400, { success: false, message: "Enter the bank session ID, or confirm you checked the payment in the Payscribe dashboard." }), true;
        const claimed = await claimPaid(o, amount, fee, tid);
        if (!claimed) return send(res, 409, { success: false, message: "This order was already processed." }), true;
        send(res, 200, { success: true, message: "Payment confirmed. The card is being set up now." });
        fulfillOrder(claimed).catch(e => console.error("CARD FULFILL ERROR:", e.message));
        return true;
      }
      if (M === "POST" && path === "/api/admin/cards/retry") {
        const chk = await requireAdminCsrf(req); if (!chk.success) return send(res, chk.statusCode || 403, chk), true;
        const b = await body(req); const ref = clean(b.reference);
        let o = (await db(`UPDATE card_orders SET status='processing', error=NULL, updated_at=NOW() WHERE reference=$1 AND status='needs_funding' RETURNING *`, [ref])).rows[0];
        if (!o && b.reverseRefund === true) {
          // the customer was already refunded to their wallet: take that refund back (only if it is still there), then retry
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const x = (await client.query(`SELECT * FROM card_orders WHERE reference=$1 AND status='failed' AND paid_ngn IS NOT NULL FOR UPDATE`, [ref])).rows[0];
            if (!x) { await client.query("ROLLBACK"); return send(res, 404, { success: false, message: "No refunded order with that reference." }), true; }
            const amt = Number(x.paid_ngn);
            const w = await client.query(`UPDATE wallets SET balance=balance-$1, updated_at=NOW() WHERE user_id=$2 AND balance>=$1 RETURNING balance`, [amt, x.user_id]);
            if (!w.rows.length) { await client.query("ROLLBACK"); return send(res, 409, { success: false, message: "The customer's wallet no longer holds the refunded amount, so it cannot be taken back automatically." }), true; }
            await addFinancialLedger(client, { accountType: "customer_wallet", ownerId: x.user_id, direction: "debit", amount: -amt, balanceAfter: Number(w.rows[0].balance), reference: `WALLET-REFUND-REVERSAL-${ref}`, category: "card_refund_reversal", description: "Card request retried by admin", metadata: {} });
            o = (await client.query(`UPDATE card_orders SET status='processing', error=NULL, updated_at=NOW() WHERE id=$1 RETURNING *`, [x.id])).rows[0];
            await client.query("COMMIT");
          } catch (e) {
            try { await client.query("ROLLBACK"); } catch { }
            if (e.code === "23505") return send(res, 409, { success: false, message: "This customer already has another open card request." }), true;
            throw e;
          } finally { client.release(); }
        }
        if (!o) return send(res, 404, { success: false, message: "Nothing to retry for that order." }), true;
        send(res, 200, { success: true, message: "Retrying now. The card is being set up." });
        fulfillOrder(o).catch(e => console.error("CARD FULFILL ERROR:", e.message));
        return true;
      }
      if (M === "POST" && path === "/api/admin/cards/refund") {
        const chk = await requireAdminCsrf(req); if (!chk.success) return send(res, chk.statusCode || 403, chk), true;
        const b = await body(req); const done = await refundOrder(clean(b.reference), "Refunded by admin");
        return send(res, 200, { success: true, refunded: done, message: done ? "Order refunded to the customer's wallet." : "Nothing to refund (already settled or refunded)." }), true;
      }
      return send(res, 404, { success: false, message: "Route not found." }), true;
    }

    const user = await userFromToken(req);
    if (!user) return send(res, 401, { success: false, message: "Unauthorized." }), true;
    const uid = clean(user.user_id);
    const out = (o) => { const { code, ...rest } = o; send(res, code || 200, { success: (code || 200) < 300, ...rest }); return true; };

    if (M === "GET" && path === "/api/cards/config") {
      const c = await cfg(); const rate = c.enabled ? await liveRate(c) : 0;
      return send(res, 200, { success: true, enabled: c.enabled, ready: !!KEY && !!rate, feeUsd: c.feeUsd, minUsd: c.minUsd, maxUsd: c.maxUsd, ratePerUsd: rate ? Number((rate + c.margin).toFixed(2)) : null }), true;
    }
    if (M === "GET" && path === "/api/cards/me") {
      let card = await getCard(uid);
      if (card && new URL(req.url, "http://x").searchParams.get("sync") === "1" && Date.now() - new Date(card.updated_at).getTime() > 20000) {
        const r = await ps("GET", `/cards/${card.payscribe_card_id}`); const det = r.data?.message?.details;
        if (r.outcome === "success" && det) { await db(`UPDATE user_cards SET balance_usd=COALESCE($2,balance_usd), status=COALESCE($3,status), updated_at=NOW() WHERE user_id=$1`, [uid, Number.isFinite(Number(det.balance)) ? Number(det.balance) : null, det.terminate ? "terminated" : (clean(det.status).toLowerCase() || null)]); card = await getCard(uid); }
      }
      await expireStale(uid);
      const openRow = (await db(`SELECT * FROM card_orders WHERE user_id=$1 AND status='awaiting_payment' ORDER BY id DESC LIMIT 1`, [uid])).rows[0];
      const pending = (await db(`SELECT kind FROM card_orders WHERE user_id=$1 AND status IN ('paid','processing','pending','needs_review','needs_funding') LIMIT 1`, [uid])).rows[0];
      return send(res, 200, { success: true, verified: !!(await getProfile(uid)), card: cardView(card), open: orderView(openRow), pending: pending ? pending.kind : null }), true;
    }
    if (M === "POST" && path === "/api/cards/quote") {
      const b = await body(req); const c = await cfg(); const usd = num2(b.usd); const kind = b.kind === "topup" ? "topup" : "create";
      if (!(usd >= c.minUsd && usd <= c.maxUsd)) return out({ code: 400, message: `Enter an amount between $${c.minUsd} and $${c.maxUsd}.` });
      const rate = await liveRate(c); if (!rate) return out({ code: 503, message: "Card pricing is unavailable right now." });
      return out({ code: 200, quote: price(usd, kind === "create" ? c.feeUsd : 0, rate, c.margin, c) });
    }
    if (M === "GET" && path === "/api/cards/order") {
      const ref = clean(new URL(req.url, "http://x").searchParams.get("ref"));
      await expireStale(uid);
      const o = (await db(`SELECT * FROM card_orders WHERE reference=$1 AND user_id=$2`, [ref, uid])).rows[0];
      return o ? out({ code: 200, order: orderView(o) }) : out({ code: 404, message: "Order not found." });
    }
    if (M === "POST" && path === "/api/cards/order/cancel") {
      const b = await body(req);
      const r = await db(`UPDATE card_orders SET status='cancelled', updated_at=NOW() WHERE reference=$1 AND user_id=$2 AND status='awaiting_payment' RETURNING reference`, [clean(b.reference), uid]);
      return out({ code: 200, cancelled: r.rows.length > 0 });
    }
    if (M === "POST" && path === "/api/cards/kyc-upload") {
      const rl = rateLimit(req, "card-upload:" + uid, 10, 3600000); if (!rl.allowed) return rateLimitedResponse(res, rl), true;
      const b = await body(req); const id = await saveUpload(uid, b.dataUrl);
      return out(id ? { code: 200, fileId: id } : { code: 400, message: "Upload a clear JPG, PNG or WebP image (under 700 KB)." });
    }
    if (M === "POST" && path === "/api/cards/kyc") {
      const rl = rateLimit(req, "card-kyc:" + uid, 5, 3600000); if (!rl.allowed) return rateLimitedResponse(res, rl), true;
      if (await getProfile(uid)) return out({ code: 200, message: "You are already verified." });
      const b = await body(req);
      const f = k => clean(b[k]);
      const need = ["firstName", "lastName", "dob", "street", "city", "state", "postalCode", "bvn", "idType", "idNumber", "photoId", "idImageId"];
      if (need.some(k => !f(k))) return out({ code: 400, message: "Please fill in every field." });
      if (!/^\d{11}$/.test(f("bvn"))) return out({ code: 400, message: "BVN must be 11 digits." });
      if (!["NIN", "PASSPORT", "VIN"].includes(f("idType"))) return out({ code: 400, message: "Choose NIN, Passport or Voter's card." });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f("dob")) || (Date.now() - new Date(f("dob")).getTime()) / 31557600000 < 18) return out({ code: 400, message: "You must be 18 or older." });
      if (!/^[A-Za-z0-9 ,.\-]{5,120}$/.test(f("street"))) return out({ code: 400, message: "Use a plain address (letters, numbers, spaces and commas only)." });
      if (!/^[a-f0-9]{48}$/.test(f("photoId")) || !/^[a-f0-9]{48}$/.test(f("idImageId"))) return out({ code: 400, message: "Please upload both images again." });
      const own = (await db(`SELECT COUNT(*)::int AS n FROM card_uploads WHERE user_id=$1 AND id = ANY($2)`, [uid, [f("photoId"), f("idImageId")]])).rows[0].n;
      if (own !== 2) return out({ code: 400, message: "Please upload both images again." });
      const r = await ps("POST", "/customers/create/full", { first_name: f("firstName"), last_name: f("lastName"), phone: clean(user.phone), email: clean(user.email), dob: f("dob"), country: "NG",
        address: { street: f("street"), city: f("city"), state: f("state"), country: "NG", postal_code: f("postalCode") },
        identification_type: "BVN", identification_number: f("bvn"), photo: uploadUrl(f("photoId")),
        identity: { type: f("idType"), number: f("idNumber"), country: "NG", image: uploadUrl(f("idImageId")) } });
      await db(`DELETE FROM card_uploads WHERE user_id=$1`, [uid]).catch(() => { }); // never keep ID images
      const cid = clean(r.data?.message?.details?.customer_id);
      if (r.outcome !== "success" || !cid) return out({ code: r.outcome === "unknown" ? 503 : 400, message: r.message || "Verification could not be completed. Check your details and try again." });
      await db(`INSERT INTO card_profiles(user_id,payscribe_customer_id,holder_name) VALUES($1,$2,$3) ON CONFLICT(user_id) DO NOTHING`, [uid, cid, `${f("firstName")} ${f("lastName")}`.toUpperCase()]);
      return out({ code: 200, message: "Verification complete. You can now create your card." });
    }
    if (M === "POST" && path === "/api/cards/create") { const b = await body(req); return out(await runOrder(user, "create", b)); }
    if (M === "POST" && path === "/api/cards/topup") { const b = await body(req); return out(await runOrder(user, "topup", b)); }
    if (M === "POST" && path === "/api/cards/design") {
      const b = await body(req); if (!designOk(b.design)) return out({ code: 400, message: "Invalid design." });
      await db(`UPDATE user_cards SET design=$2 WHERE user_id=$1`, [uid, b.design]); return out({ code: 200, design: b.design });
    }
    if (M === "POST" && path === "/api/cards/freeze") {
      const b = await body(req); const card = await getCard(uid); if (!card) return out({ code: 404, message: "No card found." });
      const unfreeze = b.action === "unfreeze";
      if (unfreeze) { const pe = await checkPin(uid, b.transactionPin); if (pe) return out({ code: 400, message: pe }); }
      const r = await ps("PATCH", `/cards/${card.payscribe_card_id}/${unfreeze ? "unfreeze" : "freeze"}`, { ref: reference("BOLTIV-CARDCTL") });
      if (r.outcome !== "success") return out({ code: r.outcome === "unknown" ? 503 : 400, message: r.message || "Could not update the card." });
      await db(`UPDATE user_cards SET status=$2, updated_at=NOW() WHERE user_id=$1`, [uid, unfreeze ? "active" : "frozen"]);
      return out({ code: 200, status: unfreeze ? "active" : "frozen" });
    }
    if (M === "POST" && path === "/api/cards/reveal") {
      const rl = rateLimit(req, "card-reveal:" + uid, 6, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl), true;
      const b = await body(req); const card = await getCard(uid); if (!card) return out({ code: 404, message: "No card found." });
      const pe = await checkPin(uid, b.transactionPin); if (pe) return out({ code: 400, message: pe });
      if (!/^[0-9a-f]{64}$/i.test(HASH_KEY)) return out({ code: 503, message: "Card details are not available yet." });
      const r = await ps("GET", `/cards/${card.payscribe_card_id}`); const sd = r.data?.message?.details?.secure_details;
      if (r.outcome !== "success" || !sd) return out({ code: 503, message: "Could not load card details. Try again." });
      try { const x = decrypt(sd); res.setHeader("Cache-Control", "no-store"); return out({ code: 200, number: x.number, cvv: x.ccv, expiry: x.expiry }); }
      catch { return out({ code: 503, message: "Could not read card details." }); }
    }
    if (M === "GET" && path === "/api/cards/transactions") {
      const card = await getCard(uid); if (!card) return out({ code: 200, transactions: [] });
      const end = new Date(), start = new Date(Date.now() - 30 * 86400000), ymd = x => x.toISOString().slice(0, 10);
      const r = await ps("GET", `/cards/${card.payscribe_card_id}/transactions?start_date=${ymd(start)}&end_date=${ymd(end)}&page_size=30&page=1`);
      if (r.outcome !== "success") return out({ code: 503, message: "Could not load card activity." });
      return out({ code: 200, transactions: r.data?.message?.details?.transactions || r.data?.message?.details || [] });
    }
    return send(res, 404, { success: false, message: "Route not found." }), true;
  }
  return { handle };
};
