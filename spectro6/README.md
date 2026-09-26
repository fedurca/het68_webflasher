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

## Spuštění

**Důležité:** vždy používej `python3` (nebo aktivovaný `.venv`). Na Debian/Ubuntu
`python` často chybí.

```bash
# seznam vstupů — hledej řádek s CH=6 a „← use this“ (ALSA hw)
python3 app.py --list-devices

# auto: vybere nejlepší ALSA 6ch (ne Pulse surround-21)
python3 app.py

# číselné id z --list-devices (doporučeno)
python3 app.py --device 4

# jméno / alias — preferuje ALSA 6ch před Pulse 3ch stubem
python3 app.py --device "Pico 6ch"
python3 app.py --device het68

# verbose + jiný port
python3 app.py --device 4 -v --port 8765
```

Otevři **http://127.0.0.1:8765/**

### Proč `--device het68` dřív selhalo

PulseAudio často nabízí
`…analog-surround-21` jako **3kanálový** stub. Skutečný 6ch stream je ALSA
`Pico 6ch Microphone … USB Audio (hw:X,0)`. Appka teď při shodě jména skóruje
zařízení a při &lt;6 ch automaticky přepne na ALSA 6ch, pokud existuje.

### Stdout VU

Za běhu capture vypisuje ~4×/s:

```text
[VU 2kHz] mic1= -42.1dB  mic2= …  mic6= …  frames=… blocks=… ovf=…
```

## UI

- 6 řádků = **mic1…mic6**
- vlevo **VU** = výkon v pásmu **2 kHz ± 100 Hz** (dBFS)
- vpravo **spektrogram** (log 100 Hz → Nyquist, scrolling)
- Start pošle vybrané device id přes WebSocket (bez restartu procesu)
- panel **debug** dole: device id/name, last_error, frames/blocks

## Poznámky

- Pokud device hlásí &lt; 6 kanálů, start selže s jasnou hláškou — z `--list-devices`
  vezmi řádek označený `← use this`.
- Ověření ALSA: `arecord -l` / `pw-cli list-objects`.
- Prohlížečové chirp/chirpdev zůstávají omezené; toto je nativní cesta k array.
