(function () {
  const root = document.documentElement;

  function updateMetaThemeColor(theme) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    meta.setAttribute("content", theme === "dark" ? "#0b1017" : "#ffffff");
  }

  function updateToggle() {
    const buttons = document.querySelectorAll("[data-boltiv-theme-toggle]");
    const dark = root.getAttribute("data-theme") === "dark";
    buttons.forEach(function (btn) {
      btn.textContent = dark ? "☀️" : "🌙";
      btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
      btn.setAttribute("title", dark ? "Switch to light mode" : "Switch to dark mode");
    });
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    updateToggle();
    updateMetaThemeColor(theme);
  }

  // Light is always the default. No localStorage. Toggle only lasts for this page view.
  applyTheme("light");

  function installToggle() {
    const buttons = document.querySelectorAll("[data-boltiv-theme-toggle]");
    buttons.forEach(function (btn) {
      if (btn.dataset.boltivThemeBound) return;
      btn.dataset.boltivThemeBound = "1";
      btn.addEventListener("click", function () {
        const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
        applyTheme(next);
      });
    });
    updateToggle();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installToggle, { once: true });
  } else {
    installToggle();
  }
})();
