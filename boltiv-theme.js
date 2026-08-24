(function () {
  const KEY = "boltiv-theme";
  const root = document.documentElement;

  function getSavedTheme() {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "dark" || saved === "light") return saved;
    } catch (_) {}
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark"
      : "light";
  }

  function updateToggle() {
    const btn = document.querySelector("[data-boltiv-theme-toggle]");
    if (!btn) return;
    const dark = root.getAttribute("data-theme") === "dark";
    btn.textContent = dark ? "☀️" : "🌙";
    btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    btn.setAttribute("title", dark ? "Switch to light mode" : "Switch to dark mode");
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    updateToggle();
  }

  // Apply before the page paints as much as possible.
  applyTheme(getSavedTheme());

  function installToggle() {
    const existing = document.querySelector("[data-boltiv-theme-toggle]");
    if (existing) {
      if (!existing.dataset.boltivThemeBound) {
        existing.dataset.boltivThemeBound = "1";
        existing.addEventListener("click", function () {
          const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
          try { localStorage.setItem(KEY, next); } catch (_) {}
          applyTheme(next);
        });
      }
      updateToggle();
      return;
    }

    // The theme control intentionally lives on the Profile page only.
    // The selected theme remains saved and applies across BOLTIV.
    const isProfile = /(^|\/)profile(?:\.html)?$/.test(window.location.pathname);
    if (!isProfile) return;

    const actions = document.querySelector(".profile-top-right");
    if (!actions) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "boltiv-theme-toggle profile-theme-toggle";
    btn.setAttribute("data-boltiv-theme-toggle", "");
    btn.addEventListener("click", function () {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      try { localStorage.setItem(KEY, next); } catch (_) {}
      applyTheme(next);
    });
    actions.insertBefore(btn, actions.firstChild);
    updateToggle();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installToggle, { once: true });
  } else {
    installToggle();
  }
})();
