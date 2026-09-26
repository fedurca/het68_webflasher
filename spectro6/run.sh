#!/usr/bin/env bash
# Prefer pasuspender so Pulse/PipeWire do not steal the HET68 USB mic.
set -euo pipefail
cd "$(dirname "$0")"
PY="${VIRTUAL_ENV:+$VIRTUAL_ENV/bin/python3}"
PY="${PY:-python3}"
if command -v pasuspender >/dev/null 2>&1; then
  exec pasuspender -- "$PY" app.py "$@"
else
  echo "[spectro6] pasuspender not found — install pulseaudio-utils" >&2
  exec "$PY" app.py --no-pasuspender "$@"
fi
