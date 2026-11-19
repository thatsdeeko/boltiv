"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const L = require("./logic"), R = require("./render");
test("usernames", () => {
  for (const ok of ["deekostore", "a1b", "my-shop-9", "DEEKO"]) assert.equal(L.validateUsername(ok), "");
  for (const bad of ["ab", "-x1", "x1-", "a--b", "www", "admin", "has space", "dot.name", "x".repeat(31), "ünï"]) assert.notEqual(L.validateUsername(bad), "", bad);
});
test("renewal never loses paid days", () => {
  const now = new Date("2026-11-19T00:00:00Z");
  assert.equal(L.renewedExpiry("2026-12-19T00:00:00Z", now, 100).toISOString(), "2027-03-29T00:00:00.000Z");
  assert.equal(L.renewedExpiry("2026-01-01T00:00:00Z", now, 100).toISOString(), "2027-02-27T00:00:00.000Z");
  assert.equal(L.renewedExpiry(null, now, 100).toISOString(), "2027-02-27T00:00:00.000Z");
});
test("site state", () => {
  const now = new Date("2026-11-19T00:00:00Z");
  assert.equal(L.siteState({ status: "active", expires_at: "2026-11-20T00:00:00Z" }, now), "active");
  assert.equal(L.siteState({ status: "active", expires_at: "2026-11-18T00:00:00Z" }, now), "expired");
  assert.equal(L.siteState({ status: "suspended", expires_at: "2027-11-18T00:00:00Z" }, now), "suspended");
});
test("sanitiser blocks bad colours, urls, html, oversize lists", () => {
  const c = L.sanitizeConfig({ theme: { primary: "red;}</style><script>", font: "Comic Sans", layout: "evil" }, contact: { instagram: "javascript:alert(1)", phone: "abc", email: "no" },
    products: Array.from({ length: 200 }, (_, i) => ({ name: "P" + i, price: "₦1,500.50" })), brand: { name: "<img onerror=x>" } });
  assert.equal(c.theme.primary, L.DEFAULT_CONFIG.theme.primary); assert.equal(c.theme.font, "Inter"); assert.equal(c.theme.layout, "classic");
  assert.ok(!/[:()]/.test(c.contact.instagram)); assert.equal(c.contact.phone, ""); assert.equal(c.contact.email, "");
  assert.equal(c.products.length, 60); assert.equal(c.products[0].price, 1500.5);
  const html = R.render(c); assert.ok(!html.includes("<img onerror")); assert.ok(!/<script/i.test(html));
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
