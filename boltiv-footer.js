/*
BOLTIV — global footer component.
One shared implementation, included on every page via:
  <script src="boltiv-footer.js?v=2"></script>
Do not duplicate this markup on individual pages — add/adjust it here only,
and every page picks up the change automatically.
*/
(function () {
  "use strict";

  var FOOTER_ID = "boltiv-global-footer";
  var STYLE_ID = "boltiv-global-footer-style";

  if (document.getElementById(FOOTER_ID)) return; // idempotent: never inject twice

  var CSS =
    ".boltiv-global-footer{background:#fffdf6;color:#6b6a63;margin-top:44px;padding:28px 20px 24px;border-top:1px solid #ead58a;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box}" +
    ".boltiv-global-footer *{box-sizing:border-box}" +
    ".boltiv-global-footer-inner{max-width:960px;margin:0 auto;display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px}" +
    ".boltiv-global-footer-brand{display:flex;align-items:center;gap:8px}" +
    ".boltiv-global-footer-brand img{width:20px;height:22px;object-fit:contain;display:block}" +
    ".boltiv-global-footer-brand span{font-size:13px;font-weight:1000;letter-spacing:.16em;color:#b8860b}" +
    ".boltiv-global-footer-links{display:flex;flex-wrap:wrap;justify-content:center;gap:16px;margin:2px 0}" +
    ".boltiv-global-footer-links a{color:#8a8a83;font-size:10.5px;font-weight:700;text-decoration:none}" +
    ".boltiv-global-footer-links a:hover{color:#b8860b}" +
    ".boltiv-global-footer-divider{width:34px;height:1px;background:#ead58a;margin:2px 0}" +
    ".boltiv-global-footer-legal p{margin:3px 0;font-size:11px;line-height:1.65;color:#7a7970}" +
    ".boltiv-global-footer-legal strong{color:#8a6d0a;font-weight:800}" +
    "@media(min-width:640px){.boltiv-global-footer{padding:32px 24px 28px}.boltiv-global-footer-legal p{font-size:11.5px}}";

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function buildFooter() {
    var footer = document.createElement("footer");
    footer.id = FOOTER_ID;
    footer.className = "boltiv-global-footer";
    footer.innerHTML =
      '<div class="boltiv-global-footer-inner">' +
        '<div class="boltiv-global-footer-brand">' +
          '<img src="assets/boltiv-logo.webp" alt="" onerror="this.style.display=\'none\'"/>' +
          "<span>BOLTIV</span>" +
        "</div>" +
        '<nav class="boltiv-global-footer-links" aria-label="Footer">' +
          '<a href="/">Home</a>' +
          '<a href="/contact">Contact</a>' +
          '<a href="/privacy">Privacy Policy</a>' +
          '<a href="/terms">Terms &amp; Conditions</a>' +
        "</nav>" +
        '<div class="boltiv-global-footer-divider"></div>' +
        '<div class="boltiv-global-footer-legal">' +
          "<p>&copy; 2026 BOLTIV. All rights reserved.</p>" +
          "<p>Powered by <strong>BOLTIV TECHNOLOGIES LIMITED</strong>.</p>" +
        "</div>" +
      "</div>";
    return footer;
  }

  function reserveSpaceAroundFixedChrome(footer) {
    // Some pages have persistent fixed-position UI the footer must never render underneath:
    // an in-app bottom tab bar (.bottom-nav) on customer screens, or a left sidebar (.sidebar)
    // on the admin dashboard. The footer itself is always appended in normal document flow
    // (never fixed), so it can't cover that UI — but without matching space, the fixed
    // element would sit on top of the footer's edge. Measure live, rather than hardcoding
    // breakpoints, so this keeps working whatever width/visibility rules the page's own CSS
    // defines (e.g. a sidebar that collapses on mobile).
    var bottomNav = document.querySelector(".bottom-nav");
    var sidebar = document.querySelector(".sidebar");

    function apply() {
      if (bottomNav) {
        var navRect = bottomNav.getBoundingClientRect();
        footer.style.marginBottom = navRect.height > 0 ? navRect.height + 16 + "px" : "";
      }
      if (sidebar) {
        var sideRect = sidebar.getBoundingClientRect();
        // Only reserve space if the sidebar is actually visible on-screen right now (its
        // right edge is past the left edge of the viewport) — a collapsed/off-canvas
        // sidebar (e.g. translated off-screen on mobile) should not push the footer over.
        footer.style.marginLeft = sideRect.right > 0 && sideRect.left < sideRect.right ? sideRect.right + "px" : "";
      }
    }
    apply();
    window.addEventListener("resize", apply);
  }

  function ensureBodyIsBlockFlow() {
    // A couple of screens set display:flex (or grid) directly on <body> itself to center a
    // single card (e.g. the email-verification screen). Appending the footer straight into
    // such a body would make it a second flex/grid item — sitting beside the existing content
    // instead of below it. Rather than leaving a gap or fighting the layout algorithm, move
    // body's existing children into a new wrapper that inherits the same layout properties,
    // then reset body to plain block flow. The page looks exactly the same (the centering just
    // now happens one level down), and body becomes a safe, predictable place to append the
    // footer afterwards.
    var bodyStyle = window.getComputedStyle(document.body);
    if (bodyStyle.display !== "flex" && bodyStyle.display !== "grid") return;
    var wrapper = document.createElement("div");
    ["display", "flexDirection", "alignItems", "justifyContent", "flexWrap", "gap", "minHeight", "gridTemplateColumns"].forEach(function (p) {
      wrapper.style[p] = bodyStyle[p];
    });
    while (document.body.firstChild) wrapper.appendChild(document.body.firstChild);
    document.body.appendChild(wrapper);
    document.body.style.display = "block";
  }

  function inject() {
    if (document.getElementById(FOOTER_ID)) return;
    injectStyle();
    ensureBodyIsBlockFlow();
    // Deliberately always appended as the very last child of <body> — no attempt to detect
    // and inject "inside" some other container. An earlier version tried to be clever about
    // that (to avoid a blank gap on tall, mostly-empty screens) but that heuristic ended up
    // misfiring on a purely decorative background element on one screen, making the footer
    // invisible there. Simple and predictable beats clever and occasionally wrong: the footer
    // is always the last thing in the document, full stop.
    var footer = buildFooter();
    document.body.appendChild(footer);
    reserveSpaceAroundFixedChrome(footer);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();
