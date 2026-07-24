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
      buildAgo: function (s) {
        return "před " + s;
      },
      freqDash: "dominantní —",
      freqLine: function (hz, db) {
        return "dominantní " + hz + " · " + db + " dB";
      },
      axisFreq: "Frekvence (kHz)",
      axisTime: "Čas (s)",
      legendDom: "směs / šum",
      legendSine: "sinus",
      legendSquare: "obdélník",
      legendSaw: "pila",
      legendTri: "trojúhelník",
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
      evWhistle: "písknutí",
      evClap: "tlesknutí",
      evSmack: "mlasknutí",
      eventsLabel: "uč. eventy",
      chirpsLabel: "chirpy:",
      chirpRxTx: function (rx, tx) {
        return "přijato " + rx + " · odesláno " + tx;
      },
      domLine: function (a, b, c) {
        return "f  0,1s" + a + "  1s" + b + "  10s" + c;
      },
      evNew: function (l) {
        return "nový event " + l;
      },
      evEvict: function (o, n) {
        return "event " + o + " vyřazen → nový " + n;
      },
      rxEmpty: "Zatím nic přijato.",
      peersEmpty: "Žádné nody.",
      rxStats: function (d, b, det) {
        return "dekódováno " + d + " · CRC chyb " + b + " · detekcí " + det;
      },
      rxCleared: "přijaté chirpy vymazány",
      profileSet: function (p, pre, lo, hi) {
        var name = p === "piezo" ? "Piezo" : p === "custom" ? "dev" : "Telefon";
        return "profil " + name + " · preambule " + pre +
          " Hz · hopy " + lo + "–" + hi + " Hz";
      },
      txBusy: function (kind, left) {
        return (kind === "ping" ? "ping" : "rámec") + " · vysílám " + left + " s";
      },
      txStopped: "vysílání zastaveno",
      queueEmpty: "Zásobník je prázdný.",
      qLoad: "Načíst",
      qSend: "Vyslat",
      qDel: "Odebrat",
      recPause: "Pauza",
      recResume: "Pokračovat",
      recDownload: "Stáhnout WAV",
      recPausedStatus: "pauza záznamu",
      wavEmpty: "není co stáhnout — nejdřív nahrávej",
      wavSaved: function (sec) {
        return "WAV uložen · " + sec + " s";
      },
      eventLog: function (name) {
        return "event: " + name;
      },
      followWaiting: "dev: čekám na konfiguraci · telefonní výchozí",
      followOff: "dev sync vypnut",
      followErr: "dev sync chyba",
      followOk: function (v, pre, lo, hi, preMs, dataMs) {
        return "dev v" + v + " · pre " + pre + " · " + lo + "–" + hi +
          " Hz · chip " + preMs + "/" + dataMs + " ms";
      },
      followApplied: function (v) {
        return "přijato nastavení z dev.het68.cz · v" + v;
      },
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
      buildAgo: function (s) {
        return s + " ago";
      },
      freqDash: "dominant —",
      freqLine: function (hz, db) {
        return "dominant " + hz + " · " + db + " dB";
      },
      axisFreq: "Frequency (kHz)",
      axisTime: "Time (s)",
      legendDom: "mixed / noise",
      legendSine: "sine",
      legendSquare: "square",
      legendSaw: "saw",
      legendTri: "triangle",
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
      evWhistle: "whistle",
      evClap: "clap",
      evSmack: "smack",
      eventsLabel: "learned events",
      chirpsLabel: "chirps:",
      chirpRxTx: function (rx, tx) {
        return "rx " + rx + " · tx " + tx;
      },
      domLine: function (a, b, c) {
        return "f  0.1s" + a + "  1s" + b + "  10s" + c;
      },
      evNew: function (l) {
        return "new event " + l;
      },
      evEvict: function (o, n) {
        return "event " + o + " evicted → new " + n;
      },
      rxEmpty: "Nothing received yet.",
      peersEmpty: "No nodes.",
      rxStats: function (d, b, det) {
        return "decoded " + d + " · CRC errors " + b + " · detects " + det;
      },
      rxCleared: "received chirps cleared",
      profileSet: function (p, pre, lo, hi) {
        var name = p === "piezo" ? "Piezo" : p === "custom" ? "dev" : "Phone";
        return "profile " + name + " · preamble " + pre +
          " Hz · hops " + lo + "–" + hi + " Hz";
      },
      txBusy: function (kind, left) {
        return (kind === "ping" ? "ping" : "frame") + " · transmitting " + left + " s";
      },
      txStopped: "transmission stopped",
      queueEmpty: "Queue is empty.",
      qLoad: "Load",
      qSend: "Send",
      qDel: "Remove",
      recPause: "Pause",
      recResume: "Resume",
      recDownload: "Download WAV",
      recPausedStatus: "recording paused",
      wavEmpty: "nothing to download — record first",
      wavSaved: function (sec) {
        return "WAV saved · " + sec + " s";
      },
      eventLog: function (name) {
        return "event: " + name;
      },
      followWaiting: "dev: waiting for config · phone defaults",
      followOff: "dev sync off",
      followErr: "dev sync error",
      followOk: function (v, pre, lo, hi, preMs, dataMs) {
        return "dev v" + v + " · pre " + pre + " · " + lo + "–" + hi +
          " Hz · chip " + preMs + "/" + dataMs + " ms";
      },
      followApplied: function (v) {
        return "applied link params from dev.het68.cz · v" + v;
      },
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
      deployed: "bereitgestellt",
      buildAgo: function (s) {
        return "vor " + s;
      },
      freqDash: "dominant —",
      freqLine: function (hz, db) {
        return "dominant " + hz + " · " + db + " dB";
      },
      axisFreq: "Frequenz (kHz)",
      axisTime: "Zeit (s)",
      legendDom: "Gemisch / Rauschen",
      legendSine: "Sinus",
      legendSquare: "Rechteck",
      legendSaw: "Säge",
      legendTri: "Dreieck",
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
      evWhistle: "Pfiff",
      evClap: "Klatschen",
      evSmack: "Schmatzen",
      eventsLabel: "gelernte Events",
      chirpsLabel: "Chirps:",
      chirpRxTx: function (rx, tx) {
        return "empf. " + rx + " · gesend. " + tx;
      },
      domLine: function (a, b, c) {
        return "f  0,1s" + a + "  1s" + b + "  10s" + c;
      },
      evNew: function (l) {
        return "neues Event " + l;
      },
      evEvict: function (o, n) {
        return "Event " + o + " verworfen → neu " + n;
      },
      rxEmpty: "Noch nichts empfangen.",
      peersEmpty: "Keine Nodes.",
      rxStats: function (d, b, det) {
        return "dekodiert " + d + " · CRC-Fehler " + b + " · Detektionen " + det;
      },
      rxCleared: "empfangene Chirps gelöscht",
      profileSet: function (p, pre, lo, hi) {
        var name = p === "piezo" ? "Piezo" : p === "custom" ? "dev" : "Telefon";
        return "Profil " + name + " · Präambel " + pre +
          " Hz · Hops " + lo + "–" + hi + " Hz";
      },
      txBusy: function (kind, left) {
        return (kind === "ping" ? "Ping" : "Frame") + " · sende " + left + " s";
      },
      txStopped: "Übertragung gestoppt",
      queueEmpty: "Warteschlange leer.",
      qLoad: "Laden",
      qSend: "Senden",
      qDel: "Entfernen",
      recPause: "Pause",
      recResume: "Weiter",
      recDownload: "WAV laden",
      recPausedStatus: "Aufnahme pausiert",
      wavEmpty: "nichts zum Download — zuerst aufnehmen",
      wavSaved: function (sec) {
        return "WAV gespeichert · " + sec + " s";
      },
      eventLog: function (name) {
        return "Event: " + name;
      },
      followWaiting: "dev: warte auf Konfiguration · Telefon-Defaults",
      followOff: "dev-Sync aus",
      followErr: "dev-Sync Fehler",
      followOk: function (v, pre, lo, hi, preMs, dataMs) {
        return "dev v" + v + " · pre " + pre + " · " + lo + "–" + hi +
          " Hz · Chip " + preMs + "/" + dataMs + " ms";
      },
      followApplied: function (v) {
        return "Link-Parameter von dev.het68.cz übernommen · v" + v;
      },
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
    eventCounts: document.getElementById("eventCounts"),
    recPause: document.getElementById("recPause"),
    recDownload: document.getElementById("recDownload"),
    // ALINK RX
    rxBody: document.getElementById("rxBody"),
    rxStats: document.getElementById("rxStats"),
    peersBody: document.getElementById("peersBody"),
    rxClear: document.getElementById("rxClear"),
    rxFilterSelf: document.getElementById("rxFilterSelf"),
    // ALINK TX
    txNode: document.getElementById("txNode"),
    txType: document.getElementById("txType"),
    txSeq: document.getElementById("txSeq"),
    txSeqAuto: document.getElementById("txSeqAuto"),
    txSynced: document.getElementById("txSynced"),
    txAck: document.getElementById("txAck"),
    txEnc: document.getElementById("txEnc"),
    txKeyId: document.getElementById("txKeyId"),
    txNonce: document.getElementById("txNonce"),
    txPayload: document.getElementById("txPayload"),
    txPayloadLen: document.getElementById("txPayloadLen"),
    txProfile: document.getElementById("txProfile"),
    txGain: document.getElementById("txGain"),
    txSend: document.getElementById("txSend"),
    txShort: document.getElementById("txShort"),
    txStop: document.getElementById("txStop"),
    txQueueAdd: document.getElementById("txQueueAdd"),
    txInfo: document.getElementById("txInfo"),
    queueList: document.getElementById("queueList"),
    queueClear: document.getElementById("queueClear"),
    followDev: document.getElementById("followDev"),
    devSyncState: document.getElementById("devSyncState"),
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
    demod: null,
    rs: null,
    rx: [],
    peers: new Map(),
    chirpRx: 0,
    chirpTx: 0,
    filterSelf: false,
    domRing: [],
    lastDomDraw: 0,
    rxStats: { decoded: 0, badCrc: 0, detects: 0 },
    rxTick: 0,
    queue: [],
    ageTimer: 0,
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
    histShape: null, // Uint8Array length histCap — waveform class per column
    domShape: 0,
    viewEnd: 0,
    colsPerPx: 1,
    dragScroll: null,
    colSeq: 0,
    events: [],
    categories: [],
    letterNext: 0,
    eventProfile: new Float32Array(24),
    eventPrev: null,
    fluxMean: 0,
    fluxDev: 0,
    eventArmed: false,
    recPaused: false,
    timeBuf: null,
    rmsFloor: 0.004,
    lastEventAt: 0,
    micSrc: null,
    wavProc: null,
    wavMute: null,
    wav: null, // Int16 ring
    wavCap: 0,
    wavHead: 0,
    wavCount: 0,
    wavRate: 0,
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
  // Waveform classes for pure dominant tones
  var SHAPE_NONE = 0;
  var SHAPE_SINE = 1;
  var SHAPE_SQUARE = 2;
  var SHAPE_SAW = 3;
  var SHAPE_TRI = 4;
  var SHAPE_COLOR = {
    0: "#f59e0b",
    1: "#2dd4bf",
    2: "#e879f9",
    3: "#fbbf24",
    4: "#60a5fa",
  };

  // Learned-event tuning
  var EVENT_BANDS = 24;
  var EVENT_FMIN = 80;
  var EVENT_FMAX = 18000;
  var EVENT_MAX_CATEGORIES = 3;
  var EVENT_MATCH_SIM = 0.86; // cosine similarity to count as the "same" event
  var EVENT_LEARN = 0.25; // prototype adaptation rate
  var EVENT_FLUX_K = 2.2; // adaptive threshold: mean + K*dev
  var EVENT_FLUX_MIN = 0.12; // absolute flux floor (normalized-profile units)
  var EVENT_MIN_LOUD = 6; // ignore onsets when the band sum is tiny
  var EVENT_REFRACTORY_MS = 140;
  var EVENT_ARM_RATIO = 0.4; // disarm once flux falls below thresh*ratio
  var EVENT_PALETTE = ["#f472b6", "#38bdf8", "#c084fc", "#fb923c", "#34d399", "#facc15"];

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

  // ---- Theme (shared cookie via /theme.js) --------------------------------
  function currentTheme() {
    if (window.HET68Theme) return window.HET68Theme.get();
    var cur = document.documentElement.dataset.theme;
    return cur === "light" ? "light" : "dark";
  }

  function applyTheme(theme) {
    var next = window.HET68Theme
      ? window.HET68Theme.apply(theme)
      : theme === "light"
        ? "light"
        : "dark";
    if (!window.HET68Theme) {
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
    return next;
  }

  applyTheme(currentTheme());
  document.addEventListener("het68-theme", function () {
    if (state.spectroReady) drawSpectroFrame();
  });
  if (els.themeToggle && !window.HET68Theme) {
    els.themeToggle.addEventListener("click", function () {
      applyTheme(currentTheme() === "light" ? "dark" : "light");
      if (state.spectroReady) drawSpectroFrame();
    });
  }

  // ---- Transmitter (ALINK DSSS-BPSK per het68 chirp spec) ----------------
  //
  // A full spec frame is 127 preamble + 3472 data chips × 2 ms = ~7.2 s on
  // air — a long steady 4 kHz buzz by design (DSSS processing gain). That is
  // not a bug; for a quick audible check use the short preamble-only ping.
  var txCtx = null;
  var txSource = null;
  var txEndTimer = 0;
  var txCountTimer = 0;
  var txActiveUntil = 0; // performance.now() when the current TX ends

  function txAudioContext() {
    if (!txCtx) {
      try {
        txCtx = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 48000,
        });
      } catch (e) {
        txCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
    }
    if (txCtx.state === "suspended") txCtx.resume();
    return txCtx;
  }

  function txBusy() {
    return !!txSource;
  }

  function stopTx() {
    if (txSource) {
      try {
        txSource.onended = null;
        txSource.stop();
      } catch (e) {
        /* already stopped */
      }
      try {
        txSource.disconnect();
      } catch (e2) {
        /* ignore */
      }
      txSource = null;
    }
    if (txEndTimer) {
      clearTimeout(txEndTimer);
      txEndTimer = 0;
    }
    if (txCountTimer) {
      clearInterval(txCountTimer);
      txCountTimer = 0;
    }
    setTxEnabled(true);
  }

  function setTxEnabled(on) {
    if (els.txSend) els.txSend.disabled = !on;
    if (els.txShort) els.txShort.disabled = !on;
    if (els.txStop) els.txStop.disabled = on;
  }

  /** Play modulated samples as a single (non-overlapping) transmission. */
  function playSamples(samples, ctx, label) {
    stopTx(); // never overlap
    var audio = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    audio.getChannelData(0).set(samples);
    var srcNode = ctx.createBufferSource();
    srcNode.buffer = audio;
    srcNode.connect(ctx.destination);
    var dur = samples.length / ctx.sampleRate;
    srcNode.onended = function () {
      if (txSource === srcNode) stopTx();
    };
    srcNode.start();
    txSource = srcNode;
    txActiveUntil = now() + dur * 1000;
    setTxEnabled(false);
    // Safety stop + live countdown.
    txEndTimer = setTimeout(function () {
      if (txSource === srcNode) stopTx();
    }, dur * 1000 + 250);
    var endAt = now() + dur * 1000;
    if (txCountTimer) clearInterval(txCountTimer);
    txCountTimer = setInterval(function () {
      var left = Math.max(0, (endAt - now()) / 1000);
      if (els.txInfo) els.txInfo.textContent = t.txBusy(label, left.toFixed(1));
      if (left <= 0 && txCountTimer) {
        clearInterval(txCountTimer);
        txCountTimer = 0;
      }
    }, 100);
    return dur;
  }

  /** Transmit one full ALINK frame; returns air-time seconds. */
  function transmitFrame(fields, gain) {
    if (typeof ALINK === "undefined") {
      log("ALINK unavailable");
      return 0;
    }
    var ctx = txAudioContext();
    var samples = ALINK.modulateFrame(fields, ctx.sampleRate, {
      gain: Math.max(0.02, Math.min(1, gain == null ? 0.6 : gain)),
    });
    return playSamples(samples, ctx, "frame");
  }

  /** Short preamble-only ping (~8 ms) — quick audible TX/mic check. */
  function transmitPreamble(nodeId, gain) {
    if (typeof ALINK === "undefined") return 0;
    var ctx = txAudioContext();
    var code = ALINK.nodeCode(nodeId); // Int8Array(31) of ±1
    var samples = ALINK.modulate(code, ctx.sampleRate, {
      gain: Math.max(0.02, Math.min(1, gain == null ? 0.6 : gain)),
    });
    return playSamples(samples, ctx, "ping");
  }

  function bandMeanDb(f0, f1) {
    if (!state.ctx || !state.buf) return -140;
    var binHz = state.ctx.sampleRate / state.analyser.fftSize;
    var i0 = Math.max(1, Math.floor(f0 / binHz));
    var i1 = Math.min(state.buf.length - 1, Math.ceil(f1 / binHz));
    if (i1 <= i0) return -140;
    var s = 0;
    for (var i = i0; i <= i1; i++) s += state.buf[i];
    return s / (i1 - i0 + 1);
  }

  function ensureWav(rate) {
    var maxSec = Math.max(30, Math.ceil((state.histCap * state.spectroColMs) / 1000) + 5);
    var cap = Math.min(rate * maxSec, rate * 120);
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

  function trimWavToSec(sec) {
    if (!state.wav || !state.wavRate) return;
    var keep = Math.min(state.wavCount, Math.floor(sec * state.wavRate));
    if (keep >= state.wavCount) return;
    var packed = new Int16Array(state.wavCap);
    var start = (state.wavHead - keep + state.wavCap * 4) % state.wavCap;
    for (var i = 0; i < keep; i++) {
      packed[i] = state.wav[(start + i) % state.wavCap];
    }
    state.wav = packed;
    state.wavCount = keep;
    state.wavHead = keep % state.wavCap;
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
      log(t.wavEmpty);
      return;
    }
    var blob = encodeWavBlob(samples, state.wavRate);
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var sec = (samples.length / state.wavRate).toFixed(1);
    a.href = url;
    a.download = "het68-chirp-" + new Date().toISOString().replace(/[:.]/g, "-") + ".wav";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 2000);
    log(t.wavSaved(sec));
  }

  // ---- Learned events (adaptive onset + online clustering) ---------------
  //
  // An "event" = a significant change in the signal (spectral-flux onset).
  // Each onset is described by a coarse spectral profile and a significance
  // (the change magnitude). Recurring profiles are clustered; we keep at most
  // EVENT_MAX_CATEGORIES categories labeled A, B, C, … When a new, more
  // significant category appears, the least significant one is evicted and the
  // new one gets the next alphabet letter.

  function computeBandProfile(out) {
    // Fill `out` (Float32Array[EVENT_BANDS]) with L2-normalized band amplitudes,
    // return total loudness (sum of amplitudes above the noise floor).
    if (!state.buf || !state.ctx) return 0;
    var binHz = state.ctx.sampleRate / state.analyser.fftSize;
    var floorDb = isFinite(state.nf) ? state.nf : -100;
    var total = 0;
    for (var b = 0; b < EVENT_BANDS; b++) {
      var f0 = EVENT_FMIN * Math.pow(EVENT_FMAX / EVENT_FMIN, b / EVENT_BANDS);
      var f1 = EVENT_FMIN * Math.pow(EVENT_FMAX / EVENT_FMIN, (b + 1) / EVENT_BANDS);
      var i0 = Math.max(1, Math.floor(f0 / binHz));
      var i1 = Math.min(state.buf.length - 1, Math.max(i0, Math.ceil(f1 / binHz)));
      var m = -Infinity;
      for (var i = i0; i <= i1; i++) if (state.buf[i] > m) m = state.buf[i];
      var amp = isFinite(m) ? Math.max(0, m - floorDb) : 0;
      out[b] = amp;
      total += amp;
    }
    var norm = 0;
    for (var b2 = 0; b2 < EVENT_BANDS; b2++) norm += out[b2] * out[b2];
    norm = Math.sqrt(norm) || 1;
    for (var b3 = 0; b3 < EVENT_BANDS; b3++) out[b3] /= norm;
    return total;
  }

  function profileCosine(a, c) {
    var dot = 0;
    for (var i = 0; i < EVENT_BANDS; i++) dot += a[i] * c[i];
    return dot; // both unit vectors → cosine similarity
  }

  function nextEventColor(idx) {
    return EVENT_PALETTE[idx % EVENT_PALETTE.length];
  }

  function pad(str, w) {
    str = String(str);
    while (str.length < w) str = " " + str;
    return str;
  }

  // Chirp counters (replaces the old learned-event counting).
  function renderChirpCounts() {
    if (!els.eventCounts) return;
    els.eventCounts.textContent =
      t.chirpsLabel + " " + t.chirpRxTx(pad(state.chirpRx, 3), pad(state.chirpTx, 3));
  }
  // Back-compat alias (older call sites).
  function renderEventCounts() {
    renderChirpCounts();
  }

  function pruneEvents() {
    var minSeq = state.colSeq - state.histCount;
    if (state.events.length) {
      state.events = state.events.filter(function (e) {
        return e.seq >= minSeq;
      });
    }
    if (state.events.length > 300) state.events = state.events.slice(-260);
  }

  function classifyIntoCategory(profile, significance) {
    // Match against known categories.
    var best = -1;
    var bestSim = -1;
    for (var i = 0; i < state.categories.length; i++) {
      var sim = profileCosine(profile, state.categories[i].proto);
      if (sim > bestSim) {
        bestSim = sim;
        best = i;
      }
    }
    if (best >= 0 && bestSim >= EVENT_MATCH_SIM) {
      var cat = state.categories[best];
      // Update running prototype + significance, bump count.
      for (var k = 0; k < EVENT_BANDS; k++) {
        cat.proto[k] = cat.proto[k] * (1 - EVENT_LEARN) + profile[k] * EVENT_LEARN;
      }
      cat.sig = Math.max(cat.sig * 0.9, significance);
      cat.count += 1;
      cat.lastSeq = state.colSeq;
      return cat;
    }

    // New distinct category.
    var newCat = {
      letter: String.fromCharCode(65 + state.letterNext),
      colorIdx: state.letterNext,
      proto: profile.slice(),
      sig: significance,
      count: 1,
      lastSeq: state.colSeq,
    };

    if (state.categories.length < EVENT_MAX_CATEGORIES) {
      state.letterNext += 1;
      state.categories.push(newCat);
      log(t.evNew(newCat.letter));
      return newCat;
    }

    // At capacity: evict the least significant only if the newcomer beats it.
    var minIdx = 0;
    for (var m = 1; m < state.categories.length; m++) {
      if (state.categories[m].sig < state.categories[minIdx].sig) minIdx = m;
    }
    if (significance <= state.categories[minIdx].sig) {
      return null; // not significant enough to be tracked
    }
    var evicted = state.categories[minIdx];
    state.letterNext += 1;
    state.categories[minIdx] = newCat;
    log(t.evEvict(evicted.letter, newCat.letter));
    return newCat;
  }

  function detectSignalEvents() {
    if (!state.buf || !state.ctx) return;
    var loud = computeBandProfile(state.eventProfile);

    // Spectral flux: positive change of the (loudness-normalized) profile.
    // Normalized so it responds to a *shape* change (new frequency content),
    // not merely to a tone getting louder — this is what "significant change"
    // means here. Range ≈ 0 (steady) … ~1.4 (silence → strong tone).
    var flux = 0;
    if (state.eventPrev) {
      for (var i = 0; i < EVENT_BANDS; i++) {
        var d = state.eventProfile[i] - state.eventPrev[i];
        if (d > 0) flux += d;
      }
    }
    var tmp = state.eventPrev;
    state.eventPrev = state.eventProfile;
    state.eventProfile = tmp || new Float32Array(EVENT_BANDS);

    // Adaptive threshold from a slow running mean + deviation of the flux.
    state.fluxMean = state.fluxMean * 0.95 + flux * 0.05;
    state.fluxDev = state.fluxDev * 0.95 + Math.abs(flux - state.fluxMean) * 0.05;
    var thresh = state.fluxMean + EVENT_FLUX_K * state.fluxDev + EVENT_FLUX_MIN;

    var tnow = now();
    var quiet = loud <= EVENT_MIN_LOUD;

    // Rising-edge trigger with hysteresis: fire when flux first crosses the
    // threshold, then re-arm only after it falls well below it. Robust for both
    // impulsive (clap) and sustained (tone) onsets without a fixed window.
    if (!state.eventArmed) {
      if (
        !quiet &&
        flux > thresh &&
        tnow - state.lastEventAt > EVENT_REFRACTORY_MS
      ) {
        state.eventArmed = true;
        state.lastEventAt = tnow;
        var cat = classifyIntoCategory(state.eventPrev, flux);
        if (cat) {
          state.events.push({
            seq: state.colSeq,
            letter: cat.letter,
            color: nextEventColor(cat.colorIdx),
            freq: isFinite(state.domHz) ? state.domHz : 2500,
          });
          pruneEvents();
          renderEventCounts();
          state.spectroDirty = true;
        }
      }
    } else if (flux < thresh * EVENT_ARM_RATIO || quiet) {
      state.eventArmed = false;
    }
  }

  // ---- Waveform shape via harmonic analysis ------------------------------
  //
  // Periodic waves have characteristic harmonic amplitude ratios (relative to
  // the fundamental): sine → only fundamental; square → odd harmonics ∝ 1/n;
  // saw → all harmonics ∝ 1/n; triangle → odd harmonics ∝ 1/n². We read the
  // harmonic amplitudes from the FFT and pick the closest template.

  function ampAtHz(hz) {
    // Energy-summed amplitude over a small window (±2 bins). Summing energy in
    // the linear domain (instead of taking the max dB bin) keeps fundamental
    // and harmonic amplitudes on the same footing, so their ratios are stable
    // regardless of how a peak straddles FFT bins.
    if (!state.buf || !state.ctx) return 0;
    var binHz = state.ctx.sampleRate / state.analyser.fftSize;
    var c = hz / binHz;
    var lo = Math.max(1, Math.round(c) - 2);
    var hi = Math.min(state.buf.length - 1, Math.round(c) + 2);
    var e = 0;
    for (var i = lo; i <= hi; i++) {
      if (isFinite(state.buf[i])) e += Math.pow(10, state.buf[i] / 10); // |X|²
    }
    return Math.sqrt(e);
  }

  function classifyWaveform(hz) {
    if (!state.buf || !state.ctx || !isFinite(hz) || hz < 120 || hz > 5000) {
      return SHAPE_NONE;
    }
    var floorDb = isFinite(state.nf) ? state.nf : -100;
    if (!isFinite(state.domDb) || state.domDb < floorDb + 14) return SHAPE_NONE;

    // Prefer the true fundamental: if there is strong energy at hz/2, step down.
    var f0 = hz;
    var a0 = ampAtHz(f0);
    for (var s = 0; s < 2; s++) {
      var sub = f0 / 2;
      if (sub < 120) break;
      if (ampAtHz(sub) > a0 * 0.5) {
        f0 = sub;
        a0 = ampAtHz(f0);
      } else break;
    }
    if (a0 <= 0) return SHAPE_NONE;

    // Use as many harmonics as fit under the analysed band (need the 3rd).
    var maxH = Math.min(8, Math.floor((SPEC_FMAX - 1) / f0));
    if (maxH < 3) return SHAPE_NONE;

    // Harmonic amplitudes relative to the fundamental (a[0] = a1 = 1).
    var a = [1, 0, 0, 0, 0, 0, 0, 0];
    for (var n = 2; n <= maxH; n++) a[n - 1] = ampAtHz(f0 * n) / a0;

    // Inharmonicity guard: energy halfway between harmonics must be low.
    var inter = (ampAtHz(f0 * 1.5) + ampAtHz(f0 * 2.5)) / (2 * a0);
    if (inter > 0.5) return SHAPE_NONE; // noisy / inharmonic → not a pure wave

    // Discriminate on the harmonic structure (fundamental excluded):
    //   sine     → negligible harmonics (a3 ≈ 0)
    //   saw      → strong even + odd harmonics (a2 ≈ 1/2), decay ∝ 1/n
    //   square   → odd dominant, a3 ≈ 1/3, decay ∝ 1/n
    //   triangle → odd dominant, a3 ≈ 1/9, decay ∝ 1/n²
    var a2 = a[1];
    var a3 = a[2];
    var even = Math.sqrt(a[1] * a[1] + a[3] * a[3] + a[5] * a[5]); // a2,a4,a6
    var odd = Math.sqrt(a[2] * a[2] + a[4] * a[4] + a[6] * a[6]); // a3,a5,a7

    // Below this, no harmonic stands out from the fundamental → pure sine.
    if (a3 < 0.05 && a2 < 0.12) return SHAPE_SINE;
    // Saw: prominent 2nd harmonic and a full (even+odd) series.
    if (a2 > 0.25 && even > 0.45 * odd) return SHAPE_SAW;
    // Odd-dominant classes keyed off the 3rd-harmonic magnitude:
    //   square a3 ≈ 0.33, triangle a3 ≈ 0.11 → split near the geometric mean.
    if (a3 >= 0.19) return SHAPE_SQUARE;
    if (a3 >= 0.05) return SHAPE_TRI;
    return SHAPE_SINE;
  }

  function poll() {
    if (!state.running) return;
    state.analyser.getFloatFrequencyData(state.buf);

    // Running noise-floor estimate (min bin, slow rise) for waveform + events.
    var b = state.buf;
    var mn = Infinity;
    for (var i = 1; i < b.length; i++) if (b[i] < mn) mn = b[i];
    if (!isFinite(mn)) mn = -100;
    state.nf = state.nf == null ? mn : mn < state.nf ? mn : state.nf * 0.95 + mn * 0.05;

    if (!state.recPaused) {
      updateDominantFreq();
      pushSpectroColumn();
      renderDominant();
    }
  }

  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + " s";
    if (s < 3600) return Math.floor(s / 60) + " min";
    return Math.floor(s / 3600) + " h";
  }

  // ---- RX: decoded ALINK frame handling ----------------------------------
  function bytesToHex(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i++) {
      s += (u8[i] < 16 ? "0" : "") + u8[i].toString(16);
    }
    return s || "—";
  }

  function bytesToText(u8) {
    if (!u8.length) return "—";
    var s = "";
    for (var i = 0; i < u8.length; i++) {
      var c = u8[i];
      s += c >= 32 && c < 127 ? String.fromCharCode(c) : ".";
    }
    return s;
  }

  function flagsText(fl) {
    var A = ALINK.FLAG;
    var p = [];
    if (fl & A.SYNCED) p.push("S");
    if (fl & A.ACK_REQ) p.push("A");
    if (fl & A.ENCRYPTED) p.push("E");
    return p.length ? p.join("") : "—";
  }

  function handleFrame(frame) {
    frame.at = Date.now();
    state.rx.unshift(frame);
    if (state.rx.length > 60) state.rx.length = 60;

    var peer = state.peers.get(frame.nodeId);
    if (!peer) {
      peer = { id: frame.nodeId, count: 0, lastSeq: -1, rho: 0, synced: false, at: 0 };
      state.peers.set(frame.nodeId, peer);
    }
    peer.count += 1;
    peer.lastSeq = frame.seq;
    peer.rho = frame.rho;
    peer.synced = !!(frame.flags & ALINK.FLAG.SYNCED);
    peer.type = frame.typeName;
    peer.at = frame.at;

    state.chirpRx += 1;
    renderReceived();
    renderPeers();
    renderRxStats();
    renderChirpCounts();
    log(
      "RX " + frame.typeName + " node " + frame.nodeId + " seq " + frame.seq +
        " rho " + frame.rho.toFixed(2) + " pl[" + frame.len + "] " + bytesToText(frame.payload)
    );
  }

  function renderRxStats() {
    if (!els.rxStats) return;
    var st = state.demod ? state.demod.stats : state.rxStats;
    els.rxStats.textContent = t.rxStats(st.decoded, st.badCrc, st.detects);
  }

  function renderReceived() {
    if (!els.rxBody) return;
    if (!state.rx.length) {
      els.rxBody.innerHTML =
        '<tr class="empty"><td colspan="7">' + t.rxEmpty + "</td></tr>";
      return;
    }
    els.rxBody.innerHTML = state.rx
      .map(function (f) {
        return (
          "<tr><td>" + ago(f.at) + "</td><td class='node-id'>" + f.nodeId +
          "</td><td>" + f.typeName + "</td><td>" + f.seq + "</td><td>" + flagsText(f.flags) +
          "</td><td title='" + bytesToHex(f.payload) + "'>" + bytesToText(f.payload) +
          "</td><td>" + f.rho.toFixed(2) + "</td></tr>"
        );
      })
      .join("");
  }

  function renderPeers() {
    if (!els.peersBody) return;
    var list = Array.from(state.peers.values()).sort(function (a, b) {
      return a.id - b.id;
    });
    if (!list.length) {
      els.peersBody.innerHTML =
        '<tr class="empty"><td colspan="5">' + t.peersEmpty + "</td></tr>";
      return;
    }
    els.peersBody.innerHTML = list
      .map(function (p) {
        return (
          "<tr><td class='node-id'>" + p.id + "</td><td>" + p.count + "</td><td>" +
          p.lastSeq + "</td><td>" + p.rho.toFixed(2) + "</td><td>" +
          (p.synced ? "✓" : "—") + "</td></tr>"
        );
      })
      .join("");
  }

  function clearReceived() {
    state.rx = [];
    state.peers.clear();
    state.chirpRx = 0;
    state.chirpTx = 0;
    if (state.demod) state.demod.stats = { detects: 0, decoded: 0, badCrc: 0 };
    renderReceived();
    renderPeers();
    renderRxStats();
    renderChirpCounts();
    log(t.rxCleared);
  }

  function refreshAges() {
    if (state.rx.length) renderReceived();
  }

  // ---- TX form + sent queue ----------------------------------------------
  function payloadFromInput() {
    var txt = els.txPayload ? els.txPayload.value : "";
    var bytes = [];
    for (var i = 0; i < txt.length && bytes.length < ALINK.CONST.PAYLOAD_MAX; i++) {
      var c = txt.charCodeAt(i);
      if (c < 256) bytes.push(c);
    }
    return new Uint8Array(bytes);
  }

  function updatePayloadLen() {
    if (!els.txPayloadLen) return;
    var n = payloadFromInput().length;
    els.txPayloadLen.textContent = n + "/" + ALINK.CONST.PAYLOAD_MAX + " B";
  }

  function currentTxFields() {
    var flags = 0;
    if (els.txSynced && els.txSynced.checked) flags |= ALINK.FLAG.SYNCED;
    if (els.txAck && els.txAck.checked) flags |= ALINK.FLAG.ACK_REQ;
    if (els.txEnc && els.txEnc.checked) flags |= ALINK.FLAG.ENCRYPTED;
    var nonce = parseInt((els.txNonce && els.txNonce.value) || "0", 16) >>> 0;
    return {
      nodeId: parseInt(els.txNode.value, 10) || 0,
      type: parseInt(els.txType.value, 10) || ALINK.TYPE.BEACON,
      seq: (parseInt(els.txSeq.value, 10) || 0) & 0xff,
      flags: flags,
      keyId: (parseInt((els.txKeyId && els.txKeyId.value) || "0", 10) || 0) & 0xff,
      nonce: nonce,
      payload: payloadFromInput(),
    };
  }

  function loadTxFields(f) {
    els.txNode.value = String(f.nodeId);
    els.txType.value = String(f.type);
    els.txSeq.value = String(f.seq);
    if (els.txSynced) els.txSynced.checked = !!(f.flags & ALINK.FLAG.SYNCED);
    if (els.txAck) els.txAck.checked = !!(f.flags & ALINK.FLAG.ACK_REQ);
    if (els.txEnc) els.txEnc.checked = !!(f.flags & ALINK.FLAG.ENCRYPTED);
    if (els.txKeyId) els.txKeyId.value = String(f.keyId || 0);
    if (els.txNonce) els.txNonce.value = (f.nonce >>> 0).toString(16);
    if (els.txPayload) {
      var s = "";
      for (var i = 0; i < f.payload.length; i++) s += String.fromCharCode(f.payload[i]);
      els.txPayload.value = s;
    }
    updatePayloadLen();
  }

  function txGainValue() {
    return els.txGain ? (parseInt(els.txGain.value, 10) || 60) / 100 : 0.6;
  }

  function doTransmit(fields) {
    var dur = transmitFrame(fields, txGainValue());
    state.chirpTx += 1;
    renderChirpCounts();
    log(
      "TX " + (ALINK.TYPE_NAME[fields.type] || "?") + " node " + fields.nodeId +
        " seq " + fields.seq + " · " + (dur * 1000).toFixed(0) + " ms"
    );
    if (els.txSeqAuto && els.txSeqAuto.checked) {
      els.txSeq.value = String((fields.seq + 1) & 0xff);
    }
  }

  function doTransmitShort() {
    var node = parseInt(els.txNode.value, 10) || 0;
    var dur = transmitPreamble(node, txGainValue());
    log("TX ping node " + node + " · " + (dur * 1000).toFixed(0) + " ms");
  }

  function renderQueue() {
    if (!els.queueList) return;
    if (!state.queue.length) {
      els.queueList.innerHTML = '<li class="queue-empty">' + t.queueEmpty + "</li>";
      return;
    }
    els.queueList.innerHTML = state.queue
      .map(function (f, i) {
        var summary =
          (ALINK.TYPE_NAME[f.type] || "?") + " · n" + f.nodeId + " · s" + f.seq +
          " · " + (f.payload.length ? bytesToText(f.payload) : "—");
        return (
          '<li class="queue-item"><span class="queue-sum">' + summary + "</span>" +
          '<span class="queue-actions">' +
          '<button class="btn btn-ghost btn-sm" data-q="load" data-i="' + i + '">' + t.qLoad + "</button>" +
          '<button class="btn btn-ghost btn-sm" data-q="send" data-i="' + i + '">' + t.qSend + "</button>" +
          '<button class="btn btn-ghost btn-sm" data-q="del" data-i="' + i + '">' + t.qDel + "</button>" +
          "</span></li>"
        );
      })
      .join("");
  }

  function snapshotFields(f) {
    return {
      nodeId: f.nodeId,
      type: f.type,
      seq: f.seq,
      flags: f.flags,
      keyId: f.keyId,
      nonce: f.nonce,
      payload: f.payload.slice(),
    };
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
    if (
      state.histData &&
      state.histCap === want &&
      state.histDom &&
      state.histDom.length === want &&
      state.histShape &&
      state.histShape.length === want
    ) {
      return;
    }
    var oldData = state.histData;
    var oldDom = state.histDom;
    var oldShape = state.histShape;
    var oldCap = state.histCap;
    var oldCount = state.histCount;
    var oldHead = state.histHead;
    var keep = oldData ? Math.min(oldCount, want) : 0;

    state.histCap = want;
    state.histData = new Uint8Array(want * bins);
    state.histDom = new Float32Array(want);
    state.histShape = new Uint8Array(want);
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
        state.histShape[dst] = oldShape ? oldShape[srcPhys] : 0;
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
    return Math.round(
      (state.histCap * state.histBins + state.histCap * 4 + state.histCap) / 1024
    );
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
    var packedShape = new Uint8Array(newCap);
    for (var i = 0; i < newCap; i++) packedDom[i] = NaN;
    for (var k = 0; k < keep; k++) {
      var srcLogic = state.histCount - keep + k;
      var srcPhys = histPhys(srcLogic);
      packed.set(
        state.histData.subarray(srcPhys * bins, srcPhys * bins + bins),
        k * bins
      );
      packedDom[k] = state.histDom[srcPhys];
      packedShape[k] = state.histShape ? state.histShape[srcPhys] : 0;
    }
    state.histCap = newCap;
    state.histData = packed;
    state.histDom = packedDom;
    state.histShape = packedShape;
    state.histCount = keep;
    state.histHead = keep % newCap;
    pruneEvents();
    trimWavToSec(histSpanSec() + 1);
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

  function pushHistColumn(colU8, domHz, shape) {
    ensureHist(state.histCap || 8000);
    var bins = state.histBins;
    var at = state.histHead;
    state.histData.set(colU8, at * bins);
    state.histDom[at] = isFinite(domHz) ? domHz : NaN;
    state.histShape[at] = shape || 0;
    state.histHead = (at + 1) % state.histCap;
    if (state.histCount < state.histCap) state.histCount += 1;
    state.colSeq += 1;
    if ((state.colSeq & 31) === 0) pruneEvents();
    else if (state.histCount === state.histCap) pruneEvents();
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

  function sampleHistShape(logicIdx) {
    if (logicIdx < 0 || logicIdx >= state.histCount || !state.histShape) return 0;
    return state.histShape[histPhys(logicIdx)] || 0;
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
      var wavKiB = state.wav ? Math.round((state.wavCount * 2) / 1024) : 0;
      els.spectroMem.textContent = t.spectroMem(
        histSpanSec().toFixed(1),
        String(histBytesKiB() + wavKiB)
      );
    }
    if (els.recPause) {
      els.recPause.textContent = state.recPaused ? t.recResume : t.recPause;
      els.recPause.classList.toggle("is-active", state.recPaused);
    }
    if (els.recDownload) {
      els.recDownload.disabled = !state.wavCount;
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
    // ALINK bands (active profile): BPSK preamble + FHSS data hop edges.
    if (typeof ALINK !== "undefined") {
      var hops = ALINK.CONST.HOPS;
      bandLine(ALINK.CONST.PREAMBLE_HZ, "rgba(59,130,246,0.55)");
      bandLine(hops[0], "rgba(31,191,160,0.4)");
      bandLine(hops[hops.length - 1], "rgba(31,191,160,0.4)");
    }

    // dominant frequency graph — colored by waveform class when pure
    g.lineWidth = 2.25;
    g.lineJoin = "round";
    g.lineCap = "round";
    var lastHz = NaN;
    var lastShape = -1;
    var segStarted = false;
    var prevX = 0;
    var prevY = 0;
    for (var x2 = 0; x2 < lay.plotW; x2++) {
      var logic2 = startLogic + (x2 / (lay.plotW - 1 || 1)) * (span - 1);
      var li2 = logic2 | 0;
      var hz = sampleHistDom(li2);
      if (!isFinite(hz)) {
        segStarted = false;
        lastShape = -1;
        continue;
      }
      lastHz = hz;
      var sh = sampleHistShape(li2);
      var yy = freqToY(hz, lay.plotY, lay.plotH);
      var xx = lay.plotX + x2;
      if (!segStarted || sh !== lastShape) {
        if (segStarted) {
          g.strokeStyle = SHAPE_COLOR[lastShape] || SHAPE_COLOR[0];
          g.beginPath();
          g.moveTo(prevX, prevY);
          g.lineTo(xx, yy);
          g.stroke();
        }
        segStarted = true;
        lastShape = sh;
        prevX = xx;
        prevY = yy;
      } else {
        g.strokeStyle = SHAPE_COLOR[sh] || SHAPE_COLOR[0];
        g.beginPath();
        g.moveTo(prevX, prevY);
        g.lineTo(xx, yy);
        g.stroke();
        prevX = xx;
        prevY = yy;
      }
    }
    if (isFinite(lastHz)) {
      g.fillStyle = SHAPE_COLOR[lastShape] || SHAPE_COLOR[0];
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
    var legendItems = [
      { c: SHAPE_COLOR[SHAPE_NONE], l: t.legendDom },
      { c: SHAPE_COLOR[SHAPE_SINE], l: t.legendSine },
      { c: SHAPE_COLOR[SHAPE_SQUARE], l: t.legendSquare },
      { c: SHAPE_COLOR[SHAPE_SAW], l: t.legendSaw },
      { c: SHAPE_COLOR[SHAPE_TRI], l: t.legendTri },
    ];
    var legX = lay.plotX + 8;
    var legY0 = lay.plotY + 10;
    var rowH = 15;
    var legW = 118;
    g.fillStyle = "rgba(5,8,10,0.62)";
    g.fillRect(legX - 4, legY0 - 10, legW, legendItems.length * rowH + 8);
    for (var li = 0; li < legendItems.length; li++) {
      var ly = legY0 + li * rowH;
      g.strokeStyle = legendItems[li].c;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(legX, ly);
      g.lineTo(legX + 16, ly);
      g.stroke();
      g.fillStyle = legendItems[li].c;
      g.fillText(legendItems[li].l, legX + 22, ly);
    }

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
    if (state.histShape) state.histShape.fill(0);
    state.histCount = 0;
    state.histHead = 0;
    state.viewEnd = 0;
    state.colSeq = 0;
    state.events = [];
    state.categories = [];
    state.letterNext = 0;
    state.eventPrev = null;
    state.fluxMean = 0;
    state.fluxDev = 0;
    state.eventArmed = false;
    state.domShape = 0;
    clearWav();
    renderEventCounts();
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
    state.domShape = classifyWaveform(state.domHz);
    // Record into the time ring for windowed (100 ms / 1 s / 10 s) readouts.
    var tnow = now();
    state.domRing.push({ t: tnow, hz: state.domHz, db: peakDb });
    var cutoff = tnow - 10000;
    while (state.domRing.length && state.domRing[0].t < cutoff) state.domRing.shift();
  }

  function domAvg(ms) {
    var tnow = now();
    var from = tnow - ms;
    var sum = 0;
    var cnt = 0;
    for (var i = state.domRing.length - 1; i >= 0; i--) {
      var e = state.domRing[i];
      if (e.t < from) break;
      sum += e.hz;
      cnt++;
    }
    return cnt ? sum / cnt : NaN;
  }

  function fmtHzFixed(hz) {
    if (!isFinite(hz) || hz <= 0) return pad("—", 8);
    var s = hz >= 1000 ? (hz / 1000).toFixed(2) + "k" : Math.round(hz) + "";
    return pad(s, 8);
  }

  // Slow, readable readout of the dominant frequency over three windows.
  function renderDominant() {
    if (!els.domFreq) return;
    var tnow = now();
    if (tnow - state.lastDomDraw < 300) return; // ≤ ~3 Hz refresh
    state.lastDomDraw = tnow;
    els.domFreq.textContent = t.domLine(
      fmtHzFixed(domAvg(100)),
      fmtHzFixed(domAvg(1000)),
      fmtHzFixed(domAvg(10000))
    );
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
    pushHistColumn(col, state.domHz, state.domShape);

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
    if (els.recPause) {
      els.recPause.addEventListener("click", toggleRecPause);
    }
    if (els.recDownload) {
      els.recDownload.addEventListener("click", downloadWav);
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
      // Prefer a 48 kHz context (spec sample rate). If the device forces a
      // different rate (often 44.1 kHz), the ALINK demod still runs at 48 kHz
      // and the mic block is resampled — the modem's 250 µs chips are unreliable
      // at other rates.
      try {
        state.ctx = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 48000,
        });
      } catch (rateErr) {
        state.ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
      await state.ctx.resume();
      var src = state.ctx.createMediaStreamSource(state.stream);
      state.micSrc = src;
      state.analyser = state.ctx.createAnalyser();
      state.analyser.fftSize = 4096;
      state.analyser.smoothingTimeConstant = 0;
      src.connect(state.analyser);
      state.buf = new Float32Array(state.analyser.frequencyBinCount);
      state.timeBuf = new Float32Array(state.analyser.fftSize);
      ensureWav(state.ctx.sampleRate);
      // ALINK receiver always runs at 48 kHz; resample the mic if needed.
      var micRate = state.ctx.sampleRate;
      if (typeof ALINK !== "undefined") {
        state.demod = new ALINK.Demod(48000);
        state.rs = micRate === 48000 ? null : new ALINK.Resampler(micRate, 48000);
      }
      log("RX sample rate " + micRate + " Hz" + (micRate === 48000 ? "" : " → 48000 (resampled)"));
      // PCM tap: feeds the WAV recorder and the ALINK demodulator.
      try {
        var proc = state.ctx.createScriptProcessor(2048, 1, 1);
        var mute = state.ctx.createGain();
        mute.gain.value = 0;
        src.connect(proc);
        proc.connect(mute);
        mute.connect(state.ctx.destination);
        proc.onaudioprocess = function (ev) {
          if (!state.running || state.recPaused) return;
          var ch = ev.inputBuffer.getChannelData(0);
          pushWavSamples(ch);
          // Optionally ignore reception during our own transmission (off by
          // default). The +120 ms guard covers speaker→mic acoustic latency.
          var ownTx = state.filterSelf && now() < txActiveUntil + 120;
          if (state.demod && !ownTx) {
            var fed = state.rs ? state.rs.process(ch) : ch;
            var frames = state.demod.push(fed);
            for (var fi = 0; fi < frames.length; fi++) handleFrame(frames[fi]);
            if (frames.length || (state.demod.stats.detects && !(state.rxTick++ & 15))) {
              renderRxStats();
            }
          }
        };
        state.wavProc = proc;
        state.wavMute = mute;
      } catch (wavErr) {
        log("WAV/RX capture unavailable: " + (wavErr && wavErr.message ? wavErr.message : wavErr));
      }
      state.running = true;
      state.recPaused = false;
      state.nf = null;
      els.permWarn.hidden = true;
      els.micBtn.textContent = t.stopMic;
      setStatus("on", t.listening);
      updateSpectroControls();
      renderRxStats();
      log(
        t.micStarted(
          state.ctx.sampleRate,
          (state.ctx.sampleRate / state.analyser.fftSize).toFixed(1)
        )
      );
      state.pollTimer = setInterval(poll, 12);
      if (!state.ageTimer) state.ageTimer = setInterval(refreshAges, 1000);
    } catch (e) {
      showPermWarn(t.micFailed(e && e.message ? e.message : e));
      setStatus("err", t.error);
    }
  }

  function stopMic() {
    state.running = false;
    state.recPaused = false;
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = 0;
    if (state.wavProc) {
      try {
        state.wavProc.onaudioprocess = null;
        state.wavProc.disconnect();
      } catch (e1) {
        /* ignore */
      }
      state.wavProc = null;
    }
    if (state.wavMute) {
      try {
        state.wavMute.disconnect();
      } catch (e2) {
        /* ignore */
      }
      state.wavMute = null;
    }
    state.micSrc = null;
    state.demod = null;
    state.rs = null;
    if (state.ageTimer) {
      clearInterval(state.ageTimer);
      state.ageTimer = 0;
    }
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
    if (els.domFreq) {
      els.domFreq.textContent = t.domLine(pad("—", 8), pad("—", 8), pad("—", 8));
    }
    state.domHz = null;
    state.domDb = null;
    state.domRing = [];
    updateSpectroControls();
    log(t.micStopped);
  }

  function toggleRecPause() {
    if (!state.running) return;
    state.recPaused = !state.recPaused;
    if (state.recPaused) {
      setStatus("", t.recPausedStatus);
    } else {
      setStatus("on", t.listening);
    }
    updateSpectroControls();
    drawSpectroFrame();
  }

  function showPermWarn(text) {
    els.permWarn.textContent = text;
    els.permWarn.hidden = false;
  }

  els.micBtn.addEventListener("click", function () {
    if (state.running) stopMic();
    else startMic();
  });

  if (els.rxClear) els.rxClear.addEventListener("click", clearReceived);

  if (els.rxFilterSelf) {
    state.filterSelf = !!els.rxFilterSelf.checked;
    els.rxFilterSelf.addEventListener("change", function () {
      state.filterSelf = !!els.rxFilterSelf.checked;
    });
  }

  // ---- Profile (Phone 2 kHz ↔ Piezo 4 kHz) + follow chirpdev room --------
  var PROFILE_KEY = "het68-chirp-profile";
  var FOLLOW_KEY = "het68-chirp-follow-dev";
  var followState = { lastV: -1, config: null, following: true };

  function airtimeMs(p) {
    if (!p) return 0;
    return Math.round(31 * (p.preChipMs || 1) + 248 * (p.dataChipMs || 4));
  }

  function refreshLinkHint() {
    if (!els.txInfo || typeof ALINK === "undefined") return;
    var C = ALINK.CONST;
    var air = Math.round(31 * C.PRE_CHIP_MS + 248 * C.DATA_CHIP_MS);
    els.txInfo.textContent =
      (C.PROFILE === "custom" ? "dev" : C.PROFILE) +
      ": pre " + C.PREAMBLE_HZ + " Hz · hopy " + C.HOPS[0] + "–" +
      C.HOPS[C.NHOPS - 1] + " Hz · chip " + C.PRE_CHIP_MS + "/" +
      C.DATA_CHIP_MS + " ms · rámec ~" + (air / 1000).toFixed(2) + " s";
  }

  function setDevSyncLabel(text) {
    if (els.devSyncState) els.devSyncState.textContent = text;
  }

  function rebuildDemod() {
    if (state.running && state.ctx && typeof ALINK !== "undefined") {
      state.demod = new ALINK.Demod(48000);
    }
    if (state.spectroReady) drawSpectroFrame();
  }

  function applyProfile(name, opts) {
    if (typeof ALINK === "undefined") return;
    opts = opts || {};
    if (!opts.fromDev && els.followDev && els.followDev.checked) {
      els.followDev.checked = false;
      followState.following = false;
      try {
        localStorage.setItem(FOLLOW_KEY, "0");
      } catch (e0) {
        /* ignore */
      }
      setDevSyncLabel(t.followOff);
    }
    var p = ALINK.setProfile(name);
    if (p !== "custom") {
      try {
        localStorage.setItem(PROFILE_KEY, p);
      } catch (e) {
        /* ignore */
      }
      if (els.txProfile) {
        els.txProfile.disabled = false;
        els.txProfile.value = p;
      }
    } else if (els.txProfile) {
      els.txProfile.disabled = true;
    }
    rebuildDemod();
    refreshLinkHint();
    log(t.profileSet(p, ALINK.CONST.PREAMBLE_HZ, ALINK.CONST.HOPS[0], ALINK.CONST.HOPS[ALINK.CONST.NHOPS - 1]));
  }

  function applyDevConfig(cfg, v, announce) {
    if (!cfg || typeof ALINK === "undefined") return;
    ALINK.setProfile(cfg);
    followState.config = cfg;
    followState.lastV = v;
    if (els.txProfile) els.txProfile.disabled = true;
    rebuildDemod();
    refreshLinkHint();
    var C = ALINK.CONST;
    setDevSyncLabel(
      t.followOk(v, C.PREAMBLE_HZ, C.HOPS[0], C.HOPS[C.NHOPS - 1], C.PRE_CHIP_MS, C.DATA_CHIP_MS)
    );
    if (announce) log(t.followApplied(v) + " · air " + airtimeMs(cfg) + " ms");
  }

  function pollDevRoom() {
    if (!followState.following) return;
    fetch("/api/dev/state", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!followState.following) return;
        if (!d || !d.config) {
          setDevSyncLabel(t.followWaiting);
          return;
        }
        if (d.v === followState.lastV) {
          var C = ALINK.CONST;
          setDevSyncLabel(
            t.followOk(
              d.v,
              C.PREAMBLE_HZ,
              C.HOPS[0],
              C.HOPS[C.NHOPS - 1],
              C.PRE_CHIP_MS,
              C.DATA_CHIP_MS
            )
          );
          return;
        }
        applyDevConfig(d.config, d.v, followState.lastV >= 0);
      })
      .catch(function () {
        if (followState.following) setDevSyncLabel(t.followErr);
      });
  }

  function setFollowing(on) {
    followState.following = !!on;
    try {
      localStorage.setItem(FOLLOW_KEY, on ? "1" : "0");
    } catch (e) {
      /* ignore */
    }
    if (els.txProfile) els.txProfile.disabled = !!on && !!followState.config;
    if (!on) {
      followState.lastV = -1;
      setDevSyncLabel(t.followOff);
      var localName = "phone";
      try {
        localName = localStorage.getItem(PROFILE_KEY) || "phone";
      } catch (e2) {
        /* ignore */
      }
      applyProfile(localName, { fromDev: true });
      if (els.txProfile) els.txProfile.disabled = false;
      return;
    }
    pollDevRoom();
  }

  if (typeof ALINK !== "undefined") {
    var savedProfile = "phone";
    var savedFollow = true;
    try {
      savedProfile = localStorage.getItem(PROFILE_KEY) || "phone";
      var f = localStorage.getItem(FOLLOW_KEY);
      if (f === "0") savedFollow = false;
    } catch (e2) {
      /* ignore */
    }
    ALINK.setProfile(savedProfile);
    refreshLinkHint();
    if (els.txProfile) {
      els.txProfile.value = ALINK.getProfile() === "custom" ? "phone" : ALINK.getProfile();
      els.txProfile.addEventListener("change", function () {
        applyProfile(els.txProfile.value);
      });
    }
    if (els.followDev) {
      els.followDev.checked = savedFollow;
      followState.following = savedFollow;
      els.followDev.addEventListener("change", function () {
        setFollowing(!!els.followDev.checked);
      });
      setDevSyncLabel(savedFollow ? t.followWaiting : t.followOff);
      if (savedFollow) pollDevRoom();
      setInterval(pollDevRoom, 1500);
    }
  }

  if (els.txPayload) els.txPayload.addEventListener("input", updatePayloadLen);

  if (els.txSend) {
    els.txSend.addEventListener("click", function () {
      doTransmit(currentTxFields());
    });
  }

  if (els.txShort) els.txShort.addEventListener("click", doTransmitShort);
  if (els.txStop) {
    els.txStop.disabled = true;
    els.txStop.addEventListener("click", function () {
      stopTx();
      if (els.txInfo) els.txInfo.textContent = t.txStopped;
    });
  }

  if (els.txQueueAdd) {
    els.txQueueAdd.addEventListener("click", function () {
      state.queue.push(snapshotFields(currentTxFields()));
      renderQueue();
    });
  }

  if (els.queueClear) {
    els.queueClear.addEventListener("click", function () {
      state.queue = [];
      renderQueue();
    });
  }

  if (els.queueList) {
    els.queueList.addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest("button[data-q]") : null;
      if (!btn) return;
      var i = parseInt(btn.getAttribute("data-i"), 10);
      var action = btn.getAttribute("data-q");
      var item = state.queue[i];
      if (!item) return;
      if (action === "load") loadTxFields(item);
      else if (action === "send") doTransmit(snapshotFields(item));
      else if (action === "del") {
        state.queue.splice(i, 1);
        renderQueue();
      }
    });
  }

  function buildAgeString(fromIso) {
    var then = new Date(fromIso).getTime();
    if (!isFinite(then)) return null;
    var mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
    if (mins < 60) return mins + " min";
    var hrs = Math.floor(mins / 60);
    if (hrs < 48) return hrs + " h";
    return Math.floor(hrs / 24) + " d";
  }

  function fmtDateTime(d) {
    function p(n) {
      return (n < 10 ? "0" : "") + n;
    }
    return (
      p(d.getDate()) +
      "." +
      p(d.getMonth() + 1) +
      "." +
      d.getFullYear() +
      " " +
      p(d.getHours()) +
      ":" +
      p(d.getMinutes())
    );
  }

  (function buildMeta() {
    var yearEl = document.getElementById("year");
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());
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
          parts.push(t.deployed + " " + fmtDateTime(d));
          var age = buildAgeString(info.deployedAt);
          if (age) parts.push(t.buildAgo(age));
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
  renderChirpCounts();
  renderReceived();
  renderPeers();
  renderRxStats();
  renderQueue();
  updatePayloadLen();
  if (els.domFreq) els.domFreq.textContent = t.domLine(pad("—", 8), pad("—", 8), pad("—", 8));
  log(t.ready);
})();
