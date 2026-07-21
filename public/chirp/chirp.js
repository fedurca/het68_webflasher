(function () {
  "use strict";

  /**
   * het68 chirp protocol v1 (acoustic sync between nodes).
   *
   * Packet: SYNC tone, then 4 data symbols (8-FSK), 60 ms each.
   *   symbols: d0 d1 d2 chk    ID = d0*64 + d1*8 + d2   (0..511)
   *   chk = (d0 + d1 + d2) mod 8
   * Encoder (emit) and decoder share these constants, so they always match.
   */
  var PROTO = {
    syncFreq: 14500,
    dataFreqs: [15000, 15500, 16000, 16500, 17000, 17500, 18000, 18500],
    symbolMs: 60,
  };

  var SYNC_MARGIN = 16; // dB above noise floor for a SYNC tone
  var DATA_MARGIN = 12; // dB above noise floor for a data symbol
  var REFRACTORY_MS = 140; // ignore new SYNC right after a packet
  var SOUND_SPEED = 343; // m/s (for reference / future ToF)

  var els = {
    micBtn: document.getElementById("micBtn"),
    statusPill: document.getElementById("statusPill"),
    permWarn: document.getElementById("permWarn"),
    radar: document.getElementById("radar"),
    levelMeter: document.getElementById("levelMeter"),
    detMeta: document.getElementById("detMeta"),
    nodesBody: document.getElementById("nodesBody"),
    matrix: document.getElementById("matrix"),
    calibrateBtn: document.getElementById("calibrateBtn"),
    clearBtn: document.getElementById("clearBtn"),
    emitId: document.getElementById("emitId"),
    emitGain: document.getElementById("emitGain"),
    emitBtn: document.getElementById("emitBtn"),
    emitLoop: document.getElementById("emitLoop"),
    log: document.getElementById("log"),
    buildMeta: document.getElementById("buildMeta"),
  };

  var state = {
    running: false,
    ctx: null,
    analyser: null,
    stream: null,
    buf: null,
    syncBin: 0,
    dataBins: [],
    pollTimer: 0,
    raf: 0,
    fsm: "IDLE",
    t0: 0,
    nextAt: 0,
    syms: [],
    levels: [],
    lastPacketEnd: 0,
    nf: null,
    detections: 0,
    lastLevel: null,
    refLevel: -42, // dB at 1 m (calibratable)
    nodes: new Map(),
  };

  function now() {
    return performance.now();
  }

  function log(msg) {
    var t = new Date().toISOString().slice(11, 23);
    els.log.textContent += (els.log.textContent ? "\n" : "") + "[" + t + "] " + msg;
    els.log.scrollTop = els.log.scrollHeight;
  }

  function setStatus(kind, text) {
    els.statusPill.className = "pill" + (kind ? " " + kind : "");
    els.statusPill.textContent = text;
  }

  // ---- Emitter (this phone acts as a node) -------------------------------
  var emitCtx = null;
  var emitLoopTimer = 0;

  function emitChirp(id, vol) {
    emitCtx = emitCtx || new (window.AudioContext || window.webkitAudioContext)();
    var ctx = emitCtx;
    if (ctx.state === "suspended") ctx.resume();
    var v = Math.max(0.0001, Math.min(1, vol));
    var idc = Math.max(0, Math.min(511, id | 0));
    var d0 = (idc >> 6) & 7;
    var d1 = (idc >> 3) & 7;
    var d2 = idc & 7;
    var chk = (d0 + d1 + d2) % 8;
    var seq = [
      PROTO.syncFreq,
      PROTO.dataFreqs[d0],
      PROTO.dataFreqs[d1],
      PROTO.dataFreqs[d2],
      PROTO.dataFreqs[chk],
    ];
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = "sine";
    osc.connect(g);
    g.connect(ctx.destination);
    var sym = PROTO.symbolMs / 1000;
    var t0 = ctx.currentTime + 0.06;
    g.gain.setValueAtTime(0.0001, t0);
    for (var i = 0; i < seq.length; i++) {
      var ts = t0 + i * sym;
      osc.frequency.setValueAtTime(seq[i], ts);
      g.gain.setValueAtTime(0.0001, ts);
      g.gain.exponentialRampToValueAtTime(v, ts + 0.006);
      g.gain.setValueAtTime(v, ts + sym - 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, ts + sym);
    }
    var end = t0 + seq.length * sym;
    osc.start(t0);
    osc.stop(end + 0.03);
    log("emit id=" + idc + " symbols [" + d0 + " " + d1 + " " + d2 + " · chk " + chk + "]");
  }

  // ---- Decoder ------------------------------------------------------------
  function binOf(freq) {
    return Math.round(freq / (state.ctx.sampleRate / state.analyser.fftSize));
  }

  function levelAt(bin) {
    var b = state.buf;
    var m = -Infinity;
    for (var i = bin - 1; i <= bin + 1; i++) {
      if (i >= 0 && i < b.length && b[i] > m) m = b[i];
    }
    return m;
  }

  function poll() {
    if (!state.running) return;
    var a = state.analyser;
    a.getFloatFrequencyData(state.buf);

    var syncLvl = levelAt(state.syncBin);
    var dLvls = state.dataBins.map(levelAt);
    var dMax = -Infinity;
    var dIdx = 0;
    for (var i = 0; i < dLvls.length; i++) {
      if (dLvls[i] > dMax) {
        dMax = dLvls[i];
        dIdx = i;
      }
    }

    var bandMin = Math.min(syncLvl, dMax === -Infinity ? syncLvl : Math.min.apply(null, dLvls));
    if (!isFinite(bandMin)) bandMin = -140;
    state.nf = state.nf == null ? bandMin : bandMin < state.nf ? bandMin : state.nf * 0.95 + bandMin * 0.05;

    var strongest = Math.max(syncLvl, dMax);
    els.levelMeter.textContent =
      "signál " + (isFinite(strongest) ? strongest.toFixed(0) : "—") + " dB · šum " +
      (isFinite(state.nf) ? state.nf.toFixed(0) : "—") + " dB";

    var tnow = now();
    if (state.fsm === "IDLE") {
      var syncPresent =
        isFinite(syncLvl) &&
        syncLvl > state.nf + SYNC_MARGIN &&
        syncLvl >= dMax - 2;
      if (syncPresent && tnow - state.lastPacketEnd > REFRACTORY_MS) {
        state.fsm = "CAP";
        state.t0 = tnow;
        state.syms = [];
        state.levels = [];
        // First data symbol center: one symbol after SYNC start + half a symbol.
        state.nextAt = tnow + PROTO.symbolMs * 1.5;
      }
    } else if (state.fsm === "CAP") {
      if (tnow >= state.nextAt) {
        if (dMax > state.nf + DATA_MARGIN) {
          state.syms.push(dIdx);
          state.levels.push(dMax);
        } else {
          state.syms.push(-1);
          state.levels.push(dMax);
        }
        state.nextAt += PROTO.symbolMs;
        if (state.syms.length >= 4) {
          finishPacket();
          state.fsm = "IDLE";
          state.lastPacketEnd = now();
        }
      }
    }
  }

  function finishPacket() {
    var s = state.syms;
    if (s.length < 4 || s.some(function (x) { return x < 0; })) {
      log("packet neúplný [" + s.join(" ") + "]");
      return;
    }
    var d0 = s[0], d1 = s[1], d2 = s[2], chk = s[3];
    if ((d0 + d1 + d2) % 8 !== chk) {
      log("kontrolní součet nesouhlasí [" + d0 + " " + d1 + " " + d2 + " · chk " + chk + "]");
      return;
    }
    var id = d0 * 64 + d1 * 8 + d2;
    var level = (state.levels[0] + state.levels[1] + state.levels[2]) / 3;
    state.detections += 1;
    state.lastLevel = level;
    upsertNode(id, level);
    els.detMeta.textContent = "detekcí: " + state.detections;
    log("dekódováno id=" + id + " · signál " + level.toFixed(1) + " dB");
  }

  function distanceFromLevel(level) {
    var r = Math.pow(10, (state.refLevel - level) / 20);
    return Math.max(0.1, Math.min(60, r));
  }

  function upsertNode(id, level) {
    var t = Date.now();
    var n = state.nodes.get(id);
    if (!n) {
      n = { id: id, firstSeen: t, count: 0 };
      state.nodes.set(id, n);
    }
    n.level = level;
    n.dist = distanceFromLevel(level);
    n.lastSeen = t;
    n.count += 1;
    renderNodes();
    renderMatrix();
  }

  // ---- Geometry (single-mic estimate) ------------------------------------
  function nodeAngle(id) {
    // Stable pseudo-random bearing from the ID (direction is not measurable).
    var h = (id * 2654435761) % 360;
    if (h < 0) h += 360;
    return (h / 360) * 2 * Math.PI;
  }

  function nodePoint(n) {
    var a = nodeAngle(n.id);
    return { x: Math.cos(a) * n.dist, y: Math.sin(a) * n.dist };
  }

  // ---- Rendering ----------------------------------------------------------
  function fmtDist(d) {
    return d < 10 ? d.toFixed(2) + " m" : d.toFixed(1) + " m";
  }

  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + " s";
    return Math.floor(s / 60) + " min";
  }

  function nodesSorted() {
    return Array.from(state.nodes.values()).sort(function (a, b) {
      return a.id - b.id;
    });
  }

  function renderNodes() {
    var list = nodesSorted();
    if (!list.length) {
      els.nodesBody.innerHTML = '<tr class="empty"><td colspan="4">Zatím nic nezachyceno.</td></tr>';
      return;
    }
    els.nodesBody.innerHTML = list
      .map(function (n) {
        return (
          "<tr><td class='node-id'>#" + n.id + "</td><td>" + fmtDist(n.dist) +
          "</td><td>" + n.level.toFixed(0) + " dB</td><td>" + ago(n.lastSeen) + "</td></tr>"
        );
      })
      .join("");
  }

  function renderMatrix() {
    var list = nodesSorted();
    if (list.length < 2) {
      els.matrix.textContent = "Potřeba alespoň 2 nody.";
      return;
    }
    var pts = list.map(nodePoint);
    var html = "<table><thead><tr><th></th>";
    list.forEach(function (n) { html += "<th>#" + n.id + "</th>"; });
    html += "</tr></thead><tbody>";
    for (var i = 0; i < list.length; i++) {
      html += "<tr><th>#" + list[i].id + "</th>";
      for (var j = 0; j < list.length; j++) {
        if (i === j) {
          html += "<td>—</td>";
        } else {
          var dx = pts[i].x - pts[j].x;
          var dy = pts[i].y - pts[j].y;
          html += "<td>" + Math.hypot(dx, dy).toFixed(1) + "</td>";
        }
      }
      html += "</tr>";
    }
    html += "</tbody></table>";
    els.matrix.innerHTML = html;
  }

  function drawRadar() {
    var c = els.radar;
    var ctx = c.getContext("2d");
    var W = c.width, H = c.height;
    var cx = W / 2, cy = H / 2;
    var pad = 46;
    var maxR = Math.min(W, H) / 2 - pad;
    ctx.clearRect(0, 0, W, H);

    var list = nodesSorted();
    var maxDist = 4;
    list.forEach(function (n) { if (n.dist > maxDist) maxDist = n.dist; });
    maxDist = Math.ceil(maxDist);
    var scale = maxR / maxDist;

    // rings
    ctx.strokeStyle = "rgba(148,163,184,0.22)";
    ctx.fillStyle = "rgba(154,168,181,0.8)";
    ctx.font = "18px Manrope, sans-serif";
    ctx.textAlign = "left";
    var rings = 4;
    for (var k = 1; k <= rings; k++) {
      var rr = (maxR * k) / rings;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(((maxDist * k) / rings).toFixed(0) + " m", cx + 4, cy - rr + 16);
    }
    // cross
    ctx.beginPath();
    ctx.moveTo(cx - maxR, cy); ctx.lineTo(cx + maxR, cy);
    ctx.moveTo(cx, cy - maxR); ctx.lineTo(cx, cy + maxR);
    ctx.stroke();

    // phone center
    ctx.fillStyle = "#3b82f6";
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(154,168,181,0.9)";
    ctx.fillText("telefon", cx + 14, cy + 5);

    // nodes
    ctx.textAlign = "center";
    list.forEach(function (n) {
      var a = nodeAngle(n.id);
      var r = Math.min(maxR, n.dist * scale);
      var x = cx + Math.cos(a) * r;
      var y = cy + Math.sin(a) * r;
      var fresh = Date.now() - n.lastSeen < 4000;
      ctx.fillStyle = fresh ? "#1fbfa0" : "rgba(31,191,160,0.4)";
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#eef3f6";
      ctx.font = "700 18px Manrope, sans-serif";
      ctx.fillText("#" + n.id, x, y - 16);
      ctx.font = "15px Manrope, sans-serif";
      ctx.fillStyle = "rgba(154,168,181,0.9)";
      ctx.fillText(fmtDist(n.dist), x, y + 28);
    });

    if (!list.length) {
      ctx.fillStyle = "rgba(154,168,181,0.7)";
      ctx.font = "20px Manrope, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Čekám na chirp…", cx, cy - maxR - 12);
    }
  }

  function drawLoop() {
    drawRadar();
    // keep "last seen" fresh
    if (state.nodes.size) renderNodes();
    state.raf = requestAnimationFrame(drawLoop);
  }

  // ---- Mic lifecycle ------------------------------------------------------
  async function startMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showPermWarn("Tento prohlížeč nepodporuje přístup k mikrofonu (getUserMedia).");
      return;
    }
    if (!window.isSecureContext) {
      showPermWarn("Mikrofon vyžaduje zabezpečený kontext (HTTPS).");
      return;
    }
    try {
      setStatus("", "žádám o mikrofon…");
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      state.ctx = new (window.AudioContext || window.webkitAudioContext)();
      await state.ctx.resume();
      var src = state.ctx.createMediaStreamSource(state.stream);
      state.analyser = state.ctx.createAnalyser();
      state.analyser.fftSize = 4096;
      state.analyser.smoothingTimeConstant = 0;
      src.connect(state.analyser);
      state.buf = new Float32Array(state.analyser.frequencyBinCount);
      state.syncBin = binOf(PROTO.syncFreq);
      state.dataBins = PROTO.dataFreqs.map(binOf);
      state.running = true;
      state.fsm = "IDLE";
      state.nf = null;
      state.lastPacketEnd = 0;
      els.permWarn.hidden = true;
      els.micBtn.textContent = "Zastavit mikrofon";
      setStatus("on", "poslouchám");
      log(
        "mikrofon spuštěn · sample " + state.ctx.sampleRate + " Hz · bin " +
        (state.ctx.sampleRate / state.analyser.fftSize).toFixed(1) + " Hz"
      );
      state.pollTimer = setInterval(poll, 12);
      if (!state.raf) drawLoop();
    } catch (e) {
      showPermWarn("Přístup k mikrofonu selhal: " + (e && e.message ? e.message : e));
      setStatus("err", "chyba");
    }
  }

  function stopMic() {
    state.running = false;
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = 0;
    if (state.stream) state.stream.getTracks().forEach(function (t) { t.stop(); });
    state.stream = null;
    if (state.ctx) state.ctx.close().catch(function () {});
    state.ctx = null;
    els.micBtn.textContent = "Spustit mikrofon";
    setStatus("", "nečinné");
    els.levelMeter.textContent = "signál —";
    log("mikrofon zastaven");
  }

  function showPermWarn(text) {
    els.permWarn.textContent = text;
    els.permWarn.hidden = false;
  }

  // ---- Wiring -------------------------------------------------------------
  els.micBtn.addEventListener("click", function () {
    if (state.running) stopMic();
    else startMic();
  });

  els.calibrateBtn.addEventListener("click", function () {
    if (state.lastLevel == null) {
      log("kalibrace: zatím žádný signál");
      return;
    }
    state.refLevel = state.lastLevel;
    state.nodes.forEach(function (n) {
      n.dist = distanceFromLevel(n.level);
    });
    renderNodes();
    renderMatrix();
    log("kalibrováno: " + state.refLevel.toFixed(1) + " dB = 1 m");
  });

  els.clearBtn.addEventListener("click", function () {
    state.nodes.clear();
    state.detections = 0;
    els.detMeta.textContent = "detekcí: 0";
    renderNodes();
    renderMatrix();
    log("nody vymazány");
  });

  els.emitBtn.addEventListener("click", function () {
    emitChirp(parseInt(els.emitId.value, 10) || 0, (parseInt(els.emitGain.value, 10) || 0) / 100);
  });

  els.emitLoop.addEventListener("change", function () {
    if (emitLoopTimer) {
      clearInterval(emitLoopTimer);
      emitLoopTimer = 0;
    }
    if (els.emitLoop.checked) {
      emitLoopTimer = setInterval(function () {
        emitChirp(parseInt(els.emitId.value, 10) || 0, (parseInt(els.emitGain.value, 10) || 0) / 100);
      }, 2000);
    }
  });

  // ---- Build metadata -----------------------------------------------------
  (function buildMeta() {
    var el = els.buildMeta;
    if (!el) return;
    fetch("/build-info.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) {
        if (!info || !info.version) return;
        var parts = ["v" + info.version];
        var d = new Date(info.deployedAt);
        if (!isNaN(d.getTime())) {
          parts.push("nasazeno " + d.toLocaleDateString("cs-CZ"));
        }
        if (info.commit) parts.push(info.commit);
        el.textContent = parts.join(" · ");
        el.hidden = false;
        el.title = info.deployedAt || "";
      })
      .catch(function () {});
  })();

  // initial paint
  drawRadar();
  log("het68 chirp dekodér připraven · protokol v1 (SYNC 14,5 kHz + 8-FSK 15–18,5 kHz)");
})();
