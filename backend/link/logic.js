"use strict";
/* BOLTIV Link: pure helpers (username rules, templates, config sanitising, expiry maths). No I/O, unit-tested. */
const RESERVED = new Set(["www","api","app","admin","mail","email","smtp","ftp","ns1","ns2","cdn","static","assets","img","images","blog","help","support","billing","pay","payments","login","signin","signup","register","account","dashboard","boltiv","boltivlink","link","links","status","dev","staging","test","demo","root","security","cpanel","webmail","wallet","cards","agent","agents","business","shop","store","official","team","info","contact","sales","careers","press","legal","terms","privacy","send","resend","em","m","mobile","web","portal","docs","imap","pop","pop3","autodiscover","pages","railway","github","ns","dns","vpn","git","new","edit","preview","go","u","s","r"]);
/* Google Fonts families. Each entry lists only weights that really exist, because Google rejects requests for missing weights. */
const FONTS = {
  "Playfair Display": "Playfair+Display:wght@400;600;700", "Cormorant Garamond": "Cormorant+Garamond:wght@500;600;700", "DM Serif Display": "DM+Serif+Display",
  "Fraunces": "Fraunces:wght@500;600;700", "Syne": "Syne:wght@600;700;800", "Space Grotesk": "Space+Grotesk:wght@500;700", "Montserrat": "Montserrat:wght@400;500;600;700",
  "Poppins": "Poppins:wght@400;500;600;700", "Outfit": "Outfit:wght@400;500;600;700", "Manrope": "Manrope:wght@400;600;700;800",
  "Inter": "Inter:wght@400;500;600;700", "DM Sans": "DM+Sans:wght@400;500;700", "Nunito": "Nunito:wght@400;600;700", "Lora": "Lora:wght@400;600;700"
};
const HEAD_WEIGHT = { "Playfair Display": 600, "Cormorant Garamond": 600, "DM Serif Display": 400, "Fraunces": 600, "Syne": 700, "Space Grotesk": 700, "Montserrat": 700, "Poppins": 600, "Outfit": 600, "Manrope": 800, "Inter": 700, "DM Sans": 700, "Nunito": 700, "Lora": 600 };
const SERIF = new Set(["Playfair Display", "Cormorant Garamond", "DM Serif Display", "Fraunces", "Lora"]);
const BODY_FONTS = ["Inter", "DM Sans", "Nunito", "Manrope", "Lora", "Outfit", "Poppins"];
const SECTION_KEYS = ["highlights", "products", "services", "about", "gallery", "testimonials", "contact"];
const BG_TYPES = ["color", "gradient", "image"];

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
const flag = v => (v === 1 || v === true ? 1 : 0);
function phone(v) {
  let d = String(v == null ? "" : v).replace(/\D/g, "");
  if (d.startsWith("0") && d.length === 11) d = "234" + d.slice(1);
  return d.length >= 10 && d.length <= 15 ? d : "";
}
const handle = v => String(v == null ? "" : v).trim().replace(/^https?:\/\/[^/]+\//i, "").replace(/^@/, "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);

/* ---------- templates ---------- */
const P = (n, primary, accent, bg, tx, to) => ({ n, primary, accent, bg, text: tx, to: to || bg });
const TEMPLATES = {
  atelier: { id: "atelier", name: "Atelier", category: "Fashion & beauty", blurb: "Editorial and elegant. Full-screen cover, portrait product cards.",
    theme: { headFont: "Playfair Display", bodyFont: "Inter", radius: 2 }, art: "arcs",
    palettes: [P("Bronze", "#b08d57", "#1a1a1a", "#faf7f2", "#1a1a1a"), P("Noir", "#d4af37", "#0d0d0d", "#111111", "#f4efe6"), P("Blush", "#c9788b", "#3b2a2e", "#fbf1f1", "#2b1f22"), P("Forest", "#8a9a5b", "#1f2a1f", "#f5f4ee", "#1f2a1f")],
    labels: { products: "The Collection", services: "Services", about: "Our story", gallery: "Lookbook", contact: "Visit & contact", highlights: "Why choose us", testimonials: "Kind words" },
    order: ["products", "highlights", "about", "gallery", "testimonials", "services", "contact"], hide: ["services"],
    tagline: "Modern tailoring and ready-to-wear, made with care.", about: "We design pieces that feel as good as they look. Every outfit is cut, sewn and finished with attention to the smallest detail, using quality fabrics sourced locally.\n\nWhether it is a wedding, a work look or an everyday favourite, we will make something that fits you perfectly.",
    products: [["Ankara Wrap Dress", 28000, "Structured wrap silhouette in premium Ankara."], ["Tailored Linen Set", 35000, "Breathable two-piece, made to your measurements."], ["Classic Agbada", 65000, "Hand-finished embroidery on soft, flowing fabric."], ["Statement Headwrap", 6500, "Bold print, ready to tie."]],
    services: [["Custom tailoring", 0, "Made-to-measure outfits, fittings included."], ["Styling session", 15000, "Build a wardrobe that works for your life."]],
    highlights: [["Made to measure", "Every piece is cut for your exact size."], ["Quality fabrics", "Premium materials chosen for comfort and finish."], ["Delivery nationwide", "Safely packed and sent to your door."]],
    testimonials: [["The fit is perfect and the finishing is beautiful. I got compliments all evening.", "Amaka O."], ["Professional, on time and the quality is excellent.", "Tunde A."]] },
  bistro: { id: "bistro", name: "Bistro", category: "Restaurants & food", blurb: "Warm and appetising. Centred cover and a classic menu layout.",
    theme: { headFont: "DM Serif Display", bodyFont: "DM Sans", radius: 8 }, art: "dots",
    palettes: [P("Terracotta", "#c2410c", "#2b1a10", "#fff8ef", "#2b1a10"), P("Olive", "#6b7d2f", "#1d2312", "#faf8ef", "#1d2312"), P("Midnight", "#f59e0b", "#0f172a", "#111827", "#f9f5ec"), P("Berry", "#be185d", "#2a0f1d", "#fff5f8", "#2a0f1d")],
    labels: { products: "Our menu", services: "Catering & events", about: "Our kitchen", gallery: "From our kitchen", contact: "Find us", highlights: "What makes us special", testimonials: "What guests say" },
    order: ["products", "highlights", "about", "gallery", "services", "testimonials", "contact"], hide: [],
    tagline: "Fresh, flavourful food made from scratch every day.", about: "We cook the food we grew up loving: bold flavours, generous portions and ingredients bought fresh every morning.\n\nDine with us, order for pickup, or let us cater your next celebration.",
    products: [["Smoky Party Jollof", 3500, "Slow-cooked jollof with fried plantain."], ["Peppered Goat Meat", 4500, "Tender, spicy and grilled to order."], ["Suya Platter", 5500, "Thinly sliced beef with yaji, onions and tomatoes."], ["Chapman", 1800, "Our chilled house recipe."]],
    services: [["Event catering", 0, "Weddings, birthdays and office events of any size."], ["Private dining", 0, "A table for you and your guests, planned your way."]],
    highlights: [["Fresh every day", "Cooked from scratch with ingredients bought that morning."], ["Order ahead", "Message us on WhatsApp and collect when it is ready."], ["Catering for any event", "From 10 guests to 500."]],
    testimonials: [["The best jollof in town, and the portions are generous.", "Chidi E."], ["Our wedding guests are still talking about the food.", "Funke & Seun"]] },
  market: { id: "market", name: "Market", category: "Retail & shops", blurb: "Bright and clear. Built to sell, with big product cards.",
    theme: { headFont: "Poppins", bodyFont: "Inter", radius: 16 }, art: "blobs",
    palettes: [P("Emerald", "#0f9d58", "#0b2e1f", "#ffffff", "#10231a", "#effaf3"), P("Ocean", "#2563eb", "#0b1f4d", "#ffffff", "#0f1b3a", "#eef4ff"), P("Sunset", "#f97316", "#3b1d0a", "#fffaf5", "#2a1608", "#fff0e0"), P("Plum", "#7c3aed", "#24114d", "#fbf9ff", "#1e1236", "#f2ecff")],
    labels: { products: "Shop", services: "Services", about: "About us", gallery: "Gallery", contact: "Contact us", highlights: "Why shop with us", testimonials: "Happy customers" },
    order: ["products", "highlights", "services", "about", "testimonials", "gallery", "contact"], hide: ["gallery"],
    tagline: "Quality products, honest prices, fast delivery.", about: "We are a neighbourhood shop built on trust. Every product is checked before it leaves our store, and we are always a message away if you need help.",
    products: [["Smart Watch", 18500, "Heart rate, sleep tracking and 7-day battery."], ["Power Bank 20,000mAh", 14500, "Fast charging for two devices at once."], ["Bluetooth Speaker", 22000, "Loud, clear and water resistant."], ["Phone Case", 3000, "Slim, durable and drop tested."]],
    services: [["Delivery & installation", 0, "We deliver and set up for you."], ["Warranty support", 0, "Fast repairs and replacements."]],
    highlights: [["Genuine products", "Every item is original and checked."], ["Pay on delivery", "Available in selected areas."], ["Fast delivery", "Same-day in town, 2 to 3 days nationwide."]],
    testimonials: [["Fast delivery and the product is exactly as described.", "Ibrahim S."], ["Great prices and very helpful on WhatsApp.", "Grace N."]] },
  studio: { id: "studio", name: "Studio", category: "Business & services", blurb: "Confident and corporate. Split cover, numbered services.",
    theme: { headFont: "Manrope", bodyFont: "Inter", radius: 10 }, art: "grid",
    palettes: [P("Royal", "#1d4ed8", "#0b1f3a", "#f6f8fb", "#0b1f3a", "#e9eff9"), P("Graphite", "#0f766e", "#111827", "#f7f7f5", "#111827", "#ecefec"), P("Gold", "#b8860b", "#14110a", "#faf8f2", "#14110a", "#f1ece0"), P("Slate", "#e11d48", "#0f172a", "#ffffff", "#0f172a", "#f1f5f9")],
    labels: { products: "Packages", services: "What we do", about: "About us", gallery: "Our work", contact: "Get in touch", highlights: "Why clients choose us", testimonials: "Client feedback" },
    order: ["services", "highlights", "products", "about", "testimonials", "gallery", "contact"], hide: ["gallery"],
    tagline: "Practical expertise that helps your business grow.", about: "We help business owners make confident decisions. Our team combines years of hands-on experience with clear communication, so you always know what is happening and why.\n\nFrom your first call to final delivery, you deal directly with the people doing the work.",
    products: [["Starter", 50000, "Everything you need to get set up properly."], ["Growth", 120000, "Ongoing support for growing businesses."], ["Premium", 250000, "Full-service partnership with priority support."]],
    services: [["Business consulting", 0, "Strategy, planning and problem solving."], ["Brand & marketing", 0, "Position your business and attract customers."], ["Bookkeeping & tax", 0, "Accurate records and stress-free compliance."]],
    highlights: [["Clear pricing", "No surprises. You know the cost up front."], ["Experienced team", "Real expertise, not trainees."], ["Fast response", "We reply within one business day."]],
    testimonials: [["They were professional, quick and explained everything clearly.", "Mrs Adeyemi, Retail owner"], ["Our process is now smoother and our books are always in order.", "David K., Logistics"]] },
  folio: { id: "folio", name: "Folio", category: "Portfolio & creatives", blurb: "Bold, minimal and image-led. Great for designers and photographers.",
    theme: { headFont: "Space Grotesk", bodyFont: "Inter", radius: 4 }, art: "waves",
    palettes: [P("Lime", "#d4ff3f", "#0b0b0c", "#0e0e10", "#f5f5f4"), P("Paper", "#111111", "#111111", "#f6f4ef", "#111111"), P("Coral", "#ff5a4f", "#111111", "#fffaf7", "#111111"), P("Ice", "#7dd3fc", "#0b1220", "#0b1220", "#eef6ff")],
    labels: { products: "Selected work", services: "What I do", about: "About", gallery: "Gallery", contact: "Let's work together", highlights: "How I work", testimonials: "Kind words" },
    order: ["products", "services", "about", "gallery", "highlights", "testimonials", "contact"], hide: ["highlights"],
    tagline: "Designer and creative director helping brands look their best.", about: "I am a creative professional focused on clear ideas and careful craft. I work with founders and small teams to shape brands, websites and campaigns that people remember.\n\nAvailable for new projects. Let's talk.",
    products: [["Brand identity for a food startup", 0, "Logo, colour system and packaging."], ["Website for a boutique hotel", 0, "Design and build, mobile first."], ["Product photography series", 0, "Studio shoot for an online store."], ["Campaign for a music festival", 0, "Posters, social and signage."]],
    services: [["Brand identity", 0, "Logo, typography, colour and guidelines."], ["Web design", 0, "Clean, fast sites that convert."], ["Photography", 0, "Product, portrait and event photography."]],
    highlights: [["Listen first", "I start by understanding your goals."], ["Clear process", "Simple milestones and honest timelines."], ["Made to last", "Work that stays fresh for years."]],
    testimonials: [["Thoughtful, quick and the result exceeded what we imagined.", "Lagos startup founder"], ["Easy to work with and the final work was exceptional.", "Event organiser"]] },
  glow: { id: "glow", name: "Glow", category: "Beauty, wellness & salons", blurb: "Soft and inviting. Treatment price lists with easy booking.",
    theme: { headFont: "Cormorant Garamond", bodyFont: "Nunito", radius: 22 }, art: "blobs",
    palettes: [P("Rose", "#c06c84", "#3d2b2f", "#fdf4f1", "#3d2b2f", "#fbe8e4"), P("Sage", "#6b8f71", "#243127", "#f4f8f2", "#243127", "#e6efe3"), P("Lilac", "#8b6bb8", "#2a1f3d", "#f8f5fd", "#2a1f3d", "#ece5f8"), P("Sand", "#b7791f", "#3a2a14", "#fbf6ee", "#3a2a14", "#f4e9d6")],
    labels: { products: "Shop", services: "Treatments", about: "About us", gallery: "Our work", contact: "Book your visit", highlights: "The experience", testimonials: "Loved by clients" },
    order: ["services", "highlights", "gallery", "products", "about", "testimonials", "contact"], hide: [],
    tagline: "Relax, restore and leave feeling beautiful.", about: "Our studio is a calm space where you can switch off. Our trained team uses trusted products and a gentle touch, and we never rush an appointment.\n\nBook ahead on WhatsApp and we will have everything ready for you.",
    products: [["Glow skincare set", 18000, "Cleanser, serum and moisturiser."], ["Hair care bundle", 12000, "Shampoo, conditioner and leave-in."]],
    services: [["Classic facial", 15000, "Deep cleanse and hydration."], ["Gel manicure", 8000, "Long-lasting shine."], ["Braids & styling", 25000, "Neat, comfortable and long lasting."], ["Bridal makeup", 60000, "Trial included."]],
    highlights: [["Hygienic studio", "Sterilised tools and fresh linen for every client."], ["Trusted products", "Gentle formulas that care for your skin."], ["Book in advance", "Pick a time that suits you on WhatsApp."]],
    testimonials: [["My skin has never looked better. The studio is so peaceful.", "Zainab M."], ["Neat, friendly and always on time.", "Ngozi P."]] }
};
const TEMPLATE_IDS = Object.keys(TEMPLATES);
const SECTION_DEFAULT_LABEL = { products: "Products", services: "Services", about: "About us", gallery: "Gallery", contact: "Contact", highlights: "Why choose us", testimonials: "What clients say" };

function templateConfig(id, name) {
  const t = TEMPLATES[id] || TEMPLATES.atelier, pal = t.palettes[0], nm = line(name, 60);
  const it = (a, s) => a.map(x => ({ name: x[0], price: x[1], desc: x[2], image: "", available: true, s: 1 }));
  return sanitizeConfig({
    theme: { template: t.id, primary: pal.primary, accent: pal.accent, bg: pal.bg, text: pal.text, headFont: t.theme.headFont, bodyFont: t.theme.bodyFont, radius: t.theme.radius, bgType: "color", bgGradientTo: pal.to },
    brand: { name: nm, tagline: t.tagline, about: t.about, tagS: 1, aboutS: 1 },
    labels: t.labels, order: t.order, sections: Object.fromEntries(SECTION_KEYS.map(k => [k, !t.hide.includes(k)])),
    products: it(t.products), services: it(t.services),
    highlights: t.highlights.map(h => ({ title: h[0], desc: h[1], s: 1 })), testimonials: t.testimonials.map(q => ({ quote: q[0], name: q[1], s: 1 })), gallery: []
  }, BASE);
}

const BASE = {
  theme: { template: "atelier", primary: "#b08d57", accent: "#1a1a1a", bg: "#faf7f2", text: "#1a1a1a", headFont: "Playfair Display", bodyFont: "Inter", radius: 2, bgType: "color", bgGradientTo: "#faf7f2", bgImage: "", overlay: 45 },
  brand: { name: "", tagline: "", about: "", logo: "", hero: "", tagS: 0, aboutS: 0 },
  labels: {}, order: SECTION_KEYS.slice(), sections: { highlights: true, products: true, services: true, about: true, gallery: true, testimonials: true, contact: true },
  contact: { phone: "", whatsapp: "", email: "", address: "", hours: "", instagram: "", facebook: "", tiktok: "", x: "" }, seo: { title: "", description: "" }
};
const DEFAULT_CONFIG = BASE;
const LIMITS = { products: 60, services: 30, gallery: 24, highlights: 6, testimonials: 6 };

function sanitizeConfig(input, base) {
  const i = input && typeof input === "object" ? input : {};
  const d = base || BASE;
  const dt = d.theme || BASE.theme, t = i.theme || {}, b = i.brand || {}, c = i.contact || {}, s = i.sections || {}, seo = i.seo || {}, lb = i.labels || {};
  const tpl = TEMPLATES[t.template] ? t.template : (TEMPLATES[dt.template] ? dt.template : "atelier");
  const order = (Array.isArray(i.order) ? i.order : d.order || SECTION_KEYS).filter((k, n, a) => SECTION_KEYS.includes(k) && a.indexOf(k) === n);
  SECTION_KEYS.forEach(k => { if (!order.includes(k)) order.push(k); });
  const labels = {}; SECTION_KEYS.forEach(k => { const v = line(lb[k], 40); if (v) labels[k] = v; });
  const sec = {}; SECTION_KEYS.forEach(k => { sec[k] = s[k] === undefined ? (d.sections ? d.sections[k] !== false : true) : s[k] !== false; });
  const item = (p, withStock) => { const o = { name: line(p && p.name, 80), price: price(p && p.price), desc: line(p && p.desc, 240), image: imgId(p && p.image), s: flag(p && p.s) }; if (withStock) o.available = !(p && p.available === false); return o; };
  return {
    theme: {
      template: tpl, primary: color(t.primary, dt.primary), accent: color(t.accent, dt.accent), bg: color(t.bg, dt.bg), text: color(t.text, dt.text),
      headFont: FONTS[t.headFont] ? t.headFont : dt.headFont, bodyFont: BODY_FONTS.includes(t.bodyFont) ? t.bodyFont : dt.bodyFont,
      radius: Math.min(32, Math.max(0, Math.round(Number(t.radius ?? dt.radius)) || 0)),
      bgType: BG_TYPES.includes(t.bgType) ? t.bgType : dt.bgType, bgGradientTo: color(t.bgGradientTo, dt.bgGradientTo),
      bgImage: imgId(t.bgImage), overlay: Math.min(80, Math.max(0, Math.round(Number(t.overlay ?? dt.overlay)) || 0))
    },
    brand: { name: line(b.name, 60), tagline: line(b.tagline, 120), about: text(b.about, 1500), logo: imgId(b.logo), hero: imgId(b.hero), tagS: flag(b.tagS), aboutS: flag(b.aboutS) },
    labels, order, sections: sec,
    contact: { phone: phone(c.phone), whatsapp: phone(c.whatsapp), email: /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(String(c.email || "").trim()) ? String(c.email).trim().slice(0, 254) : "",
      address: line(c.address, 200), hours: line(c.hours, 120), instagram: handle(c.instagram), facebook: handle(c.facebook), tiktok: handle(c.tiktok), x: handle(c.x) },
    products: (Array.isArray(i.products) ? i.products : []).slice(0, LIMITS.products).map(p => item(p, true)).filter(p => p.name),
    services: (Array.isArray(i.services) ? i.services : []).slice(0, LIMITS.services).map(p => item(p, false)).filter(p => p.name),
    highlights: (Array.isArray(i.highlights) ? i.highlights : []).slice(0, LIMITS.highlights).map(h => ({ title: line(h && h.title, 60), desc: line(h && h.desc, 200), s: flag(h && h.s) })).filter(h => h.title),
    testimonials: (Array.isArray(i.testimonials) ? i.testimonials : []).slice(0, LIMITS.testimonials).map(q => ({ quote: line(q && q.quote, 300), name: line(q && q.name, 60), s: flag(q && q.s) })).filter(q => q.quote),
    gallery: (Array.isArray(i.gallery) ? i.gallery : []).slice(0, LIMITS.gallery).map(imgId).filter(Boolean),
    seo: { title: line(seo.title, 70), description: line(seo.description, 160) }
  };
}
const sampleCount = c => c.products.filter(x => x.s).length + c.services.filter(x => x.s).length + c.highlights.filter(x => x.s).length + c.testimonials.filter(x => x.s).length + (c.brand.aboutS ? 1 : 0) + (c.brand.tagS ? 1 : 0);
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
module.exports = { RESERVED, FONTS, HEAD_WEIGHT, SERIF, BODY_FONTS, SECTION_KEYS, SECTION_DEFAULT_LABEL, TEMPLATES, TEMPLATE_IDS, DEFAULT_CONFIG, LIMITS, templateConfig, sampleCount,
  normUsername, validateUsername, sanitizeConfig, imageIds, renewedExpiry, siteState, daysLeft, dataUrlImage, phone, DAY };
