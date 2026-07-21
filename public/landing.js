(() => {
  const navToggle = document.getElementById("navToggle");
  const siteNav = document.getElementById("siteNav");
  const themeBtn = document.getElementById("themeBtn");
  const year = document.getElementById("year");

  if (year) year.textContent = String(new Date().getFullYear());

  if (navToggle && siteNav) {
    navToggle.addEventListener("click", () => {
      const open = navToggle.getAttribute("aria-expanded") === "true";
      navToggle.setAttribute("aria-expanded", String(!open));
      siteNav.classList.toggle("is-open", !open);
    });

    siteNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        navToggle.setAttribute("aria-expanded", "false");
        siteNav.classList.remove("is-open");
      });
    });
  }

  const saved = localStorage.getItem("het68-theme");
  if (saved === "light") document.body.classList.add("theme-light");

  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      document.body.classList.toggle("theme-light");
      localStorage.setItem(
        "het68-theme",
        document.body.classList.contains("theme-light") ? "light" : "dark"
      );
    });
  }

  const LOCALES = { cs: "cs-CZ", en: "en-US", de: "de-DE" };
  const BUILD_I18N = {
    cs: { deployed: "nasazeno", ago: (s) => `před ${s}` },
    en: { deployed: "deployed", ago: (s) => `${s} ago` },
    de: { deployed: "bereitgestellt", ago: (s) => `vor ${s}` },
  };

  function ageString(fromIso) {
    const then = new Date(fromIso).getTime();
    if (!isFinite(then)) return null;
    const mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs} h`;
    return `${Math.floor(hrs / 24)} d`;
  }

  const buildMeta = document.getElementById("buildMeta");
  if (buildMeta) {
    const lang = (document.documentElement.lang || "cs").slice(0, 2).toLowerCase();
    const i18n = BUILD_I18N[lang] || BUILD_I18N.cs;
    const locale = LOCALES[lang] || "cs-CZ";
    fetch("/build-info.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        if (!info || !info.version) return;
        const date = new Date(info.deployedAt);
        const parts = [`v${info.version}`];
        if (!isNaN(date.getTime())) {
          parts.push(`${i18n.deployed} ${date.toLocaleDateString(locale)}`);
          const age = ageString(info.deployedAt);
          if (age) parts.push(i18n.ago(age));
        }
        if (info.commit) parts.push(info.commit);
        buildMeta.textContent = parts.join(" · ");
        buildMeta.hidden = false;
        buildMeta.title = info.deployedAt || "";
      })
      .catch(() => {});
  }
})();
