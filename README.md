# het68.cz

Statický web + firmware flasher pro [HET68](https://github.com/fedurca/het68) na Cloudflare Workers.

| Host | Obsah | Auth |
|---|---|---|
| `het68.cz` / `www.het68.cz` | Marketingový web (mobile-first) | Basic Auth `dev:dev` |
| `flasher.het68.cz` | WebUSB firmware flasher | bez auth |

## Lokální vývoj

```bash
npm install
npm run dev
```

- Landing: `http://127.0.0.1:8787/` — prohlížeč vyžádá login **dev / dev**
- Flasher (dev path): `http://127.0.0.1:8787/flasher/`
- API: `http://127.0.0.1:8787/api/releases`

## Flasher — podporované desky

| Varianta | Asset |
|---|---|
| Raspberry Pi Pico 2 | `het68-<ver>-pico2.uf2` |
| Raspberry Pi Pico 2 W | `het68-<ver>-pico2w.uf2` |
| Pimoroni Pico Plus 2 W (8 MB PSRAM · 16 MB flash) | `het68-<ver>-pico-plus2-w.uf2` |

## Deploy

1. Secrets v GitHubu: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
2. Push na `main` → [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
3. Domény:

```bash
npx wrangler deploy
npx wrangler domains add het68.cz
npx wrangler domains add www.het68.cz
npx wrangler domains add flasher.het68.cz
```

Heslo změníš přes `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` ve `wrangler.toml` (nebo secrets).

## Struktura

```
public/                 # landing (het68.cz)
public/flasher/         # flasher UI (flasher.het68.cz)
src/worker.js           # Basic Auth + host routing + GitHub proxy
wrangler.toml
```
