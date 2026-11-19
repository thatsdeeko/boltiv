"use strict";
/* BOLTIV Link: server-side site renderer. Each template is a distinct design (cover, product layout, spacing, type),
   all built on one shared quality bar. Pure HTML + CSS, no JavaScript: tiny, fast and safe. Owner text is always escaped,
   images are referenced by id only, colours are validated hex and every derived colour is computed here (no modern-CSS dependence). */
const L = require("./logic");
const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const naira = n => "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 });
const nl = s => esc(s).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");

/* ---------- colour helpers ---------- */
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const hex = a => "#" + a.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, w) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v * (1 - w) + y[i] * w)); };
const lum = h => { const [r, g, b] = rgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const onColor = h => (lum(h) > 0.42 ? "#111111" : "#ffffff");
/* Make an accent colour readable as text on the page background. */
function readable(c, bg) { let o = c, n = 0; const dark = lum(bg) < 0.4; while (Math.abs(lum(o) - lum(bg)) < 0.28 && n++ < 8) o = mix(o, dark ? "#ffffff" : "#000000", 0.18); return o; }

/* ---------- generated artwork: used as the cover when no photo is uploaded, so a new site never looks empty ---------- */
function art(kind, c1, c2, c3) {
  const defs = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient><radialGradient id="r"><stop offset="0" stop-color="${c3}" stop-opacity=".55"/><stop offset="1" stop-color="${c3}" stop-opacity="0"/></radialGradient></defs><rect width="1200" height="800" fill="url(#g)"/>`;
  const sh = {
    arcs: `<g fill="none" stroke="${c3}" stroke-opacity=".28">${[120, 220, 320, 420, 520].map(r => `<circle cx="980" cy="160" r="${r}"/>`).join("")}</g><circle cx="980" cy="160" r="260" fill="url(#r)"/>`,
    dots: `<g fill="${c3}" fill-opacity=".22">${Array.from({ length: 12 * 7 }, (_, i) => `<circle cx="${60 + (i % 12) * 100}" cy="${60 + Math.floor(i / 12) * 110}" r="${3 + (i % 3)}"/>`).join("")}</g><circle cx="200" cy="680" r="340" fill="url(#r)"/>`,
    blobs: `<circle cx="1000" cy="140" r="360" fill="url(#r)"/><circle cx="160" cy="700" r="320" fill="url(#r)"/><circle cx="640" cy="420" r="210" fill="${c3}" fill-opacity=".12"/>`,
    grid: `<g stroke="${c3}" stroke-opacity=".16">${Array.from({ length: 13 }, (_, i) => `<path d="M${i * 100} 0V800"/>`).join("")}${Array.from({ length: 9 }, (_, i) => `<path d="M0 ${i * 100}H1200"/>`).join("")}</g><circle cx="900" cy="260" r="300" fill="url(#r)"/>`,
    waves: `<g fill="none" stroke="${c3}" stroke-opacity=".3" stroke-width="2">${Array.from({ length: 9 }, (_, i) => `<path d="M0 ${300 + i * 46} C 300 ${200 + i * 46}, 600 ${440 + i * 46}, 1200 ${280 + i * 46}"/>`).join("")}</g><circle cx="220" cy="140" r="300" fill="url(#r)"/>`
  }[kind] || "";
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">${defs}${sh}</svg>`)}")`;
}
const ICON_WA = `<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.8-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.300.1-.2 0-.3 0-.4l-.8-1.800c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.200c0 1.300.9 2.600 1 2.700.1.200 1.800 2.900 4.500 4 1.700.7 2.300.7 3.100.6.500-.1 1.500-.6 1.700-1.200.2-.6.2-1.100.2-1.200-.1-.1-.3-.2-.5-.3z"/></svg>`;

function render(cfg, o) {
  o = o || {};
  const t = cfg.theme, b = cfg.brand, c = cfg.contact, tpl = L.TEMPLATES[t.template] || L.TEMPLATES.atelier;
  const img = id => `${o.imgBase || "/_i/"}${id}`;
  const name = b.name || "My Business";
  const wa = c.whatsapp || c.phone;
  const go = (k, i) => (o.preview ? "#" : `/_go/${k}${i === undefined ? "" : "?i=" + i}`);
  const dark = lum(t.bg) < 0.4;
  const surface = mix(t.bg, t.text, dark ? 0.09 : 0.035), line = mix(t.bg, t.text, dark ? 0.2 : 0.12), muted = mix(t.text, t.bg, 0.38);
  const pOn = onColor(t.primary), pText = readable(t.primary, t.bg), tint = mix(t.bg, t.primary, dark ? 0.2 : 0.1);
  const hf = t.headFont, bf = t.bodyFont, hw = L.HEAD_WEIGHT[hf] || 700, serif = L.SERIF.has(hf);
  const fams = [...new Set([hf, bf, "Inter"].slice(0, 2))].map(f => "family=" + L.FONTS[f]).join("&");
  const labelOf = k => (cfg.labels && cfg.labels[k]) || tpl.labels[k] || L.SECTION_DEFAULT_LABEL[k];
  const hasItems = { products: cfg.products.length, services: cfg.services.length, highlights: cfg.highlights.length, testimonials: cfg.testimonials.length, gallery: cfg.gallery.length,
    about: !!b.about, contact: !!(c.phone || c.whatsapp || c.email || c.address || c.hours || c.instagram || c.facebook || c.tiktok || c.x) };
  const shown = cfg.order.filter(k => cfg.sections[k] && hasItems[k]);
  const hero = { atelier: "full", glow: "full", bistro: "center", market: "split", studio: "split", folio: "type" }[tpl.id];
  const heroImg = b.hero || (t.bgType === "image" ? t.bgImage : "");
  const c1 = lum(t.accent) < 0.2 ? mix(t.accent, t.primary, 0.25) : t.accent, c2 = mix(t.accent, t.primary, 0.55);
  const artBg = art(tpl.art, c1, c2, t.primary);
  const heroFg = heroImg ? "#ffffff" : onColor(mix(c1, c2, 0.5));
  const pageBg = t.bgType === "gradient" ? `linear-gradient(170deg,${t.bg},${t.bgGradientTo})` : t.bg;
  const imgBgCss = t.bgType === "image" && t.bgImage ? `body{background-image:linear-gradient(rgba(0,0,0,${t.overlay / 100}),rgba(0,0,0,${t.overlay / 100})),url(${img(t.bgImage)});background-size:cover;background-attachment:fixed}` : "";
  const ink = "var(--tx)";

  /* ---------- items ---------- */
  const mono = n => `<div class="mono" aria-hidden="true"><span>${esc(String(n || "?").trim().charAt(0).toUpperCase())}</span></div>`;
  const pic = (p, w, h) => (p.image ? `<img loading="lazy" decoding="async" width="${w}" height="${h}" src="${img(p.image)}" alt="${esc(p.name)}">` : mono(p.name));
  const cta = (kind, i, p) => (kind === "p" && p.available === false ? `<span class="soldout">Sold out</span>` : wa ? `<a class="lnk" rel="nofollow" href="${go(kind === "p" ? "order" : "book", i)}">${kind === "p" ? "Order on WhatsApp" : "Book now"}</a>` : "");
  const priceTxt = (p, kind) => (p.price ? `${kind === "s" && tpl.id === "studio" ? "From " : ""}${naira(p.price)}` : "");
  const ITEM = {
    portrait: (p, i, k) => `<article class="it portrait"><div class="ph r34">${pic(p, 480, 640)}${k === "p" && p.available === false ? `<span class="badge">Sold out</span>` : ""}</div><h3>${esc(p.name)}</h3>${p.desc ? `<p class="d">${esc(p.desc)}</p>` : ""}<div class="pr">${priceTxt(p, k)}</div>${cta(k, i, p)}</article>`,
    card: (p, i, k) => `<article class="it card"><div class="ph r11">${pic(p, 480, 480)}${k === "p" && p.available === false ? `<span class="badge">Sold out</span>` : ""}</div><div class="bd"><h3>${esc(p.name)}</h3>${p.desc ? `<p class="d">${esc(p.desc)}</p>` : ""}<div class="pr">${priceTxt(p, k)}</div>${wa && !(k === "p" && p.available === false) ? `<a class="btn sm" rel="nofollow" href="${go(k === "p" ? "order" : "book", i)}">${k === "p" ? "Order on WhatsApp" : "Book now"}</a>` : ""}</div></article>`,
    menu: (p, i, k) => `<article class="it menu">${p.image ? `<img loading="lazy" decoding="async" width="96" height="96" src="${img(p.image)}" alt="${esc(p.name)}">` : ""}<div class="mb"><div class="mh"><h3${k === "p" && p.available === false ? ' class="x"' : ""}>${esc(p.name)}</h3><span class="dots"></span><span class="pr">${priceTxt(p, k)}</span></div>${p.desc ? `<p class="d">${esc(p.desc)}</p>` : ""}${cta(k, i, p)}</div></article>`,
    rows: (p, i, k) => `<article class="it rows">${p.image ? `<img loading="lazy" decoding="async" width="120" height="120" src="${img(p.image)}" alt="${esc(p.name)}">` : ""}<div class="mb"><h3>${esc(p.name)}</h3>${p.desc ? `<p class="d">${esc(p.desc)}</p>` : ""}${cta(k, i, p)}</div><div class="pr">${priceTxt(p, k)}</div></article>`,
    numbered: (p, i, k) => `<article class="it numbered"><span class="no">${String(i + 1).padStart(2, "0")}</span><div class="mb"><h3>${esc(p.name)}</h3>${p.desc ? `<p class="d">${esc(p.desc)}</p>` : ""}</div><div class="side"><div class="pr">${priceTxt(p, k)}</div>${cta(k, i, p)}</div></article>`
  };
  const STYLE = { atelier: ["portrait", "rows"], bistro: ["menu", "menu"], market: ["card", "rows"], studio: ["card", "numbered"], folio: ["rows", "numbered"], glow: ["card", "menu"] }[tpl.id];
  const wrapC = { portrait: "grid g-portrait", card: "grid g-card", menu: "menus", rows: "list", numbered: "list" };
  const itemSection = (key, kind) => { const st = STYLE[key === "products" ? 0 : 1], arr = cfg[key]; return `<div class="${wrapC[st]}">${arr.map((p, i) => ITEM[st](p, i, kind)).join("")}</div>`; };

  /* ---------- sections ---------- */
  const head = (k, sub) => `<header class="sh"><span class="eyebrow">${esc(String(shown.indexOf(k) + 1).padStart(2, "0"))}</span><h2>${esc(labelOf(k))}</h2>${sub ? `<p class="sub">${esc(sub)}</p>` : ""}</header>`;
  const SEC = {
    products: () => `<section id="products" class="sec">${head("products")}${itemSection("products", "p")}</section>`,
    services: () => `<section id="services" class="sec alt">${head("services")}${itemSection("services", "s")}</section>`,
    highlights: () => `<section id="highlights" class="sec">${head("highlights")}<div class="hl">${cfg.highlights.map((h, i) => `<div class="hi"><span class="hn">${String(i + 1).padStart(2, "0")}</span><h3>${esc(h.title)}</h3><p>${esc(h.desc)}</p></div>`).join("")}</div></section>`,
    about: () => `<section id="about" class="sec alt"><div class="ab">${head("about")}<div class="abt">${nl(b.about)}</div></div></section>`,
    gallery: () => `<section id="gallery" class="sec">${head("gallery")}<div class="ga">${cfg.gallery.map(id => `<img loading="lazy" decoding="async" width="600" height="750" src="${img(id)}" alt="">`).join("")}</div></section>`,
    testimonials: () => `<section id="testimonials" class="sec alt">${head("testimonials")}<div class="tm">${cfg.testimonials.map(q => `<figure><blockquote>${esc(q.quote)}</blockquote>${q.name ? `<figcaption>${esc(q.name)}</figcaption>` : ""}</figure>`).join("")}</div></section>`,
    contact: () => {
      const soc = [["instagram", "https://instagram.com/", "Instagram"], ["facebook", "https://facebook.com/", "Facebook"], ["tiktok", "https://tiktok.com/@", "TikTok"], ["x", "https://x.com/", "X"]].filter(s => c[s[0]]).map(s => `<a class="chip" rel="noopener nofollow" target="_blank" href="${s[1]}${encodeURIComponent(c[s[0]])}">${s[2]}</a>`).join("");
      return `<section id="contact" class="sec ct">${head("contact")}<div class="cg"><div class="ci">${c.address ? `<div class="row"><b>Address</b><span>${esc(c.address)}</span><a class="lnk" rel="noopener nofollow" target="_blank" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}">Open in Maps</a></div>` : ""}${c.hours ? `<div class="row"><b>Opening hours</b><span>${esc(c.hours)}</span></div>` : ""}${c.phone ? `<div class="row"><b>Phone</b><a href="${go("call")}" rel="nofollow">+${esc(c.phone)}</a></div>` : ""}${c.email ? `<div class="row"><b>Email</b><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ""}${soc ? `<div class="row"><b>Follow</b><span class="chips">${soc}</span></div>` : ""}</div>${wa ? `<div class="cc"><h3>${tpl.id === "bistro" ? "Hungry?" : "Let’s talk"}</h3><p>Message us on WhatsApp and we will reply as soon as we can.</p><a class="btn" rel="nofollow" href="${go("wa")}">Chat on WhatsApp</a></div>` : ""}</div></section>`;
    }
  };
  const navItems = shown.filter(k => k !== "highlights").map(k => `<a href="#${k}">${esc(labelOf(k))}</a>`).join("");
  const ctaBtn = wa ? `<a class="btn sm" rel="nofollow" href="${go("wa")}">${tpl.id === "glow" ? "Book now" : tpl.id === "bistro" ? "Order now" : tpl.id === "studio" ? "Get a quote" : "WhatsApp"}</a>` : "";
  const logo = b.logo ? `<img class="lg" src="${img(b.logo)}" width="40" height="40" alt="">` : "";
  const heroBtns = `${wa ? `<a class="btn" rel="nofollow" href="${go("wa")}">${tpl.id === "bistro" ? "Order on WhatsApp" : tpl.id === "glow" ? "Book on WhatsApp" : "Chat on WhatsApp"}</a>` : ""}${shown.includes("products") ? `<a class="btn ghost" href="#products">${esc(labelOf("products"))}</a>` : shown[0] ? `<a class="btn ghost" href="#${shown[0]}">${esc(labelOf(shown[0]))}</a>` : ""}`;
  const heroMedia = heroImg ? `<img class="hm" fetchpriority="high" width="1200" height="800" src="${img(heroImg)}" alt="">` : "";
  const heroHtml = `<section class="hero h-${hero}${heroImg ? " has-img" : ""}"><div class="hbg">${heroMedia}</div><div class="w hin"><div class="ht">${b.tagline ? `<p class="kick">${esc(b.tagline)}</p>` : ""}<h1>${esc(name)}</h1><div class="hb">${heroBtns}</div></div>${hero === "split" ? `<div class="hv">${heroImg ? `<img width="900" height="900" fetchpriority="high" src="${img(heroImg)}" alt="">` : `<div class="hart"></div>`}</div>` : ""}</div></section>`;

  const css = `:root{--p:${t.primary};--pt:${pText};--po:${pOn};--a:${t.accent};--bg:${t.bg};--tx:${t.text};--sf:${surface};--ln:${line};--mu:${muted};--ti:${tint};--r:${t.radius}px;--hf:'${hf}',${serif ? "Georgia,'Times New Roman',serif" : "system-ui,sans-serif"};--bf:'${bf}',system-ui,-apple-system,'Segoe UI',sans-serif}
*{box-sizing:border-box}html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{animation:none!important}}
body{margin:0;font-family:var(--bf);font-size:16px;line-height:1.7;color:var(--tx);background:${pageBg};-webkit-font-smoothing:antialiased}${imgBgCss}
img{max-width:100%;display:block}a{color:inherit}h1,h2,h3{font-family:var(--hf);font-weight:${hw};margin:0;line-height:1.12;letter-spacing:${serif ? "-.01em" : "-.02em"}}p{margin:0}
.w{width:min(1140px,100% - 40px);margin-inline:auto}section[id]{scroll-margin-top:96px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:50px;padding:0 28px;border-radius:calc(var(--r) * 2.2 + 2px);background:var(--p);color:var(--po);font:700 15px/1 var(--bf);text-decoration:none;border:2px solid var(--p);transition:transform .15s,opacity .15s;letter-spacing:.01em}.btn:active{transform:scale(.98)}.btn:hover{opacity:.92}
.btn.ghost{background:transparent;color:inherit;border-color:currentColor}.btn.sm{min-height:42px;padding:0 20px;font-size:14px}.lnk{display:inline-block;margin-top:8px;font-weight:700;font-size:14px;color:var(--pt);text-decoration:none;border-bottom:2px solid currentColor;padding-bottom:1px}
.nav{position:sticky;top:0;z-index:20;background:${rgbaBg(t.bg, 0.9)};backdrop-filter:saturate(1.4) blur(14px);-webkit-backdrop-filter:saturate(1.4) blur(14px);border-bottom:1px solid var(--ln);padding-top:env(safe-area-inset-top,0)}
.ni{display:flex;align-items:center;gap:14px;min-height:64px;flex-wrap:wrap}.brand{display:flex;align-items:center;gap:10px;text-decoration:none;font:${hw} 20px/1 var(--hf);letter-spacing:-.01em;margin-right:auto}.lg{width:40px;height:40px;border-radius:calc(var(--r) / 1.4);object-fit:cover}
.links{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;order:3;width:100%;padding-bottom:10px;margin-inline:-4px}.links::-webkit-scrollbar{display:none}.links a{flex:none;padding:8px 14px;border-radius:99px;text-decoration:none;font-size:14px;font-weight:600;color:var(--mu)}.links a:hover{background:var(--sf);color:var(--tx)}
@media(min-width:860px){.links{order:0;width:auto;padding:0;margin:0}.ni{flex-wrap:nowrap}.brand{margin-right:20px}.links{margin-right:auto}}
.hero{position:relative;overflow:hidden;color:var(--tx)}.hbg{position:absolute;inset:0;z-index:0;background:${artBg} center/cover}.hm{width:100%;height:100%;object-fit:cover}
.kick{font-size:clamp(15px,3.8vw,19px);opacity:.9;max-width:34ch;margin-bottom:14px}.hero h1{font-size:clamp(40px,11vw,84px)}.hb{display:flex;gap:12px;flex-wrap:wrap;margin-top:26px}.hin{position:relative;z-index:1}
@keyframes up{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}.ht{animation:up .7s ease both}
.h-full,.h-center{color:${heroFg};min-height:min(86vh,720px);display:flex;align-items:flex-end}.h-full .hbg:after,.h-center .hbg:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.18) 0%,rgba(0,0,0,.72) 100%)}
.h-full .hin{padding:90px 0 56px}.h-full .hb .ghost{color:${heroFg}}.h-full h1{max-width:12ch}
.h-center{align-items:center;text-align:center}.h-center .hin{padding:96px 0}.h-center .kick{margin-inline:auto}.h-center .hb{justify-content:center}.h-center .hb .ghost{color:${heroFg}}.h-center h1{margin-inline:auto;max-width:14ch}
.h-split{background:var(--ti)}.h-split .hbg{display:none}.h-split .hin{display:grid;gap:34px;padding:56px 0 60px;align-items:center}.hv img,.hart{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:calc(var(--r) * 1.6)}.hart{background:${artBg} center/cover}
@media(min-width:860px){.h-split .hin{grid-template-columns:1.05fr .95fr;padding:84px 0}}.h-split h1{font-size:clamp(36px,9vw,66px)}
.h-type{border-bottom:1px solid var(--ln)}.h-type .hbg{inset:auto 0 0 0;height:34%;opacity:.16}.h-type .hin{padding:84px 0 150px}.h-type h1{font-size:clamp(46px,13vw,128px);letter-spacing:-.04em;line-height:.96}.h-type .kick{max-width:44ch;color:var(--mu)}
.sec{padding:clamp(60px,10vw,112px) 0}.sec.alt{background:var(--sf)}.sec>*{width:min(1140px,100% - 40px);margin-inline:auto}
.sh{margin-bottom:clamp(30px,5vw,52px)}.eyebrow{display:inline-block;font:700 12px/1 var(--bf);letter-spacing:.18em;color:var(--pt);margin-bottom:14px}.eyebrow:after{content:"";display:inline-block;width:34px;height:2px;background:currentColor;vertical-align:middle;margin-left:10px}
.sh h2{font-size:clamp(30px,6.4vw,52px)}.sub{margin-top:10px;color:var(--mu);max-width:52ch}
.grid{display:grid;gap:clamp(16px,3vw,32px)}.g-portrait{grid-template-columns:repeat(2,1fr)}.g-card{grid-template-columns:repeat(2,1fr)}@media(min-width:760px){.g-portrait{grid-template-columns:repeat(4,1fr)}.g-card{grid-template-columns:repeat(3,1fr)}}
.ph{position:relative;overflow:hidden;border-radius:var(--r);background:var(--sf)}.r34{aspect-ratio:3/4}.r11{aspect-ratio:1/1}.ph img{width:100%;height:100%;object-fit:cover}
.mono{height:100%;display:grid;place-items:center;background:linear-gradient(145deg,var(--ti),${mix(t.bg, t.primary, dark ? 0.34 : 0.2)});color:var(--pt)}.mono span{font:${hw} clamp(44px,12vw,72px)/1 var(--hf);opacity:.85}
.badge,.soldout{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}.badge{position:absolute;top:10px;left:10px;background:var(--tx);color:var(--bg);padding:6px 10px;border-radius:99px}.soldout{color:var(--mu)}
.it h3{font-size:clamp(17px,4.4vw,21px)}.d{color:var(--mu);font-size:15px;margin-top:6px}.pr{font-weight:700;color:var(--pt);font-size:17px;margin-top:8px}
.portrait h3{margin-top:14px;font-family:var(--bf);font-weight:600;font-size:14px;letter-spacing:.12em;text-transform:uppercase}.portrait .d{display:none}.portrait .pr{color:var(--tx);font-weight:500;margin-top:4px}
.card{background:var(--bg);border:1px solid var(--ln);border-radius:calc(var(--r) * 1.2);overflow:hidden;display:flex;flex-direction:column}.card .ph{border-radius:0}.bd{padding:16px;display:flex;flex-direction:column;flex:1}.bd .btn{margin-top:auto;width:100%}.bd .pr{margin-bottom:14px}
.menus{display:grid;gap:6px 56px}@media(min-width:860px){.menus{grid-template-columns:1fr 1fr}}.menu{display:flex;gap:16px;padding:18px 0;border-bottom:1px dashed var(--ln)}.menu img{width:72px;height:72px;border-radius:var(--r);object-fit:cover;flex:none}.mb{flex:1;min-width:0}.mh{display:flex;align-items:baseline;gap:10px}.mh h3{font-size:clamp(18px,4.6vw,22px)}.dots{flex:1;border-bottom:2px dotted var(--ln);transform:translateY(-4px);min-width:16px}.mh .pr{margin:0}.x{text-decoration:line-through;opacity:.55}
.list{border-top:1px solid var(--ln)}.rows{display:flex;gap:18px;align-items:center;padding:22px 0;border-bottom:1px solid var(--ln)}.rows img{width:84px;height:84px;border-radius:var(--r);object-fit:cover;flex:none}.rows .pr{margin:0;white-space:nowrap}
.numbered{display:grid;grid-template-columns:auto 1fr;gap:6px 18px;padding:26px 0;border-bottom:1px solid var(--ln)}.no{font:700 14px/2 var(--bf);color:var(--pt);letter-spacing:.1em}.side{grid-column:2}.numbered .pr{margin-top:10px}@media(min-width:760px){.numbered{grid-template-columns:70px 1fr auto;align-items:start}.side{grid-column:auto;text-align:right}}
.hl{display:grid;gap:20px}@media(min-width:760px){.hl{grid-template-columns:repeat(3,1fr)}}.hi{padding:26px;border:1px solid var(--ln);border-radius:calc(var(--r) * 1.2);background:var(--bg)}.sec:not(.alt) .hi{background:var(--sf);border-color:transparent}.hn{font:700 13px/1 var(--bf);letter-spacing:.14em;color:var(--pt)}.hi h3{font-size:22px;margin:16px 0 8px}.hi p{color:var(--mu)}
.abt{max-width:64ch;display:grid;gap:18px;font-size:clamp(17px,4.2vw,20px)}.abt p:first-child{font-family:var(--hf);font-size:clamp(22px,5vw,30px);line-height:1.4;font-weight:${hw}}.abt p+p{color:var(--mu)}
.ga{display:grid;gap:10px;grid-template-columns:repeat(2,1fr)}.ga img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:var(--r)}@media(min-width:760px){.ga{grid-template-columns:repeat(3,1fr);gap:16px}.ga img:first-child{grid-column:span 2;aspect-ratio:16/10;grid-row:span 1}}
.tm{display:grid;gap:20px}@media(min-width:760px){.tm{grid-template-columns:repeat(2,1fr)}}figure{margin:0;padding:30px;background:var(--bg);border:1px solid var(--ln);border-radius:calc(var(--r) * 1.2)}blockquote{margin:0;font:${hw} clamp(19px,4.6vw,24px)/1.4 var(--hf)}blockquote:before{content:"“";display:block;font-size:56px;line-height:.6;color:var(--pt);margin-bottom:10px}figcaption{margin-top:16px;font-size:14px;font-weight:700;color:var(--mu)}
.cg{display:grid;gap:28px}@media(min-width:860px){.cg{grid-template-columns:1.1fr .9fr;align-items:start}}.row{padding:18px 0;border-bottom:1px solid var(--ln);display:grid;gap:3px}.row b{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--mu)}.row a{text-decoration:none;font-weight:600}.chips{display:flex;gap:8px;flex-wrap:wrap}.chip{padding:8px 16px;border:1px solid var(--ln);border-radius:99px;font-size:14px}
.cc{background:var(--a);color:${onColor(t.accent)};padding:clamp(26px,5vw,40px);border-radius:calc(var(--r) * 1.6)}.cc h3{font-size:clamp(26px,6vw,36px)}.cc p{margin:10px 0 22px;opacity:.85}.cc .btn{background:var(--p);color:var(--po);border-color:var(--p)}
.ft{padding:36px 0 calc(48px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--ln);text-align:center;color:var(--mu);font-size:14px}.ft b{display:block;font:${hw} 20px/1 var(--hf);color:var(--tx);margin-bottom:10px}.ft a{color:inherit}
.wa{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));width:58px;height:58px;border-radius:50%;background:#25d366;color:#fff;display:grid;place-items:center;box-shadow:0 8px 24px rgba(0,0,0,.28);z-index:30}
${tpl.id === "atelier" ? ".sh h2{font-style:italic;font-weight:400}.btn{border-radius:0;text-transform:uppercase;letter-spacing:.14em;font-size:13px}.ph{border-radius:0}" : ""}
${tpl.id === "folio" ? ".sh h2{text-transform:none}.btn{border-radius:0}.rows h3{font-size:clamp(22px,6vw,34px)}" : ""}
${tpl.id === "glow" ? ".hero .btn.ghost{background:rgba(255,255,255,.14)}.hi{text-align:center}.sh{text-align:center}.eyebrow:after{display:none}.sh .sub{margin-inline:auto}" : ""}
${tpl.id === "bistro" ? ".sh{text-align:center}.eyebrow:after{display:none}.sh .sub{margin-inline:auto}.sh h2:after{content:\"\";display:block;width:56px;height:3px;background:var(--p);margin:16px auto 0}" : ""}`;
  const title = cfg.seo.title || `${name}${b.tagline ? " | " + b.tagline : ""}`, desc = cfg.seo.description || b.tagline || b.about.slice(0, 150);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website">${b.logo ? `<meta property="og:image" content="${esc(o.origin || "")}/_i/${b.logo}"><link rel="icon" href="${img(b.logo)}">` : ""}${o.noindex ? '<meta name="robots" content="noindex">' : ""}<meta name="theme-color" content="${t.bg}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fams}&display=swap"><style>${css}</style></head>
<body><header class="nav"><div class="w ni"><a class="brand" href="#top">${logo}<span>${esc(name)}</span></a><nav class="links" aria-label="Sections">${navItems}</nav>${ctaBtn}</div></header><a id="top"></a>
<main>${heroHtml}${shown.map(k => SEC[k]()).join("")}</main>
<footer class="ft"><div class="w"><b>${esc(name)}</b>${b.tagline && !b.tagS ? `<div>${esc(b.tagline)}</div>` : ""}<div style="margin-top:14px">© ${new Date().getFullYear()} ${esc(name)} · Made with <a href="https://boltiv.ng/boltiv-link" rel="noopener">BOLTIV Link</a></div></div></footer>${wa ? `<a class="wa" rel="nofollow" aria-label="Chat on WhatsApp" href="${go("wa")}">${ICON_WA}</a>` : ""}</body></html>`;
}
function rgbaBg(h, a) { const [r, g, b] = rgb(h); return `rgba(${r},${g},${b},${a})`; }
const page = (title, msg, extra) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#fffdf7;color:#171717;text-align:center;padding:24px}h1{margin:0 0 8px}p{color:#68645b;max-width:420px}a{display:inline-block;margin-top:14px;padding:13px 22px;border-radius:999px;background:#c9a227;color:#111;font-weight:700;text-decoration:none}</style></head><body><div><h1>${esc(title)}</h1><p>${esc(msg)}</p>${extra || ""}</div></body></html>`;
module.exports = { render, page, esc };
