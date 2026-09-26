(() => {
  const CHANNELS = 6;
  const BINS = 256;
  const HISTORY = 320; // scrolling spectrogram columns

  const el = {
    device: document.getElementById("device"),
    start: document.getElementById("btnStart"),
    stop: document.getElementById("btnStop"),
    status: document.getElementById("status"),
    channels: document.getElementById("channels"),
    stats: document.getElementById("stats"),
    debug: document.getElementById("debug"),
  };

  /** @type {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, fill: HTMLElement, db: HTMLElement, hist: Uint8Array }[]} */
  const rows = [];

  // Green heat map: dark → #086821 → bright crest
  const LUT = (() => {
    const t = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      const u = i / 255;
      const r = Math.round(2 + u * u * 40);
      const g = Math.round(8 + u * 180);
      const b = Math.round(4 + u * 50);
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
          </div>
        </div>
        <div class="spectro-wrap"><canvas data-spectro width="640" height="120"></canvas></div>
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
        hist: new Uint8Array(HISTORY * BINS),
      });
    }
  }

  function paintColumn(row, colU8) {
    const hist = row.hist;
    hist.copyWithin(0, BINS);
    hist.set(colU8, (HISTORY - 1) * BINS);

    const { canvas, ctx } = row;
    const w = canvas.width;
    const h = canvas.height;
    const img = ctx.createImageData(w, h);
    const data = img.data;
    for (let x = 0; x < w; x++) {
      const srcX = Math.floor((x / w) * HISTORY);
      for (let y = 0; y < h; y++) {
        const bin = BINS - 1 - Math.floor((y / h) * BINS);
        const v = hist[srcX * BINS + bin];
        const o = (y * w + x) * 4;
        const l = v * 4;
        data[o] = LUT[l];
        data[o + 1] = LUT[l + 1];
        data[o + 2] = LUT[l + 2];
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function setVu(row, norm, db) {
    const pct = Math.max(0, Math.min(100, norm * 100));
    row.fill.style.height = pct.toFixed(1) + "%";
    row.fill.classList.toggle("warn", norm > 0.72);
    row.fill.classList.toggle("hot", norm > 0.88);
    row.db.textContent = Number.isFinite(db) ? db.toFixed(1) + " dB" : "−∞ dB";
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
      `want_ch=${m.channels ?? CHANNELS}  sr=${m.sample_rate ?? "?"}  running=${!!m.running}`,
      m.last_error ? `last_error=${m.last_error}` : null,
      `frames=${m.frames ?? 0}  blocks=${m.blocks ?? 0}  overflows=${m.overflows ?? 0}`,
      extra || null,
    ].filter(Boolean);
    setDebug(parts);
  }

  function setRunning(running) {
    meta.running = running;
    el.start.disabled = running;
    el.stop.disabled = !running;
    if (running) setStatus("běží");
    else if (meta.last_error) setStatus("chyba — viz debug");
    else setStatus("zastaveno");
  }

  function scoreDevice(d) {
    let s = 0;
    if (d.channels >= 6) s += 100;
    if (d.is_alsa) s += 30;
    if (d.is_pulse) s -= 20;
    const n = (d.name || "").toLowerCase();
    if (n.includes("hw:") || n.includes("usb audio")) s += 20;
    if (n.includes("6ch") || n.includes("pico")) s += 15;
    if (n.includes("surround") || n.includes("monitor")) s -= 40;
    return s;
  }

  function formatDevice(d) {
    const host = d.hostapi || "?";
    let label = `[${d.id}] ${d.name} · ${d.channels}ch · ${host} · ${Math.round(d.default_sr)} Hz`;
    if (d.channels >= 6 && d.is_alsa) label += " ★ ALSA 6ch";
    else if (d.channels < 6 && /surround/i.test(d.name || "")) label += " ✗ Pulse stub";
    else if (d.channels >= 6) label += " ★";
    return label;
  }

  async function loadDevices() {
    const r = await fetch("/api/devices");
    const data = await r.json();
    const devices = data.devices || [];
    el.device.innerHTML = "";

    const optAuto = document.createElement("option");
    optAuto.value = "auto";
    optAuto.textContent = "auto (prefer ALSA 6ch)";
    el.device.appendChild(optAuto);

    const ranked = devices.slice().sort((a, b) => scoreDevice(b) - scoreDevice(a));
    for (const d of ranked) {
      const o = document.createElement("option");
      o.value = String(d.id);
      o.textContent = formatDevice(d);
      o.dataset.channels = String(d.channels);
      if (d.channels < 6) o.classList.add("weak");
      el.device.appendChild(o);
    }

    if (data.meta) {
      meta = data.meta;
      setRunning(!!meta.running);
      if (meta.device != null) {
        const match = [...el.device.options].find((o) => o.value === String(meta.device));
        if (match) el.device.value = String(meta.device);
      } else {
        // Preselect best ALSA 6ch when idle
        const best = ranked.find((d) => d.channels >= 6 && d.is_alsa) || ranked.find((d) => d.channels >= 6);
        if (best) el.device.value = String(best.id);
      }
      renderMetaDebug(meta, meta.last_error ? "Tip: zvol ALSA id s CH=6 (★), ne Pulse surround." : null);
    }
  }

  function selectedDevicePayload() {
    const v = el.device.value;
    if (v === "auto" || v === "default") return { device: "auto" };
    return { device: Number(v) };
  }

  function connectWs() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      setStatus(meta.running ? "běží" : "připojeno");
      // Ask backend for fresh meta
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
        setDebug([`error: ${msg.message}`, "Zvol ALSA zařízení s 6 kanály (★ ALSA 6ch) a Start znovu."]);
        return;
      }
      if (msg.type !== "frame") return;
      frameCount += 1;
      lastFrameAt = Date.now();
      const [chN, bins] = msg.shape || [CHANNELS, BINS];
      const raw = b64ToU8(msg.spectro);
      for (let ch = 0; ch < Math.min(chN, rows.length); ch++) {
        const col = raw.subarray(ch * bins, (ch + 1) * bins);
        if (col.length === BINS) paintColumn(rows[ch], col);
        const n = (msg.vu && msg.vu[ch]) || 0;
        const db = (msg.vu_db && msg.vu_db[ch]) || -90;
        setVu(rows[ch], n, db);
      }
      const vuLine = (msg.vu_db || [])
        .slice(0, CHANNELS)
        .map((db, i) => `mic${i + 1}=${Number(db).toFixed(1)}`)
        .join("  ");
      el.stats.textContent =
        `ui_frames ${frameCount}` +
        ` · capture ${msg.frames || 0}` +
        (msg.overflows ? ` · overflow ${msg.overflows}` : "") +
        ` · VU @ ${msg.vu_hz || 2000} Hz`;
      if (frameCount % 10 === 0) {
        renderMetaDebug(
          {
            ...meta,
            frames: msg.frames,
            blocks: msg.blocks,
            overflows: msg.overflows,
            running: true,
          },
          vuLine ? `[VU 2kHz] ${vuLine}` : null
        );
      }
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

  // Stale-frame watchdog
  setInterval(() => {
    if (meta.running && lastFrameAt && Date.now() - lastFrameAt > 2500) {
      setStatus("běží, ale žádné frame — zkontroluj zařízení / stdout");
    }
  }, 1000);

  buildRows();
  loadDevices().catch((e) => {
    setStatus(String(e));
    setDebug(String(e));
  });
  connectWs();
})();
