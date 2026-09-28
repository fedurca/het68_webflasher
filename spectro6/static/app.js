(() => {
  const CHANNELS = 6;
  const BINS = 256;
  const HISTORY = 360;
  const VU_HIST = 120; // scrolling VU trajectory samples per mic
  const TRAIL_MAX = 180;
  const TRAIL_FADE_MS = 14000;
  // Face normals of the vertex-down cube, same order as MIC_DIR in het68 doa.c.
  // Mic 1 is north (+X), azimuth 0°, elevation +35.26°.
  const MIC_DIR = [
    [0.8165, 0, 0.57735],
    [-0.40825, 0.70711, 0.57735],
    [-0.40825, -0.70711, 0.57735],
    [-0.8165, 0, -0.57735],
    [0.40825, -0.70711, -0.57735],
    [0.40825, 0.70711, -0.57735],
  ];
  const CUBE_FACE_TRIPLES = [
    [0, 1, 2], [0, 1, 5], [0, 2, 4], [0, 4, 5],
    [1, 2, 3], [1, 3, 5], [2, 3, 4], [3, 4, 5],
  ];

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
    doaEl: document.querySelector("#doaReadout [data-el]"),
    doaSrc: document.querySelector("#doaReadout [data-src]"),
    doaTrail: document.querySelector("#doaReadout [data-trail]"),
    grid: document.getElementById("chkGrid"),
    btnViewReset: document.getElementById("btnViewReset"),
    btnSilence: document.getElementById("btnSilence"),
    btnClearGain: document.getElementById("btnClearGain"),
    gainLine: document.getElementById("gainLine"),
    btnCalibStart: document.getElementById("btnCalibStart"),
    btnCalibStop: document.getElementById("btnCalibStop"),
    btnCalibDown: document.getElementById("btnCalibDown"),
    btnCalibReset: document.getElementById("btnCalibReset"),
    calibName: document.getElementById("calibName"),
    calibLog: document.getElementById("calibLog"),
    serialPort: document.getElementById("serialPort"),
    serialOpen: document.getElementById("btnSerialOpen"),
    serialClose: document.getElementById("btnSerialClose"),
    syncTime: document.getElementById("btnSyncTime"),
    serialStatus: document.getElementById("serialStatus"),
    detList: document.getElementById("detList"),
    serialLog: document.getElementById("serialLog"),
  };

  /** @type {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, vuCanvas: HTMLCanvasElement, vuCtx: CanvasRenderingContext2D, fill: HTMLElement, db: HTMLElement, peak: HTMLElement, hist: Uint8Array, gaps: Uint8Array, vuTrail: Float32Array }[]} */
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

  /* ---------- Detection cube (vertex down, 128 mm) ---------------- */
  function unitSum(idx) {
    const s = [0, 0, 0];
    for (const i of idx) {
      s[0] += MIC_DIR[i][0];
      s[1] += MIC_DIR[i][1];
      s[2] += MIC_DIR[i][2];
    }
    const n = Math.hypot(s[0], s[1], s[2]) || 1;
    return [s[0] / n, s[1] / n, s[2] / n];
  }
  const CUBE_VERTS = CUBE_FACE_TRIPLES.map(unitSum);
  const CUBE_EDGES = [];
  for (let i = 0; i < CUBE_FACE_TRIPLES.length; i++) {
    for (let j = i + 1; j < CUBE_FACE_TRIPLES.length; j++) {
      let share = 0;
      for (const a of CUBE_FACE_TRIPLES[i]) {
        if (CUBE_FACE_TRIPLES[j].includes(a)) share++;
      }
      if (share === 2) CUBE_EDGES.push([i, j]);
    }
  }
  const FACE_SCALE = 1 / Math.sqrt(3);

  const doa = {
    trail: /** @type {{ x: number, y: number, z: number, t: number, s: number }[]} */ ([]),
    lastLevels: new Array(CHANNELS).fill(0),
    vuEst: /** @type {null | { dir: number[], az: number, el: number, strength: number, dom: number }} */ (null),
    firmware: /** @type {null | { az: number, el: number, conf: number, pos: string, t: number }} */ (null),
    raf: 0,
  };

  function dirFromAzEl(azDeg, elDeg) {
    const az = (azDeg * Math.PI) / 180;
    const el = (elDeg * Math.PI) / 180;
    return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
  }

  function azElFromDir(d) {
    const az = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
    const el = (Math.atan2(d[2], Math.hypot(d[0], d[1])) * 180) / Math.PI;
    return { az: (az + 360) % 360, el };
  }

  function estimateDoa(vuDb) {
    if (!vuDb || vuDb.length < CHANNELS) return null;
    const powers = [];
    let sum = 0;
    let dom = 0;
    const acc = [0, 0, 0];
    for (let i = 0; i < CHANNELS; i++) {
      const p = Math.pow(10, Math.max(Number(vuDb[i]), -90) / 10);
      powers.push(p);
      sum += p;
      if (p > powers[dom]) dom = i;
      acc[0] += p * MIC_DIR[i][0];
      acc[1] += p * MIC_DIR[i][1];
      acc[2] += p * MIC_DIR[i][2];
    }
    if (sum < 1e-14) return null;
    const mag = Math.hypot(acc[0], acc[1], acc[2]);
    if (mag < 1e-12) return null;
    const dir = [acc[0] / mag, acc[1] / mag, acc[2] / mag];
    const ang = azElFromDir(dir);
    const meanDb = vuDb.reduce((a, b) => a + Number(b), 0) / CHANNELS;
    const strength = Math.max(0, Math.min(1, (meanDb + 70) / 55));
    if (strength < 0.08 && mag / sum < 0.12) return null;
    return { dir, az: ang.az, el: ang.el, strength, dom };
  }

  function activeFix(now) {
    const fw = doa.firmware;
    if (fw && now - fw.t < 2500 && fw.pos === "tdoa" && fw.conf >= 0.28) {
      return {
        dir: dirFromAzEl(fw.az, fw.el),
        az: fw.az,
        el: fw.el,
        strength: Math.max(0.4, Math.min(1, fw.conf)),
        source: "TDOA",
      };
    }
    if (doa.vuEst) {
      return { ...doa.vuEst, source: "VU" };
    }
    if (fw && now - fw.t < 2500) {
      return { dir: null, az: fw.az, el: fw.el, strength: 0, source: "pásmo" };
    }
    return null;
  }

  function noteFirmwareFix(det) {
    if (!det || !Number.isFinite(Number(det.azimuthDeg))) return;
    const pos = det.extra && det.extra.pos ? String(det.extra.pos) : "";
    doa.firmware = {
      az: Number(det.azimuthDeg),
      el: Number.isFinite(Number(det.elevationDeg)) ? Number(det.elevationDeg) : 0,
      conf: Number(det.confidence) || 0,
      pos,
      t: performance.now(),
    };
  }

  function pushTrail(dir, strength) {
    if (!dir) return;
    const now = performance.now();
    const last = doa.trail[doa.trail.length - 1];
    if (last && Math.hypot(dir[0] - last.x, dir[1] - last.y, dir[2] - last.z) < 0.03 && now - last.t < 40) {
      last.t = now;
      last.s = Math.max(last.s, strength);
      return;
    }
    doa.trail.push({ x: dir[0], y: dir[1], z: dir[2], t: now, s: strength });
    while (doa.trail.length > TRAIL_MAX) doa.trail.shift();
  }

  function clearTrail() {
    doa.trail.length = 0;
    if (el.doaTrail) el.doaTrail.textContent = "0";
    for (const row of rows) {
      row.vuTrail.fill(0);
      paintVuHist(row);
    }
    drawDoa(performance.now());
  }

  function project(p, cx, cy, R) {
    const yaw = -0.6;
    const pitch = 0.55;
    const x0 = p[0];
    const y0 = p[1];
    const z0 = p[2];
    const cyaw = Math.cos(yaw);
    const syaw = Math.sin(yaw);
    const x1 = cyaw * x0 - syaw * y0;
    const y1 = syaw * x0 + cyaw * y0;
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const y2 = cp * y1 + sp * z0;
    const z2 = -sp * y1 + cp * z0;
    const depth = 3.1 + y2;
    const s = (R * 1.35) / depth;
    return { x: cx + x1 * s, y: cy - z2 * s, depth: y2 };
  }

  let cubeView = null;
  function ensureCube() {
    if (cubeView || !el.doaCanvas || !window.Het68Cube) return cubeView;
    cubeView = window.Het68Cube.attach(el.doaCanvas);
    return cubeView;
  }

  function drawDoa(now) {
    const fix = activeFix(now);
    const alive = [];
    if (fix && fix.dir) {
      for (const pt of doa.trail) {
        if (now - pt.t <= TRAIL_FADE_MS) alive.push(pt);
      }
    }
    doa.trail = alive;
    const view = ensureCube();
    const grid = el.grid ? el.grid.checked : true;
    if (view) {
      const trail = alive.map((pt) => view.place(pt.dir || [pt.x, pt.y, pt.z]));
      const drone = fix && fix.dir ? view.place(fix.dir) : null;
      view.frame({ grid, levels: doa.lastLevels, trail, drone });
    }
    if (el.doaTrail) el.doaTrail.textContent = String(alive.length);
    if (el.doaAz) el.doaAz.textContent = fix ? `${fix.az.toFixed(0)}°` : "—";
    if (el.doaEl) el.doaEl.textContent = fix ? `${fix.el.toFixed(0)}°` : "—";
    if (el.doaSrc) el.doaSrc.textContent = fix ? fix.source : "—";
  }

  function tickDoa() {
    drawDoa(performance.now());
    doa.raf = requestAnimationFrame(tickDoa);
  }

  function updateDoaFromVu(vuDb, vuNorm) {
    for (let i = 0; i < CHANNELS; i++) {
      doa.lastLevels[i] = Math.max(0, Math.min(1, (vuNorm && vuNorm[i]) || 0));
    }
    doa.vuEst = estimateDoa(vuDb);
    const fix = activeFix(performance.now());
    if (fix && fix.dir && fix.source === "VU") pushTrail(fix.dir, fix.strength);
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
            <div class="vu-db" data-db>−∞</div>
            <div class="vu-peak" data-peak></div>
          </div>
        </div>
        <div class="vu-hist-wrap" title="VU historie (trail)"><canvas data-vuhist width="320" height="72"></canvas></div>
        <div class="spectro-wrap"><canvas data-spectro width="960" height="72"></canvas></div>
      `;
      el.channels.appendChild(card);
      const canvas = card.querySelector("[data-spectro]");
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#020403";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const vuCanvas = card.querySelector("[data-vuhist]");
      const vuCtx = vuCanvas.getContext("2d", { alpha: false });
      vuCtx.fillStyle = "#020403";
      vuCtx.fillRect(0, 0, vuCanvas.width, vuCanvas.height);
      rows.push({
        canvas,
        ctx,
        vuCanvas,
        vuCtx,
        fill: card.querySelector("[data-vu]"),
        db: card.querySelector("[data-db]"),
        peak: card.querySelector("[data-peak]"),
        hist: new Uint8Array(HISTORY * BINS),
        gaps: new Uint8Array(HISTORY),
        vuTrail: new Float32Array(VU_HIST),
      });
    }
  }

  function paintVuHist(row) {
    const { vuCanvas, vuCtx, vuTrail } = row;
    const w = vuCanvas.width;
    const h = vuCanvas.height;
    vuCtx.fillStyle = "#020403";
    vuCtx.fillRect(0, 0, w, h);
    // baseline
    vuCtx.strokeStyle = "rgba(148,163,184,0.12)";
    vuCtx.beginPath();
    vuCtx.moveTo(0, h - 1);
    vuCtx.lineTo(w, h - 1);
    vuCtx.stroke();

    const n = vuTrail.length;
    // filled area under curve (fading toward the left = older)
    vuCtx.beginPath();
    vuCtx.moveTo(0, h);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (w - 1);
      const v = vuTrail[i];
      const y = h - 1 - v * (h - 2);
      if (i === 0) vuCtx.lineTo(x, y);
      else vuCtx.lineTo(x, y);
    }
    vuCtx.lineTo(w - 1, h);
    vuCtx.closePath();
    const grad = vuCtx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "rgba(8,104,33,0.05)");
    grad.addColorStop(0.55, "rgba(8,104,33,0.25)");
    grad.addColorStop(1, "rgba(26,154,60,0.55)");
    vuCtx.fillStyle = grad;
    vuCtx.fill();

    // bright trailing stroke (newest on the right)
    vuCtx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * (w - 1);
      const y = h - 1 - vuTrail[i] * (h - 2);
      if (i === 0) vuCtx.moveTo(x, y);
      else vuCtx.lineTo(x, y);
    }
    vuCtx.strokeStyle = "rgba(232,240,234,0.65)";
    vuCtx.lineWidth = 1.25;
    vuCtx.stroke();

    // head dot
    const last = vuTrail[n - 1];
    vuCtx.beginPath();
    vuCtx.arc(w - 1, h - 1 - last * (h - 2), 2.2, 0, Math.PI * 2);
    vuCtx.fillStyle = last > 0.88 ? "#c45b4a" : last > 0.72 ? "#d4a017" : "#1a9a3c";
    vuCtx.fill();
  }

  function pushVuHist(row, norm) {
    const t = row.vuTrail;
    t.copyWithin(0, 1);
    t[t.length - 1] = Math.max(0, Math.min(1, norm));
    paintVuHist(row);
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
    row.db.textContent = Number.isFinite(db) ? db.toFixed(1) : "−∞";
    if (row.peak) {
      if (overloaded) row.peak.textContent = "CLIP";
      else if (peakDb != null && Number.isFinite(peakDb))
        row.peak.textContent = "pk " + peakDb.toFixed(0);
      else row.peak.textContent = "";
      row.peak.classList.toggle("hot", !!overloaded);
    }
    pushVuHist(row, norm);
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
  const detItems = [];
  const MAX_DETS_UI = 40;
  const MAX_LOG_UI = 80;

  function setSerialStatus(st) {
    if (!el.serialStatus) return;
    const on = !!(st && st.connected);
    el.serialStatus.textContent = on
      ? `on ${st.port || ""}`
      : st && st.last_error
        ? "err"
        : "off";
    el.serialStatus.classList.toggle("on", on);
    if (el.serialOpen) el.serialOpen.disabled = on;
    if (el.serialClose) el.serialClose.disabled = !on;
    if (el.syncTime) el.syncTime.disabled = !on;
  }

  function appendSerialLog(text, kind) {
    if (!el.serialLog) return;
    const line = document.createElement("div");
    if (kind === "tx") line.className = "tx";
    if (kind === "err") line.className = "err";
    line.textContent = text;
    el.serialLog.appendChild(line);
    while (el.serialLog.childNodes.length > MAX_LOG_UI) {
      el.serialLog.removeChild(el.serialLog.firstChild);
    }
    el.serialLog.scrollTop = el.serialLog.scrollHeight;
  }

  function prependDetection(det) {
    if (!el.detList || !det) return;
    detItems.unshift(det);
    while (detItems.length > MAX_DETS_UI) detItems.pop();
    const az =
      det.azimuthDeg != null && Number.isFinite(Number(det.azimuthDeg))
        ? Number(det.azimuthDeg).toFixed(1) + "°"
        : "—";
    const conf =
      det.confidence != null && Number.isFinite(Number(det.confidence))
        ? (Number(det.confidence) * 100).toFixed(0) + "%"
        : "";
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="az">${az}</span> ` +
      `<span class="cls">${det.class || "?"}</span> ` +
      `<span class="meta">${conf}</span> ` +
      `<span class="meta">${(det.observedAtHost || "").split("T")[1] || ""}</span>`;
    el.detList.insertBefore(li, el.detList.firstChild);
    while (el.detList.children.length > MAX_DETS_UI) {
      el.detList.removeChild(el.detList.lastChild);
    }
  }

  async function loadSerialPorts() {
    if (!el.serialPort) return;
    try {
      const r = await fetch("/api/serial/ports", { cache: "no-store" });
      const data = await r.json();
      el.serialPort.innerHTML = "";
      const ports = data.ports || [];
      if (!ports.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = data.status && !data.status.pyserial
          ? "pip install pyserial"
          : "žádný port";
        el.serialPort.appendChild(o);
      } else {
        for (const p of ports) {
          const o = document.createElement("option");
          o.value = p.device;
          o.textContent =
            (p.recommended ? "★ " : "") +
            p.device +
            (p.description ? " · " + p.description : "");
          el.serialPort.appendChild(o);
        }
        const rec = ports.find((p) => p.recommended);
        if (rec) el.serialPort.value = rec.device;
      }
      setSerialStatus(data.status || {});
    } catch (e) {
      appendSerialLog(String(e), "err");
    }
  }

  function setStatus(text) {
    el.status.textContent = text;
  }

  function setDebug(lines) {
    if (!el.debug) return;
    const text = Array.isArray(lines) ? lines.join(" · ") : String(lines || "");
    el.debug.textContent = text.replace(/\n+/g, " · ");
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
      (() => {
        const fix = activeFix(performance.now());
        return fix ? `doa=${fix.source} ${fix.az.toFixed(0)}/${fix.el.toFixed(0)}` : null;
      })(),
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

    // Cube DOA from 2 kHz band levels (skip pure digital-zero gaps)
    const gapHeavy = gapFlags.length && gapFlags.filter(Boolean).length > gapFlags.length * 0.6;
    if (!gapHeavy && msg.vu_db) {
      updateDoaFromVu(msg.vu_db, msg.vu);
    }
    if (msg.gain_db) renderGains(msg.gain_db);
    if (msg.calib) renderCalib(msg.calib);
    if (el.btnSilence) el.btnSilence.disabled = !!msg.silence_busy;

    const vuLine = (msg.vu_db || [])
      .slice(0, CHANNELS)
      .map((db, i) => `mic${i + 1}=${Number(db).toFixed(1)}`)
      .join(" ");
    const ovAny = (msg.overloaded || []).some(Boolean);
    const gapN = gapFlags.filter(Boolean).length;
    const fixNow = activeFix(performance.now());
    const doaTxt = fixNow
      ? ` · ${fixNow.source} ${fixNow.az.toFixed(0)}°/${fixNow.el.toFixed(0)}°`
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
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ cmd: "ping" }));
        const saved = localStorage.getItem("het68-gain-db");
        if (saved) {
          try {
            ws.send(JSON.stringify({ cmd: "calib_set_gains", gain_db: JSON.parse(saved) }));
          } catch { /* ignore stale storage */ }
        }
      }
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
        if (msg.serial) setSerialStatus(msg.serial);
        if (msg.device != null) {
          const match = [...el.device.options].find((o) => o.value === String(msg.device));
          if (match) el.device.value = String(msg.device);
        }
        renderMetaDebug(meta);
        return;
      }
      if (msg.type === "serial_status" || msg.type === "serial_sync_ok") {
        setSerialStatus(msg);
        if (msg.type === "serial_sync_ok") {
          appendSerialLog(`sync OK → ${msg.command}`, "tx");
          setStatus("čas sync " + (msg.epochMs || ""));
        }
        return;
      }
      if (msg.type === "serial_snapshot") {
        if (msg.status) setSerialStatus(msg.status);
        if (el.detList) el.detList.innerHTML = "";
        detItems.length = 0;
        (msg.detections || []).slice().reverse().forEach(prependDetection);
        if (el.serialLog) el.serialLog.innerHTML = "";
        (msg.lines || []).forEach((ln) => appendSerialLog(ln.text, ln.kind));
        return;
      }
      if (msg.type === "serial_line") {
        appendSerialLog(msg.text, msg.kind || "rx");
        return;
      }
      if (msg.type === "detection") {
        prependDetection(msg.detection);
        noteFirmwareFix(msg.detection);
        const fix = activeFix(performance.now());
        if (fix && fix.dir && fix.source === "TDOA") pushTrail(fix.dir, fix.strength);
        return;
      }
      if (msg.type === "serial_ports") {
        // refresh dropdown if server pushed
        loadSerialPorts();
        return;
      }
      if (msg.type === "silence_done") {
        renderGains(msg.gain_db);
        if (el.btnSilence) el.btnSilence.disabled = false;
        setStatus(msg.cleared ? "kompenzace vypnuta" : "ticho nastaveno");
        return;
      }
      if (msg.type === "calib") {
        renderCalib(msg);
        return;
      }
      if (msg.type === "error") {
        setStatus("chyba: " + msg.message);
        setDebug([`error: ${msg.message}`, "Zvol ALSA ★ / ← DEFAULT a Start."]);
        appendSerialLog(msg.message, "err");
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

  if (el.serialOpen) {
    el.serialOpen.addEventListener("click", () => {
      if (!ws || ws.readyState !== 1) return;
      const port = el.serialPort && el.serialPort.value;
      if (!port) {
        setStatus("vyber serial port");
        return;
      }
      ws.send(JSON.stringify({ cmd: "serial_open", port, baud: 115200 }));
      setStatus("serial open " + port);
    });
  }
  if (el.serialClose) {
    el.serialClose.addEventListener("click", () => {
      if (!ws || ws.readyState !== 1) return;
      ws.send(JSON.stringify({ cmd: "serial_close" }));
    });
  }
  if (el.syncTime) {
    el.syncTime.addEventListener("click", () => {
      if (!ws || ws.readyState !== 1) return;
      const epochMs = Date.now();
      ws.send(JSON.stringify({ cmd: "serial_sync_time", epochMs }));
      appendSerialLog(`TIME ${epochMs}`, "tx");
      setStatus("sync čas → device");
    });
  }

  const PHASE_TEXT = {
    circle1: "Kruh ve vzdálenosti 1 m, výška 1 m, po směru hodin.",
    climb: "Před mic1 výstup na 3 m.",
    circle3: "Kruh ve vzdálenosti 1 m, výška 3 m, po směru hodin.",
    land: "Sestup z 3 m a přistání před mic1.",
  };

  function wsSend(payload) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify(payload));
  }

  function renderGains(gainDb) {
    if (!el.gainLine || !gainDb) return;
    const key = gainDb.map((g) => Number(g).toFixed(2)).join(",");
    if (el.gainLine.dataset.key === key) return;
    el.gainLine.dataset.key = key;
    const idle = gainDb.every((g) => Math.abs(Number(g)) < 0.05);
    el.gainLine.textContent = idle
      ? "bez kompenzace"
      : gainDb.map((g, i) => `m${i + 1} ${Number(g) >= 0 ? "+" : ""}${Number(g).toFixed(1)} dB`).join("  ");
    if (!idle) localStorage.setItem("het68-gain-db", JSON.stringify(gainDb));
    else localStorage.removeItem("het68-gain-db");
  }

  function renderCalib(st) {
    if (!st) return;
    const recording = !!st.recording;
    if (el.btnCalibStart) el.btnCalibStart.disabled = recording;
    if (el.btnCalibStop) el.btnCalibStop.disabled = !recording;
    if (el.btnCalibDown) el.btnCalibDown.disabled = !st.ready;
    if (el.btnCalibReset) el.btnCalibReset.disabled = recording || (!st.name && !(st.log || []).length);
    document.querySelectorAll(".phase").forEach((btn) => { btn.disabled = !recording; });
    if (el.calibName) {
      el.calibName.textContent = st.name
        ? `${st.name} · ${Number(st.seconds || 0).toFixed(1)} s`
        : "";
    }
    if (el.calibLog && Array.isArray(st.log)) {
      const stamp = st.log.map((row) => row.t + row.text).join("|");
      if (el.calibLog.dataset.stamp !== stamp) {
        el.calibLog.dataset.stamp = stamp;
        el.calibLog.innerHTML = "";
        for (const row of st.log) {
          const li = document.createElement("li");
          li.textContent = `${row.t}  ${row.text}`;
          el.calibLog.appendChild(li);
        }
      }
    }
  }

  if (el.btnViewReset) {
    el.btnViewReset.addEventListener("click", () => {
      if (cubeView) cubeView.reset();
    });
  }
  if (el.btnSilence) {
    el.btnSilence.addEventListener("click", () => {
      wsSend({ cmd: "calib_silence" });
      el.btnSilence.disabled = true;
      setStatus("měřím ticho…");
    });
  }
  if (el.btnClearGain) {
    el.btnClearGain.addEventListener("click", () => wsSend({ cmd: "calib_clear_gains" }));
  }
  if (el.btnCalibStart) {
    el.btnCalibStart.addEventListener("click", () => wsSend({ cmd: "calib_start" }));
  }
  if (el.btnCalibStop) {
    el.btnCalibStop.addEventListener("click", () => wsSend({ cmd: "calib_stop" }));
  }
  if (el.btnCalibReset) {
    el.btnCalibReset.addEventListener("click", () => wsSend({ cmd: "calib_reset" }));
  }
  if (el.btnCalibDown) {
    el.btnCalibDown.addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = "/api/calib/wav";
      a.click();
    });
  }
  document.querySelectorAll(".phase").forEach((btn) => {
    btn.addEventListener("click", () => {
      const phase = btn.dataset.phase;
      wsSend({ cmd: "calib_mark", phase, text: PHASE_TEXT[phase] || phase });
    });
  });

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
  loadSerialPorts();
  connectWs();
})();
