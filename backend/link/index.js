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
    const [en, pr, dy, mx] = await Promise.all([g("link_enabled", true), g("link_price", 5000), g("link_days", 30), g("link_max_sites", 10)]);
    return { enabled: en !== false && en !== "false", price: Math.max(0, Number(pr) || 5000), days: Math.min(366, Math.max(1, Math.round(Number(dy)) || 30)), maxSites: Math.min(100, Math.max(1, Math.round(Number(mx)) || 10)) };
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
        return out(res, { draft, samples: L.sampleCount(draft) });
      }
      if (M === "POST" && path === "/api/link/preview") {
        const rl = rateLimit(req, "link-prev:" + uid, 240, 600000); if (!rl.allowed) return rateLimitedResponse(res, rl);
        const c = L.sanitizeConfig(b.config, site.draft);
        return out(res, { html: R.render(c, { preview: true, imgBase: `${API_BASE}/api/link/img/`, noindex: true }) });
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
        if (agg.n >= 120 || Number(agg.s) + im.buf.length > 24 * 1024 * 1024) fail(409, "Image storage is full for this website.");
        const r = await db(`INSERT INTO link_images(site_id,mime,data,size) VALUES($1,$2,$3,$4) RETURNING id`, [site.id, im.mime, im.buf, im.buf.length]);
        return out(res, { id: String(r.rows[0].id) });
      }
      if (M === "GET" && path === "/api/link/analytics") {
        const days = Math.min(90, Math.max(1, Number(q.get("days")) || 30));
        const [tot, daily, refs] = await Promise.all([
          db(`SELECT COALESCE(SUM(views),0)::int v,COALESCE(SUM(uniques),0)::int u,COALESCE(SUM(wa),0)::int w,COALESCE(SUM(calls),0)::int c,COALESCE(SUM(orders),0)::int o FROM link_stats WHERE site_id=$1 AND day>CURRENT_DATE-$2::int`, [site.id, days]),
          db(`SELECT day,views,uniques FROM link_stats WHERE site_id=$1 AND day>CURRENT_DATE-$2::int ORDER BY day`, [site.id, days]),
          db(`SELECT host,SUM(n)::int n FROM link_refs WHERE site_id=$1 AND day>CURRENT_DATE-$2::int GROUP BY host ORDER BY n DESC LIMIT 8`, [site.id, days])]);
        const t = tot.rows[0];
        return out(res, { days, views: t.v, visitors: t.u, whatsappClicks: t.w, callClicks: t.c, orderClicks: t.o, daily: daily.rows, referrers: refs.rows });
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
      const [st, tp, rv] = await Promise.all([
        db(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status<>'suspended' AND expires_at>NOW())::int active,COUNT(*) FILTER(WHERE status<>'suspended' AND expires_at<=NOW())::int expired,COUNT(*) FILTER(WHERE status='suspended')::int suspended,
          COUNT(*) FILTER(WHERE status<>'suspended' AND expires_at>NOW() AND expires_at<=NOW()+interval '7 days')::int expiring7,COUNT(*) FILTER(WHERE created_at>NOW()-interval '30 days')::int new30,COUNT(DISTINCT user_id)::int owners,COALESCE(SUM(paid_total),0) revenue FROM link_sites`),
        db(`SELECT COALESCE(draft->'theme'->>'template','atelier') t,COUNT(*)::int n FROM link_sites GROUP BY 1 ORDER BY n DESC`),
        db(`SELECT COALESCE(SUM(amount) FILTER(WHERE created_at>NOW()-interval '30 days'),0) r30,COUNT(*) FILTER(WHERE kind='renew')::int renewals FROM link_payments`)]);
      const x = st.rows[0];
      return send(res, 200, { success: true, stats: { total: x.total, active: x.active, expired: x.expired, suspended: x.suspended, expiring7: x.expiring7, new30: x.new30, owners: x.owners, revenue: Number(x.revenue), revenue30: Number(rv.rows[0].r30), renewals: rv.rows[0].renewals }, templates: tp.rows, settings: await cfg() });
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
      if (b.days !== undefined) await set("link_days", Math.min(366, Math.max(1, Math.round(Number(b.days)) || 30)));
      if (b.maxSites !== undefined) await set("link_max_sites", Math.min(100, Math.max(1, Math.round(Number(b.maxSites)) || 10)));
      if (b.enabled !== undefined) await set("link_enabled", !!b.enabled);
      return send(res, 200, { success: true, settings: await cfg() });
    }
    return send(res, 404, { success: false, message: "Route not found." });
  }

  /* ---------- public sites on *.boltiv.ng ---------- */
  const htmlHead = (res, code, extra) => res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'", ...extra });
  const isBot = ua => /bot|crawl|spider|preview|facebookexternalhit|slurp|headless|monitor|uptime/i.test(ua || "");
  function track(site, req, kind) {
    const ua = String(req.headers["user-agent"] || ""); if (isBot(ua)) return;
    const col = { view: "views", wa: "wa", call: "calls", order: "orders" }[kind];
    db(`INSERT INTO link_stats(site_id,day,${col}) VALUES($1,CURRENT_DATE,1) ON CONFLICT(site_id,day) DO UPDATE SET ${col}=link_stats.${col}+1`, [site.id]).catch(() => {});
    if (kind !== "view") return;
    const h = crypto.createHash("sha256").update(`${SALT}|${new Date().toISOString().slice(0, 10)}|${ipOf(req)}|${ua}`).digest("hex").slice(0, 24);
    db(`INSERT INTO link_visitors(site_id,day,h) VALUES($1,CURRENT_DATE,$2) ON CONFLICT DO NOTHING RETURNING 1`, [site.id, h]).then(r => { if (r.rows.length) return db(`UPDATE link_stats SET uniques=uniques+1 WHERE site_id=$1 AND day=CURRENT_DATE`, [site.id]); }).catch(() => {});
    try { const rh = new URL(req.headers.referer || "").hostname.replace(/^www\./, ""); if (rh && !rh.endsWith(DOMAIN)) db(`INSERT INTO link_refs(site_id,day,host,n) VALUES($1,CURRENT_DATE,$2,1) ON CONFLICT(site_id,day,host) DO UPDATE SET n=link_refs.n+1`, [site.id, rh.slice(0, 80)]).catch(() => {}); } catch {}
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
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return true; }
      const site = L.validateUsername(user) ? null : (await db(`SELECT * FROM link_sites WHERE username=$1`, [user])).rows[0];
      if (!site) { htmlHead(res, 404, { "Cache-Control": "no-store" }); res.end(R.page("This name is available", "No website lives here yet. Claim it for your business in minutes.", `<a href="${FRONT}/link">Create your website</a>`)); return true; }
      const state = L.siteState(site, new Date());
      if (state !== "active" || !site.published) {
        htmlHead(res, 503, { "Retry-After": "86400", "Cache-Control": "no-store" });
        res.end(state === "active" ? R.page("Coming soon", "This website is being set up. Please check back soon.") : state === "suspended" ? R.page("Website unavailable", "This website is currently unavailable.") : R.page("Temporarily unavailable", "This website is temporarily unavailable. The owner can restore it at any time.")); return true;
      }
      const m = /^\/_i\/(\d{1,12})$/.exec(path);
      if (m) {
        const r = (await db(`SELECT mime,data FROM link_images WHERE id=$1 AND site_id=$2`, [m[1], site.id])).rows[0];
        if (!r) { res.writeHead(404); res.end(); return true; }
        res.writeHead(200, { "Content-Type": r.mime, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Content-Length": r.data.length }); res.end(r.data); return true;
      }
      const cfgp = L.sanitizeConfig(site.published, site.published), c = cfgp.contact, g = /^\/_go\/(wa|call|order|book)$/.exec(path);
      if (g) {
        const kind = g[1], i = Number(new URL(req.url, "http://x").searchParams.get("i")), nm = cfgp.brand.name || user;
        track(site, req, kind === "book" ? "wa" : kind);
        const wa = c.whatsapp || c.phone; let to = "/";
        if (kind === "call" && c.phone) to = "tel:+" + c.phone;
        else if (wa) { const it = kind === "order" ? cfgp.products[i] : kind === "book" ? cfgp.services[i] : null;
          const msg = it ? `Hello ${nm}, I would like to ${kind === "order" ? "order" : "book"} ${it.name}${it.price ? " (₦" + it.price.toLocaleString("en-NG") + ")" : ""}.` : `Hello ${nm}, I found you on your website.`;
          to = `https://wa.me/${wa}?text=${encodeURIComponent(msg)}`; }
        res.writeHead(302, { Location: to, "Cache-Control": "no-store" }); res.end(); return true;
      }
      if (path === "/robots.txt") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end(`User-agent: *\nAllow: /\nSitemap: https://${host}/sitemap.xml\n`); return true; }
      if (path === "/sitemap.xml") { res.writeHead(200, { "Content-Type": "application/xml" }); res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${host}/</loc></url></urlset>`); return true; }
      if (path !== "/") { htmlHead(res, 404, { "Cache-Control": "no-store" }); res.end(R.page("Page not found", "That page does not exist.", `<a href="/">Go to homepage</a>`)); return true; }
      track(site, req, "view");
      htmlHead(res, 200, { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" });
      res.end(req.method === "HEAD" ? "" : R.render(cfgp, { origin: `https://${host}` })); return true;
    } catch (e) { console.error("LINK SERVE ERROR", e && e.message); try { htmlHead(res, 500, {}); res.end(R.page("Something went wrong", "Please try again in a moment.")); } catch {} return true; }
  }
  async function serveImagePublic(req, res, id) { /* API-host image for dashboard previews */
    await ensureTables();
    const r = (await db(`SELECT i.mime,i.data FROM link_images i JOIN link_sites s ON s.id=i.site_id WHERE i.id=$1 AND s.status<>'suspended'`, [id])).rows[0];
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
