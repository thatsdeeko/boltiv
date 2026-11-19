"use strict";
/* BOLTIV Link: pure helpers (username rules, config sanitising, phone/colour checks, expiry maths). No I/O, unit-tested. */
const RESERVED = new Set(["www","api","app","admin","mail","email","smtp","ftp","ns1","ns2","cdn","static","assets","img","images","blog","help","support","billing","pay","payments","login","signin","signup","register","account","dashboard","boltiv","boltivlink","link","links","status","dev","staging","test","demo","root","security","cpanel","webmail","wallet","cards","agent","agents","business","shop","store","official","team","info","contact","sales","careers","press","legal","terms","privacy","send","resend","em","m","mobile","web","portal","docs","imap","pop","pop3","autodiscover","pages","railway","github","ns","dns","vpn","git","new","edit","preview","go","u","s","r"]);
const FONTS = { "Inter":"Inter", "Poppins":"Poppins", "Playfair Display":"Playfair+Display", "Montserrat":"Montserrat", "Lora":"Lora", "DM Sans":"DM+Sans", "Space Grotesk":"Space+Grotesk", "Nunito":"Nunito" };
const LAYOUTS = ["classic","bold","minimal","shop"];
const BG_TYPES = ["color","gradient","image"];

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
function phone(v) {
  let d = String(v == null ? "" : v).replace(/\D/g, "");
  if (d.startsWith("0") && d.length === 11) d = "234" + d.slice(1);
  return d.length >= 10 && d.length <= 15 ? d : "";
}
const handle = v => String(v == null ? "" : v).trim().replace(/^https?:\/\/[^/]+\//i, "").replace(/^@/, "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);

const DEFAULT_CONFIG = {
  theme: { primary: "#c9a227", accent: "#171717", bg: "#ffffff", text: "#171717", font: "Inter", layout: "classic", radius: 16, bgType: "color", bgGradientTo: "#fff7dc", bgImage: "", overlay: 45 },
  brand: { name: "", tagline: "", about: "", logo: "", hero: "" },
  contact: { phone: "", whatsapp: "", email: "", address: "", hours: "", instagram: "", facebook: "", tiktok: "", x: "" },
  sections: { about: true, products: true, services: true, gallery: true, contact: true },
  products: [], services: [], gallery: [],
  seo: { title: "", description: "" }
};
const LIMITS = { products: 60, services: 30, gallery: 24 };

function sanitizeConfig(input, base) {
  const i = input && typeof input === "object" ? input : {};
  const d = base || DEFAULT_CONFIG;
  const t = i.theme || {}, b = i.brand || {}, c = i.contact || {}, s = i.sections || {}, seo = i.seo || {};
  const out = {
    theme: {
      primary: color(t.primary, d.theme.primary), accent: color(t.accent, d.theme.accent), bg: color(t.bg, d.theme.bg), text: color(t.text, d.theme.text),
      font: FONTS[t.font] ? t.font : d.theme.font, layout: LAYOUTS.includes(t.layout) ? t.layout : d.theme.layout,
      radius: Math.min(32, Math.max(0, Math.round(Number(t.radius ?? d.theme.radius)) || 0)),
      bgType: BG_TYPES.includes(t.bgType) ? t.bgType : d.theme.bgType, bgGradientTo: color(t.bgGradientTo, d.theme.bgGradientTo),
      bgImage: imgId(t.bgImage), overlay: Math.min(80, Math.max(0, Math.round(Number(t.overlay ?? d.theme.overlay)) || 0))
    },
    brand: { name: line(b.name, 60), tagline: line(b.tagline, 120), about: text(b.about, 1200), logo: imgId(b.logo), hero: imgId(b.hero) },
    contact: { phone: phone(c.phone), whatsapp: phone(c.whatsapp), email: /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(String(c.email || "").trim()) ? String(c.email).trim().slice(0, 254) : "",
      address: line(c.address, 200), hours: line(c.hours, 120), instagram: handle(c.instagram), facebook: handle(c.facebook), tiktok: handle(c.tiktok), x: handle(c.x) },
    sections: { about: s.about !== false, products: s.products !== false, services: s.services !== false, gallery: s.gallery !== false, contact: s.contact !== false },
    products: (Array.isArray(i.products) ? i.products : []).slice(0, LIMITS.products).map(p => ({ name: line(p && p.name, 80), price: price(p && p.price), desc: line(p && p.desc, 240), image: imgId(p && p.image), available: !(p && p.available === false) })).filter(p => p.name),
    services: (Array.isArray(i.services) ? i.services : []).slice(0, LIMITS.services).map(p => ({ name: line(p && p.name, 80), price: price(p && p.price), desc: line(p && p.desc, 240), image: imgId(p && p.image) })).filter(p => p.name),
    gallery: (Array.isArray(i.gallery) ? i.gallery : []).slice(0, LIMITS.gallery).map(imgId).filter(Boolean),
    seo: { title: line(seo.title, 70), description: line(seo.description, 160) }
  };
  return out;
}
/* Every image id referenced by a config (used to make sure a site only references its own images). */
function imageIds(cfg) {
  const s = new Set([cfg.brand.logo, cfg.brand.hero, cfg.theme.bgImage, ...cfg.gallery, ...cfg.products.map(p => p.image), ...cfg.services.map(p => p.image)]);
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
module.exports = { RESERVED, FONTS, LAYOUTS, DEFAULT_CONFIG, LIMITS, normUsername, validateUsername, sanitizeConfig, imageIds, renewedExpiry, siteState, daysLeft, dataUrlImage, phone, DAY };
