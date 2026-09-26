#!/usr/bin/env python3
"""
spectro6 raw capture diagnostics — isolate firmware / USB / PC stack.

Does NOT run FFT or the web UI. Records raw samples (sounddevice and/or
arecord) and reports digital-zero gaps + clip bursts.

Decision tree (printed at the end):
  A) arecord (ALSA hw) under pasuspender still has sync zeros on all 6 ch
     → firmware or USB path (not Python/PortAudio/FFT)
  B) arecord clean, sounddevice gappy
     → PortAudio / PC userspace
  C) only with Pulse/PipeWire open (without pasuspender) gappy
     → host audio server stealing the device
  D) ovf/drop in spectro6 but raw capture clean
     → spectro6 processing / ring (ruled out when zeros already in raw)

Usage:
  cd spectro6 && source .venv/bin/activate
  python3 diag_capture.py --device 4 --seconds 5
  python3 diag_capture.py --arecord --card 1 --seconds 5
  python3 diag_capture.py --wav /tmp/het68.wav   # analyze existing file
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path
from typing import Any

import numpy as np

ZERO_PEAK = 1e-7
CLIP_PEAK = 0.98


def _load_wav(path: Path) -> tuple[np.ndarray, int]:
    """Return float32 (n, ch) in ±1.0 and sample rate."""
    with wave.open(str(path), "rb") as w:
        ch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    if sw == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sw == 3:
        # rare; pack to i32
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        v = b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16)
        v = np.where(v & 0x800000, v - 0x1000000, v)
        x = v.astype(np.float32) / 8388608.0
    elif sw == 4:
        x = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise SystemExit(f"Unsupported sample width {sw} in {path}")
    if ch > 1:
        x = x.reshape(-1, ch)
    else:
        x = x.reshape(-1, 1)
    return x, sr


def _write_wav_f32(path: Path, data: np.ndarray, sr: int) -> None:
    """Write float32 (n,ch) as 32-bit PCM WAV."""
    x = np.clip(data, -1.0, 1.0)
    pcm = (x * 2147483647.0).astype("<i4")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(pcm.shape[1])
        w.setsampwidth(4)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def analyze(x: np.ndarray, sr: int, hop: int = 512) -> dict[str, Any]:
    """Analyze (n, ch) float32 for digital-zero gaps and clips."""
    n, ch = x.shape
    dur = n / sr
    # Per-sample peak across channels
    peak = np.max(np.abs(x), axis=1)
    zero = peak < ZERO_PEAK
    clip = peak >= CLIP_PEAK

    # Run-length encode zeros
    gaps: list[dict[str, float]] = []
    i = 0
    while i < n:
        if not zero[i]:
            i += 1
            continue
        j = i
        while j < n and zero[j]:
            j += 1
        gaps.append({"start_s": i / sr, "dur_ms": (j - i) * 1000.0 / sr, "samples": j - i})
        i = j

    # Hop-level sync: all channels near-zero in same hop
    hops = n // hop
    sync_zero_hops = 0
    clip_hops = 0
    hop_peak_db = []
    for h in range(hops):
        sl = x[h * hop : (h + 1) * hop]
        hp = float(np.max(np.abs(sl)))
        hop_peak_db.append(20.0 * np.log10(max(hp, 1e-12)))
        if hp < ZERO_PEAK:
            sync_zero_hops += 1
        if hp >= CLIP_PEAK:
            clip_hops += 1

    zero_frac = float(np.mean(zero))
    clip_frac = float(np.mean(clip))
    # Gap period estimate from midpoints
    period_ms = None
    if len(gaps) >= 3:
        mids = [g["start_s"] * 1000 + g["dur_ms"] / 2 for g in gaps]
        dts = np.diff(mids)
        period_ms = float(np.median(dts))

    # Per-channel zero fraction (if only some ch zero → not shared USB frame)
    ch_zero = [float(np.mean(np.max(np.abs(x[:, c : c + 1]), axis=1) < ZERO_PEAK)) for c in range(ch)]

    return {
        "duration_s": dur,
        "samples": n,
        "channels": ch,
        "sr": sr,
        "zero_sample_frac": zero_frac,
        "clip_sample_frac": clip_frac,
        "gap_count": len(gaps),
        "gaps_ms": [round(g["dur_ms"], 1) for g in gaps[:40]],
        "gap_period_ms_median": period_ms,
        "sync_zero_hop_frac": sync_zero_hops / max(hops, 1),
        "clip_hop_frac": clip_hops / max(hops, 1),
        "per_channel_zero_frac": ch_zero,
        "peak_db_p50": float(np.percentile(hop_peak_db, 50)) if hop_peak_db else None,
        "peak_db_p95": float(np.percentile(hop_peak_db, 95)) if hop_peak_db else None,
        "peak_db_p5": float(np.percentile(hop_peak_db, 5)) if hop_peak_db else None,
    }


def verdict(stats: dict[str, Any], source: str) -> list[str]:
    lines = []
    zf = stats["zero_sample_frac"]
    chz = stats["per_channel_zero_frac"]
    sync = stats["sync_zero_hop_frac"]
    period = stats.get("gap_period_ms_median")

    lines.append(f"source={source}")
    if zf < 0.01 and sync < 0.01:
        lines.append("VERDICT: raw stream looks continuous (no digital-zero gaps).")
        lines.append("  → If spectro6 UI still gaps, bug is in PC processing/UI (unlikely given prior logs).")
        return lines

    lines.append(
        f"VERDICT: digital-zero gaps present "
        f"(zero_frac={zf:.1%}, sync_zero_hops={sync:.1%}, gaps={stats['gap_count']})"
    )
    if period:
        lines.append(f"  typical gap spacing ≈ {period:.0f} ms")

    # All channels same?
    if max(chz) - min(chz) < 0.05 and sync > 0.05:
        lines.append("  all 6 channels gap together → shared path (USB frame / DMA / firmware), not one ICS43434")
    else:
        lines.append("  channels differ → could be per-ADC or host channel map issue")

    if source.startswith("arecord"):
        lines.append("  arecord=ALSA hw direct → NOT spectro6 FFT / PortAudio ring")
        lines.append("  → blame: firmware UAC2 buffer OR USB host/controller OR ALSA USB driver")
    elif source.startswith("sounddevice"):
        lines.append("  sounddevice=PortAudio → still above firmware; compare with --arecord")

    if stats["clip_sample_frac"] > 0.01:
        lines.append(
            f"  also hard-CLIP {stats['clip_sample_frac']:.1%} of samples "
            "(full-scale ±1.0) — firmware gain / USB packing / mic overload"
        )
    return lines


def capture_sounddevice(device: int, seconds: float, channels: int, sr: int, blocksize: int) -> np.ndarray:
    import sounddevice as sd

    n = int(seconds * sr)
    print(f"[diag] sounddevice record device={device} {seconds}s ch={channels} sr={sr} block={blocksize}", flush=True)
    data = sd.rec(n, samplerate=sr, channels=channels, dtype="float32", device=device, blocking=True, blocksize=blocksize)
    sd.wait()
    return np.asarray(data, dtype=np.float32)


def capture_arecord(card: int, device: int, seconds: float, channels: int, sr: int, out: Path) -> Path:
    arecord = shutil.which("arecord")
    if not arecord:
        raise SystemExit("arecord not found (install alsa-utils)")
    # S32_LE is what most UAC2 24-in-32 devices expose on Linux
    cmd = [
        arecord,
        "-D",
        f"hw:{card},{device}",
        "-c",
        str(channels),
        "-r",
        str(sr),
        "-f",
        "S32_LE",
        "-d",
        str(max(1, int(round(seconds)))),
        str(out),
    ]
    # Prefer pasuspender if it actually works (classic PulseAudio).
    # PipeWire-only often: "Failure to suspend: No such entity"
    ps = shutil.which("pasuspender")
    if ps:
        probe = subprocess.run([ps, "--", "true"], capture_output=True, text=True)
        if probe.returncode == 0:
            cmd = [ps, "--", *cmd]
            print("[diag] wrapping arecord with pasuspender", flush=True)
        else:
            tip = (probe.stderr or probe.stdout or "").strip().splitlines()
            print(
                f"[diag] pasuspender skip ({tip[-1] if tip else probe.returncode})",
                flush=True,
            )
    print("[diag] exec:", " ".join(cmd), flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr, file=sys.stderr)
        raise SystemExit(f"arecord failed ({r.returncode})")
    return out


def find_alsa_card_for_pico() -> tuple[int, int] | None:
    """Best-effort: parse /proc/asound/cards for Pico/HET68."""
    cards = Path("/proc/asound/cards")
    if not cards.exists():
        return None
    text = cards.read_text(errors="replace")
    for line in text.splitlines():
        # e.g. " 1 [Microphone     ]: USB-Audio - Pico 6ch Microphone"
        if "pico" in line.lower() or "het68" in line.lower() or "6ch" in line.lower():
            parts = line.strip().split()
            if parts and parts[0].isdigit():
                return int(parts[0]), 0
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description="HET68 raw capture diagnostics (firmware vs USB vs PC)")
    ap.add_argument("--device", default="auto", help="sounddevice device id or auto")
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--channels", type=int, default=6)
    ap.add_argument("--rate", type=int, default=48000)
    ap.add_argument("--blocksize", type=int, default=2048)
    ap.add_argument("--arecord", action="store_true", help="Capture via arecord hw:CARD,DEV (bypasses PortAudio)")
    ap.add_argument("--card", type=int, default=None, help="ALSA card index for --arecord (auto-detect Pico)")
    ap.add_argument("--adev", type=int, default=0, help="ALSA device index for --arecord (default 0)")
    ap.add_argument("--wav", type=Path, default=None, help="Analyze existing WAV instead of capturing")
    ap.add_argument("--out", type=Path, default=Path("/tmp/spectro6_diag"))
    ap.add_argument("--both", action="store_true", help="Run arecord AND sounddevice, compare")
    args = ap.parse_args()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    reports: list[tuple[str, dict[str, Any], Path | None]] = []

    if args.wav:
        x, sr = _load_wav(args.wav)
        st = analyze(x, sr)
        reports.append((f"wav:{args.wav}", st, args.wav))
    elif args.both or args.arecord:
        card = args.card
        if card is None:
            hit = find_alsa_card_for_pico()
            if not hit:
                raise SystemExit("Cannot auto-detect ALSA card; pass --card N (see arecord -l)")
            card, adev = hit
            args.adev = adev
            print(f"[diag] auto ALSA card={card} device={args.adev}", flush=True)
        wav_path = args.out.with_suffix(".arecord.wav")
        capture_arecord(card, args.adev, args.seconds, args.channels, args.rate, wav_path)
        x, sr = _load_wav(wav_path)
        st = analyze(x, sr)
        reports.append((f"arecord:hw:{card},{args.adev}", st, wav_path))

    if args.both or (not args.arecord and not args.wav):
        # sounddevice path
        try:
            import app as spectro_app  # reuse device picker when available

            if args.device == "auto":
                dev = spectro_app.resolve_device("auto", args.channels)
            elif str(args.device).isdigit():
                dev = int(args.device)
            else:
                dev = spectro_app.resolve_device(str(args.device), args.channels)
        except Exception as exc:
            print(f"[diag] app.resolve_device unavailable ({exc}); using device={args.device}", flush=True)
            if args.device == "auto" or not str(args.device).isdigit():
                raise SystemExit("Pass numeric --device id from: python3 app.py --list-devices")
            dev = int(args.device)

        x = capture_sounddevice(dev, args.seconds, args.channels, args.rate, args.blocksize)
        wav_path = args.out.with_suffix(".sounddevice.wav")
        _write_wav_f32(wav_path, x, args.rate)
        st = analyze(x, args.rate)
        reports.append((f"sounddevice:id={dev}", st, wav_path))

    print("\n========== RAW CAPTURE ANALYSIS ==========")
    for source, st, path in reports:
        print(f"\n--- {source} ---")
        if path:
            print(f"file: {path}")
        print(json.dumps({k: v for k, v in st.items() if k != "gaps_ms"}, indent=2))
        if st["gaps_ms"]:
            print(f"first gaps_ms: {st['gaps_ms'][:12]}")
        for line in verdict(st, source):
            print(line)

    if len(reports) >= 2:
        print("\n========== COMPARE ==========")
        a, b = reports[0], reports[1]
        za, zb = a[1]["zero_sample_frac"], b[1]["zero_sample_frac"]
        print(f"{a[0]} zero_frac={za:.1%}")
        print(f"{b[0]} zero_frac={zb:.1%}")
        if za > 0.05 and zb > 0.05:
            print("BOTH gappy → problem is BELOW PortAudio (ALSA/USB/firmware).")
        elif za > 0.05 and zb < 0.02:
            print(f"{a[0]} gappy, {b[0]} clean → issue in that capture path.")
        elif zb > 0.05 and za < 0.02:
            print(f"{b[0]} gappy, {a[0]} clean → issue in that capture path.")
        else:
            print("Neither shows strong digital-zero gaps in this take.")

    out_json = args.out.with_suffix(".json")
    out_json.write_text(json.dumps([{ "source": s, "stats": st, "file": str(p) if p else None} for s, st, p in reports], indent=2))
    print(f"\n[diag] wrote {out_json}")


if __name__ == "__main__":
    main()
