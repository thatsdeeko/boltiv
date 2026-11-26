/*
BOLTIV — public site chrome (navigation, footer, icon sprite, audience tabs).
One shared implementation for every public marketing page. Edit product names,
links or footer columns HERE and every public page picks the change up.
Include before boltiv-footer.js (the old footer skips itself when this one exists).
*/
(function () {
  "use strict";
  var doc = document;

  var PRODUCTS = [
    { icon: "bm",    name: "Business Manager", text: "Sales, stock, invoices, staff and branches.",        href: "/business-manager" },
    { icon: "link",  name: "BOLTIV Link",      text: "Your business website with orders and bookings.",     href: "/boltiv-link" },
    { icon: "card",  name: "BOLTIV Card",      text: "A USD virtual card for online business spending.",    href: "/virtual-card" },
    { icon: "spark", name: "Smart Features",   text: "AutoPay, scheduled payments, insights and alerts.",   href: "/features" }
  ];


  var SPRITE =
    '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>' +
    sym("bm",     '<path d="M4 20V11M10 20V4M16 20v-6M2 20h20"/>') +
    sym("link",   '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3.2 3.2 3.2 14.8 0 18M12 3c-3.2 3.2-3.2 14.8 0 18"/>') +
    sym("wallet", '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><rect x="3" y="7.5" width="18" height="12.5" rx="2.5"/><path d="M16.5 14h1.5"/>') +
    sym("card",   '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>') +
    sym("spark",  '<path d="M12 3l1.9 5.3L19 10l-5.1 1.7L12 17l-1.9-5.3L5 10l5.1-1.7z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>') +
    sym("connect",'<circle cx="12" cy="5.5" r="2.3"/><circle cx="5" cy="18" r="2.3"/><circle cx="19" cy="18" r="2.3"/><path d="M10.9 7.6L6 16M13.1 7.6L18 16M7.3 18h9.4"/>') +
    sym("data",   '<path d="M8 20V4M8 4L4.5 7.5M8 4l3.5 3.5M16 4v16M16 20l-3.5-3.5M16 20l3.5-3.5"/>') +
    sym("phone",  '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>') +
    sym("bolt",   '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>') +
    sym("tv",     '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>') +
    sym("pin",    '<path d="M5 3.5h10l4 4V20.5H5z"/><path d="M9 12h6M9 16h6"/>') +
    sym("msg",    '<path d="M4 5h16v11H9.5L4 20.5z"/><path d="M8 9.5h8M8 12.5h5"/>') +
    sym("shield", '<path d="M12 3l8 3v6c0 4.4-3.1 7.7-8 9-4.9-1.3-8-4.6-8-9V6z"/><path d="M8.8 12l2.2 2.2L15.4 10"/>') +
    sym("key",    '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2.5 2.5"/>') +
    sym("clock",  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/>') +
    sym("users",  '<circle cx="9" cy="8.5" r="3.3"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 5.5a3.2 3.2 0 0 1 0 6M18 14.8c1.8.6 3 2.2 3.5 5"/>') +
    sym("list",   '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.8" cy="6" r="1"/><circle cx="3.8" cy="12" r="1"/><circle cx="3.8" cy="18" r="1"/>') +
    sym("globe2", '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>') +
    sym("home",   '<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-6h4v6"/>') +
    '</defs></svg>';

  function sym(id, body) {
    return '<symbol id="i-' + id + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + body + "</symbol>";
  }
  function icon(id) { return '<svg aria-hidden="true"><use href="#i-' + id + '"/></svg>'; }

  function injectSprite() {
    if (doc.getElementById("bx-sprite")) return;
    var d = doc.createElement("div");
    d.id = "bx-sprite";
    d.innerHTML = SPRITE;
    doc.body.insertBefore(d, doc.body.firstChild);
  }

  function navHTML() {
    var items = PRODUCTS.map(function (p) {
      return '<a href="' + p.href + '"><span class="ic">' + icon(p.icon) + '</span><span><b>' + p.name + "</b><span>" + p.text + "</span></span></a>";
    }).join("");
    return (
      '<div class="bx-nav-in">' +
      '<a class="bx-brand" href="/" aria-label="BOLTIV home"><img src="assets/boltiv-logo-dark-2.webp" alt="" width="30" height="37"><span>BOLTIV</span></a>' +
      '<nav class="bx-menu" id="bx-menu" aria-label="Main">' +
      '<div class="bx-dd"><button type="button" aria-expanded="false" aria-haspopup="true">Products<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4.5l4 4 4-4"/></svg></button><div class="bx-panel">' + items + '<a class="all" href="/products"><span><b>Explore the full ecosystem</b><span>See how every BOLTIV product works together.</span></span></a></div></div>' +
      '<a href="/#solutions">Solutions</a>' +
      '<a href="/#pricing">Pricing</a>' +
      '<a href="/contact">Help</a>' +
      '<div class="bx-m-cta"><a class="bx-btn secondary" href="/login" style="color:#fff;border-color:rgba(255,255,255,.4)">Sign in</a><a class="bx-btn primary" href="/register">Get started</a></div>' +
      "</nav>" +
      '<div class="bx-nav-cta"><a class="bx-signin" href="/login">Sign in</a><a class="bx-btn primary" href="/register">Get started</a></div>' +
      '<button class="bx-burger" type="button" aria-label="Open menu" aria-controls="bx-menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>' +
      "</div>"
    );
  }

  function mountNav() {
    var old = doc.querySelector("header.seo-nav") || doc.querySelector(".container>header.header");
    var mini = old && old.querySelector(".seo-mini-nav");
    var heroEl = doc.querySelector(".seo-hero");
    if (mini && heroEl) heroEl.appendChild(mini); // keep the in-page section links
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var nav = doc.querySelector("[data-bx-nav]");
    if (!nav) {
      nav = doc.createElement("header");
      nav.setAttribute("data-bx-nav", "");
      doc.body.insertBefore(nav, doc.getElementById("bx-sprite").nextSibling);
    }
    nav.className = "bx-nav";
    nav.innerHTML = navHTML();

    var burger = nav.querySelector(".bx-burger");
    var dd = nav.querySelector(".bx-dd");
    var ddBtn = dd.querySelector("button");

    function setDD(open) { dd.classList.toggle("open", open); ddBtn.setAttribute("aria-expanded", open ? "true" : "false"); }
    function setMenu(open) {
      nav.classList.toggle("open", open);
      burger.setAttribute("aria-expanded", open ? "true" : "false");
      burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      doc.body.style.overflow = open ? "hidden" : "";
      setDD(open);
    }
    ddBtn.addEventListener("click", function () { setDD(!dd.classList.contains("open")); });
    burger.addEventListener("click", function () { setMenu(!nav.classList.contains("open")); });
    doc.addEventListener("click", function (e) { if (!dd.contains(e.target) && !burger.contains(e.target) && !nav.classList.contains("open")) setDD(false); });
    doc.addEventListener("keydown", function (e) { if (e.key === "Escape") { setDD(false); setMenu(false); } });
    nav.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest("a");
      if (a && nav.classList.contains("open")) setMenu(false);
    });
    var path = (location.pathname || "/").replace(/\/+$/, "") || "/";
    Array.prototype.forEach.call(nav.querySelectorAll(".bx-menu>a"), function (a) {
      if (a.getAttribute("href") === path) a.setAttribute("aria-current", "page");
    });
  }

  function footerHTML() {
    function col(title, links) {
      return "<div><h4>" + title + "</h4><ul>" + links.map(function (l) { return '<li><a href="' + l[1] + '">' + l[0] + "</a></li>"; }).join("") + "</ul></div>";
    }
    return (
      '<div class="bx-footer-in"><div class="bx-foot-grid">' +
      '<div class="bx-foot-brand"><a class="bx-brand" href="/" aria-label="BOLTIV home"><img src="assets/boltiv-logo-dark-2.webp" alt="" width="30" height="37"><span>BOLTIV</span></a>' +
      '<div class="tag">Moving Business Beyond Limits.</div>' +
      "<p>One business technology ecosystem to start, operate, manage and grow, for individuals, entrepreneurs, SMEs and established businesses.</p></div>" +
      col("Products", PRODUCTS.map(function (p) { return [p.name, p.href]; }).concat([["Ecosystem overview", "/products"]])) +
      col("Explore", [["Solutions", "/#solutions"], ["Pricing", "/#pricing"], ["Become an agent", "/agents"], ["Contact", "/contact"]]) +
      col("Account", [["Sign in", "/login"], ["Create an account", "/register"], ["Privacy policy", "/privacy"], ["Terms &amp; conditions", "/terms"]]) +
      '</div><div class="bx-foot-base"><span>&copy; 2026 BOLTIV. All rights reserved.</span><span>Powered by <strong>BOLTIV TECHNOLOGIES LIMITED</strong></span></div></div>'
    );
  }

  function mountFooter() {
    if (doc.getElementById("boltiv-global-footer")) return;
    var f = doc.createElement("footer");
    f.id = "boltiv-global-footer"; // the legacy footer script checks this id and skips itself
    f.className = "bx-footer";
    f.innerHTML = footerHTML();
    var cta = doc.querySelector(".seo-mobile-cta");
    if (cta && cta.parentNode === doc.body) doc.body.insertBefore(f, cta);
    else doc.body.appendChild(f);
  }

  function mountTabs() {
    Array.prototype.forEach.call(doc.querySelectorAll("[data-bx-tabs]"), function (root) {
      var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
      var panels = Array.prototype.slice.call(root.querySelectorAll('[role="tabpanel"]'));
      function select(i, focus) {
        tabs.forEach(function (t, n) {
          var on = n === i;
          t.setAttribute("aria-selected", on ? "true" : "false");
          t.tabIndex = on ? 0 : -1;
          if (on && focus) t.focus();
        });
        panels.forEach(function (p, n) { p.classList.toggle("on", n === i); p.hidden = n !== i; });
      }
      tabs.forEach(function (t, i) {
        t.addEventListener("click", function () { select(i, false); });
        t.addEventListener("keydown", function (e) {
          if (e.key === "ArrowRight") { e.preventDefault(); select((i + 1) % tabs.length, true); }
          if (e.key === "ArrowLeft") { e.preventDefault(); select((i - 1 + tabs.length) % tabs.length, true); }
        });
      });
      select(0, false);
    });
  }

  function init() {
    var m = doc.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", "#0A1736");
    doc.body.classList.add("bx");
    injectSprite();
    mountNav();
    mountFooter();
    mountTabs();
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else init();
})();
