# HET68 Web Flasher

Webový flasher pro firmware [HET68](https://github.com/fedurca/het68) běžící na **Cloudflare Workers Static Assets** (doména **het68.cz**).

Stáhne UF2 z [GitHub Releases](https://github.com/fedurca/het68/releases) a nahraje ho přes **WebUSB / PICOBOOT** na desku v BOOTSEL režimu.

## Podporované desky

| Varianta | Asset pattern | Poznámka |
|---|---|---|
| **Raspberry Pi Pico 2** | `het68-<ver>-pico2.uf2` | RP2350 |
| **Raspberry Pi Pico 2 W** | `het68-<ver>-pico2w.uf2` / `pico2-w` | pokud je v release |
| **Pimoroni Pico Plus 2 W** | `het68-<ver>-pico-plus2-w.uf2` | 8 MB PSRAM · 16 MB flash |

## Požadavky na klienta

- Chromium prohlížeč (Chrome / Edge / Brave) s WebUSB
- Deska v **BOOTSEL** (RP2350)

## Lokální vývoj

```bash
npm install
npm run dev
```

Otevři URL z Wrangleru (typicky `http://127.0.0.1:8787`).

API:

- `GET /api/releases` — seznam releases + dostupnost UF2 per deska
- `GET /api/firmware/:tag/:board` — proxy stažení UF2 (`pico2` \| `pico2w` \| `pimoroni`)

## Deploy na Cloudflare (het68.cz)

1. V Cloudflare vytvoř Worker / připoj účet.
2. Nastav GitHub secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
3. Push na `main` spustí [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).
4. Doménu připoj:

```bash
npx wrangler deploy
npx wrangler domains add het68.cz
# případně www:
npx wrangler domains add www.het68.cz
```

Nebo v `wrangler.toml` odkomentuj `[[routes]]` pro zónu `het68.cz`.

## Struktura

```
public/          # statický frontend (HTML/CSS/JS)
src/worker.js    # API proxy na GitHub Releases (CORS)
wrangler.toml    # Cloudflare Workers + Static Assets
```

## Poznámky

- GitHub release CDN neposílá CORS hlavičky — UF2 se stahuje přes Worker proxy.
- Flasher používá ROM PICOBOOT protokol (ne drag&drop na MSC disk), takže flash běží přímo z prohlížeče.
