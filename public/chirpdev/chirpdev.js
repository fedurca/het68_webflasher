/**
 * het68 chirpdev — link tuning playground.
 *
 * - Sweeps ALINK modulation parameters and measures decode success / goodput
 *   live, so the band / tone spacing / chip length can be tuned empirically.
 * - Shares the current parameters across all visitors via a Cloudflare Durable
 *   Object (/api/dev/*), so multiple devices test with the same config.
 * - Draws a node map; each browser is a node whose id is derived from a
 *   fingerprint of navigator.userAgent (+ platform + languages).
 */
(function () {
  "use strict";
  if (typeof ALINK === "undefined") {
    document.getElementById("permWarn").hidden = false;
    document.getElementById("permWarn").textContent = "ALINK modem se nenačetl.";
    return;
  }

  var THEME_KEY = "het68-theme";
  var els = {};
  [
    "micBtn", "statusPill", "meId", "permWarn", "themeToggle",
    "pPre", "pBase", "pStep", "pPreMs", "pDataMs", "pNode",
    "applyLocal", "applyAll", "followRoom", "airInfo", "syncState",
    "txPayload", "txGain", "txOnce", "txAuto", "txStop", "txInfo", "rxStats", "rxBody",
    "swPre", "swStep", "swData", "swWin", "sweepStart", "sweepStop", "sweepBest",
    "sweepState", "sweepBody", "map", "log", "buildMeta",
  ].forEach(function (id) { els[id] = document.getElementById(id); });

  function now() { return performance.now(); }
  function log(m) {
    var s = new Date().toISOString().slice(11, 23);
    els.log.textContent += (els.log.textContent ? "\n" : "") + "[" + s + "] " + m;
    els.log.scrollTop = els.log.scrollHeight;
  }
  function setStatus(kind, txt) {
    els.statusPill.className = "pill" + (kind ? " " + kind : "");
    els.statusPill.textContent = txt;
  }

  // ---- Theme ----
  function currentTheme() { return document.documentElement.dataset.theme === "light" ? "light" : "dark"; }
  function applyTheme(x) {
    document.documentElement.dataset.theme = x;
    try { localStorage.setItem(THEME_KEY, x); } catch (e) {}
    els.themeToggle.textContent = x === "light" ? "\u263e" : "\u2600";
  }
  applyTheme(currentTheme());
  els.themeToggle.addEventListener("click", function () {
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
  var myNode = fpHash % ALINK.CONST.MAX_NODES;
  var myLabel = fp.slice(0, 6);
  els.meId.textContent = "node " + myNode + " · " + myLabel;
  els.pNode.value = String(myNode);

  var state = {
    running: false, ctx: null, demod: null, rs: null, wavProc: null, mute: null,
    rxCount: 0, txCount: 0, seq: 0,
    rx: [], heard: {}, // heard[node] = last rho
    lastV: -1, editing: 0,
    nodes: [],
    txAutoTimer: 0,
    sweep: null,
  };

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
    ALINK.setProfile(p);
    if (state.running && state.ctx) state.demod = new ALINK.Demod(48000);
    var C = ALINK.CONST;
    els.airInfo.textContent =
      "pre " + C.PREAMBLE_HZ + " Hz · hopy " + C.HOPS[0] + "–" + C.HOPS[C.NHOPS - 1] +
      " Hz · air " + airtimeMs(p) + " ms · goodput≈" + Math.round(128000 / airtimeMs(p)) + " b/s";
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

  // ---- Room sync (Durable Object) ----
  function pushConfig(p) {
    fetch("/api/dev/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: p }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state.lastV = d.v;
        els.syncState.textContent = "sync v" + d.v + " (odesláno)";
        log("konfigurace synchronizována všem (v" + d.v + ")");
      })
      .catch(function () { els.syncState.textContent = "sync chyba"; });
  }

  function applyRemoteConfig(d) {
    if (!d || !d.config) return;
    if (d.v === state.lastV) return;
    state.lastV = d.v;
    // Don't clobber params the user is actively editing.
    if (els.followRoom.checked && now() - state.editing > 4000) {
      writeParams(d.config);
      applyParams(d.config);
      els.syncState.textContent = "sync v" + d.v + " (přijato)";
      log("přijato sdílené nastavení v" + d.v);
    } else {
      els.syncState.textContent = "sync v" + d.v + " (dostupné)";
    }
  }

  function poll() {
    fetch("/api/dev/state", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        applyRemoteConfig(d);
        state.nodes = d.nodes || [];
        drawMap();
      })
      .catch(function () {});
  }

  function heardList() {
    return Object.keys(state.heard).map(function (n) { return parseInt(n, 10); });
  }
  function heartbeat() {
    fetch("/api/dev/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fp: fp, node: myNode, label: myLabel,
        rx: state.rxCount, tx: state.txCount, heard: heardList(),
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d) { applyRemoteConfig(d); state.nodes = d.nodes || []; drawMap(); }
      })
      .catch(function () {});
  }

  // ---- Mic RX ----
  function startMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showWarn("Prohlížeč nepodporuje mikrofon."); return;
    }
    if (!window.isSecureContext) { showWarn("Vyžaduje HTTPS."); return; }
    setStatus("", "žádám mikrofon…");
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    }).then(function (stream) {
      state.stream = stream;
      try { state.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 }); }
      catch (e) { state.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      state.ctx.resume();
      var src = state.ctx.createMediaStreamSource(stream);
      var micRate = state.ctx.sampleRate;
      state.demod = new ALINK.Demod(48000);
      state.rs = micRate === 48000 ? null : new ALINK.Resampler(micRate, 48000);
      var proc = state.ctx.createScriptProcessor(2048, 1, 1);
      var mute = state.ctx.createGain(); mute.gain.value = 0;
      src.connect(proc); proc.connect(mute); mute.connect(state.ctx.destination);
      proc.onaudioprocess = function (ev) {
        if (!state.running) return;
        var ch = ev.inputBuffer.getChannelData(0);
        var fed = state.rs ? state.rs.process(ch) : ch;
        var frames = state.demod.push(fed);
        for (var i = 0; i < frames.length; i++) onFrame(frames[i]);
        if (frames.length) renderRxStats();
      };
      state.wavProc = proc; state.mute = mute;
      state.running = true;
      els.permWarn.hidden = true;
      els.micBtn.textContent = "Zastavit mikrofon";
      setStatus("on", "poslouchám");
      log("mikrofon " + micRate + " Hz" + (micRate === 48000 ? "" : " → 48000 (resample)"));
      renderRxStats();
    }).catch(function (e) { showWarn("Mikrofon selhal: " + (e && e.message ? e.message : e)); setStatus("err", "chyba"); });
  }
  function stopMic() {
    state.running = false;
    if (state.wavProc) { try { state.wavProc.onaudioprocess = null; state.wavProc.disconnect(); } catch (e) {} state.wavProc = null; }
    if (state.mute) { try { state.mute.disconnect(); } catch (e) {} state.mute = null; }
    if (state.stream) state.stream.getTracks().forEach(function (t) { t.stop(); });
    if (state.ctx) state.ctx.close().catch(function () {});
    state.ctx = null; state.demod = null; state.rs = null;
    els.micBtn.textContent = "Spustit mikrofon";
    setStatus("", "nečinné");
  }
  function showWarn(t) { els.permWarn.textContent = t; els.permWarn.hidden = false; }

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
    var s = ""; for (var i = 0; i < u8.length; i++) { var c = u8[i]; s += c >= 32 && c < 127 ? String.fromCharCode(c) : "."; }
    return s;
  }
  function ago(ts) { var s = Math.round((Date.now() - ts) / 1000); return s + " s"; }
  function renderRx() {
    if (!state.rx.length) { els.rxBody.innerHTML = '<tr class="empty"><td colspan="5">Zatím nic přijato.</td></tr>'; return; }
    els.rxBody.innerHTML = state.rx.map(function (r) {
      return "<tr><td>" + ago(r.at) + "</td><td class='node-id'>" + r.node + "</td><td>" + r.seq +
        "</td><td>" + bytesToText(r.pl) + "</td><td>" + r.rho.toFixed(2) + "</td></tr>";
    }).join("");
    renderRxStats();
  }

  // ---- TX ----
  var txCtx = null, txSrc = null;
  function txContext() {
    if (!txCtx) { try { txCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 }); } catch (e) { txCtx = new (window.AudioContext || window.webkitAudioContext)(); } }
    if (txCtx.state === "suspended") txCtx.resume();
    return txCtx;
  }
  function payloadBytes() {
    var s = els.txPayload.value || "";
    var b = []; for (var i = 0; i < s.length && b.length < 16; i++) { var c = s.charCodeAt(i); if (c < 256) b.push(c); }
    return new Uint8Array(b);
  }
  function transmit() {
    var ctx = txContext();
    var fields = { nodeId: myNode, type: ALINK.TYPE.BEACON, seq: state.seq & 0xff, flags: ALINK.FLAG.SYNCED, keyId: 0, nonce: fpHash >>> 0, payload: payloadBytes() };
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
      var period = airtimeMs(readParams()) + 500;
      state.txAutoTimer = setInterval(transmit, period);
      transmit();
    }
  });

  // ---- Auto sweep ----
  function buildGrid() {
    var pres = els.swPre.checked ? [1500, 2000, 2500] : [readParams().preambleHz];
    var steps = els.swStep.checked ? [150, 200, 300] : [readParams().hopStepHz];
    var datas = els.swData.checked ? [2, 3, 4, 6] : [readParams().dataChipMs];
    var grid = [];
    pres.forEach(function (pre) {
      steps.forEach(function (st) {
        datas.forEach(function (dm) {
          // center the 8-tone band on the preamble
          var base = Math.max(700, pre - (ALINK.CONST.NHOPS / 2) * st);
          grid.push({ preambleHz: pre, hopBaseHz: base, hopStepHz: st, preChipMs: 1, dataChipMs: dm });
        });
      });
    });
    return grid;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  els.sweepStart.addEventListener("click", async function () {
    if (state.sweep) return;
    if (!state.running) { log("sweep: nejdřív spusť mikrofon"); return; }
    var grid = buildGrid();
    var winS = Math.max(4, parseInt(els.swWin.value, 10) || 8);
    state.sweep = { stop: false, decoded: 0, tx: 0, best: null };
    els.sweepBody.innerHTML = "";
    els.sweepBest.disabled = true;
    log("sweep spuštěn: " + grid.length + " sad × " + winS + " s");
    for (var gi = 0; gi < grid.length; gi++) {
      if (state.sweep.stop) break;
      var p = grid[gi];
      writeParams(p); applyParams(p); pushConfig(p);
      els.sweepState.textContent = "sada " + (gi + 1) + "/" + grid.length + " · pre" + p.preambleHz + " step" + p.hopStepHz + " data" + p.dataChipMs;
      await sleep(1200); // settle + let peers adopt
      state.sweep.decoded = 0; state.sweep.tx = 0;
      var air = airtimeMs(p);
      var period = air + 400;
      var end = now() + winS * 1000;
      while (now() < end && !state.sweep.stop) {
        transmit();
        await sleep(period);
      }
      var ok = state.sweep.decoded, att = state.sweep.tx || 1;
      var goodput = (ok * 128) / winS; // payload bits/s
      var row = { p: p, ok: ok, att: att, goodput: goodput, air: air };
      addSweepRow(row);
      if (!state.sweep.best || (ok > 0 && goodput > state.sweep.best.goodput)) state.sweep.best = row;
    }
    els.sweepState.textContent = state.sweep.stop ? "zastaveno" : "hotovo";
    if (state.sweep.best) { els.sweepBest.disabled = false; markBest(); }
    log("sweep dokončen; nejlepší: " + (state.sweep.best ? describe(state.sweep.best.p) + " (" + Math.round(state.sweep.best.goodput) + " b/s)" : "—"));
    var done = state.sweep; state.sweep = null;
    state._lastSweepBest = done.best;
  });
  els.sweepStop.addEventListener("click", function () { if (state.sweep) state.sweep.stop = true; });
  els.sweepBest.addEventListener("click", function () {
    var b = state._lastSweepBest;
    if (b) { writeParams(b.p); applyParams(b.p); pushConfig(b.p); log("použit nejlepší profil"); }
  });
  function describe(p) { return p.preambleHz + "/" + p.hopStepHz + "/" + p.dataChipMs; }
  var sweepRows = [];
  function addSweepRow(row) {
    sweepRows.push(row);
    renderSweep();
  }
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
  function cssVar(n, f) { var v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v || f; }
  function drawMap() {
    var c = els.map; if (!c) return;
    var g = c.getContext("2d"); var W = c.width, H = c.height;
    g.fillStyle = cssVar("--bg-card", "#0f1720"); g.fillRect(0, 0, W, H);
    var nodes = state.nodes.slice();
    // ensure self present
    if (!nodes.some(function (n) { return n.fp === fp; })) {
      nodes.push({ fp: fp, node: myNode, label: myLabel, rx: state.rxCount, tx: state.txCount, heard: heardList(), self: true });
    }
    var cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 70;
    var pos = {};
    nodes.forEach(function (n, i) {
      var a = (i / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
      pos[n.fp] = { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R };
    });
    // edges: for each node, its "heard" ALINK nodes → link to matching fp(s)
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
    // nodes
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
      g.fillText("Čekám na další nody… (otevři chirpdev na dalším zařízení)", cx, cy + R + 40);
    }
  }

  // ---- wire up ----
  els.micBtn.addEventListener("click", function () { if (state.running) stopMic(); else startMic(); });

  applyParams(readParams());
  drawMap();
  poll();
  setInterval(poll, 1500);
  setInterval(heartbeat, 3000);
  setInterval(function () { if (state.rx.length) renderRx(); }, 1000);

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
    fetch("/build-info.json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (info) {
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
      els.buildMeta.title = info.deployedAt || "";
    }).catch(function () {});
  })();

  log("chirpdev připraven · node " + myNode + " (" + myLabel + ")");
})();
