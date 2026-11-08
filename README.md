# het68.cz

Statický web + firmware flasher + QR pro [HET68](https://github.com/fedurca/het68) na Cloudflare Workers.

| Host | Obsah |
|---|---|
| `het68.cz` | Marketing CZ `/` · EN `/en/` · DE `/de/` |
| `www.het68.cz` | 301 → `https://het68.cz/...` (www se vždy odřezává) |
| `flasher.het68.cz` | WebUSB flasher CZ `/` · EN `/en/` · DE `/de/` — jen Pimoroni Pico Plus 2 W |
| `qr.het68.cz` | QR scrambler z [fedurca/qr_scrambler](https://github.com/fedurca/qr_scrambler) |
| `chirp.het68.cz` | Akustický chirp dekodér CZ `/` · EN `/en/` · DE `/de/` |
| `dev.het68.cz` | chirpdev — ladění linky, sdílené nastavení mezi zařízeními (Durable Object), mapa nodů |

Před každým `npm run deploy` / CI deployem se stáhne **nejnovější `main`** z `qr_scrambler` do `public/qr/` (`npm run fetch:qr`).

## Lokální vývoj

```bash
npm install
npm run dev          # automaticky spustí fetch:qr
```

- Landing: `http://127.0.0.1:8787/`
- Flasher: `http://127.0.0.1:8787/flasher/`
- QR: `http://127.0.0.1:8787/qr/`
- API: `http://127.0.0.1:8787/api/releases`

## Flasher — podporovaná deska

Firmware se flashuje **jen** na finální hardware:

| Varianta | Asset |
|---|---|
| Pimoroni Pico Plus 2 W (RP2350B · 8 MB PSRAM · 16 MB flash) | `het68-<ver>-pico-plus2-w.uf2` |

WebUSB filtruje pouze RP2350 (`0x2e8a:0x000f`). Pico / Pico W (RP2040) a ostatní desky flasher odmítne.

## Deploy (z Macu)

```bash
git clone https://github.com/fedurca/het68_webflasher.git
cd het68_webflasher
npm install
npx wrangler login
npx wrangler deploy   # predeploy → fetch:qr → wrangler deploy
```

Custom Domains v `wrangler.toml`: `het68.cz`, `www.het68.cz`, `flasher.het68.cz`, `qr.het68.cz`.

CI (`.github/workflows/deploy.yml`) běží na push do `main`, ručně, každých 12 h (kvůli čerstvému QR) a na `repository_dispatch` typu `qr_scrambler_updated`.

## Spektrogram 6ch (localhost, mimo prohlížeč)

Prohlížeč typicky otevře jen 1–2 kanály. Pro plných **6 kanálů** HET68 UAC2
spusť host tool:

```bash
cd spectro6
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
sudo apt install -y portaudio19-dev   # jednou
python app.py --list-devices
python app.py --device het68          # http://127.0.0.1:8765/
```

Detaily: [`spectro6/README.md`](spectro6/README.md).

## Struktura

```
public/                 # landing (het68.cz)
public/flasher/         # flasher UI
public/qr/              # generováno z fedurca/qr_scrambler (fetch:qr)
spectro6/               # 6ch spektrogram + 2 kHz VU (Python, localhost)
scripts/fetch-qr.mjs    # stažení nejnovějšího QR z GitHubu
src/worker.js           # host routing + GitHub proxy
wrangler.toml
```
