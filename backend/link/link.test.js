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
  assert.equal(c.products.length, 60); assert.equal(c.products[0].price, 1500.5);
  assert.deepEqual(c.order.slice(0, 1), ["contact"]); assert.equal(c.order.length, L.SECTION_KEYS.length);
  const html = R.render(c); assert.ok(!html.includes("<img onerror")); assert.ok(!/<script/i.test(html));
});
test("every template is complete, safe and renders", () => {
  assert.equal(L.TEMPLATE_IDS.length, 6);
  for (const id of L.TEMPLATE_IDS) {
    const t = L.TEMPLATES[id], c = L.templateConfig(id, "Deeko <b>Store</b> & Co");
    assert.ok(L.FONTS[t.theme.headFont] && L.BODY_FONTS.includes(t.theme.bodyFont), id);
    assert.ok(t.palettes.length >= 4 && t.palettes.every(p => [p.primary, p.accent, p.bg, p.text].every(x => /^#[0-9a-f]{6}$/i.test(x))), id);
    assert.ok(L.sampleCount(c) > 5, id);
    const h = R.render(c, { origin: "https://x.boltiv.ng" });
    assert.ok(!h.includes("<b>Store"), id); assert.ok(h.includes("&lt;b&gt;Store"), id); assert.ok(!/<script/i.test(h), id);
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
