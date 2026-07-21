/**
 * het68 acoustic link ("chirp") — browser codec + software modem.
 *
 * Implements the het68 spec v1.4.0 (chirp.md, ALINK_VERSION = 2):
 *   PHY  : 31-chip BPSK preamble at 4 kHz (CDMA) + 248-chip non-coherent
 *          2-FSK / FHSS data. Chip dwell 250 µs → one frame ≈ 69.75 ms.
 *   CDMA : length-31 m-sequence (x^5+x^2+1), circular shift = node_id*3.
 *   DATA : per data bit, 2-FSK between a hop-tone pair offset by NHOPS/2;
 *          the per-chip hop base advances (FHSS) and is offset by node_id*3.
 *   FRAME: fixed 31-byte plaintext, CRC32 (0xEDB88320), no FEC.
 *
 * Not interoperable with v1.3 (version 1, Hamming + slow DSSS). Exact hardware
 * interop is not bench-verified (the spec flags v1.4 as not fully validated);
 * the browser TX/RX are mutually consistent and follow the documented design.
 */
(function (root) {
  "use strict";

  var C = {
    FS_REF: 48000,
    CHIP_US: 250,
    CHIP_MS: 0.25,
    PREAMBLE_HZ: 4000,
    PREAMBLE_LEN: 31,
    NHOPS: 8,
    HOPS: [3000, 3400, 3800, 4000, 4200, 4600, 5000, 5400],
    DATA_SF: 1,
    MAX_NODES: 8,
    VERSION: 2,
    FRAME_BYTES: 31,
    PAYLOAD_MAX: 16,
    DATA_BITS: 248, // 31 bytes * 8
    TX_CHIPS: 279, // 31 + 248
    DETECT_RHO: 0.28,
    DETECT_EMIN: 1e-5,
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

  // ---- Preamble codes: length-31 m-sequence, per-node circular shift ------
  var MSEQ31 = (function () {
    // x^5 + x^2 + 1, taps at bits 5 and 2 (Fibonacci LFSR)
    var st = 0x1f; // 5-bit register, all ones
    var out = new Int8Array(31);
    for (var k = 0; k < 31; k++) {
      out[k] = st & 1 ? 1 : -1;
      var fb = (((st >> 4) & 1) ^ ((st >> 1) & 1)) & 1;
      st = ((st >> 1) | (fb << 4)) & 0x1f;
    }
    return out;
  })();

  function nodeCode(n) {
    var shift = ((n % C.MAX_NODES) * 3) % C.PREAMBLE_LEN;
    var code = new Int8Array(C.PREAMBLE_LEN);
    for (var k = 0; k < C.PREAMBLE_LEN; k++) {
      code[k] = MSEQ31[(k + shift) % C.PREAMBLE_LEN];
    }
    return code;
  }

  // Data hop-tone pair for bit index `i` on node `n`.
  function hopPair(i, n) {
    var base = (i + n * 3) % (C.NHOPS / 2); // 0..3
    return { lo: C.HOPS[base], hi: C.HOPS[base + C.NHOPS / 2] };
  }

  // ---- Frame pack / parse (version 2, no FEC) ----------------------------
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
    var wire = (b[27] | (b[28] << 8) | (b[29] << 16) | (b[30] << 24)) >>> 0;
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

  // ---- bytes <-> bits (MSB first) ----------------------------------------
  function bytesToBits(bytes) {
    var bits = new Uint8Array(C.DATA_BITS);
    var o = 0;
    for (var i = 0; i < C.FRAME_BYTES; i++) {
      for (var k = 7; k >= 0; k--) bits[o++] = (bytes[i] >> k) & 1;
    }
    return bits;
  }

  function bitsToBytes(bits) {
    var out = new Uint8Array(C.FRAME_BYTES);
    var o = 0;
    for (var i = 0; i < C.FRAME_BYTES; i++) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | (bits[o++] & 1);
      out[i] = v;
    }
    return out;
  }

  // ---- Modulation --------------------------------------------------------
  function applyEdges(out, ramp) {
    var total = out.length;
    for (var n = 0; n < ramp && n < total; n++) {
      var e = 0.5 * (1 - Math.cos((Math.PI * n) / ramp));
      out[n] *= e;
      out[total - 1 - n] *= e;
    }
  }

  /** BPSK chips (+/-1) at the preamble carrier — used for preamble + ping. */
  function modulate(chips, fs, opts) {
    opts = opts || {};
    var gain = opts.gain == null ? 0.6 : opts.gain;
    var spc = fs * (C.CHIP_MS / 1000);
    var total = Math.round(chips.length * spc);
    var out = new Float32Array(total);
    var w = (2 * Math.PI * C.PREAMBLE_HZ) / fs;
    for (var n = 0; n < total; n++) {
      var ci = Math.floor(n / spc);
      if (ci >= chips.length) ci = chips.length - 1;
      out[n] = gain * chips[ci] * Math.cos(w * n);
    }
    applyEdges(out, Math.min(total >> 1, Math.round(fs * 0.001)));
    return out;
  }

  /** Full v1.4 frame: BPSK preamble @4kHz + 2-FSK/FHSS data. */
  function modulateFrame(fields, fs, opts) {
    opts = opts || {};
    var gain = opts.gain == null ? 0.6 : opts.gain;
    var nodeId = fields.nodeId | 0;
    var bytes = fields instanceof Uint8Array ? fields : packFrame(fields);
    var bits = bytesToBits(bytes);
    var code = nodeCode(nodeId);
    var spc = fs * (C.CHIP_MS / 1000);
    var total = Math.round(C.TX_CHIPS * spc);
    var out = new Float32Array(total);
    var wPre = (2 * Math.PI * C.PREAMBLE_HZ) / fs;

    for (var n = 0; n < total; n++) {
      var ci = Math.floor(n / spc);
      if (ci >= C.TX_CHIPS) ci = C.TX_CHIPS - 1;
      if (ci < C.PREAMBLE_LEN) {
        // coherent BPSK preamble (continuous carrier)
        out[n] = gain * code[ci] * Math.cos(wPre * n);
      } else {
        // 2-FSK data chip; phase resets per chip (non-coherent)
        var bi = ci - C.PREAMBLE_LEN;
        var pair = hopPair(bi, nodeId);
        var f = bits[bi] ? pair.hi : pair.lo;
        var local = n - Math.round((C.PREAMBLE_LEN + bi) * spc);
        out[n] = gain * Math.cos((2 * Math.PI * f * local) / fs);
      }
    }
    applyEdges(out, Math.min(total >> 1, Math.round(fs * 0.001)));
    return out;
  }

  // ---- Goertzel energy ---------------------------------------------------
  function goertzel(buf, n0, n1, f, fs) {
    var w = (2 * Math.PI * f) / fs;
    var coeff = 2 * Math.cos(w);
    var s1 = 0;
    var s2 = 0;
    for (var i = n0; i < n1; i++) {
      var s0 = buf[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }

  // ---- Streaming demodulator --------------------------------------------
  function Demod(fs, opts) {
    opts = opts || {};
    this.fs = fs;
    this.spc = fs * (C.CHIP_MS / 1000);
    this.wPre = (2 * Math.PI * C.PREAMBLE_HZ) / fs;
    this.detectRho = opts.detectRho == null ? C.DETECT_RHO : opts.detectRho;
    this.detectEmin = opts.detectEmin == null ? C.DETECT_EMIN : opts.detectEmin;
    this.reset();
  }

  Demod.prototype.reset = function () {
    this.n = 0;
    this.chipCount = 0;
    this.nextBoundary = this.spc;
    this.chipBuf = new Float32Array(Math.ceil(this.spc) + 4);
    this.chipFill = 0;
    this.histI = new Float32Array(C.PREAMBLE_LEN);
    this.histQ = new Float32Array(C.PREAMBLE_LEN);
    this.histPos = 0;
    this.histFill = 0;
    // Raw sample ring — big enough to hold a whole frame (preamble + data) so
    // data chips can be re-sliced at sub-chip timing once the peak is known.
    this.rawLen = (C.TX_CHIPS + 80) * Math.ceil(this.spc);
    this.raw = new Float32Array(this.rawLen);
    // Coarse trigger; the precise (node, timing) is found later by a bounded
    // search over the buffered raw preamble.
    this.armed = false;
    this.armSample = 0;
    this.armChip = 0;
    // Coarse arm threshold is intentionally low; the precise (node, timing)
    // search + CRC still validate, so off-grid frames that give a weaker
    // streaming peak are not missed.
    this.armThresh = 0.38;
    this.stats = { detects: 0, decoded: 0, badCrc: 0 };
    this.dataBits = new Uint8Array(C.DATA_BITS);
  };

  Demod.prototype._pushHist = function (ci, cq) {
    this.histI[this.histPos] = ci;
    this.histQ[this.histPos] = cq;
    this.histPos = (this.histPos + 1) % C.PREAMBLE_LEN;
    if (this.histFill < C.PREAMBLE_LEN) this.histFill++;
  };

  Demod.prototype._rawAt = function (m) {
    var i = m % this.rawLen;
    if (i < 0) i += this.rawLen;
    return this.raw[i];
  };

  // Goertzel over the raw ring for [n0, n1).
  Demod.prototype._toneEnergy = function (n0, n1, f) {
    var w = (2 * Math.PI * f) / this.fs;
    var coeff = 2 * Math.cos(w);
    var s1 = 0;
    var s2 = 0;
    for (var m = n0; m < n1; m++) {
      var s0 = this._rawAt(m) + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  };

  // Preamble BPSK correlation at a given data-start sample (I/Q, non-coherent).
  Demod.prototype._preCorr = function (preStart, node) {
    var code = nodeCode(node);
    var spc = this.spc;
    var sumI = 0;
    var sumQ = 0;
    var energy = 0;
    for (var k = 0; k < C.PREAMBLE_LEN; k++) {
      var a0 = Math.round(preStart + k * spc);
      var a1 = Math.round(preStart + (k + 1) * spc);
      var ci = 0;
      var cq = 0;
      for (var m = a0; m < a1; m++) {
        var ph = this.wPre * m;
        var x = this._rawAt(m);
        ci += x * Math.cos(ph);
        cq += x * -Math.sin(ph);
      }
      var n = a1 - a0 || 1;
      ci /= n;
      cq /= n;
      sumI += ci * code[k];
      sumQ += cq * code[k];
      energy += ci * ci + cq * cq;
    }
    if (energy <= 0) return { rho: 0, mag: 0 };
    return { rho: (sumI * sumI + sumQ * sumQ) / (C.PREAMBLE_LEN * energy), mag: sumI * sumI + sumQ * sumQ };
  };

  Demod.prototype._finishChip = function () {
    var N = this.chipFill;
    if (N <= 0) return null;
    var buf = this.chipBuf;

    var ci = 0;
    var cq = 0;
    var startN = this.n - N;
    for (var i = 0; i < N; i++) {
      var ph = this.wPre * (startN + i);
      ci += buf[i] * Math.cos(ph);
      cq += buf[i] * -Math.sin(ph);
    }
    ci /= N;
    cq /= N;
    this._pushHist(ci, cq);

    var thisChip = this.chipCount;
    this.chipFill = 0;
    this.chipCount++;

    var out = null;

    if (this.histFill >= C.PREAMBLE_LEN) {
      var energy = 0;
      for (var k = 0; k < C.PREAMBLE_LEN; k++) {
        energy += this.histI[k] * this.histI[k] + this.histQ[k] * this.histQ[k];
      }
      if (energy >= this.detectEmin) {
        var bestRho = 0;
        var bestNode = -1;
        for (var c = 0; c < C.MAX_NODES; c++) {
          var code = nodeCode(c);
          var sI = 0;
          var sQ = 0;
          for (var j = 0; j < C.PREAMBLE_LEN; j++) {
            var p = (this.histPos + j) % C.PREAMBLE_LEN;
            var sg = code[j];
            sI += this.histI[p] * sg;
            sQ += this.histQ[p] * sg;
          }
          var rho = (sI * sI + sQ * sQ) / (C.PREAMBLE_LEN * energy);
          if (rho > bestRho) {
            bestRho = rho;
            bestNode = c;
          }
        }
        if (bestRho > this.armThresh && !this.armed) {
          this.armed = true;
          this.armSample = this.n; // ≈ a preamble-end sample near true alignment
          this.armChip = thisChip;
        }
      }
    }

    // Wait until the whole frame is buffered, then locate the true preamble by a
    // bounded (node, sample-offset) search over the raw ring — data chips (which
    // include a 4 kHz tone) can otherwise spoof the streaming correlator.
    if (this.armed && this.chipCount - this.armChip >= C.DATA_BITS + 22) {
      out = this._decodeFrame();
      this.armed = false;
    }
    return out;
  };

  Demod.prototype._extractBits = function (dataStart, node) {
    var spc = this.spc;
    for (var bi = 0; bi < C.DATA_BITS; bi++) {
      var n0 = Math.round(dataStart + bi * spc);
      var n1 = Math.round(dataStart + (bi + 1) * spc);
      var pair = hopPair(bi, node);
      var eLo = this._toneEnergy(n0, n1, pair.lo);
      var eHi = this._toneEnergy(n0, n1, pair.hi);
      this.dataBits[bi] = eHi > eLo ? 1 : 0;
    }
    return bitsToBytes(this.dataBits);
  };

  Demod.prototype._decodeFrame = function () {
    this.stats.detects++;
    var spc = this.spc;
    var center = this.armSample;
    // The coarse trigger fires on the rising edge, up to ~15 chips before the
    // true preamble end; search mostly forward from it.
    var dLo = -Math.round(6 * spc);
    var dHi = Math.round(20 * spc);

    // Because the 4 kHz preamble carrier is also a data hop tone, the data
    // region can spoof the preamble correlator. Gather all strong (node, timing)
    // candidates and let the CRC pick the real one.
    var cands = [];
    for (var node = 0; node < C.MAX_NODES; node++) {
      for (var d = dLo; d <= dHi; d++) {
        var end = center + d;
        var r = this._preCorr(end - C.PREAMBLE_LEN * spc, node).rho;
        if (r > 0.55) cands.push({ rho: r, node: node, end: end });
      }
    }
    cands.sort(function (a, b) {
      return b.rho - a.rho;
    });

    var tried = {};
    var limit = Math.min(cands.length, 80);
    for (var i = 0; i < limit; i++) {
      var c = cands[i];
      var key = c.node + ":" + c.end;
      if (tried[key]) continue;
      tried[key] = 1;
      var bytes = this._extractBits(c.end, c.node);
      var parsed = parseFrame(bytes);
      if (parsed) {
        this.stats.decoded++;
        parsed.rho = c.rho;
        parsed.codeIndex = c.node;
        parsed.snrDb =
          10 * Math.log10(c.rho / Math.max(1e-6, 1 - Math.min(0.999, c.rho)));
        parsed.bytes = bytes;
        return parsed;
      }
    }
    this.stats.badCrc++;
    return null;
  };

  Demod.prototype.push = function (samples) {
    var out = [];
    for (var i = 0; i < samples.length; i++) {
      var x = samples[i];
      var ri = this.n % this.rawLen;
      this.raw[ri] = x;
      if (this.chipFill < this.chipBuf.length) this.chipBuf[this.chipFill++] = x;
      this.n++;
      if (this.n >= this.nextBoundary) {
        this.nextBoundary += this.spc;
        var d = this._finishChip();
        if (d) out.push(d);
      }
    }
    return out;
  };

  // ---- Streaming linear resampler (mic rate -> 48 kHz demod rate) --------
  function Resampler(inRate, outRate) {
    this.step = inRate / outRate; // input samples advanced per output sample
    this.t = 0;
    this.buf = new Float32Array(0);
    this.passthrough = inRate === outRate;
  }
  Resampler.prototype.process = function (input) {
    if (this.passthrough) return input;
    var b = new Float32Array(this.buf.length + input.length);
    b.set(this.buf, 0);
    b.set(input, this.buf.length);
    var out = [];
    var t = this.t;
    while (Math.floor(t) + 1 < b.length) {
      var i = Math.floor(t);
      var f = t - i;
      out.push(b[i] * (1 - f) + b[i + 1] * f);
      t += this.step;
    }
    var consumed = Math.floor(t);
    if (consumed > 0) {
      this.buf = Float32Array.from(b.subarray(consumed));
      t -= consumed;
    } else {
      this.buf = b;
    }
    this.t = t;
    return Float32Array.from(out);
  };

  var API = {
    CONST: C,
    Resampler: Resampler,
    TYPE: TYPE,
    TYPE_NAME: TYPE_NAME,
    FLAG: FLAG,
    crc32: crc32,
    nodeCode: nodeCode,
    hopPair: hopPair,
    packFrame: packFrame,
    parseFrame: parseFrame,
    bytesToBits: bytesToBits,
    bitsToBytes: bitsToBytes,
    modulate: modulate,
    modulateFrame: modulateFrame,
    Demod: Demod,
    _mseq: MSEQ31,
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
