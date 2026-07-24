(() => {
  const navToggle = document.getElementById("navToggle");
  const siteNav = document.getElementById("siteNav");
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

  // Theme is owned by /theme.js (shared cookie across *.het68.cz).
  if (window.HET68Theme) {
    window.HET68Theme.apply(window.HET68Theme.get());
  } else {
    const saved = localStorage.getItem("het68-theme");
    if (saved === "light") document.body.classList.add("theme-light");
  }

  const LOCALES = { cs: "cs-CZ", en: "en-US", de: "de-DE" };
  const BUILD_I18N = {
    cs: { deployed: "nasazeno", ago: (s) => `před ${s}` },
    en: { deployed: "deployed", ago: (s) => `${s} ago` },
    de: { deployed: "bereitgestellt", ago: (s) => `vor ${s}` },
  };

  function fmtDateTime(d) {
    const p = (n) => (n < 10 ? "0" : "") + n;
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(
      d.getHours()
    )}:${p(d.getMinutes())}`;
  }

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
    fetch("/build-info.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        if (!info || !info.version) return;
        const date = new Date(info.deployedAt);
        const parts = [`v${info.version}`];
        if (!isNaN(date.getTime())) {
          parts.push(`${i18n.deployed} ${fmtDateTime(date)}`);
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

  // ---- Atmospheric drone + acoustic rings (hero background) ---------------
  const canvas = document.getElementById("atmosCanvas");
  if (!canvas || !canvas.getContext) return;

  const ctx = canvas.getContext("2d");
  let w = 0;
  let h = 0;
  let dpr = 1;
  let raf = 0;
  let t0 = performance.now();

  function isLight() {
    if (window.HET68Theme) return window.HET68Theme.get() === "light";
    return (
      document.body.classList.contains("theme-light") ||
      document.documentElement.dataset.theme === "light"
    );
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || Math.max(420, window.innerHeight * 0.7);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function dronePath(g, x, y, s) {
    g.beginPath();
    // body
    g.ellipse(x, y, 18 * s, 8 * s, 0, 0, Math.PI * 2);
    // arms
    g.moveTo(x - 28 * s, y - 14 * s);
    g.lineTo(x + 28 * s, y + 14 * s);
    g.moveTo(x + 28 * s, y - 14 * s);
    g.lineTo(x - 28 * s, y + 14 * s);
    // rotors
    [
      [x - 28 * s, y - 14 * s],
      [x + 28 * s, y - 14 * s],
      [x - 28 * s, y + 14 * s],
      [x + 28 * s, y + 14 * s],
    ].forEach(([rx, ry]) => {
      g.moveTo(rx + 10 * s, ry);
      g.arc(rx, ry, 10 * s, 0, Math.PI * 2);
    });
  }

  function frame(now) {
    const t = (now - t0) / 1000;
    const light = isLight();
    ctx.clearRect(0, 0, w, h);

    // fog / night wash
    if (light) {
      const fog = ctx.createRadialGradient(w * 0.62, h * 0.42, 20, w * 0.62, h * 0.42, w * 0.55);
      fog.addColorStop(0, "rgba(210, 220, 228, 0.35)");
      fog.addColorStop(0.45, "rgba(190, 205, 215, 0.18)");
      fog.addColorStop(1, "rgba(244, 247, 249, 0)");
      ctx.fillStyle = fog;
      ctx.fillRect(0, 0, w, h);
    } else {
      const night = ctx.createRadialGradient(w * 0.62, h * 0.42, 10, w * 0.62, h * 0.42, w * 0.5);
      night.addColorStop(0, "rgba(8, 14, 18, 0.15)");
      night.addColorStop(1, "rgba(5, 8, 10, 0)");
      ctx.fillStyle = night;
      ctx.fillRect(0, 0, w, h);
    }

    // slow drift
    const cx = w * (0.58 + Math.sin(t * 0.18) * 0.04);
    const cy = h * (0.42 + Math.cos(t * 0.14) * 0.05);
    const scale = Math.max(0.85, Math.min(w, h) / 520);

    // acoustic rings (teal / green)
    for (let i = 0; i < 5; i++) {
      const phase = (t * 0.35 + i * 0.2) % 1;
      const r = (28 + phase * 160) * scale;
      const alpha = (1 - phase) * (light ? 0.22 : 0.28);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(31, 191, 160, ${alpha})`;
      ctx.lineWidth = light ? 1.1 : 1.35;
      ctx.stroke();
    }

    // secondary delayed pulse
    for (let i = 0; i < 3; i++) {
      const phase = (t * 0.22 + 0.5 + i * 0.25) % 1;
      const r = (40 + phase * 210) * scale;
      const alpha = (1 - phase) * (light ? 0.1 : 0.14);
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 1.25, r * 0.72, t * 0.1, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(45, 212, 168, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // barely-visible drone
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.sin(t * 0.2) * 0.08);
    ctx.globalAlpha = light ? 0.07 : 0.1;
    ctx.strokeStyle = light ? "rgba(40, 55, 65, 0.9)" : "rgba(180, 195, 205, 0.85)";
    ctx.fillStyle = light ? "rgba(50, 65, 75, 0.35)" : "rgba(120, 135, 145, 0.25)";
    ctx.lineWidth = 1.2;
    dronePath(ctx, 0, 0, scale);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    raf = requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener("resize", resize);
  document.addEventListener("het68-theme", () => {
    /* redraw uses isLight() each frame */
  });
  raf = requestAnimationFrame(frame);
})();
