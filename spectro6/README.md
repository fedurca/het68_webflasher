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

```bash
# seznam vstupů (hledej HET68 / 6ch)
python app.py --list-devices

# výchozí vstup
python app.py

# konkrétní zařízení (id nebo část jména)
python app.py --device 3
python app.py --device het68

# jiný port
python app.py --port 8765
```

Otevři **http://127.0.0.1:8765/**

## UI

- 6 řádků = CH0…CH5
- vlevo **VU** = výkon v pásmu **2 kHz ± 100 Hz** (dBFS)
- vpravo **spektrogram** (log 100 Hz → Nyquist, scrolling)
- Start / Stop přes WebSocket

## Poznámky

- Změna zařízení v UI vyžaduje restart procesu s `--device …`
  (PortAudio stream se váže při startu).
- Pokud device hlásí &lt; 6 kanálů, appka odmítne start — zkontroluj
  `arecord -l` / `pw-cli list-objects` že PipeWire/ALSA vidí 6ch UAC2.
- Prohlížečové chirp/chirpdev zůstávají mono; toto je nativní cesta k array.
