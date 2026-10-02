"""Serial CDC debug bridge for HET68 — detections + time sync.

Reads lines from a USB serial console (typically Pico ``/dev/ttyACM*``),
parses detection events, and can push browser UTC time to the device.

Accepted inbound line formats (examples)::

    DET az=123.4 el=5.0 conf=0.87 class=drone id=a1b2
    {"type":"detection","azimuthDeg":123.4,"confidence":0.87,"class":"drone"}
    DET: 123.4 deg conf=0.9 cls=uav

Time sync outbound (browser → device)::

    TIME SYNC <unix_epoch_seconds>\\n

The firmware CLI accepts seconds, not milliseconds, and ignores a bare ``TIME``.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections import deque
from typing import Any

log = logging.getLogger("spectro6.serial")

# Firmware: `TIME SYNC <unix seconds>`, and the value must be >= 1700000000.
_EPOCH_MS_MIN = 10_000_000_000
_EPOCH_SEC_MIN = 1_700_000_000
_EPOCH_SEC_MAX = 4_000_000_000


def time_sync_command(epoch_ms: int) -> str:
    """Build the firmware clock command from a JS Date.now() millisecond stamp.

    A 10-digit value is already unix seconds and is sent as-is.
    """
    value = int(epoch_ms)
    sec = value // 1000 if value >= _EPOCH_MS_MIN else value
    if sec < _EPOCH_SEC_MIN or sec > _EPOCH_SEC_MAX:
        raise ValueError(f"unix epoch {sec}s is outside 2023..2096")
    return f"TIME SYNC {sec}"


DET_KV = re.compile(
    r"^(?:SRC|DET|DETECTION|DOA)\b[:\s]*(.*)$",
    re.IGNORECASE,
)
KV_PAIR = re.compile(r"([A-Za-z_][\w]*)\s*[:=]\s*([^\s,;]+)")
AZ_LOOSE = re.compile(
    r"(?:az(?:imuth)?|bearing|deg)\s*[:=]?\s*(-?\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
CONF_LOOSE = re.compile(
    r"(?:conf(?:idence)?|score)\s*[:=]?\s*(-?\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
CLASS_LOOSE = re.compile(
    r"(?:class|cls|label)\s*[:=]\s*([A-Za-z0-9_\-\.]+)",
    re.IGNORECASE,
)


def list_serial_ports() -> list[dict[str, Any]]:
    try:
        from serial.tools import list_ports
    except ImportError:
        return []
    out: list[dict[str, Any]] = []
    for p in list_ports.comports():
        desc = p.description or ""
        out.append(
            {
                "device": p.device,
                "name": p.name or p.device,
                "description": desc,
                "hwid": p.hwid or "",
                "vid": p.vid,
                "pid": p.pid,
                "recommended": bool(
                    "ACM" in (p.device or "").upper()
                    or "USB" in (p.device or "").upper()
                    or "pico" in desc.lower()
                    or "het68" in desc.lower()
                    or "rp2" in desc.lower()
                ),
            }
        )
    out.sort(key=lambda d: (0 if d["recommended"] else 1, d["device"]))
    return out


def parse_detection_line(line: str, host_ts: float) -> dict[str, Any] | None:
    """Return a detection dict or None if the line is not a detection."""
    s = line.strip()
    if not s:
        return None

    # JSON object
    if s.startswith("{") and s.endswith("}"):
        try:
            obj = json.loads(s)
        except json.JSONDecodeError:
            obj = None
        if isinstance(obj, dict):
            t = str(obj.get("type") or obj.get("event") or "").lower()
            if t in ("detection", "det", "doa", "") and (
                "azimuthDeg" in obj
                or "azimuth" in obj
                or "az" in obj
                or "bearing" in obj
                or t in ("detection", "det", "doa")
            ):
                az = obj.get("azimuthDeg", obj.get("azimuth", obj.get("az", obj.get("bearing"))))
                el = obj.get("elevationDeg", obj.get("elevation", obj.get("el")))
                conf = obj.get("confidence", obj.get("conf", obj.get("score")))
                cls = obj.get("class", obj.get("cls", obj.get("label", "unknown")))
                return _mk_det(
                    az=az,
                    el=el,
                    conf=conf,
                    cls=str(cls),
                    raw=s,
                    host_ts=host_ts,
                    det_id=str(obj.get("id") or ""),
                    extra=obj,
                )

    m = DET_KV.match(s)
    if m:
        rest = m.group(1)
        kv = {k.lower(): v for k, v in KV_PAIR.findall(rest)}
        az = kv.get("az") or kv.get("azimuth") or kv.get("bearing") or kv.get("deg")
        el = kv.get("el") or kv.get("elev") or kv.get("elevation")
        conf = kv.get("conf") or kv.get("confidence") or kv.get("score")
        cls = kv.get("class") or kv.get("cls") or kv.get("label") or "unknown"
        if az is None:
            am = AZ_LOOSE.search(rest)
            if am:
                az = am.group(1)
        if conf is None:
            cm = CONF_LOOSE.search(rest)
            if cm:
                conf = cm.group(1)
        if cls == "unknown":
            clm = CLASS_LOOSE.search(rest)
            if clm:
                cls = clm.group(1)
        if az is not None:
            extra = {}
            if kv.get("pos"):
                extra["pos"] = kv["pos"]
            return _mk_det(
                az=az,
                el=el,
                conf=conf,
                cls=cls,
                raw=s,
                host_ts=host_ts,
                det_id=kv.get("id", ""),
                extra=extra or None,
            )

    # Loose: line contains azimuth-like token
    am = AZ_LOOSE.search(s)
    if am and ("det" in s.lower() or "doa" in s.lower() or "bearing" in s.lower()):
        conf_m = CONF_LOOSE.search(s)
        cls_m = CLASS_LOOSE.search(s)
        return _mk_det(
            az=am.group(1),
            el=None,
            conf=conf_m.group(1) if conf_m else None,
            cls=cls_m.group(1) if cls_m else "unknown",
            raw=s,
            host_ts=host_ts,
        )
    return None


def _f(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _mk_det(
    *,
    az: Any,
    el: Any,
    conf: Any,
    cls: str,
    raw: str,
    host_ts: float,
    det_id: str = "",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    azf = _f(az)
    conf_f = _f(conf)
    if conf_f is not None and conf_f > 1.5:
        conf_f = conf_f / 100.0  # percent → 0..1
    return {
        "id": det_id or f"h{int(host_ts * 1000) % 10_000_000:07d}",
        "class": cls,
        "confidence": conf_f,
        "azimuthDeg": azf,
        "elevationDeg": _f(el),
        "observedAtHost": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(host_ts))
        + f".{int((host_ts % 1) * 1000):03d}",
        "hostTs": host_ts,
        "raw": raw[:240],
        "extra": extra or {},
    }


class SerialBridge:
    """Background reader for USB CDC serial console."""

    def __init__(self, max_lines: int = 200, max_dets: int = 100) -> None:
        self._lock = threading.Lock()
        self._ser = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.port: str | None = None
        self.baud = 115200
        self.last_error: str | None = None
        self.connected = False
        self.lines: deque[dict[str, Any]] = deque(maxlen=max_lines)
        self.detections: deque[dict[str, Any]] = deque(maxlen=max_dets)
        self._outbox: deque[dict[str, Any]] = deque(maxlen=256)
        self.bytes_rx = 0
        self.line_count = 0
        self.det_count = 0
        self.last_sync_at: float | None = None
        self.last_sync_epoch_ms: int | None = None

    def status(self) -> dict[str, Any]:
        return {
            "connected": self.connected,
            "port": self.port,
            "baud": self.baud,
            "last_error": self.last_error,
            "lines": self.line_count,
            "detections": self.det_count,
            "bytes_rx": self.bytes_rx,
            "last_sync_at": self.last_sync_at,
            "last_sync_epoch_ms": self.last_sync_epoch_ms,
            "pyserial": _pyserial_ok(),
        }

    def open(self, port: str, baud: int = 115200) -> None:
        if not _pyserial_ok():
            raise RuntimeError("pyserial not installed — pip install pyserial")
        import serial

        self.close()
        self.last_error = None
        try:
            ser = serial.Serial(port=port, baudrate=baud, timeout=0.2)
        except Exception as exc:
            self.last_error = str(exc)
            raise
        self._ser = ser
        self.port = port
        self.baud = baud
        self.connected = True
        self._stop.clear()
        self._thread = threading.Thread(target=self._reader, name="spectro6-serial", daemon=True)
        self._thread.start()
        log.info("serial open %s @ %s", port, baud)

    def close(self) -> None:
        self._stop.set()
        t = self._thread
        if t and t.is_alive():
            t.join(timeout=1.5)
        self._thread = None
        if self._ser is not None:
            try:
                self._ser.close()
            except Exception as exc:
                log.debug("serial close: %s", exc)
        self._ser = None
        self.connected = False
        self.port = None

    def write_line(self, text: str) -> None:
        if not self._ser or not self.connected:
            raise RuntimeError("serial not connected")
        data = (text.rstrip("\r\n") + "\n").encode("utf-8", errors="replace")
        with self._lock:
            self._ser.write(data)
            self._ser.flush()

    def sync_time(self, epoch_ms: int) -> str:
        """Push browser/host UTC to the device. Returns the command sent."""
        cmd = time_sync_command(epoch_ms)
        self.write_line(cmd)
        self.last_sync_at = time.time()
        self.last_sync_epoch_ms = int(epoch_ms)
        # Also emit a local status line into the log
        self._push_line(f"[host] sent {cmd}", kind="tx")
        return cmd

    def drain_events(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        with self._lock:
            while self._outbox:
                out.append(self._outbox.popleft())
        return out

    def recent_detections(self, n: int = 40) -> list[dict[str, Any]]:
        with self._lock:
            return list(self.detections)[-n:]

    def recent_lines(self, n: int = 60) -> list[dict[str, Any]]:
        with self._lock:
            return list(self.lines)[-n:]

    def _push_line(self, text: str, kind: str = "rx") -> None:
        host_ts = time.time()
        entry = {"t": host_ts, "kind": kind, "text": text}
        with self._lock:
            self.lines.append(entry)
            self._outbox.append({"type": "serial_line", **entry})
        det = parse_detection_line(text, host_ts) if kind == "rx" else None
        if det:
            with self._lock:
                self.detections.append(det)
                self.det_count += 1
                self._outbox.append({"type": "detection", "detection": det})

    def _reader(self) -> None:
        assert self._ser is not None
        buf = bytearray()
        while not self._stop.is_set():
            try:
                chunk = self._ser.read(256)
            except Exception as exc:
                self.last_error = str(exc)
                self.connected = False
                self._push_line(f"[host] serial read error: {exc}", kind="err")
                break
            if not chunk:
                continue
            self.bytes_rx += len(chunk)
            buf.extend(chunk)
            while True:
                nl = buf.find(b"\n")
                if nl < 0:
                    break
                raw = bytes(buf[:nl])
                del buf[: nl + 1]
                if raw.endswith(b"\r"):
                    raw = raw[:-1]
                try:
                    text = raw.decode("utf-8", errors="replace")
                except Exception:
                    text = repr(raw)
                self.line_count += 1
                self._push_line(text, kind="rx")
        self.connected = False


def _pyserial_ok() -> bool:
    try:
        import serial  # noqa: F401

        return True
    except ImportError:
        return False
