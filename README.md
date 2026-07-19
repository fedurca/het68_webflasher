# het68.cz

Statický web + firmware flasher + QR pro [HET68](https://github.com/fedurca/het68) na Cloudflare Workers.

| Host | Obsah | Auth |
|---|---|---|
| `het68.cz` / `www.het68.cz` | Marketing CZ `/` · EN `/en/` · DE `/de/` | Basic Auth `dev:dev` |
| `flasher.het68.cz` | WebUSB flasher CZ `/` · EN `/en/` | bez auth |
| `qr.het68.cz` | QR scrambler z [fedurca/qr_scrambler](https://github.com/fedurca/qr_scrambler) | bez auth |

Před každým `npm run deploy` / CI deployem se stáhne **nejnovější `main`** z `qr_scrambler` do `public/qr/` (`npm run fetch:qr`).

## Lokální vývoj

```bash
npm install
npm run dev          # automaticky spustí fetch:qr
```

- Landing: `http://127.0.0.1:8787/` — login **dev / dev**
- Flasher: `http://127.0.0.1:8787/flasher/`
- QR: `http://127.0.0.1:8787/qr/`
- API: `http://127.0.0.1:8787/api/releases`

## Flasher — podporované desky

| Varianta | Asset |
|---|---|
| Raspberry Pi Pico 2 | `het68-<ver>-pico2.uf2` |
| Raspberry Pi Pico 2 W | `het68-<ver>-pico2w.uf2` |
| Pimoroni Pico Plus 2 W (8 MB PSRAM · 16 MB flash) | `het68-<ver>-pico-plus2-w.uf2` |

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

## Struktura

```
public/                 # landing (het68.cz)
public/flasher/         # flasher UI
public/qr/              # generováno z fedurca/qr_scrambler (fetch:qr)
scripts/fetch-qr.mjs    # stažení nejnovějšího QR z GitHubu
src/worker.js           # auth + host routing + GitHub proxy
wrangler.toml
```
