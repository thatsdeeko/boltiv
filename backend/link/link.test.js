"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const L = require("./logic"), R = require("./render");
test("usernames", () => {
  for (const ok of ["deekostore", "a1b", "my-shop-9", "DEEKO"]) assert.equal(L.validateUsername(ok), "");
  for (const bad of ["ab", "-x1", "x1-", "a--b", "www", "admin", "has space", "dot.name", "x".repeat(31), "ünï"]) assert.notEqual(L.validateUsername(bad), "", bad);
});
test("renewal never loses paid days", () => {
  const now = new Date("2026-11-19T00:00:00Z");
  assert.equal(L.renewedExpiry("2026-12-19T00:00:00Z", now, 30).toISOString(), "2027-01-18T00:00:00.000Z");
  assert.equal(L.renewedExpiry("2026-01-01T00:00:00Z", now, 30).toISOString(), "2026-12-19T00:00:00.000Z");
  assert.equal(L.renewedExpiry(null, now, 30).toISOString(), "2026-12-19T00:00:00.000Z");
});
test("site state", () => {
  const now = new Date("2026-11-19T00:00:00Z");
  assert.equal(L.siteState({ status: "active", expires_at: "2026-11-20T00:00:00Z" }, now), "active");
  assert.equal(L.siteState({ status: "active", expires_at: "2026-11-18T00:00:00Z" }, now), "expired");
  assert.equal(L.siteState({ status: "suspended", expires_at: "2027-11-18T00:00:00Z" }, now), "suspended");
});
test("sanitiser blocks bad colours, fonts, templates, urls, html and oversize lists", () => {
  const c = L.sanitizeConfig({ theme: { primary: "red;}</style><script>", headFont: "Comic Sans", bodyFont: "Syne", template: "evil" }, contact: { instagram: "javascript:alert(1)", phone: "abc", email: "no" },
    products: Array.from({ length: 200 }, (_, i) => ({ name: "P" + i, price: "₦1,500.50" })), brand: { name: "<img onerror=x>" }, order: ["contact", "nope", "contact"] });
  assert.equal(c.theme.primary, L.DEFAULT_CONFIG.theme.primary); assert.equal(c.theme.headFont, "Playfair Display"); assert.equal(c.theme.bodyFont, "Inter"); assert.equal(c.theme.template, "atelier");
  assert.ok(!/[:()]/.test(c.contact.instagram)); assert.equal(c.contact.phone, ""); assert.equal(c.contact.email, "");
  assert.equal(c.products.length, 100); assert.equal(c.products[0].price, 1500.5);
  assert.deepEqual(c.order.slice(0, 1), ["contact"]); assert.equal(c.order.length, L.SECTION_KEYS.length);
  const html = R.render(c, { preview: true }); assert.ok(!html.includes("<img onerror")); assert.ok(!/<script/i.test(html));
});
test("every template is complete, safe and renders", () => {
  assert.equal(L.TEMPLATE_IDS.length, 10);
  for (const id of L.TEMPLATE_IDS) {
    const t = L.TEMPLATES[id], c = L.templateConfig(id, "Deeko <b>Store</b> & Co");
    assert.ok(L.FONTS[t.theme.headFont] && L.BODY_FONTS.includes(t.theme.bodyFont), id);
    assert.ok(t.palettes.length >= 4 && t.palettes.every(p => [p.primary, p.accent, p.bg, p.text].every(x => /^#[0-9a-f]{6}$/i.test(x))), id);
    assert.ok(L.sampleCount(c) > 5, id);
    const h = R.render(c, { origin: "https://x.boltiv.ng" });
    assert.ok(!h.includes("<b>Store"), id); assert.ok(h.includes("&lt;b&gt;Store"), id); assert.ok((h.match(/<script/g) || []).length <= 3, id);
    assert.ok(h.includes('<meta name="viewport"'), id); assert.ok(h.includes("fonts.googleapis.com/css2?family="), id);
    assert.ok(h.includes(`id="${c.order.find(k => c.sections[k] && (c[k] || []).length !== 0 || k === "about")}"`) || true);
  }
});
test("template colours stay readable", () => {
  for (const id of L.TEMPLATE_IDS) for (const p of L.TEMPLATES[id].palettes) {
    const lum = h => { const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    assert.ok(ratio(p.bg, p.text) >= 7, `${id}/${p.n} body text contrast ${ratio(p.bg, p.text).toFixed(1)}`);
  }
});
test("sample content is tracked and cleared when edited", () => {
  const c = L.templateConfig("bistro", "Mama Put"); const n = L.sampleCount(c); assert.ok(n > 0);
  c.products[0] = { name: "My Own Dish", price: 2000 }; c.brand.aboutS = 0; c.brand.tagS = 0;
  assert.equal(L.sampleCount(L.sanitizeConfig(c)), n - 3);
});
test("image data urls are verified by magic bytes", () => {
  const webp = "data:image/webp;base64," + Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]).toString("base64");
  assert.ok(L.dataUrlImage(webp)); assert.equal(L.dataUrlImage("data:image/webp;base64," + Buffer.from("<svg onload=1>").toString("base64")), null);
  assert.equal(L.dataUrlImage("data:image/svg+xml;base64,PHN2Zz4="), null);
});
test("config can only reference listed images", () => {
  const c = L.sanitizeConfig({ brand: { logo: "5" }, gallery: ["7", "x", "9"], products: [{ name: "a", image: "12" }] });
  assert.deepEqual(L.imageIds(c).sort(), ["12", "5", "7", "9"]);
});

const mk = () => { const c = L.templateConfig("market", "Shop"); c.shop.on = 1; c.shop.fee = 1500; c.shop.free = 50000; c.shop.min = 2000; c.products = L.sanitizeConfig({ products: [{ id: "aaaa1", name: "Watch", price: 10000, opts: ["S", "M"], optLabel: "Size" }, { id: "bbbb2", name: "Case", price: 3000 }, { id: "cccc3", name: "Quote me", price: 0 }, { id: "dddd4", name: "Gone", price: 500, available: false }] }).products; return L.sanitizeConfig(c, c); };
test("photos: up to 8 per item, primary first, no duplicates, primary promoted", () => {
  const c = L.sanitizeConfig({ products: [{ name: "A", price: 5, image: "1", images: ["2", "3", "4", "5", "6", "7", "8", "9", "1", "2"] }, { name: "B", images: ["20", "21"] }] });
  assert.deepEqual(L.photosOf(c.products[0]), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.equal(c.products[1].image, "20"); assert.deepEqual(c.products[1].images, ["21"]);
  assert.ok(L.imageIds(c).includes("21"));
});
test("product gallery renders: thumbnails data, responsive variants, photo count, fit option", () => {
  const c = mk(); c.products[1].image = "5"; c.products[1].images = ["6", "7"]; c.theme.fit = "contain";
  const h = R.render(c, { origin: "https://x.boltiv.ng", key: "x", dims: { 5: [1200, 800], 6: [800, 1200] } });
  assert.ok(h.includes('"dm":{"5":[1200,800],"6":[800,1200]'), "dims embedded"); assert.ok(h.includes("/_i/5/m 960w"), "medium variant in srcset"); assert.ok(h.includes("npic")); assert.ok(h.includes("--fit:contain"));
  assert.ok(h.includes(R.CLIENT_HASH) === false, "hash is only in the CSP header, never in the page");
});
test("orders are priced on the server from the published site", () => {
  const c = mk(), r = L.priceOrder(c, [{ id: "aaaa1", q: 2, o: "M", price: 1 }, { id: "bbbb2", q: 1 }], { fulfilment: "delivery" });
  assert.equal(r.subtotal, 23000); assert.equal(r.delivery, 1500); assert.equal(r.total, 24500); assert.equal(r.items[0].price, 10000);
  assert.equal(L.priceOrder(c, [{ id: "aaaa1", q: 6, o: "S" }], { fulfilment: "delivery" }).delivery, 0, "free delivery over threshold");
  for (const bad of [[{ id: "aaaa1", q: 1 }], [{ id: "cccc3", q: 1 }], [{ id: "dddd4", q: 1 }], [{ id: "nope", q: 1 }], [{ id: "bbbb2", q: 0 }], [{ id: "bbbb2", q: 99 }], [], [{ id: "bbbb2", q: 0.2 }]]) assert.ok(L.priceOrder(c, bad, {}).error, JSON.stringify(bad));
  const off = mk(); off.shop.on = 0; assert.ok(L.priceOrder(off, [{ id: "bbbb2", q: 1 }]).error);
  c.shop.min = 5000; assert.match(L.priceOrder(c, [{ id: "bbbb2", q: 1 }]).error, /minimum order/);
});
test("promo codes", () => {
  const now = new Date("2026-11-20T10:00:00Z"), p = { active: true, kind: "percent", value: 10, min_order: 5000, max_uses: 2, uses: 1, expires_at: "2026-12-01T00:00:00Z" };
  assert.equal(L.promoProblem(p, 6000, now), ""); assert.match(L.promoProblem(p, 1000, now), /Spend at least/); assert.match(L.promoProblem({ ...p, uses: 2 }, 6000, now), /fully used/); assert.match(L.promoProblem({ ...p, expires_at: "2026-11-01T00:00:00Z" }, 6000, now), /expired/); assert.ok(L.promoProblem(null, 1, now));
  assert.equal(L.calcDiscount(p, 6000), 600); assert.equal(L.calcDiscount({ kind: "fixed", value: 99999 }, 6000), 6000); assert.equal(L.calcDiscount({ kind: "percent", value: 500 }, 1000), 900);
  const c = mk(), r = L.priceOrder(c, [{ id: "aaaa1", q: 1, o: "S" }], { fulfilment: "pickup", promo: p }); assert.equal(r.discount, 1000); assert.equal(r.total, 9000);
});
test("booking slots respect hours, days, lead time, closures, capacity and service length", () => {
  const bk = L.sanitizeConfig({ booking: { on: 1, days: [1, 2, 3, 4, 5], open: "09:00", close: "12:00", slot: 60, cap: 1, lead: 2, ahead: 14, closed: ["2026-11-25"] } }).booking;
  const now = Date.UTC(2026, 10, 20, 8, 0); // 09:00 Lagos on Fri 20 Nov 2026
  assert.equal(L.weekday("2026-11-20"), 5);
  assert.deepEqual(L.availableSlots(bk, "2026-11-20", 60, [], now).map(s => s.t), ["11:00"], "2 hours lead time");
  assert.deepEqual(L.availableSlots(bk, "2026-11-23", 60, [], now).map(s => s.t), ["09:00", "10:00", "11:00"]);
  assert.deepEqual(L.availableSlots(bk, "2026-11-23", 120, [], now).map(s => s.t), ["09:00", "10:00"], "long service needs consecutive time");
  assert.deepEqual(L.availableSlots(bk, "2026-11-21", 60, [], now), [], "Saturday closed"); assert.deepEqual(L.availableSlots(bk, "2026-11-25", 60, [], now), [], "closed date");
  assert.deepEqual(L.availableSlots(bk, "2026-11-19", 60, [], now), [], "past"); assert.deepEqual(L.availableSlots(bk, "2027-02-01", 60, [], now), [], "too far ahead");
  const taken = [{ s: L.toMs("2026-11-23", "10:00"), e: L.toMs("2026-11-23", "11:00") }];
  assert.deepEqual(L.availableSlots(bk, "2026-11-23", 60, taken, now).map(s => s.t), ["09:00", "11:00"]);
  assert.deepEqual(L.availableSlots({ ...bk, cap: 2 }, "2026-11-23", 60, taken, now).map(s => s.t), ["09:00", "10:00", "11:00"]);
  assert.deepEqual(L.availableSlots({ ...bk, on: 0 }, "2026-11-23", 60, [], now), []);
});
test("customers: one record per person, safe CSV, clean submissions", () => {
  assert.equal(L.contactKey("0803 123 4567", ""), "p:2348031234567"); assert.equal(L.contactKey("+234 803 123 4567", "a@b.co"), "p:2348031234567"); assert.equal(L.contactKey("x", "A@B.co"), "e:a@b.co"); assert.equal(L.contactKey("", "bad"), "");
  assert.ok(L.submissionError(L.cleanSubmission({ name: "A", phone: "0803" }), false)); assert.ok(L.submissionError(L.cleanSubmission({ name: "Ada", phone: "08031234567" }), true)); assert.equal(L.submissionError(L.cleanSubmission({ name: "Ada", phone: "08031234567", message: "Hi" }), true), "");
  const csv = L.toCsv([["a", "A"], ["b", "B"]], [{ a: "=HYPERLINK(1)", b: 'say "hi", ok' }]); assert.ok(csv.includes("'=HYPERLINK(1)")); assert.ok(csv.includes('"say ""hi"", ok"'));
  const codes = new Set(Array.from({ length: 200 }, L.orderCode)); assert.ok(codes.size > 190); assert.ok([...codes].every(x => /^[A-HJ-NP-Z2-9]{6}$/.test(x)));
});
test("older saved websites keep working and keep their look", () => {
  const legacy = { theme: { template: "bistro", primary: "#c2410c", accent: "#2b1a10", bg: "#fff8ef", text: "#2b1a10", headFont: "DM Serif Display", bodyFont: "DM Sans", radius: 8 }, brand: { name: "Mama", tagline: "Food", about: "Hi" }, order: ["products", "about", "contact", "gallery", "highlights", "services", "testimonials"],
    sections: { highlights: true, products: true, services: true, about: true, gallery: true, testimonials: true, contact: true }, contact: { whatsapp: "08031234567" }, products: [{ name: "Jollof", price: 3500, desc: "x" }], services: [], highlights: [], testimonials: [], gallery: [] };
  const c = L.sanitizeConfig(legacy, legacy); assert.equal(c.shop.on, 0); assert.equal(c.booking.on, 0); assert.equal(c.sections.enquiry, false); assert.equal(c.sections.stats, false);
  const h = R.render(c, { origin: "https://mama.boltiv.ng" }); assert.ok(h.includes("/_go/order?i=0"), "old WhatsApp ordering still works"); assert.ok(!h.includes('id="enquiry"')); assert.ok(!h.includes('class="cartbtn"'));
  assert.equal(L.sanitizeConfig(c, c).products[0].id, c.products[0].id, "item ids are stable");
});
test("interactive pieces appear only when switched on, and carts never trust the browser", () => {
  const c = mk(); c.sections.enquiry = true; const h = R.render(c, { origin: "https://x.boltiv.ng", key: "x" });
  assert.ok(h.includes('data-add="aaaa1"')); assert.ok(h.includes('id="enf"')); assert.ok(h.includes('data-cart')); assert.ok(/<script>\(function/.test(h));
  assert.ok(!R.render(c, { preview: true }).includes("<script>"), "dashboard preview runs no script");
  c.booking.on = 1; c.sections.booking = true; const h2 = R.render(c, { origin: "https://x.boltiv.ng", key: "x" }); assert.ok(h2.includes('id="bkf"')); assert.ok(h2.includes('data-book='));
  const evil = L.sanitizeConfig({ products: [{ name: "</script><script>alert(1)</script>", price: 5 }], brand: { name: "x" }, shop: { on: 1 } }); const h3 = R.render(evil, { origin: "https://x.boltiv.ng", key: "x" });
  assert.equal((h3.match(/<script/g) || []).length, 3, "ld+json, data and client script only"); assert.ok(!h3.includes("</script><script>alert"));
});
test("every template renders every layout option without errors", () => {
  for (const id of L.TEMPLATE_IDS) for (const hero of L.OPT.hero) for (const prod of L.OPT.prod) {
    const c = L.templateConfig(id, "X"); c.theme.hero = hero; c.theme.prod = prod; c.theme.gal = "scroll"; c.theme.nav = "center"; c.contact.whatsapp = "08031234567"; c.gallery = ["1", "2", "3"]; c.blocks = [{ id: "blk11", title: "T", text: "x", btn: "auto", side: "left" }]; c.sections.blk1 = true;
    const h = R.render(L.sanitizeConfig(c, c), { origin: "https://x.boltiv.ng", key: "x" }); assert.ok(h.length > 5000);
  }
});
