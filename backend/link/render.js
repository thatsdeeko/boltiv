"use strict";
/* BOLTIV Link: server-side site renderer. Pure HTML+CSS, zero JavaScript, so sites are tiny, fast and safe.
   Everything the owner typed is escaped; images are referenced by id only; colours are validated hex. */
const { FONTS } = require("./logic");
const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const naira = n => "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 });
const nl = s => esc(s).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>");

function render(cfg, o) {
  o = o || {};
  const t = cfg.theme, b = cfg.brand, c = cfg.contact, sec = cfg.sections;
  const img = id => `${o.imgBase || "/_i/"}${id}`;
  const name = b.name || "My Business";
  const go = (k, i) => (o.preview ? "#" : `/_go/${k}${i === undefined ? "" : "?i=" + i}`);
  const wa = c.whatsapp || c.phone;
  const fam = FONTS[t.font] || "Inter";
  const bgCss = t.bgType === "gradient" ? `linear-gradient(160deg,${t.bg},${t.bgGradientTo})` : t.bg;
  const heroImg = b.hero || (t.bgType === "image" ? t.bgImage : "");
  const pageBgImg = t.bgType === "image" && t.bgImage;
  const css = `:root{--p:${t.primary};--a:${t.accent};--bg:${t.bg};--tx:${t.text};--r:${t.radius}px}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font-family:'${t.font}',system-ui,-apple-system,Segoe UI,sans-serif;color:var(--tx);background:${bgCss};${pageBgImg ? `background-image:linear-gradient(rgba(0,0,0,${t.overlay / 100}),rgba(0,0,0,${t.overlay / 100})),url(${img(t.bgImage)});background-size:cover;background-attachment:fixed;` : ""}line-height:1.55}
img{max-width:100%;display:block}a{color:inherit}.w{width:min(1040px,92%);margin:auto}
.top{display:flex;align-items:center;gap:12px;padding:14px 0}.top img{width:44px;height:44px;border-radius:var(--r);object-fit:cover}.top b{font-size:18px}
.hero{padding:56px 0 44px;text-align:center}.hero h1{font-size:clamp(28px,7vw,52px);line-height:1.1;margin:0 0 10px}.hero p{margin:0 auto 22px;max-width:560px;opacity:.85;font-size:clamp(15px,3.6vw,18px)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 24px;border-radius:calc(var(--r) + 8px);background:var(--p);color:#111;font-weight:700;text-decoration:none;border:0;margin:4px}
.btn.o{background:transparent;border:2px solid var(--p);color:inherit}
.hi{margin:0 auto 24px;width:min(560px,100%);aspect-ratio:16/9;object-fit:cover;border-radius:var(--r)}
.l-bold .hero{padding:90px 0;color:#fff;background:linear-gradient(rgba(0,0,0,.${String(t.overlay).padStart(2, "0")}),rgba(0,0,0,.${String(t.overlay).padStart(2, "0")}))${heroImg ? `,url(${img(heroImg)}) center/cover` : `,linear-gradient(135deg,var(--p),var(--a))`}}.l-bold .hi{display:none}
.l-minimal .hero{text-align:left}.l-minimal .hero p{margin-left:0}
.l-shop .hero{padding:28px 0 8px}.l-shop .hero h1{font-size:clamp(22px,5vw,34px)}
section{padding:30px 0}h2{font-size:22px;margin:0 0 16px}
.g{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(min(100%,210px),1fr))}.l-shop .g{grid-template-columns:repeat(2,1fr)}@media(min-width:720px){.l-shop .g{grid-template-columns:repeat(4,1fr)}}
.cd{background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.18);border-radius:var(--r);overflow:hidden;display:flex;flex-direction:column}
.cd img{width:100%;aspect-ratio:1/1;object-fit:cover}.cd div{padding:12px;display:flex;flex-direction:column;gap:4px;flex:1}.cd b{font-size:15px}.cd small{opacity:.75}.pr{color:var(--p);font-weight:800}
.cd .btn{margin:8px 0 0;min-height:42px;padding:0 14px;font-size:14px}.so{opacity:.6;font-size:13px}
.ga{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(130px,1fr))}.ga img{aspect-ratio:1/1;object-fit:cover;border-radius:calc(var(--r) / 1.5);width:100%}
.ct{display:grid;gap:8px}.ct a{text-decoration:none}.ft{padding:28px 0 40px;text-align:center;font-size:13px;opacity:.7}
.wa{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));width:56px;height:56px;border-radius:50%;background:#25d366;display:grid;place-items:center;box-shadow:0 6px 18px rgba(0,0,0,.25);text-decoration:none;color:#fff;font-weight:800}`;
  const card = (p, i, kind) => `<div class="cd">${p.image ? `<img loading="lazy" decoding="async" width="400" height="400" src="${img(p.image)}" alt="${esc(p.name)}">` : ""}<div><b>${esc(p.name)}</b>${p.desc ? `<small>${esc(p.desc)}</small>` : ""}${p.price ? `<span class="pr">${naira(p.price)}</span>` : ""}${kind === "p" && p.available === false ? `<span class="so">Out of stock</span>` : wa ? `<a class="btn" rel="nofollow" href="${go(kind === "p" ? "order" : "book", i)}">${kind === "p" ? "Order on WhatsApp" : "Book now"}</a>` : ""}</div></div>`;
  const soc = [["instagram", "https://instagram.com/", "Instagram"], ["facebook", "https://facebook.com/", "Facebook"], ["tiktok", "https://tiktok.com/@", "TikTok"], ["x", "https://x.com/", "X"]].filter(s => c[s[0]]).map(s => `<a class="btn o" rel="noopener nofollow" target="_blank" href="${s[1]}${encodeURIComponent(c[s[0]])}">${s[2]}</a>`).join("");
  const title = cfg.seo.title || `${name}${b.tagline ? " | " + b.tagline : ""}`, desc = cfg.seo.description || b.tagline || b.about.slice(0, 150);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">${b.logo ? `<meta property="og:image" content="${esc(o.origin || "")}/_i/${b.logo}"><link rel="icon" href="${img(b.logo)}">` : ""}${o.noindex ? '<meta name="robots" content="noindex">' : ""}<meta name="theme-color" content="${t.primary}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${fam}:wght@400;600;700;800&display=swap"><style>${css}</style></head>
<body class="l-${t.layout}"><header class="w top">${b.logo ? `<img src="${img(b.logo)}" width="44" height="44" alt="">` : ""}<b>${esc(name)}</b></header>
<main><div class="hero"><div class="w">${b.hero && t.layout !== "bold" ? `<img class="hi" src="${img(b.hero)}" alt="">` : ""}<h1>${esc(name)}</h1>${b.tagline ? `<p>${esc(b.tagline)}</p>` : ""}${wa ? `<a class="btn" rel="nofollow" href="${go("wa")}">Chat on WhatsApp</a>` : ""}${c.phone ? `<a class="btn o" rel="nofollow" href="${go("call")}">Call us</a>` : ""}</div></div>
<div class="w">${sec.products && cfg.products.length ? `<section><h2>Products</h2><div class="g">${cfg.products.map((p, i) => card(p, i, "p")).join("")}</div></section>` : ""}
${sec.services && cfg.services.length ? `<section><h2>Services</h2><div class="g">${cfg.services.map((p, i) => card(p, i, "s")).join("")}</div></section>` : ""}
${sec.about && b.about ? `<section><h2>About us</h2><p>${nl(b.about)}</p></section>` : ""}
${sec.gallery && cfg.gallery.length ? `<section><h2>Gallery</h2><div class="ga">${cfg.gallery.map(id => `<img loading="lazy" decoding="async" width="300" height="300" src="${img(id)}" alt="">`).join("")}</div></section>` : ""}
${sec.contact && (c.phone || c.whatsapp || c.email || c.address || c.hours || soc) ? `<section><h2>Contact</h2><div class="ct">${c.address ? `<div>📍 ${esc(c.address)}</div>` : ""}${c.hours ? `<div>🕒 ${esc(c.hours)}</div>` : ""}${c.phone ? `<a href="${go("call")}" rel="nofollow">📞 +${esc(c.phone)}</a>` : ""}${c.email ? `<a href="mailto:${esc(c.email)}">✉️ ${esc(c.email)}</a>` : ""}</div>${soc ? `<div style="margin-top:10px">${soc}</div>` : ""}</section>` : ""}</div></main>
<footer class="ft w">© ${new Date().getFullYear()} ${esc(name)} · Made with <a href="https://boltiv.ng/boltiv-link" rel="noopener">BOLTIV Link</a></footer>${wa ? `<a class="wa" rel="nofollow" aria-label="WhatsApp" href="${go("wa")}">WA</a>` : ""}</body></html>`;
}
const page = (title, msg, extra) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#fffdf7;color:#171717;text-align:center;padding:24px}h1{margin:0 0 8px}p{color:#68645b;max-width:420px}a{display:inline-block;margin-top:14px;padding:13px 22px;border-radius:999px;background:#c9a227;color:#111;font-weight:700;text-decoration:none}</style></head><body><div><h1>${esc(title)}</h1><p>${esc(msg)}</p>${extra || ""}</div></body></html>`;
module.exports = { render, page, esc };
