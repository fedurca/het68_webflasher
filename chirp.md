# het68 chirp — web implementation & dual-profile mode

This document describes the **browser** implementation of the het68 acoustic
"chirp" link that ships on `chirp.het68.cz` ([`public/chirp/alink.js`](public/chirp/alink.js)
= modem, [`public/chirp/chirp.js`](public/chirp/chirp.js) = UI). It follows the
het68 firmware spec **v1.4.0** (`ALINK_VERSION = 2`) and adds a **dual-profile
mode** so the same page can talk to two very different transducers.

> The canonical wire spec lives in the firmware repo (`fedurca/het68`,
> `chirp.md`). This file documents the web build and the profile system.

---

## 1. Why two profiles

The physical transducer dominates what actually gets on air:

| Transducer | Emits well | Emits poorly |
|---|---|---|
| **Phone speaker + mic** | ≲ ~3 kHz | ≳ 3 kHz (sharp roll-off) |
| **Passive PS1240 piezo** (het68 HW) | ~4 kHz (mechanical resonance) | far from 3.5–4.5 kHz |

These are opposite constraints. Measured on real phone recordings, the spec's
4 kHz preamble + 3–5.4 kHz data hops barely survived the speaker→mic path (the
usable energy sat around 1.5–3 kHz), so nothing decoded. A single fixed band
cannot serve both, hence two selectable **profiles**:

| Profile | Preamble | Hop tones | Preamble chip | Data chip | Frame air-time | Intended for |
|---|---|---|---|---|---|---|
| **Phone** (default) | 2000 Hz | 1400–2800 Hz (8, 200 Hz step) | 1 ms | 4 ms | ~1.02 s | phone speaker/mic, browser↔browser |
| **Piezo** (spec band) | 4000 Hz | 3000–5400 Hz (spec set) | 1 ms | 4 ms | ~1.02 s | resonant 4 kHz piezo / 4 kHz-capable transducer |

Both profiles keep **the same link structure and chip timing** — only the
**carrier band** changes. (The firmware spec uses 250 µs chips, but a 250 µs
burst can't form a clean tone acoustically, so the web build uses the longer
1 ms/4 ms chips in *both* profiles; only the band distinguishes them.) TX and RX
**must use the same profile**; the selector sets it for both and the choice is
remembered in `localStorage` (`het68-chirp-profile`).

Validated in simulation: **Phone** decodes reliably at ≥15 dB SNR through a
phone-like 3.2 kHz low-pass; **Piezo** decodes reliably at ≥25 dB (its 3–5.4 kHz
tones need a transducer that actually radiates there — i.e. a resonant piezo,
not a phone speaker).

---

## 2. Shared link structure (both profiles)

Unchanged from spec v1.4.0:

- **Frame:** fixed 31 bytes — `version(=2) · node_id · type · seq · flags ·
  key_id · nonce(LE32) · len · payload[16] · CRC32(LE, over bytes 0..26)`.
  Types `BEACON/DETECT/CTRL/ACK`; flags `ENCRYPTED/ACK_REQ/SYNCED`.
  **No FEC** — integrity is CRC32 only.
- **Bits:** 31 bytes → **248 data bits** (MSB-first), no expansion.
- **Preamble (CDMA):** length-31 m-sequence (`x^5 + x^2 + 1`), circular shift
  `= node_id·3`, transmitted as **BPSK** on the preamble carrier. Used for
  acquisition, sender identity and time-of-arrival.
- **Data (FHSS + 2-FSK):** for data-bit `i` the per-chip hop base is
  `base = (i + node_id·3) mod (NHOPS/2)`; the two candidate tones are
  `HOPS[base]` (bit 0) and `HOPS[base + NHOPS/2]` (bit 1). Because the pair is
  offset by `NHOPS/2 = 4`, the two tones are ~800 Hz (Phone) / ~1.4 kHz (Piezo)
  apart. Detection is **non-coherent** (compare tone energies).
- **Chips:** 31 preamble + 248 data = **279 chips** per frame.

Only `PREAMBLE_HZ`, `HOPS[]`, `PRE_CHIP_MS` and `DATA_CHIP_MS` differ between
profiles (see [`alink.js`](public/chirp/alink.js) `PROFILES`).

---

## 3. Transmitter

`ALINK.modulateFrame(fields, fs, {gain})`:

1. Pack fields → 31 bytes → 248 bits (`packFrame`, `bytesToBits`).
2. **Preamble region:** `PREAMBLE_LEN` chips of continuous-carrier BPSK at
   `PREAMBLE_HZ`; chip sign = the node's shifted m-sequence (`±1`).
3. **Data region:** for each bit, a single tone at the selected hop frequency,
   `DATA_CHIP_MS` long, phase reset per chip (non-coherent).
4. Raised-cosine edges to avoid clicks; played once via a `BufferSource`
   (48 kHz `AudioContext`).

The short **preamble-only ping** (`ALINK.modulate(nodeCode(id), …)`) is used by
the "short test" button — a quick audible TX/mic check (~31 chips only).

---

## 4. Receiver

The mic runs at 48 kHz (forced; if the device reports another rate the stream
is resampled with `ALINK.Resampler`). `ALINK.Demod(48000)`:

1. **Chip integration** on a `PRE_CHIP_MS` grid; raw samples are also kept in a
   ring big enough for a whole frame.
2. **Coarse acquisition (streaming):** downconvert to I/Q at `PREAMBLE_HZ`,
   correlate the last 31 chips against all 8 node codes; **arm** when the
   normalized peak `ρ` crosses a low threshold (0.38).
3. **Buffered fine search:** once the whole frame has streamed in, search a
   bounded window of `(node, sample-offset)` over the raw preamble to find the
   true alignment. Because the preamble carrier is also a data hop tone, the
   data region can spoof the correlator, so several strong candidates are tried
   and the **CRC decides** which is real.
4. **Data slicing:** for each of the 248 bits, integrate energy (Goertzel) at
   the two candidate hop tones over its `DATA_CHIP_MS` window; the larger wins.
   A **per-hop-tone channel-gain normalization** (average energy per tone across
   the frame) compensates the uneven speaker/mic response.
5. **Decode:** 248 bits → 31 bytes → CRC32 + `version==2` check → dispatch to
   the received-frames table and peer table.

`stats = { detects, decoded, badCrc }` is shown live.

---

## 5. Using the dual profile

- **Phone (default):** pick this for phone/laptop speakers and for testing
  browser↔browser (or self-loopback on one device — the mic hears the speaker,
  own TX is *not* filtered unless you tick "filter own TX"). Reliable: simulated
  through a phone-like low-pass (3.2 kHz) + noise it decodes 40/40 at 15–25 dB.
- **Piezo (4 kHz band):** pick this to drive a resonant 4 kHz piezo (the het68
  hardware band). On a phone **speaker** this band barely radiates, so
  browser↔browser decode over a phone speaker is unreliable in Piezo mode — it
  is meant for a transducer that emits at 3–5.4 kHz (a resonant piezo), where it
  decodes cleanly at close range / high SNR.

Switching the profile while the mic is running rebuilds the receiver instantly;
the spectrogram's dashed band guides move to the active preamble/hop edges.

---

## 6. Limitations

- **No FEC** (per spec) → a handful of bit errors fails the whole frame; the
  link leans on short, repeated beacons. Give it adequate volume and proximity.
- Profiles are **not wire-compatible with each other**, and the Phone profile is
  **not wire-compatible with 4 kHz piezo hardware** (different band/timing).
- Exact hardware interop in Piezo mode is **not bench-validated** (the firmware
  spec itself flags v1.4 as best-effort).
- Two overlapping simultaneous senders may decode only the strongest (single
  matched-filter receiver, no parallel per-code correlators).
