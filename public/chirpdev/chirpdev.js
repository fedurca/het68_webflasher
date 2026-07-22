/**
 * het68 chirpdev — link tuning playground.
 *
 * - Autotune on two devices: shorten airtime until both sides reliably hear
 *   each other. Every TX is announced over the web backend so peers (and the
 *   room) can score link quality against what was actually sent.
 * - Memory bank: 10 user-named slots storing full link params, map snapshot,
 *   acoustic time-sync estimates, node IDs, and short PCM clips from all sides.
 * - Shares config / presence / autotune / bank via Durable Object (/api/dev/*).
 * - Node map with distance from acoustic delay (speed of sound).
 */
(function () {
  "use strict";
  if (typeof ALINK === "undefined") {
    document.getElementById("permWarn").hidden = false;
    document.getElementById("permWarn").textContent = "ALINK modem se nenačetl.";
    return;
  }

  var THEME_KEY = "het68-theme";
  var SPEED_OF_SOUND = 343;
  var AUDIO_SR = 8000;
  var AUDIO_SAMPLES = 8000; // ~1 s
  var RELIABLE_DEFAULT = 0.75;

  var els = {};
  [
    "micBtn", "statusPill", "meId", "permWarn", "themeToggle",
    "pPre", "pBase", "pStep", "pPreMs", "pDataMs", "pNode",
    "applyLocal", "applyAll", "followRoom", "airInfo", "syncState",
    "txPayload", "txGain", "txOnce", "txAuto", "txStop", "txInfo", "rxStats", "rxBody",
    "atState", "atRounds", "atThresh", "atStart", "atStop", "atApplyBest", "atBest", "atBody",
    "bankSlot", "bankName", "bankSave", "bankLoad", "bankRename", "bankClear", "bankInfo", "bankBody",
    "swPre", "swStep", "swData", "swWin", "sweepStart", "sweepStop", "sweepBest",
    "sweepState", "sweepBody", "map", "mapMeta", "log", "buildMeta",
  ].forEach(function (id) { els[id] = document.getElementById(id); });

  function now() { return performance.now(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function log(m) {
    var s = new Date().toISOString().slice(11, 23);
    els.log.textContent += (els.log.textContent ? "\n" : "") + "[" + s + "] " + m;
    els.log.scrollTop = els.log.scrollHeight;
  }
  function setStatus(kind, txt) {
    els.statusPill.className = "pill" + (kind ? " " + kind : "");
    els.statusPill.textContent = txt;
  }
  function showWarn(t) { els.permWarn.textContent = t; els.permWarn.hidden = false; }

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
    running: false, ctx: null, demod: null, rs: null, wavProc: null, mute: null, stream: null,
    rxCount: 0, txCount: 0, seq: 0,
    rx: [], heard: {},
    lastV: -1, editing: 0,
    nodes: [],
    bank: [],
    autotune: null,
    txAutoTimer: 0,
    sweep: null,
    at: null, // local autotune controller / participant
    ring: null, // Int16 ring for audio capture @ AUDIO_SR
    mapPositions: null,
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
    ALINK.setProfile(p);
    if (state.running && state.ctx) state.demod = new ALINK.Demod(48000);
    var C = ALINK.CONST;
    els.airInfo.textContent =
      "pre " + C.PREAMBLE_HZ + " Hz · hopy " + C.HOPS[0] + "–" + C.HOPS[C.NHOPS - 1] +
      " Hz · air " + airtimeMs(p) + " ms · goodput≈" + Math.round(128000 / airtimeMs(p)) + " b/s";
  }
  function describe(p) {
    return p.preambleHz + "/" + p.hopStepHz + "/" + p.preChipMs + "+" + p.dataChipMs;
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

  // ---- API helpers ----
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
        return d;
      })
      .catch(function () { els.syncState.textContent = "sync chyba"; });
  }
  function autotuneApi(body) {
    return postJson("/api/dev/autotune", body);
  }
  function bankApi(body) {
    return postJson("/api/dev/bank", body);
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
    // Full room snapshot.
    if (d.nodes) {
      applyRemoteConfig(d);
      state.nodes = d.nodes || [];
      state.bank = d.bank || state.bank;
    }
    if (d.autotune) state.autotune = d.autotune;
    if (d.bank && !d.nodes) state.bank = d.bank;
    renderBank();
    renderAutotune();
    if (d.autotune) {
      maybeFollowAutotuneTrial(d.autotune);
      updateMapFromAutotune(d.autotune);
    }
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
    })
      .then(ingestRoom)
      .catch(function () {});
  }

  // ---- Audio ring buffer (for bank clips) ----
  function ensureRing() {
    if (!state.ring) {
      state.ring = { sr: AUDIO_SR, buf: new Int16Array(AUDIO_SAMPLES), w: 0, filled: false };
    }
    return state.ring;
  }
  function pushRingFromFloat(f32, inSr) {
    var ring = ensureRing();
    var ratio = inSr / AUDIO_SR;
    var nOut = Math.floor(f32.length / ratio);
    for (var i = 0; i < nOut; i++) {
      var src = Math.min(f32.length - 1, Math.floor(i * ratio));
      var s = f32[src];
      if (s > 1) s = 1; if (s < -1) s = -1;
      ring.buf[ring.w] = (s * 32767) | 0;
      ring.w++;
      if (ring.w >= ring.buf.length) { ring.w = 0; ring.filled = true; }
    }
  }
  function ringToBase64() {
    var ring = ensureRing();
    var out = new Int16Array(ring.buf.length);
    if (!ring.filled) {
      out.set(ring.buf.subarray(0, ring.w));
    } else {
      out.set(ring.buf.subarray(ring.w));
      out.set(ring.buf.subarray(0, ring.w), ring.buf.length - ring.w);
    }
    var u8 = new Uint8Array(out.buffer);
    var bin = "";
    for (var i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return { b64: btoa(bin), sr: AUDIO_SR, samples: out.length };
  }
  function uploadAudioClip(trialId) {
    try {
      var clip = ringToBase64();
      return autotuneApi({
        action: "audio",
        fp: fp,
        label: myLabel,
        b64: clip.b64,
        sr: clip.sr,
        samples: clip.samples,
        trialId: trialId | 0,
      }).catch(function () {});
    } catch (e) { return Promise.resolve(); }
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
        pushRingFromFloat(ch, micRate);
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
    state.ctx = null; state.demod = null; state.rs = null; state.stream = null;
    els.micBtn.textContent = "Spustit mikrofon";
    setStatus("", "nečinné");
  }

  function bytesToHex(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i++) s += ("0" + u8[i].toString(16)).slice(-2);
    return s;
  }
  function textToBytes(s) {
    var b = [];
    for (var i = 0; i < s.length && b.length < 16; i++) {
      var c = s.charCodeAt(i);
      if (c < 256) b.push(c);
    }
    return new Uint8Array(b);
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

  function onFrame(f) {
    state.rxCount++;
    state.heard[f.nodeId] = f.rho;
    state.rx.unshift({ at: Date.now(), node: f.nodeId, seq: f.seq, rho: f.rho, pl: f.payload });
    if (state.rx.length > 30) state.rx.length = 30;
    if (state.sweep) state.sweep.decoded++;
    renderRx();
    reportAutotuneRx(f);
    drawMap();
  }
  function renderRxStats() {
    var st = state.demod ? state.demod.stats : { decoded: 0, badCrc: 0, detects: 0 };
    els.rxStats.textContent = "dekódováno " + st.decoded + " · CRC " + st.badCrc + " · det " + st.detects;
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

  // Report acoustic RX to backend for web-path quality evaluation.
  function reportAutotuneRx(f) {
    var at = state.autotune;
    if (!at || (!at.active && at.phase !== "sync" && at.phase !== "probe")) return;
    var pl = f.payload || new Uint8Array(0);
    var hex = bytesToHex(pl);
    var text = bytesToText(pl);
    // Autotune payloads start with "A" or "S" (sync).
    if (text.charAt(0) !== "A" && text.charAt(0) !== "S") return;
    var fromFp = null;
    if (at.txRecent) {
      for (var i = at.txRecent.length - 1; i >= 0; i--) {
        if (at.txRecent[i].payloadHex === hex) { fromFp = at.txRecent[i].fp; break; }
      }
    }
    var rxWallMs = Date.now();
    autotuneApi({
      action: "rx_report",
      trialId: at.trialId | 0,
      fp: fp,
      fromFp: fromFp,
      fromNode: f.nodeId,
      seq: f.seq,
      payloadHex: hex,
      ok: true,
      rho: f.rho,
      rxWallMs: rxWallMs,
    }).then(function (d) {
      if (d && d.autotune) state.autotune = d.autotune;
      // Update distance from delay when we matched a TX announce.
      if (fromFp && at.txRecent) {
        var tx = null;
        for (var j = at.txRecent.length - 1; j >= 0; j--) {
          if (at.txRecent[j].payloadHex === hex) { tx = at.txRecent[j]; break; }
        }
        if (tx && tx.txWallMs) {
          var delayMs = rxWallMs - tx.txWallMs;
          // Subtract half airtime as mid-frame estimate; clamp to sane delays.
          var oneWay = delayMs - (tx.airMs || 0) * 0.5;
          if (oneWay > 0.5 && oneWay < 200) {
            autotuneApi({
              action: "sync",
              fpA: fp,
              fpB: fromFp,
              delayMs: oneWay,
            }).then(function (s) {
              if (s && s.autotune) {
                state.autotune = s.autotune;
                updateMapFromAutotune(s.autotune);
                publishMap();
                drawMap();
              }
            }).catch(function () {});
          }
        }
      }
    }).catch(function () {});
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

  function transmitBytes(payloadU8, opts) {
    opts = opts || {};
    var ctx = txContext();
    var fields = {
      nodeId: myNode,
      type: ALINK.TYPE.BEACON,
      seq: state.seq & 0xff,
      flags: ALINK.FLAG.SYNCED,
      keyId: 0,
      nonce: fpHash >>> 0,
      payload: payloadU8,
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

    if (opts.announce !== false && (opts.forceAnnounce || (state.autotune && state.autotune.active))) {
      var trialId = (state.autotune && state.autotune.trialId) || 0;
      var air = airtimeMs(readParams());
      var txWallMs = Date.now();
      autotuneApi({
        action: "tx_announce",
        trialId: trialId,
        fp: fp,
        node: myNode,
        seq: fields.seq,
        payloadHex: bytesToHex(payloadU8),
        txWallMs: txWallMs,
        airMs: air,
      }).catch(function () {});
    }
    return { dur: dur, seq: fields.seq, payload: payloadU8 };
  }

  function transmit() {
    return transmitBytes(textToBytes(els.txPayload.value || ""), { announce: false }).dur;
  }

  function atPayload(kind, trialId, seq) {
    // Compact ASCII tag: kind + trial(2hex) + seq(2hex) + fp(4) ≤ 9 chars.
    var t = ("0" + (trialId & 0xff).toString(16)).slice(-2);
    var s = ("0" + (seq & 0xff).toString(16)).slice(-2);
    return textToBytes(kind + t + s + fp.slice(0, 4));
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

  // ---- Autotune: shorten ladder ----
  function shortenLadder(base) {
    var dataMs = [4, 3, 2.5, 2, 1.5, 1];
    var preMs = [1, 0.75, 0.5, 0.25];
    var list = [];
    // Longest first (reliable), then progressively shorter airtime.
    for (var di = 0; di < dataMs.length; di++) {
      for (var pi = 0; pi < preMs.length; pi++) {
        // Only allow pre ≤ data for stability; skip absurdly short pre on long data later.
        if (preMs[pi] > dataMs[di]) continue;
        list.push({
          preambleHz: base.preambleHz,
          hopBaseHz: base.hopBaseHz,
          hopStepHz: base.hopStepHz,
          preChipMs: preMs[pi],
          dataChipMs: dataMs[di],
        });
      }
    }
    list.sort(function (a, b) { return airtimeMs(b) - airtimeMs(a); });
    // Dedupe identical air configs
    var seen = {};
    return list.filter(function (p) {
      var k = p.preChipMs + ":" + p.dataChipMs;
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
  }

  function onlinePeers() {
    var nodes = state.nodes.slice();
    if (!nodes.some(function (n) { return n.fp === fp; })) {
      nodes.push({ fp: fp, node: myNode, label: myLabel });
    }
    return nodes;
  }

  function updateMapFromAutotune(at) {
    if (!at) return;
    var nodes = onlinePeers();
    var positions = {};
    var pairs = (at.sync && at.sync.pairs) || {};
    // Place self at origin; peers along +x by estimated distance.
    positions[fp] = { fp: fp, node: myNode, label: myLabel, x: 0, y: 0, id: myLabel };
    var angleStep = Math.PI / 6;
    var ai = 0;
    nodes.forEach(function (n) {
      if (n.fp === fp) return;
      var key = fp < n.fp ? fp + "|" + n.fp : n.fp + "|" + fp;
      var pair = pairs[key];
      var dist = pair && pair.distanceM != null ? pair.distanceM : 1 + ai;
      var ang = ai * angleStep;
      positions[n.fp] = {
        fp: n.fp,
        node: n.node,
        label: n.label,
        x: Math.cos(ang) * dist,
        y: Math.sin(ang) * dist,
        id: n.label,
      };
      ai++;
    });
    // Prefer server map if present and has our nodes.
    if (at.map && at.map.nodes && at.map.nodes.length) {
      at.map.nodes.forEach(function (n) {
        if (n && n.fp) positions[n.fp] = n;
      });
    }
    state.mapPositions = positions;
    var maxD = 1;
    Object.keys(positions).forEach(function (k) {
      var p = positions[k];
      var d = Math.sqrt(p.x * p.x + p.y * p.y);
      if (d > maxD) maxD = d;
    });
    if (els.mapMeta) {
      var parts = [];
      Object.keys(pairs).forEach(function (k) {
        var p = pairs[k];
        if (p.distanceM != null) parts.push(k.replace("|", "↔") + " ≈ " + p.distanceM.toFixed(2) + " m");
      });
      els.mapMeta.textContent = parts.length ? parts.join(" · ") : "otisk · vzdálenost z akustického zpoždění";
    }
  }

  function publishMap() {
    if (!state.mapPositions) return;
    var nodes = Object.keys(state.mapPositions).map(function (k) { return state.mapPositions[k]; });
    var maxD = 1;
    nodes.forEach(function (p) {
      var d = Math.sqrt(p.x * p.x + p.y * p.y);
      if (d > maxD) maxD = d;
    });
    autotuneApi({
      action: "map",
      map: { nodes: nodes, scaleM: maxD },
    }).then(function (d) {
      if (d && d.autotune) state.autotune = d.autotune;
    }).catch(function () {});
  }

  // Follower: adopt trial config and contribute TX frames for scoring.
  var lastFollowTrial = -1;
  function maybeFollowAutotuneTrial(at) {
    if (!at || !at.active || !at.config) return;
    if (state.at && state.at.leader) return; // leader drives apply itself
    if (at.trialId === lastFollowTrial) return;
    lastFollowTrial = at.trialId;
    writeParams(at.config);
    applyParams(at.config);
    log("autotune: přejímám trial #" + at.trialId + " · " + describe(at.config));
    contributeTrial(at);
  }

  async function contributeTrial(at) {
    if (!at || !state.running) return;
    if (state.at && state.at.leader) return;
    if (state._contribTrial === at.trialId) return;
    state._contribTrial = at.trialId;
    var rounds = Math.max(2, Math.min(8, parseInt(els.atRounds.value, 10) || 4));
    var cfg = at.config || readParams();
    var air = airtimeMs(cfg);
    var kind = at.phase === "sync" ? "S" : "A";
    // Stagger after leader's opening window when possible.
    await sleep(air + 600);
    for (var i = 0; i < rounds; i++) {
      if (!state.autotune || state.autotune.trialId !== at.trialId || !state.autotune.active) break;
      transmitBytes(atPayload(kind, at.trialId, i), { forceAnnounce: true });
      await sleep(air + 800);
    }
    await uploadAudioClip(at.trialId);
  }

  function renderAutotune() {
    var at = state.autotune;
    if (!at) {
      els.atState.textContent = "nečinné";
      return;
    }
    var phase = at.phase || "idle";
    els.atState.textContent = (at.active ? "běží · " : "") + phase +
      (at.message ? " · " + at.message : "");
    if (at.best) {
      els.atBest.textContent = "nejlepší: " + describe(at.best.config) +
        " · air " + at.best.airMs + " ms · min " + (at.best.minScore * 100).toFixed(0) + "%";
      els.atApplyBest.disabled = false;
    } else {
      els.atBest.textContent = "nejlepší: —";
    }
    var scores = at.scores || [];
    if (!scores.length) {
      els.atBody.innerHTML = '<tr class="empty"><td colspan="6">Zatím žádné zkoušky.</td></tr>';
      return;
    }
    els.atBody.innerHTML = scores.slice().reverse().map(function (r) {
      var p = r.config || {};
      var best = at.best && at.best.trialId === r.trialId;
      return "<tr" + (best ? ' class="sweep-best"' : "") + "><td>" + r.trialId +
        "</td><td>" + (p.preChipMs || "?") + "+" + (p.dataChipMs || "?") +
        "</td><td>" + r.airMs +
        "</td><td>" + Math.round((r.minScore || 0) * 100) + "%" +
        "</td><td>" + Math.round((r.meanScore || 0) * 100) + "%" +
        "</td><td>" + (r.reliable ? "ano" : "ne") + "</td></tr>";
    }).join("");
  }

  async function runAutotuneLeader() {
    if (state.at && state.at.running) return;
    if (!state.running) { log("autotune: nejdřív spusť mikrofon"); return; }
    var peers = onlinePeers();
    if (peers.length < 2) {
      log("autotune: potřeba alespoň 2 online nody (otevři chirpdev na druhém zařízení)");
      return;
    }

    state.at = { running: true, leader: true, busy: false, stop: false };
    var thresh = parseFloat(els.atThresh.value);
    if (!(thresh > 0 && thresh <= 1)) thresh = RELIABLE_DEFAULT;
    var rounds = Math.max(2, Math.min(8, parseInt(els.atRounds.value, 10) || 4));

    try {
      var start = await autotuneApi({ action: "start", fp: fp });
      ingestRoom(start);
      log("autotune: session #" + (start.autotune && start.autotune.sessionId) + " · leader " + myLabel);

      // Sync phase: a few beacons both ways + map seed.
      await autotuneApi({ action: "phase", phase: "sync", message: "časová synchronizace" });
      var base = readParams();
      applyParams(base);
      await pushConfig(base);
      await sleep(800);
      for (var s = 0; s < 3 && !state.at.stop; s++) {
        state.at.busy = true;
        transmitBytes(atPayload("S", 0, s), { forceAnnounce: true });
        state.at.busy = false;
        await sleep(airtimeMs(base) + 900);
      }
      await uploadAudioClip(0);
      publishMap();

      var ladder = shortenLadder(base);
      log("autotune: " + ladder.length + " kandidátů zkrácení, práh " + Math.round(thresh * 100) + "%");

      var lastReliable = null;
      for (var i = 0; i < ladder.length && !state.at.stop; i++) {
        var cfg = ladder[i];
        var air = airtimeMs(cfg);
        writeParams(cfg);
        applyParams(cfg);
        state.at.busy = true;
        var trialRes = await autotuneApi({
          action: "trial",
          config: cfg,
          message: "zkouška " + (i + 1) + "/" + ladder.length + " · air " + air + " ms",
        });
        ingestRoom(trialRes);
        var trialId = trialRes.autotune.trialId;
        log("autotune trial #" + trialId + " · " + describe(cfg) + " · air " + air + " ms");
        await sleep(1500); // peers adopt
        // Leader transmits its rounds first, then waits for follower contributeTrial.
        for (var r = 0; r < rounds && !state.at.stop; r++) {
          transmitBytes(atPayload("A", trialId, r), { forceAnnounce: true });
          await sleep(air + 800);
        }
        await sleep(rounds * (air + 800) + 1500);
        await uploadAudioClip(trialId);

        var scored = await autotuneApi({
          action: "score",
          trialId: trialId,
          config: cfg,
          airMs: air,
          threshold: thresh,
          minSent: nodes.length,
          minLinks: Math.min(2, nodes.length),
          phase: "shorten",
          message: "vyhodnocení #" + trialId,
        });
        ingestRoom(scored);
        var row = scored.score;
        if (row.reliable) {
          lastReliable = cfg;
          log("autotune: OK min=" + Math.round(row.minScore * 100) + "% air=" + air);
        } else {
          log("autotune: FAIL min=" + Math.round(row.minScore * 100) + "% air=" + air);
          // Stop shortening; keep the last reliable (longer) profile if any.
          break;
        }
        state.at.busy = false;
      }

      if (lastReliable) {
        writeParams(lastReliable);
        applyParams(lastReliable);
        await pushConfig(lastReliable);
        publishMap();
        await autotuneApi({
          action: "done",
          message: "spolehlivé minimum air " + airtimeMs(lastReliable) + " ms",
        }).then(ingestRoom);
        log("autotune hotovo · " + describe(lastReliable));
      } else {
        await autotuneApi({
          action: "done",
          message: "žádný spolehlivý profil",
        }).then(ingestRoom);
        log("autotune: nepodařilo se najít spolehlivý profil");
      }
    } catch (e) {
      log("autotune chyba: " + (e && e.message ? e.message : e));
      autotuneApi({ action: "stop", message: "chyba" }).catch(function () {});
    } finally {
      if (state.at) state.at.running = false;
      state.at = null;
      renderAutotune();
    }
  }

  els.atStart.addEventListener("click", function () { runAutotuneLeader(); });
  els.atStop.addEventListener("click", function () {
    if (state.at) state.at.stop = true;
    autotuneApi({ action: "stop", message: "zastaveno uživatelem" })
      .then(ingestRoom)
      .catch(function () {});
  });
  els.atApplyBest.addEventListener("click", function () {
    var at = state.autotune;
    if (!at || !at.best || !at.best.config) return;
    writeParams(at.best.config);
    applyParams(at.best.config);
    pushConfig(at.best.config);
    log("použit autotune profil " + describe(at.best.config));
  });

  // ---- Memory bank ----
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
      els.bankBody.innerHTML = '<tr class="empty"><td colspan="6">—</td></tr>';
      return;
    }
    els.bankBody.innerHTML = bank.map(function (s) {
      if (s.empty) {
        return "<tr><td>" + (s.slot + 1) + "</td><td class='muted'>— prázdný —</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>";
      }
      var when = s.savedAt ? new Date(s.savedAt).toLocaleString("cs-CZ") : "—";
      return "<tr><td>" + (s.slot + 1) + "</td><td>" + (s.name || "Profil") +
        "</td><td>" + (s.airMs != null ? s.airMs + " ms" : "—") +
        "</td><td>" + (s.hasMap ? "ano" : "ne") +
        "</td><td>" + (s.hasAudio ? "ano" : "ne") +
        "</td><td>" + when + "</td></tr>";
    }).join("");
    var slot = parseInt(els.bankSlot.value, 10) || 0;
    var cur = bank[slot];
    if (cur && !cur.empty) {
      els.bankInfo.textContent = "slot " + (slot + 1) + " · " + (cur.name || "") +
        (cur.airMs != null ? " · air " + cur.airMs + " ms" : "");
      if (!els.bankName.value) els.bankName.value = cur.name || "";
    } else {
      els.bankInfo.textContent = "slot " + (slot + 1) + " · prázdný";
    }
  }
  els.bankSlot.addEventListener("change", function () {
    var slot = parseInt(els.bankSlot.value, 10) || 0;
    var cur = (state.bank || [])[slot];
    els.bankName.value = cur && !cur.empty ? (cur.name || "") : "";
    renderBank();
  });

  els.bankSave.addEventListener("click", async function () {
    var slot = parseInt(els.bankSlot.value, 10) || 0;
    var name = (els.bankName.value || "").trim() || ("Profil " + (slot + 1));
    // Capture local audio before save so both sides contribute if possible.
    await uploadAudioClip(state.autotune && state.autotune.trialId);
    if (state.mapPositions) publishMap();
    var profile = {
      config: readParams(),
      map: state.autotune && state.autotune.map,
      sync: state.autotune && state.autotune.sync,
      ids: onlinePeers().map(function (n) {
        return { fp: n.fp, node: n.node, label: n.label };
      }),
      minScore: state.autotune && state.autotune.best ? state.autotune.best.minScore : null,
      meanScore: state.autotune && state.autotune.best ? state.autotune.best.meanScore : null,
    };
    try {
      var d = await bankApi({ action: "save", slot: slot, name: name, profile: profile });
      state.bank = d.bank || state.bank;
      renderBank();
      log("bank: uložen slot " + (slot + 1) + " „" + name + "“");
    } catch (e) {
      log("bank: uložení selhalo");
    }
  });

  els.bankLoad.addEventListener("click", async function () {
    var slot = parseInt(els.bankSlot.value, 10) || 0;
    try {
      var d = await bankApi({ action: "load", slot: slot });
      if (d.error) { log("bank: " + d.error); return; }
      if (d.config) {
        writeParams(d.config);
        applyParams(d.config);
        state.lastV = d.v;
      }
      if (d.autotune) {
        state.autotune = d.autotune;
        updateMapFromAutotune(d.autotune);
      }
      if (d.bank) state.bank = d.bank;
      if (d.slot && d.slot.name) els.bankName.value = d.slot.name;
      renderBank();
      renderAutotune();
      drawMap();
      log("bank: načten slot " + (slot + 1) + (d.slot && d.slot.name ? " „" + d.slot.name + "“" : ""));
    } catch (e) {
      log("bank: načtení selhalo");
    }
  });

  els.bankRename.addEventListener("click", async function () {
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

  els.bankClear.addEventListener("click", async function () {
    var slot = parseInt(els.bankSlot.value, 10) || 0;
    try {
      var d = await bankApi({ action: "clear", slot: slot });
      state.bank = d.bank || state.bank;
      els.bankName.value = "";
      renderBank();
      log("bank: smazán slot " + (slot + 1));
    } catch (e) { log("bank: smazání selhalo"); }
  });

  // ---- Auto sweep (grid) ----
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
    els.sweepBody.innerHTML = "";
    els.sweepBest.disabled = true;
    log("sweep spuštěn: " + grid.length + " sad × " + winS + " s");
    for (var gi = 0; gi < grid.length; gi++) {
      if (state.sweep.stop) break;
      var p = grid[gi];
      writeParams(p); applyParams(p); pushConfig(p);
      els.sweepState.textContent = "sada " + (gi + 1) + "/" + grid.length + " · pre" + p.preambleHz + " step" + p.hopStepHz + " data" + p.dataChipMs;
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
    log("sweep dokončen; nejlepší: " + (state.sweep.best ? describe(state.sweep.best.p) + " (" + Math.round(state.sweep.best.goodput) + " b/s)" : "—"));
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

  // ---- Node map (meters when sync distances available) ----
  function cssVar(n, f) { var v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return v || f; }
  function drawMap() {
    var c = els.map; if (!c) return;
    var g = c.getContext("2d"); var W = c.width, H = c.height;
    g.fillStyle = cssVar("--bg-card", "#0f1720"); g.fillRect(0, 0, W, H);

    var nodes = onlinePeers();
    var positions = state.mapPositions;
    var useMeters = positions && Object.keys(positions).length >= nodes.length;

    var pos = {};
    if (useMeters) {
      var maxD = 0.5;
      nodes.forEach(function (n) {
        var p = positions[n.fp] || { x: 0, y: 0 };
        var d = Math.sqrt(p.x * p.x + p.y * p.y);
        if (d > maxD) maxD = d;
      });
      var scale = (Math.min(W, H) / 2 - 80) / maxD;
      var cx = W / 2, cy = H / 2;
      nodes.forEach(function (n) {
        var p = positions[n.fp] || { x: 0, y: 0 };
        pos[n.fp] = { x: cx + p.x * scale, y: cy - p.y * scale, meters: p };
      });
      // scale bar
      g.strokeStyle = cssVar("--muted", "#9aa8b5");
      g.fillStyle = cssVar("--muted", "#9aa8b5");
      g.font = "11px Manrope, sans-serif";
      var barM = maxD >= 4 ? 2 : 1;
      var barPx = barM * scale;
      g.beginPath(); g.moveTo(24, H - 24); g.lineTo(24 + barPx, H - 24); g.stroke();
      g.fillText(barM + " m", 24, H - 32);
    } else {
      var cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 70;
      nodes.forEach(function (n, i) {
        var a = (i / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
        pos[n.fp] = { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R };
      });
    }

    // edges
    g.lineWidth = 1.5;
    nodes.forEach(function (n) {
      (n.heard || []).forEach(function (hn) {
        nodes.forEach(function (m) {
          if (m.node === hn && m.fp !== n.fp) {
            var a = pos[n.fp], b = pos[m.fp];
            if (!a || !b) return;
            g.strokeStyle = "rgba(31,191,160,0.5)";
            g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
          }
        });
      });
    });
    // distance labels from sync pairs
    var pairs = state.autotune && state.autotune.sync && state.autotune.sync.pairs;
    if (pairs) {
      Object.keys(pairs).forEach(function (k) {
        var pair = pairs[k];
        var a = pos[pair.fpA], b = pos[pair.fpB];
        if (!a || !b || pair.distanceM == null) return;
        g.fillStyle = cssVar("--muted", "#9aa8b5");
        g.font = "600 11px Manrope, sans-serif";
        g.textAlign = "center";
        g.fillText(pair.distanceM.toFixed(2) + " m", (a.x + b.x) / 2, (a.y + b.y) / 2 - 8);
      });
    }

    g.textAlign = "center"; g.textBaseline = "middle";
    nodes.forEach(function (n) {
      var pt = pos[n.fp]; if (!pt) return;
      var isSelf = n.fp === fp;
      g.fillStyle = isSelf ? cssVar("--teal", "#1fbfa0") : "#3b82f6";
      g.beginPath(); g.arc(pt.x, pt.y, 20, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#fff"; g.font = "700 13px Manrope, sans-serif";
      g.fillText("#" + n.node, pt.x, pt.y);
      g.fillStyle = cssVar("--text", "#eef3f6"); g.font = "600 12px Manrope, sans-serif";
      g.fillText((n.label || "") + (isSelf ? " (já)" : ""), pt.x, pt.y - 30);
      g.fillStyle = cssVar("--muted", "#9aa8b5"); g.font = "11px Manrope, sans-serif";
      var extra = "";
      if (pt.meters && (pt.meters.x || pt.meters.y)) {
        extra = " · " + Math.sqrt(pt.meters.x * pt.meters.x + pt.meters.y * pt.meters.y).toFixed(2) + " m";
      }
      g.fillText("rx " + (n.rx || 0) + " · tx " + (n.tx || 0) + extra, pt.x, pt.y + 32);
    });
    if (nodes.length <= 1) {
      g.fillStyle = cssVar("--muted", "#9aa8b5"); g.font = "14px Manrope, sans-serif";
      g.textAlign = "center";
      g.fillText("Čekám na další nody… (otevři chirpdev na dalším zařízení)", W / 2, H / 2 + 40);
    }
  }

  // ---- wire up ----
  els.micBtn.addEventListener("click", function () { if (state.running) stopMic(); else startMic(); });

  applyParams(readParams());
  drawMap();
  poll();
  setInterval(poll, 1200);
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
