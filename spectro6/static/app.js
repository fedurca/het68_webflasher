(() => {
  const CHANNELS = 6;
  const BINS = 256;
  const HISTORY = 480;
  const TRAIL_MAX = 180;
  const TRAIL_FADE_MS = 14000;
  // mic1 at top (−90°), then clockwise mic2…mic6 every 60°
  const MIC_ANGLES = Array.from({ length: CHANNELS }, (_, i) => -Math.PI / 2 + i * (Math.PI / 3));

  const el = {
    device: document.getElementById("device"),
    start: document.getElementById("btnStart"),
    stop: document.getElementById("btnStop"),
    clearTrail: document.getElementById("btnClearTrail"),
    status: document.getElementById("status"),
    channels: document.getElementById("channels"),
    stats: document.getElementById("stats"),
    debug: document.getElementById("debug"),
    doaCanvas: document.getElementById("doaCanvas"),
    doaAz: document.querySelector("#doaReadout [data-az]"),
    doaFocus: document.querySelector("#doaReadout [data-focus]"),
    doaDom: document.querySelector("#doaReadout [data-dom]"),
    doaTrail: document.querySelector("#doaReadout [data-trail]"),
  };

  /** @type {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, fill: HTMLElement, db: HTMLElement, peak: HTMLElement, hist: Uint8Array, gaps: Uint8Array }[]} */
  const rows = [];

  const LUT = (() => {
    const t = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      const u = i / 255;
      const r = Math.round(2 + u * u * 50);
      const g = Math.round(6 + u * 200);
      const b = Math.round(4 + u * 55);
      const o = i * 4;
      t[o] = r;
      t[o + 1] = g;
      t[o + 2] = b;
      t[o + 3] = 255;
    }
    return t;
  })();

  /* ---------- Hexagon DOA map ----------------------------------------- */
  const doa = {
    trail: /** @type {{ x: number, y: number, t: number, s: number }[]} */ ([]),
    lastLevels: new Array(CHANNELS).fill(0),
    lastDoa: /** @type {null | { x: number, y: number, r: number, deg: number, dom: number, strength: number }} */ (
      null
    ),
    raf: 0,
  };

  function estimateDoa(vuDb) {
    if (!vuDb || vuDb.length < CHANNELS) return null;
    // Soft-floor; convert to linear power in 2 kHz band
    const powers = [];
    let sum = 0;
    let dom = 0;
    for (let i = 0; i < CHANNELS; i++) {
      const db = Number(vuDb[i]);
      const p = Math.pow(10, Math.max(db, -90) / 10);
      powers.push(p);
      sum += p;
      if (p > powers[dom]) dom = i;
    }
    if (sum < 1e-14) return null;

    let cx = 0;
    let cy = 0;
    for (let i = 0; i < CHANNELS; i++) {
      const w = powers[i] / sum;
      cx += w * Math.cos(MIC_ANGLES[i]);
      cy += w * Math.sin(MIC_ANGLES[i]);
    }
    const r = Math.hypot(cx, cy); // 0 = ambient/center, ~1 = on one vertex
    const ang = Math.atan2(cy, cx);
    // Strength: how far above quiet floor (for trail visibility)
    const meanDb = vuDb.reduce((a, b) => a + Number(b), 0) / CHANNELS;
    const strength = Math.max(0, Math.min(1, (meanDb + 70) / 55));
    if (strength < 0.08 && r < 0.12) return null; // too quiet / isotropic
    return {
      x: cx,
      y: cy,
      r,
      deg: ((ang * 180) / Math.PI + 360) % 360,
      dom,
      strength,
      powers,
    };
  }

  function pushTrail(est) {
    if (!est) return;
    const now = performance.now();
    const last = doa.trail[doa.trail.length - 1];
    // Skip near-duplicates to keep trail readable
    if (last && Math.hypot(est.x - last.x, est.y - last.y) < 0.02 && now - last.t < 40) {
      last.t = now;
      last.s = Math.max(last.s, est.strength);
      return;
    }
    doa.trail.push({ x: est.x, y: est.y, t: now, s: est.strength });
    while (doa.trail.length > TRAIL_MAX) doa.trail.shift();
  }

  function clearTrail() {
    doa.trail.length = 0;
    if (el.doaTrail) el.doaTrail.textContent = "0";
    drawDoa(performance.now());
  }

  function drawDoa(now) {
    const canvas = el.doaCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const R = Math.min(w, h) * 0.38;

    ctx.clearRect(0, 0, w, h);

    // soft vignette
    const g = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.35);
    g.addColorStop(0, "rgba(8,104,33,0.18)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // hexagon ring
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + i * (Math.PI / 3);
      const x = cx + Math.cos(a) * R;
      const y = cy + Math.sin(a) * R;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = "rgba(26,154,60,0.55)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "rgba(8,104,33,0.06)";
    ctx.fill();

    // radial spokes
    ctx.strokeStyle = "rgba(148,163,184,0.12)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(MIC_ANGLES[i]) * R, cy + Math.sin(MIC_ANGLES[i]) * R);
      ctx.stroke();
    }

    // fading trail (oldest → newest)
    const alive = [];
    for (const p of doa.trail) {
      const age = now - p.t;
      if (age > TRAIL_FADE_MS) continue;
      alive.push(p);
      const u = 1 - age / TRAIL_FADE_MS;
      const px = cx + p.x * R;
      const py = cy + p.y * R;
      const rad = 2.5 + 5 * u * p.s;
      ctx.beginPath();
      ctx.arc(px, py, rad, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(26, 154, 60, ${0.08 + 0.55 * u * u})`;
      ctx.fill();
    }
    doa.trail = alive;

    // trail polyline
    if (alive.length > 1) {
      ctx.beginPath();
      for (let i = 0; i < alive.length; i++) {
        const p = alive[i];
        const u = 1 - (now - p.t) / TRAIL_FADE_MS;
        const px = cx + p.x * R;
        const py = cy + p.y * R;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        ctx.strokeStyle = `rgba(232, 240, 234, ${0.05 + 0.35 * u})`;
      }
      // redraw as segments with per-segment alpha
      for (let i = 1; i < alive.length; i++) {
        const a = alive[i - 1];
        const b = alive[i];
        const u = 1 - (now - b.t) / TRAIL_FADE_MS;
        ctx.beginPath();
        ctx.moveTo(cx + a.x * R, cy + a.y * R);
        ctx.lineTo(cx + b.x * R, cy + b.y * R);
        ctx.strokeStyle = `rgba(26, 154, 60, ${0.1 + 0.55 * u})`;
        ctx.lineWidth = 1.5 + 2.5 * u;
        ctx.stroke();
      }
    }

    // microphone nodes
    const levels = doa.lastLevels;
    for (let i = 0; i < CHANNELS; i++) {
      const a = MIC_ANGLES[i];
      const mx = cx + Math.cos(a) * R;
      const my = cy + Math.sin(a) * R;
      const lvl = levels[i] || 0;
      const hot = doa.lastDoa && doa.lastDoa.dom === i;
      ctx.beginPath();
      ctx.arc(mx, my, 11 + lvl * 10, 0, Math.PI * 2);
      ctx.fillStyle = hot ? "#1a9a3c" : `rgba(8,104,33,${0.35 + lvl * 0.55})`;
      ctx.fill();
      ctx.strokeStyle = hot ? "#e8f0ea" : "rgba(232,240,234,0.45)";
      ctx.lineWidth = hot ? 2 : 1;
      ctx.stroke();
      ctx.fillStyle = "#e8f0ea";
      ctx.font = "700 11px Manrope, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), mx, my);
    }

    // current source marker
    if (doa.lastDoa) {
      const d = doa.lastDoa;
      const sx = cx + d.x * R;
      const sy = cy + d.y * R;
      ctx.beginPath();
      ctx.arc(sx, sy, 7 + 4 * d.strength, 0, Math.PI * 2);
      ctx.fillStyle = "#e8f0ea";
      ctx.fill();
      ctx.strokeStyle = "#086821";
      ctx.lineWidth = 2;
      ctx.stroke();
      // direction tick from center
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(sx, sy);
      ctx.strokeStyle = "rgba(232,240,234,0.55)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // center hub
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(232,240,234,0.35)";
    ctx.fill();

    if (el.doaTrail) el.doaTrail.textContent = String(alive.length);
  }

  function tickDoa() {
    drawDoa(performance.now());
    doa.raf = requestAnimationFrame(tickDoa);
  }

  function updateDoaFromVu(vuDb, vuNorm) {
    for (let i = 0; i < CHANNELS; i++) {
      doa.lastLevels[i] = Math.max(0, Math.min(1, (vuNorm && vuNorm[i]) || 0));
    }
    const est = estimateDoa(vuDb);
    doa.lastDoa = est;
    if (est) pushTrail(est);

    if (el.doaAz) {
      el.doaAz.textContent = est ? `${est.deg.toFixed(0)}°` : "—";
    }
    if (el.doaFocus) {
      el.doaFocus.textContent = est ? `${(est.r * 100).toFixed(0)}%` : "—";
    }
    if (el.doaDom) {
      el.doaDom.textContent = est ? `mic${est.dom + 1}` : "—";
    }
  }

  /* ---------- Spectrogram rows ---------------------------------------- */
  function buildRows() {
    el.channels.innerHTML = "";
    rows.length = 0;
    for (let ch = 0; ch < CHANNELS; ch++) {
      const card = document.createElement("article");
      card.className = "ch";
      card.innerHTML = `
        <div class="ch-meta">
          <div class="ch-id">mic${ch + 1}</div>
          <div class="vu-wrap">
            <div class="vu" title="2 kHz VU"><div class="vu-fill" data-vu></div></div>
            <div class="vu-db" data-db>−∞ dB</div>
            <div class="vu-peak" data-peak></div>
          </div>
        </div>
        <div class="spectro-wrap"><canvas data-spectro width="720" height="120"></canvas></div>
      `;
      el.channels.appendChild(card);
      const canvas = card.querySelector("canvas");
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#020403";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      rows.push({
        canvas,
        ctx,
        fill: card.querySelector("[data-vu]"),
        db: card.querySelector("[data-db]"),
        peak: card.querySelector("[data-peak]"),
        hist: new Uint8Array(HISTORY * BINS),
        gaps: new Uint8Array(HISTORY),
      });
    }
  }

  function paintColumn(row, colU8, isGap) {
    const hist = row.hist;
    hist.copyWithin(0, BINS);
    hist.set(colU8, (HISTORY - 1) * BINS);
    row.gaps.copyWithin(0, 1);
    row.gaps[HISTORY - 1] = isGap ? 1 : 0;
  }

  function flushPaint(row) {
    const { canvas, ctx, hist, gaps } = row;
    const w = canvas.width;
    const h = canvas.height;
    const img = ctx.createImageData(w, h);
    const data = img.data;
    for (let x = 0; x < w; x++) {
      const srcX = Math.floor((x / w) * HISTORY);
      const gap = gaps[srcX];
      for (let y = 0; y < h; y++) {
        const bin = BINS - 1 - Math.floor((y / h) * BINS);
        const v = hist[srcX * BINS + bin];
        const o = (y * w + x) * 4;
        if (gap) {
          const stripe = (y >> 2) & 1;
          data[o] = stripe ? 90 : 40;
          data[o + 1] = 8;
          data[o + 2] = stripe ? 70 : 30;
        } else {
          const l = v * 4;
          data[o] = LUT[l];
          data[o + 1] = LUT[l + 1];
          data[o + 2] = LUT[l + 2];
        }
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function setVu(row, norm, db, peakDb, overloaded) {
    const pct = Math.max(0, Math.min(100, norm * 100));
    row.fill.style.height = pct.toFixed(1) + "%";
    row.fill.classList.toggle("warn", norm > 0.72 || (peakDb != null && peakDb > -6));
    row.fill.classList.toggle("hot", overloaded || (peakDb != null && peakDb > -1));
    row.db.textContent = Number.isFinite(db) ? db.toFixed(1) + " dB" : "−∞ dB";
    if (row.peak) {
      if (overloaded) row.peak.textContent = "CLIP";
      else if (peakDb != null && Number.isFinite(peakDb))
        row.peak.textContent = "pk " + peakDb.toFixed(0);
      else row.peak.textContent = "";
      row.peak.classList.toggle("hot", !!overloaded);
    }
  }

  function b64ToU8(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  let ws = null;
  let meta = { running: false };
  let frameCount = 0;
  let colCount = 0;
  let lastFrameAt = 0;

  function setStatus(text) {
    el.status.textContent = text;
  }

  function setDebug(lines) {
    if (!el.debug) return;
    el.debug.textContent = Array.isArray(lines) ? lines.join("\n") : String(lines || "");
  }

  function renderMetaDebug(m, extra) {
    const parts = [
      `device id=${m.device ?? "?"}  max_ch=${m.device_max_channels ?? "?"}`,
      m.device_name ? `name=${m.device_name}` : null,
      m.recommended_device != null
        ? `recommended=${m.recommended_device} ${m.recommended_name || ""}`
        : null,
      `want_ch=${m.channels ?? CHANNELS}  sr=${m.sample_rate ?? "?"}  running=${!!m.running}`,
      m.last_error ? `last_error=${m.last_error}` : null,
      `frames=${m.frames ?? 0}  blocks=${m.blocks ?? 0}  ovf=${m.overflows ?? 0}  drop=${m.ring_drops ?? 0}`,
      `zeros=${m.zero_blocks ?? 0}  gap_hops=${m.gap_hops ?? 0}  block=${m.blocksize ?? "?"}  lat=${m.latency ?? "?"}`,
      doa.lastDoa
        ? `doa=${doa.lastDoa.deg.toFixed(0)}° focus=${(doa.lastDoa.r * 100).toFixed(0)}% mic${doa.lastDoa.dom + 1}`
        : null,
      m.peak_db ? `peak_db=[${m.peak_db.map((x) => Number(x).toFixed(1)).join(", ")}]` : null,
      extra || null,
    ].filter(Boolean);
    setDebug(parts);
  }

  function setRunning(running) {
    meta.running = !!running;
    el.start.disabled = !!running;
    el.stop.disabled = !running;
    if (running) setStatus("běží");
    else if (meta.last_error) setStatus("chyba — viz debug");
    else setStatus("zastaveno");
  }

  function scoreDevice(d) {
    if (typeof d.score === "number") return d.score;
    let s = 0;
    if (d.channels === 6) s += 120;
    else if (d.channels >= 6) s += 40;
    if (d.is_alsa) s += 40;
    if (d.is_pulse) s -= 50;
    if (d.is_virtual) s -= 80;
    const n = (d.name || "").toLowerCase();
    if (n.includes("hw:")) s += 35;
    if (n.includes("pico") && n.includes("6ch")) s += 50;
    if (n.includes("surround") || n.includes("monitor")) s -= 60;
    return s;
  }

  function formatDevice(d) {
    const host = d.hostapi || "?";
    let label = `[${d.id}] ${d.name} · ${d.channels}ch · ${host}`;
    if (d.recommended) label += " ← DEFAULT";
    else if (d.channels >= 6 && d.is_alsa && !d.is_virtual) label += " ★ ALSA 6ch";
    else if (d.channels < 6 && /surround/i.test(d.name || "")) label += " ✗ Pulse stub";
    else if (d.is_virtual) label += " (virtual)";
    return label;
  }

  async function loadDevices() {
    const r = await fetch("/api/devices", { cache: "no-store" });
    const data = await r.json();
    const devices = data.devices || [];
    el.device.innerHTML = "";

    const optAuto = document.createElement("option");
    optAuto.value = "auto";
    optAuto.textContent = "auto (ALSA Pico 6ch)";
    el.device.appendChild(optAuto);

    const ranked = devices.slice().sort((a, b) => scoreDevice(b) - scoreDevice(a));
    for (const d of ranked) {
      const o = document.createElement("option");
      o.value = String(d.id);
      o.textContent = formatDevice(d);
      o.dataset.channels = String(d.channels);
      el.device.appendChild(o);
    }

    if (data.meta) {
      meta = data.meta;
      setRunning(!!meta.running);
      const pick =
        meta.device != null
          ? String(meta.device)
          : data.recommended_device != null
            ? String(data.recommended_device)
            : null;
      if (pick && [...el.device.options].some((o) => o.value === pick)) {
        el.device.value = pick;
      }
      renderMetaDebug(meta, meta.last_error ? "Tip: zvol ★ ALSA 6ch / ← DEFAULT" : null);
    }
  }

  function selectedDevicePayload() {
    const v = el.device.value;
    if (v === "auto" || v === "default") return { device: "auto" };
    return { device: Number(v) };
  }

  function applyFrame(msg) {
    frameCount += 1;
    lastFrameAt = Date.now();
    if (!meta.running) setRunning(true);

    const shape = msg.shape || [];
    let ncols = 1;
    let chN = CHANNELS;
    let bins = BINS;
    if (shape.length === 3) {
      ncols = shape[0];
      chN = shape[1];
      bins = shape[2];
    } else if (shape.length === 2) {
      chN = shape[0];
      bins = shape[1];
      ncols = msg.ncols || 1;
    }
    const raw = b64ToU8(msg.spectro);
    const colStride = chN * bins;
    const gapFlags = msg.gaps || [];

    for (let n = 0; n < ncols; n++) {
      const base = n * colStride;
      const isGap = !!gapFlags[n];
      for (let ch = 0; ch < Math.min(chN, rows.length); ch++) {
        const col = raw.subarray(base + ch * bins, base + (ch + 1) * bins);
        if (col.length === BINS) paintColumn(rows[ch], col, isGap);
      }
      colCount += 1;
    }
    for (let ch = 0; ch < rows.length; ch++) {
      flushPaint(rows[ch]);
      const n = (msg.vu && msg.vu[ch]) || 0;
      const db = (msg.vu_db && msg.vu_db[ch]) || -90;
      const peak = msg.peak_db ? msg.peak_db[ch] : null;
      const ov = msg.overloaded ? msg.overloaded[ch] : false;
      setVu(rows[ch], n, db, peak, ov);
    }

    // Hexagon DOA from 2 kHz band levels (skip pure digital-zero gaps)
    const gapHeavy = gapFlags.length && gapFlags.filter(Boolean).length > gapFlags.length * 0.6;
    if (!gapHeavy && msg.vu_db) {
      updateDoaFromVu(msg.vu_db, msg.vu);
    }

    const vuLine = (msg.vu_db || [])
      .slice(0, CHANNELS)
      .map((db, i) => `mic${i + 1}=${Number(db).toFixed(1)}`)
      .join(" ");
    const ovAny = (msg.overloaded || []).some(Boolean);
    const gapN = gapFlags.filter(Boolean).length;
    const doaTxt = doa.lastDoa
      ? ` · DOA ${doa.lastDoa.deg.toFixed(0)}° mic${doa.lastDoa.dom + 1}`
      : "";
    el.stats.textContent =
      `cols ${colCount}` +
      ` · +${ncols}/tick` +
      (gapN ? ` · GAP ${gapN}/${ncols}` : "") +
      doaTxt +
      ` · capture ${msg.frames || 0}` +
      (ovAny ? " · CLIP" : "") +
      ` · VU @ ${msg.vu_hz || 2000} Hz`;

    if (frameCount % 8 === 0) {
      renderMetaDebug(
        {
          ...meta,
          running: true,
          frames: msg.frames,
          blocks: msg.blocks,
          overflows: msg.overflows,
          ring_drops: msg.ring_drops,
          zero_blocks: msg.zero_blocks,
          gap_hops: msg.gap_hops,
          peak_db: msg.peak_db,
        },
        vuLine ? `[VU 2kHz] ${vuLine}` : null
      );
    }
  }

  function connectWs() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      setStatus(meta.running ? "běží" : "připojeno");
      if (ws.readyState === 1) ws.send(JSON.stringify({ cmd: "ping" }));
    };
    ws.onclose = () => {
      setStatus("odpojeno — reconnect…");
      setTimeout(connectWs, 1200);
    };
    ws.onerror = () => setStatus("ws chyba");
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "meta" || msg.type === "pong") {
        meta = msg;
        setRunning(!!msg.running);
        if (msg.device != null) {
          const match = [...el.device.options].find((o) => o.value === String(msg.device));
          if (match) el.device.value = String(msg.device);
        }
        renderMetaDebug(meta);
        return;
      }
      if (msg.type === "error") {
        setStatus("chyba: " + msg.message);
        setDebug([`error: ${msg.message}`, "Zvol ALSA ★ / ← DEFAULT a Start."]);
        return;
      }
      if (msg.type !== "frame") return;
      applyFrame(msg);
    };
  }

  el.start.addEventListener("click", () => {
    if (!ws || ws.readyState !== 1) {
      setStatus("ws není připraven");
      return;
    }
    const payload = { cmd: "start", ...selectedDevicePayload() };
    setStatus(`start device=${payload.device}…`);
    setDebug([`sending ${JSON.stringify(payload)}`, "čekám na meta / frame…"]);
    frameCount = 0;
    colCount = 0;
    ws.send(JSON.stringify(payload));
  });

  el.stop.addEventListener("click", () => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ cmd: "stop" }));
  });

  if (el.clearTrail) el.clearTrail.addEventListener("click", clearTrail);

  el.device.addEventListener("change", () => {
    const opt = el.device.selectedOptions[0];
    const ch = opt && opt.dataset.channels ? Number(opt.dataset.channels) : null;
    if (ch != null && ch < 6) {
      setStatus(`varování: zařízení má jen ${ch} ch — potřeba 6`);
    } else {
      setStatus(`vybráno ${el.device.value} — Start otevře stream`);
    }
  });

  setInterval(() => {
    if (meta.running && lastFrameAt && Date.now() - lastFrameAt > 2500) {
      setStatus("běží, ale žádné frame — zkontroluj stdout / zařízení");
    }
  }, 1000);

  buildRows();
  drawDoa(performance.now());
  doa.raf = requestAnimationFrame(tickDoa);
  loadDevices().catch((e) => {
    setStatus(String(e));
    setDebug(String(e));
  });
  connectWs();
})();
