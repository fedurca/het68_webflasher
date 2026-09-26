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
  python app.py --list-devices
  python app.py --device <id-or-name> --port 8765
  # open http://127.0.0.1:8765/
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import numpy as np
import sounddevice as sd
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

# ---- DSP defaults (HET68 UAC2) --------------------------------------------
SAMPLE_RATE = 48_000
CHANNELS = 6
BLOCK = 1024
FFT_SIZE = 2048
HOP = 512
VU_HZ = 2_000.0
VU_BW_HZ = 200.0  # ±100 Hz around 2 kHz
SPECTRO_BINS = 256  # UI bins (log-ish mapped from FFT)
STREAM_HZ = 20  # UI update rate

STATIC_DIR = Path(__file__).resolve().parent / "static"


def list_devices() -> list[dict[str, Any]]:
    out = []
    for i, d in enumerate(sd.query_devices()):
        if int(d.get("max_input_channels") or 0) < 1:
            continue
        out.append(
            {
                "id": i,
                "name": d["name"],
                "channels": int(d["max_input_channels"]),
                "default_sr": float(d.get("default_samplerate") or SAMPLE_RATE),
                "hostapi": sd.query_hostapis(int(d["hostapi"]))["name"],
            }
        )
    return out


def resolve_device(spec: str | None) -> int | None:
    """None = PortAudio default input. Else numeric id or substring of name."""
    if spec is None or spec == "" or spec.lower() in ("default", "auto"):
        return None
    devices = list_devices()
    if spec.isdigit():
        idx = int(spec)
        if not any(d["id"] == idx for d in devices):
            raise SystemExit(f"No input device with id {idx}. Try --list-devices.")
        return idx
    needle = spec.lower()
    hits = [d for d in devices if needle in d["name"].lower()]
    if not hits:
        raise SystemExit(f"No input device matching {spec!r}. Try --list-devices.")
    if len(hits) > 1:
        names = ", ".join(f'{d["id"]}:{d["name"]}' for d in hits)
        raise SystemExit(f"Ambiguous device {spec!r}: {names}")
    return hits[0]["id"]


class SpectroEngine:
    """Background PortAudio capture → per-channel spectrogram columns + 2 kHz VU."""

    def __init__(
        self,
        device: int | None,
        channels: int = CHANNELS,
        sample_rate: int = SAMPLE_RATE,
    ) -> None:
        self.device = device
        self.channels = channels
        self.sample_rate = sample_rate
        self._lock = threading.Lock()
        self._ring: deque[np.ndarray] = deque(maxlen=8)
        self._stream: sd.InputStream | None = None
        self._running = False
        self._window = np.hanning(FFT_SIZE).astype(np.float32)
        self._vu = np.full(channels, -90.0, dtype=np.float32)
        self._cols = np.zeros((channels, SPECTRO_BINS), dtype=np.float32)
        self._overflows = 0
        self._frames = 0
        self._bin_map = self._build_bin_map()
        # Goertzel / band indices for 2 kHz VU
        freqs = np.fft.rfftfreq(FFT_SIZE, 1.0 / sample_rate)
        lo, hi = VU_HZ - VU_BW_HZ / 2, VU_HZ + VU_BW_HZ / 2
        self._vu_bins = np.where((freqs >= lo) & (freqs <= hi))[0]
        if self._vu_bins.size == 0:
            self._vu_bins = np.array([int(round(VU_HZ * FFT_SIZE / sample_rate))])

    def _build_bin_map(self) -> np.ndarray:
        """Map SPECTRO_BINS UI rows to FFT bins (log-ish, 100 Hz … Nyquist)."""
        n_fft = FFT_SIZE // 2 + 1
        f_min, f_max = 100.0, self.sample_rate / 2
        ui = np.linspace(0, 1, SPECTRO_BINS)
        # log spacing
        freqs = f_min * (f_max / f_min) ** ui
        fft_freqs = np.fft.rfftfreq(FFT_SIZE, 1.0 / self.sample_rate)
        idx = np.searchsorted(fft_freqs, freqs).clip(0, n_fft - 1)
        return idx.astype(np.int32)

    def start(self) -> None:
        if self._running:
            return
        info = sd.query_devices(self.device, "input") if self.device is not None else sd.query_devices(kind="input")
        max_ch = int(info["max_input_channels"])
        if max_ch < self.channels:
            raise RuntimeError(
                f"Device reports {max_ch} input channels; need {self.channels}. "
                "Check ALSA/PipeWire sees the HET68 UAC2 6-ch mic."
            )
        self._ring.clear()
        self._overflows = 0
        self._frames = 0
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
        self._running = True

    def stop(self) -> None:
        self._running = False
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None

    def _callback(self, indata, frames, time_info, status) -> None:  # noqa: ANN001
        if status:
            self._overflows += 1
        # copy — PortAudio reuses the buffer
        self._ring.append(indata.copy())
        self._frames += frames

    def process_once(self) -> dict[str, Any] | None:
        """Pull queued blocks, update FFT/VU, return a UI payload or None."""
        if not self._running:
            return None
        chunks: list[np.ndarray] = []
        with self._lock:
            while self._ring:
                chunks.append(self._ring.popleft())
        if not chunks:
            return None
        block = np.concatenate(chunks, axis=0)  # (n, ch)
        # keep a hop-sized tail for overlapping FFT
        if not hasattr(self, "_tail"):
            self._tail = np.zeros((FFT_SIZE, self.channels), dtype=np.float32)
        buf = np.concatenate([self._tail, block], axis=0)
        # advance by hops
        cols_acc = []
        vu_acc = []
        pos = 0
        while pos + FFT_SIZE <= buf.shape[0]:
            frame = buf[pos : pos + FFT_SIZE, :]  # (FFT, ch)
            windowed = frame * self._window[:, None]
            spec = np.fft.rfft(windowed, axis=0)  # (bins, ch)
            power = (spec.real * spec.real + spec.imag * spec.imag).T  # (ch, bins)
            # dB spectrogram column
            col = 10.0 * np.log10(power[:, self._bin_map] + 1e-12)
            cols_acc.append(col)
            # 2 kHz band VU (mean power in band → dBFS)
            band = power[:, self._vu_bins].mean(axis=1)
            vu_acc.append(10.0 * np.log10(band + 1e-12))
            pos += HOP
        self._tail = buf[-(FFT_SIZE - HOP) :] if buf.shape[0] >= FFT_SIZE - HOP else buf
        if not cols_acc:
            return None
        # use latest column / mean VU over hops in this tick
        self._cols = cols_acc[-1].astype(np.float32)
        self._vu = np.mean(np.stack(vu_acc, axis=0), axis=0).astype(np.float32)
        # clamp for transport
        col_u8 = np.clip((self._cols + 90.0) * (255.0 / 90.0), 0, 255).astype(np.uint8)
        vu_norm = np.clip((self._vu + 90.0) / 90.0, 0.0, 1.0)
        return {
            "t": time.time(),
            "sr": self.sample_rate,
            "vu_hz": VU_HZ,
            "vu": vu_norm.tolist(),  # 0..1
            "vu_db": self._vu.tolist(),
            "spectro": base64.b64encode(col_u8.tobytes()).decode("ascii"),
            "shape": [int(self.channels), int(SPECTRO_BINS)],
            "overflows": self._overflows,
            "frames": self._frames,
        }

    def snapshot_meta(self) -> dict[str, Any]:
        dev_name = "default"
        try:
            info = (
                sd.query_devices(self.device, "input")
                if self.device is not None
                else sd.query_devices(kind="input")
            )
            dev_name = str(info["name"])
        except Exception:
            pass
        return {
            "device": self.device,
            "device_name": dev_name,
            "channels": self.channels,
            "sample_rate": self.sample_rate,
            "vu_hz": VU_HZ,
            "fft_size": FFT_SIZE,
            "spectro_bins": SPECTRO_BINS,
            "running": self._running,
        }


def create_app(engine: SpectroEngine) -> FastAPI:
    app = FastAPI(title="HET68 spectro6", docs_url=None, redoc_url=None)
    clients: set[WebSocket] = set()
    push_task: asyncio.Task | None = None

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
        try:
            await ws.send_json({"type": "meta", **engine.snapshot_meta()})
            while True:
                # client may send {cmd: start|stop} ; ignore otherwise
                try:
                    msg = await asyncio.wait_for(ws.receive_text(), timeout=0.05)
                    data = json.loads(msg)
                    cmd = data.get("cmd")
                    if cmd == "start" and not engine._running:
                        engine.start()
                        await ws.send_json({"type": "meta", **engine.snapshot_meta()})
                    elif cmd == "stop" and engine._running:
                        engine.stop()
                        await ws.send_json({"type": "meta", **engine.snapshot_meta()})
                except asyncio.TimeoutError:
                    pass
                except WebSocketDisconnect:
                    raise
                except Exception:
                    pass
        except WebSocketDisconnect:
            pass
        finally:
            clients.discard(ws)

    async def broadcaster() -> None:
        interval = 1.0 / STREAM_HZ
        while True:
            t0 = time.perf_counter()
            payload = None
            try:
                if engine._running:
                    payload = await asyncio.to_thread(engine.process_once)
            except Exception as exc:
                payload = {"type": "error", "message": str(exc)}
            if payload and clients:
                dead: list[WebSocket] = []
                msg = {"type": "frame", **payload} if "type" not in payload else payload
                raw = json.dumps(msg)
                for ws in list(clients):
                    try:
                        await ws.send_text(raw)
                    except Exception:
                        dead.append(ws)
                for ws in dead:
                    clients.discard(ws)
            dt = time.perf_counter() - t0
            await asyncio.sleep(max(0.0, interval - dt))

    @app.on_event("startup")
    async def _startup() -> None:
        nonlocal push_task
        push_task = asyncio.create_task(broadcaster())
        try:
            engine.start()
        except Exception as exc:
            print(f"[spectro6] auto-start failed: {exc}", flush=True)

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        engine.stop()
        if push_task:
            push_task.cancel()

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="HET68 6-channel spectrogram + 2 kHz VU (localhost)")
    parser.add_argument("--list-devices", action="store_true", help="List input devices and exit")
    parser.add_argument("--device", default="default", help="Device id, name substring, or 'default'")
    parser.add_argument("--channels", type=int, default=CHANNELS, help="Input channel count (default 6)")
    parser.add_argument("--rate", type=int, default=SAMPLE_RATE, help="Sample rate Hz (default 48000)")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="HTTP port (default 8765)")
    args = parser.parse_args()

    if args.list_devices:
        print(f"{'ID':>4}  {'CH':>3}  {'SR':>8}  HostAPI            Name")
        for d in list_devices():
            print(
                f"{d['id']:4d}  {d['channels']:3d}  {d['default_sr']:8.0f}  "
                f"{d['hostapi']:<16}  {d['name']}"
            )
        return

    device = resolve_device(args.device)
    engine = SpectroEngine(device=device, channels=args.channels, sample_rate=args.rate)
    app = create_app(engine)
    print(
        f"[spectro6] http://{args.host}:{args.port}/  "
        f"device={device if device is not None else 'default'} "
        f"ch={args.channels} sr={args.rate} vu={VU_HZ:.0f}Hz",
        flush=True,
    )
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
