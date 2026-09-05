/*
BOLTIV — global footer component.
One shared implementation, included on every page via:
  <script src="boltiv-footer.js?v=1"></script>
Do not duplicate this markup on individual pages — add/adjust it here only,
and every page picks up the change automatically.
*/
(function () {
  "use strict";

  var FOOTER_ID = "boltiv-global-footer";
  var STYLE_ID = "boltiv-global-footer-style";

  if (document.getElementById(FOOTER_ID)) return; // idempotent: never inject twice

  var CSS =
    ".boltiv-global-footer{background:#0c0c0c;color:#bdbdbb;margin-top:44px;padding:30px 20px 26px;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box;position:relative;z-index:1}" +
    ".boltiv-global-footer *{box-sizing:border-box}" +
    ".boltiv-global-footer-inner{max-width:960px;margin:0 auto;display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px}" +
    ".boltiv-global-footer-brand{display:flex;align-items:center;gap:8px}" +
    ".boltiv-global-footer-brand img{width:20px;height:22px;object-fit:contain;display:block}" +
    ".boltiv-global-footer-brand span{font-size:13px;font-weight:1000;letter-spacing:.16em;color:#D4AF37}" +
    ".boltiv-global-footer-links{display:flex;flex-wrap:wrap;justify-content:center;gap:16px;margin:2px 0}" +
    ".boltiv-global-footer-links a{color:#9a9a97;font-size:10.5px;font-weight:700;text-decoration:none}" +
    ".boltiv-global-footer-links a:hover{color:#D4AF37}" +
    ".boltiv-global-footer-divider{width:34px;height:1px;background:#2a2a28;margin:2px 0}" +
    ".boltiv-global-footer-legal p{margin:3px 0;font-size:11px;line-height:1.65;color:#a3a39f}" +
    ".boltiv-global-footer-legal strong{color:#e8c766;font-weight:800}" +
    "@media(min-width:640px){.boltiv-global-footer{padding:34px 24px 30px}.boltiv-global-footer-legal p{font-size:11.5px}}";

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
          "<p>Powered by <strong>Boltiv Technologies Limited</strong>.</p>" +
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
    // A couple of screens set display:flex directly on <body> itself to center a single card
    // (e.g. the email-verification screen). Appending the footer straight into such a body
    // would make it a second flex item — sitting beside the existing content instead of below
    // it. Rather than leaving a gap or fighting the flex algorithm, move body's existing
    // children into a new wrapper that inherits the same layout properties, then reset body to
    // plain block flow. The page looks exactly the same (the centering just now happens one
    // level down), and body becomes a safe, predictable place to append the footer afterwards.
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

  function findContentHost() {
    // A number of BOLTIV screens wrap their content in a shell forced to at least full
    // viewport height (various class names — .page, .airtime-page, .exam-page, etc.). If the
    // footer were appended as a sibling *after* such a shell, on any page whose real content is
    // shorter than one screen it would end up a full viewport-height below the visible content,
    // behind a blank gap. Detecting this by computed style (rather than guessing class names)
    // lets the footer render directly under the real content on such pages.
    // This only ever applies to a plain block-flow shell. A flex/grid shell (e.g. a full-screen
    // centering layout like the admin login screen) would instead lay the footer out as another
    // flex/grid item alongside the existing content — exactly the kind of visual interference
    // the footer must never cause — so those fall back to a plain body-append instead.
    var children = document.body.children;
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE" || el.tagName === "LINK") continue;
      var cs = window.getComputedStyle(el);
      var minH = parseFloat(cs.minHeight) || 0;
      if (minH >= window.innerHeight * 0.9 && cs.display === "block") return el;
    }
    return document.body;
  }

  function inject() {
    if (document.getElementById(FOOTER_ID)) return;
    injectStyle();
    ensureBodyIsBlockFlow();
    var footer = buildFooter();
    findContentHost().appendChild(footer);
    reserveSpaceAroundFixedChrome(footer);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  } else {
    inject();
  }
})();
