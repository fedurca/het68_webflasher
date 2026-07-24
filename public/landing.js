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

  // ---- Atmospheric drones + Doppler acoustic rings (hero background) -----
  const canvas = document.getElementById("atmosCanvas");
  if (!canvas || !canvas.getContext) return;

  const ctx = canvas.getContext("2d");
  let w = 0;
  let h = 0;
  let dpr = 1;
  let raf = 0;
  let lastNow = performance.now();
  let spawnIn = 0.6;
  /** @type {{x:number,y:number,vx:number,vy:number,s:number,emit:number,progress:number,willBlast:boolean,blastAt:number,phase:number,alive:boolean}[]} */
  const drones = [];
  /** @type {{x:number,y:number,born:number,life:number,speed:number,strength:number,kind:string,vx:number}[]} */
  const pulses = [];
  /** @type {{x:number,y:number,born:number,life:number}[]} */
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

  function dronePath(g, x, y, s) {
    g.beginPath();
    g.ellipse(x, y, 18 * s, 8 * s, 0, 0, Math.PI * 2);
    g.moveTo(x - 28 * s, y - 14 * s);
    g.lineTo(x + 28 * s, y + 14 * s);
    g.moveTo(x + 28 * s, y - 14 * s);
    g.lineTo(x - 28 * s, y + 14 * s);
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

  function spawnDrone(stagger = 0) {
    const span = Math.max(w, 320);
    const speed = span / (7.5 + Math.random() * 4.5); // full crossing ~7.5–12 s
    drones.push({
      x: w + 50 + stagger * (40 + Math.random() * 80),
      y: h * (0.22 + Math.random() * 0.5),
      vx: -(speed * (0.92 + Math.random() * 0.2)),
      vy: (Math.random() - 0.5) * (h * 0.04),
      s: Math.max(0.7, Math.min(w, h) / 560) * (0.85 + Math.random() * 0.35),
      emit: Math.random() * 0.12,
      progress: 0,
      willBlast: Math.random() < 0.42,
      blastAt: 0.28 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
      alive: true,
    });
  }

  function emitPulse(x, y, strength, kind, life, speed, vx) {
    pulses.push({
      x,
      y,
      born: 0,
      life: life || 2.4,
      speed: speed || (95 + Math.random() * 40),
      strength: strength || 1,
      kind: kind || "cruise",
      vx: vx || 0,
    });
  }

  function triggerBlast(d) {
    blasts.push({ x: d.x, y: d.y, born: 0, life: 1.35 });
    for (let i = 0; i < 7; i++) {
      emitPulse(d.x, d.y, 1.4 - i * 0.12, "blast", 1.5 + i * 0.08, 140 + i * 28, d.vx);
    }
    // asymmetric shock lobes (visual acoustic crack)
    for (let i = 0; i < 4; i++) {
      const ang = -Math.PI * 0.15 + i * 0.22 + (Math.random() - 0.5) * 0.08;
      emitPulse(
        d.x + Math.cos(ang) * 6,
        d.y + Math.sin(ang) * 4,
        1.1,
        "shock",
        1.1,
        180 + Math.random() * 60,
        d.vx
      );
    }
    d.alive = false;
  }

  function scheduleSpawn(dt) {
    spawnIn -= dt;
    if (spawnIn > 0) return;
    const count = Math.random() < 0.38 ? 2 + (Math.random() < 0.45 ? 1 : 0) : 1;
    for (let i = 0; i < count; i++) spawnDrone(i);
    // keep the sky from overcrowding
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
   * Wavefront expands from the emission point (successive pulses → natural
   * Doppler bunching ahead of a leftward source). Extra elliptical squash
   * exaggerates compression on the leading side / stretch on the trailing side.
   */
  function drawDopplerPulse(p, light, age) {
    const u = age / p.life;
    if (u >= 1) return;
    const r = p.speed * age;
    // Mach-ish factor from source speed vs wave speed (visual, not physical units)
    const mach = Math.min(0.55, Math.abs(p.vx) / Math.max(p.speed, 1));
    const dir = p.vx <= 0 ? 1 : -1; // 1 = flying left → compress further left
    const compress = 1 - mach * (p.kind === "cruise" ? 0.45 : 0.65);
    const stretch = 1 + mach * (p.kind === "cruise" ? 0.55 : 0.85);
    const rx = r * ((compress + stretch) * 0.5);
    const ry = r * (p.kind === "shock" ? 0.52 + u * 0.22 : 0.82 - mach * 0.08);
    // Shift center toward the trailing side so the leading crest bunches up.
    const bias = dir * r * ((stretch - compress) * 0.5);
    const cx = p.x + bias;
    const cy = p.y;
    const base =
      p.kind === "blast"
        ? light
          ? 0.34
          : 0.42
        : p.kind === "shock"
          ? light
            ? 0.28
            : 0.36
          : light
            ? 0.2
            : 0.26;
    const alpha = (1 - u) * (1 - u) * base * p.strength;
    if (alpha < 0.01) return;

    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2);
    if (p.kind === "blast") {
      ctx.strokeStyle = `rgba(45, 212, 168, ${alpha})`;
      ctx.lineWidth = light ? 1.4 : 1.7;
    } else if (p.kind === "shock") {
      ctx.strokeStyle = `rgba(160, 220, 200, ${alpha * 0.9})`;
      ctx.lineWidth = 1.1;
    } else {
      ctx.strokeStyle = `rgba(31, 191, 160, ${alpha})`;
      ctx.lineWidth = light ? 1.05 : 1.3;
    }
    ctx.stroke();

    // Leading-edge crest highlight (compressed front)
    if (p.kind !== "shock" && u < 0.85) {
      const leadX = cx - dir * rx;
      const crest = alpha * (0.45 + mach * 0.35);
      ctx.beginPath();
      ctx.ellipse(leadX + dir * rx * 0.08, cy, rx * (0.1 + mach * 0.06), ry * 0.5, 0, -Math.PI * 0.55, Math.PI * 0.55);
      ctx.strokeStyle = `rgba(80, 230, 190, ${crest})`;
      ctx.lineWidth = 1.25;
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

    // crack spokes
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

    // update drones
    for (let i = drones.length - 1; i >= 0; i--) {
      const d = drones[i];
      if (!d.alive) {
        drones.splice(i, 1);
        continue;
      }
      d.x += d.vx * dt;
      d.y += d.vy * dt + Math.sin(now / 1000 + d.phase) * 0.15;
      const travel = w + 80 - d.x;
      d.progress = Math.max(0, Math.min(1, travel / (w + 100)));

      d.emit += dt;
      if (d.emit >= 0.14) {
        d.emit = 0;
        emitPulse(
          d.x,
          d.y,
          0.85 + Math.random() * 0.25,
          "cruise",
          2.8,
          88 + Math.random() * 36,
          d.vx
        );
      }

      if (d.willBlast && d.progress >= d.blastAt) {
        triggerBlast(d);
        drones.splice(i, 1);
        continue;
      }
      if (d.x < -60) {
        drones.splice(i, 1);
      }
    }

    // update / draw pulses (oldest first so newer crest sits on top)
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

    // drones (barely visible, heading left)
    for (const d of drones) {
      if (!d.alive) continue;
      ctx.save();
      ctx.translate(d.x, d.y);
      // nose points left (flight direction)
      ctx.rotate(Math.PI + Math.sin(now / 1000 + d.phase) * 0.06 + d.vy * 0.002);
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
  // seed one flyby so the hero is never empty on first paint
  spawnDrone(0);
  window.addEventListener("resize", resize);
  document.addEventListener("het68-theme", () => {
    /* redraw uses isLight() each frame */
  });
  raf = requestAnimationFrame(frame);
})();
