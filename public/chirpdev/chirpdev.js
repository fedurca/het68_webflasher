/**
 * het68 chirpdev — link tuning playground.
 *
 * - Spectrogram with ~10 MB PCM window (clear + save WAV)
 * - 10-slot persistent memory bank via Durable Object
 * - Parameter sweep + shared config / node map
 */
(function () {
  "use strict";
  var alinkReady = typeof ALINK !== "undefined";
  if (!alinkReady) {
    var pw0 = document.getElementById("permWarn");
    if (pw0) {
      pw0.hidden = false;
      pw0.textContent = "ALINK modem se nenačetl — spektrogram půjde, dekódování ne.";
    }
  }

  var THEME_KEY = "het68-theme";
  var WAV_MAX_BYTES = 10 * 1024 * 1024; // ~10 MB Int16 PCM ring
  var CHUNK_RAW_BYTES = 900 * 1024; // keep base64 well under DO 2 MB/value
  var SPEC_FMIN = 0;
  var SPEC_FMAX = 8000; // phone-band focus
  var SPEC_DB_MIN = -100;
  var SPEC_DB_MAX = -20;
  var SPEC_PAD = { l: 54, r: 14, t: 18, b: 36 };
  var SPEC_CAP_MIN = 2000;
  var SPEC_CAP_MAX = 12000;
  var SPEC_ZOOM_STEPS = [0.25, 0.5, 1, 2, 4, 8, 16];

  var els = {};
  [
    "micBtn", "statusPill", "meId", "permWarn", "themeToggle",
    "spectro", "spectroLive", "recPause", "recDownload", "spectroZoom",
    "spectroScroll", "spectroClear", "domFreq", "spectroViewHint", "spectroMem",
    "pPre", "pBase", "pStep", "pPreMs", "pDataMs", "pNode",
    "applyLocal", "applyAll", "followRoom", "airInfo", "syncState",
    "txPayload", "txGain", "txOnce", "txAuto", "txStop", "txInfo", "rxStats", "rxBody",
    "bankSlot", "bankName", "bankNote", "bankWithAudio", "bankSave", "bankLoad",
    "bankAudioDl", "bankRename", "bankClear", "bankInfo", "bankBody",
    "swPre", "swStep", "swData", "swWin", "sweepStart", "sweepStop", "sweepBest",
    "sweepState", "sweepBody", "map", "log", "buildMeta",
  ].forEach(function (id) { els[id] = document.getElementById(id); });

  function now() { return performance.now(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function log(m) {
    if (!els.log) return;
    var s = new Date().toISOString().slice(11, 23);
    els.log.textContent += (els.log.textContent ? "\n" : "") + "[" + s + "] " + m;
    els.log.scrollTop = els.log.scrollHeight;
  }
  function setStatus(kind, txt) {
    if (!els.statusPill) return;
    els.statusPill.className = "pill" + (kind ? " " + kind : "");
    els.statusPill.textContent = txt;
  }
  function showWarn(t) {
    if (!els.permWarn) return;
    els.permWarn.textContent = t;
    els.permWarn.hidden = false;
  }
  function on(el, ev, fn) {
    if (el) el.addEventListener(ev, fn);
  }
  function cssVar(n, f) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return v || f;
  }

  // ---- Theme ----
  function currentTheme() {
    return document.documentElement.dataset.theme === "light" ? "light" : "dark";
  }
  function applyTheme(x) {
    document.documentElement.dataset.theme = x;
    try { localStorage.setItem(THEME_KEY, x); } catch (e) {}
    if (els.themeToggle) {
      els.themeToggle.textContent = x === "light" ? "\u263e" : "\u2600";
    }
    // `state` is created later; never touch it during first paint.
    if (typeof state !== "undefined" && state && state.spectroReady) {
      try { drawSpectroFrame(); } catch (e) { /* ignore */ }
    }
  }
  applyTheme(currentTheme());
  on(els.themeToggle, "click", function () {
    applyTheme(currentTheme() === "light" ? "dark" : "light");
  });

  // ---- Fingerprint → node id + label ----
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }
  var fpSrc = [
    navigator.userAgent || "",
    navigator.platform || "",
    (navigator.languages || [navigator.language || ""]).join(","),
    (screen.width || 0) + "x" + (screen.height || 0),
  ].join("|");
  var fpHash = fnv1a(fpSrc);
  var fp = ("0000000" + fpHash.toString(16)).slice(-8);
  var maxNodes = alinkReady ? ALINK.CONST.MAX_NODES : 8;
  var myNode = fpHash % maxNodes;
  var myLabel = fp.slice(0, 6);
  if (els.meId) els.meId.textContent = "node " + myNode + " · " + myLabel;
  if (els.pNode) els.pNode.value = String(myNode);

  /** Default / test / autosweep payload = transmitting node id (e.g. "n3"). */
  function nodePayloadText() {
    return "n" + myNode;
  }
  function ensureNodePayload() {
    if (els.txPayload) els.txPayload.value = nodePayloadText();
  }
  ensureNodePayload();

  var state = {
    running: false, ctx: null, demod: null, rs: null, wavProc: null, mute: null, stream: null,
    micSrc: null, analyser: null, buf: null,
    rxCount: 0, txCount: 0, seq: 0,
    rx: [], heard: {},
    lastV: -1, editing: 0,
    nodes: [], bank: [],
    txAutoTimer: 0, sweep: null,
    // spectro / wav
    histBins: 96,
    histCap: 8000,
    histData: null, histDom: null,
    histCount: 0, histHead: 0,
    spectroColMs: 40,
    colsPerPx: 1,
    viewEnd: 0,
    spectroReady: false,
    spectroDirty: true,
    spectroImg: null,
    spectroColScratch: null,
    spectroRaf: 0,
    recPaused: false,
    wav: null, wavCap: 0, wavHead: 0, wavCount: 0, wavRate: 0,
    workletReady: false,
    pcmTapKind: "",
    domHz: NaN,
    lastColAt: 0,
  };

  // Mic button must work even if later init throws (hoisted startMic/stopMic).
  on(els.micBtn, "click", function () {
    if (state.running) stopMic();
    else startMic();
  });
  // Re-apply theme icon now that `state` exists (first applyTheme ran earlier).
  if (els.themeToggle) {
    els.themeToggle.textContent =
      currentTheme() === "light" ? "\u263e" : "\u2600";
  }

  // ---- Config <-> UI ----
  function readParams() {
    return {
      preambleHz: parseInt(els.pPre.value, 10) || 2000,
      hopBaseHz: parseInt(els.pBase.value, 10) || 1400,
      hopStepHz: parseInt(els.pStep.value, 10) || 200,
      preChipMs: parseFloat(els.pPreMs.value) || 1,
      dataChipMs: parseFloat(els.pDataMs.value) || 4,
    };
  }
  function writeParams(p) {
    if (!p) return;
    els.pPre.value = p.preambleHz;
    els.pBase.value = p.hopBaseHz;
    els.pStep.value = p.hopStepHz;
    els.pPreMs.value = p.preChipMs;
    els.pDataMs.value = p.dataChipMs;
  }
  function airtimeMs(p) {
    return Math.round(31 * p.preChipMs + 248 * p.dataChipMs);
  }
  function applyParams(p) {
    if (!alinkReady) {
      if (els.airInfo) els.airInfo.textContent = "ALINK nedostupný";
      return;
    }
    ALINK.setProfile(p);
    if (state.running && state.ctx) state.demod = new ALINK.Demod(48000);
    var C = ALINK.CONST;
    if (els.airInfo) {
      els.airInfo.textContent =
        "pre " + C.PREAMBLE_HZ + " Hz · hopy " + C.HOPS[0] + "–" + C.HOPS[C.NHOPS - 1] +
        " Hz · air " + airtimeMs(p) + " ms · goodput≈" + Math.round(128000 / airtimeMs(p)) + " b/s";
    }
  }
  function describe(p) {
    return p.preambleHz + "/" + p.hopStepHz + "/" + p.dataChipMs;
  }

  els.applyLocal.addEventListener("click", function () {
    applyParams(readParams());
    log("použito lokálně");
  });
  els.applyAll.addEventListener("click", function () {
    var p = readParams();
    applyParams(p);
    pushConfig(p);
  });
  ["pPre", "pBase", "pStep", "pPreMs", "pDataMs"].forEach(function (id) {
    els[id].addEventListener("focus", function () { state.editing = now(); });
    els[id].addEventListener("input", function () { state.editing = now(); });
  });

  // ---- Room sync ----
  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }
  function pushConfig(p) {
    return postJson("/api/dev/config", { config: p })
      .then(function (d) {
        state.lastV = d.v;
        els.syncState.textContent = "sync v" + d.v + " (odesláno)";
        log("konfigurace synchronizována všem (v" + d.v + ")");
        if (d.bank) { state.bank = d.bank; renderBank(); }
        return d;
      })
      .catch(function () { els.syncState.textContent = "sync chyba"; });
  }
  function applyRemoteConfig(d) {
    if (!d || !d.config) return;
    if (d.v === state.lastV) return;
    state.lastV = d.v;
    if (els.followRoom.checked && now() - state.editing > 4000) {
      writeParams(d.config);
      applyParams(d.config);
      els.syncState.textContent = "sync v" + d.v + " (přijato)";
      log("přijato sdílené nastavení v" + d.v);
    } else {
      els.syncState.textContent = "sync v" + d.v + " (dostupné)";
    }
  }
  function ingestRoom(d) {
    if (!d) return;
    applyRemoteConfig(d);
    if (d.nodes) state.nodes = d.nodes;
    if (d.bank) state.bank = d.bank;
    renderBank();
    drawMap();
  }
  function poll() {
    fetch("/api/dev/state", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(ingestRoom)
      .catch(function () {});
  }
  function heardList() {
    return Object.keys(state.heard).map(function (n) { return parseInt(n, 10); });
  }
  function heartbeat() {
    postJson("/api/dev/heartbeat", {
      fp: fp, node: myNode, label: myLabel,
      rx: state.rxCount, tx: state.txCount, heard: heardList(),
    }).then(ingestRoom).catch(function () {});
  }

  // ---- Spectrogram + 10 MB WAV ----
  function ensureWav(rate) {
    var cap = Math.floor(WAV_MAX_BYTES / 2); // Int16
    if (state.wav && state.wavRate === rate && state.wavCap === cap) return;
    state.wav = new Int16Array(cap);
    state.wavCap = cap;
    state.wavHead = 0;
    state.wavCount = 0;
    state.wavRate = rate;
  }
  function pushWavSamples(floatBuf) {
    if (!state.wav || state.recPaused) return;
    for (var i = 0; i < floatBuf.length; i++) {
      var s = floatBuf[i];
      if (s > 1) s = 1;
      if (s < -1) s = -1;
      state.wav[state.wavHead] = (s * 32767) | 0;
      state.wavHead = (state.wavHead + 1) % state.wavCap;
      if (state.wavCount < state.wavCap) state.wavCount += 1;
    }
  }
  function clearWav() {
    if (state.wav) state.wav.fill(0);
    state.wavHead = 0;
    state.wavCount = 0;
  }
  function wavChronological() {
    if (!state.wav || state.wavCount <= 0) return new Int16Array(0);
    var out = new Int16Array(state.wavCount);
    var start = (state.wavHead - state.wavCount + state.wavCap * 4) % state.wavCap;
    for (var i = 0; i < state.wavCount; i++) {
      out[i] = state.wav[(start + i) % state.wavCap];
    }
    return out;
  }
  function encodeWavBlob(samples, sampleRate) {
    var n = samples.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buf);
    function str(o, s) {
      for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
    }
    str(0, "RIFF");
    v.setUint32(4, 36 + n * 2, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, n * 2, true);
    var o = 44;
    for (var i = 0; i < n; i++, o += 2) v.setInt16(o, samples[i], true);
    return new Blob([buf], { type: "audio/wav" });
  }
  function downloadWav() {
    var samples = wavChronological();
    if (!samples.length || !state.wavRate) {
      log("WAV: nic k uložení");
      return;
    }
    var blob = encodeWavBlob(samples, state.wavRate);
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var sec = (samples.length / state.wavRate).toFixed(1);
    a.href = url;
    a.download = "het68-chirpdev-" + new Date().toISOString().replace(/[:.]/g, "-") + ".wav";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    log("WAV uložen · " + sec + " s · " + (blob.size / 1024 / 1024).toFixed(2) + " MB");
  }

  function ensureHist(cap) {
    var bins = state.histBins;
    var want = Math.max(SPEC_CAP_MIN, Math.min(SPEC_CAP_MAX, cap | 0));
    if (state.histData && state.histCap === want && state.histDom && state.histDom.length === want) return;
    var oldData = state.histData;
    var oldDom = state.histDom;
    var oldCap = state.histCap;
    var oldCount = state.histCount;
    var oldHead = state.histHead;
    var keep = oldData ? Math.min(oldCount, want) : 0;
    state.histCap = want;
    state.histData = new Uint8Array(want * bins);
    state.histDom = new Float32Array(want);
    for (var i = 0; i < want; i++) state.histDom[i] = NaN;
    if (keep > 0) {
      for (var k = 0; k < keep; k++) {
        var srcLogic = oldCount - keep + k;
        var srcPhys = (oldHead - oldCount + srcLogic + oldCap * 4) % oldCap;
        state.histData.set(
          oldData.subarray(srcPhys * bins, srcPhys * bins + bins),
          k * bins
        );
        state.histDom[k] = oldDom[srcPhys];
      }
      state.histCount = keep;
      state.histHead = keep % want;
    } else {
      state.histCount = 0;
      state.histHead = 0;
    }
  }
  function histPhys(logicIdx) {
    return (state.histHead - state.histCount + logicIdx + state.histCap * 4) % state.histCap;
  }
  function pushHistColumn(colU8, domHz) {
    ensureHist(state.histCap || 8000);
    var bins = state.histBins;
    var at = state.histHead;
    state.histData.set(colU8, at * bins);
    state.histDom[at] = isFinite(domHz) ? domHz : NaN;
    state.histHead = (at + 1) % state.histCap;
    if (state.histCount < state.histCap) state.histCount += 1;
    if (state.viewEnd === 0) { /* live */ }
    else state.viewEnd = Math.min(state.viewEnd + 1, Math.max(0, state.histCount - 8));
  }
  function sampleHistCol(logicIdx, out) {
    if (logicIdx < 0 || logicIdx >= state.histCount) { out.fill(0); return false; }
    var phys = histPhys(logicIdx);
    out.set(state.histData.subarray(phys * state.histBins, phys * state.histBins + state.histBins));
    return true;
  }
  function sampleHistDom(logicIdx) {
    if (logicIdx < 0 || logicIdx >= state.histCount) return NaN;
    return state.histDom[histPhys(logicIdx)];
  }

  function colorRgbForU8(u) {
    // dark → teal heat
    var t = u / 255;
    var r = (20 + t * 40) | 0;
    var g = (30 + t * 190) | 0;
    var b = (40 + t * 140) | 0;
    return [r, g, b];
  }
  function spectroLayout() {
    var c = els.spectro;
    var W = c.width, H = c.height;
    return {
      W: W, H: H,
      plotX: SPEC_PAD.l, plotY: SPEC_PAD.t,
      plotW: W - SPEC_PAD.l - SPEC_PAD.r,
      plotH: H - SPEC_PAD.t - SPEC_PAD.b,
    };
  }
  function freqToY(freq, plotY, plotH) {
    var frac = (SPEC_FMAX - freq) / (SPEC_FMAX - SPEC_FMIN);
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    return plotY + frac * (plotH - 1);
  }
  function viewSpanCols(plotW) {
    return Math.max(8, Math.ceil(plotW * state.colsPerPx));
  }
  function clampView() {
    var lay = spectroLayout();
    var span = viewSpanCols(lay.plotW);
    var maxEnd = Math.max(0, state.histCount - span);
    if (state.viewEnd > maxEnd) state.viewEnd = maxEnd;
    if (state.viewEnd < 0) state.viewEnd = 0;
  }
  function memStats() {
    var histB = state.histCap * state.histBins + state.histCap * 4;
    var wavB = state.wavCount * 2;
    var totalMB = (histB + wavB) / 1024 / 1024;
    var wavSec = state.wavRate ? state.wavCount / state.wavRate : 0;
    return { totalMB: totalMB, wavSec: wavSec, wavMB: wavB / 1024 / 1024 };
  }
  function updateSpectroControls() {
    var lay = spectroLayout();
    var span = viewSpanCols(lay.plotW);
    var maxEnd = Math.max(0, state.histCount - span);
    if (els.spectroScroll) {
      els.spectroScroll.max = String(Math.max(1, maxEnd));
      els.spectroScroll.value = String(Math.max(0, maxEnd - state.viewEnd));
      els.spectroScroll.disabled = maxEnd <= 0;
    }
    if (els.spectroLive) els.spectroLive.classList.toggle("is-active", state.viewEnd === 0);
    if (els.recPause) {
      els.recPause.textContent = state.recPaused ? "Pokračovat" : "Pauza";
      els.recPause.classList.toggle("is-active", state.recPaused);
    }
    if (els.recDownload) els.recDownload.disabled = !state.wavCount;
    if (els.spectroViewHint) {
      els.spectroViewHint.textContent = state.viewEnd === 0 ? "teď" : "historie";
    }
    if (els.spectroMem) {
      var m = memStats();
      els.spectroMem.textContent =
        "paměť " + m.totalMB.toFixed(2) + " / 10 MB · WAV " + m.wavSec.toFixed(1) + " s";
    }
  }

  function drawSpectroFrame() {
    var c = els.spectro;
    if (!c) return;
    ensureHist(state.histCap || 8000);
    var lay = spectroLayout();
    clampView();
    var g = c.getContext("2d");
    g.fillStyle = cssVar("--bg-card", "#0f1720");
    g.fillRect(0, 0, lay.W, lay.H);
    g.fillStyle = "#05080a";
    g.fillRect(lay.plotX, lay.plotY, lay.plotW, lay.plotH);

    var span = viewSpanCols(lay.plotW);
    var endLogic = state.histCount - 1 - state.viewEnd;
    var startLogic = endLogic - span + 1;
    if (!state.spectroImg || state.spectroImg.width !== lay.plotW || state.spectroImg.height !== lay.plotH) {
      state.spectroImg = g.createImageData(lay.plotW, lay.plotH);
    }
    if (!state.spectroColScratch || state.spectroColScratch.length !== state.histBins) {
      state.spectroColScratch = new Uint8Array(state.histBins);
    }
    var img = state.spectroImg;
    var px = img.data;
    var col = state.spectroColScratch;
    var bins = state.histBins;
    for (var x = 0; x < lay.plotW; x++) {
      var logic = startLogic + (x / (lay.plotW - 1 || 1)) * (span - 1);
      var li = logic | 0;
      var ok = sampleHistCol(li, col);
      for (var y = 0; y < lay.plotH; y++) {
        var bi = ((y / (lay.plotH - 1 || 1)) * (bins - 1) + 0.5) | 0;
        var rgb = ok ? colorRgbForU8(col[bi]) : [5, 8, 10];
        var o = (y * lay.plotW + x) * 4;
        px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = 255;
      }
    }
    g.putImageData(img, lay.plotX, lay.plotY);

    var marks = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
    g.font = "11px Manrope, sans-serif";
    g.fillStyle = cssVar("--muted", "#9aa8b5");
    g.strokeStyle = "rgba(148,163,184,0.16)";
    g.lineWidth = 1;
    g.textAlign = "right";
    g.textBaseline = "middle";
    for (var i = 0; i < marks.length; i++) {
      var f = marks[i];
      var yy = freqToY(f, lay.plotY, lay.plotH);
      g.beginPath(); g.moveTo(lay.plotX, yy); g.lineTo(lay.plotX + lay.plotW, yy); g.stroke();
      g.fillText((f / 1000).toFixed(0), lay.plotX - 8, yy);
    }
    if (typeof ALINK !== "undefined") {
      var hops = ALINK.CONST.HOPS;
      function bandLine(freq, color) {
        var yb = freqToY(freq, lay.plotY, lay.plotH);
        g.strokeStyle = color; g.setLineDash([4, 4]);
        g.beginPath(); g.moveTo(lay.plotX, yb); g.lineTo(lay.plotX + lay.plotW, yb); g.stroke();
        g.setLineDash([]);
      }
      bandLine(ALINK.CONST.PREAMBLE_HZ, "rgba(59,130,246,0.55)");
      bandLine(hops[0], "rgba(31,191,160,0.4)");
      bandLine(hops[hops.length - 1], "rgba(31,191,160,0.4)");
    }

    // dominant line
    g.strokeStyle = "#f59e0b";
    g.lineWidth = 2;
    g.beginPath();
    var started = false;
    for (var x2 = 0; x2 < lay.plotW; x2++) {
      var logic2 = startLogic + (x2 / (lay.plotW - 1 || 1)) * (span - 1);
      var hz = sampleHistDom(logic2 | 0);
      if (!isFinite(hz) || hz > SPEC_FMAX) { started = false; continue; }
      var xx = lay.plotX + x2;
      var y2 = freqToY(hz, lay.plotY, lay.plotH);
      if (!started) { g.moveTo(xx, y2); started = true; }
      else g.lineTo(xx, y2);
    }
    if (started) g.stroke();

    g.strokeStyle = cssVar("--line", "rgba(148,163,184,0.3)");
    g.lineWidth = 1;
    g.strokeRect(lay.plotX + 0.5, lay.plotY + 0.5, lay.plotW - 1, lay.plotH - 1);

    state.spectroReady = true;
    state.spectroDirty = false;
    updateSpectroControls();
  }

  function dbToU8(db) {
    var t = (db - SPEC_DB_MIN) / (SPEC_DB_MAX - SPEC_DB_MIN);
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return (t * 255) | 0;
  }

  function captureSpectroColumn() {
    if (!state.analyser || !state.buf || state.recPaused) return;
    state.analyser.getFloatFrequencyData(state.buf);
    var binHz = state.ctx.sampleRate / state.analyser.fftSize;
    var col = state.spectroColScratch || (state.spectroColScratch = new Uint8Array(state.histBins));
    var peakDb = -Infinity;
    var peakHz = NaN;
    for (var b = 0; b < state.histBins; b++) {
      var f0 = SPEC_FMIN + (b / state.histBins) * (SPEC_FMAX - SPEC_FMIN);
      var f1 = SPEC_FMIN + ((b + 1) / state.histBins) * (SPEC_FMAX - SPEC_FMIN);
      var i0 = Math.max(1, Math.floor(f0 / binHz));
      var i1 = Math.min(state.buf.length - 1, Math.ceil(f1 / binHz));
      var s = -140;
      if (i1 > i0) {
        var acc = 0;
        for (var i = i0; i <= i1; i++) acc += state.buf[i];
        s = acc / (i1 - i0 + 1);
      }
      col[b] = dbToU8(s);
      if (s > peakDb) { peakDb = s; peakHz = (f0 + f1) / 2; }
    }
    state.domHz = peakHz;
    if (els.domFreq) {
      els.domFreq.textContent = isFinite(peakHz)
        ? "dominantní " + peakHz.toFixed(0) + " Hz"
        : "dominantní —";
    }
    pushHistColumn(col, peakHz);
    state.spectroDirty = true;
  }

  function spectroLoop() {
    if (!state.running) { state.spectroRaf = 0; return; }
    var t = now();
    if (t - state.lastColAt >= state.spectroColMs) {
      state.lastColAt = t;
      captureSpectroColumn();
    }
    if (state.spectroDirty && state.viewEnd === 0) drawSpectroFrame();
    else if (state.spectroDirty) drawSpectroFrame();
    state.spectroRaf = requestAnimationFrame(spectroLoop);
  }

  function clearSpectro() {
    ensureHist(state.histCap || 8000);
    state.histData.fill(0);
    for (var i = 0; i < state.histCap; i++) state.histDom[i] = NaN;
    state.histCount = 0;
    state.histHead = 0;
    state.viewEnd = 0;
    clearWav();
    state.spectroDirty = true;
    drawSpectroFrame();
    log("spektrogram smazán");
  }

  on(els.spectroClear, "click", clearSpectro);
  on(els.recDownload, "click", downloadWav);
  on(els.recPause, "click", function () {
    state.recPaused = !state.recPaused;
    updateSpectroControls();
    log(state.recPaused ? "záznam pozastaven" : "záznam běží");
  });
  on(els.spectroLive, "click", function () {
    state.viewEnd = 0;
    state.spectroDirty = true;
    drawSpectroFrame();
  });
  on(els.spectroZoom, "input", function () {
    var zi = parseInt(els.spectroZoom.value, 10) || 2;
    state.colsPerPx = SPEC_ZOOM_STEPS[zi] || 1;
    state.spectroDirty = true;
    drawSpectroFrame();
  });
  on(els.spectroScroll, "input", function () {
    var lay = spectroLayout();
    var span = viewSpanCols(lay.plotW);
    var maxEnd = Math.max(0, state.histCount - span);
    var v = parseInt(els.spectroScroll.value, 10) || 0;
    state.viewEnd = Math.max(0, maxEnd - v);
    state.spectroDirty = true;
    drawSpectroFrame();
  });

  function onPcmSamples(ch) {
    if (!state.running || !ch || !ch.length) return;
    pushWavSamples(ch);
    if (state.demod) {
      var fed = state.rs ? state.rs.process(ch) : ch;
      var frames = state.demod.push(fed);
      for (var i = 0; i < frames.length; i++) onFrame(frames[i]);
      if (frames.length) renderRxStats();
    }
  }

  /** Prefer AudioWorklet; fall back to ScriptProcessor only if Worklet is unavailable. */
  async function attachPcmTap(src) {
    var mute = state.ctx.createGain();
    mute.gain.value = 0;
    state.mute = mute;

    if (state.ctx.audioWorklet && typeof AudioWorkletNode === "function") {
      if (!state.workletReady) {
        await state.ctx.audioWorklet.addModule("/pcm-tap-worklet.js");
        state.workletReady = true;
      }
      var node = new AudioWorkletNode(state.ctx, "pcm-tap", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
      });
      node.port.onmessage = function (ev) {
        if (ev.data && ev.data.samples) onPcmSamples(ev.data.samples);
      };
      src.connect(node);
      node.connect(mute);
      mute.connect(state.ctx.destination);
      state.wavProc = node;
      state.pcmTapKind = "worklet";
      log("PCM tap: AudioWorklet");
      return;
    }

    // Legacy fallback (may log a deprecation warning in Chromium).
    var proc = state.ctx.createScriptProcessor(2048, 1, 1);
    src.connect(proc);
    proc.connect(mute);
    mute.connect(state.ctx.destination);
    proc.onaudioprocess = function (ev) {
      onPcmSamples(ev.inputBuffer.getChannelData(0));
    };
    state.wavProc = proc;
    state.pcmTapKind = "script";
    log("PCM tap: ScriptProcessor (fallback)");
  }

  // ---- Mic RX (wired early; async + guarded like chirp.js) ----
  async function startMic() {
    if (state.running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showWarn("Prohlížeč nepodporuje mikrofon.");
      return;
    }
    if (!window.isSecureContext) {
      showWarn("Vyžaduje HTTPS.");
      return;
    }
    try {
      setStatus("", "žádám mikrofon…");
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      try {
        state.ctx = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 48000,
        });
      } catch (rateErr) {
        state.ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (state.ctx.state === "suspended") await state.ctx.resume();
      var src = state.ctx.createMediaStreamSource(state.stream);
      state.micSrc = src;
      var micRate = state.ctx.sampleRate;
      state.analyser = state.ctx.createAnalyser();
      state.analyser.fftSize = 4096;
      state.analyser.smoothingTimeConstant = 0;
      src.connect(state.analyser);
      state.buf = new Float32Array(state.analyser.frequencyBinCount);
      ensureHist(state.histCap || 8000);
      try {
        ensureWav(micRate);
      } catch (wavAllocErr) {
        log("WAV buffer: " + (wavAllocErr && wavAllocErr.message ? wavAllocErr.message : wavAllocErr));
      }
      if (alinkReady) {
        state.demod = new ALINK.Demod(48000);
        state.rs = micRate === 48000 ? null : new ALINK.Resampler(micRate, 48000);
      } else {
        state.demod = null;
        state.rs = null;
      }
      try {
        await attachPcmTap(src);
      } catch (procErr) {
        log("PCM tap nedostupný: " + (procErr && procErr.message ? procErr.message : procErr));
      }
      state.running = true;
      state.recPaused = false;
      if (els.permWarn) els.permWarn.hidden = true;
      if (els.micBtn) els.micBtn.textContent = "Zastavit mikrofon";
      setStatus("on", "poslouchám");
      log(
        "mikrofon " + micRate + " Hz" +
          (micRate === 48000 ? "" : " → 48000") +
          " · WAV cap " + (WAV_MAX_BYTES / 1024 / 1024).toFixed(0) + " MB" +
          (alinkReady ? "" : " · bez ALINK demod")
      );
      renderRxStats();
      updateSpectroControls();
      if (!state.spectroRaf) state.spectroRaf = requestAnimationFrame(spectroLoop);
    } catch (e) {
      showWarn("Mikrofon selhal: " + (e && e.message ? e.message : e));
      setStatus("err", "chyba");
      try { stopMic(); } catch (e2) { /* ignore */ }
    }
  }
  function stopMic() {
    state.running = false;
    if (state.spectroRaf) {
      cancelAnimationFrame(state.spectroRaf);
      state.spectroRaf = 0;
    }
    if (state.wavProc) {
      try {
        if (state.wavProc.port) state.wavProc.port.onmessage = null;
        if (state.wavProc.onaudioprocess) state.wavProc.onaudioprocess = null;
        state.wavProc.disconnect();
      } catch (e) {}
      state.wavProc = null;
    }
    if (state.mute) {
      try { state.mute.disconnect(); } catch (e) {}
      state.mute = null;
    }
    if (state.analyser) {
      try { state.analyser.disconnect(); } catch (e) {}
      state.analyser = null;
    }
    if (state.micSrc) {
      try { state.micSrc.disconnect(); } catch (e) {}
      state.micSrc = null;
    }
    if (state.stream) {
      state.stream.getTracks().forEach(function (t) { t.stop(); });
    }
    if (state.ctx) state.ctx.close().catch(function () {});
    state.ctx = null;
    state.demod = null;
    state.rs = null;
    state.stream = null;
    if (els.micBtn) els.micBtn.textContent = "Spustit mikrofon";
    setStatus("", "nečinné");
  }

  function onFrame(f) {
    state.rxCount++;
    state.heard[f.nodeId] = f.rho;
    state.rx.unshift({ at: Date.now(), node: f.nodeId, seq: f.seq, rho: f.rho, pl: f.payload });
    if (state.rx.length > 30) state.rx.length = 30;
    if (state.sweep) state.sweep.decoded++;
    renderRx();
    drawMap();
  }
  function renderRxStats() {
    var st = state.demod ? state.demod.stats : { decoded: 0, badCrc: 0, detects: 0 };
    els.rxStats.textContent = "dekódováno " + st.decoded + " · CRC " + st.badCrc + " · det " + st.detects;
  }
  function bytesToText(u8) {
    if (!u8 || !u8.length) return "—";
    var s = "";
    for (var i = 0; i < u8.length; i++) {
      var c = u8[i];
      s += c >= 32 && c < 127 ? String.fromCharCode(c) : ".";
    }
    return s;
  }
  function ago(ts) { return Math.round((Date.now() - ts) / 1000) + " s"; }
  function renderRx() {
    if (!state.rx.length) {
      els.rxBody.innerHTML = '<tr class="empty"><td colspan="5">Zatím nic přijato.</td></tr>';
      return;
    }
    els.rxBody.innerHTML = state.rx.map(function (r) {
      return "<tr><td>" + ago(r.at) + "</td><td class='node-id'>" + r.node + "</td><td>" + r.seq +
        "</td><td>" + bytesToText(r.pl) + "</td><td>" + r.rho.toFixed(2) + "</td></tr>";
    }).join("");
    renderRxStats();
  }

  // ---- TX ----
  var txCtx = null, txSrc = null;
  function txContext() {
    if (!txCtx) {
      try { txCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 }); }
      catch (e) { txCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    }
    if (txCtx.state === "suspended") txCtx.resume();
    return txCtx;
  }
  function payloadBytes(text) {
    var s = text != null ? String(text) : (els.txPayload.value || nodePayloadText());
    if (!s) s = nodePayloadText();
    var b = [];
    for (var i = 0; i < s.length && b.length < 16; i++) {
      var c = s.charCodeAt(i);
      if (c < 256) b.push(c);
    }
    return new Uint8Array(b);
  }
  function transmit(opts) {
    opts = opts || {};
    // Tests / autosweep always announce the transmitting node id.
    var plText = opts.forceNodeId || state.sweep
      ? nodePayloadText()
      : (els.txPayload.value || nodePayloadText());
    if (opts.forceNodeId || state.sweep) els.txPayload.value = plText;
    var ctx = txContext();
    var fields = {
      nodeId: myNode, type: ALINK.TYPE.BEACON, seq: state.seq & 0xff,
      flags: ALINK.FLAG.SYNCED, keyId: 0, nonce: fpHash >>> 0, payload: payloadBytes(plText),
    };
    state.seq = (state.seq + 1) & 0xff;
    var gain = (parseInt(els.txGain.value, 10) || 70) / 100;
    var samples = ALINK.modulateFrame(fields, ctx.sampleRate, { gain: gain });
    if (txSrc) { try { txSrc.onended = null; txSrc.stop(); } catch (e) {} }
    var buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buf.getChannelData(0).set(samples);
    var sn = ctx.createBufferSource(); sn.buffer = buf; sn.connect(ctx.destination); sn.start(); txSrc = sn;
    state.txCount++;
    if (state.sweep) state.sweep.tx++;
    var dur = samples.length / ctx.sampleRate;
    els.txInfo.textContent = "TX node " + myNode + " seq " + fields.seq + " · " + (dur * 1000).toFixed(0) + " ms";
    return dur;
  }
  els.txOnce.addEventListener("click", transmit);
  els.txStop.addEventListener("click", function () {
    els.txAuto.checked = false;
    if (state.txAutoTimer) { clearInterval(state.txAutoTimer); state.txAutoTimer = 0; }
    if (txSrc) { try { txSrc.stop(); } catch (e) {} txSrc = null; }
  });
  els.txAuto.addEventListener("change", function () {
    if (state.txAutoTimer) { clearInterval(state.txAutoTimer); state.txAutoTimer = 0; }
    if (els.txAuto.checked) {
      ensureNodePayload();
      var period = airtimeMs(readParams()) + 500;
      state.txAutoTimer = setInterval(function () {
        transmit({ forceNodeId: true });
      }, period);
      transmit({ forceNodeId: true });
    }
  });

  // ---- Memory bank (10 slots) ----
  function bankApi(body) { return postJson("/api/dev/bank", body); }
  function initBankSelect() {
    els.bankSlot.innerHTML = "";
    for (var i = 0; i < 10; i++) {
      var o = document.createElement("option");
      o.value = String(i);
      o.textContent = "Slot " + (i + 1);
      els.bankSlot.appendChild(o);
    }
  }
  initBankSelect();
  function renderBank() {
    var bank = state.bank || [];
    if (!bank.length) {
      els.bankBody.innerHTML = '<tr class="empty"><td colspan="5">—</td></tr>';
      return;
    }
    els.bankBody.innerHTML = bank.map(function (s) {
      if (s.empty) {
        return "<tr><td>" + (s.slot + 1) + "</td><td class='muted'>— prázdný —</td><td>—</td><td>—</td><td>—</td></tr>";
      }
      var when = s.savedAt ? new Date(s.savedAt).toLocaleString("cs-CZ") : "—";
      var note = (s.note || "").slice(0, 28);
      var audio =
        s.hasAudio && s.audioBytes
          ? (s.audioBytes / 1024 / 1024).toFixed(1) + " MB"
          : s.hasAudio
            ? "ano"
            : "—";
      return "<tr><td>" + (s.slot + 1) + "</td><td>" + (s.name || "Profil") +
        "</td><td>" + (s.airMs != null ? s.airMs + " ms" : "—") +
        "</td><td>" + (note || "—") + " · " + audio +
        "</td><td>" + when + "</td></tr>";
    }).join("");
    var slot = parseInt(els.bankSlot.value, 10) || 0;
    var cur = bank[slot];
    if (cur && !cur.empty) {
      els.bankInfo.textContent = "slot " + (slot + 1) + " · " + (cur.name || "") +
        (cur.airMs != null ? " · air " + cur.airMs + " ms" : "");
    } else {
      els.bankInfo.textContent = "slot " + (slot + 1) + " · prázdný";
    }
  }
  els.bankSlot.addEventListener("change", function () {
    var slot = parseInt(els.bankSlot.value, 10) || 0;
    var cur = (state.bank || [])[slot];
    els.bankName.value = cur && !cur.empty ? (cur.name || "") : "";
    els.bankNote.value = cur && !cur.empty ? (cur.note || "") : "";
    renderBank();
  });
  function u8ToBase64(u8) {
    var CHUNK = 0x8000;
    var s = "";
    for (var i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(
        null,
        u8.subarray(i, Math.min(u8.length, i + CHUNK))
      );
    }
    return btoa(s);
  }
  function base64ToU8(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function uploadWavChunks(slot) {
    var samples = wavChronological();
    if (!samples.length || !state.wavRate) {
      log("bank: žádné audio k uploadu");
      return null;
    }
    var u8 = new Uint8Array(
      samples.buffer,
      samples.byteOffset,
      samples.byteLength
    );
    var total = Math.ceil(u8.length / CHUNK_RAW_BYTES) || 1;
    if (total > 64) {
      log("bank: audio příliš velké (" + total + " chunků)");
      return null;
    }
    await bankApi({ action: "chunk_clear", slot: slot });
    log("bank: upload audio " + (u8.length / 1024 / 1024).toFixed(2) + " MB · " + total + " chunků…");
    for (var i = 0; i < total; i++) {
      var slice = u8.subarray(
        i * CHUNK_RAW_BYTES,
        Math.min(u8.length, (i + 1) * CHUNK_RAW_BYTES)
      );
      var res = await bankApi({
        action: "chunk_put",
        slot: slot,
        index: i,
        total: total,
        b64: u8ToBase64(slice),
        sr: state.wavRate,
        samples: samples.length,
        bytes: u8.length,
      });
      if (res.error) throw new Error(res.error);
      if (els.bankInfo) {
        els.bankInfo.textContent =
          "upload chunk " + (i + 1) + "/" + total;
      }
    }
    return {
      format: "pcm16le",
      sr: state.wavRate,
      samples: samples.length,
      bytes: u8.length,
      chunks: total,
    };
  }

  async function downloadSlotAudio(slot) {
    var meta = await bankApi({ action: "chunk_meta", slot: slot });
    if (meta.error || !meta.audio || !(meta.audio.chunks > 0)) {
      log("bank: slot " + (slot + 1) + " nemá audio chunky");
      return null;
    }
    var total = meta.audio.chunks | 0;
    var parts = [];
    var totalBytes = 0;
    for (var i = 0; i < total; i++) {
      var ch = await bankApi({ action: "chunk_get", slot: slot, index: i });
      if (ch.error || !ch.b64) throw new Error(ch.error || "chunk " + i);
      var u8 = base64ToU8(ch.b64);
      parts.push(u8);
      totalBytes += u8.length;
      if (els.bankInfo) {
        els.bankInfo.textContent = "download chunk " + (i + 1) + "/" + total;
      }
    }
    var merged = new Uint8Array(totalBytes);
    var off = 0;
    for (var p = 0; p < parts.length; p++) {
      merged.set(parts[p], off);
      off += parts[p].length;
    }
    var samples = new Int16Array(
      merged.buffer,
      merged.byteOffset,
      Math.floor(merged.byteLength / 2)
    );
    var sr = meta.audio.sr || state.wavRate || 48000;
    var blob = encodeWavBlob(samples, sr);
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download =
      "het68-bank-slot" +
      (slot + 1) +
      "-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      ".wav";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    log(
      "bank: staženo audio slotu " +
        (slot + 1) +
        " · " +
        (blob.size / 1024 / 1024).toFixed(2) +
        " MB"
    );
    return { samples: samples, sr: sr };
  }

  on(els.bankSave, "click", async function () {
    var slot = parseInt(els.bankSlot.value, 10) || 0;
    var name = (els.bankName.value || "").trim() || ("Profil " + (slot + 1));
    var note = (els.bankNote.value || "").trim();
    var best = state._lastSweepBest;
    var withAudio = !!(els.bankWithAudio && els.bankWithAudio.checked);
    try {
      var audioMeta = null;
      if (withAudio) {
        // Save profile first (so chunk_put can attach audio meta to the slot).
        await bankApi({
          action: "save",
          slot: slot,
          name: name,
          profile: {
            config: readParams(),
            note: note,
            rx: state.rxCount,
            tx: state.txCount,
            goodput: best ? best.goodput : null,
            byFp: fp,
            byLabel: myLabel,
            audio: null,
            ids: (state.nodes || []).map(function (n) {
              return { fp: n.fp, node: n.node, label: n.label };
            }),
          },
        });
        audioMeta = await uploadWavChunks(slot);
      }
      var d = await bankApi({
        action: "save",
        slot: slot,
        name: name,
        profile: {
          config: readParams(),
          note: note,
          rx: state.rxCount,
          tx: state.txCount,
          goodput: best ? best.goodput : null,
          byFp: fp,
          byLabel: myLabel,
          audio: audioMeta,
          ids: (state.nodes || []).map(function (n) {
            return { fp: n.fp, node: n.node, label: n.label };
          }),
        },
      });
      if (d.error) { log("bank: " + d.error); return; }
      state.bank = d.bank || state.bank;
      renderBank();
      log(
        "bank: uložen slot " +
          (slot + 1) +
          " „" +
          name +
          "“" +
          (audioMeta
            ? " · audio " +
              (audioMeta.bytes / 1024 / 1024).toFixed(2) +
              " MB / " +
              audioMeta.chunks +
              " ch"
            : "")
      );
    } catch (e) {
      log("bank: uložení selhalo — " + (e && e.message ? e.message : e));
    }
  });
  on(els.bankLoad, "click", async function () {
    var slot = parseInt(els.bankSlot.value, 10) || 0;
    try {
      var d = await bankApi({ action: "load", slot: slot });
      if (d.error) { log("bank: " + d.error); return; }
      if (d.config) {
        writeParams(d.config);
        applyParams(d.config);
        state.lastV = d.v;
      }
      if (d.bank) state.bank = d.bank;
      if (d.slot) {
        els.bankName.value = d.slot.name || "";
        els.bankNote.value = d.slot.note || "";
      }
      renderBank();
      log(
        "bank: načten slot " +
          (slot + 1) +
          (d.slot && d.slot.name ? " „" + d.slot.name + "“" : "") +
          (d.slot && d.slot.audio && d.slot.audio.chunks
            ? " · audio " + d.slot.audio.chunks + " ch"
            : "")
      );
    } catch (e) {
      log("bank: načtení selhalo — " + (e && e.message ? e.message : e));
    }
  });
  on(els.bankAudioDl, "click", async function () {
    var slot = parseInt(els.bankSlot.value, 10) || 0;
    try {
      await downloadSlotAudio(slot);
      renderBank();
    } catch (e) {
      log("bank: stažení audia selhalo — " + (e && e.message ? e.message : e));
    }
  });
  on(els.bankRename, "click", async function () {
    var slot = parseInt(els.bankSlot.value, 10) || 0;
    var name = (els.bankName.value || "").trim();
    if (!name) { log("bank: zadej název"); return; }
    try {
      var d = await bankApi({ action: "rename", slot: slot, name: name });
      if (d.error) { log("bank: " + d.error); return; }
      state.bank = d.bank || state.bank;
      renderBank();
      log("bank: přejmenován slot " + (slot + 1));
    } catch (e) { log("bank: přejmenování selhalo"); }
  });
  on(els.bankClear, "click", async function () {
    var slot = parseInt(els.bankSlot.value, 10) || 0;
    try {
      var d = await bankApi({ action: "clear", slot: slot });
      state.bank = d.bank || state.bank;
      els.bankName.value = "";
      els.bankNote.value = "";
      renderBank();
      log("bank: smazán slot " + (slot + 1));
    } catch (e) { log("bank: smazání selhalo"); }
  });

  // ---- Sweep ----
  function buildGrid() {
    var pres = els.swPre.checked ? [1500, 2000, 2500] : [readParams().preambleHz];
    var steps = els.swStep.checked ? [150, 200, 300] : [readParams().hopStepHz];
    var datas = els.swData.checked ? [2, 3, 4, 6] : [readParams().dataChipMs];
    var grid = [];
    pres.forEach(function (pre) {
      steps.forEach(function (st) {
        datas.forEach(function (dm) {
          var base = Math.max(700, pre - (ALINK.CONST.NHOPS / 2) * st);
          grid.push({ preambleHz: pre, hopBaseHz: base, hopStepHz: st, preChipMs: 1, dataChipMs: dm });
        });
      });
    });
    return grid;
  }
  els.sweepStart.addEventListener("click", async function () {
    if (state.sweep) return;
    if (!state.running) { log("sweep: nejdřív spusť mikrofon"); return; }
    var grid = buildGrid();
    var winS = Math.max(4, parseInt(els.swWin.value, 10) || 8);
    state.sweep = { stop: false, decoded: 0, tx: 0, best: null };
    ensureNodePayload();
    els.sweepBody.innerHTML = "";
    els.sweepBest.disabled = true;
    log("sweep spuštěn: " + grid.length + " sad × " + winS + " s · payload " + nodePayloadText());
    for (var gi = 0; gi < grid.length; gi++) {
      if (state.sweep.stop) break;
      var p = grid[gi];
      writeParams(p); applyParams(p); pushConfig(p);
      els.sweepState.textContent = "sada " + (gi + 1) + "/" + grid.length;
      await sleep(1200);
      state.sweep.decoded = 0; state.sweep.tx = 0;
      var air = airtimeMs(p);
      var period = air + 400;
      var end = now() + winS * 1000;
      while (now() < end && !state.sweep.stop) {
        transmit();
        await sleep(period);
      }
      var ok = state.sweep.decoded, att = state.sweep.tx || 1;
      var goodput = (ok * 128) / winS;
      var row = { p: p, ok: ok, att: att, goodput: goodput, air: air };
      addSweepRow(row);
      if (!state.sweep.best || (ok > 0 && goodput > state.sweep.best.goodput)) state.sweep.best = row;
    }
    els.sweepState.textContent = state.sweep.stop ? "zastaveno" : "hotovo";
    if (state.sweep.best) { els.sweepBest.disabled = false; markBest(); }
    log("sweep dokončen; nejlepší: " + (state.sweep.best ? describe(state.sweep.best.p) : "—"));
    var done = state.sweep; state.sweep = null;
    state._lastSweepBest = done.best;
  });
  els.sweepStop.addEventListener("click", function () { if (state.sweep) state.sweep.stop = true; });
  els.sweepBest.addEventListener("click", function () {
    var b = state._lastSweepBest;
    if (b) { writeParams(b.p); applyParams(b.p); pushConfig(b.p); log("použit nejlepší profil"); }
  });
  var sweepRows = [];
  function addSweepRow(row) { sweepRows.push(row); renderSweep(); }
  function markBest() { renderSweep(); }
  function renderSweep() {
    var best = state.sweep ? state.sweep.best : state._lastSweepBest;
    els.sweepBody.innerHTML = sweepRows.map(function (r) {
      var isBest = best && r === best;
      return "<tr" + (isBest ? ' class="sweep-best"' : "") + "><td>" + r.p.preambleHz + "</td><td>" + r.p.hopStepHz +
        "</td><td>" + r.p.dataChipMs + "</td><td>" + r.ok + "/" + r.att + "</td><td>" + Math.round(r.goodput) +
        "</td><td>" + r.air + "</td></tr>";
    }).join("") || '<tr class="empty"><td colspan="6">—</td></tr>';
  }

  // ---- Node map ----
  function drawMap() {
    var c = els.map; if (!c) return;
    var g = c.getContext("2d"); var W = c.width, H = c.height;
    g.fillStyle = cssVar("--bg-card", "#0f1720"); g.fillRect(0, 0, W, H);
    var nodes = state.nodes.slice();
    if (!nodes.some(function (n) { return n.fp === fp; })) {
      nodes.push({ fp: fp, node: myNode, label: myLabel, rx: state.rxCount, tx: state.txCount, heard: heardList() });
    }
    var cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 70;
    var pos = {};
    nodes.forEach(function (n, i) {
      var a = (i / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
      pos[n.fp] = { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R };
    });
    g.lineWidth = 1.5;
    nodes.forEach(function (n) {
      (n.heard || []).forEach(function (hn) {
        nodes.forEach(function (m) {
          if (m.node === hn && m.fp !== n.fp) {
            var a = pos[n.fp], b = pos[m.fp];
            g.strokeStyle = "rgba(31,191,160,0.5)";
            g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
          }
        });
      });
    });
    g.textAlign = "center"; g.textBaseline = "middle";
    nodes.forEach(function (n) {
      var pt = pos[n.fp];
      var isSelf = n.fp === fp;
      g.fillStyle = isSelf ? cssVar("--teal", "#1fbfa0") : "#3b82f6";
      g.beginPath(); g.arc(pt.x, pt.y, 20, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#fff"; g.font = "700 13px Manrope, sans-serif";
      g.fillText("#" + n.node, pt.x, pt.y);
      g.fillStyle = cssVar("--text", "#eef3f6"); g.font = "600 12px Manrope, sans-serif";
      g.fillText(n.label + (isSelf ? " (já)" : ""), pt.x, pt.y - 30);
      g.fillStyle = cssVar("--muted", "#9aa8b5"); g.font = "11px Manrope, sans-serif";
      g.fillText("rx " + (n.rx || 0) + " · tx " + (n.tx || 0), pt.x, pt.y + 32);
    });
    if (nodes.length <= 1) {
      g.fillStyle = cssVar("--muted", "#9aa8b5"); g.font = "14px Manrope, sans-serif";
      g.fillText("Čekám na další nody…", cx, cy + R + 40);
    }
  }

  // ---- wire up ----
  try {
    applyParams(readParams());
    ensureHist(8000);
    drawSpectroFrame();
    drawMap();
    poll();
    setInterval(poll, 1500);
    setInterval(heartbeat, 3000);
    setInterval(function () { if (state.rx.length) renderRx(); }, 1000);
  } catch (initErr) {
    showWarn("Init: " + (initErr && initErr.message ? initErr.message : initErr));
    log("init chyba: " + (initErr && initErr.message ? initErr.message : initErr));
  }

  (function buildMeta() {
    var yearEl = document.getElementById("year");
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());
    function fmtDT(d) {
      var p = function (n) { return (n < 10 ? "0" : "") + n; };
      return p(d.getDate()) + "." + p(d.getMonth() + 1) + "." + d.getFullYear() +
        " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }
    function ageStr(iso) {
      var then = new Date(iso).getTime();
      if (!isFinite(then)) return null;
      var mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
      if (mins < 60) return mins + " min";
      var hrs = Math.floor(mins / 60);
      return hrs < 48 ? hrs + " h" : Math.floor(hrs / 24) + " d";
    }
    if (!els.buildMeta) return;
    fetch("/build-info.json", { cache: "no-store" }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (info) {
      if (!info || !info.version) return;
      var parts = ["v" + info.version];
      var d = new Date(info.deployedAt);
      if (!isNaN(d.getTime())) {
        parts.push("nasazeno " + fmtDT(d));
        var a = ageStr(info.deployedAt);
        if (a) parts.push("před " + a);
      }
      if (info.commit) parts.push(info.commit);
      els.buildMeta.textContent = parts.join(" · ");
      els.buildMeta.hidden = false;
    }).catch(function () {});
  })();

  log("chirpdev připraven · node " + myNode + " (" + myLabel + ") · bank 10 slotů · spektro 10 MB");
})();
