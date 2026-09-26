#!/usr/bin/env bash
# Start spectro6. Use pasuspender only when it actually works (PulseAudio).
# On PipeWire-only hosts pasuspender often fails with "No such entity".
set -euo pipefail
cd "$(dirname "$0")"
PY="${VIRTUAL_ENV:+$VIRTUAL_ENV/bin/python3}"
PY="${PY:-python3}"
if command -v pasuspender >/dev/null 2>&1 && pasuspender -- true >/dev/null 2>&1; then
  exec pasuspender -- "$PY" app.py "$@"
fi
exec "$PY" app.py --no-pasuspender "$@"
