# spectro6 — 6kanálový spektrogram + VU @ 2 kHz

Lokální Python nástroj pro Ubuntu host. Na rozdíl od prohlížeče (`getUserMedia`
typicky 1–2 kanály) otevírá **celých 6 kanálů** HET68 UAC2 mikrofonu přes
PortAudio/ALSA a streamuje spektrogram + pásmové VU (2 kHz) do web UI na
`localhost`.

## Požadavky

- Ubuntu (PipeWire / Pulse / ALSA)
- Python 3.11+ (testováno s 3.12)
- HET68 připojený jako USB audio (UAC2, 6 ch · 48 kHz)

Systémové balíčky (PortAudio):

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip portaudio19-dev libportaudio2
```

## Instalace

```bash
cd spectro6
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Spuštění (důležité: větev s opravami)

Na `main` můžeš mít starší spectro6 bez VU stdout. Opravy jsou ve větvi:

```bash
cd ~/het68_webflasher
git fetch origin
git checkout cursor/spectro6-debug-device-180e
cd spectro6 && source .venv/bin/activate
```

```bash
# seznam — DEFAULT = ALSA Pico 6ch hw (ne Pulse surround / pipewire)
python3 app.py --list-devices

# auto default = ta správná zvukovka
python3 app.py

# nebo pevné id
python3 app.py --device 4
```

Otevři **http://127.0.0.1:8765/** (hard refresh Ctrl+Shift+R).

### Stdout

Za běhu ~4×/s:

```text
[VU 2kHz] mic1= -42.1dB  …  mic6= …  peak=[…]  live frames=… ovf=… drop=…
```

`CLIP` / `⚠ OVERLOAD` = špička u full-scale (±1.0) — hardwarové přebuzení, ne jen jas spektrogramu.

### UI

- mic1…mic6, multi-column spektrogram (bez „dírek“ z dropnutých hopů)
- VU @ 2 kHz + peak/CLIP
- debug panel: device, last_error, ovf/drop
- Start posílá device id přes WS

## Poznámky

- Pulse `…analog-surround-21` = 3ch stub — appka ho přeskočí.
- Virtual `sysdefault` / `pipewire` / `default` mají nižší score než ALSA `hw:`.
- Spektro mapování −85…−15 dBFS (jas ≠ clipping).
