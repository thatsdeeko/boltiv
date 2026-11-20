"use strict";
/* BOLTIV Link: website builder (subdomain sites). Self-contained like business/index.js, wired into server.js with a require,
   a host check (serveSite) and one route hook (handle). Rules:
   - A username is reserved forever in link_usernames. There is no delete route, and database triggers refuse DELETE on sites and usernames.
   - Money is computed on the server only; wallet debit is atomic, PIN-checked, idempotent and ledgered.
   - Expiry is decided from expires_at at request time (never from a cron flag), so a late timer can never keep a dead site online.
   - Expired sites return a friendly 503 and keep all their data; renewing brings everything back. */
const crypto = require("node:crypto");
const L = require("./logic");
const R = require("./render");
const naira = n => "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 });

module.exports = function createLink(d) {
  const { db, pool, send, body, clean, userFromToken, verifyPassword, reference, addFinancialLedger, addNotification, addNotificationOnce,
    getPlatformSetting, rateLimit, rateLimitedResponse, adminFromToken, requireAdminCsrf, requestIp } = d;
  const DOMAIN = (process.env.LINK_DOMAIN || "boltiv.ng").toLowerCase();
  const SALT = process.env.LINK_SALT || "boltiv-link-v1";
  const FRONT = (process.env.FRONTEND_URL || "https://boltiv.ng").replace(/\/+$/, "");
  const API_BASE = (process.env.BACKEND_PUBLIC_URL || "https://boltiv-production.up.railway.app").replace(/\/+$/, "");
  class Fail extends Error { constructor(code, message, extra) { super(message); this.code = code; this.extra = extra || {}; } }
  const fail = (c, m, x) => { throw new Fail(c, m, x); };
  const out = (res, data) => send(res, 200, { success: true, ...data });
  const ipOf = req => (requestIp ? requestIp(req) : String(req.socket?.remoteAddress || ""));

  /* ---------- schema ---------- */
  let ready = null;
  function ensureTables() {
    if (!ready) ready = (async () => {
      await db(`CREATE TABLE IF NOT EXISTS link_usernames(username TEXT PRIMARY KEY CHECK(username=lower(username)),user_id TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db(`CREATE TABLE IF NOT EXISTS link_sites(id BIGSERIAL PRIMARY KEY,user_id TEXT NOT NULL,username TEXT UNIQUE NOT NULL REFERENCES link_usernames(username),status TEXT NOT NULL DEFAULT 'active',
        draft JSONB NOT NULL,published JSONB,published_at TIMESTAMPTZ,starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL,paid_total NUMERIC(14,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db(`ALTER TABLE link_sites DROP CONSTRAINT IF EXISTS link_sites_user_id_key`); // one customer can own several websites
      await db(`CREATE INDEX IF NOT EXISTS link_sites_user ON link_sites(user_id)`);
      await db(`CREATE TABLE IF NOT EXISTS link_payments(reference TEXT PRIMARY KEY,site_id BIGINT NOT NULL,user_id TEXT NOT NULL,kind TEXT NOT NULL,days INT NOT NULL,amount NUMERIC(14,2) NOT NULL,starts_at TIMESTAMPTZ NOT NULL,expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db(`CREATE TABLE IF NOT EXISTS link_images(id BIGSERIAL PRIMARY KEY,site_id BIGINT NOT NULL,mime TEXT NOT NULL,data BYTEA NOT NULL,size INT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db(`CREATE INDEX IF NOT EXISTS link_images_site ON link_images(site_id)`);
      await db(`CREATE TABLE IF NOT EXISTS link_stats(site_id BIGINT NOT NULL,day DATE NOT NULL,views INT NOT NULL DEFAULT 0,uniques INT NOT NULL DEFAULT 0,wa INT NOT NULL DEFAULT 0,calls INT NOT NULL DEFAULT 0,orders INT NOT NULL DEFAULT 0,PRIMARY KEY(site_id,day))`);
      await db(`CREATE TABLE IF NOT EXISTS link_visitors(site_id BIGINT NOT NULL,day DATE NOT NULL,h TEXT NOT NULL,PRIMARY KEY(site_id,day,h))`);
      await db(`CREATE TABLE IF NOT EXISTS link_refs(site_id BIGINT NOT NULL,day DATE NOT NULL,host TEXT NOT NULL,n INT NOT NULL DEFAULT 0,PRIMARY KEY(site_id,day,host))`);
      await db(`ALTER TABLE link_images ADD COLUMN IF NOT EXISTS small BYTEA`); await db(`ALTER TABLE link_images ADD COLUMN IF NOT EXISTS med BYTEA`);
      await db(`ALTER TABLE link_images ADD COLUMN IF NOT EXISTS small_mime TEXT`); await db(`ALTER TABLE link_images ADD COLUMN IF NOT EXISTS med_mime TEXT`);
      await db(`ALTER TABLE link_images ADD COLUMN IF NOT EXISTS w INT`); await db(`ALTER TABLE link_images ADD COLUMN IF NOT EXISTS h INT`);
      for (const c of ["enq", "plc", "bkg", "mob"]) await db(`ALTER TABLE link_stats ADD COLUMN IF NOT EXISTS ${c} INT NOT NULL DEFAULT 0`);
      await db(`CREATE TABLE IF NOT EXISTS link_item_stats(site_id BIGINT NOT NULL,day DATE NOT NULL,item_id TEXT NOT NULL,taps INT NOT NULL DEFAULT 0,adds INT NOT NULL DEFAULT 0,orders INT NOT NULL DEFAULT 0,PRIMARY KEY(site_id,day,item_id))`);
      await db(`CREATE TABLE IF NOT EXISTS link_contacts(id BIGSERIAL PRIMARY KEY,site_id BIGINT NOT NULL,ckey TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'enquiry',
        tags TEXT[] NOT NULL DEFAULT '{}',notes TEXT NOT NULL DEFAULT '',consent BOOLEAN NOT NULL DEFAULT FALSE,first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(site_id,ckey))`);
      await db(`CREATE TABLE IF NOT EXISTS link_enquiries(id BIGSERIAL PRIMARY KEY,site_id BIGINT NOT NULL,contact_id BIGINT NOT NULL,message TEXT NOT NULL,item_name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'new',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db(`CREATE INDEX IF NOT EXISTS link_enq_site ON link_enquiries(site_id,created_at DESC)`);
      await db(`CREATE TABLE IF NOT EXISTS link_orders(id BIGSERIAL PRIMARY KEY,site_id BIGINT NOT NULL,contact_id BIGINT NOT NULL,code TEXT NOT NULL,items JSONB NOT NULL,subtotal NUMERIC(14,2) NOT NULL,discount NUMERIC(14,2) NOT NULL DEFAULT 0,delivery_fee NUMERIC(14,2) NOT NULL DEFAULT 0,total NUMERIC(14,2) NOT NULL,
        promo TEXT NOT NULL DEFAULT '',fulfilment TEXT NOT NULL DEFAULT 'pickup',address TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'new',paid BOOLEAN NOT NULL DEFAULT FALSE,owner_note TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(site_id,code))`);
      await db(`CREATE INDEX IF NOT EXISTS link_orders_site ON link_orders(site_id,created_at DESC)`);
      await db(`CREATE TABLE IF NOT EXISTS link_bookings(id BIGSERIAL PRIMARY KEY,site_id BIGINT NOT NULL,contact_id BIGINT NOT NULL,code TEXT NOT NULL DEFAULT '',service_id TEXT NOT NULL DEFAULT '',service_name TEXT NOT NULL,price NUMERIC(14,2) NOT NULL DEFAULT 0,
        start_at TIMESTAMPTZ NOT NULL,duration INT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',note TEXT NOT NULL DEFAULT '',owner_note TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await db(`CREATE INDEX IF NOT EXISTS link_bookings_site ON link_bookings(site_id,start_at)`);
      await db(`CREATE TABLE IF NOT EXISTS link_promos(id BIGSERIAL PRIMARY KEY,site_id BIGINT NOT NULL,code TEXT NOT NULL,kind TEXT NOT NULL,value NUMERIC(14,2) NOT NULL,min_order NUMERIC(14,2) NOT NULL DEFAULT 0,max_uses INT NOT NULL DEFAULT 0,uses INT NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ,active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(site_id,code))`);
      await db(`CREATE OR REPLACE FUNCTION link_block_delete() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'BOLTIV Link: websites and usernames can never be deleted'; END $$ LANGUAGE plpgsql`);
      for (const t of ["link_sites", "link_usernames"]) {
        await db(`DROP TRIGGER IF EXISTS ${t}_no_delete ON ${t}`);
        await db(`CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION link_block_delete()`);
      }
    })().catch(e => { ready = null; throw e; });
    return ready;
  }
  async function cfg() {
    const g = async (k, f) => { try { const v = await getPlatformSetting(k, f); return v === null || v === undefined ? f : v; } catch { return f; } };
    const [en, pr, dy, mx] = await Promise.all([g("link_enabled", true), g("link_price", 3000), g("link_days", 100), g("link_max_sites", 10)]);
    return { enabled: en !== false && en !== "false", price: Math.max(0, Number(pr) || 3000), days: Math.min(366, Math.max(1, Math.round(Number(dy)) || 100)), maxSites: Math.min(100, Math.max(1, Math.round(Number(mx)) || 10)) };
  }
  async function withTx(fn) {
    const c = await pool.connect();
    try { await c.query("BEGIN"); const o = await fn(c); await c.query("COMMIT"); return o; }
    catch (e) { try { await c.query("ROLLBACK"); } catch {} throw e; } finally { c.release(); }
  }
  async function checkPin(uid, pin) {
    const s = await db(`SELECT transaction_pin_hash FROM user_security WHERE user_id=$1 LIMIT 1`, [uid]);
    const h = s.rows[0]?.transaction_pin_hash;
    if (!h) return "Please set your Transaction PIN first.";
    if (!/^\d{4}$/.test(String(pin || "")) || !verifyPassword(String(pin), h)) return "Incorrect Transaction PIN.";
    return "";
  }
  const ownedSite = async (uid, id) => { const n = Number(id); if (!Number.isInteger(n) || n < 1) return null; return (await db(`SELECT * FROM link_sites WHERE id=$1 AND user_id=$2`, [n, uid])).rows[0] || null; };
  const summary = (s, now) => ({ id: Number(s.id), username: s.username, url: `https://${s.username}.${DOMAIN}`, name: (s.draft && s.draft.brand && s.draft.brand.name) || s.username, template: s.draft && s.draft.theme && s.draft.theme.template,
    colors: s.draft && s.draft.theme ? { primary: s.draft.theme.primary, accent: s.draft.theme.accent, bg: s.draft.theme.bg, text: s.draft.theme.text } : null, state: L.siteState(s, now), expiresAt: s.expires_at, daysLeft: L.daysLeft(s.expires_at, now), publishedAt: s.published_at, hasUnpublished: !s.published || JSON.stringify(s.published) !== JSON.stringify(s.draft) });
  async function listFor(uid, now) {
    const r = await db(`SELECT s.*,COALESCE((SELECT SUM(views) FROM link_stats x WHERE x.site_id=s.id AND x.day>CURRENT_DATE-30),0)::int AS views30 FROM link_sites s WHERE s.user_id=$1 ORDER BY s.id DESC`, [uid]);
    return r.rows.map(s => ({ ...summary(s, now), views30: s.views30 }));
  }
  const walletOf = async uid => Number(((await db(`SELECT balance FROM wallets WHERE user_id=$1`, [uid])).rows[0] || {}).balance || 0);
  const templateList = () => L.TEMPLATE_IDS.map(id => { const t = L.TEMPLATES[id]; return { id, name: t.name, category: t.category, blurb: t.blurb, palettes: t.palettes, headFont: t.theme.headFont, bodyFont: t.theme.bodyFont, radius: t.theme.radius, labels: t.labels, order: t.order }; });
  async function debit(c, uid, amount, ref, desc, meta) {
    await c.query(`INSERT INTO wallets(user_id,balance) VALUES($1,0) ON CONFLICT(user_id) DO NOTHING`, [uid]);
    const w = await c.query(`UPDATE wallets SET balance=balance-$1,updated_at=NOW() WHERE user_id=$2 AND balance>=$1 RETURNING balance`, [amount, uid]);
    if (!w.rows.length) fail(400, "Insufficient wallet balance. Fund your wallet and try again.", { code: "insufficient_balance" });
    const balance = Number(w.rows[0].balance);
    await addFinancialLedger(c, { accountType: "customer_wallet", ownerId: uid, direction: "debit", amount: -amount, balanceAfter: balance, reference: `WALLET-${ref}`, category: "link_subscription", description: desc, metadata: meta });
    return balance;
  }
  const idemRef = (prefix, uid, idem) => (idem ? prefix + "-" + crypto.createHash("sha256").update(`${uid}|${idem}`).digest("hex").slice(0, 32).toUpperCase() : reference(prefix));
  const ownImages = async (siteId, ids) => { if (!ids.length) return true; const r = await db(`SELECT COUNT(*)::int AS n FROM link_images WHERE site_id=$1 AND id=ANY($2::bigint[])`, [siteId, ids]); return r.rows[0].n === ids.length; };
  const frameHead = (res, code, extra) => res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'; frame-ancestors ${FRONT} https://www.boltiv.ng`, ...extra });

  /* ---------- shared helpers for the business hub ---------- */
  const fmtWhen = ms => new Date(ms).toLocaleString("en-GB", { timeZone: "Africa/Lagos", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s?(am|pm)/i, m => m.trim().toLowerCase());
  const clockLabel = hm => { const [h, m] = hm.split(":").map(Number); return ((h % 12) || 12) + (m ? ":" + String(m).padStart(2, "0") : "") + (h < 12 ? "am" : "pm"); };
  const loadDims = async (siteId, ids) => { const m = {}; if (!ids.length) return m; try { const r = await db(`SELECT id,w,h FROM link_images WHERE site_id=$1 AND id=ANY($2::bigint[]) AND w IS NOT NULL`, [siteId, ids]); r.rows.forEach(x => { m[String(x.id)] = [x.w, x.h]; }); } catch {} return m; };
  const BUMP = { view: "views", wa: "wa", call: "calls", order: "orders", enq: "enq", plc: "plc", bkg: "bkg" };
  const bump = (siteId, kind, n) => db(`INSERT INTO link_stats(site_id,day,${BUMP[kind]}) VALUES($1,CURRENT_DATE,$2) ON CONFLICT(site_id,day) DO UPDATE SET ${BUMP[kind]}=link_stats.${BUMP[kind]}+$2`, [siteId, n || 1]).catch(() => {});
  const itemStat = (siteId, itemId, col) => { if (!["taps", "adds", "orders"].includes(col) || !itemId) return; return db(`INSERT INTO link_item_stats(site_id,day,item_id,${col}) VALUES($1,CURRENT_DATE,$2,1) ON CONFLICT(site_id,day,item_id) DO UPDATE SET ${col}=link_item_stats.${col}+1`, [siteId, String(itemId).slice(0, 12)]).catch(() => {}); };
  async function upsertContact(c, siteId, sub, source) {
    const key = L.contactKey(sub.phone, sub.email);
    const r = await c.query(`INSERT INTO link_contacts(site_id,ckey,name,phone,email,source,consent) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(site_id,ckey) DO UPDATE SET name=CASE WHEN link_contacts.name='' THEN EXCLUDED.name ELSE link_contacts.name END,phone=CASE WHEN link_contacts.phone='' THEN EXCLUDED.phone ELSE link_contacts.phone END,
      email=CASE WHEN link_contacts.email='' THEN EXCLUDED.email ELSE link_contacts.email END,consent=link_contacts.consent OR EXCLUDED.consent,last_at=NOW() RETURNING id`, [siteId, key, sub.name, sub.phone, sub.email, source, !!sub.optin]);
    return r.rows[0].id;
  }
  /* Photos nobody references any more (replaced or removed by the owner) are cleaned up so the storage allowance is never wasted. */
  async function pruneImages(site, draft) {
    const keep = new Set([...L.imageIds(draft), ...(site.published ? L.imageIds(L.sanitizeConfig(site.published, site.published)) : [])].map(Number));
    await db(`DELETE FROM link_images WHERE site_id=$1 AND created_at<NOW()-interval '15 minutes' AND NOT (id=ANY($2::bigint[]))`, [site.id, [...keep]]).catch(() => {});
  }

  /* ---------- API ---------- */
  async function handle(req, res, path) {
    const M = req.method, url = new URL(req.url, "http://x"), q = url.searchParams;
    try {
      await ensureTables();
      const settings = await cfg();
      if (path.startsWith("/api/admin/link/")) return await adminRoutes(req, res, path, M, q);

      if (M === "GET" && path === "/api/link/check") {
        const rl = rateLimit(req, "link-check", 60, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
        const u = L.normUsername(q.get("u")), err = L.validateUsername(u);
        if (err) return out(res, { available: false, username: u, reason: err });
        const taken = (await db(`SELECT 1 FROM link_usernames WHERE username=$1`, [u])).rows.length > 0;
        return out(res, { available: !taken, username: u, reason: taken ? "This name is already taken." : "", url: `https://${u}.${DOMAIN}` });
      }
      if (M === "GET" && path === "/api/link/pricing") return out(res, { price: settings.price, days: settings.days, enabled: settings.enabled, domain: DOMAIN, maxSites: settings.maxSites });
      if (M === "GET" && path === "/api/link/templates") return out(res, { templates: templateList() });
      const dm = /^\/api\/link\/demo\/([a-z]+)$/.exec(path);
      if (M === "GET" && dm) { /* public live demo of a template, shown on the public page and in the picker */
        if (!L.TEMPLATES[dm[1]]) return send(res, 404, { success: false, message: "Template not found." });
        const demoName = { atelier: "Maison Adé", bistro: "Mama’s Kitchen", market: "Corner Store", studio: "Northwind Advisory", folio: "Tola Bello", glow: "Glow Studio" }[dm[1]];
        const c = L.templateConfig(dm[1], demoName); c.contact = L.sanitizeConfig({ contact: { whatsapp: "08031234567", phone: "08031234567", address: "12 Admiralty Way, Lekki, Lagos", hours: "Mon to Sat, 9am to 6pm", instagram: "boltiv" } }).contact;
        frameHead(res, 200, { "Cache-Control": "public, max-age=300" }); res.end(R.render(c, { preview: true, noindex: true })); return true;
      }

      const user = await userFromToken(req); if (!user) return send(res, 401, { success: false, message: "Please sign in." });
      const uid = String(user.user_id), now = new Date();

      if (M === "GET" && (path === "/api/link/me" || path === "/api/link/sites")) {
        const [sites, balance] = await Promise.all([listFor(uid, now), walletOf(uid)]);
        const o = { sites, pricing: { price: settings.price, days: settings.days, enabled: settings.enabled, domain: DOMAIN, maxSites: settings.maxSites }, walletBalance: balance };
        if (path === "/api/link/me") { o.templates = templateList(); o.imgBase = `${API_BASE}/api/link/img/`; }
        return out(res, o);
      }

      if (M === "POST" && (path === "/api/link/register" || path === "/api/link/renew")) {
        const renew = path.endsWith("renew");
        const rl = rateLimit(req, "link-pay:" + uid, 10, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
        if (!settings.enabled && !renew) fail(403, "BOLTIV Link is not accepting new websites right now.");
        const b = await body(req);
        const pinErr = await checkPin(uid, b.transactionPin); if (pinErr) fail(400, pinErr);
        if (b.expectedAmount !== undefined && Math.abs(Number(b.expectedAmount) - settings.price) > 0.001) fail(409, "The price changed. Please review the new amount.", { code: "price_changed", price: settings.price });
        const ref = idemRef(renew ? "LNKRN" : "LNKNW", uid, clean(b.idempotencyKey).slice(0, 80));
        const result = await withTx(async c => {
          const dupe = (await c.query(`SELECT * FROM link_payments WHERE reference=$1`, [ref])).rows[0];
          if (dupe) { if (dupe.user_id !== uid) fail(409, "Duplicate request."); return { already: true, pay: dupe }; }
          if (renew) {
            const s = (await c.query(`SELECT * FROM link_sites WHERE id=$1 AND user_id=$2 FOR UPDATE`, [Number(b.siteId) || 0, uid])).rows[0]; if (!s) fail(404, "Website not found.");
            if (s.status === "suspended") fail(403, "This website is suspended. Contact BOLTIV support.");
            const exp = L.renewedExpiry(s.expires_at, new Date(), settings.days);
            const balance = await debit(c, uid, settings.price, ref, `BOLTIV Link renewal (${s.username}.${DOMAIN}, ${settings.days} days)`, { site_id: Number(s.id), days: settings.days });
            await c.query(`UPDATE link_sites SET expires_at=$2,status='active',paid_total=paid_total+$3,updated_at=NOW() WHERE id=$1`, [s.id, exp, settings.price]);
            const p = (await c.query(`INSERT INTO link_payments(reference,site_id,user_id,kind,days,amount,starts_at,expires_at) VALUES($1,$2,$3,'renew',$4,$5,NOW(),$6) RETURNING *`, [ref, s.id, uid, settings.days, settings.price, exp])).rows[0];
            return { pay: p, balance, username: s.username, siteId: Number(s.id) };
          }
          const username = L.normUsername(b.username), err = L.validateUsername(username); if (err) fail(400, err);
          const count = (await c.query(`SELECT COUNT(*)::int n FROM link_sites WHERE user_id=$1`, [uid])).rows[0].n;
          if (count >= settings.maxSites) fail(409, `You can have up to ${settings.maxSites} websites.`, { code: "max_sites" });
          try { await c.query(`INSERT INTO link_usernames(username,user_id) VALUES($1,$2)`, [username, uid]); }
          catch (e) { if (e.code === "23505") fail(409, "Sorry, this name was just taken. Please choose another.", { code: "username_taken" }); throw e; }
          const balance = await debit(c, uid, settings.price, ref, `BOLTIV Link website (${username}.${DOMAIN}, ${settings.days} days)`, { username, days: settings.days });
          const draft = L.templateConfig(L.TEMPLATES[b.templateId] ? b.templateId : "atelier", clean(b.businessName).slice(0, 60) || username);
          const exp = L.renewedExpiry(null, new Date(), settings.days);
          const s = (await c.query(`INSERT INTO link_sites(user_id,username,draft,expires_at,paid_total) VALUES($1,$2,$3::jsonb,$4,$5) RETURNING *`, [uid, username, JSON.stringify(draft), exp, settings.price])).rows[0];
          const p = (await c.query(`INSERT INTO link_payments(reference,site_id,user_id,kind,days,amount,starts_at,expires_at) VALUES($1,$2,$3,'new',$4,$5,NOW(),$6) RETURNING *`, [ref, s.id, uid, settings.days, settings.price, exp])).rows[0];
          return { pay: p, balance, username, siteId: Number(s.id) };
        });
        if (!result.already) { try { await addNotification(uid, renew ? "Website renewed" : "Your website is ready", `${result.username}.${DOMAIN} is active until ${new Date(result.pay.expires_at).toDateString()}.`, "success"); } catch {} }
        return out(res, { already: !!result.already, message: result.already ? "This payment was already processed." : renew ? "Website renewed." : "Website created.", reference: ref, siteId: result.siteId ?? Number(result.pay.site_id), expiresAt: result.pay.expires_at, balance: result.balance ?? null });
      }

      /* everything below works on ONE of the customer's websites, always checked against their own account; editing stays open while expired so owners can prepare before renewing */
      const b = M === "GET" ? {} : await body(req);
      const site = await ownedSite(uid, q.get("id") || b.id); if (!site) fail(404, "Website not found.");
      if (site.status === "suspended") fail(403, "This website is suspended. Contact BOLTIV support.");

      if (M === "GET" && path === "/api/link/site") return out(res, { site: summary(site, now), draft: site.draft, samples: L.sampleCount(site.draft) });
      if (M === "PATCH" && path === "/api/link/site") {
        const rl = rateLimit(req, "link-save:" + uid, 120, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
        const draft = L.sanitizeConfig(b.config, site.draft);
        if (!(await ownImages(site.id, L.imageIds(draft)))) fail(400, "One of the images does not belong to this website. Please re-upload it.");
        await db(`UPDATE link_sites SET draft=$2::jsonb,updated_at=NOW() WHERE id=$1`, [site.id, JSON.stringify(draft)]);
        pruneImages(site, draft);
        return out(res, { draft, samples: L.sampleCount(draft) });
      }
      if (M === "POST" && path === "/api/link/preview") {
        const rl = rateLimit(req, "link-prev:" + uid, 240, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
        const c = L.sanitizeConfig(b.config, site.draft);
        return out(res, { html: R.render(c, { preview: true, imgBase: `${API_BASE}/api/link/img/`, noindex: true, dims: await loadDims(site.id, L.imageIds(c).map(Number)) }) });
      }
      if (M === "POST" && path === "/api/link/publish") {
        if (L.siteState(site, now) !== "active") fail(403, "Your website has expired. Renew it to publish.");
        const d0 = L.sanitizeConfig(site.draft, site.draft);
        if (!d0.brand.name) fail(400, "Add your business name before publishing.");
        const samples = L.sampleCount(d0);
        if (samples > 0 && !b.force) fail(409, `${samples} sample item${samples === 1 ? " is" : "s are"} still on your website.`, { code: "sample_content", samples });
        await db(`UPDATE link_sites SET published=draft,published_at=NOW(),updated_at=NOW() WHERE id=$1`, [site.id]);
        return out(res, { message: "Your website is live.", url: `https://${site.username}.${DOMAIN}` });
      }
      if (M === "POST" && path === "/api/link/image") {
        const rl = rateLimit(req, "link-img:" + uid, 60, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
        const im = L.dataUrlImage(b.dataUrl);
        if (!im) fail(400, "Please upload a JPG, PNG or WebP image.");
        if (im.buf.length > 600 * 1024) fail(413, "Image is too large. Try a smaller photo.");
        const agg = (await db(`SELECT COUNT(*)::int AS n,COALESCE(SUM(size),0)::bigint AS s FROM link_images WHERE site_id=$1`, [site.id])).rows[0];
        if (agg.n >= 400 || Number(agg.s) + im.buf.length > 64 * 1024 * 1024) fail(409, "Image storage is full for this website. Remove photos you no longer use.");
        const w = L.int(b.w, 1, 8000, 0), h = L.int(b.h, 1, 8000, 0);
        const r = await db(`INSERT INTO link_images(site_id,mime,data,size,w,h) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [site.id, im.mime, im.buf, im.buf.length, w || null, h || null]);
        return out(res, { id: String(r.rows[0].id) });
      }
      /* ---- image variants (small and medium copies make pages fast; the full photo is only fetched for full-size viewing) ---- */
      if (M === "POST" && path === "/api/link/image-variant") {
        const rl = rateLimit(req, "link-imgv:" + uid, 240, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
        const v = b.v === "s" ? "s" : b.v === "m" ? "m" : "", im = L.dataUrlImage(b.dataUrl); if (!v || !im) fail(400, "Invalid image.");
        if (im.buf.length > (v === "s" ? 160 : 380) * 1024) fail(413, "Image variant is too large.");
        const own = (await db(`SELECT mime FROM link_images WHERE id=$1 AND site_id=$2`, [Number(b.imageId) || 0, site.id])).rows[0]; if (!own) fail(404, "Image not found.");
        if (own.mime !== im.mime) fail(400, "Image format mismatch.");
        await db(v === "s" ? `UPDATE link_images SET small=$2,small_mime=$3 WHERE id=$1` : `UPDATE link_images SET med=$2,med_mime=$3 WHERE id=$1`, [Number(b.imageId), im.buf, im.mime]);
        return out(res, {});
      }

      /* ---- the business hub: overview ---- */
      if (M === "GET" && path === "/api/link/hub") {
        const id = site.id;
        const [o, bk, en, ct, vw, lo, lb, le, lp] = await Promise.all([
          db(`SELECT COUNT(*) FILTER(WHERE status='new')::int new_orders,COUNT(*) FILTER(WHERE status<>'cancelled' AND created_at>NOW()-interval '30 days')::int orders30,COALESCE(SUM(total) FILTER(WHERE status<>'cancelled' AND created_at>NOW()-interval '30 days'),0)::float revenue30,COUNT(*) FILTER(WHERE status IN ('new','confirmed','preparing','ready'))::int open_orders FROM link_orders WHERE site_id=$1`, [id]),
          db(`SELECT COUNT(*) FILTER(WHERE status='pending')::int pending,COUNT(*) FILTER(WHERE status IN ('pending','confirmed') AND start_at>=NOW())::int upcoming FROM link_bookings WHERE site_id=$1`, [id]),
          db(`SELECT COUNT(*) FILTER(WHERE status='new')::int new_enquiries,COUNT(*)::int total FROM link_enquiries WHERE site_id=$1`, [id]),
          db(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE consent)::int optin,COUNT(*) FILTER(WHERE first_at>NOW()-interval '30 days')::int new30 FROM link_contacts WHERE site_id=$1`, [id]),
          db(`SELECT COALESCE(SUM(views),0)::int views30,COALESCE(SUM(uniques),0)::int visitors30 FROM link_stats WHERE site_id=$1 AND day>CURRENT_DATE-30`, [id]),
          db(`SELECT o.id,o.code,o.total::float total,o.status,o.created_at,c.name FROM link_orders o JOIN link_contacts c ON c.id=o.contact_id WHERE o.site_id=$1 ORDER BY o.id DESC LIMIT 5`, [id]),
          db(`SELECT b.id,b.service_name,b.start_at,b.status,c.name FROM link_bookings b JOIN link_contacts c ON c.id=b.contact_id WHERE b.site_id=$1 AND b.status IN ('pending','confirmed') AND b.start_at>=NOW()-interval '1 hour' ORDER BY b.start_at LIMIT 5`, [id]),
          db(`SELECT e.id,e.message,e.status,e.created_at,c.name FROM link_enquiries e JOIN link_contacts c ON c.id=e.contact_id WHERE e.site_id=$1 ORDER BY e.id DESC LIMIT 5`, [id]),
          db(`SELECT 1 FROM link_promos WHERE site_id=$1 AND active LIMIT 1`, [id])]);
        return out(res, { orders: o.rows[0], bookings: bk.rows[0], enquiries: en.rows[0], contacts: ct.rows[0], traffic: vw.rows[0], latestOrders: lo.rows, nextBookings: lb.rows, latestEnquiries: le.rows, hasPromo: lp.rows.length > 0 });
      }
      /* ---- orders ---- */
      if (M === "GET" && path === "/api/link/orders") {
        const st = L.ORDER_FLOW.includes(q.get("status")) ? q.get("status") : q.get("status") === "open" ? "open" : "", s = "%" + clean(q.get("q")).toLowerCase().replace(/[%_]/g, "") + "%";
        const cond = st === "open" ? "AND o.status IN ('new','confirmed','preparing','ready')" : st ? "AND o.status=$3" : "";
        const r = await db(`SELECT o.id,o.code,o.items,o.subtotal::float subtotal,o.discount::float discount,o.delivery_fee::float delivery_fee,o.total::float total,o.promo,o.fulfilment,o.address,o.note,o.status,o.paid,o.owner_note,o.created_at,c.name,c.phone,c.email,c.id contact_id
          FROM link_orders o JOIN link_contacts c ON c.id=o.contact_id WHERE o.site_id=$1 AND (lower(c.name) LIKE $2 OR lower(o.code) LIKE $2 OR c.phone LIKE $2) ${cond} ORDER BY o.id DESC LIMIT 100`, st && st !== "open" ? [site.id, s, st] : [site.id, s]);
        return out(res, { orders: r.rows });
      }
      if (M === "PATCH" && path === "/api/link/order") {
        const sets = [], vals = [Number(b.orderId) || 0, site.id];
        if (b.status !== undefined) { if (!L.ORDER_FLOW.includes(b.status)) fail(400, "Unknown status."); vals.push(b.status); sets.push(`status=$${vals.length}`); }
        if (b.paid !== undefined) { vals.push(!!b.paid); sets.push(`paid=$${vals.length}`); }
        if (b.ownerNote !== undefined) { vals.push(L.text(b.ownerNote, 300)); sets.push(`owner_note=$${vals.length}`); }
        if (!sets.length) fail(400, "Nothing to update.");
        const r = await db(`UPDATE link_orders SET ${sets.join(",")},updated_at=NOW() WHERE id=$1 AND site_id=$2 RETURNING id,status,paid`, vals); if (!r.rows.length) fail(404, "Order not found.");
        return out(res, { order: r.rows[0] });
      }
      /* ---- bookings ---- */
      if (M === "GET" && path === "/api/link/bookings") {
        const w = q.get("when") === "past" ? "AND b.start_at<NOW()" : q.get("when") === "all" ? "" : "AND b.start_at>=NOW()-interval '2 hours'";
        const r = await db(`SELECT b.id,b.code,b.service_name,b.price::float price,b.start_at,b.duration,b.status,b.note,b.owner_note,b.created_at,c.name,c.phone,c.email,c.id contact_id FROM link_bookings b JOIN link_contacts c ON c.id=b.contact_id
          WHERE b.site_id=$1 ${w} ORDER BY ${q.get("when") === "past" ? "b.start_at DESC" : "b.start_at"} LIMIT 150`, [site.id]);
        return out(res, { bookings: r.rows.map(x => ({ ...x, when: fmtWhen(new Date(x.start_at).getTime()) })) });
      }
      if (M === "PATCH" && path === "/api/link/booking") {
        const sets = [], vals = [Number(b.bookingId) || 0, site.id];
        if (b.status !== undefined) { if (!L.BOOKING_FLOW.includes(b.status)) fail(400, "Unknown status."); vals.push(b.status); sets.push(`status=$${vals.length}`); }
        if (b.ownerNote !== undefined) { vals.push(L.text(b.ownerNote, 300)); sets.push(`owner_note=$${vals.length}`); }
        if (!sets.length) fail(400, "Nothing to update.");
        const r = await db(`UPDATE link_bookings SET ${sets.join(",")},updated_at=NOW() WHERE id=$1 AND site_id=$2 RETURNING id,status`, vals); if (!r.rows.length) fail(404, "Booking not found.");
        return out(res, { booking: r.rows[0] });
      }
      /* ---- enquiries ---- */
      if (M === "GET" && path === "/api/link/enquiries") {
        const st = L.ENQ_FLOW.includes(q.get("status")) ? q.get("status") : "";
        const r = await db(`SELECT e.id,e.message,e.item_name,e.status,e.created_at,c.name,c.phone,c.email,c.id contact_id FROM link_enquiries e JOIN link_contacts c ON c.id=e.contact_id WHERE e.site_id=$1 ${st ? "AND e.status=$2" : ""} ORDER BY e.id DESC LIMIT 100`, st ? [site.id, st] : [site.id]);
        return out(res, { enquiries: r.rows });
      }
      if (M === "PATCH" && path === "/api/link/enquiry") {
        if (!L.ENQ_FLOW.includes(b.status)) fail(400, "Unknown status.");
        const r = await db(`UPDATE link_enquiries SET status=$3,updated_at=NOW() WHERE id=$1 AND site_id=$2 RETURNING id,status`, [Number(b.enquiryId) || 0, site.id, b.status]); if (!r.rows.length) fail(404, "Enquiry not found.");
        return out(res, { enquiry: r.rows[0] });
      }
      /* ---- customers (CRM) ---- */
      if ((M === "GET") && (path === "/api/link/contacts" || path === "/api/link/contacts/export")) {
        const s = "%" + clean(q.get("q")).toLowerCase().replace(/[%_]/g, "") + "%", f = q.get("filter");
        const cond = { customers: "(orders>0 OR bookings>0)", leads: "(orders=0 AND bookings=0)", optin: "consent", repeat: "(orders+bookings>=2)" }[f] || "TRUE";
        const r = await db(`SELECT * FROM (SELECT c.id,c.name,c.phone,c.email,c.source,c.tags,c.notes,c.consent,c.first_at,c.last_at,
          (SELECT COUNT(*) FROM link_orders o WHERE o.contact_id=c.id AND o.status<>'cancelled')::int AS orders,(SELECT COALESCE(SUM(o.total),0) FROM link_orders o WHERE o.contact_id=c.id AND o.status<>'cancelled')::float AS spent,
          (SELECT COUNT(*) FROM link_bookings b WHERE b.contact_id=c.id AND b.status<>'cancelled')::int AS bookings,(SELECT COUNT(*) FROM link_enquiries e WHERE e.contact_id=c.id)::int AS enquiries
          FROM link_contacts c WHERE c.site_id=$1 AND (lower(c.name) LIKE $2 OR c.phone LIKE $2 OR lower(c.email) LIKE $2)) x WHERE ${cond} ORDER BY last_at DESC LIMIT ${path.endsWith("export") ? 5000 : 200}`, [site.id, s]);
        if (path.endsWith("export")) return out(res, { csv: L.toCsv([["name", "Name"], ["phone", "Phone"], ["email", "Email"], ["source", "Source"], ["orders", "Orders"], ["spent", "Total spent (NGN)"], ["bookings", "Bookings"], ["enquiries", "Enquiries"], ["consent", "OK to send offers"], ["tags", "Tags"], ["first", "First contact"], ["last", "Last contact"], ["notes", "Notes"]],
          r.rows.map(x => ({ ...x, consent: x.consent ? "Yes" : "No", tags: (x.tags || []).join("; "), first: new Date(x.first_at).toISOString().slice(0, 10), last: new Date(x.last_at).toISOString().slice(0, 10) }))) });
        return out(res, { contacts: r.rows });
      }
      if (M === "PATCH" && path === "/api/link/contact") {
        const tags = (Array.isArray(b.tags) ? b.tags : []).map(x => L.line(x, 20)).filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 8);
        const r = await db(`UPDATE link_contacts SET notes=COALESCE($3,notes),tags=COALESCE($4::text[],tags) WHERE id=$1 AND site_id=$2 RETURNING id`, [Number(b.contactId) || 0, site.id, b.notes === undefined ? null : L.text(b.notes, 1000), b.tags === undefined ? null : tags]);
        if (!r.rows.length) fail(404, "Customer not found."); return out(res, {});
      }
      /* ---- promo codes ---- */
      if (M === "GET" && path === "/api/link/promos") {
        const r = await db(`SELECT id,code,kind,value::float value,min_order::float min_order,max_uses,uses,expires_at,active,created_at FROM link_promos WHERE site_id=$1 ORDER BY id DESC LIMIT 100`, [site.id]);
        return out(res, { promos: r.rows });
      }
      if (M === "POST" && path === "/api/link/promo") {
        const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20), kind = b.kind === "fixed" ? "fixed" : "percent", value = L.price(b.value);
        if (code.length < 3) fail(400, "Use 3 to 20 letters or numbers for the code.");
        if (kind === "percent" ? !(value >= 1 && value <= 90) : !(value >= 1)) fail(400, kind === "percent" ? "Choose a discount between 1% and 90%." : "Enter the amount to take off.");
        const exp = b.expiresAt && L.dateStr(b.expiresAt) ? new Date(L.toMs(b.expiresAt, "23:59")) : null;
        const n = (await db(`SELECT COUNT(*)::int n FROM link_promos WHERE site_id=$1`, [site.id])).rows[0].n; if (n >= 50) fail(409, "You can have up to 50 promo codes.");
        try { await db(`INSERT INTO link_promos(site_id,code,kind,value,min_order,max_uses,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, [site.id, code, kind, value, L.price(b.minOrder), L.int(b.maxUses, 0, 100000, 0), exp]); }
        catch (e) { if (e.code === "23505") fail(409, "You already have a code called " + code + "."); throw e; }
        return out(res, {});
      }
      if (M === "PATCH" && path === "/api/link/promo") {
        const r = await db(`UPDATE link_promos SET active=$3 WHERE id=$1 AND site_id=$2 RETURNING id`, [Number(b.promoId) || 0, site.id, !!b.active]); if (!r.rows.length) fail(404, "Code not found."); return out(res, {});
      }
      /* ---- analytics ---- */
      if (M === "GET" && path === "/api/link/analytics") {
        const days = Math.min(90, Math.max(1, Number(q.get("days")) || 30)), id = site.id, W = `site_id=$1 AND day>CURRENT_DATE-$2::int`;
        const SUMS = `COALESCE(SUM(views),0)::int v,COALESCE(SUM(uniques),0)::int u,COALESCE(SUM(wa),0)::int w,COALESCE(SUM(calls),0)::int c,COALESCE(SUM(orders),0)::int o,COALESCE(SUM(enq),0)::int e,COALESCE(SUM(plc),0)::int p,COALESCE(SUM(bkg),0)::int b,COALESCE(SUM(mob),0)::int m`;
        const [tot, prev, daily, refs, items, rev, prevRev, dow, ost] = await Promise.all([
          db(`SELECT ${SUMS} FROM link_stats WHERE ${W}`, [id, days]),
          db(`SELECT ${SUMS} FROM link_stats WHERE site_id=$1 AND day<=CURRENT_DATE-$2::int AND day>CURRENT_DATE-($2::int*2)`, [id, days]),
          db(`SELECT day,views,uniques,enq,plc,bkg FROM link_stats WHERE ${W} ORDER BY day`, [id, days]),
          db(`SELECT host,SUM(n)::int n FROM link_refs WHERE ${W} GROUP BY host ORDER BY n DESC LIMIT 8`, [id, days]),
          db(`SELECT item_id,SUM(taps)::int taps,SUM(adds)::int adds,SUM(orders)::int orders FROM link_item_stats WHERE ${W} GROUP BY item_id ORDER BY SUM(orders)*3+SUM(adds)*2+SUM(taps) DESC LIMIT 8`, [id, days]),
          db(`SELECT COALESCE(SUM(total) FILTER(WHERE status<>'cancelled'),0)::float rev,COUNT(*) FILTER(WHERE status<>'cancelled')::int n,COUNT(*) FILTER(WHERE status='completed')::int done FROM link_orders WHERE site_id=$1 AND created_at>NOW()-make_interval(days=>$2::int)`, [id, days]),
          db(`SELECT COALESCE(SUM(total) FILTER(WHERE status<>'cancelled'),0)::float rev,COUNT(*) FILTER(WHERE status<>'cancelled')::int n FROM link_orders WHERE site_id=$1 AND created_at<=NOW()-make_interval(days=>$2::int) AND created_at>NOW()-make_interval(days=>$2::int*2)`, [id, days]),
          db(`SELECT EXTRACT(DOW FROM day)::int d,SUM(views)::int v FROM link_stats WHERE ${W} GROUP BY 1`, [id, days]),
          db(`SELECT status,COUNT(*)::int n FROM link_orders WHERE site_id=$1 AND created_at>NOW()-make_interval(days=>$2::int) GROUP BY status`, [id, days])]);
        const t = tot.rows[0], pv = prev.rows[0], names = {}; [...((site.published || site.draft).products || []), ...((site.published || site.draft).services || [])].forEach(x => { if (x.id) names[x.id] = x.name; });
        const actions = t.w + t.c + t.o + t.e + t.p + t.b;
        return out(res, { days, views: t.v, visitors: t.u, whatsappClicks: t.w, callClicks: t.c, orderClicks: t.o, daily: daily.rows, referrers: refs.rows,
          enquiries: t.e, ordersPlaced: t.p, bookings: t.b, mobileShare: t.v ? Math.round(t.m / t.v * 100) : 0, revenue: rev.rows[0].rev, revenueOrders: rev.rows[0].n, completed: rev.rows[0].done,
          conversion: t.u ? Math.round(Math.min(100, (t.p + t.b + t.e) / t.u * 100) * 10) / 10 : 0, engagement: t.u ? Math.round(Math.min(100, actions / t.u * 100)) : 0,
          previous: { views: pv.v, visitors: pv.u, enquiries: pv.e, ordersPlaced: pv.p, bookings: pv.b, revenue: prevRev.rows[0].rev },
          topItems: items.rows.map(x => ({ name: names[x.item_id] || "Removed item", taps: x.taps, adds: x.adds, orders: x.orders })), weekdays: dow.rows, orderStatus: ost.rows });
      }
      return send(res, 404, { success: false, message: "Route not found." });
    } catch (e) {
      if (e instanceof Fail) return send(res, e.code, { success: false, message: e.message, ...e.extra });
      if (e && e.expected && e.statusCode) return send(res, e.statusCode, { success: false, message: e.message });
      console.error("LINK ERROR", e && e.message); return send(res, 500, { success: false, message: "Something went wrong. Please try again." });
    }
  }

  async function adminRoutes(req, res, path, M, q) {
    const admin = await adminFromToken(req); if (!admin) return send(res, 401, { success: false, message: "Admin sign-in required." });
    if (M !== "GET") { const chk = await requireAdminCsrf(req); if (!chk.success) return send(res, chk.statusCode || 403, chk); }
    if (M === "GET" && path === "/api/admin/link/overview") {
      const [st, tp, rv, hub] = await Promise.all([
        db(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status<>'suspended' AND expires_at>NOW())::int active,COUNT(*) FILTER(WHERE status<>'suspended' AND expires_at<=NOW())::int expired,COUNT(*) FILTER(WHERE status='suspended')::int suspended,
          COUNT(*) FILTER(WHERE status<>'suspended' AND expires_at>NOW() AND expires_at<=NOW()+interval '7 days')::int expiring7,COUNT(*) FILTER(WHERE created_at>NOW()-interval '30 days')::int new30,COUNT(DISTINCT user_id)::int owners,COALESCE(SUM(paid_total),0) revenue FROM link_sites`),
        db(`SELECT COALESCE(draft->'theme'->>'template','atelier') t,COUNT(*)::int n FROM link_sites GROUP BY 1 ORDER BY n DESC`),
        db(`SELECT COALESCE(SUM(amount) FILTER(WHERE created_at>NOW()-interval '30 days'),0) r30,COUNT(*) FILTER(WHERE kind='renew')::int renewals FROM link_payments`),
        db(`SELECT (SELECT COUNT(*) FROM link_orders)::int orders,(SELECT COALESCE(SUM(total),0) FROM link_orders WHERE status<>'cancelled')::float order_value,(SELECT COUNT(*) FROM link_bookings)::int bookings,(SELECT COUNT(*) FROM link_enquiries)::int enquiries,(SELECT COUNT(*) FROM link_contacts)::int contacts,(SELECT COUNT(DISTINCT site_id) FROM link_orders WHERE created_at>NOW()-interval '30 days')::int shops30`)]);
      const x = st.rows[0];
      return send(res, 200, { success: true, stats: { total: x.total, active: x.active, expired: x.expired, suspended: x.suspended, expiring7: x.expiring7, new30: x.new30, owners: x.owners, revenue: Number(x.revenue), revenue30: Number(rv.rows[0].r30), renewals: rv.rows[0].renewals, hub: hub.rows[0] }, templates: tp.rows, settings: await cfg() });
    }
    if (M === "GET" && path === "/api/admin/link/sites") {
      const s = "%" + clean(q.get("q")).toLowerCase().replace(/[%_]/g, "") + "%", f = q.get("filter");
      const cond = f === "active" ? "AND s.status<>'suspended' AND s.expires_at>NOW()" : f === "expired" ? "AND s.status<>'suspended' AND s.expires_at<=NOW()" : f === "suspended" ? "AND s.status='suspended'" : f === "expiring" ? "AND s.status<>'suspended' AND s.expires_at>NOW() AND s.expires_at<=NOW()+interval '7 days'" : "";
      const r = await db(`SELECT s.id,s.username,s.user_id,s.status,s.expires_at,s.paid_total,s.published_at,s.created_at,COALESCE(s.draft->'theme'->>'template','atelier') template,s.draft->'brand'->>'name' name,u.email,u.name AS owner,
        (CASE WHEN s.status='suspended' THEN 'suspended' WHEN s.expires_at>NOW() THEN 'active' ELSE 'expired' END) state,(SELECT COUNT(*) FROM link_sites o WHERE o.user_id=s.user_id)::int AS owner_sites,
        COALESCE((SELECT SUM(views) FROM link_stats x WHERE x.site_id=s.id AND x.day>CURRENT_DATE-30),0)::int AS views30
        FROM link_sites s LEFT JOIN users u ON u.user_id=s.user_id WHERE (lower(s.username) LIKE $1 OR lower(COALESCE(u.email,'')) LIKE $1 OR lower(COALESCE(s.draft->'brand'->>'name','')) LIKE $1) ${cond} ORDER BY s.id DESC LIMIT 100`, [s]);
      return send(res, 200, { success: true, sites: r.rows.map(x => ({ ...x, url: `https://${x.username}.${DOMAIN}` })) });
    }
    if (M === "PATCH" && path === "/api/admin/link/site") {
      const b = await body(req), id = Number(b.id); if (!Number.isInteger(id)) fail(400, "Site is required.");
      if (b.status === "suspended" || b.status === "active") await db(`UPDATE link_sites SET status=$2,updated_at=NOW() WHERE id=$1`, [id, b.status]);
      const add = Math.round(Number(b.extendDays)); if (add > 0 && add <= 366) await db(`UPDATE link_sites SET expires_at=GREATEST(expires_at,NOW())+make_interval(days=>$2),updated_at=NOW() WHERE id=$1`, [id, add]);
      try { await db(`INSERT INTO admin_audit_logs(admin_id,action,target_type,target_id,details) VALUES($1,$2,'link_site',$3,$4::jsonb)`, [admin.id, "link.site.update", String(id), JSON.stringify({ id, status: b.status || null, extendDays: add || 0 })]); } catch {}
      return send(res, 200, { success: true });
    }
    if (M === "PATCH" && path === "/api/admin/link/settings") {
      const b = await body(req), set = (k, v) => db(`INSERT INTO platform_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`, [k, JSON.stringify(v)]);
      if (b.price !== undefined) await set("link_price", Math.max(0, Number(b.price) || 0));
      if (b.days !== undefined) await set("link_days", Math.min(366, Math.max(1, Math.round(Number(b.days)) || 100)));
      if (b.maxSites !== undefined) await set("link_max_sites", Math.min(100, Math.max(1, Math.round(Number(b.maxSites)) || 10)));
      if (b.enabled !== undefined) await set("link_enabled", !!b.enabled);
      return send(res, 200, { success: true, settings: await cfg() });
    }
    return send(res, 404, { success: false, message: "Route not found." });
  }

  /* ---------- public sites on *.boltiv.ng ---------- */
  const htmlHead = (res, code, extra) => res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src '${R.CLIENT_HASH}'; connect-src 'self'; base-uri 'none'; form-action 'none'`, ...extra });
  const isBot = ua => /bot|crawl|spider|preview|facebookexternalhit|slurp|headless|monitor|uptime/i.test(ua || "");
  function track(site, req, kind) {
    const ua = String(req.headers["user-agent"] || ""); if (isBot(ua)) return;
    bump(site.id, kind);
    if (kind !== "view") return;
    if (/Mobi|Android|iPhone/i.test(ua)) db(`UPDATE link_stats SET mob=mob+1 WHERE site_id=$1 AND day=CURRENT_DATE`, [site.id]).catch(() => {});
    const h = crypto.createHash("sha256").update(`${SALT}|${new Date().toISOString().slice(0, 10)}|${ipOf(req)}|${ua}`).digest("hex").slice(0, 24);
    db(`INSERT INTO link_visitors(site_id,day,h) VALUES($1,CURRENT_DATE,$2) ON CONFLICT DO NOTHING RETURNING 1`, [site.id, h]).then(r => { if (r.rows.length) return db(`UPDATE link_stats SET uniques=uniques+1 WHERE site_id=$1 AND day=CURRENT_DATE`, [site.id]); }).catch(() => {});
    try { const rh = new URL(req.headers.referer || "").hostname.replace(/^www\./, ""); if (rh && !rh.endsWith(DOMAIN)) db(`INSERT INTO link_refs(site_id,day,host,n) VALUES($1,CURRENT_DATE,$2,1) ON CONFLICT(site_id,day,host) DO UPDATE SET n=link_refs.n+1`, [site.id, rh.slice(0, 80)]).catch(() => {}); } catch {}
  }
  const pubJson = (res, code, data) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(data)); return true; };
  const IMG_SQL = { "": "data", s: "COALESCE(small,med,data)", m: "COALESCE(med,data)" }, IMG_MIME = { "": "mime", s: "COALESCE(small_mime,med_mime,mime)", m: "COALESCE(med_mime,mime)" };
  /* Public API of a customer website: enquiries, orders, bookings. Everything is checked against the PUBLISHED website, never against what the browser claims. */
  async function siteApi(req, res, site, cfgp, path, host) {
    const q = new URL(req.url, "http://x").searchParams, POST = req.method === "POST";
    if (POST) { let og = ""; try { og = new URL(req.headers.origin || "").host; } catch {} if (og !== host) return pubJson(res, 403, { success: false, message: "Request not allowed." }); }
    try {
      const rlk = path === "/_api/order" || path === "/_api/enquiry" || path === "/_api/book";
      const rl = rateLimit(req, "lnk-pub:" + site.id + (rlk ? ":w" : ":r"), rlk ? 8 : 150, 600000); if (!rl.allowed) return pubJson(res, 429, { success: false, message: "Too many requests. Please wait a few minutes and try again." });
      const now = Date.now(), promoRow = async (c, code) => (code ? (await c.query(`SELECT * FROM link_promos WHERE site_id=$1 AND code=$2${c === pool ? "" : " FOR UPDATE"}`, [site.id, String(code).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20)])).rows[0] : null);
      if (rlk) { const day = (await db(`SELECT (SELECT COUNT(*) FROM link_orders WHERE site_id=$1 AND created_at>NOW()-interval '1 day')+(SELECT COUNT(*) FROM link_enquiries WHERE site_id=$1 AND created_at>NOW()-interval '1 day')+(SELECT COUNT(*) FROM link_bookings WHERE site_id=$1 AND created_at>NOW()-interval '1 day') AS n`, [site.id])).rows[0].n; if (Number(day) >= 300) return pubJson(res, 429, { success: false, message: "This website is receiving a lot of requests. Please try again later." }); }

      if (req.method === "GET" && path === "/_api/slots") {
        const bk = cfgp.booking, date = L.dateStr(q.get("date")); if (!bk.on || !date) return pubJson(res, 400, { success: false, message: "Booking is not available." });
        const svc = L.bookableServices(cfgp).find(s => s.id === q.get("s")) || L.bookableServices(cfgp)[0], dur = svc.dur || bk.slot;
        const day0 = L.toMs(date, "00:00"), ex = (await db(`SELECT start_at,duration FROM link_bookings WHERE site_id=$1 AND status IN ('pending','confirmed') AND start_at>=$2 AND start_at<$3`, [site.id, new Date(day0), new Date(day0 + 86400000)])).rows.map(x => ({ s: new Date(x.start_at).getTime(), e: new Date(x.start_at).getTime() + x.duration * 60000 }));
        const slots = L.availableSlots(bk, date, dur, ex, now).map(x => ({ t: x.t, label: clockLabel(x.t) }));
        const today = L.todayLagos(now), reason = date < today ? "That date has passed." : date > L.addDays(today, bk.ahead) ? `Bookings open up to ${bk.ahead} days ahead.` : !bk.days.includes(L.weekday(date)) || bk.closed.includes(date) ? "We are closed on this day. Please pick another date." : "";
        return pubJson(res, 200, { success: true, slots, reason: slots.length ? "" : reason });
      }
      if (!POST) return pubJson(res, 404, { success: false, message: "Not found." });
      const b = await body(req);

      if (path === "/_api/hit") { const p = cfgp.products.find(x => x.id === String(b.id)); if (p && b.k === "add") itemStat(site.id, p.id, "adds"); return pubJson(res, 200, { success: true }); }
      if (path === "/_api/quote") {
        const promo = await promoRow(pool, b.code); let perr = ""; const lines = Array.isArray(b.lines) ? b.lines : [];
        const base = L.priceOrder(cfgp, lines, { fulfilment: b.ful }); if (base.error) return pubJson(res, 400, { success: false, message: base.error });
        let use = null; if (b.code) { perr = L.promoProblem(promo, base.subtotal, new Date(now)); if (!perr) use = promo; }
        const r = use ? L.priceOrder(cfgp, lines, { fulfilment: b.ful, promo: use }) : base;
        return pubJson(res, 200, { success: true, subtotal: r.subtotal, discount: r.discount, delivery: r.delivery, total: r.total, code: use ? use.code : "", promoError: perr });
      }
      if (path === "/_api/enquiry") {
        const sub = L.cleanSubmission(b); if (sub.website) return pubJson(res, 200, { success: true, message: "Thank you. Your message has been sent." });
        const err = L.submissionError(sub, true); if (err) return pubJson(res, 400, { success: false, message: err });
        await withTx(async c => { const cid = await upsertContact(c, site.id, sub, "enquiry"); await c.query(`INSERT INTO link_enquiries(site_id,contact_id,message,item_name) VALUES($1,$2,$3,$4)`, [site.id, cid, sub.message, L.line(b.item, 80)]); });
        bump(site.id, "enq"); try { await addNotification(site.user_id, "New enquiry", `${sub.name} sent an enquiry on ${site.username}.${DOMAIN}.`, "info"); } catch {}
        return pubJson(res, 200, { success: true, message: "Thank you. Your message has been sent and we will reply soon." });
      }
      if (path === "/_api/order") {
        const sub = L.cleanSubmission(b); if (sub.website) return pubJson(res, 200, { success: true, code: "OK", total: 0 });
        const err = L.submissionError(sub, false); if (err) return pubJson(res, 400, { success: false, message: err });
        const f = b.ful === "delivery" ? "delivery" : "pickup", address = L.text(b.address, 300); if (f === "delivery" && address.length < 6) return pubJson(res, 400, { success: false, message: "Please enter your delivery address." });
        const result = await withTx(async c => {
          const promo = await promoRow(c, b.code); let use = null;
          const pre = L.priceOrder(cfgp, b.lines, { fulfilment: f }); if (pre.error) fail(400, pre.error);
          if (b.code) { const pe = L.promoProblem(promo, pre.subtotal, new Date(now)); if (pe) fail(400, pe); use = promo; }
          const pr = use ? L.priceOrder(cfgp, b.lines, { fulfilment: f, promo: use }) : pre;
          if (use) { const u = await c.query(`UPDATE link_promos SET uses=uses+1 WHERE id=$1 AND (max_uses=0 OR uses<max_uses) RETURNING id`, [use.id]); if (!u.rows.length) fail(400, "This code has been fully used."); }
          const cid = await upsertContact(c, site.id, sub, "order"); let code = "", row = null;
          for (let n = 0; n < 6 && !row; n++) { code = L.orderCode(); row = (await c.query(`INSERT INTO link_orders(site_id,contact_id,code,items,subtotal,discount,delivery_fee,total,promo,fulfilment,address,note) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(site_id,code) DO NOTHING RETURNING id`,
            [site.id, cid, code, JSON.stringify(pr.items), pr.subtotal, pr.discount, pr.delivery, pr.total, use ? use.code : "", f, f === "delivery" ? address : "", L.text(b.note, 300)])).rows[0]; }
          if (!row) fail(500, "Could not place the order. Please try again.");
          return { code, pr };
        });
        bump(site.id, "plc"); result.pr.items.forEach(x => itemStat(site.id, x.id, "orders"));
        try { await addNotification(site.user_id, "New order " + result.code, `${sub.name} ordered ${naira(result.pr.total)} on ${site.username}.${DOMAIN}.`, "success"); } catch {}
        return pubJson(res, 200, { success: true, code: result.code, total: result.pr.total });
      }
      if (path === "/_api/book") {
        const sub = L.cleanSubmission(b); if (sub.website) return pubJson(res, 200, { success: true, status: "pending", message: "Request received.", service: "", when: "", code: "OK" });
        const err = L.submissionError(sub, false); if (err) return pubJson(res, 400, { success: false, message: err });
        const bk = cfgp.booking, date = L.dateStr(b.date), time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time)) ? String(b.time) : ""; if (!bk.on || !date || !time) return pubJson(res, 400, { success: false, message: "Please choose a date and time." });
        const svc = L.bookableServices(cfgp).find(s => s.id === String(b.svc)); if (!svc) return pubJson(res, 400, { success: false, message: "Please choose a service." });
        const dur = Math.max(bk.slot, Math.ceil((svc.dur || bk.slot) / bk.slot) * bk.slot);
        const result = await withTx(async c => {
          await c.query(`SELECT pg_advisory_xact_lock($1)`, [Number(site.id)]);
          const day0 = L.toMs(date, "00:00"), ex = (await c.query(`SELECT start_at,duration FROM link_bookings WHERE site_id=$1 AND status IN ('pending','confirmed') AND start_at>=$2 AND start_at<$3`, [site.id, new Date(day0), new Date(day0 + 86400000)])).rows.map(x => ({ s: new Date(x.start_at).getTime(), e: new Date(x.start_at).getTime() + x.duration * 60000 }));
          const ok = L.availableSlots(bk, date, svc.dur || bk.slot, ex, now).find(x => x.t === time); if (!ok) fail(409, "Sorry, that time is no longer available. Please choose another.");
          const cid = await upsertContact(c, site.id, sub, "booking"), code = L.orderCode(), status = bk.auto ? "confirmed" : "pending";
          await c.query(`INSERT INTO link_bookings(site_id,contact_id,code,service_id,service_name,price,start_at,duration,status,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [site.id, cid, code, svc.id, svc.name, svc.price || 0, new Date(ok.ms), dur, status, L.text(b.note, 300)]);
          return { code, status, when: fmtWhen(ok.ms) };
        });
        bump(site.id, "bkg"); try { await addNotification(site.user_id, "New booking", `${sub.name} booked ${svc.name} for ${result.when} on ${site.username}.${DOMAIN}.`, "success"); } catch {}
        return pubJson(res, 200, { success: true, status: result.status, code: result.code, service: svc.name, when: result.when, message: result.status === "confirmed" ? `You are booked for ${result.when}. Your reference is ${result.code}.` : `Your request for ${result.when} has been received (reference ${result.code}). We will contact you to confirm.` });
      }
      return pubJson(res, 404, { success: false, message: "Not found." });
    } catch (e) {
      if (e instanceof Fail) return pubJson(res, e.code, { success: false, message: e.message });
      if (e && e.expected && e.statusCode) return pubJson(res, e.statusCode, { success: false, message: e.message });
      console.error("LINK PUBLIC ERROR", e && e.message); return pubJson(res, 500, { success: false, message: "Something went wrong. Please try again." });
    }
  }
  /* returns true when the request belongs to a BOLTIV Link host and has been answered */
  async function serveSite(req, res) {
    const host = String(req.headers.host || "").toLowerCase().split(":")[0];
    if (!host.endsWith("." + DOMAIN) || host === "www." + DOMAIN) return false; // apex + www stay on GitHub Pages
    const user = host.slice(0, -(DOMAIN.length + 1));
    if (L.RESERVED.has(user) || user.includes(".")) return false; // api., mail., etc. are never customer sites
    try {
      await ensureTables();
      const path = new URL(req.url, "http://x").pathname;
      if (req.method !== "GET" && req.method !== "HEAD" && !(req.method === "POST" && path.startsWith("/_api/"))) { res.writeHead(405); res.end(); return true; }
      const site = L.validateUsername(user) ? null : (await db(`SELECT * FROM link_sites WHERE username=$1`, [user])).rows[0];
      if (!site) { htmlHead(res, 404, { "Cache-Control": "no-store" }); res.end(R.page("This name is available", "No website lives here yet. Claim it for your business in minutes.", `<a href="${FRONT}/link">Create your website</a>`)); return true; }
      const state = L.siteState(site, new Date());
      if (state !== "active" || !site.published) {
        if (path.startsWith("/_api/")) return pubJson(res, 503, { success: false, message: "This website is not accepting requests right now." });
        htmlHead(res, 503, { "Retry-After": "86400", "Cache-Control": "no-store" });
        res.end(state === "active" ? R.page("Coming soon", "This website is being set up. Please check back soon.") : state === "suspended" ? R.page("Website unavailable", "This website is currently unavailable.") : R.page("Temporarily unavailable", "This website is temporarily unavailable. The owner can restore it at any time.")); return true;
      }
      const m = /^\/_i\/(\d{1,12})(?:\/(s|m))?$/.exec(path);
      if (m) {
        const v = m[2] || "", r = (await db(`SELECT ${IMG_MIME[v]} AS mime,${IMG_SQL[v]} AS data FROM link_images WHERE id=$1 AND site_id=$2`, [m[1], site.id])).rows[0];
        if (!r) { res.writeHead(404); res.end(); return true; }
        res.writeHead(200, { "Content-Type": r.mime, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Content-Length": r.data.length }); res.end(r.data); return true;
      }
      const cfgp = L.sanitizeConfig(site.published, site.published), c = cfgp.contact, g = /^\/_go\/(wa|call|order|book)$/.exec(path);
      if (path.startsWith("/_api/")) return await siteApi(req, res, site, cfgp, path, String(req.headers.host || "").toLowerCase());
      if (g) {
        const kind = g[1], i = Number(new URL(req.url, "http://x").searchParams.get("i")), nm = cfgp.brand.name || user;
        track(site, req, kind === "book" ? "wa" : kind);
        const wa = c.whatsapp || c.phone; let to = "/";
        const it = kind === "order" ? cfgp.products[i] : kind === "book" ? cfgp.services[i] : null; if (it && !isBot(String(req.headers["user-agent"] || ""))) itemStat(site.id, it.id, "taps");
        if (kind === "call" && c.phone) to = "tel:+" + c.phone;
        else if (wa) { const msg = it ? `Hello ${nm}, I would like to ${kind === "order" ? "order" : "book"} ${it.name}${it.price ? " (₦" + it.price.toLocaleString("en-NG") + ")" : ""}.` : (c.greeting || `Hello ${nm}, I found you on your website.`);
          to = `https://wa.me/${wa}?text=${encodeURIComponent(msg)}`; }
        res.writeHead(302, { Location: to, "Cache-Control": "no-store" }); res.end(); return true;
      }
      if (path === "/robots.txt") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end(`User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`); return true; }
      if (path === "/sitemap.xml") { res.writeHead(200, { "Content-Type": "application/xml" }); res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${host}/</loc></url></urlset>`); return true; }
      if (path !== "/") { htmlHead(res, 404, { "Cache-Control": "no-store" }); res.end(R.page("Page not found", "That page does not exist.", `<a href="/">Go to homepage</a>`)); return true; }
      track(site, req, "view");
      htmlHead(res, 200, { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" });
      res.end(req.method === "HEAD" ? "" : R.render(cfgp, { origin: `https://${host}`, key: site.username, dims: await loadDims(site.id, L.imageIds(cfgp).map(Number)) })); return true;
    } catch (e) { console.error("LINK SERVE ERROR", e && e.message); try { htmlHead(res, 500, {}); res.end(R.page("Something went wrong", "Please try again in a moment.")); } catch {} return true; }
  }
  async function serveImagePublic(req, res, id, v) { /* API-host image for dashboard previews */
    await ensureTables(); v = v === "s" || v === "m" ? v : "";
    const r = (await db(`SELECT ${IMG_MIME[v].replace(/\b(small_mime|med_mime|mime)\b/g, "i.$1")} AS mime,${IMG_SQL[v].replace(/\b(small|med|data)\b/g, "i.$1")} AS data FROM link_images i JOIN link_sites s ON s.id=i.site_id WHERE i.id=$1 AND s.status<>'suspended'`, [id])).rows[0];
    if (!r) { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { "Content-Type": r.mime, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "cross-origin", "Content-Length": r.data.length }); res.end(r.data); return true;
  }

  /* ---------- expiry sweep: status flag + reminders (7 days, 1 day, expired). Access itself never depends on this. ---------- */
  async function sweep() {
    await ensureTables();
    await db(`UPDATE link_sites SET status='expired',updated_at=NOW() WHERE status='active' AND expires_at<=NOW()`);
    await db(`UPDATE link_sites SET status='active',updated_at=NOW() WHERE status='expired' AND expires_at>NOW()`);
    const rows = (await db(`SELECT id,user_id,username,expires_at FROM link_sites WHERE status<>'suspended' AND expires_at<=NOW()+interval '7 days' AND expires_at>NOW()-interval '30 days'`)).rows;
    const now = new Date();
    for (const s of rows) {
      const left = L.daysLeft(s.expires_at, now), key = `link:${s.id}:${new Date(s.expires_at).toISOString().slice(0, 10)}`;
      try {
        if (new Date(s.expires_at) <= now) await addNotificationOnce(s.user_id, "Your website is offline", `${s.username}.${DOMAIN} is temporarily offline. Renew to bring it back; nothing has been deleted.`, "warning", key + ":x");
        else if (left <= 1) await addNotificationOnce(s.user_id, "Website expires tomorrow", `${s.username}.${DOMAIN} goes offline within a day. Renew now to stay online.`, "warning", key + ":1");
        else await addNotificationOnce(s.user_id, "Website expires soon", `${s.username}.${DOMAIN} expires in ${left} days. Renew from your dashboard.`, "info", key + ":7");
      } catch {}
    }
  }
  function startTimers() { sweep().catch(() => {}); setInterval(() => sweep().catch(e => console.error("LINK SWEEP", e && e.message)), 30 * 60 * 1000).unref(); }
  return { handle, serveSite, serveImagePublic, startTimers, ensureTables };
};
