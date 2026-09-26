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
  python3 app.py --device 4              # prefer numeric ALSA id with 6ch
  python3 app.py --device "Pico 6ch"     # or name substring
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
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# ---- DSP defaults (HET68 UAC2) --------------------------------------------
SAMPLE_RATE = 48_000
CHANNELS = 6
BLOCK = 1024
FFT_SIZE = 2048
HOP = 512
VU_HZ = 2_000.0
VU_BW_HZ = 200.0  # ±100 Hz around 2 kHz
SPECTRO_BINS = 256
STREAM_HZ = 20
STDOUT_VU_HZ = 4  # print mic1..mic6 2 kHz levels this often

STATIC_DIR = Path(__file__).resolve().parent / "static"

log = logging.getLogger("spectro6")


def list_devices() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i, d in enumerate(sd.query_devices()):
        if int(d.get("max_input_channels") or 0) < 1:
            continue
        host = sd.query_hostapis(int(d["hostapi"]))["name"]
        out.append(
            {
                "id": i,
                "name": d["name"],
                "channels": int(d["max_input_channels"]),
                "default_sr": float(d.get("default_samplerate") or SAMPLE_RATE),
                "hostapi": host,
                "is_alsa": "ALSA" in host,
                "is_pulse": "Pulse" in host,
            }
        )
    return out


def _score_device(d: dict[str, Any], need_ch: int) -> tuple[int, int, int]:
    """Higher is better: enough channels, ALSA USB/hw, not Pulse surround stub."""
    ch = d["channels"]
    name = d["name"].lower()
    score = 0
    if ch >= need_ch:
        score += 100
    elif ch >= 2:
        score += 10
    if d.get("is_alsa"):
        score += 30
    if d.get("is_pulse"):
        score -= 20
    if "hw:" in name or "usb audio" in name:
        score += 20
    if "6ch" in name or "pico" in name:
        score += 15
    if "surround" in name or "monitor" in name:
        score -= 40
    if "het68" in name:
        score += 5
    # Prefer exact channel match slightly
    if ch == need_ch:
        score += 5
    return (score, ch, -d["id"])


def resolve_device(spec: str | None, need_ch: int = CHANNELS) -> int:
    """Resolve device id. Prefers ALSA 6ch over Pulse 'surround-21' stubs.

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
        ranked = sorted(devices, key=lambda d: _score_device(d, need_ch), reverse=True)
        best = ranked[0]
        if best["channels"] < need_ch:
            log.warning(
                "No device with ≥%d channels; best is id=%s %r (%d ch)",
                need_ch,
                best["id"],
                best["name"],
                best["channels"],
            )
        else:
            log.info(
                "auto device id=%s %r (%d ch, %s)",
                best["id"],
                best["name"],
                best["channels"],
                best["hostapi"],
            )
        return int(best["id"])

    needle = str(spec).lower()
    # Expand common aliases for HET68 — but score prefers real 6ch ALSA hw
    aliases = {needle}
    if "het68" in needle or needle in ("pico", "6ch", "usb", "pico 6ch"):
        aliases.update({"het68", "pico 6ch", "6ch microphone", "pico"})

    hits: list[dict[str, Any]] = []
    for d in devices:
        name_l = d["name"].lower()
        if any(a in name_l for a in aliases if a):
            hits.append(d)
    if not hits:
        raise ValueError(
            f"No input device matching {spec!r}. Try --list-devices "
            f"(look for ALSA 'Pico 6ch … USB Audio (hw:…)' with 6 channels)."
        )

    ranked = sorted(hits, key=lambda d: _score_device(d, need_ch), reverse=True)
    best = ranked[0]
    if len(ranked) > 1:
        log.info(
            "name %r matched %d devices; picking id=%s %r (%d ch, %s) "
            "[others: %s]",
            spec,
            len(ranked),
            best["id"],
            best["name"],
            best["channels"],
            best["hostapi"],
            ", ".join(f'{d["id"]}:{d["channels"]}ch/{d["hostapi"]}' for d in ranked[1:4]),
        )
    if best["channels"] < need_ch:
        # Fallback: any 6ch ALSA USB/Pico regardless of name match
        alsa6 = [
            d
            for d in devices
            if d["channels"] >= need_ch
            and d.get("is_alsa")
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


class SpectroEngine:
    """Background PortAudio capture → per-channel spectrogram columns + 2 kHz VU."""

    def __init__(
        self,
        device: int | None,
        channels: int = CHANNELS,
        sample_rate: int = SAMPLE_RATE,
        debug: bool = True,
    ) -> None:
        self.device = device
        self.channels = channels
        self.sample_rate = sample_rate
        self.debug = debug
        self._lock = threading.Lock()
        self._ring: deque[np.ndarray] = deque(maxlen=32)
        self._stream: sd.InputStream | None = None
        self._running = False
        self._last_error: str | None = None
        self._window = np.hanning(FFT_SIZE).astype(np.float32)
        self._vu = np.full(channels, -120.0, dtype=np.float32)
        self._cols = np.zeros((channels, SPECTRO_BINS), dtype=np.float32)
        self._overflows = 0
        self._callback_blocks = 0
        self._frames = 0
        self._last_stdout_vu = 0.0
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
            "opening device id=%s name=%r max_ch=%s want_ch=%s sr=%s",
            self.device,
            name,
            max_ch,
            self.channels,
            self.sample_rate,
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
        self._callback_blocks = 0
        self._frames = 0
        self._tail = np.zeros((0, self.channels), dtype=np.float32)
        try:
            self._stream = sd.InputStream(
                device=self.device,
                channels=self.channels,
                samplerate=self.sample_rate,
                blocksize=BLOCK,
                dtype="float32",
                callback=self._callback,
                latency="low",
            )
            self._stream.start()
        except Exception as exc:
            self._last_error = str(exc)
            self._stream = None
            raise
        self._running = True
        log.info("capture started")

    def stop(self) -> None:
        self._running = False
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception as exc:
                log.warning("stream close: %s", exc)
            self._stream = None
        log.info("capture stopped")

    def _callback(self, indata, frames, time_info, status) -> None:  # noqa: ANN001
        if status:
            self._overflows += 1
            if self.debug and self._overflows <= 5:
                log.warning("portaudio status: %s", status)
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
            return None
        block = np.concatenate(chunks, axis=0)  # (n, ch)
        if block.shape[1] != self.channels:
            log.error("channel mismatch: got %s want %s", block.shape, self.channels)
            return None
        buf = np.concatenate([self._tail, block], axis=0) if self._tail.size else block
        cols_acc = []
        vu_acc = []
        pos = 0
        while pos + FFT_SIZE <= buf.shape[0]:
            frame = buf[pos : pos + FFT_SIZE, :]
            windowed = frame * self._window[:, None]
            spec = np.fft.rfft(windowed, axis=0)
            power = (spec.real * spec.real + spec.imag * spec.imag).T
            col = 10.0 * np.log10(power[:, self._bin_map] + 1e-20)
            cols_acc.append(col)
            band = power[:, self._vu_bins].mean(axis=1)
            vu_acc.append(10.0 * np.log10(band + 1e-20))
            pos += HOP
        keep = FFT_SIZE - HOP
        self._tail = buf[-keep:] if buf.shape[0] >= keep else buf.copy()
        if not cols_acc:
            return None
        self._cols = cols_acc[-1].astype(np.float32)
        self._vu = np.mean(np.stack(vu_acc, axis=0), axis=0).astype(np.float32)
        col_u8 = np.clip((self._cols + 90.0) * (255.0 / 90.0), 0, 255).astype(np.uint8)
        vu_norm = np.clip((self._vu + 90.0) / 90.0, 0.0, 1.0)

        now = time.time()
        if now - self._last_stdout_vu >= 1.0 / STDOUT_VU_HZ:
            self._last_stdout_vu = now
            parts = [
                f"mic{i + 1}={self._vu[i]:+6.1f}dB"
                for i in range(self.channels)
            ]
            print(
                f"[VU 2kHz] {'  '.join(parts)}  "
                f"frames={self._frames} blocks={self._callback_blocks} ovf={self._overflows}",
                flush=True,
            )

        return {
            "t": now,
            "sr": self.sample_rate,
            "vu_hz": VU_HZ,
            "vu": vu_norm.tolist(),
            "vu_db": [float(x) for x in self._vu],
            "spectro": base64.b64encode(col_u8.tobytes()).decode("ascii"),
            "shape": [int(self.channels), int(SPECTRO_BINS)],
            "overflows": self._overflows,
            "frames": self._frames,
            "blocks": self._callback_blocks,
            "ring": len(self._ring),
        }

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
        return {
            "device": self.device,
            "device_name": dev_name,
            "device_max_channels": max_ch,
            "channels": self.channels,
            "sample_rate": self.sample_rate,
            "vu_hz": VU_HZ,
            "fft_size": FFT_SIZE,
            "spectro_bins": SPECTRO_BINS,
            "running": self._running,
            "last_error": self._last_error,
            "frames": self._frames,
            "blocks": self._callback_blocks,
            "overflows": self._overflows,
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
                        if idle_ticks == 40:  # ~2 s with no FFT columns
                            log.warning(
                                "running but no FFT frames yet "
                                "(blocks=%s ring=%s) — waiting for audio…",
                                engine._callback_blocks,
                                len(engine._ring),
                            )
                    else:
                        idle_ticks = 0
            except Exception as exc:
                log.exception("process_once failed")
                payload = {"type": "error", "message": str(exc)}

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
            print(f"[spectro6] auto-start failed: {exc}", flush=True)
            print(
                "[spectro6] Tip: python3 app.py --list-devices  "
                "→ pick ALSA id with CH=6 (e.g. --device 4), not Pulse surround.",
                flush=True,
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

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/api/devices")
    async def api_devices() -> dict[str, Any]:
        return {"devices": list_devices(), "meta": engine.snapshot_meta()}

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
                        log.info("ws start OK device=%s name=%r", engine.device, engine.snapshot_meta().get("device_name"))
                    except Exception as exc:
                        log.error("ws start failed: %s", exc)
                        print(f"[spectro6] start failed: {exc}", flush=True)
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
        help="Device id, name substring, or auto (prefer ALSA 6ch)",
    )
    parser.add_argument("--channels", type=int, default=CHANNELS, help="Input channel count (default 6)")
    parser.add_argument("--rate", type=int, default=SAMPLE_RATE, help="Sample rate Hz (default 48000)")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="HTTP port (default 8765)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Debug logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    if args.list_devices:
        print(f"{'ID':>4}  {'CH':>3}  {'SR':>8}  {'HostAPI':<16}  Name")
        for d in list_devices():
            mark = ""
            if d["channels"] >= CHANNELS and d.get("is_alsa"):
                mark = "  ← use this"
            elif d["channels"] < CHANNELS and "surround" in d["name"].lower():
                mark = "  (Pulse stub — skip)"
            print(
                f"{d['id']:4d}  {d['channels']:3d}  {d['default_sr']:8.0f}  "
                f"{d['hostapi']:<16}  {d['name']}{mark}"
            )
        print(
            "\nTip: python3 app.py --device <ID with CH=6 on ALSA>, "
            "e.g. --device 4   (not Pulse surround-21)",
            flush=True,
        )
        return

    try:
        device = resolve_device(args.device, need_ch=args.channels)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    engine = SpectroEngine(
        device=device,
        channels=args.channels,
        sample_rate=args.rate,
        debug=args.verbose,
    )
    app = create_app(engine)
    print(
        f"[spectro6] http://{args.host}:{args.port}/  "
        f"device={device} ch={args.channels} sr={args.rate} vu={VU_HZ:.0f}Hz",
        flush=True,
    )
    print(
        "[spectro6] stdout: [VU 2kHz] mic1..mic6 dB four times/sec while capturing",
        flush=True,
    )
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
