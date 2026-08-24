
(function () {
  const KEY = "boltiv-theme";
  const root = document.documentElement;

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    const btn = document.querySelector("[data-boltiv-theme-toggle]");
    if (btn) {
      const dark = theme === "dark";
      btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
      btn.setAttribute("title", dark ? "Switch to light mode" : "Switch to dark mode");
      btn.textContent = dark ? "☀️" : "🌙";
    }
  }

  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (_) {}
  const initial = saved === "dark" || saved === "light"
    ? saved
    : (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  applyTheme(initial);

  document.addEventListener("DOMContentLoaded", function () {
    applyTheme(root.getAttribute("data-theme") || initial);
    const btn = document.querySelector("[data-boltiv-theme-toggle]");
    if (!btn) return;
    btn.addEventListener("click", function () {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      try { localStorage.setItem(KEY, next); } catch (_) {}
      applyTheme(next);
    });
  });
})();
