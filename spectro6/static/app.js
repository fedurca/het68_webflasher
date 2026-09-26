(() => {
  const CHANNELS = 6;
  const BINS = 256;
  const HISTORY = 480;

  const el = {
    device: document.getElementById("device"),
    start: document.getElementById("btnStart"),
    stop: document.getElementById("btnStop"),
    status: document.getElementById("status"),
    channels: document.getElementById("channels"),
    stats: document.getElementById("stats"),
    debug: document.getElementById("debug"),
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
          // Magenta stripe = digital-zero USB gap (not quiet ambient)
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
      m.peak_db ? `peak_db=[${m.peak_db.map((x) => Number(x).toFixed(1)).join(", ")}]` : null,
      m.clips_total ? `clips_total=[${m.clips_total.join(", ")}]` : null,
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

    const vuLine = (msg.vu_db || [])
      .slice(0, CHANNELS)
      .map((db, i) => `mic${i + 1}=${Number(db).toFixed(1)}`)
      .join(" ");
    const ovAny = (msg.overloaded || []).some(Boolean);
    const gapN = gapFlags.filter(Boolean).length;
    el.stats.textContent =
      `cols ${colCount}` +
      ` · +${ncols}/tick` +
      (gapN ? ` · GAP ${gapN}/${ncols}` : "") +
      (msg.zero_ratio ? ` · zero ${(msg.zero_ratio * 100).toFixed(0)}%` : "") +
      ` · capture ${msg.frames || 0}` +
      (msg.overflows ? ` · ovf ${msg.overflows}` : "") +
      (msg.ring_drops ? ` · drop ${msg.ring_drops}` : "") +
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
  loadDevices().catch((e) => {
    setStatus(String(e));
    setDebug(String(e));
  });
  connectWs();
})();
