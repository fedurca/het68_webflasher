/**
 * Persistent site language (cookie + localStorage).
 * Preference sticks until the user clicks CZ / EN / DE.
 */
(() => {
  const COOKIE = "het68_lang";
  const STORAGE = "het68-lang";
  const SUPPORTED = new Set(["cs", "en", "de"]);

  function readCookie() {
    const m = document.cookie.match(
      new RegExp("(?:^|; )" + COOKIE + "=([^;]*)")
    );
    return m ? decodeURIComponent(m[1]) : null;
  }

  function writeCookie(lang) {
    const parts = [
      `${COOKIE}=${encodeURIComponent(lang)}`,
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

  function getStoredLang() {
    try {
      const fromLs = localStorage.getItem(STORAGE);
      if (fromLs && SUPPORTED.has(fromLs)) return fromLs;
    } catch (_) {
      /* private mode */
    }
    const fromCookie = readCookie();
    if (fromCookie && SUPPORTED.has(fromCookie)) return fromCookie;
    return null;
  }

  function setStoredLang(lang) {
    if (!SUPPORTED.has(lang)) return;
    try {
      localStorage.setItem(STORAGE, lang);
    } catch (_) {
      /* ignore */
    }
    writeCookie(lang);
  }

  function pageLang() {
    const lang = (document.documentElement.lang || "cs").slice(0, 2).toLowerCase();
    return SUPPORTED.has(lang) ? lang : "cs";
  }

  /** Canonical path for a language on the current host. */
  function pathForLang(lang) {
    // Both the marketing site and the flasher ship CS / EN / DE.
    if (lang === "en") return "/en/";
    if (lang === "de") return "/de/";
    return "/";
  }

  function normalizePath(pathname) {
    if (!pathname || pathname === "/") return "/";
    return pathname.endsWith("/") ? pathname : `${pathname}/`;
  }

  function enforceStoredLang() {
    let stored = getStoredLang();
    const current = pageLang();

    if (!stored) {
      // First visit: adopt the language of the page we landed on.
      setStoredLang(current);
      return;
    }

    const target = normalizePath(pathForLang(stored));
    const here = normalizePath(location.pathname);

    if (target !== here) {
      location.replace(target + location.search + location.hash);
    }
  }

  function bindLangSwitchers() {
    document.querySelectorAll(".lang-switch a[hreflang]").forEach((link) => {
      link.addEventListener("click", (event) => {
        const lang = (link.getAttribute("hreflang") || "").slice(0, 2).toLowerCase();
        if (!SUPPORTED.has(lang)) return;
        setStoredLang(lang);
        // Let the browser follow href; cookie is already set.
      });
    });
  }

  enforceStoredLang();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindLangSwitchers);
  } else {
    bindLangSwitchers();
  }
})();
