# spectro6 — 6kanálový spektrogram + VU @ 2 kHz

Lokální Python nástroj pro Ubuntu host. Otevírá **6 kanálů** HET68 UAC2 přes
PortAudio/ALSA a streamuje spektrogram + VU (2 kHz) na `localhost`.

## Spuštění (musíš být na větvi s opravami)

```bash
cd ~/het68_webflasher
git fetch origin
git checkout cursor/spectro6-debug-device-180e
git pull origin cursor/spectro6-debug-device-180e
cd spectro6 && source .venv/bin/activate

python3 app.py --help | grep blocksize   # musí existovat; jinak máš starý app.py
python3 app.py --list-devices
python3 app.py                           # auto; pasuspender only if it works
# PipeWire: "Failure to suspend: No such entity" → app continues bez pasuspender
```

Když `app.py: error: unrecognized arguments: --blocksize` → **nejsi na této větvi**.

## Diagnostika mezer: firmware vs USB vs PC

Z logů typu `ovf=0 drop=0` + střídání `CLIP` / `peak=+0` a `mic=-200` / `peak=-240`:

| Vrstva | Znamení | Závěr |
|--------|---------|--------|
| spectro6 FFT / UI | `drop>0` nebo mezery jen ve webu, raw WAV čistý | PC zpracování |
| PortAudio | sounddevice gappy, **arecord čistý** | PC userspace |
| Pulse/PipeWire | gappy bez `pasuspender`, čisté s ním | host audio server |
| ALSA USB / firmware | **arecord hw: také gappy**, všechny 6 ch naráz | USB nebo firmware Pico |

Všechny 6 kanálů jdou na nulu současně → **sdílená cesta** (USB ISO packet / DMA / FW), ne jeden ICS-43434.

### Raw test (obejde FFT i web)

```bash
# 1) jen ALSA (bez PortAudio / bez spectro6)
python3 diag_capture.py --arecord --seconds 5

# 2) PortAudio (sounddevice) stejně jako app
python3 diag_capture.py --device 4 --seconds 5

# 3) obojí a porovnání
python3 diag_capture.py --both --seconds 5

# ruční arecord
pasuspender -- arecord -D hw:1,0 -c 6 -r 48000 -f S32_LE -d 5 /tmp/het68.wav
python3 diag_capture.py --wav /tmp/het68.wav
```

Výstup: `zero_sample_frac`, `sync_zero_hop_frac`, `gap_period_ms`, VERDICT.

- **arecord i sounddevice gappy** → problém je *pod* Pythonem (FW/USB/ALSA).
- **jen sounddevice gappy** → PortAudio/PC.
- **jen bez pasuspender** → Pulse/PipeWire.

Další USB stopy:

```bash
dmesg -w   # při mezerách: USB disconnect / bandwidth?
lsusb -t
cat /proc/asound/card1/stream0
```

## UI — hexagon DOA

Nad spektrogramy je **šestiúhelník** mic1…mic6 (mic1 nahoře, po směru hodin).
Pozice zdroje = vážený průměr směrů kanálů podle výkonu v pásmu 2&nbsp;kHz.
Stopa (trail) postupně slábne (~14&nbsp;s); tlačítko **Trail ✕** ji vymaže.

## Buffery

```bash
python3 app.py --blocksize 4096 --latency 0.3
./run.sh --blocksize 4096 --latency 0.3
```

Magenta pruhy ve spektrogramu = digitální nuly. `--gap-hold` jen kosmetika.

## Serial debug (CDC) + detekce + sync času

HET68 často má vedle UAC2 ještě USB CDC konzoli (`/dev/ttyACM*`). Appka umí
číst detekce a poslat čas z prohlížeče:

```bash
pip install -r requirements.txt
python3 app.py --list-serial
python3 app.py --serial /dev/ttyACM0
```

Ve UI (panel **Serial · detekce**):

- Open/Close CDC portu
- **Sync čas** → pošle na zařízení řádek `TIME <epoch_ms>` (UTC z browseru)
- seznam detekcí + raw konzole

Rozpoznávané řádky (příklady):

```text
DET az=123.4 el=5.0 conf=0.87 class=drone id=a1b2
{"type":"detection","azimuthDeg":123.4,"confidence":0.87,"class":"drone"}
```
