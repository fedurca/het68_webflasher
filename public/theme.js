/**
 * Shared light/dark theme across *.het68.cz (cookie + localStorage).
 * Applies both html[data-theme] (chirp/dev) and body.theme-light (marketing).
 */
(() => {
  const COOKIE = "het68_theme";
  const STORAGE = "het68-theme";

  function readCookie() {
    const m = document.cookie.match(
      new RegExp("(?:^|; )" + COOKIE + "=([^;]*)")
    );
    return m ? decodeURIComponent(m[1]) : null;
  }

  function writeCookie(theme) {
    const parts = [
      `${COOKIE}=${encodeURIComponent(theme)}`,
      "Path=/",
      "Max-Age=31536000",
      "SameSite=Lax",
    ];
    if (location.protocol === "https:") parts.push("Secure");
    const host = location.hostname.toLowerCase();
    if (host === "het68.cz" || host.endsWith(".het68.cz")) {
      parts.push("Domain=.het68.cz");
    }
    document.cookie = parts.join("; ");
  }

  function normalize(theme) {
    return theme === "light" ? "light" : "dark";
  }

  function preferred() {
    try {
      if (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches) {
        return "light";
      }
    } catch (_) {
      /* ignore */
    }
    return "dark";
  }

  function getStoredTheme() {
    const fromCookie = readCookie();
    if (fromCookie === "light" || fromCookie === "dark") return fromCookie;
    try {
      const fromLs = localStorage.getItem(STORAGE);
      if (fromLs === "light" || fromLs === "dark") return fromLs;
    } catch (_) {
      /* private mode */
    }
    return preferred();
  }

  function applyTheme(theme, opts) {
    const next = normalize(theme);
    document.documentElement.dataset.theme = next;
    if (document.body) {
      document.body.classList.toggle("theme-light", next === "light");
    }
    try {
      localStorage.setItem(STORAGE, next);
    } catch (_) {
      /* ignore */
    }
    if (!opts || opts.persist !== false) writeCookie(next);

    document.querySelectorAll("#themeBtn, #themeToggle, .theme-toggle").forEach((btn) => {
      if (!btn) return;
      if (btn.tagName === "BUTTON" && !btn.querySelector("svg")) {
        btn.textContent = next === "light" ? "\u263e" : "\u2600";
      }
      btn.setAttribute("aria-pressed", String(next === "light"));
    });

    try {
      document.dispatchEvent(
        new CustomEvent("het68-theme", { detail: { theme: next } })
      );
    } catch (_) {
      /* ignore */
    }
    return next;
  }

  function toggleTheme() {
    return applyTheme(getStoredTheme() === "light" ? "dark" : "light");
  }

  function boot() {
    applyTheme(getStoredTheme(), { persist: true });
    const bind = () => {
      document.querySelectorAll("#themeBtn, #themeToggle, .theme-toggle").forEach((btn) => {
        if (!btn || btn.dataset.themeBound) return;
        btn.dataset.themeBound = "1";
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          toggleTheme();
        });
      });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bind);
    } else {
      bind();
    }
  }

  window.HET68Theme = {
    get: getStoredTheme,
    apply: applyTheme,
    toggle: toggleTheme,
  };

  boot();
})();
