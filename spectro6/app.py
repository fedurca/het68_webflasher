#!/usr/bin/env python3
"""
HET68 spectro6 — local 6-channel spectrogram + 2 kHz VU meters.

Captures a multi-channel USB mic (UAC2, typically 6× ICS-43434 @ 48 kHz)
via PortAudio/ALSA and streams FFT columns + band-limited VU levels to a
localhost web UI. Browsers cannot open 6 channels; this host-side tool can.

Usage (Ubuntu):
  cd spectro6
  python3 -m venv .venv && source .venv/bin/activate
  pip install -r requirements.txt
  python3 app.py --list-devices
  python3 app.py                          # auto → ALSA Pico 6ch hw
  python3 app.py --device 4
  # open http://127.0.0.1:8765/
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import sys
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import numpy as np
import sounddevice as sd
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

# ---- DSP defaults (HET68 UAC2) --------------------------------------------
SAMPLE_RATE = 48_000
CHANNELS = 6
# Larger period = fewer USB SOF edge-cases stuffing digital zeros into the stream
BLOCK = 2048
FFT_SIZE = 2048
HOP = 512
VU_HZ = 2_000.0
VU_BW_HZ = 200.0  # ±100 Hz around 2 kHz
SPECTRO_BINS = 256
STREAM_HZ = 30
STDOUT_VU_HZ = 4
# Spectro display window (dBFS) — ambient ~-60..-30 should not look "clipped"
SPEC_DB_LO = -85.0
SPEC_DB_HI = -15.0
MAX_COLS_PER_TICK = 64
RING_MAX = 512
CLIP_THRESH = 0.98
# Digital-silence: PortAudio still delivers blocks, but samples are ~0 (USB gap)
ZERO_PEAK_THRESH = 1e-7
GAP_DB_THRESH = -140.0  # spectro/VU below this ⇒ treat hop as gap
DEFAULT_LATENCY = 0.20  # seconds — USB-friendly
ASSET_VER = "20260926d"

STATIC_DIR = Path(__file__).resolve().parent / "static"

log = logging.getLogger("spectro6")


def _vout(msg: str) -> None:
    """Always-visible console line (do not also log.info — that doubles every line)."""
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def maybe_reexec_pasuspender(enabled: bool) -> None:
    """Re-exec under pasuspender when it actually works (classic PulseAudio).

    On PipeWire-only hosts pasuspender often exits with
    ``Failure to suspend: No such entity`` — in that case just continue
    without wrapping so the app still starts.
    """
    import os
    import shutil
    import subprocess

    if not enabled:
        return
    if os.environ.get("SPECTRO6_UNDER_PASUSPENDER") == "1":
        return
    exe = shutil.which("pasuspender")
    if not exe:
        _vout(
            "[spectro6] tip: pasuspender not found — optional on PipeWire; "
            "ALSA hw: device usually works without it"
        )
        return
    # Probe: does pasuspender have a Pulse entity to suspend?
    probe = subprocess.run([exe, "--", "true"], capture_output=True, text=True)
    if probe.returncode != 0:
        err = (probe.stderr or probe.stdout or "").strip().splitlines()
        tip = err[-1] if err else f"exit {probe.returncode}"
        _vout(f"[spectro6] pasuspender skip ({tip}) — continuing without it")
        return
    env = os.environ.copy()
    env["SPECTRO6_UNDER_PASUSPENDER"] = "1"
    _vout("[spectro6] re-exec under pasuspender (suspend Pulse)…")
    os.execvpe(exe, ["pasuspender", "--", sys.executable, *sys.argv], env)


def list_devices() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, d in enumerate(sd.query_devices()):
        if int(d.get("max_input_channels") or 0) < 1:
            continue
        host = sd.query_hostapis(int(d["hostapi"]))["name"]
        name = str(d["name"])
        out.append(
            {
                "id": i,
                "name": name,
                "channels": int(d["max_input_channels"]),
                "default_sr": float(d.get("default_samplerate") or SAMPLE_RATE),
                "hostapi": host,
                "is_alsa": "ALSA" in host,
                "is_pulse": "Pulse" in host,
                "is_virtual": name.lower()
                in ("sysdefault", "default", "pipewire", "pulse", "lavrate", "samplerate", "speexrate"),
            }
        )
    return out


def _score_device(d: dict[str, Any], need_ch: int) -> tuple[int, int, int]:
    """Higher is better: real ALSA Pico/HET68 6ch hw beats Pulse/pipewire stubs."""
    ch = d["channels"]
    name = d["name"].lower()
    score = 0
    if ch == need_ch:
        score += 120
    elif ch >= need_ch:
        score += 40  # e.g. sysdefault 128 — usable but not preferred
    elif ch >= 2:
        score += 5

    if d.get("is_alsa"):
        score += 40
    if d.get("is_pulse"):
        score -= 50
    if d.get("is_virtual"):
        score -= 80

    if "hw:" in name:
        score += 35
    if "usb audio" in name or "usb" in name:
        score += 15
    if "pico" in name and "6ch" in name:
        score += 50
    elif "6ch" in name or "pico" in name:
        score += 20
    if "het68" in name:
        score += 25
    if "surround" in name or "monitor" in name:
        score -= 60
    if "analog-surround" in name:
        score -= 40

    return (score, ch if ch == need_ch else -abs(ch - need_ch), -d["id"])


def preferred_device(need_ch: int = CHANNELS) -> dict[str, Any] | None:
    devices = list_devices()
    if not devices:
        return None
    ranked = sorted(devices, key=lambda d: _score_device(d, need_ch), reverse=True)
    return ranked[0]


def resolve_device(spec: str | None, need_ch: int = CHANNELS) -> int:
    """Resolve device id. Prefers ALSA Pico 6ch hw over Pulse surround stubs.

    Raises ValueError on failure (safe to call from WebSocket handlers).
    """
    devices = list_devices()
    if not devices:
        raise ValueError("No input devices found.")

    if isinstance(spec, int) or (isinstance(spec, str) and str(spec).isdigit()):
        idx = int(spec)
        hit = next((d for d in devices if d["id"] == idx), None)
        if not hit:
            raise ValueError(f"No input device with id {idx}. Try --list-devices.")
        if hit["channels"] < need_ch:
            log.warning(
                "Device %s has only %d channels (need %d). "
                "Prefer ALSA 'Pico 6ch … USB Audio (hw:X,0)' over Pulse surround.",
                idx,
                hit["channels"],
                need_ch,
            )
        return idx

    if spec is None or spec == "" or str(spec).lower() in ("default", "auto"):
        best = preferred_device(need_ch)
        assert best is not None
        log.info(
            "auto device id=%s %r (%d ch, %s) score=%s",
            best["id"],
            best["name"],
            best["channels"],
            best["hostapi"],
            _score_device(best, need_ch),
        )
        if best["channels"] < need_ch:
            log.warning(
                "No device with ≥%d channels; best is id=%s %r (%d ch)",
                need_ch,
                best["id"],
                best["name"],
                best["channels"],
            )
        return int(best["id"])

    needle = str(spec).lower()
    aliases = {needle}
    if "het68" in needle or needle in ("pico", "6ch", "usb", "pico 6ch"):
        aliases.update({"het68", "pico 6ch", "6ch microphone", "pico"})

    hits = [d for d in devices if any(a in d["name"].lower() for a in aliases if a)]
    if not hits:
        raise ValueError(
            f"No input device matching {spec!r}. Try --list-devices "
            f"(look for ALSA 'Pico 6ch … USB Audio (hw:…)' with 6 channels)."
        )

    ranked = sorted(hits, key=lambda d: _score_device(d, need_ch), reverse=True)
    best = ranked[0]
    if len(ranked) > 1:
        log.info(
            "name %r matched %d devices; picking id=%s %r (%d ch, %s) [others: %s]",
            spec,
            len(ranked),
            best["id"],
            best["name"],
            best["channels"],
            best["hostapi"],
            ", ".join(f'{d["id"]}:{d["channels"]}ch/{d["hostapi"]}' for d in ranked[1:4]),
        )
    if best["channels"] < need_ch:
        alsa6 = [
            d
            for d in devices
            if d["channels"] >= need_ch
            and d.get("is_alsa")
            and not d.get("is_virtual")
            and (
                "usb" in d["name"].lower()
                or "6ch" in d["name"].lower()
                or "pico" in d["name"].lower()
                or "hw:" in d["name"].lower()
            )
        ]
        if alsa6:
            alt = sorted(alsa6, key=lambda d: _score_device(d, need_ch), reverse=True)[0]
            log.warning(
                "Match %r → id=%s has only %d ch; switching to ALSA 6ch id=%s %r",
                spec,
                best["id"],
                best["channels"],
                alt["id"],
                alt["name"],
            )
            return int(alt["id"])
        raise ValueError(
            f"Best match for {spec!r} is id={best['id']} with only {best['channels']} "
            f"channels. Use --device <id> for ALSA 6ch (see --list-devices)."
        )
    return int(best["id"])


def _db_to_u8(db: np.ndarray, lo: float = SPEC_DB_LO, hi: float = SPEC_DB_HI) -> np.ndarray:
    span = max(hi - lo, 1.0)
    return np.clip((db - lo) * (255.0 / span), 0, 255).astype(np.uint8)


class SpectroEngine:
    """Background PortAudio capture → per-channel spectrogram columns + 2 kHz VU."""

    def __init__(
        self,
        device: int | None,
        channels: int = CHANNELS,
        sample_rate: int = SAMPLE_RATE,
        debug: bool = True,
        latency: float = DEFAULT_LATENCY,
        blocksize: int = BLOCK,
        gap_hold: bool = False,
    ) -> None:
        self.device = device
        self.channels = channels
        self.sample_rate = sample_rate
        self.debug = debug
        self.latency = float(latency)
        self.blocksize = int(blocksize)
        self.gap_hold = bool(gap_hold)
        self._lock = threading.Lock()
        self._ring: deque[np.ndarray] = deque(maxlen=RING_MAX)
        self._stream: sd.InputStream | None = None
        self._running = False
        self._last_error: str | None = None
        self._window = np.hanning(FFT_SIZE).astype(np.float32)
        # Coherent gain ≈ sum(window)/N — normalize band power toward dBFS-ish
        self._win_cg = float(np.sum(self._window) / FFT_SIZE) or 1.0
        self._vu = np.full(channels, -120.0, dtype=np.float32)
        self._peak = np.zeros(channels, dtype=np.float32)
        self._peak_db = np.full(channels, -120.0, dtype=np.float32)
        self._clips = np.zeros(channels, dtype=np.int64)
        self._clips_tick = np.zeros(channels, dtype=np.int64)
        self._cols = np.zeros((channels, SPECTRO_BINS), dtype=np.float32)
        self._last_good_cols = np.zeros((channels, SPECTRO_BINS), dtype=np.float32)
        self._overflows = 0
        self._ring_drops = 0
        self._zero_blocks = 0
        self._zero_blocks_tick = 0
        self._gap_hops = 0
        self._gap_hops_tick = 0
        self._callback_blocks = 0
        self._frames = 0
        self._last_stdout_vu = 0.0
        self._in_gap = False
        self._gap_started_at = 0.0
        self._bin_map = self._build_bin_map()
        freqs = np.fft.rfftfreq(FFT_SIZE, 1.0 / sample_rate)
        lo, hi = VU_HZ - VU_BW_HZ / 2, VU_HZ + VU_BW_HZ / 2
        self._vu_bins = np.where((freqs >= lo) & (freqs <= hi))[0]
        if self._vu_bins.size == 0:
            self._vu_bins = np.array([int(round(VU_HZ * FFT_SIZE / sample_rate))])
        self._tail = np.zeros((0, channels), dtype=np.float32)

    def _build_bin_map(self) -> np.ndarray:
        f_min, f_max = 100.0, self.sample_rate / 2
        ui = np.linspace(0, 1, SPECTRO_BINS)
        freqs = f_min * (f_max / f_min) ** ui
        fft_freqs = np.fft.rfftfreq(FFT_SIZE, 1.0 / self.sample_rate)
        n_fft = FFT_SIZE // 2 + 1
        idx = np.searchsorted(fft_freqs, freqs).clip(0, n_fft - 1)
        return idx.astype(np.int32)

    def configure(self, device: int | None = None, channels: int | None = None) -> None:
        was = self._running
        if was:
            self.stop()
        if device is not None:
            self.device = device
        if channels is not None and channels != self.channels:
            self.channels = channels
            self._vu = np.full(channels, -120.0, dtype=np.float32)
            self._peak = np.zeros(channels, dtype=np.float32)
            self._peak_db = np.full(channels, -120.0, dtype=np.float32)
            self._clips = np.zeros(channels, dtype=np.int64)
            self._clips_tick = np.zeros(channels, dtype=np.int64)
            self._cols = np.zeros((channels, SPECTRO_BINS), dtype=np.float32)
            self._tail = np.zeros((0, channels), dtype=np.float32)
        if was:
            self.start()

    def start(self) -> None:
        if self._running:
            return
        self._last_error = None
        info = (
            sd.query_devices(self.device, "input")
            if self.device is not None
            else sd.query_devices(kind="input")
        )
        max_ch = int(info["max_input_channels"])
        name = str(info["name"])
        log.info(
            "opening device id=%s name=%r max_ch=%s want_ch=%s sr=%s block=%s latency=%.3f",
            self.device,
            name,
            max_ch,
            self.channels,
            self.sample_rate,
            self.blocksize,
            self.latency,
        )
        if max_ch < self.channels:
            msg = (
                f"Device id={self.device} {name!r} reports {max_ch} input channels; "
                f"need {self.channels}. Use ALSA 'Pico 6ch … USB Audio (hw:X,0)' "
                f"(see --list-devices), not PulseAudio surround-21."
            )
            self._last_error = msg
            raise RuntimeError(msg)

        self._ring.clear()
        self._overflows = 0
        self._ring_drops = 0
        self._zero_blocks = 0
        self._zero_blocks_tick = 0
        self._gap_hops = 0
        self._gap_hops_tick = 0
        self._callback_blocks = 0
        self._frames = 0
        self._clips[:] = 0
        self._clips_tick[:] = 0
        self._peak[:] = 0
        self._in_gap = False
        self._tail = np.zeros((0, self.channels), dtype=np.float32)
        try:
            self._stream = sd.InputStream(
                device=self.device,
                channels=self.channels,
                samplerate=self.sample_rate,
                blocksize=self.blocksize,
                dtype="float32",
                callback=self._callback,
                latency=self.latency,
            )
            self._stream.start()
        except Exception as exc:
            self._last_error = str(exc)
            self._stream = None
            raise
        self._running = True
        _vout(
            f"[spectro6] capture ON device={self.device} {name!r} "
            f"ch={self.channels} sr={self.sample_rate} "
            f"block={self.blocksize} latency={self.latency:.3f}s gap_hold={self.gap_hold}"
        )

    def stop(self) -> None:
        self._running = False
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception as exc:
                log.warning("stream close: %s", exc)
            self._stream = None
        _vout("[spectro6] capture OFF")

    def _callback(self, indata, frames, time_info, status) -> None:  # noqa: ANN001
        if status:
            self._overflows += 1
            if self._overflows <= 8:
                log.warning("portaudio status: %s", status)
        absx = np.abs(indata)
        block_peak = absx.max(axis=0)
        peak_all = float(block_peak.max()) if block_peak.size else 0.0
        # Digital-zero block: USB/firmware gap (PortAudio still fires callbacks)
        if peak_all < ZERO_PEAK_THRESH:
            self._zero_blocks += 1
            self._zero_blocks_tick += 1
            if not self._in_gap:
                self._in_gap = True
                self._gap_started_at = time.time()
                _vout(
                    f"[GAP] digital silence START  "
                    f"(peak<{ZERO_PEAK_THRESH:g}) frames={self._frames}"
                )
        else:
            if self._in_gap:
                dt = time.time() - self._gap_started_at
                _vout(
                    f"[GAP] digital silence END  lasted={dt*1000:.0f}ms  "
                    f"zero_blocks={self._zero_blocks}"
                )
                self._in_gap = False
            np.maximum(self._peak, block_peak, out=self._peak)
            clips = (absx >= CLIP_THRESH).sum(axis=0)
            self._clips += clips
            self._clips_tick += clips
        if len(self._ring) >= RING_MAX:
            self._ring_drops += 1
        self._ring.append(indata.copy())
        self._callback_blocks += 1
        self._frames += frames

    def process_once(self) -> dict[str, Any] | None:
        if not self._running:
            return None
        chunks: list[np.ndarray] = []
        while True:
            try:
                chunks.append(self._ring.popleft())
            except IndexError:
                break
        if not chunks:
            self._maybe_stdout_vu(idle=True)
            return None
        block = np.concatenate(chunks, axis=0)  # (n, ch)
        if block.shape[1] != self.channels:
            log.error("channel mismatch: got %s want %s", block.shape, self.channels)
            return None
        buf = np.concatenate([self._tail, block], axis=0) if self._tail.size else block
        cols_acc: list[np.ndarray] = []
        vu_acc: list[np.ndarray] = []
        gap_flags: list[bool] = []
        pos = 0
        # Normalize rFFT power toward ~dBFS for a full-scale sine
        pnorm = 1.0 / max((FFT_SIZE * self._win_cg) ** 2, 1e-20)
        while pos + FFT_SIZE <= buf.shape[0]:
            frame = buf[pos : pos + FFT_SIZE, :]
            # Time-domain peak for this hop — true digital gap?
            hop_peak = float(np.max(np.abs(frame)))
            is_gap = hop_peak < ZERO_PEAK_THRESH
            windowed = frame * self._window[:, None]
            spec = np.fft.rfft(windowed, axis=0)
            power = (spec.real * spec.real + spec.imag * spec.imag).T * pnorm
            col = 10.0 * np.log10(power[:, self._bin_map] + 1e-20)
            band = power[:, self._vu_bins].mean(axis=1)
            vu = 10.0 * np.log10(band + 1e-20)
            if is_gap or float(np.max(vu)) < GAP_DB_THRESH:
                is_gap = True
                self._gap_hops += 1
                self._gap_hops_tick += 1
                if self.gap_hold:
                    col = self._last_good_cols.copy()
                # else leave near-floor col (will be painted as gap stripe in UI)
            else:
                self._last_good_cols = col.astype(np.float32)
            cols_acc.append(col)
            vu_acc.append(vu)
            gap_flags.append(is_gap)
            pos += HOP
        keep = FFT_SIZE - HOP
        self._tail = buf[-keep:] if buf.shape[0] >= keep else buf.copy()
        if not cols_acc:
            self._maybe_stdout_vu(idle=True)
            return None

        if len(cols_acc) > MAX_COLS_PER_TICK:
            cols_acc = cols_acc[-MAX_COLS_PER_TICK:]
            vu_acc = vu_acc[-MAX_COLS_PER_TICK:]
            gap_flags = gap_flags[-MAX_COLS_PER_TICK:]
        self._cols = cols_acc[-1].astype(np.float32)
        # VU from non-gap hops when possible
        live_vu = [v for v, g in zip(vu_acc, gap_flags) if not g]
        if live_vu:
            self._vu = np.mean(np.stack(live_vu, axis=0), axis=0).astype(np.float32)
        else:
            self._vu = np.full(self.channels, -200.0, dtype=np.float32)

        stack = np.stack(cols_acc, axis=0).astype(np.float32)  # (N, ch, bins)
        col_u8 = _db_to_u8(stack)
        vu_norm = np.clip((self._vu - SPEC_DB_LO) / (SPEC_DB_HI - SPEC_DB_LO), 0.0, 1.0)

        with self._lock:
            peak = self._peak.copy()
            self._peak[:] = 0
            clips_tick = self._clips_tick.copy()
            self._clips_tick[:] = 0
            zero_tick = self._zero_blocks_tick
            self._zero_blocks_tick = 0
            gap_tick = self._gap_hops_tick
            self._gap_hops_tick = 0
        peak_db = 20.0 * np.log10(np.maximum(peak, 1e-12))
        self._peak_db = peak_db.astype(np.float32)
        overloaded = [bool(peak[i] >= CLIP_THRESH or clips_tick[i] > 0) for i in range(self.channels)]
        zero_ratio = zero_tick / max(1, len(chunks))

        now = time.time()
        self._maybe_stdout_vu(
            idle=False,
            peak_db=peak_db,
            clips=clips_tick,
            overloaded=overloaded,
            zero_tick=zero_tick,
            gap_tick=gap_tick,
            zero_ratio=zero_ratio,
        )

        return {
            "t": now,
            "sr": self.sample_rate,
            "vu_hz": VU_HZ,
            "vu": vu_norm.tolist(),
            "vu_db": [float(x) for x in self._vu],
            "peak_db": [float(x) for x in peak_db],
            "clips": [int(x) for x in clips_tick],
            "overloaded": overloaded,
            "spectro": base64.b64encode(col_u8.tobytes()).decode("ascii"),
            "shape": [int(col_u8.shape[0]), int(self.channels), int(SPECTRO_BINS)],
            "ncols": int(col_u8.shape[0]),
            "gaps": gap_flags,  # per spectro column
            "gap_hold": self.gap_hold,
            "spec_db": [SPEC_DB_LO, SPEC_DB_HI],
            "overflows": self._overflows,
            "ring_drops": self._ring_drops,
            "zero_blocks": self._zero_blocks,
            "zero_blocks_tick": int(zero_tick),
            "gap_hops": self._gap_hops,
            "gap_hops_tick": int(gap_tick),
            "zero_ratio": float(zero_ratio),
            "frames": self._frames,
            "blocks": self._callback_blocks,
            "ring": len(self._ring),
            "running": True,
        }

    def _maybe_stdout_vu(
        self,
        idle: bool,
        peak_db: np.ndarray | None = None,
        clips: np.ndarray | None = None,
        overloaded: list[bool] | None = None,
        zero_tick: int = 0,
        gap_tick: int = 0,
        zero_ratio: float = 0.0,
    ) -> None:
        now = time.time()
        if now - self._last_stdout_vu < 1.0 / STDOUT_VU_HZ:
            return
        self._last_stdout_vu = now
        parts = [f"mic{i + 1}={self._vu[i]:+6.1f}dB" for i in range(self.channels)]
        extra = ""
        if peak_db is not None:
            pk = " ".join(f"{peak_db[i]:+5.1f}" for i in range(self.channels))
            extra += f"  peak=[{pk}]"
        if clips is not None and int(np.sum(clips)) > 0:
            extra += f"  CLIP={list(map(int, clips))}"
        if overloaded and any(overloaded):
            extra += "  ⚠ OVERLOAD"
        if zero_tick or gap_tick:
            extra += f"  zeros={zero_tick} gap_hops={gap_tick} zero_ratio={zero_ratio:.0%}"
        flag = "idle" if idle else ("GAP" if self._in_gap or zero_ratio > 0.4 else "live")
        _vout(
            f"[VU 2kHz] {'  '.join(parts)}{extra}  "
            f"{flag} frames={self._frames} blocks={self._callback_blocks} "
            f"ovf={self._overflows} drop={self._ring_drops} "
            f"zeros_total={self._zero_blocks}"
        )

    def snapshot_meta(self) -> dict[str, Any]:
        dev_name = "default"
        max_ch = None
        try:
            info = (
                sd.query_devices(self.device, "input")
                if self.device is not None
                else sd.query_devices(kind="input")
            )
            dev_name = str(info["name"])
            max_ch = int(info["max_input_channels"])
        except Exception as exc:
            log.debug("meta device query: %s", exc)
        pref = preferred_device(self.channels)
        return {
            "device": self.device,
            "device_name": dev_name,
            "device_max_channels": max_ch,
            "recommended_device": pref["id"] if pref else None,
            "recommended_name": pref["name"] if pref else None,
            "channels": self.channels,
            "sample_rate": self.sample_rate,
            "vu_hz": VU_HZ,
            "fft_size": FFT_SIZE,
            "spectro_bins": SPECTRO_BINS,
            "spec_db": [SPEC_DB_LO, SPEC_DB_HI],
            "running": self._running,
            "last_error": self._last_error,
            "frames": self._frames,
            "blocks": self._callback_blocks,
            "overflows": self._overflows,
            "ring_drops": self._ring_drops,
            "zero_blocks": self._zero_blocks,
            "gap_hops": self._gap_hops,
            "gap_hold": self.gap_hold,
            "latency": self.latency,
            "blocksize": self.blocksize,
            "peak_db": [float(x) for x in self._peak_db],
            "clips_total": [int(x) for x in self._clips],
            "asset_ver": ASSET_VER,
        }


def create_app(engine: SpectroEngine) -> FastAPI:
    clients: set[WebSocket] = set()
    state: dict[str, Any] = {"push_task": None}

    async def broadcaster() -> None:
        interval = 1.0 / STREAM_HZ
        idle_ticks = 0
        while True:
            t0 = time.perf_counter()
            payload = None
            try:
                if engine._running:
                    payload = await asyncio.to_thread(engine.process_once)
                    if payload is None:
                        idle_ticks += 1
                        if idle_ticks == 60:
                            log.warning(
                                "running but no FFT frames yet "
                                "(blocks=%s ring=%s drops=%s)",
                                engine._callback_blocks,
                                len(engine._ring),
                                engine._ring_drops,
                            )
                            _vout(
                                f"[spectro6] waiting for audio… blocks={engine._callback_blocks} "
                                f"ring={len(engine._ring)} drops={engine._ring_drops}"
                            )
                    else:
                        idle_ticks = 0
                else:
                    # Still tick stdout heartbeat while stopped? no — keep quiet
                    pass
            except Exception:
                log.exception("process_once failed")
                payload = {"type": "error", "message": "process_once failed — see server log"}

            if payload and clients:
                dead: list[WebSocket] = []
                msg = {"type": "frame", **payload} if "type" not in payload else payload
                raw = json.dumps(msg, separators=(",", ":"))
                for ws in list(clients):
                    try:
                        await ws.send_text(raw)
                    except Exception:
                        dead.append(ws)
                for ws in dead:
                    clients.discard(ws)
            dt = time.perf_counter() - t0
            await asyncio.sleep(max(0.0, interval - dt))

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        state["push_task"] = asyncio.create_task(broadcaster())
        try:
            engine.start()
            log.info("auto-start OK: %s", engine.snapshot_meta())
        except Exception as exc:
            log.error("auto-start failed: %s", exc)
            _vout(f"[spectro6] auto-start failed: {exc}")
            _vout(
                "[spectro6] Tip: python3 app.py --list-devices  "
                "→ pick ALSA id with CH=6 (★), not Pulse surround."
            )
        yield
        engine.stop()
        task = state.get("push_task")
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    app = FastAPI(title="HET68 spectro6", docs_url=None, redoc_url=None, lifespan=lifespan)

    def _no_cache(resp: Response) -> Response:
        resp.headers["Cache-Control"] = "no-store, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        return resp

    @app.get("/")
    async def index() -> FileResponse:
        html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        html = html.replace("@@ASSET_VER@@", ASSET_VER)
        return _no_cache(
            Response(content=html, media_type="text/html; charset=utf-8")
        )

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/api/devices")
    async def api_devices() -> dict[str, Any]:
        devices = list_devices()
        pref = preferred_device(engine.channels)
        # Annotate scores for UI sorting / debug
        for d in devices:
            d["score"] = int(_score_device(d, engine.channels)[0])
            d["recommended"] = bool(pref and d["id"] == pref["id"])
        return {
            "devices": devices,
            "recommended_device": pref["id"] if pref else None,
            "meta": engine.snapshot_meta(),
        }

    @app.get("/api/meta")
    async def api_meta() -> dict[str, Any]:
        return engine.snapshot_meta()

    @app.websocket("/ws")
    async def ws_stream(ws: WebSocket) -> None:
        await ws.accept()
        clients.add(ws)
        log.info("ws client +1 (n=%s)", len(clients))
        try:
            await ws.send_json({"type": "meta", **engine.snapshot_meta()})
            while True:
                try:
                    msg = await asyncio.wait_for(ws.receive_text(), timeout=0.25)
                except asyncio.TimeoutError:
                    continue
                try:
                    data = json.loads(msg)
                except json.JSONDecodeError:
                    continue
                cmd = data.get("cmd")
                if cmd == "start":
                    try:
                        if "device" in data and data["device"] is not None:
                            raw_dev = data["device"]
                            if isinstance(raw_dev, int):
                                new_id = raw_dev
                            elif isinstance(raw_dev, str):
                                new_id = resolve_device(raw_dev, engine.channels)
                            else:
                                new_id = int(raw_dev)
                            if new_id != engine.device or not engine._running:
                                log.info(
                                    "ws start: switching device %s → %s (was_running=%s)",
                                    engine.device,
                                    new_id,
                                    engine._running,
                                )
                                engine.configure(device=new_id)
                        if not engine._running:
                            engine.start()
                        await ws.send_json({"type": "meta", **engine.snapshot_meta()})
                        log.info(
                            "ws start OK device=%s name=%r",
                            engine.device,
                            engine.snapshot_meta().get("device_name"),
                        )
                    except Exception as exc:
                        log.error("ws start failed: %s", exc)
                        _vout(f"[spectro6] start failed: {exc}")
                        await ws.send_json({"type": "error", "message": str(exc)})
                        await ws.send_json({"type": "meta", **engine.snapshot_meta()})
                elif cmd == "stop":
                    engine.stop()
                    await ws.send_json({"type": "meta", **engine.snapshot_meta()})
                elif cmd == "ping":
                    await ws.send_json({"type": "pong", "t": time.time(), **engine.snapshot_meta()})
        except WebSocketDisconnect:
            pass
        finally:
            clients.discard(ws)
            log.info("ws client -1 (n=%s)", len(clients))

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="HET68 6-channel spectrogram + 2 kHz VU (localhost)")
    parser.add_argument("--list-devices", action="store_true", help="List input devices and exit")
    parser.add_argument(
        "--device",
        default="auto",
        help="Device id, name substring, or auto (prefer ALSA Pico 6ch hw)",
    )
    parser.add_argument("--channels", type=int, default=CHANNELS, help="Input channel count (default 6)")
    parser.add_argument("--rate", type=int, default=SAMPLE_RATE, help="Sample rate Hz (default 48000)")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="HTTP port (default 8765)")
    parser.add_argument(
        "--latency",
        type=float,
        default=DEFAULT_LATENCY,
        help=f"PortAudio input latency seconds (default {DEFAULT_LATENCY})",
    )
    parser.add_argument(
        "--blocksize",
        type=int,
        default=BLOCK,
        help=f"PortAudio blocksize (default {BLOCK}; try 4096 if gaps persist)",
    )
    parser.add_argument(
        "--gap-hold",
        action="store_true",
        help="Cosmetically hold last good spectro column during digital-zero gaps",
    )
    parser.add_argument(
        "--no-pasuspender",
        action="store_true",
        help="Do not re-exec under pasuspender (Pulse/PipeWire stay active)",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Debug logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    if args.list_devices:
        print(f"{'ID':>4}  {'CH':>3}  {'SR':>8}  {'HostAPI':<16}  {'Score':>5}  Name")
        devices = list_devices()
        pref = preferred_device(CHANNELS)
        for d in sorted(devices, key=lambda x: _score_device(x, CHANNELS), reverse=True):
            mark = ""
            score = _score_device(d, CHANNELS)[0]
            if pref and d["id"] == pref["id"]:
                mark = "  ← DEFAULT"
            elif d["channels"] < CHANNELS and "surround" in d["name"].lower():
                mark = "  (Pulse stub — skip)"
            elif d.get("is_virtual"):
                mark = "  (virtual — skip)"
            print(
                f"{d['id']:4d}  {d['channels']:3d}  {d['default_sr']:8.0f}  "
                f"{d['hostapi']:<16}  {score:5d}  {d['name']}{mark}"
            )
        if pref:
            print(
                f"\nDefault auto → id={pref['id']} {pref['name']!r}",
                flush=True,
            )
        print(
            "Tip: python3 app.py --device auto   # or numeric ALSA 6ch id\n"
            "Gaps tip: pasuspender -- python3 app.py   # or omit --no-pasuspender",
            flush=True,
        )
        return

    # Suspend Pulse/PipeWire so they don't steal/zero-fill the USB mic
    maybe_reexec_pasuspender(enabled=not args.no_pasuspender)

    try:
        device = resolve_device(args.device, need_ch=args.channels)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    engine = SpectroEngine(
        device=device,
        channels=args.channels,
        sample_rate=args.rate,
        debug=True,
        latency=args.latency,
        blocksize=args.blocksize,
        gap_hold=args.gap_hold,
    )
    app = create_app(engine)
    _vout(
        f"[spectro6] http://{args.host}:{args.port}/  "
        f"device={device} ch={args.channels} sr={args.rate} vu={VU_HZ:.0f}Hz "
        f"block={args.blocksize} lat={args.latency:.3f}s ver={ASSET_VER}"
    )
    _vout(
        "[spectro6] console: [VU 2kHz] + [GAP] digital-silence markers; "
        "ovf/drop=0 with zeros_* > 0 ⇒ USB/firmware/Pulse gap, not UI"
    )
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
