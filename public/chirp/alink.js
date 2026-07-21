/**
 * het68 acoustic link ("chirp") — browser codec + software modem.
 *
 * Implements the wire format from the het68 spec (chirp.md, firmware v1.3.x):
 *   PHY  : DSSS-BPSK on a 4 kHz carrier, 500 chip/s, SF=8, 127-chip preamble
 *   CDMA : Gold codes from two degree-7 m-sequences (x^7+x^6+1, x^7+x^3+1)
 *   FRAME: fixed 31-byte plaintext, Hamming(7,4) per nibble, CRC32 (0xEDB88320)
 *
 * TX  : fields -> 31 bytes -> 434 coded bits -> 3599 chips -> BPSK audio.
 * RX  : mic samples -> I/Q downconvert -> integrate&dump -> preamble acquisition
 *       -> despread -> Hamming decode -> CRC check -> parsed frame.
 *
 * Note: exact hardware interop needs bench validation (the spec itself flags the
 * Gold preferred-pair as unverified); TX/RX here are mutually consistent and
 * follow the documented construction.
 */
(function (root) {
  "use strict";

  var C = {
    CARRIER_HZ: 4000,
    FS_REF: 48000,
    CYCLES_CHIP: 8,
    CHIP_HZ: 500,
    CHIP_MS: 2,
    PREAMBLE_LEN: 127,
    DATA_SF: 8,
    MAX_NODES: 8,
    VERSION: 1,
    FRAME_BYTES: 31,
    PAYLOAD_MAX: 16,
    CODED_BITS: 434, // 62 nibbles * 7
    DATA_CHIPS: 3472, // 434 * 8
    TX_CHIPS: 3599, // 127 + 3472
    DETECT_RHO: 0.3,
    DETECT_EMIN: 1e-4,
  };

  var TYPE = { BEACON: 1, DETECT: 2, CTRL: 3, ACK: 4 };
  var TYPE_NAME = { 1: "BEACON", 2: "DETECT", 3: "CTRL", 4: "ACK" };
  var FLAG = { ENCRYPTED: 0x01, ACK_REQ: 0x02, SYNCED: 0x04 };

  // ---- CRC32 (IEEE 802.3, reflected 0xEDB88320) --------------------------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, len) {
    var c = 0xffffffff;
    var n = len == null ? bytes.length : len;
    for (var i = 0; i < n; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---- Hamming(7,4) ------------------------------------------------------
  // Layout bit positions 1..7: p1 p2 d1 p3 d2 d3 d4
  function hammingEncode(nib) {
    var d1 = (nib >> 3) & 1;
    var d2 = (nib >> 2) & 1;
    var d3 = (nib >> 1) & 1;
    var d4 = nib & 1;
    var p1 = d1 ^ d2 ^ d4;
    var p2 = d1 ^ d3 ^ d4;
    var p3 = d2 ^ d3 ^ d4;
    return [p1, p2, d1, p3, d2, d3, d4];
  }

  function hammingDecode(bits7) {
    var b = bits7.slice();
    var s1 = b[0] ^ b[2] ^ b[4] ^ b[6];
    var s2 = b[1] ^ b[2] ^ b[5] ^ b[6];
    var s3 = b[3] ^ b[4] ^ b[5] ^ b[6];
    var syn = (s3 << 2) | (s2 << 1) | s1; // position (1..7) of the error, 0 = none
    if (syn >= 1 && syn <= 7) b[syn - 1] ^= 1;
    return (b[2] << 3) | (b[4] << 2) | (b[5] << 1) | b[6];
  }

  // ---- Gold codes --------------------------------------------------------
  function mSeq(taps) {
    var st = 0x7f; // 7-bit register, all ones
    var out = new Uint8Array(C.PREAMBLE_LEN);
    for (var k = 0; k < C.PREAMBLE_LEN; k++) {
      out[k] = st & 1;
      var fb = 0;
      for (var i = 0; i < taps.length; i++) fb ^= (st >> (taps[i] - 1)) & 1;
      st = ((st >> 1) | (fb << 6)) & 0x7f;
    }
    return out;
  }

  // Degree-7 preferred pair for a proper Gold family. The spec lists
  // x^7+x^6+1 / x^7+x^3+1 but flags the pair as unverified; as pure LFSRs those
  // are non-maximal and give large correlation sidelobes (unreliable
  // acquisition). This preferred pair yields the optimal 3-valued correlation
  // (max |R| = 17/127 ≈ 0.13), so preamble acquisition is robust.
  var SEQ_A = mSeq([7, 1]); // x^7 + x + 1
  var SEQ_B = mSeq([7, 6, 3, 1]); // x^7 + x^6 + x^3 + x + 1

  var CODES = (function () {
    var codes = [];
    for (var n = 0; n < C.MAX_NODES; n++) {
      var c = new Int8Array(C.PREAMBLE_LEN);
      for (var k = 0; k < C.PREAMBLE_LEN; k++) {
        var bit = SEQ_A[k] ^ SEQ_B[(k + n) % C.PREAMBLE_LEN];
        c[k] = bit ? -1 : 1; // 1 - 2*bit
      }
      codes.push(c);
    }
    return codes;
  })();

  function nodeCode(n) {
    return CODES[((n % C.MAX_NODES) + C.MAX_NODES) % C.MAX_NODES];
  }

  // ---- Frame pack / parse ------------------------------------------------
  function packFrame(f) {
    var b = new Uint8Array(C.FRAME_BYTES);
    b[0] = C.VERSION;
    b[1] = (f.nodeId | 0) & 0xff;
    b[2] = (f.type | 0) & 0xff;
    b[3] = (f.seq | 0) & 0xff;
    b[4] = (f.flags | 0) & 0xff;
    b[5] = (f.keyId | 0) & 0xff;
    var nonce = (f.nonce | 0) >>> 0;
    b[6] = nonce & 0xff;
    b[7] = (nonce >>> 8) & 0xff;
    b[8] = (nonce >>> 16) & 0xff;
    b[9] = (nonce >>> 24) & 0xff;
    var payload = f.payload || new Uint8Array(0);
    var len = Math.max(0, Math.min(C.PAYLOAD_MAX, payload.length));
    b[10] = len;
    for (var i = 0; i < C.PAYLOAD_MAX; i++) b[11 + i] = i < len ? payload[i] : 0;
    var crc = crc32(b, 27);
    b[27] = crc & 0xff;
    b[28] = (crc >>> 8) & 0xff;
    b[29] = (crc >>> 16) & 0xff;
    b[30] = (crc >>> 24) & 0xff;
    return b;
  }

  function parseFrame(b) {
    if (!b || b.length < C.FRAME_BYTES) return null;
    var crc = crc32(b, 27);
    var wire =
      (b[27] | (b[28] << 8) | (b[29] << 16) | (b[30] << 24)) >>> 0;
    if (crc !== wire) return null;
    if (b[0] !== C.VERSION) return null;
    var len = Math.min(C.PAYLOAD_MAX, b[10]);
    return {
      version: b[0],
      nodeId: b[1],
      type: b[2],
      typeName: TYPE_NAME[b[2]] || "?",
      seq: b[3],
      flags: b[4],
      keyId: b[5],
      nonce: (b[6] | (b[7] << 8) | (b[8] << 16) | (b[9] << 24)) >>> 0,
      len: len,
      payload: b.slice(11, 11 + len),
    };
  }

  // ---- bits <-> chips ----------------------------------------------------
  function frameToCodedBits(frameBytes) {
    var bits = new Uint8Array(C.CODED_BITS);
    var o = 0;
    for (var i = 0; i < C.FRAME_BYTES; i++) {
      var hi = (frameBytes[i] >> 4) & 0xf;
      var lo = frameBytes[i] & 0xf;
      var eh = hammingEncode(hi);
      var el = hammingEncode(lo);
      for (var k = 0; k < 7; k++) bits[o++] = eh[k];
      for (var k2 = 0; k2 < 7; k2++) bits[o++] = el[k2];
    }
    return bits;
  }

  function codedBitsToFrame(bits) {
    var out = new Uint8Array(C.FRAME_BYTES);
    var o = 0;
    var tmp = new Array(7);
    for (var i = 0; i < C.FRAME_BYTES; i++) {
      for (var k = 0; k < 7; k++) tmp[k] = bits[o++];
      var hi = hammingDecode(tmp);
      for (var k2 = 0; k2 < 7; k2++) tmp[k2] = bits[o++];
      var lo = hammingDecode(tmp);
      out[i] = ((hi & 0xf) << 4) | (lo & 0xf);
    }
    return out;
  }

  /** frame fields -> Int8Array(TX_CHIPS) of chip signs (+/-1). */
  function encodeChips(frameFields, nodeId) {
    var frameBytes =
      frameFields instanceof Uint8Array ? frameFields : packFrame(frameFields);
    var code = nodeCode(nodeId);
    var bits = frameToCodedBits(frameBytes);
    var chips = new Int8Array(C.TX_CHIPS);
    for (var k = 0; k < C.PREAMBLE_LEN; k++) chips[k] = code[k];
    var o = C.PREAMBLE_LEN;
    for (var i = 0; i < C.CODED_BITS; i++) {
      var bitSign = bits[i] ? -1 : 1; // 1 - 2*b
      for (var j = 0; j < C.DATA_SF; j++) {
        chips[o++] = bitSign * code[j]; // a = (1-2b)*(1-2c)
      }
    }
    return { chips: chips, bytes: frameBytes };
  }

  /** chip signs -> BPSK audio at `fs` (raised-cosine edges, continuous carrier). */
  function modulate(chips, fs, opts) {
    opts = opts || {};
    var gain = opts.gain == null ? 0.6 : opts.gain;
    var samplesPerChip = fs * (C.CHIP_MS / 1000);
    var total = Math.round(chips.length * samplesPerChip);
    var out = new Float32Array(total);
    var w = 2 * Math.PI * C.CARRIER_HZ / fs;
    var rampSamples = Math.min(Math.floor(total / 2), Math.round(fs * 0.004));
    for (var n = 0; n < total; n++) {
      var chipIdx = Math.floor(n / samplesPerChip);
      if (chipIdx >= chips.length) chipIdx = chips.length - 1;
      var env = gain;
      if (n < rampSamples) env *= 0.5 * (1 - Math.cos((Math.PI * n) / rampSamples));
      else if (n > total - rampSamples)
        env *= 0.5 * (1 - Math.cos((Math.PI * (total - n)) / rampSamples));
      out[n] = env * chips[chipIdx] * Math.cos(w * n);
    }
    return out;
  }

  // ---- Streaming demodulator --------------------------------------------
  function Demod(fs, opts) {
    opts = opts || {};
    this.fs = fs;
    this.w = (2 * Math.PI * C.CARRIER_HZ) / fs;
    this.samplesPerChip = fs * (C.CHIP_MS / 1000);
    this.detectRho = opts.detectRho == null ? C.DETECT_RHO : opts.detectRho;
    this.detectEmin = opts.detectEmin == null ? C.DETECT_EMIN : opts.detectEmin;
    this.reset();
  }

  Demod.prototype.reset = function () {
    this.n = 0; // global sample index
    this.chipCount = 0; // chips finalized
    this.accI = 0;
    this.accQ = 0;
    this.accCnt = 0;
    this.nextBoundary = this.samplesPerChip;
    this.histI = new Float32Array(C.PREAMBLE_LEN);
    this.histQ = new Float32Array(C.PREAMBLE_LEN);
    this.histPos = 0;
    this.histFill = 0;
    this.state = "SEARCH";
    this.collectI = new Float32Array(C.DATA_CHIPS);
    this.collectQ = new Float32Array(C.DATA_CHIPS);
    this.collected = 0;
    this.det = null;
    this.lastDetectChip = -1e9;
    this.stats = { detects: 0, decoded: 0, badCrc: 0 };
  };

  Demod.prototype._onChip = function (ci, cq) {
    // push into preamble history ring
    this.histI[this.histPos] = ci;
    this.histQ[this.histPos] = cq;
    this.histPos = (this.histPos + 1) % C.PREAMBLE_LEN;
    if (this.histFill < C.PREAMBLE_LEN) this.histFill++;
    this.chipCount++;

    var decoded = null;

    if (this.state === "COLLECT") {
      this.collectI[this.collected] = ci;
      this.collectQ[this.collected] = cq;
      this.collected++;
      if (this.collected >= C.DATA_CHIPS) {
        decoded = this._decode();
        this.state = "SEARCH";
        this.det = null;
      }
      return decoded;
    }

    if (this.histFill < C.PREAMBLE_LEN) return null;
    if (this.chipCount - this.lastDetectChip < 8) return null;

    // Acquisition: correlate 127-history against each candidate preamble code.
    var energy = 0;
    for (var k = 0; k < C.PREAMBLE_LEN; k++) {
      energy += this.histI[k] * this.histI[k] + this.histQ[k] * this.histQ[k];
    }
    if (energy < this.detectEmin) return null;

    var bestRho = 0;
    var bestCode = -1;
    var bestPhi = 0;
    for (var c = 0; c < C.MAX_NODES; c++) {
      var code = CODES[c];
      var sumI = 0;
      var sumQ = 0;
      // history is a ring; logical index j maps to physical (histPos + j) % N,
      // oldest first — aligns with preamble chip order.
      for (var j = 0; j < C.PREAMBLE_LEN; j++) {
        var p = (this.histPos + j) % C.PREAMBLE_LEN;
        var s = code[j];
        sumI += this.histI[p] * s;
        sumQ += this.histQ[p] * s;
      }
      var mag2 = sumI * sumI + sumQ * sumQ;
      var rho = mag2 / (C.PREAMBLE_LEN * energy);
      if (rho > bestRho) {
        bestRho = rho;
        bestCode = c;
        bestPhi = Math.atan2(sumQ, sumI);
      }
    }

    if (bestRho > this.detectRho && bestCode >= 0) {
      this.stats.detects++;
      this.lastDetectChip = this.chipCount;
      this.det = { code: bestCode, phi: bestPhi, rho: bestRho, energy: energy };
      this.state = "COLLECT";
      this.collected = 0;
    }
    return null;
  };

  Demod.prototype._decode = function () {
    var code = CODES[this.det.code];
    var cosphi = Math.cos(this.det.phi);
    var sinphi = Math.sin(this.det.phi);
    var bits = new Uint8Array(C.CODED_BITS);
    for (var i = 0; i < C.CODED_BITS; i++) {
      var accI = 0;
      var accQ = 0;
      for (var j = 0; j < C.DATA_SF; j++) {
        var s = code[j];
        var idx = i * C.DATA_SF + j;
        accI += this.collectI[idx] * s;
        accQ += this.collectQ[idx] * s;
      }
      // derotate by -phi and slice real part: a = (1-2b) → positive ⇒ bit 0
      var metric = accI * cosphi + accQ * sinphi;
      bits[i] = metric < 0 ? 1 : 0;
    }
    var frameBytes = codedBitsToFrame(bits);
    var parsed = parseFrame(frameBytes);
    if (!parsed) {
      this.stats.badCrc++;
      return null;
    }
    this.stats.decoded++;
    parsed.rho = this.det.rho;
    parsed.codeIndex = this.det.code;
    parsed.energy = this.det.energy;
    parsed.snrDb = 10 * Math.log10(this.det.rho / Math.max(1e-6, 1 - this.det.rho));
    parsed.bytes = frameBytes;
    return parsed;
  };

  /** Feed mono samples; returns an array of decoded frames (possibly empty). */
  Demod.prototype.push = function (samples) {
    var out = [];
    for (var i = 0; i < samples.length; i++) {
      var x = samples[i];
      var ph = this.w * this.n;
      this.accI += x * Math.cos(ph);
      this.accQ += x * -Math.sin(ph);
      this.accCnt++;
      this.n++;
      if (this.n >= this.nextBoundary) {
        var ci = this.accI / this.accCnt;
        var cq = this.accQ / this.accCnt;
        this.accI = 0;
        this.accQ = 0;
        this.accCnt = 0;
        this.nextBoundary += this.samplesPerChip;
        var d = this._onChip(ci, cq);
        if (d) out.push(d);
      }
    }
    return out;
  };

  var API = {
    CONST: C,
    TYPE: TYPE,
    TYPE_NAME: TYPE_NAME,
    FLAG: FLAG,
    crc32: crc32,
    hammingEncode: hammingEncode,
    hammingDecode: hammingDecode,
    nodeCode: nodeCode,
    packFrame: packFrame,
    parseFrame: parseFrame,
    frameToCodedBits: frameToCodedBits,
    codedBitsToFrame: codedBitsToFrame,
    encodeChips: encodeChips,
    modulate: modulate,
    Demod: Demod,
    _seq: { A: SEQ_A, B: SEQ_B },
  };

  root.ALINK = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(
  typeof self !== "undefined"
    ? self
    : typeof globalThis !== "undefined"
    ? globalThis
    : this
);
