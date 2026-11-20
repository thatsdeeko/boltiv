"use strict";
/* BOLTIV Link: pure helpers (username rules, templates, config sanitising, expiry maths, order pricing, booking slots, CRM keys). No I/O, unit-tested. */
const crypto = require("node:crypto");
const { TEMPLATES } = require("./templates");
const RESERVED = new Set(["www","api","app","admin","mail","email","smtp","ftp","ns1","ns2","cdn","static","assets","img","images","blog","help","support","billing","pay","payments","login","signin","signup","register","account","dashboard","boltiv","boltivlink","link","links","status","dev","staging","test","demo","root","security","cpanel","webmail","wallet","cards","agent","agents","business","shop","store","official","team","info","contact","sales","careers","press","legal","terms","privacy","send","resend","em","m","mobile","web","portal","docs","imap","pop","pop3","autodiscover","pages","railway","github","ns","dns","vpn","git","new","edit","preview","go","u","s","r"]);
/* Google Fonts families. Each entry lists only weights that really exist, because Google rejects requests for missing weights. */
const FONTS = {
  "Playfair Display": "Playfair+Display:wght@400;600;700", "Cormorant Garamond": "Cormorant+Garamond:wght@500;600;700", "DM Serif Display": "DM+Serif+Display",
  "Fraunces": "Fraunces:wght@500;600;700", "Syne": "Syne:wght@600;700;800", "Space Grotesk": "Space+Grotesk:wght@500;700", "Montserrat": "Montserrat:wght@400;500;600;700",
  "Poppins": "Poppins:wght@400;500;600;700", "Outfit": "Outfit:wght@400;500;600;700", "Manrope": "Manrope:wght@400;600;700;800",
  "Inter": "Inter:wght@400;500;600;700", "DM Sans": "DM+Sans:wght@400;500;700", "Nunito": "Nunito:wght@400;600;700", "Lora": "Lora:wght@400;600;700",
  "Instrument Serif": "Instrument+Serif", "Sora": "Sora:wght@400;600;700;800", "Plus Jakarta Sans": "Plus+Jakarta+Sans:wght@400;500;700;800",
  "Bricolage Grotesque": "Bricolage+Grotesque:wght@500;700;800", "Libre Baskerville": "Libre+Baskerville:wght@400;700", "Josefin Sans": "Josefin+Sans:wght@400;600;700",
  "Archivo": "Archivo:wght@400;600;800", "Bebas Neue": "Bebas+Neue", "Marcellus": "Marcellus"
};
const HEAD_WEIGHT = { "Playfair Display": 600, "Cormorant Garamond": 600, "DM Serif Display": 400, "Fraunces": 600, "Syne": 700, "Space Grotesk": 700, "Montserrat": 700, "Poppins": 600, "Outfit": 600, "Manrope": 800, "Inter": 700, "DM Sans": 700, "Nunito": 700, "Lora": 600,
  "Instrument Serif": 400, "Sora": 700, "Plus Jakarta Sans": 800, "Bricolage Grotesque": 700, "Libre Baskerville": 700, "Josefin Sans": 700, "Archivo": 800, "Bebas Neue": 400, "Marcellus": 400 };
const SERIF = new Set(["Playfair Display", "Cormorant Garamond", "DM Serif Display", "Fraunces", "Lora", "Instrument Serif", "Libre Baskerville", "Marcellus"]);
const BODY_FONTS = ["Inter", "DM Sans", "Nunito", "Manrope", "Lora", "Outfit", "Poppins", "Plus Jakarta Sans", "Josefin Sans", "Archivo", "Sora"];
/* Section keys. The first seven are the original sections (shown by default on older sites); the rest are new and start hidden on older sites. */
const LEGACY_KEYS = ["highlights", "products", "services", "about", "gallery", "testimonials", "contact"];
const SECTION_KEYS = ["highlights", "products", "services", "about", "gallery", "testimonials", "contact", "stats", "booking", "faq", "enquiry", "cta", "blk1", "blk2", "blk3"];
const BG_TYPES = ["color", "gradient", "image"];
const OPT = {
  hero: ["auto", "full", "center", "split", "type", "minimal"], prod: ["auto", "portrait", "card", "menu", "rows", "numbered", "tile"], svc: ["auto", "card", "menu", "rows", "numbered", "tile"],
  gal: ["auto", "grid", "mosaic", "scroll"], tm: ["auto", "cards", "large"], nav: ["auto", "bar", "center"], btn: ["auto", "pill", "soft", "square"], card: ["auto", "line", "soft", "raised"], density: ["auto", "compact", "cozy", "airy"], cols: ["auto", "2", "3", "4"], fit: ["auto", "cover", "contain"]
};
const ACTIONS = ["auto", "whatsapp", "shop", "book", "call", "enquire", "none"];
const BADGES = ["", "new", "hot", "sale", "limited", "best"];
const SLOT_SIZES = [15, 30, 45, 60, 90, 120];
const pick = (v, list, fb) => (list.includes(String(v)) ? String(v) : fb);

function normUsername(v) { return String(v == null ? "" : v).trim().toLowerCase(); }
function validateUsername(v) {
  const u = normUsername(v);
  if (u.length < 3 || u.length > 30) return "Use 3 to 30 characters.";
  if (!/^[a-z0-9-]+$/.test(u)) return "Use only letters, numbers and hyphens.";
  if (/^-|-$/.test(u)) return "A name cannot start or end with a hyphen.";
  if (u.includes("--")) return "A name cannot contain two hyphens in a row.";
  if (RESERVED.has(u)) return "This name is reserved. Please choose another.";
  return "";
}
const text = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/\s+\n/g, "\n").trim().slice(0, max);
const line = (v, max) => text(v, max).replace(/\s+/g, " ");
const color = (v, fb) => (/^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v).toLowerCase() : fb);
const price = v => { const n = Number(String(v == null ? "" : v).replace(/[^\d.]/g, "")); return Number.isFinite(n) && n >= 0 && n <= 1e9 ? Math.round(n * 100) / 100 : 0; };
const imgId = v => (/^\d{1,12}$/.test(String(v == null ? "" : v)) ? String(v) : "");
const flag = v => (v === 1 || v === true || v === "1" || v === "true" ? 1 : 0);
const flagOr = (v, d) => (v === undefined ? (d ? 1 : 0) : flag(v));
const int = (v, lo, hi, fb) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb; };
function phone(v) {
  let d = String(v == null ? "" : v).replace(/\D/g, "");
  if (d.startsWith("0") && d.length === 11) d = "234" + d.slice(1);
  return d.length >= 10 && d.length <= 15 ? d : "";
}
const handle = v => String(v == null ? "" : v).trim().replace(/^https?:\/\/[^/]+\//i, "").replace(/^@/, "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
const emailOk = v => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(String(v || "").trim());
const dateStr = v => { const s = String(v || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return ""; const d = new Date(s + "T00:00:00Z"); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : ""; };
const hhmm = (v, fb) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "")) ? String(v) : fb);
const itemId = v => (/^[a-z0-9]{4,12}$/.test(String(v || "")) ? String(v) : "");
const fid = (key, idx, name) => "x" + crypto.createHash("sha1").update(key + ":" + idx + ":" + name).digest("hex").slice(0, 7);

/* ---------- templates ---------- */
const TEMPLATE_IDS = Object.keys(TEMPLATES);
const SECTION_DEFAULT_LABEL = { products: "Products", services: "Services", about: "About us", gallery: "Gallery", contact: "Contact", highlights: "Why choose us", testimonials: "What clients say", stats: "In numbers", booking: "Book an appointment", faq: "Questions", enquiry: "Send an enquiry", cta: "", blk1: "", blk2: "", blk3: "" };
const SHOP0 = { on: 0, pickup: 1, delivery: 1, fee: 0, free: 0, min: 0, note: "" };
const BOOK0 = { on: 0, days: [1, 2, 3, 4, 5, 6], open: "09:00", close: "17:00", slot: 60, cap: 1, lead: 2, ahead: 30, closed: [], auto: 0, note: "" };
const ANN0 = { on: 0, text: "", action: "none", label: "", until: "" };
const CTA0 = { title: "", text: "", action: "auto", label: "", s: 0 };
const BASE = {
  theme: { template: "atelier", primary: "#b08d57", accent: "#1a1a1a", bg: "#faf7f2", text: "#1a1a1a", headFont: "Playfair Display", bodyFont: "Inter", radius: 2, bgType: "color", bgGradientTo: "#faf7f2", bgImage: "", overlay: 45,
    hero: "auto", prod: "auto", svc: "auto", gal: "auto", tm: "auto", nav: "auto", btn: "auto", card: "auto", density: "auto", cols: "auto", fit: "auto", scale: 100 },
  brand: { name: "", headline: "", tagline: "", about: "", logo: "", hero: "", tagS: 0, aboutS: 0, headS: 0, ctaA: "auto", ctaB: "auto", ctaLabel: "" },
  labels: {}, order: SECTION_KEYS.slice(), sections: { highlights: true, products: true, services: true, about: true, gallery: true, testimonials: true, contact: true, stats: false, booking: false, faq: false, enquiry: false, cta: false, blk1: false, blk2: false, blk3: false },
  contact: { phone: "", whatsapp: "", email: "", address: "", hours: "", instagram: "", facebook: "", tiktok: "", x: "", greeting: "" }, seo: { title: "", description: "" },
  announce: ANN0, shop: SHOP0, booking: BOOK0, cta: CTA0, stats: [], faq: [], blocks: []
};
const DEFAULT_CONFIG = BASE;
const LIMITS = { products: 100, services: 40, gallery: 36, highlights: 6, testimonials: 8, faq: 12, stats: 4, blocks: 3, extraImages: 7, options: 10 };

function sanitizeBooking(b, d) {
  const x = b && typeof b === "object" ? b : {}, y = d && typeof d === "object" ? d : BOOK0;
  const days = Array.isArray(x.days) ? [...new Set(x.days.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 7))].sort() : (Array.isArray(y.days) ? y.days : BOOK0.days);
  let open = hhmm(x.open, hhmm(y.open, BOOK0.open)), close = hhmm(x.close, hhmm(y.close, BOOK0.close));
  if (open >= close) { open = BOOK0.open; close = BOOK0.close; }
  const slot = SLOT_SIZES.includes(Number(x.slot)) ? Number(x.slot) : (SLOT_SIZES.includes(Number(y.slot)) ? Number(y.slot) : 60);
  return { on: flagOr(x.on, y.on), days, open, close, slot, cap: int(x.cap ?? y.cap, 1, 20, 1), lead: int(x.lead ?? y.lead, 0, 72, 2), ahead: int(x.ahead ?? y.ahead, 1, 90, 30),
    closed: (Array.isArray(x.closed) ? x.closed : (Array.isArray(y.closed) ? y.closed : [])).map(dateStr).filter((s, i, a) => s && a.indexOf(s) === i).sort().slice(0, 40), auto: flagOr(x.auto, y.auto), note: line(x.note ?? y.note, 200) };
}
function templateConfig(id, name) {
  const t = TEMPLATES[id] || TEMPLATES.atelier, pal = t.palettes[0], nm = line(name, 60);
  const it = (a, svc) => a.map(x => svc ? ({ name: x[0], price: x[1], desc: x[2], dur: x[3] || 60, image: "", available: true, book: 1, s: 1 }) : ({ name: x[0], price: x[1], desc: x[2], cat: x[3] || "", badge: x[4] || "", old: x[5] || 0, image: "", available: true, s: 1 }));
  return sanitizeConfig({
    theme: { template: t.id, primary: pal.primary, accent: pal.accent, bg: pal.bg, text: pal.text, headFont: t.theme.headFont, bodyFont: t.theme.bodyFont, radius: t.theme.radius, bgType: "color", bgGradientTo: pal.to },
    brand: { name: nm, tagline: t.tagline, about: t.about, tagS: 1, aboutS: 1 },
    labels: t.labels, order: t.order, sections: Object.fromEntries(SECTION_KEYS.map(k => [k, t.on.includes(k) || (k === "booking" && !!(t.booking && t.booking.on))])),
    products: it(t.products), services: it(t.services, 1), highlights: t.highlights.map(h => ({ title: h[0], desc: h[1], s: 1 })), testimonials: t.testimonials.map(q => ({ quote: q[0], name: q[1], s: 1 })), gallery: [],
    stats: t.stats.map(s => ({ value: s[0], label: s[1], s: 1 })), faq: t.faq.map(f => ({ q: f[0], a: f[1], s: 1 })), cta: { title: t.cta.title, text: t.cta.text, s: 1 },
    shop: Object.assign({}, SHOP0, t.shop || {}), booking: Object.assign({}, BOOK0, t.booking || {}), announce: ANN0, blocks: []
  }, BASE);
}

function sanitizeItems(arr, key, max, svc) {
  const seen = new Set();
  return (Array.isArray(arr) ? arr : []).slice(0, max).map((p, i) => {
    p = p && typeof p === "object" ? p : {};
    let id = itemId(p.id) || fid(key, i, line(p.name, 80)); while (seen.has(id)) id = fid(key, i + seen.size + 1, id); seen.add(id);
    const o = { id, name: line(p.name, 80), price: price(p.price), desc: line(p.desc, 300), image: imgId(p.image), s: flag(p.s), hidden: flag(p.hidden), feat: flag(p.feat) };
    const old = price(p.old); o.old = old > o.price && o.price > 0 ? old : 0;
    o.images = (Array.isArray(p.images) ? p.images : []).map(imgId).filter((x, n, a) => x && a.indexOf(x) === n && x !== o.image).slice(0, LIMITS.extraImages);
    if (!o.image && o.images.length) o.image = o.images.shift();
    o.cat = line(p.cat, 30); o.badge = pick(p.badge, BADGES, "");
    if (svc) { o.dur = int(p.dur, 5, 600, 60); o.book = flagOr(p.book, 1); }
    else {
      o.available = !(p.available === false); o.optLabel = line(p.optLabel, 24);
      o.opts = (Array.isArray(p.opts) ? p.opts : String(p.opts || "").split(",")).map(v => line(v, 30)).filter((v, n, a) => v && a.indexOf(v) === n).slice(0, LIMITS.options);
      if (!o.opts.length) o.optLabel = "";
    }
    return o;
  }).filter(p => p.name);
}
function sanitizeConfig(input, base) {
  const i = input && typeof input === "object" ? input : {};
  const d = base || BASE;
  const dt = Object.assign({}, BASE.theme, d.theme || {}), t = i.theme || {}, b = i.brand || {}, c = i.contact || {}, s = i.sections || {}, seo = i.seo || {}, lb = i.labels || {};
  const db = Object.assign({}, BASE.brand, d.brand || {});
  const tpl = TEMPLATES[t.template] ? t.template : (TEMPLATES[dt.template] ? dt.template : "atelier");
  const order = (Array.isArray(i.order) ? i.order : d.order || SECTION_KEYS).filter((k, n, a) => SECTION_KEYS.includes(k) && a.indexOf(k) === n);
  SECTION_KEYS.forEach(k => { if (!order.includes(k)) order.push(k); });
  const labels = {}; SECTION_KEYS.forEach(k => { const v = line(lb[k], 40); if (v) labels[k] = v; });
  const sec = {}; SECTION_KEYS.forEach(k => { const dv = d.sections && d.sections[k] !== undefined ? d.sections[k] !== false : LEGACY_KEYS.includes(k); sec[k] = s[k] === undefined ? dv : s[k] !== false; });
  const th = { template: tpl, primary: color(t.primary, dt.primary), accent: color(t.accent, dt.accent), bg: color(t.bg, dt.bg), text: color(t.text, dt.text),
    headFont: FONTS[t.headFont] ? t.headFont : dt.headFont, bodyFont: BODY_FONTS.includes(t.bodyFont) ? t.bodyFont : dt.bodyFont,
    radius: Math.min(32, Math.max(0, Math.round(Number(t.radius ?? dt.radius)) || 0)),
    bgType: BG_TYPES.includes(t.bgType) ? t.bgType : dt.bgType, bgGradientTo: color(t.bgGradientTo, dt.bgGradientTo),
    bgImage: imgId(t.bgImage), overlay: Math.min(80, Math.max(0, Math.round(Number(t.overlay ?? dt.overlay)) || 0)), scale: int(t.scale ?? dt.scale, 90, 120, 100) };
  for (const k of Object.keys(OPT)) th[k] = pick(t[k] === undefined ? dt[k] : t[k], OPT[k], "auto");
  const act = (v, fb) => pick(v, ACTIONS, fb);
  const ann = i.announce || {}, dan = d.announce || ANN0, shp = i.shop || {}, dsh = d.shop || SHOP0, ct = i.cta || {}, dct = d.cta || CTA0;
  return {
    theme: th,
    brand: { name: line(b.name, 60), headline: line(b.headline ?? db.headline, 90), tagline: line(b.tagline, 120), about: text(b.about, 1500), logo: imgId(b.logo), hero: imgId(b.hero), tagS: flag(b.tagS), aboutS: flag(b.aboutS), headS: flag(b.headS),
      ctaA: act(b.ctaA ?? db.ctaA, "auto"), ctaB: act(b.ctaB ?? db.ctaB, "auto"), ctaLabel: line(b.ctaLabel ?? db.ctaLabel, 24) },
    labels, order, sections: sec,
    contact: { phone: phone(c.phone), whatsapp: phone(c.whatsapp), email: emailOk(c.email) ? String(c.email).trim().slice(0, 254) : "",
      address: line(c.address, 200), hours: line(c.hours, 120), instagram: handle(c.instagram), facebook: handle(c.facebook), tiktok: handle(c.tiktok), x: handle(c.x), greeting: line(c.greeting, 140) },
    products: sanitizeItems(i.products, "p", LIMITS.products, false), services: sanitizeItems(i.services, "s", LIMITS.services, true),
    highlights: (Array.isArray(i.highlights) ? i.highlights : []).slice(0, LIMITS.highlights).map(h => ({ title: line(h && h.title, 60), desc: line(h && h.desc, 200), s: flag(h && h.s) })).filter(h => h.title),
    testimonials: (Array.isArray(i.testimonials) ? i.testimonials : []).slice(0, LIMITS.testimonials).map(q => ({ quote: line(q && q.quote, 300), name: line(q && q.name, 60), s: flag(q && q.s) })).filter(q => q.quote),
    gallery: (Array.isArray(i.gallery) ? i.gallery : []).slice(0, LIMITS.gallery).map(imgId).filter(Boolean),
    stats: (Array.isArray(i.stats) ? i.stats : []).slice(0, LIMITS.stats).map(x => ({ value: line(x && x.value, 12), label: line(x && x.label, 40), s: flag(x && x.s) })).filter(x => x.value && x.label),
    faq: (Array.isArray(i.faq) ? i.faq : []).slice(0, LIMITS.faq).map(x => ({ q: line(x && x.q, 140), a: text(x && x.a, 600), s: flag(x && x.s) })).filter(x => x.q && x.a),
    blocks: (Array.isArray(i.blocks) ? i.blocks : []).slice(0, LIMITS.blocks).map((x, n) => ({ id: itemId(x && x.id) || fid("b", n, ""), title: line(x && x.title, 80), text: text(x && x.text, 700), image: imgId(x && x.image), btn: act(x && x.btn, "none"), label: line(x && x.label, 24), side: x && x.side === "left" ? "left" : "right", s: flag(x && x.s) })).filter(x => x.title || x.text),
    announce: { on: flagOr(ann.on, dan.on), text: line(ann.text ?? dan.text, 140), action: act(ann.action ?? dan.action, "none"), label: line(ann.label ?? dan.label, 24), until: dateStr(ann.until ?? dan.until) },
    shop: { on: flagOr(shp.on, dsh.on), pickup: flagOr(shp.pickup, dsh.pickup ?? 1), delivery: flagOr(shp.delivery, dsh.delivery ?? 1), fee: price(shp.fee ?? dsh.fee), free: price(shp.free ?? dsh.free), min: price(shp.min ?? dsh.min), note: text(shp.note ?? dsh.note, 300) },
    booking: sanitizeBooking(i.booking, d.booking),
    cta: { title: line(ct.title ?? dct.title, 80), text: line(ct.text ?? dct.text, 200), action: act(ct.action ?? dct.action, "auto"), label: line(ct.label ?? dct.label, 24), s: ct.s === undefined ? flag(dct.s) : flag(ct.s) },
    seo: { title: line(seo.title, 70), description: line(seo.description, 160) }
  };
}
const sampleCount = c => c.products.filter(x => x.s).length + c.services.filter(x => x.s).length + c.highlights.filter(x => x.s).length + c.testimonials.filter(x => x.s).length + (c.brand.aboutS ? 1 : 0) + (c.brand.tagS ? 1 : 0)
  + (c.stats || []).filter(x => x.s).length + (c.faq || []).filter(x => x.s).length + (c.blocks || []).filter(x => x.s).length + (c.cta && c.cta.s ? 1 : 0);
const photosOf = p => [p.image, ...(p.images || [])].filter(Boolean).slice(0, 8);
/* Every image id referenced by a config (used to make sure a site only references its own images). */
function imageIds(cfg) {
  const s = new Set([cfg.brand.logo, cfg.brand.hero, cfg.theme.bgImage, ...cfg.gallery, ...cfg.products.flatMap(p => [p.image, ...(p.images || [])]), ...cfg.services.flatMap(p => [p.image, ...(p.images || [])]), ...(cfg.blocks || []).map(b => b.image)]);
  s.delete(""); return [...s];
}
const DAY = 86400000;
/* Renewal always adds full days on top of whatever time is left, so nobody loses paid days by renewing early. */
function renewedExpiry(currentExpiry, now, days) {
  const base = currentExpiry && new Date(currentExpiry) > now ? new Date(currentExpiry) : now;
  return new Date(base.getTime() + days * DAY);
}
function siteState(site, now) {
  if (!site) return "none";
  if (site.status === "suspended") return "suspended";
  return new Date(site.expires_at) > now ? "active" : "expired";
}
const daysLeft = (exp, now) => Math.max(0, Math.ceil((new Date(exp) - now) / DAY));
function dataUrlImage(s) {
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ""));
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  const ok = (m[1] === "image/webp" && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") ||
    (m[1] === "image/jpeg" && buf[0] === 0xff && buf[1] === 0xd8) || (m[1] === "image/png" && buf[0] === 0x89 && buf.slice(1, 4).toString() === "PNG");
  return ok ? { mime: m[1], buf } : null;
}

/* ---------- resolved layout: 'auto' means "use this template's design" ---------- */
function layoutOf(cfg) {
  const t = cfg.theme, tpl = TEMPLATES[t.template] || TEMPLATES.atelier, L = tpl.layout, r = {};
  for (const k of Object.keys(OPT)) r[k] = t[k] && t[k] !== "auto" ? t[k] : String(L[k]);
  r.cols = Number(r.cols) || 3; r.fit = t.fit === "contain" ? "contain" : "cover"; return r;
}
/* Which button does each call-to-action slot perform on this site? Falls back gracefully to what the site actually offers. */
function actionsOf(cfg) {
  const c = cfg.contact, wa = !!(c.whatsapp || c.phone), shop = !!(cfg.shop.on && cfg.sections.products && cfg.products.some(p => !p.hidden && p.price > 0)), book = !!(cfg.booking.on && cfg.sections.booking), enq = !!cfg.sections.enquiry;
  const has = { whatsapp: wa, shop, book, call: !!c.phone, enquire: enq, none: true };
  const tplId = cfg.theme.template;
  const prefer = book && /^(glow|lumen|studio|forma|fete|vista)$/.test(tplId) ? ["book", "shop", "whatsapp", "enquire", "call"] : shop ? ["shop", "whatsapp", "book", "enquire", "call"] : ["whatsapp", "book", "enquire", "call", "shop"];
  const first = prefer.find(k => has[k]) || "none";
  const second = prefer.filter(k => k !== first).find(k => has[k] && k !== "call") || "none";
  const resolve = (v, fb) => (v === "auto" ? fb : has[v] ? v : fb);
  return { has, a: resolve(cfg.brand.ctaA, first), b: resolve(cfg.brand.ctaB, second === first ? "none" : second), first, second };
}

/* ---------- orders ---------- */
function calcDiscount(promo, subtotal) {
  if (!promo) return 0;
  const v = Number(promo.value) || 0;
  const raw = promo.kind === "percent" ? Math.floor(subtotal * Math.min(90, v) / 100) : v;
  return Math.max(0, Math.min(subtotal, Math.round(raw * 100) / 100));
}
function promoProblem(p, subtotal, now) {
  if (!p || !p.active) return "This code is not valid.";
  if (p.expires_at && new Date(p.expires_at) <= now) return "This code has expired.";
  if (Number(p.max_uses) > 0 && Number(p.uses) >= Number(p.max_uses)) return "This code has been fully used.";
  if (Number(p.min_order) > 0 && subtotal < Number(p.min_order)) return "Spend at least ₦" + Number(p.min_order).toLocaleString("en-NG") + " to use this code.";
  return "";
}
/* Prices ALWAYS come from the published website, never from the visitor's browser. */
function priceOrder(cfg, lines, o) {
  o = o || {}; const shop = cfg.shop;
  if (!shop.on) return { error: "Online ordering is not available on this website." };
  if (!Array.isArray(lines) || !lines.length) return { error: "Your cart is empty." };
  if (lines.length > 30) return { error: "Too many items in one order." };
  const byId = new Map(cfg.products.map(p => [p.id, p])), items = [];
  for (const l of lines) {
    const p = byId.get(String(l && l.id));
    if (!p || p.hidden) return { error: "Some items are no longer available. Please refresh the page." };
    if (p.available === false) return { error: p.name + " is sold out." };
    if (!(p.price > 0)) return { error: p.name + " needs a quote. Please send an enquiry." };
    const q = Math.round(Number(l.q)); if (!(q >= 1 && q <= 50)) return { error: "Please check the quantity." };
    let opt = ""; if (p.opts && p.opts.length) { opt = p.opts.includes(String(l.o)) ? String(l.o) : ""; if (!opt) return { error: "Please choose " + (p.optLabel || "an option") + " for " + p.name + "." }; }
    items.push({ id: p.id, name: p.name, opt, q, price: p.price, line: Math.round(p.price * q * 100) / 100 });
  }
  const subtotal = Math.round(items.reduce((a, x) => a + x.line, 0) * 100) / 100;
  if (shop.min > 0 && subtotal < shop.min) return { error: "The minimum order is ₦" + shop.min.toLocaleString("en-NG") + "." };
  const f = o.fulfilment === "delivery" ? "delivery" : "pickup";
  if (f === "delivery" && !shop.delivery) return { error: "Delivery is not available. Please choose pickup." };
  if (f === "pickup" && !shop.pickup) return { error: "Pickup is not available. Please choose delivery." };
  const discount = calcDiscount(o.promo, subtotal), after = subtotal - discount;
  const delivery = f === "delivery" ? (shop.free > 0 && after >= shop.free ? 0 : shop.fee) : 0;
  return { items, subtotal, discount, delivery, total: Math.round((after + delivery) * 100) / 100, fulfilment: f };
}

/* ---------- bookings (Nigeria is UTC+1 all year, no daylight saving) ---------- */
const LAGOS = 3600000;
const todayLagos = nowMs => new Date(nowMs + LAGOS).toISOString().slice(0, 10);
const weekday = ds => { const w = new Date(ds + "T00:00:00Z").getUTCDay(); return w === 0 ? 7 : w; };
const toMs = (ds, hm) => { const [y, m, d] = ds.split("-").map(Number), [h, mi] = hm.split(":").map(Number); return Date.UTC(y, m - 1, d, h, mi) - LAGOS; };
const minOf = hm => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
const hmOf = n => String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
const addDays = (ds, n) => new Date(new Date(ds + "T00:00:00Z").getTime() + n * DAY).toISOString().slice(0, 10);
/* existing: [{s: startMs, e: endMs}] of pending/confirmed bookings that day. Returns [{t:"09:00", ms}] */
function availableSlots(bk, ds, durMin, existing, nowMs) {
  if (!bk.on || !dateStr(ds)) return [];
  const today = todayLagos(nowMs);
  if (ds < today || ds > addDays(today, bk.ahead)) return [];
  if (!bk.days.includes(weekday(ds)) || bk.closed.includes(ds)) return [];
  const dur = Math.max(bk.slot, Math.ceil((durMin || bk.slot) / bk.slot) * bk.slot), out = [];
  const open = minOf(bk.open), close = minOf(bk.close), earliest = nowMs + bk.lead * 3600000;
  for (let m = open; m + dur <= close; m += bk.slot) {
    const s = toMs(ds, hmOf(m)), e = s + dur * 60000;
    if (s < earliest) continue;
    const busy = (existing || []).filter(x => x.s < e && x.e > s).length;
    if (busy < bk.cap) out.push({ t: hmOf(m), ms: s });
  }
  return out;
}
const bookableServices = cfg => { const l = cfg.services.filter(s => !s.hidden && s.book !== 0); return l.length ? l : [{ id: "general", name: "Appointment", price: 0, dur: cfg.booking.slot }]; };

/* ---------- people (CRM) ---------- */
const contactKey = (ph, em) => { const p = phone(ph); return p ? "p:" + p : emailOk(em) ? "e:" + String(em).trim().toLowerCase() : ""; };
function cleanSubmission(b) {
  b = b && typeof b === "object" ? b : {};
  const o = { name: line(b.name, 80), phone: phone(b.phone), email: emailOk(b.email) ? String(b.email).trim().toLowerCase().slice(0, 254) : "", message: text(b.message, 1000), optin: flag(b.optin), website: String(b.website || "") };
  return o;
}
const submissionError = (o, needMessage) => !o.name || o.name.length < 2 ? "Please enter your name." : !o.phone && !o.email ? "Please enter a valid phone number or email so we can reach you." : needMessage && o.message.length < 2 ? "Please write a short message." : "";
const ORDER_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const orderCode = () => Array.from(crypto.randomBytes(6), b => ORDER_CODE_CHARS[b % ORDER_CODE_CHARS.length]).join("");
const csvCell = v => { let s = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = (cols, rows) => "\ufeff" + [cols.map(c => csvCell(c[1])).join(","), ...rows.map(r => cols.map(c => csvCell(r[c[0]])).join(","))].join("\r\n");
const ORDER_FLOW = ["new", "confirmed", "preparing", "ready", "completed", "cancelled"];
const BOOKING_FLOW = ["pending", "confirmed", "completed", "cancelled", "no_show"];
const ENQ_FLOW = ["new", "replied", "closed"];

module.exports = { RESERVED, FONTS, HEAD_WEIGHT, SERIF, BODY_FONTS, SECTION_KEYS, LEGACY_KEYS, SECTION_DEFAULT_LABEL, TEMPLATES, TEMPLATE_IDS, DEFAULT_CONFIG, LIMITS, OPT, ACTIONS, BADGES, SLOT_SIZES, templateConfig, sampleCount,
  normUsername, validateUsername, sanitizeConfig, imageIds, renewedExpiry, siteState, daysLeft, dataUrlImage, phone, DAY, layoutOf, actionsOf, priceOrder, calcDiscount, promoProblem,
  photosOf, availableSlots, bookableServices, todayLagos, weekday, toMs, addDays, contactKey, cleanSubmission, submissionError, orderCode, toCsv, emailOk, dateStr, price, line, text, ORDER_FLOW, BOOKING_FLOW, ENQ_FLOW, int };
