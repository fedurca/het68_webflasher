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
          <div class="ch-id">CH${ch}</div>
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
    // shift history left by one column
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
        // y=0 top = high freq
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

  function setStatus(text) {
    el.status.textContent = text;
  }

  function setRunning(running) {
    meta.running = running;
    el.start.disabled = running;
    el.stop.disabled = !running;
    setStatus(running ? "běží" : "zastaveno");
  }

  async function loadDevices() {
    const r = await fetch("/api/devices");
    const data = await r.json();
    el.device.innerHTML = "";
    const optDef = document.createElement("option");
    optDef.value = "default";
    optDef.textContent = "Výchozí vstup";
    el.device.appendChild(optDef);
    for (const d of data.devices || []) {
      const o = document.createElement("option");
      o.value = String(d.id);
      o.textContent = `[${d.id}] ${d.name} · ${d.channels}ch · ${Math.round(d.default_sr)} Hz`;
      if (d.channels >= 6) o.textContent += " ★";
      el.device.appendChild(o);
    }
    if (data.meta) {
      meta = data.meta;
      setRunning(!!meta.running);
      if (meta.device != null) el.device.value = String(meta.device);
    }
  }

  function connectWs() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => setStatus(meta.running ? "běží" : "připojeno");
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
      if (msg.type === "meta") {
        meta = msg;
        setRunning(!!msg.running);
        return;
      }
      if (msg.type === "error") {
        setStatus("chyba: " + msg.message);
        return;
      }
      if (msg.type !== "frame") return;
      const [chN, bins] = msg.shape || [CHANNELS, BINS];
      const raw = b64ToU8(msg.spectro);
      for (let ch = 0; ch < Math.min(chN, rows.length); ch++) {
        const col = raw.subarray(ch * bins, (ch + 1) * bins);
        if (col.length === BINS) paintColumn(rows[ch], col);
        const n = (msg.vu && msg.vu[ch]) || 0;
        const db = (msg.vu_db && msg.vu_db[ch]) || -90;
        setVu(rows[ch], n, db);
      }
      el.stats.textContent =
        `frames ${msg.frames || 0}` +
        (msg.overflows ? ` · overflow ${msg.overflows}` : "") +
        ` · VU @ ${msg.vu_hz || 2000} Hz`;
    };
  }

  el.start.addEventListener("click", () => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ cmd: "start" }));
  });
  el.stop.addEventListener("click", () => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ cmd: "stop" }));
  });

  // Device change requires process restart with --device; show hint
  el.device.addEventListener("change", () => {
    const v = el.device.value;
    setStatus(
      v === "default"
        ? "výchozí zařízení — restart: python app.py"
        : `zařízení ${v} — restart: python app.py --device ${v}`
    );
  });

  buildRows();
  loadDevices().catch((e) => setStatus(String(e)));
  connectWs();
})();
