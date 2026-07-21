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

  var SYNC_MARGIN = 16;
  var DATA_MARGIN = 12;
  var REFRACTORY_MS = 140;
  var THEME_KEY = "het68-theme";

  var STRINGS = {
    cs: {
      locale: "cs-CZ",
      idle: "nečinné",
      listening: "poslouchám",
      askingMic: "žádám o mikrofon…",
      error: "chyba",
      startMic: "Spustit mikrofon",
      stopMic: "Zastavit mikrofon",
      signalDash: "signál —",
      signalLine: function (sig, noise) {
        return "signál " + sig + " dB · šum " + noise + " dB";
      },
      detections: function (n) {
        return "detekcí: " + n;
      },
      emptyNodes: "Zatím nic nezachyceno.",
      needTwoNodes: "Potřeba alespoň 2 nody.",
      phone: "telefon",
      waitingChirp: "Čekám na chirp…",
      noGetUserMedia: "Tento prohlížeč nepodporuje přístup k mikrofonu (getUserMedia).",
      needHttps: "Mikrofon vyžaduje zabezpečený kontext (HTTPS).",
      micFailed: function (msg) {
        return "Přístup k mikrofonu selhal: " + msg;
      },
      micStarted: function (sr, bin) {
        return "mikrofon spuštěn · sample " + sr + " Hz · bin " + bin + " Hz";
      },
      micStopped: "mikrofon zastaven",
      packetIncomplete: function (s) {
        return "packet neúplný [" + s + "]";
      },
      checksumFail: function (d0, d1, d2, chk) {
        return "kontrolní součet nesouhlasí [" + d0 + " " + d1 + " " + d2 + " · chk " + chk + "]";
      },
      decoded: function (id, level) {
        return "dekódováno id=" + id + " · signál " + level + " dB";
      },
      emitLog: function (idc, d0, d1, d2, chk) {
        return "emit id=" + idc + " symbols [" + d0 + " " + d1 + " " + d2 + " · chk " + chk + "]";
      },
      calibNoSignal: "kalibrace: zatím žádný signál",
      calibrated: function (db) {
        return "kalibrováno: " + db + " dB = 1 m";
      },
      nodesCleared: "nody vymazány",
      ready: "het68 chirp dekodér připraven · protokol v1 (SYNC 14,5 kHz + 8-FSK 15–18,5 kHz)",
      deployed: "nasazeno",
      freqDash: "dominantní —",
      freqLine: function (hz, db) {
        return "dominantní " + hz + " · " + db + " dB";
      },
      axisFreq: "Frekvence (kHz)",
      axisTime: "Čas (s)",
      legendDom: "dominantní f",
      legendNow: "teď",
      spectroHint: "osa Y = frekvence · osa X = čas · čára = dominantní f",
      spectroLive: "Živě",
      spectroZoom: "Měřítko",
      spectroScroll: "Posun",
      spectroClear: "Smazat historii",
      spectroPaused: "náhled historie",
      spectroMem: function (sec, kib) {
        return "paměť " + sec + " s · " + kib + " KiB";
      },
      spectroTrim: function (sec) {
        return "spektrogram: uvolňuji paměť, zahazuji data starší než ~" + sec + " s";
      },
      spectroCleared: "historie spektrogramu smazána",
    },
    en: {
      locale: "en-US",
      idle: "idle",
      listening: "listening",
      askingMic: "requesting microphone…",
      error: "error",
      startMic: "Start microphone",
      stopMic: "Stop microphone",
      signalDash: "signal —",
      signalLine: function (sig, noise) {
        return "signal " + sig + " dB · noise " + noise + " dB";
      },
      detections: function (n) {
        return "detections: " + n;
      },
      emptyNodes: "Nothing captured yet.",
      needTwoNodes: "Need at least 2 nodes.",
      phone: "phone",
      waitingChirp: "Waiting for chirp…",
      noGetUserMedia: "This browser does not support microphone access (getUserMedia).",
      needHttps: "Microphone requires a secure context (HTTPS).",
      micFailed: function (msg) {
        return "Microphone access failed: " + msg;
      },
      micStarted: function (sr, bin) {
        return "microphone started · sample " + sr + " Hz · bin " + bin + " Hz";
      },
      micStopped: "microphone stopped",
      packetIncomplete: function (s) {
        return "incomplete packet [" + s + "]";
      },
      checksumFail: function (d0, d1, d2, chk) {
        return "checksum mismatch [" + d0 + " " + d1 + " " + d2 + " · chk " + chk + "]";
      },
      decoded: function (id, level) {
        return "decoded id=" + id + " · signal " + level + " dB";
      },
      emitLog: function (idc, d0, d1, d2, chk) {
        return "emit id=" + idc + " symbols [" + d0 + " " + d1 + " " + d2 + " · chk " + chk + "]";
      },
      calibNoSignal: "calibration: no signal yet",
      calibrated: function (db) {
        return "calibrated: " + db + " dB = 1 m";
      },
      nodesCleared: "nodes cleared",
      ready: "het68 chirp decoder ready · protocol v1 (SYNC 14.5 kHz + 8-FSK 15–18.5 kHz)",
      deployed: "deployed",
      freqDash: "dominant —",
      freqLine: function (hz, db) {
        return "dominant " + hz + " · " + db + " dB";
      },
      axisFreq: "Frequency (kHz)",
      axisTime: "Time (s)",
      legendDom: "dominant f",
      legendNow: "now",
      spectroHint: "Y = frequency · X = time · line = dominant f",
      spectroLive: "Live",
      spectroZoom: "Scale",
      spectroScroll: "Scroll",
      spectroClear: "Clear history",
      spectroPaused: "history view",
      spectroMem: function (sec, kib) {
        return "memory " + sec + " s · " + kib + " KiB";
      },
      spectroTrim: function (sec) {
        return "spectrogram: freeing memory, dropping data older than ~" + sec + " s";
      },
      spectroCleared: "spectrogram history cleared",
    },
    de: {
      locale: "de-DE",
      idle: "inaktiv",
      listening: "hört zu",
      askingMic: "Mikrofon wird angefordert…",
      error: "Fehler",
      startMic: "Mikrofon starten",
      stopMic: "Mikrofon stoppen",
      signalDash: "Signal —",
      signalLine: function (sig, noise) {
        return "Signal " + sig + " dB · Rauschen " + noise + " dB";
      },
      detections: function (n) {
        return "Erkennungen: " + n;
      },
      emptyNodes: "Noch nichts erfasst.",
      needTwoNodes: "Mindestens 2 Nodes nötig.",
      phone: "Telefon",
      waitingChirp: "Warte auf Chirp…",
      noGetUserMedia: "Dieser Browser unterstützt keinen Mikrofonzugriff (getUserMedia).",
      needHttps: "Mikrofon erfordert einen sicheren Kontext (HTTPS).",
      micFailed: function (msg) {
        return "Mikrofonzugriff fehlgeschlagen: " + msg;
      },
      micStarted: function (sr, bin) {
        return "Mikrofon gestartet · Sample " + sr + " Hz · Bin " + bin + " Hz";
      },
      micStopped: "Mikrofon gestoppt",
      packetIncomplete: function (s) {
        return "unvollständiges Paket [" + s + "]";
      },
      checksumFail: function (d0, d1, d2, chk) {
        return "Checksumme falsch [" + d0 + " " + d1 + " " + d2 + " · chk " + chk + "]";
      },
      decoded: function (id, level) {
        return "dekodiert id=" + id + " · Signal " + level + " dB";
      },
      emitLog: function (idc, d0, d1, d2, chk) {
        return "emit id=" + idc + " Symbole [" + d0 + " " + d1 + " " + d2 + " · chk " + chk + "]";
      },
      calibNoSignal: "Kalibrierung: noch kein Signal",
      calibrated: function (db) {
        return "kalibriert: " + db + " dB = 1 m";
      },
      nodesCleared: "Nodes gelöscht",
      ready: "het68 Chirp-Decoder bereit · Protokoll v1 (SYNC 14,5 kHz + 8-FSK 15–18,5 kHz)",
      deployed: "deployed",
      freqDash: "dominant —",
      freqLine: function (hz, db) {
        return "dominant " + hz + " · " + db + " dB";
      },
      axisFreq: "Frequenz (kHz)",
      axisTime: "Zeit (s)",
      legendDom: "dominante f",
      legendNow: "jetzt",
      spectroHint: "Y = Frequenz · X = Zeit · Linie = dominante f",
      spectroLive: "Live",
      spectroZoom: "Maßstab",
      spectroScroll: "Scrollen",
      spectroClear: "Verlauf löschen",
      spectroPaused: "Verlaufsansicht",
      spectroMem: function (sec, kib) {
        return "Speicher " + sec + " s · " + kib + " KiB";
      },
      spectroTrim: function (sec) {
        return "Spektrogramm: Speicher freigeben, Daten älter als ~" + sec + " s verwerfen";
      },
      spectroCleared: "Spektrogramm-Verlauf gelöscht",
    },
  };

  function pageLang() {
    var lang = (document.documentElement.lang || "cs").slice(0, 2).toLowerCase();
    return STRINGS[lang] ? lang : "cs";
  }

  var t = STRINGS[pageLang()];

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
    themeToggle: document.getElementById("themeToggle"),
    spectro: document.getElementById("spectro"),
    domFreq: document.getElementById("domFreq"),
    spectroLive: document.getElementById("spectroLive"),
    spectroZoom: document.getElementById("spectroZoom"),
    spectroScroll: document.getElementById("spectroScroll"),
    spectroClear: document.getElementById("spectroClear"),
    spectroMem: document.getElementById("spectroMem"),
    spectroViewHint: document.getElementById("spectroViewHint"),
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
    refLevel: -42,
    nodes: new Map(),
    domHz: null,
    domDb: null,
    spectroReady: false,
    spectroColMs: 12,
    spectroDirty: true,
    spectroDrawMs: 0,
    spectroSlowStreak: 0,
    spectroImg: null,
    spectroColScratch: null,
    // Ring history (quantized columns). viewEnd=0 → live (right edge = newest).
    histBins: 128,
    histCap: 8000,
    histCount: 0,
    histHead: 0,
    histData: null, // Uint8Array length histCap * histBins
    histDom: null, // Float32Array length histCap
    viewEnd: 0,
    colsPerPx: 1,
    dragScroll: null,
  };

  var SPEC_FMIN = 0;
  var SPEC_FMAX = 20000;
  var SPEC_DB_MIN = -100;
  var SPEC_DB_MAX = -20;
  var SPEC_PAD = { l: 54, r: 14, t: 18, b: 36 };
  var SPEC_CAP_MIN = 2000;
  var SPEC_CAP_MAX = 16000;
  var SPEC_HEAP_RATIO = 0.78;
  var SPEC_ZOOM_STEPS = [0.25, 0.5, 1, 2, 4, 8, 16];

  function now() {
    return performance.now();
  }

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function log(msg) {
    var stamp = new Date().toISOString().slice(11, 23);
    els.log.textContent += (els.log.textContent ? "\n" : "") + "[" + stamp + "] " + msg;
    els.log.scrollTop = els.log.scrollHeight;
  }

  function setStatus(kind, text) {
    els.statusPill.className = "pill" + (kind ? " " + kind : "");
    els.statusPill.textContent = text;
  }

  // ---- Theme --------------------------------------------------------------
  function currentTheme() {
    var cur = document.documentElement.dataset.theme;
    return cur === "light" ? "light" : "dark";
  }

  function applyTheme(theme) {
    var next = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (e) {
      /* ignore */
    }
    if (els.themeToggle) {
      els.themeToggle.textContent = next === "light" ? "\u263e" : "\u2600";
      els.themeToggle.setAttribute("aria-pressed", String(next === "light"));
    }
  }

  if (els.themeToggle) {
    applyTheme(currentTheme());
    els.themeToggle.addEventListener("click", function () {
      applyTheme(currentTheme() === "light" ? "dark" : "light");
      if (state.spectroReady) drawSpectroFrame();
    });
  }

  // ---- Emitter ------------------------------------------------------------
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
    log(t.emitLog(idc, d0, d1, d2, chk));
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
    els.levelMeter.textContent = t.signalLine(
      isFinite(strongest) ? strongest.toFixed(0) : "—",
      isFinite(state.nf) ? state.nf.toFixed(0) : "—"
    );

    updateDominantFreq();
    pushSpectroColumn();

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
      log(t.packetIncomplete(s.join(" ")));
      return;
    }
    var d0 = s[0], d1 = s[1], d2 = s[2], chk = s[3];
    if ((d0 + d1 + d2) % 8 !== chk) {
      log(t.checksumFail(d0, d1, d2, chk));
      return;
    }
    var id = d0 * 64 + d1 * 8 + d2;
    var level = (state.levels[0] + state.levels[1] + state.levels[2]) / 3;
    state.detections += 1;
    state.lastLevel = level;
    upsertNode(id, level);
    els.detMeta.textContent = t.detections(state.detections);
    log(t.decoded(id, level.toFixed(1)));
  }

  function distanceFromLevel(level) {
    var r = Math.pow(10, (state.refLevel - level) / 20);
    return Math.max(0.1, Math.min(60, r));
  }

  function upsertNode(id, level) {
    var ts = Date.now();
    var n = state.nodes.get(id);
    if (!n) {
      n = { id: id, firstSeen: ts, count: 0 };
      state.nodes.set(id, n);
    }
    n.level = level;
    n.dist = distanceFromLevel(level);
    n.lastSeen = ts;
    n.count += 1;
    renderNodes();
    renderMatrix();
  }

  function nodeAngle(id) {
    var h = (id * 2654435761) % 360;
    if (h < 0) h += 360;
    return (h / 360) * 2 * Math.PI;
  }

  function nodePoint(n) {
    var a = nodeAngle(n.id);
    return { x: Math.cos(a) * n.dist, y: Math.sin(a) * n.dist };
  }

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
      els.nodesBody.innerHTML =
        '<tr class="empty"><td colspan="4">' + t.emptyNodes + "</td></tr>";
      return;
    }
    els.nodesBody.innerHTML = list
      .map(function (n) {
        return (
          "<tr><td class='node-id'>#" +
          n.id +
          "</td><td>" +
          fmtDist(n.dist) +
          "</td><td>" +
          n.level.toFixed(0) +
          " dB</td><td>" +
          ago(n.lastSeen) +
          "</td></tr>"
        );
      })
      .join("");
  }

  function renderMatrix() {
    var list = nodesSorted();
    if (list.length < 2) {
      els.matrix.textContent = t.needTwoNodes;
      return;
    }
    var pts = list.map(nodePoint);
    var html = "<table><thead><tr><th></th>";
    list.forEach(function (n) {
      html += "<th>#" + n.id + "</th>";
    });
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

  function fmtHz(hz) {
    if (!isFinite(hz) || hz < 0) return "—";
    if (hz >= 1000) return (hz / 1000).toFixed(hz >= 10000 ? 2 : 3) + " kHz";
    return Math.round(hz) + " Hz";
  }

  function dbToU8(db) {
    var x = (db - SPEC_DB_MIN) / (SPEC_DB_MAX - SPEC_DB_MIN);
    if (x < 0) x = 0;
    if (x > 1) x = 1;
    return (x * 255 + 0.5) | 0;
  }

  function colorRgbForU8(u) {
    var x = u / 255;
    var r, g, b;
    if (x < 0.35) {
      var a = x / 0.35;
      r = (8 + a * 20) | 0;
      g = (12 + a * 80) | 0;
      b = (18 + a * 70) | 0;
    } else if (x < 0.7) {
      var a2 = (x - 0.35) / 0.35;
      r = (28 + a2 * 3) | 0;
      g = (92 + a2 * 99) | 0;
      b = (88 + a2 * 72) | 0;
    } else {
      var a3 = (x - 0.7) / 0.3;
      r = (31 + a3 * 224) | 0;
      g = (191 + a3 * 64) | 0;
      b = (160 + a3 * 95) | 0;
    }
    return [r, g, b];
  }

  function spectroLayout() {
    var c = els.spectro;
    var W = c.width;
    var H = c.height;
    var pad = SPEC_PAD;
    return {
      W: W,
      H: H,
      pad: pad,
      plotX: pad.l,
      plotY: pad.t,
      plotW: W - pad.l - pad.r,
      plotH: H - pad.t - pad.b,
    };
  }

  function freqToY(freq, plotY, plotH) {
    var frac = (SPEC_FMAX - freq) / (SPEC_FMAX - SPEC_FMIN);
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    return plotY + frac * (plotH - 1);
  }

  function ensureHist(cap) {
    var bins = state.histBins;
    var want = Math.max(SPEC_CAP_MIN, Math.min(SPEC_CAP_MAX, cap | 0));
    if (state.histData && state.histCap === want && state.histDom && state.histDom.length === want) {
      return;
    }
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
        var dst = k;
        state.histData.set(
          oldData.subarray(srcPhys * bins, srcPhys * bins + bins),
          dst * bins
        );
        state.histDom[dst] = oldDom[srcPhys];
      }
      state.histCount = keep;
      state.histHead = keep % want;
    } else {
      state.histCount = 0;
      state.histHead = 0;
    }
    if (state.viewEnd > Math.max(0, state.histCount - 1)) {
      state.viewEnd = Math.max(0, state.histCount - 1);
    }
  }

  function histPhys(logicIdx) {
    // logic 0 = oldest, logic count-1 = newest
    return (state.histHead - state.histCount + logicIdx + state.histCap * 4) % state.histCap;
  }

  function histBytesKiB() {
    return Math.round((state.histCap * state.histBins + state.histCap * 4) / 1024);
  }

  function histSpanSec() {
    return (state.histCount * state.spectroColMs) / 1000;
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

  function trimOldest(keepCols, reason) {
    keepCols = Math.max(SPEC_CAP_MIN, Math.min(state.histCount, keepCols | 0));
    if (keepCols >= state.histCount && keepCols >= state.histCap) return false;
    var newCap = Math.max(SPEC_CAP_MIN, Math.min(SPEC_CAP_MAX, keepCols));
    // Pack newest keepCols into a smaller/equal ring.
    var bins = state.histBins;
    var keep = Math.min(state.histCount, newCap);
    var packed = new Uint8Array(newCap * bins);
    var packedDom = new Float32Array(newCap);
    for (var i = 0; i < newCap; i++) packedDom[i] = NaN;
    for (var k = 0; k < keep; k++) {
      var srcLogic = state.histCount - keep + k;
      var srcPhys = histPhys(srcLogic);
      packed.set(
        state.histData.subarray(srcPhys * bins, srcPhys * bins + bins),
        k * bins
      );
      packedDom[k] = state.histDom[srcPhys];
    }
    state.histCap = newCap;
    state.histData = packed;
    state.histDom = packedDom;
    state.histCount = keep;
    state.histHead = keep % newCap;
    clampView();
    state.spectroDirty = true;
    if (reason) log(t.spectroTrim(Math.round(histSpanSec())));
    updateSpectroControls();
    return true;
  }

  function maybePressureTrim() {
    var trimmed = false;
    // Heap pressure (Chrome)
    try {
      var mem = performance.memory;
      if (mem && mem.jsHeapSizeLimit > 0) {
        if (mem.usedJSHeapSize / mem.jsHeapSizeLimit > SPEC_HEAP_RATIO) {
          trimmed = trimOldest(Math.floor(state.histCount * 0.5), "heap") || trimmed;
        }
      }
    } catch (e) {
      /* ignore */
    }
    // Slow draw streak → drop oldest half / shrink cap
    if (state.spectroSlowStreak >= 8) {
      trimmed = trimOldest(Math.floor(state.histCount * 0.55), "slow") || trimmed;
      state.spectroSlowStreak = 0;
      // Prefer zooming out slightly to reduce work
      if (state.colsPerPx < 8) {
        state.colsPerPx = SPEC_ZOOM_STEPS[
          Math.min(SPEC_ZOOM_STEPS.length - 1, SPEC_ZOOM_STEPS.indexOf(state.colsPerPx) + 1)
        ] || state.colsPerPx * 2;
        if (els.spectroZoom) {
          var zi = SPEC_ZOOM_STEPS.indexOf(state.colsPerPx);
          if (zi >= 0) els.spectroZoom.value = String(zi);
        }
      }
    }
    return trimmed;
  }

  function pushHistColumn(colU8, domHz) {
    ensureHist(state.histCap || 8000);
    var bins = state.histBins;
    var at = state.histHead;
    state.histData.set(colU8, at * bins);
    state.histDom[at] = isFinite(domHz) ? domHz : NaN;
    state.histHead = (at + 1) % state.histCap;
    if (state.histCount < state.histCap) state.histCount += 1;
    // Live follow: keep viewEnd at 0. If reviewing, stay put (history grows on the right of buffer).
    if (state.viewEnd > 0) {
      // oldest dropped when full → shift viewEnd left by 1 so viewport stays on same data
      if (state.histCount === state.histCap) {
        // ring overwrote oldest; logical indices shift — viewEnd measured from newest stays same
      }
    }
    clampView();
  }

  function sampleHistCol(logicIdx, out) {
    if (logicIdx < 0 || logicIdx >= state.histCount) {
      out.fill(0);
      return false;
    }
    var phys = histPhys(logicIdx);
    out.set(state.histData.subarray(phys * state.histBins, phys * state.histBins + state.histBins));
    return true;
  }

  function sampleHistDom(logicIdx) {
    if (logicIdx < 0 || logicIdx >= state.histCount) return NaN;
    return state.histDom[histPhys(logicIdx)];
  }

  function updateSpectroControls() {
    var lay = spectroLayout();
    var span = viewSpanCols(lay.plotW);
    var maxEnd = Math.max(0, state.histCount - span);
    if (els.spectroScroll) {
      els.spectroScroll.max = String(Math.max(1, maxEnd));
      // slider max = live (viewEnd 0), slider 0 = oldest
      els.spectroScroll.value = String(Math.max(0, maxEnd - state.viewEnd));
      els.spectroScroll.disabled = maxEnd <= 0;
    }
    if (els.spectroLive) {
      els.spectroLive.classList.toggle("is-active", state.viewEnd === 0);
    }
    if (els.spectroMem) {
      els.spectroMem.textContent = t.spectroMem(
        histSpanSec().toFixed(1),
        String(histBytesKiB())
      );
    }
    if (els.spectroViewHint) {
      els.spectroViewHint.textContent =
        state.viewEnd === 0 ? t.legendNow : t.spectroPaused;
    }
  }

  function drawSpectroFrame() {
    var c = els.spectro;
    if (!c) return;
    ensureHist(state.histCap || 8000);
    var lay = spectroLayout();
    clampView();
    var g = c.getContext("2d");
    var t0 = performance.now();

    g.fillStyle = cssVar("--bg-card", "#0f1720");
    g.fillRect(0, 0, lay.W, lay.H);
    g.fillStyle = "#05080a";
    g.fillRect(lay.plotX, lay.plotY, lay.plotW, lay.plotH);

    var span = viewSpanCols(lay.plotW);
    var endLogic = state.histCount - 1 - state.viewEnd;
    var startLogic = endLogic - span + 1;
    if (
      !state.spectroImg ||
      state.spectroImg.width !== lay.plotW ||
      state.spectroImg.height !== lay.plotH
    ) {
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
        px[o] = rgb[0];
        px[o + 1] = rgb[1];
        px[o + 2] = rgb[2];
        px[o + 3] = 255;
      }
    }
    g.putImageData(img, lay.plotX, lay.plotY);

    // horizontal grid + Y ticks
    var marks = [0, 2500, 5000, 7500, 10000, 12500, 15000, 17500, 20000];
    g.font = "11px Manrope, sans-serif";
    g.fillStyle = cssVar("--muted", "#9aa8b5");
    g.strokeStyle = "rgba(148,163,184,0.16)";
    g.lineWidth = 1;
    g.textAlign = "right";
    g.textBaseline = "middle";
    for (var i = 0; i < marks.length; i++) {
      var f = marks[i];
      var y = freqToY(f, lay.plotY, lay.plotH);
      g.beginPath();
      g.moveTo(lay.plotX, y);
      g.lineTo(lay.plotX + lay.plotW, y);
      g.stroke();
      g.fillText((f / 1000).toFixed(f % 1000 === 0 ? 0 : 1), lay.plotX - 8, y);
    }

    function bandLine(freq, color) {
      var yb = freqToY(freq, lay.plotY, lay.plotH);
      g.strokeStyle = color;
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(lay.plotX, yb);
      g.lineTo(lay.plotX + lay.plotW, yb);
      g.stroke();
      g.setLineDash([]);
    }
    bandLine(PROTO.syncFreq, "rgba(59,130,246,0.55)");
    bandLine(PROTO.dataFreqs[0], "rgba(31,191,160,0.4)");
    bandLine(PROTO.dataFreqs[7], "rgba(31,191,160,0.4)");

    // dominant frequency graph across visible window
    g.strokeStyle = "#f59e0b";
    g.lineWidth = 2;
    g.lineJoin = "round";
    g.beginPath();
    var started = false;
    var lastHz = NaN;
    for (var x2 = 0; x2 < lay.plotW; x2++) {
      var logic2 = startLogic + (x2 / (lay.plotW - 1 || 1)) * (span - 1);
      var hz = sampleHistDom(logic2 | 0);
      if (!isFinite(hz)) {
        started = false;
        continue;
      }
      lastHz = hz;
      var yy = freqToY(hz, lay.plotY, lay.plotH);
      if (!started) {
        g.moveTo(lay.plotX + x2, yy);
        started = true;
      } else {
        g.lineTo(lay.plotX + x2, yy);
      }
    }
    g.stroke();
    if (isFinite(lastHz)) {
      g.fillStyle = "#f59e0b";
      g.beginPath();
      g.arc(
        lay.plotX + lay.plotW - 1,
        freqToY(lastHz, lay.plotY, lay.plotH),
        3.5,
        0,
        Math.PI * 2
      );
      g.fill();
    }

    g.strokeStyle = cssVar("--line", "rgba(148,163,184,0.3)");
    g.lineWidth = 1;
    g.strokeRect(lay.plotX + 0.5, lay.plotY + 0.5, lay.plotW - 1, lay.plotH - 1);

    // X ticks — right edge = age of viewEnd (0 = now when live)
    var rightAgeSec = (state.viewEnd * state.spectroColMs) / 1000;
    var spanSec = (span * state.spectroColMs) / 1000;
    var tickStep = spanSec > 20 ? 5 : spanSec > 10 ? 2 : spanSec > 4 ? 1 : 0.5;
    g.textAlign = "center";
    g.textBaseline = "top";
    g.fillStyle = cssVar("--muted", "#9aa8b5");
    g.strokeStyle = "rgba(148,163,184,0.22)";
    for (var age = rightAgeSec; age <= rightAgeSec + spanSec + 0.001; age += tickStep) {
      var rel = age - rightAgeSec;
      var frac = 1 - rel / spanSec;
      var tx = lay.plotX + frac * (lay.plotW - 1);
      g.beginPath();
      g.moveTo(tx, lay.plotY + lay.plotH);
      g.lineTo(tx, lay.plotY + lay.plotH + 5);
      g.stroke();
      var label =
        age < 0.05 && state.viewEnd === 0
          ? t.legendNow
          : (-age).toFixed(age % 1 === 0 || age >= 10 ? 0 : 1);
      g.fillText(label, tx, lay.plotY + lay.plotH + 8);
    }

    g.fillStyle = cssVar("--muted", "#9aa8b5");
    g.font = "700 11px Manrope, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "bottom";
    g.fillText(t.axisTime, lay.plotX + lay.plotW / 2, lay.H - 2);

    g.save();
    g.translate(14, lay.plotY + lay.plotH / 2);
    g.rotate(-Math.PI / 2);
    g.textBaseline = "middle";
    g.fillText(t.axisFreq, 0, 0);
    g.restore();

    g.font = "700 11px Manrope, sans-serif";
    g.textAlign = "left";
    g.textBaseline = "middle";
    var legX = lay.plotX + 10;
    var legY = lay.plotY + 12;
    g.fillStyle = "rgba(5,8,10,0.55)";
    g.fillRect(legX - 4, legY - 9, 118, 18);
    g.strokeStyle = "#f59e0b";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(legX, legY);
    g.lineTo(legX + 18, legY);
    g.stroke();
    g.fillStyle = "#f59e0b";
    g.fillText(t.legendDom, legX + 24, legY);

    state.spectroReady = true;
    state.spectroDirty = false;
    state.spectroDrawMs = performance.now() - t0;
    if (state.spectroDrawMs > 22) state.spectroSlowStreak += 1;
    else state.spectroSlowStreak = Math.max(0, state.spectroSlowStreak - 1);

    updateSpectroControls();
    maybePressureTrim();
  }

  function clearSpectro() {
    ensureHist(state.histCap || 8000);
    state.histData.fill(0);
    for (var i = 0; i < state.histCap; i++) state.histDom[i] = NaN;
    state.histCount = 0;
    state.histHead = 0;
    state.viewEnd = 0;
    state.spectroDirty = true;
    drawSpectroFrame();
  }

  function updateDominantFreq() {
    if (!state.buf || !state.ctx || !els.domFreq) return;
    var binHz = state.ctx.sampleRate / state.analyser.fftSize;
    var lo = Math.max(1, Math.floor(80 / binHz));
    var hi = Math.min(state.buf.length - 1, Math.floor(SPEC_FMAX / binHz));
    var peakBin = lo;
    var peakDb = -Infinity;
    for (var i = lo; i <= hi; i++) {
      if (state.buf[i] > peakDb) {
        peakDb = state.buf[i];
        peakBin = i;
      }
    }
    state.domHz = peakBin * binHz;
    state.domDb = peakDb;
    // Live readout only when following live edge
    if (state.viewEnd === 0) {
      els.domFreq.textContent = t.freqLine(
        fmtHz(state.domHz),
        isFinite(peakDb) ? peakDb.toFixed(0) : "—"
      );
    }
  }

  function pushSpectroColumn() {
    var c = els.spectro;
    if (!c || !state.buf || !state.ctx) return;
    ensureHist(state.histCap || 8000);
    if (!state.spectroColScratch || state.spectroColScratch.length !== state.histBins) {
      state.spectroColScratch = new Uint8Array(state.histBins);
    }

    var binHz = state.ctx.sampleRate / state.analyser.fftSize;
    var bin0 = Math.max(0, Math.floor(SPEC_FMIN / binHz));
    var bin1 = Math.min(state.buf.length - 1, Math.ceil(SPEC_FMAX / binHz));
    var col = state.spectroColScratch;
    for (var i = 0; i < state.histBins; i++) {
      var frac = i / (state.histBins - 1);
      // i=0 → fMax (top), i=max → fMin (bottom) — match screen Y
      var bin = Math.round(bin1 - frac * (bin1 - bin0));
      col[i] = dbToU8(state.buf[bin]);
    }
    pushHistColumn(col, state.domHz);

    // Redraw: always when live; when reviewing, only refresh mem readout occasionally
    if (state.viewEnd === 0) {
      drawSpectroFrame();
    } else if ((state.histCount & 15) === 0) {
      updateSpectroControls();
      maybePressureTrim();
    }
  }

  function setSpectroLive() {
    state.viewEnd = 0;
    state.spectroDirty = true;
    drawSpectroFrame();
    if (isFinite(state.domHz) && els.domFreq) {
      els.domFreq.textContent = t.freqLine(
        fmtHz(state.domHz),
        isFinite(state.domDb) ? state.domDb.toFixed(0) : "—"
      );
    }
  }

  function bindSpectroControls() {
    ensureHist(8000);
    if (els.spectroZoom) {
      var zi = SPEC_ZOOM_STEPS.indexOf(state.colsPerPx);
      els.spectroZoom.min = "0";
      els.spectroZoom.max = String(SPEC_ZOOM_STEPS.length - 1);
      els.spectroZoom.value = String(zi < 0 ? 2 : zi);
      els.spectroZoom.addEventListener("input", function () {
        var idx = parseInt(els.spectroZoom.value, 10) || 0;
        state.colsPerPx = SPEC_ZOOM_STEPS[idx] || 1;
        clampView();
        drawSpectroFrame();
      });
    }
    if (els.spectroScroll) {
      els.spectroScroll.addEventListener("input", function () {
        var lay = spectroLayout();
        var span = viewSpanCols(lay.plotW);
        var maxEnd = Math.max(0, state.histCount - span);
        var v = parseInt(els.spectroScroll.value, 10) || 0;
        state.viewEnd = Math.max(0, maxEnd - v);
        drawSpectroFrame();
      });
    }
    if (els.spectroLive) {
      els.spectroLive.addEventListener("click", setSpectroLive);
    }
    if (els.spectroClear) {
      els.spectroClear.addEventListener("click", function () {
        clearSpectro();
        log(t.spectroCleared);
      });
    }

    var canvas = els.spectro;
    if (!canvas) return;

    canvas.addEventListener(
      "wheel",
      function (ev) {
        ev.preventDefault();
        var lay = spectroLayout();
        if (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
          var dx = ev.deltaX || ev.deltaY;
          var step = Math.max(1, (viewSpanCols(lay.plotW) / lay.plotW) * Math.abs(dx) * 0.5);
          state.viewEnd += dx > 0 ? step : -step;
          state.viewEnd = Math.round(state.viewEnd);
          clampView();
          drawSpectroFrame();
          return;
        }
        var zi = SPEC_ZOOM_STEPS.indexOf(state.colsPerPx);
        if (zi < 0) zi = 2;
        if (ev.deltaY < 0) zi = Math.max(0, zi - 1);
        else zi = Math.min(SPEC_ZOOM_STEPS.length - 1, zi + 1);
        state.colsPerPx = SPEC_ZOOM_STEPS[zi];
        if (els.spectroZoom) els.spectroZoom.value = String(zi);
        clampView();
        drawSpectroFrame();
      },
      { passive: false }
    );

    canvas.addEventListener("pointerdown", function (ev) {
      var lay = spectroLayout();
      if (
        ev.offsetX < lay.plotX ||
        ev.offsetX > lay.plotX + lay.plotW ||
        ev.offsetY < lay.plotY ||
        ev.offsetY > lay.plotY + lay.plotH
      ) {
        return;
      }
      canvas.setPointerCapture(ev.pointerId);
      state.dragScroll = {
        x: ev.clientX,
        viewEnd: state.viewEnd,
        colsPerPx: state.colsPerPx,
      };
    });
    canvas.addEventListener("pointermove", function (ev) {
      if (!state.dragScroll) return;
      var lay = spectroLayout();
      var dx = ev.clientX - state.dragScroll.x;
      // drag right → look further back
      state.viewEnd = Math.round(
        state.dragScroll.viewEnd + dx * state.dragScroll.colsPerPx
      );
      clampView();
      drawSpectroFrame();
    });
    function endDrag() {
      state.dragScroll = null;
    }
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
  }

  function drawRadar() {
    var c = els.radar;
    var ctx = c.getContext("2d");
    var W = c.width,
      H = c.height;
    var cx = W / 2,
      cy = H / 2;
    var pad = 46;
    var maxR = Math.min(W, H) / 2 - pad;
    ctx.clearRect(0, 0, W, H);

    var list = nodesSorted();
    var maxDist = 4;
    list.forEach(function (n) {
      if (n.dist > maxDist) maxDist = n.dist;
    });
    maxDist = Math.ceil(maxDist);
    var scale = maxR / maxDist;

    ctx.strokeStyle = cssVar("--radar-ring", "rgba(148,163,184,0.22)");
    ctx.fillStyle = cssVar("--radar-label", "rgba(154,168,181,0.8)");
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
    ctx.beginPath();
    ctx.moveTo(cx - maxR, cy);
    ctx.lineTo(cx + maxR, cy);
    ctx.moveTo(cx, cy - maxR);
    ctx.lineTo(cx, cy + maxR);
    ctx.stroke();

    ctx.fillStyle = cssVar("--blue", "#3b82f6");
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = cssVar("--radar-label", "rgba(154,168,181,0.9)");
    ctx.fillText(t.phone, cx + 14, cy + 5);

    ctx.textAlign = "center";
    list.forEach(function (n) {
      var a = nodeAngle(n.id);
      var r = Math.min(maxR, n.dist * scale);
      var x = cx + Math.cos(a) * r;
      var y = cy + Math.sin(a) * r;
      var fresh = Date.now() - n.lastSeen < 4000;
      ctx.fillStyle = fresh ? cssVar("--teal", "#1fbfa0") : "rgba(31,191,160,0.4)";
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = cssVar("--radar-node-text", "#eef3f6");
      ctx.font = "700 18px Manrope, sans-serif";
      ctx.fillText("#" + n.id, x, y - 16);
      ctx.font = "15px Manrope, sans-serif";
      ctx.fillStyle = cssVar("--radar-label", "rgba(154,168,181,0.9)");
      ctx.fillText(fmtDist(n.dist), x, y + 28);
    });

    if (!list.length) {
      ctx.fillStyle = cssVar("--radar-waiting", "rgba(154,168,181,0.7)");
      ctx.font = "20px Manrope, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(t.waitingChirp, cx, cy - maxR - 12);
    }
  }

  function drawLoop() {
    drawRadar();
    if (state.nodes.size) renderNodes();
    state.raf = requestAnimationFrame(drawLoop);
  }

  async function startMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showPermWarn(t.noGetUserMedia);
      return;
    }
    if (!window.isSecureContext) {
      showPermWarn(t.needHttps);
      return;
    }
    try {
      setStatus("", t.askingMic);
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
      els.micBtn.textContent = t.stopMic;
      setStatus("on", t.listening);
      log(
        t.micStarted(
          state.ctx.sampleRate,
          (state.ctx.sampleRate / state.analyser.fftSize).toFixed(1)
        )
      );
      state.pollTimer = setInterval(poll, 12);
      if (!state.raf) drawLoop();
    } catch (e) {
      showPermWarn(t.micFailed(e && e.message ? e.message : e));
      setStatus("err", t.error);
    }
  }

  function stopMic() {
    state.running = false;
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = 0;
    if (state.stream)
      state.stream.getTracks().forEach(function (tr) {
        tr.stop();
      });
    state.stream = null;
    if (state.ctx)
      state.ctx.close().catch(function () {});
    state.ctx = null;
    els.micBtn.textContent = t.startMic;
    setStatus("", t.idle);
    els.levelMeter.textContent = t.signalDash;
    if (els.domFreq) els.domFreq.textContent = t.freqDash;
    state.domHz = null;
    state.domDb = null;
    log(t.micStopped);
  }

  function showPermWarn(text) {
    els.permWarn.textContent = text;
    els.permWarn.hidden = false;
  }

  els.micBtn.addEventListener("click", function () {
    if (state.running) stopMic();
    else startMic();
  });

  els.calibrateBtn.addEventListener("click", function () {
    if (state.lastLevel == null) {
      log(t.calibNoSignal);
      return;
    }
    state.refLevel = state.lastLevel;
    state.nodes.forEach(function (n) {
      n.dist = distanceFromLevel(n.level);
    });
    renderNodes();
    renderMatrix();
    log(t.calibrated(state.refLevel.toFixed(1)));
  });

  els.clearBtn.addEventListener("click", function () {
    state.nodes.clear();
    state.detections = 0;
    els.detMeta.textContent = t.detections(0);
    renderNodes();
    renderMatrix();
    log(t.nodesCleared);
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
        emitChirp(
          parseInt(els.emitId.value, 10) || 0,
          (parseInt(els.emitGain.value, 10) || 0) / 100
        );
      }, 2000);
    }
  });

  (function buildMeta() {
    var el = els.buildMeta;
    if (!el) return;
    fetch("/build-info.json", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (info) {
        if (!info || !info.version) return;
        var parts = ["v" + info.version];
        var d = new Date(info.deployedAt);
        if (!isNaN(d.getTime())) {
          parts.push(t.deployed + " " + d.toLocaleDateString(t.locale));
        }
        if (info.commit) parts.push(info.commit);
        el.textContent = parts.join(" · ");
        el.hidden = false;
        el.title = info.deployedAt || "";
      })
      .catch(function () {});
  })();

  bindSpectroControls();
  clearSpectro();
  drawRadar();
  log(t.ready);
})();
