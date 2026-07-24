/**
 * Shared light/dark theme across *.het68.cz (cookie + localStorage).
 * Applies both html[data-theme] (chirp/dev/flasher) and body.theme-light (marketing).
 * Toggle icon shows the theme you switch TO (sun in dark, moon in light).
 */
(() => {
  const COOKIE = "het68_theme";
  const STORAGE = "het68-theme";
  const BTN_SEL = "#themeBtn, #themeToggle, button.theme-toggle, button.theme-btn";

  const SUN_SVG =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M12 2v2.2M12 19.8V22M2 12h2.2M19.8 12H22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    "</svg>";

  const MOON_SVG =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
    "</svg>";

  function readCookie() {
    const m = document.cookie.match(
      new RegExp("(?:^|; )" + COOKIE + "=([^;]*)")
    );
    return m ? decodeURIComponent(m[1]) : null;
  }

  function writeCookie(theme) {
    const host = location.hostname.toLowerCase();
    const base = [
      `${COOKIE}=${encodeURIComponent(theme)}`,
      "Path=/",
      "Max-Age=31536000",
      "SameSite=Lax",
    ];
    if (location.protocol === "https:") base.push("Secure");

    // Prefer shared parent-domain cookie across het68.cz subdomains.
    if (host === "het68.cz" || host.endsWith(".het68.cz")) {
      document.cookie = base.concat("Domain=.het68.cz").join("; ");
      // Clear a possible host-only leftover that would shadow the shared cookie.
      document.cookie = [
        `${COOKIE}=`,
        "Path=/",
        "Max-Age=0",
        "SameSite=Lax",
      ]
        .concat(location.protocol === "https:" ? ["Secure"] : [])
        .join("; ");
    } else {
      document.cookie = base.join("; ");
    }
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

  function syncIcons(theme) {
    // Icon = destination theme (what a click will switch to).
    const toLight = theme !== "light";
    document.querySelectorAll(BTN_SEL).forEach((btn) => {
      if (!btn) return;
      const useSvg =
        btn.classList.contains("theme-btn") ||
        btn.id === "themeBtn" ||
        btn.dataset.themeIcon === "svg" ||
        !!btn.querySelector("svg");
      if (useSvg) {
        btn.innerHTML = toLight ? SUN_SVG : MOON_SVG;
        btn.dataset.themeIcon = "svg";
      } else {
        btn.textContent = toLight ? "\u2600" : "\u263e";
      }
      btn.setAttribute("aria-pressed", String(theme === "light"));
      btn.setAttribute("data-theme-state", theme);
    });
  }

  function applyTheme(theme, opts) {
    const next = normalize(theme);
    const root = document.documentElement;
    root.dataset.theme = next;
    root.classList.toggle("theme-light", next === "light");
    if (document.body) {
      document.body.classList.toggle("theme-light", next === "light");
    }
    try {
      localStorage.setItem(STORAGE, next);
    } catch (_) {
      /* ignore */
    }
    if (!opts || opts.persist !== false) writeCookie(next);
    syncIcons(next);

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
    const cur =
      document.documentElement.dataset.theme === "light" ? "light" : "dark";
    // Prefer live DOM state so icon and paint stay in lockstep even if storage lags.
    return applyTheme(cur === "light" ? "dark" : "light");
  }

  function bindButtons() {
    document.querySelectorAll(BTN_SEL).forEach((btn) => {
      if (!btn || btn.dataset.themeBound) return;
      btn.dataset.themeBound = "1";
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        toggleTheme();
      });
    });
  }

  function boot() {
    applyTheme(getStoredTheme(), { persist: true });
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        applyTheme(getStoredTheme(), { persist: true });
        bindButtons();
      });
    } else {
      bindButtons();
    }

    // Re-sync when returning from another subdomain tab.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      applyTheme(getStoredTheme(), { persist: true });
    });
    window.addEventListener("storage", (ev) => {
      if (ev.key !== STORAGE) return;
      if (ev.newValue === "light" || ev.newValue === "dark") {
        applyTheme(ev.newValue, { persist: true });
      }
    });
  }

  window.HET68Theme = {
    get: getStoredTheme,
    apply: applyTheme,
    toggle: toggleTheme,
    syncIcons,
  };

  boot();
})();
