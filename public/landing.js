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

  // Tools dropdown (Wiki / API / Flasher / Dev / Chirp)
  document.querySelectorAll(".nav-dd").forEach((dd) => {
    const btn = dd.querySelector(".nav-dd-btn");
    const menu = dd.querySelector(".nav-dd-menu");
    if (!btn || !menu) return;

    const setOpen = (open) => {
      dd.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", String(open));
      if (open) menu.removeAttribute("hidden");
      else menu.setAttribute("hidden", "");
    };

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setOpen(btn.getAttribute("aria-expanded") !== "true");
    });

    menu.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => setOpen(false));
    });

    document.addEventListener("click", (ev) => {
      if (!dd.contains(ev.target)) setOpen(false);
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") setOpen(false);
    });
  });

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

  // ---- Atmospheric drones + per-rotor Doppler rings (hero background) ----
  // Flight L→R: right rotors spin faster → denser acoustic contours.
  const canvas = document.getElementById("atmosCanvas");
  if (!canvas || !canvas.getContext) return;

  const ctx = canvas.getContext("2d");
  let w = 0;
  let h = 0;
  let dpr = 1;
  let raf = 0;
  let lastNow = performance.now();
  let spawnIn = 0.6;
  /** Local rotor offsets (nose +X). Right side spins faster when flying L→R. */
  const ROTOR_DEFS = [
    { ox: -28, oy: -14, side: "left" },
    { ox: 28, oy: -14, side: "right" },
    { ox: -28, oy: 14, side: "left" },
    { ox: 28, oy: 14, side: "right" },
  ];
  /** @type {any[]} */
  const drones = [];
  /** @type {any[]} */
  const pulses = [];
  /** @type {any[]} */
  const blasts = [];

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

  function droneAngle(d, now) {
    // Nose points +X (right); slight bank / bob.
    return Math.sin(now / 1000 + d.phase) * 0.06 + d.vy * 0.002;
  }

  function rotorWorldPositions(d, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const s = d.s;
    return ROTOR_DEFS.map((r) => {
      const lx = r.ox * s;
      const ly = r.oy * s;
      return {
        x: d.x + lx * cos - ly * sin,
        y: d.y + lx * sin + ly * cos,
        side: r.side,
      };
    });
  }

  function dronePath(g, x, y, s) {
    g.beginPath();
    g.ellipse(x, y, 18 * s, 8 * s, 0, 0, Math.PI * 2);
    g.moveTo(x - 28 * s, y - 14 * s);
    g.lineTo(x + 28 * s, y + 14 * s);
    g.moveTo(x + 28 * s, y - 14 * s);
    g.lineTo(x - 28 * s, y + 14 * s);
    ROTOR_DEFS.forEach((r) => {
      const rx = x + r.ox * s;
      const ry = y + r.oy * s;
      g.moveTo(rx + 10 * s, ry);
      g.arc(rx, ry, 10 * s, 0, Math.PI * 2);
    });
  }

  function spawnDrone(stagger = 0) {
    const span = Math.max(w, 320);
    const speed = span / (7.5 + Math.random() * 4.5); // full crossing ~7.5–12 s
    // Right motors faster → shorter emit period → denser contour spacing.
    const leftPeriod = 0.2 + Math.random() * 0.04;
    const rightPeriod = 0.075 + Math.random() * 0.025;
    drones.push({
      x: -50 - stagger * (40 + Math.random() * 80),
      y: h * (0.22 + Math.random() * 0.5),
      vx: speed * (0.92 + Math.random() * 0.2),
      vy: (Math.random() - 0.5) * (h * 0.04),
      s: Math.max(0.7, Math.min(w, h) / 560) * (0.85 + Math.random() * 0.35),
      progress: 0,
      willBlast: Math.random() < 0.42,
      blastAt: 0.28 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
      alive: true,
      rotors: ROTOR_DEFS.map((r) => ({
        side: r.side,
        emit: Math.random() * (r.side === "right" ? rightPeriod : leftPeriod),
        period: r.side === "right" ? rightPeriod : leftPeriod,
      })),
    });
  }

  function emitPulse(x, y, strength, kind, life, speed, vx, side) {
    pulses.push({
      x,
      y,
      born: 0,
      life: life || 2.4,
      speed: speed || (95 + Math.random() * 40),
      strength: strength || 1,
      kind: kind || "cruise",
      vx: vx || 0,
      side: side || "left",
    });
  }

  function triggerBlast(d, now) {
    blasts.push({ x: d.x, y: d.y, born: 0, life: 1.35 });
    const rotors = rotorWorldPositions(d, droneAngle(d, now));
    rotors.forEach((r, ri) => {
      const dense = r.side === "right";
      const n = dense ? 5 : 3;
      for (let i = 0; i < n; i++) {
        emitPulse(
          r.x,
          r.y,
          (dense ? 1.35 : 1.1) - i * 0.12,
          "blast",
          1.35 + i * 0.08,
          (dense ? 155 : 130) + i * 26,
          d.vx,
          r.side
        );
      }
      // asymmetric shock from each rotor hub
      const ang = (ri / 4) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
      emitPulse(
        r.x + Math.cos(ang) * 4,
        r.y + Math.sin(ang) * 3,
        dense ? 1.15 : 0.95,
        "shock",
        1.05,
        170 + Math.random() * 50,
        d.vx,
        r.side
      );
    });
    d.alive = false;
  }

  function scheduleSpawn(dt) {
    spawnIn -= dt;
    if (spawnIn > 0) return;
    const count = Math.random() < 0.38 ? 2 + (Math.random() < 0.45 ? 1 : 0) : 1;
    for (let i = 0; i < count; i++) spawnDrone(i);
    spawnIn = count > 1 ? 3.2 + Math.random() * 2.8 : 1.8 + Math.random() * 2.4;
    if (drones.filter((d) => d.alive).length > 5) spawnIn += 1.5;
  }

  function drawFog(light) {
    if (light) {
      const fog = ctx.createRadialGradient(w * 0.55, h * 0.4, 20, w * 0.55, h * 0.4, w * 0.65);
      fog.addColorStop(0, "rgba(210, 220, 228, 0.28)");
      fog.addColorStop(0.5, "rgba(190, 205, 215, 0.12)");
      fog.addColorStop(1, "rgba(244, 247, 249, 0)");
      ctx.fillStyle = fog;
    } else {
      const night = ctx.createRadialGradient(w * 0.55, h * 0.4, 10, w * 0.55, h * 0.4, w * 0.6);
      night.addColorStop(0, "rgba(8, 14, 18, 0.12)");
      night.addColorStop(1, "rgba(5, 8, 10, 0)");
      ctx.fillStyle = night;
    }
    ctx.fillRect(0, 0, w, h);
  }

  /**
   * Wavefront from a rotor hub. Flying L→R → compress on the right;
   * right-side rotors use denser emission (handled at emit time).
   */
  function drawDopplerPulse(p, light, age) {
    const u = age / p.life;
    if (u >= 1) return;
    const r = p.speed * age;
    const mach = Math.min(0.55, Math.abs(p.vx) / Math.max(p.speed, 1));
    // Bias: shift ellipse center toward trailing side so leading crest bunches.
    const dir = p.vx >= 0 ? -1 : 1; // L→R → compress further right
    const compress = 1 - mach * (p.kind === "cruise" ? 0.45 : 0.65);
    const stretch = 1 + mach * (p.kind === "cruise" ? 0.55 : 0.85);
    const rx = r * ((compress + stretch) * 0.5);
    const ry = r * (p.kind === "shock" ? 0.52 + u * 0.22 : 0.78 - mach * 0.08);
    const bias = dir * r * ((stretch - compress) * 0.5);
    const cx = p.x + bias;
    const cy = p.y;
    const denseBoost = p.side === "right" ? 1.15 : 1;
    const base =
      p.kind === "blast"
        ? light
          ? 0.3
          : 0.38
        : p.kind === "shock"
          ? light
            ? 0.24
            : 0.32
          : light
            ? 0.16
            : 0.22;
    const alpha = (1 - u) * (1 - u) * base * p.strength * denseBoost;
    if (alpha < 0.01) return;

    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2);
    if (p.kind === "blast") {
      ctx.strokeStyle = `rgba(45, 212, 168, ${alpha})`;
      ctx.lineWidth = light ? 1.3 : 1.55;
    } else if (p.kind === "shock") {
      ctx.strokeStyle = `rgba(160, 220, 200, ${alpha * 0.9})`;
      ctx.lineWidth = 1.05;
    } else {
      ctx.strokeStyle = `rgba(31, 191, 160, ${alpha})`;
      ctx.lineWidth = (light ? 0.95 : 1.15) * (p.side === "right" ? 1.05 : 0.95);
    }
    ctx.stroke();

    if (p.kind !== "shock" && u < 0.85) {
      const leadX = cx - dir * rx;
      const crest = alpha * (0.45 + mach * 0.35);
      ctx.beginPath();
      ctx.ellipse(
        leadX + dir * rx * 0.08,
        cy,
        rx * (0.1 + mach * 0.06),
        ry * 0.5,
        0,
        -Math.PI * 0.55,
        Math.PI * 0.55
      );
      ctx.strokeStyle = `rgba(80, 230, 190, ${crest})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  function drawBlastFlash(b, light, age) {
    const u = age / b.life;
    if (u >= 1) return;
    const flash = (1 - u) * (1 - u);
    const r = 18 + u * 90;
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
    if (light) {
      g.addColorStop(0, `rgba(31, 191, 160, ${0.22 * flash})`);
      g.addColorStop(0.35, `rgba(45, 212, 168, ${0.1 * flash})`);
      g.addColorStop(1, "rgba(244, 247, 249, 0)");
    } else {
      g.addColorStop(0, `rgba(45, 212, 168, ${0.28 * flash})`);
      g.addColorStop(0.4, `rgba(31, 191, 160, ${0.1 * flash})`);
      g.addColorStop(1, "rgba(5, 8, 10, 0)");
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.globalAlpha = flash * (light ? 0.35 : 0.45);
    ctx.strokeStyle = light ? "rgba(20, 120, 100, 0.8)" : "rgba(140, 235, 200, 0.85)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + u * 0.4;
      const len = 20 + u * 55 + (i % 2) * 12;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 4, Math.sin(a) * 4);
      ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len * 0.7);
      ctx.stroke();
    }
    ctx.restore();
  }

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;
    const light = isLight();
    ctx.clearRect(0, 0, w, h);
    drawFog(light);

    scheduleSpawn(dt);

    for (let i = drones.length - 1; i >= 0; i--) {
      const d = drones[i];
      if (!d.alive) {
        drones.splice(i, 1);
        continue;
      }
      d.x += d.vx * dt;
      d.y += d.vy * dt + Math.sin(now / 1000 + d.phase) * 0.15;
      d.progress = Math.max(0, Math.min(1, (d.x + 60) / (w + 120)));

      const angle = droneAngle(d, now);
      const hubs = rotorWorldPositions(d, angle);
      for (let ri = 0; ri < 4; ri++) {
        const rotor = d.rotors[ri];
        const hub = hubs[ri];
        rotor.emit += dt;
        if (rotor.emit < rotor.period) continue;
        rotor.emit = 0;
        const dense = rotor.side === "right";
        emitPulse(
          hub.x,
          hub.y,
          dense ? 0.95 + Math.random() * 0.2 : 0.7 + Math.random() * 0.2,
          "cruise",
          dense ? 2.4 : 2.7,
          dense ? 78 + Math.random() * 28 : 90 + Math.random() * 34,
          d.vx,
          rotor.side
        );
      }

      if (d.willBlast && d.progress >= d.blastAt) {
        triggerBlast(d, now);
        drones.splice(i, 1);
        continue;
      }
      if (d.x > w + 70) {
        drones.splice(i, 1);
      }
    }

    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.born += dt;
      if (p.born >= p.life) {
        pulses.splice(i, 1);
        continue;
      }
      drawDopplerPulse(p, light, p.born);
    }

    for (let i = blasts.length - 1; i >= 0; i--) {
      const b = blasts[i];
      b.born += dt;
      if (b.born >= b.life) {
        blasts.splice(i, 1);
        continue;
      }
      drawBlastFlash(b, light, b.born);
    }

    // drones (barely visible, nose to the right)
    for (const d of drones) {
      if (!d.alive) continue;
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(droneAngle(d, now));
      ctx.globalAlpha = light ? 0.08 : 0.12;
      ctx.strokeStyle = light ? "rgba(40, 55, 65, 0.9)" : "rgba(180, 195, 205, 0.85)";
      ctx.fillStyle = light ? "rgba(50, 65, 75, 0.35)" : "rgba(120, 135, 145, 0.25)";
      ctx.lineWidth = 1.2;
      dronePath(ctx, 0, 0, d.s);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    raf = requestAnimationFrame(frame);
  }

  resize();
  spawnDrone(0);
  window.addEventListener("resize", resize);
  document.addEventListener("het68-theme", () => {
    /* redraw uses isLight() each frame */
  });
  raf = requestAnimationFrame(frame);
})();
