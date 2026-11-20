(function () {
  "use strict";
  /* BOLTIV Link: the only script on a published website. It makes the page interactive (cart, quick view, booking, enquiry, filters, gallery)
     but never builds trusted content: every price, total, slot and promo is decided by the server. The page works without it. */
  var el = document.getElementById("d"); if (!el) return;
  var D; try { D = JSON.parse(el.textContent); } catch (e) { return; }
  var doc = document, root = doc.documentElement; root.classList.add("js");
  function $(s, r) { return (r || doc).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function money(n) { return "\u20A6" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 2 }); }
  var P = {}, S = {}; D.p.forEach(function (x) { P[x.id] = x; }); D.s.forEach(function (x) { S[x.id] = x; });
  function toast(m) { var t = doc.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = m; doc.body.appendChild(t); setTimeout(function () { t.remove(); }, 3400); }
  function api(path, body) {
    var o = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
    return fetch("/_api/" + path, o).then(function (r) {
      return r.json().catch(function () { return { success: false, message: "Unexpected response." }; }).then(function (d) {
        if (!r.ok || d.success === false) { var e = new Error(d.message || "Something went wrong. Please try again."); e.data = d; throw e; } return d; });
    }, function () { throw new Error("No connection. Check your internet and try again."); });
  }
  function wa(msg) { return D.wa ? "https://wa.me/" + D.wa + "?text=" + encodeURIComponent(msg) : ""; }
  function lock(on) { root.classList.toggle("lock", !!on); }
  function overlay(cls) { var o = doc.createElement("div"); o.className = "ov " + (cls || ""); o.hidden = true; o.addEventListener("click", function (e) { if (e.target === o) shut(o); }); doc.body.appendChild(o); return o; }
  function shut(o) { if (o) o.hidden = true; if (!$$(".ov").some(function (x) { return !x.hidden; })) lock(false); }
  function open(o) { o.hidden = false; lock(true); }
  function head(t) { return '<div class="dh"><b>' + esc(t) + '</b><button type="button" class="x" data-x aria-label="Close">\u00D7</button></div>'; }

  /* ---------- cart ---------- */
  var KEY = "bl:" + D.k, cart = [];
  try { cart = JSON.parse(localStorage.getItem(KEY) || "[]").filter(function (l) { return P[l.id] && l.q > 0; }).slice(0, 30); } catch (e) { cart = []; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch (e) {} count(); }
  function count() { var n = cart.reduce(function (a, l) { return a + l.q; }, 0); $$("[data-count]").forEach(function (e) { e.textContent = n; e.hidden = !n; }); }
  function add(id, opt, q) {
    var p = P[id]; if (!p) return;
    if (p.opt && !opt) { qv(id); return; }
    var l = cart.filter(function (x) { return x.id === id && x.o === (opt || ""); })[0];
    if (l) l.q = Math.min(50, l.q + (q || 1)); else cart.push({ id: id, o: opt || "", q: q || 1 });
    save(); toast(p.n + " added to your cart"); api("hit", { k: "add", id: id }).catch(function () {});
  }
  var cartEl, Q = { code: "", ful: D.sh.pickup ? "pickup" : "delivery", q: null, msg: "" };
  function openCart() {
    if (!cartEl) {
      cartEl = overlay("side");
      cartEl.innerHTML = '<div class="dr" role="dialog" aria-modal="true" aria-label="Your cart">' + head("Your cart") + '<div id="cl" class="dbody"></div>' +
        '<form id="cof" class="dbody" novalidate><h3>Your details</h3><label>Name<input name="name" autocomplete="name" maxlength="80" required></label><label>Phone number<input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" required></label>' +
        '<label>Email (optional)<input name="email" type="email" autocomplete="email" maxlength="120"></label><label id="adr" hidden>Delivery address<textarea name="address" maxlength="300" rows="2"></textarea></label><label>Note (optional)<textarea name="note" maxlength="300" rows="2" placeholder="Anything we should know?"></textarea></label>' +
        '<label class="ck"><input type="checkbox" name="optin"> <span>Send me offers on WhatsApp</span></label><input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
        '<div id="cerr" class="err" role="alert"></div><button class="btn" type="submit" id="place">Place order</button><p class="hint">We save your order and contact you to confirm. Payment is arranged directly with the seller.</p></form></div>';
    }
    open(cartEl); drawLines(); refresh();
  }
  function drawLines() {
    var box = $("#cl", cartEl), form = $("#cof", cartEl);
    if (!cart.length) { box.innerHTML = '<p class="empty">Your cart is empty.</p><button class="btn" type="button" data-x>Keep browsing</button>'; form.hidden = true; return; }
    form.hidden = false; $("#adr", cartEl).hidden = Q.ful !== "delivery";
    var lines = cart.map(function (l, i) { var p = P[l.id]; return '<div class="cl"><div class="cm"><b>' + esc(p.n) + '</b>' + (l.o ? '<small>' + esc((p.opt && p.opt.l ? p.opt.l + ": " : "") + l.o) + '</small>' : "") + '<small>' + money(p.p) + ' each</small></div><div class="qt"><button type="button" data-q="' + i + ':-1" aria-label="Fewer">\u2212</button><span>' + l.q + '</span><button type="button" data-q="' + i + ':1" aria-label="More">+</button></div></div>'; }).join("");
    var ful = D.sh.pickup && D.sh.delivery ? '<div class="seg" role="radiogroup" aria-label="How would you like to receive it?"><label><input type="radio" name="ful" value="pickup"' + (Q.ful === "pickup" ? " checked" : "") + '><span>Pickup</span></label><label><input type="radio" name="ful" value="delivery"' + (Q.ful === "delivery" ? " checked" : "") + '><span>Delivery</span></label></div>' : "";
    box.innerHTML = lines + ful + '<div class="pc"><input id="pcode" placeholder="Promo code" maxlength="30" autocapitalize="characters" value="' + esc(Q.code) + '"><button type="button" class="btn sm ghost" data-promo>Apply</button></div><div id="sum" class="sum"></div>' + (D.sh.note ? '<p class="hint">' + esc(D.sh.note) + '</p>' : "");
    drawSum();
  }
  function drawSum() {
    var s = $("#sum", cartEl); if (!s) return; var q = Q.q, h = "";
    if (q) {
      h += '<div><span>Subtotal</span><span>' + money(q.subtotal) + '</span></div>';
      if (q.discount > 0) h += '<div class="g"><span>Discount' + (q.code ? " (" + esc(q.code) + ")" : "") + '</span><span>\u2212' + money(q.discount) + '</span></div>';
      if (Q.ful === "delivery") h += '<div><span>Delivery</span><span>' + (q.delivery > 0 ? money(q.delivery) : "Free") + '</span></div>';
      h += '<div class="t"><span>Total</span><span>' + money(q.total) + '</span></div>';
    }
    s.innerHTML = h + (Q.msg ? '<p class="err">' + esc(Q.msg) + '</p>' : "");
  }
  function refresh() {
    if (!cart.length) return;
    api("quote", { lines: cart, code: Q.code, ful: Q.ful }).then(function (r) { Q.q = r; Q.msg = r.promoError || ""; if (r.promoError) Q.code = ""; drawSum(); }).catch(function (e) { Q.q = null; Q.msg = e.message; drawSum(); });
  }
  function placeOrder(form) {
    var err = $("#cerr", cartEl), btn = $("#place", cartEl); err.textContent = "";
    function v(n) { return form.elements[n] ? form.elements[n].value : ""; }
    btn.disabled = true; btn.textContent = "Placing order\u2026";
    api("order", { lines: cart, code: Q.code, ful: Q.ful, name: v("name"), phone: v("phone"), email: v("email"), address: v("address"), note: v("note"), optin: form.elements.optin.checked, website: v("website") }).then(function (r) {
      cart = []; save(); Q.code = ""; Q.q = null;
      var link = wa("Hello " + D.n + ", I just placed order " + r.code + " (" + money(r.total) + "). Please confirm.");
      $(".dr", cartEl).innerHTML = head("Order received") + '<div class="dbody ok"><div class="tick">\u2713</div><h3>Thank you!</h3><p>Your order code is <b>' + esc(r.code) + '</b> (' + money(r.total) + '). ' + esc(D.n) + ' will contact you shortly to confirm.</p>' +
        (link ? '<a class="btn" rel="noopener" href="' + esc(link) + '">Send on WhatsApp</a>' : "") + '<button type="button" class="btn ghost" data-x>Close</button></div>';
    }).catch(function (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = "Place order"; });
  }

  /* ---------- photos: product gallery, lightbox, swipe ---------- */
  function imgSrc(id, v) { return "/_i/" + id + (v ? "/" + v : ""); }
  function swipe(node, fn) {
    var x0 = null, y0 = 0, moved = false;
    node.addEventListener("touchstart", function (e) { if (e.touches.length !== 1) { x0 = null; return; } x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; moved = false; }, { passive: true });
    node.addEventListener("touchmove", function (e) { if (x0 !== null && Math.abs(e.touches[0].clientX - x0) > 12) moved = true; }, { passive: true });
    node.addEventListener("touchend", function (e) {
      if (x0 === null) return; var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.4) { fn(dx < 0 ? 1 : -1); node._sw = Date.now(); }
    }, { passive: true });
  }
  var qvEl, G = { list: [], dm: {}, i: 0 };
  function pre(id) { if (id) { var im = new Image(); im.src = imgSrc(id, "m"); } }
  function show(i) {
    var n = G.list.length; if (!n) return; G.i = (i + n) % n; var id = G.list[G.i], d = G.dm[id], m = $("#qm", qvEl); if (!m) return;
    m.removeAttribute("srcset"); m.src = imgSrc(id, "m"); m.srcset = imgSrc(id, "m") + " 960w, " + imgSrc(id) + " 1600w"; m.sizes = "(min-width:760px) 440px, 100vw";
    if (d) { m.width = d[0]; m.height = d[1]; }
    var c = $("#qc", qvEl); if (c) c.textContent = (G.i + 1) + " / " + n;
    $$("[data-qi]", qvEl).forEach(function (b) { var on = Number(b.getAttribute("data-qi")) === G.i; b.classList.toggle("on", on); if (on && b.scrollIntoView) { var t = b.parentNode; t.scrollTo ? t.scrollTo({ left: b.offsetLeft - t.clientWidth / 2 + b.clientWidth / 2, behavior: "smooth" }) : 0; } });
    pre(G.list[(G.i + 1) % n]); pre(G.list[(G.i + n - 1) % n]);
  }
  function qv(id) {
    var p = P[id], svc = false; if (!p) { p = S[id]; svc = true; } if (!p) return;
    if (!qvEl) qvEl = overlay("mid");
    G.list = [p.i].concat(p.im || []).filter(Boolean).slice(0, 8); G.dm = p.dm || {}; G.i = 0;
    var imgs = G.list, d0 = G.dm[imgs[0]], ar = d0 ? Math.max(0.75, Math.min(1.5, d0[0] / d0[1])) : 1;
    var pr = p.p ? '<b>' + money(p.p) + '</b>' + (p.o ? ' <s>' + money(p.o) + '</s>' : "") : "";
    var opt = !svc && p.opt ? '<label>' + esc(p.opt.l || "Choose an option") + '<select id="qo">' + p.opt.v.map(function (o) { return '<option>' + esc(o) + '</option>'; }).join("") + '</select></label>' : "";
    var can = !svc && D.sh.on && p.a && p.p > 0, act = "";
    if (svc) act = D.bk ? '<button class="btn" type="button" data-book="' + esc(p.id) + '">Book now</button>' : (D.wa ? '<a class="btn" rel="noopener" href="' + esc(wa("Hello " + D.n + ", I would like to book " + p.n + ".")) + '">Book on WhatsApp</a>' : "");
    else if (can) act = '<div class="row"><div class="qt"><button type="button" data-qq="-1" aria-label="Fewer">\u2212</button><span id="qn">1</span><button type="button" data-qq="1" aria-label="More">+</button></div><button class="btn f" type="button" data-qadd="' + esc(p.id) + '">Add to cart</button></div>';
    else if (!svc && !p.a) act = '<p class="hint">This item is sold out.</p>';
    else if (D.wa) act = '<a class="btn" rel="noopener" href="' + esc(wa("Hello " + D.n + ", I would like to " + (svc ? "book " : "order ") + p.n + (p.p ? " (" + money(p.p) + ")" : "") + ".")) + '">' + (p.p ? "Order on WhatsApp" : "Ask for the price") + '</a>';
    var gal = imgs.length ? '<div class="mg"><div class="stage" id="qs" style="aspect-ratio:' + ar.toFixed(3) + '"><img id="qm" alt="' + esc(p.n) + '" decoding="async">' +
      (imgs.length > 1 ? '<button type="button" class="nv p" data-pn="-1" aria-label="Previous photo">\u2039</button><button type="button" class="nv n" data-pn="1" aria-label="Next photo">\u203A</button><span class="cnt" id="qc"></span>' : "") + '<button type="button" class="zm" data-zoom aria-label="View full size">\u2922</button></div>' +
      (imgs.length > 1 ? '<div class="th" role="tablist">' + imgs.map(function (x, n) { return '<button type="button" role="tab" data-qi="' + n + '" class="' + (n ? "" : "on") + '" aria-label="Photo ' + (n + 1) + '"><img src="' + imgSrc(x, "s") + '" alt="" loading="lazy" decoding="async"></button>'; }).join("") + '</div>' : "") + '</div>' : "";
    qvEl.innerHTML = '<div class="md' + (imgs.length ? "" : " nog") + '" role="dialog" aria-modal="true" aria-label="' + esc(p.n) + '"><button type="button" class="x" data-x aria-label="Close">\u00D7</button>' + gal +
      '<div class="mt"><h3>' + esc(p.n) + '</h3><div class="pr">' + pr + (svc && p.d ? ' <span class="chip">' + p.d + ' min</span>' : "") + '</div>' + (p.desc ? '<p>' + esc(p.desc) + '</p>' : "") + opt + act + '</div></div>';
    qvEl._qty = 1; open(qvEl); if (imgs.length) { show(0); var st = $("#qs", qvEl); swipe(st, function (dir) { show(G.i + dir); }); }
  }
  var lbEl, lbList = [], lbI = 0;
  function lbShow(i) { lbI = (i + lbList.length) % lbList.length; var im = $("img", lbEl), id = lbList[lbI]; im.src = imgSrc(id, "m"); im.srcset = imgSrc(id, "m") + " 960w, " + imgSrc(id) + " 1600w"; im.sizes = "100vw"; var c = $(".cnt", lbEl); if (c) c.textContent = (lbI + 1) + " / " + lbList.length; if (lbList.length > 1) { pre(lbList[(lbI + 1) % lbList.length]); } }
  function lb(list, i) {
    lbList = list; if (!lbEl) { lbEl = overlay("lb"); swipe(lbEl, function (dir) { lbShow(lbI + dir); }); }
    lbEl.innerHTML = '<button type="button" class="x" data-x aria-label="Close">\u00D7</button>' + (list.length > 1 ? '<button type="button" class="nv p" data-lbn="-1" aria-label="Previous">\u2039</button><button type="button" class="nv n" data-lbn="1" aria-label="Next">\u203A</button><span class="cnt">1</span>' : "") + '<img alt="" decoding="async">'; open(lbEl); lbShow(i);
  }

  /* ---------- booking & enquiry ---------- */
  function fieldsOf(form) { var o = {}; Array.prototype.forEach.call(form.elements, function (f) { if (f.name) o[f.name] = f.type === "checkbox" ? f.checked : f.value; }); return o; }
  function done(box, title, msg, link) { box.innerHTML = '<div class="ok"><div class="tick">\u2713</div><h3>' + esc(title) + '</h3><p>' + esc(msg) + '</p>' + (link ? '<a class="btn" rel="noopener" href="' + esc(link) + '">Message us on WhatsApp</a>' : "") + '</div>'; box.scrollIntoView({ behavior: "smooth", block: "center" }); }
  var bf = $("#bkf");
  if (bf) {
    var sel = bf.elements.svc, dt = bf.elements.date, slots = $("#slots"), picked = "", bmsg = $("#bmsg");
    var loadSlots = function () {
      picked = ""; if (!dt.value) { slots.innerHTML = '<p class="hint">Choose a date to see available times.</p>'; return; }
      slots.innerHTML = '<p class="hint">Checking times\u2026</p>';
      api("slots?date=" + encodeURIComponent(dt.value) + "&s=" + encodeURIComponent(sel.value)).then(function (r) {
        slots.innerHTML = r.slots.length ? r.slots.map(function (s) { return '<button type="button" class="sl" data-slot="' + esc(s.t) + '">' + esc(s.label || s.t) + '</button>'; }).join("") : '<p class="hint">' + esc(r.reason || "No times are free on this day. Please try another date.") + '</p>';
      }).catch(function (e) { slots.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; });
    };
    sel.addEventListener("change", loadSlots); dt.addEventListener("change", loadSlots);
    slots.addEventListener("click", function (e) { var b = e.target.closest("[data-slot]"); if (!b) return; picked = b.getAttribute("data-slot"); $$("[data-slot]", slots).forEach(function (x) { x.classList.toggle("on", x === b); }); });
    bf.addEventListener("submit", function (e) {
      e.preventDefault(); bmsg.textContent = ""; var f = fieldsOf(bf);
      if (!f.date) { bmsg.textContent = "Please choose a date."; return; } if (!picked) { bmsg.textContent = "Please choose a time."; return; }
      var btn = $("button[type=submit]", bf); btn.disabled = true; btn.textContent = "Booking\u2026";
      api("book", { svc: f.svc, date: f.date, time: picked, name: f.name, phone: f.phone, email: f.email, note: f.note, optin: f.optin, website: f.website }).then(function (r) {
        done($("#bkw"), r.status === "confirmed" ? "You are booked" : "Request received", r.message, wa("Hello " + D.n + ", I just booked " + r.service + " for " + r.when + " (ref " + r.code + ")."));
      }).catch(function (er) { bmsg.textContent = er.message; btn.disabled = false; btn.textContent = "Book appointment"; if (dt.value) loadSlots(); });
    });
  }
  var ef = $("#enf");
  if (ef) ef.addEventListener("submit", function (e) {
    e.preventDefault(); var m = $("#emsg"); m.textContent = ""; var f = fieldsOf(ef), btn = $("button[type=submit]", ef); btn.disabled = true; btn.textContent = "Sending\u2026";
    api("enquiry", { name: f.name, phone: f.phone, email: f.email, item: f.item, message: f.message, optin: f.optin, website: f.website }).then(function (r) {
      done($("#enw"), "Message sent", r.message, wa("Hello " + D.n + ", I just sent an enquiry on your website.")); }).catch(function (er) { m.textContent = er.message; btn.disabled = false; btn.textContent = "Send message"; });
  });

  /* ---------- events ---------- */
  doc.addEventListener("click", function (e) {
    var t = e.target, x;
    if ((x = t.closest("[data-x]"))) { shut(x.closest(".ov")); return; }
    if ((x = t.closest("[data-add]"))) { e.preventDefault(); add(x.getAttribute("data-add"), "", 1); return; }
    if ((x = t.closest("[data-cart]"))) { e.preventDefault(); openCart(); return; }
    if ((x = t.closest("[data-book]"))) {
      var bw = $("#bkw"); if (!bw) return; e.preventDefault(); if (qvEl) shut(qvEl); var id = x.getAttribute("data-book"); if (bf && S[id]) { bf.elements.svc.value = id; if (bf.elements.date.value) bf.elements.date.dispatchEvent(new Event("change")); }
      bw.scrollIntoView({ behavior: "smooth", block: "start" }); return;
    }
    if ((x = t.closest("[data-q]"))) { var p = x.getAttribute("data-q").split(":"), l = cart[Number(p[0])]; if (l) { l.q += Number(p[1]); if (l.q < 1) cart.splice(Number(p[0]), 1); if (l && l.q > 50) l.q = 50; save(); drawLines(); refresh(); } return; }
    if (t.closest("[data-promo]")) { Q.code = ($("#pcode", cartEl).value || "").trim().toUpperCase(); refresh(); return; }
    if ((x = t.closest("[data-qi]"))) { show(Number(x.getAttribute("data-qi"))); return; }
    if ((x = t.closest("[data-pn]"))) { show(G.i + Number(x.getAttribute("data-pn"))); return; }
    if (t.closest("[data-zoom]") || (t.closest("#qm") && !(qvEl.querySelector("#qs")._sw > Date.now() - 400))) { lb(G.list.slice(), G.i); return; }
    if ((x = t.closest("[data-qq]"))) { qvEl._qty = Math.max(1, Math.min(50, qvEl._qty + Number(x.getAttribute("data-qq")))); $("#qn", qvEl).textContent = qvEl._qty; return; }
    if ((x = t.closest("[data-qadd]"))) { var o = $("#qo", qvEl); add(x.getAttribute("data-qadd"), o ? o.value : "", qvEl._qty); shut(qvEl); return; }
    if ((x = t.closest("[data-lb]"))) { var list = $$("[data-lb]").map(function (n) { return n.getAttribute("data-lb"); }); lb(list, list.indexOf(x.getAttribute("data-lb"))); return; }
    if ((x = t.closest("[data-lbn]"))) { lbShow(lbI + Number(x.getAttribute("data-lbn"))); return; }
    if ((x = t.closest("[data-cat]"))) { var c = x.getAttribute("data-cat"); $$("[data-cat]").forEach(function (b) { b.classList.toggle("on", b === x); }); $$("[data-ic]").forEach(function (n) { n.hidden = !!c && n.getAttribute("data-ic") !== c; }); return; }
    if ((x = t.closest("[data-qv]")) && !t.closest("a,button,input,select,textarea,label")) qv(x.getAttribute("data-qv"));
  });
  doc.addEventListener("change", function (e) { if (e.target.name === "ful" && cartEl && cartEl.contains(e.target)) { Q.ful = e.target.value; $("#adr", cartEl).hidden = Q.ful !== "delivery"; refresh(); } });
  doc.addEventListener("submit", function (e) { if (e.target.id === "cof") { e.preventDefault(); placeOrder(e.target); } });
  doc.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { $$(".ov").forEach(function (o) { shut(o); }); return; }
    var k = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (!k) return;
    if (lbEl && !lbEl.hidden) lbShow(lbI + k); else if (qvEl && !qvEl.hidden && G.list.length > 1) show(G.i + k);
  });
  count();
})();
