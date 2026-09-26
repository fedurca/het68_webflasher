# spectro6 — 6kanálový spektrogram + VU @ 2 kHz

Lokální Python nástroj pro Ubuntu host. Otevírá **6 kanálů** HET68 UAC2 přes
PortAudio/ALSA a streamuje spektrogram + VU (2 kHz) na `localhost`.

## Spuštění

```bash
cd ~/het68_webflasher
git fetch && git checkout cursor/spectro6-debug-device-180e
cd spectro6 && source .venv/bin/activate

python3 app.py --list-devices   # ← DEFAULT = ALSA Pico 6ch hw
python3 app.py                  # auto + pasuspender (doporučeno)
```

`app.py` se defaultně znovu spustí pod **`pasuspender`**, aby Pulse/PipeWire
nekradly USB mic (častá příčina digitálních mezer).

```bash
# bez pasuspenderu
python3 app.py --no-pasuspender

# větší buffery, když mezery zůstanou
python3 app.py --blocksize 4096 --latency 0.3

# kosmeticky držet poslední sloupec spektrogramu v mezerách
python3 app.py --gap-hold
```

Otevři **http://127.0.0.1:8765/** (Ctrl+Shift+R).

## Mezery ve spektrogramu = digitální nuly z USB

Když ve logu vidíš střídání:

- `peak=[+0.0 …]` / `CLIP` / vysoké VU
- hned `mic*=-200dB` / `peak=[-240 …]`
- a zároveň `ovf=0 drop=0`

…PortAudio **dostává callbacky se samými nulami**. To není chyba UI ani
ring-bufferu. Typické příčiny:

1. **Pulse/PipeWire** souběžně sahá na stejný USB mic → `pasuspender` (default)
2. **USB hub / kabel / port** — zkus přímý USB2 port na notebooku
3. **Firmware Pico UAC2** nestíhá SOF → nuly mezi platnými packety
4. Přebuzení (`CLIP`) a hned ticho — firmware/USB restart period

Appka teď:

- loguje `[GAP] digital silence START/END`
- počítá `zeros_*` / `gap_hops` / `zero_ratio`
- ve webu barví mezery **magenta** (ne tiché ambient)

## Stdout

```text
[VU 2kHz] mic1=…  peak=[…]  live|GAP  zeros=… zero_ratio=…
[GAP] digital silence START …
[GAP] digital silence END  lasted=120ms
```

## UI

- mic1…mic6, multi-column spektrogram
- magenta = digitální gap; zelená = reálný signál
- debug: zeros / gap_hops / ovf / drop
