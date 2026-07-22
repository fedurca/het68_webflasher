/**
 * HET68 — Cloudflare Worker
 *
 * - www.* → 301 strip to apex (www.het68.cz → het68.cz) before auth/routing
 * - het68.cz → static marketing site (Basic Auth)
 * - flasher.het68.cz → web flasher (no auth)
 * - qr.het68.cz → QR scrambler from fedurca/qr_scrambler (no auth)
 * - chirp.het68.cz → acoustic chirp decoder (no auth)
 * - /api/* → GitHub Releases proxy (flasher host, or /flasher path in dev)
 *
 * Note: DNS alone cannot strip "www" from the hostname — the www custom domain
 * still points here so this Worker can issue the canonical redirect.
 */

const GITHUB_API = "https://api.github.com";
const RELEASES_CACHE_TTL = 60;
const FIRMWARE_CACHE_TTL = 300;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": `public, max-age=${RELEASES_CACHE_TTL}`,
};

const BOARDS = [
  {
    id: "het68",
    label: "het68 board",
    short: "het68 board",
    mcu: "RP2350",
    description: "Firemní zařízení · RP2350 · Wi‑Fi / BT",
    // Virtual platform — ships the same firmware as the Pimoroni Plus 2 W.
    assetPatterns: [
      /^het68-.+-pico-plus2-w\.uf2$/i,
      /^het68-.+-pimoroni.*\.uf2$/i,
      /^het68-.+-plus2-w\.uf2$/i,
    ],
    rejectPatterns: [],
  },
  {
    id: "pico1",
    label: "Raspberry Pi Pico",
    short: "Pico",
    mcu: "RP2040",
    description: "RP2040 · bez Wi‑Fi",
    assetPatterns: [/^het68-.+-pico1\.uf2$/i, /^het68-.+-pico\.uf2$/i],
    rejectPatterns: [/pico1w/i, /picow/i, /pico2/i, /plus/i, /pimoroni/i],
  },
  {
    id: "pico1w",
    label: "Raspberry Pi Pico W",
    short: "Pico W",
    mcu: "RP2040",
    description: "RP2040 · CYW43439 Wi‑Fi / BT",
    assetPatterns: [
      /^het68-.+-pico1w\.uf2$/i,
      /^het68-.+-pico1-w\.uf2$/i,
      /^het68-.+-picow\.uf2$/i,
      /^het68-.+-pico-w\.uf2$/i,
    ],
    rejectPatterns: [/pico2/i, /plus/i, /pimoroni/i],
  },
  {
    id: "pico2",
    label: "Raspberry Pi Pico 2",
    short: "Pico 2",
    mcu: "RP2350",
    description: "RP2350 · bez Wi‑Fi",
    assetPatterns: [/^het68-.+-pico2\.uf2$/i],
    rejectPatterns: [/pico2w/i, /pico2-w/i, /plus/i, /pimoroni/i],
  },
  {
    id: "pico2w",
    label: "Raspberry Pi Pico 2 W",
    short: "Pico 2 W",
    mcu: "RP2350",
    description: "RP2350 · CYW43439 Wi‑Fi / BT",
    assetPatterns: [/^het68-.+-pico2w\.uf2$/i, /^het68-.+-pico2-w\.uf2$/i],
    rejectPatterns: [/plus/i, /pimoroni/i],
  },
  {
    id: "pimoroni",
    label: "Pimoroni Pico Plus 2 W",
    short: "Pimoroni Plus 2 W",
    mcu: "RP2350",
    description: "RP2350 · 8 MB PSRAM · 16 MB flash · Wi‑Fi / BT",
    assetPatterns: [
      /^het68-.+-pico-plus2-w\.uf2$/i,
      /^het68-.+-pimoroni.*\.uf2$/i,
      /^het68-.+-plus2-w\.uf2$/i,
    ],
    rejectPatterns: [],
  },
];

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status, { "cache-control": "no-store" });
}

function githubHeaders() {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "het68-webflasher",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function matchBoardAsset(board, assetName) {
  if (board.rejectPatterns.some((re) => re.test(assetName))) return false;
  return board.assetPatterns.some((re) => re.test(assetName));
}

function findUf2ForBoard(assets, boardId) {
  const board = BOARDS.find((b) => b.id === boardId);
  if (!board) return null;
  return assets.find((a) => matchBoardAsset(board, a.name)) || null;
}

function normalizeRelease(release) {
  const assets = (release.assets || []).map((a) => ({
    name: a.name,
    size: a.size,
    content_type: a.content_type,
    download_url: a.browser_download_url,
    updated_at: a.updated_at,
  }));

  const boards = {};
  for (const board of BOARDS) {
    const uf2 = findUf2ForBoard(assets, board.id);
    boards[board.id] = uf2
      ? {
          available: true,
          name: uf2.name,
          size: uf2.size,
          updated_at: uf2.updated_at,
        }
      : { available: false };
  }

  return {
    tag: release.tag_name,
    name: release.name || release.tag_name,
    published_at: release.published_at,
    prerelease: !!release.prerelease,
    draft: !!release.draft,
    html_url: release.html_url,
    body: release.body || "",
    boards,
  };
}

async function fetchReleases(repo) {
  const url = `${GITHUB_API}/repos/${repo}/releases?per_page=30`;
  const res = await fetch(url, {
    headers: githubHeaders(),
    cf: { cacheTtl: RELEASES_CACHE_TTL, cacheEverything: true },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`);
  }
  const raw = await res.json();
  return raw
    .filter((r) => !r.draft)
    .map(normalizeRelease)
    .filter((r) => Object.values(r.boards).some((b) => b.available));
}

async function handleReleases(env) {
  const repo = env.FIRMWARE_REPO || "fedurca/het68";
  try {
    const releases = await fetchReleases(repo);
    return json({
      repo,
      source: `https://github.com/${repo}/releases`,
      boards: BOARDS.map(({ id, label, short, description, mcu }) => ({
        id,
        label,
        short,
        description,
        mcu,
      })),
      releases,
      latest: releases.find((r) => !r.prerelease) || releases[0] || null,
    });
  } catch (e) {
    return err(`Nelze načíst releases: ${e.message}`, 502);
  }
}

async function handleFirmware(env, tag, boardId) {
  const repo = env.FIRMWARE_REPO || "fedurca/het68";
  const board = BOARDS.find((b) => b.id === boardId);
  if (!board) return err(`Neznámá deska: ${boardId}`, 404);
  if (!tag || !/^[A-Za-z0-9._-]+$/.test(tag)) {
    return err("Neplatný tag release", 400);
  }

  const apiUrl = `${GITHUB_API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const metaRes = await fetch(apiUrl, { headers: githubHeaders() });
  if (metaRes.status === 404) return err(`Release ${tag} neexistuje`, 404);
  if (!metaRes.ok) return err(`GitHub API ${metaRes.status}`, 502);

  const release = await metaRes.json();
  const asset = findUf2ForBoard(release.assets || [], boardId);
  if (!asset) {
    return err(
      `Pro ${board.label} není v release ${tag} dostupný UF2 asset`,
      404
    );
  }

  const dlRes = await fetch(asset.browser_download_url, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "het68-webflasher",
    },
    redirect: "follow",
    cf: { cacheTtl: FIRMWARE_CACHE_TTL, cacheEverything: true },
  });
  if (!dlRes.ok) return err(`Stažení UF2 selhalo (${dlRes.status})`, 502);

  const headers = new Headers();
  headers.set("content-type", asset.content_type || "application/octet-stream");
  headers.set("content-disposition", `attachment; filename="${asset.name}"`);
  headers.set("access-control-allow-origin", "*");
  headers.set("cache-control", `public, max-age=${FIRMWARE_CACHE_TTL}`);
  headers.set("x-het68-asset", asset.name);
  headers.set("x-het68-board", boardId);
  headers.set("x-het68-tag", tag);
  if (dlRes.headers.get("content-length")) {
    headers.set("content-length", dlRes.headers.get("content-length"));
  }
  return new Response(dlRes.body, { status: 200, headers });
}

async function handleApi(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
      },
    });
  }

  if (request.method !== "GET") return err("Method not allowed", 405);

  if (url.pathname === "/api/health") {
    return json({ ok: true, service: "het68" });
  }
  if (url.pathname === "/api/releases") return handleReleases(env);

  const fw = url.pathname.match(
    /^\/api\/firmware\/([^/]+)\/([a-z0-9-]+)\/?$/i
  );
  if (fw) {
    return handleFirmware(env, decodeURIComponent(fw[1]), fw[2]);
  }
  return err("Not found", 404);
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa[i] ^ bb[i];
  return out === 0;
}

function unauthorized() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="het68", charset="UTF-8"',
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function checkBasicAuth(request, env) {
  const user = env.BASIC_AUTH_USER || "dev";
  const pass = env.BASIC_AUTH_PASS || "dev";
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const colon = decoded.indexOf(":");
    if (colon < 0) return false;
    const u = decoded.slice(0, colon);
    const p = decoded.slice(colon + 1);
    return timingSafeEqual(u, user) && timingSafeEqual(p, pass);
  } catch {
    return false;
  }
}

function isFlasherHost(hostname) {
  const host = (hostname || "").toLowerCase();
  return host === "flasher.het68.cz" || host.startsWith("flasher.");
}

function isQrHost(hostname) {
  const host = (hostname || "").toLowerCase();
  return host === "qr.het68.cz" || host.startsWith("qr.");
}

function isChirpHost(hostname) {
  const host = (hostname || "").toLowerCase();
  return host === "chirp.het68.cz" || host.startsWith("chirp.");
}

function isDevHost(hostname) {
  const host = (hostname || "").toLowerCase();
  return host === "dev.het68.cz" || host.startsWith("dev.");
}

/**
 * Resolve request host. Prefer flasher/qr/chirp when any candidate matches —
 * local `wrangler dev` rewrites URL/Host to the first custom_domain (het68.cz).
 */
function requestHostname(request) {
  const url = new URL(request.url);
  const candidates = [
    request.headers.get("X-Forwarded-Host")?.split(",")[0]?.trim(),
    request.headers.get("Host"),
    url.hostname,
  ]
    .filter(Boolean)
    .map((h) => h.split(":")[0].toLowerCase());

  for (const h of candidates) {
    if (isFlasherHost(h) || isQrHost(h) || isChirpHost(h) || isDevHost(h)) return h;
  }
  return candidates[0] || url.hostname.toLowerCase();
}

/**
 * Map flasher subdomain paths onto /flasher/* assets and follow
 * asset-platform redirects internally so the browser stays on /.
 */
async function serveFlasherHost(request, env) {
  const url = new URL(request.url);
  let path = url.pathname;

  // Shared root assets (not under /flasher/)
  const sharedRoot = new Set(["/lang.js", "/build-info.json"]);

  if (path === "/" || path === "" || path === "/index.html") {
    path = "/flasher/index.html";
  } else if (sharedRoot.has(path)) {
    // keep as-is
  } else if (!path.startsWith("/flasher/")) {
    path = `/flasher${path.startsWith("/") ? path : `/${path}`}`;
  }

  let assetUrl = new URL(request.url);
  assetUrl.pathname = path;

  let res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));

  // Follow trailing-slash / SPA redirects inside the worker
  for (let i = 0; i < 3; i++) {
    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers.get("Location");
    if (!loc) break;
    assetUrl = new URL(loc, assetUrl);
    if (!assetUrl.pathname.startsWith("/flasher")) {
      assetUrl.pathname = `/flasher${assetUrl.pathname === "/" ? "/" : assetUrl.pathname}`;
    }
    res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  }

  return res;
}

/**
 * Map qr.het68.cz onto /qr/* (latest fetch of fedurca/qr_scrambler).
 */
async function serveQrHost(request, env) {
  const url = new URL(request.url);
  let path = url.pathname;

  if (path === "/" || path === "" || path === "/index.html") {
    path = "/qr/index.html";
  } else if (path === "/version.json" || path.startsWith("/qr/")) {
    if (!path.startsWith("/qr/")) path = `/qr${path}`;
  } else if (!path.startsWith("/qr/")) {
    path = `/qr${path.startsWith("/") ? path : `/${path}`}`;
  }

  let assetUrl = new URL(request.url);
  assetUrl.pathname = path;

  let res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));

  for (let i = 0; i < 3; i++) {
    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers.get("Location");
    if (!loc) break;
    assetUrl = new URL(loc, assetUrl);
    if (!assetUrl.pathname.startsWith("/qr")) {
      assetUrl.pathname = `/qr${assetUrl.pathname === "/" ? "/" : assetUrl.pathname}`;
    }
    res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  }

  return res;
}

/**
 * Map chirp.het68.cz onto /chirp/* (acoustic chirp decoder web app).
 */
async function serveChirpHost(request, env) {
  const url = new URL(request.url);
  let path = url.pathname;

  const sharedRoot = new Set(["/build-info.json", "/lang.js"]);

  if (path === "/" || path === "" || path === "/index.html") {
    path = "/chirp/index.html";
  } else if (sharedRoot.has(path)) {
    // keep as-is
  } else if (!path.startsWith("/chirp/")) {
    path = `/chirp${path.startsWith("/") ? path : `/${path}`}`;
  }

  let assetUrl = new URL(request.url);
  assetUrl.pathname = path;

  let res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));

  for (let i = 0; i < 3; i++) {
    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers.get("Location");
    if (!loc) break;
    assetUrl = new URL(loc, assetUrl);
    if (!assetUrl.pathname.startsWith("/chirp")) {
      assetUrl.pathname = `/chirp${assetUrl.pathname === "/" ? "/" : assetUrl.pathname}`;
    }
    res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  }

  return res;
}

/**
 * Map dev.het68.cz onto /chirpdev/* (parameter-tuning playground). The ALINK
 * modem is shared with the chirp app (served from /chirp/alink.js).
 */
async function serveDevHost(request, env) {
  const url = new URL(request.url);
  let path = url.pathname;

  if (path === "/alink.js") {
    path = "/chirp/alink.js"; // shared modem
  } else if (
    path === "/build-info.json" ||
    path === "/lang.js" ||
    path.startsWith("/chirp/") // shared chirp assets (styles.css, etc.)
  ) {
    // keep as-is
  } else if (path === "/" || path === "" || path === "/index.html") {
    path = "/chirpdev/index.html";
  } else if (!path.startsWith("/chirpdev/")) {
    path = `/chirpdev${path.startsWith("/") ? path : `/${path}`}`;
  }

  let assetUrl = new URL(request.url);
  assetUrl.pathname = path;
  let res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  for (let i = 0; i < 3; i++) {
    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers.get("Location");
    if (!loc) break;
    assetUrl = new URL(loc, assetUrl);
    if (!assetUrl.pathname.startsWith("/chirpdev") && assetUrl.pathname !== "/chirp/alink.js") {
      assetUrl.pathname = `/chirpdev${assetUrl.pathname === "/" ? "/" : assetUrl.pathname}`;
    }
    res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  }
  return res;
}

/** Shared tuning room + node presence for chirpdev (routed to the DO). */
async function handleDevApi(request, env) {
  if (!env.CONFIG_ROOM) return err("shared room unavailable", 503);
  const id = env.CONFIG_ROOM.idFromName("global");
  const stub = env.CONFIG_ROOM.get(id);
  return stub.fetch(request);
}

async function serveAssets(request, env) {
  return env.ASSETS.fetch(request);
}

function cookieLang(request) {
  const raw = request.headers.get("Cookie") || "";
  const m = raw.match(/(?:^|;\s*)het68_lang=([^;]+)/);
  if (!m) return null;
  try {
    const lang = decodeURIComponent(m[1]).slice(0, 2).toLowerCase();
    if (lang === "cs" || lang === "en" || lang === "de") return lang;
  } catch (_) {
    /* ignore */
  }
  return null;
}

function acceptLanguageLang(request) {
  const al = (request.headers.get("Accept-Language") || "").toLowerCase();
  if (!al) return null;
  const primary = al.split(",")[0]?.trim().slice(0, 2);
  if (primary === "en" || primary === "de" || primary === "cs") return primary;
  return null;
}

/** Locale path for marketing site. */
function sitePathForLang(lang) {
  if (lang === "en") return "/en/";
  if (lang === "de") return "/de/";
  return null; // cs → stay on /
}

/** Locale path for flasher (CS / EN / DE). */
function flasherPathForLang(lang) {
  if (lang === "en") return "/en/";
  if (lang === "de") return "/de/";
  return null; // cs → stay on /
}

/** Locale path for chirp decoder (CS / EN / DE). */
function chirpPathForLang(lang) {
  if (lang === "en") return "/en/";
  if (lang === "de") return "/de/";
  return null; // cs → stay on /
}

function localeRedirect(request, url, pathForLang) {
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.searchParams.has("lang")) return null;

  // Cookie wins (manual choice). Accept-Language only on first visit.
  const lang = cookieLang(request) || acceptLanguageLang(request);
  if (!lang || lang === "cs") return null;
  const dest = pathForLang(lang);
  if (!dest) return null;
  return Response.redirect(new URL(dest, url).toString(), 302);
}

/** Raw request host (Host / X-Forwarded-Host), without flasher/qr/chirp preference. */
function rawRequestHostname(request) {
  const url = new URL(request.url);
  const candidates = [
    request.headers.get("X-Forwarded-Host")?.split(",")[0]?.trim(),
    request.headers.get("Host"),
    url.hostname,
  ]
    .filter(Boolean)
    .map((h) => h.split(":")[0].toLowerCase());
  return candidates[0] || url.hostname.toLowerCase();
}

/** 301 www.example.com → example.com (path + query preserved). */
function wwwCanonicalRedirect(request) {
  const host = rawRequestHostname(request);
  if (!host.startsWith("www.")) return null;
  const apex = host.slice(4);
  if (!apex) return null;
  const url = new URL(request.url);
  const dest = new URL(url.pathname + url.search + url.hash, `https://${apex}`);
  return Response.redirect(dest.toString(), 301);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Canonical host: always strip www (before Basic Auth).
    const wwwRedirect = wwwCanonicalRedirect(request);
    if (wwwRedirect) return wwwRedirect;

    const host = requestHostname(request);

    // chirpdev shared-room API (tuning params + node presence)
    if (url.pathname.startsWith("/api/dev/")) {
      return handleDevApi(request, env);
    }

    // API available on both hosts
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }

    // dev.het68.cz — chirpdev tuning playground (no Basic Auth)
    if (isDevHost(host)) {
      return serveDevHost(request, env);
    }

    // flasher.het68.cz — no Basic Auth
    if (isFlasherHost(host)) {
      const redirect = localeRedirect(request, url, flasherPathForLang);
      if (redirect) return redirect;
      return serveFlasherHost(request, env);
    }

    // qr.het68.cz — latest qr_scrambler (no Basic Auth)
    if (isQrHost(host)) {
      return serveQrHost(request, env);
    }

    // chirp.het68.cz — acoustic chirp decoder (no Basic Auth)
    if (isChirpHost(host)) {
      const redirect = localeRedirect(request, url, chirpPathForLang);
      if (redirect) return redirect;
      return serveChirpHost(request, env);
    }

    // Dev convenience: /flasher/*, /qr/*, /chirp/* without auth
    if (url.pathname === "/flasher" || url.pathname.startsWith("/flasher/")) {
      return serveAssets(request, env);
    }
    if (url.pathname === "/qr" || url.pathname.startsWith("/qr/")) {
      return serveAssets(request, env);
    }
    if (url.pathname === "/chirp" || url.pathname.startsWith("/chirp/")) {
      return serveAssets(request, env);
    }
    if (url.pathname === "/chirpdev" || url.pathname.startsWith("/chirpdev/")) {
      return serveAssets(request, env);
    }

    // Marketing site — Basic Auth (Cloudflare stand-in for .htaccess)
    if (!checkBasicAuth(request, env)) {
      return unauthorized();
    }

    const redirect = localeRedirect(request, url, sitePathForLang);
    if (redirect) return redirect;

    return serveAssets(request, env);
  },
};

/**
 * ConfigRoom — a single shared Durable Object for chirpdev.
 *
 * Holds the current tuning config (agreed by all testers) plus a live presence
 * table of nodes (each browser is a node, identified by a fingerprint hash).
 * Clients poll a few times per second; whoever posts a new config bumps a
 * version so everyone converges on the same modulation parameters for a test.
 *
 * Endpoints (POST/GET JSON):
 *   GET  /api/dev/state           → { v, config, nodes: [...] }
 *   POST /api/dev/config {config} → set config, v++
 *   POST /api/dev/heartbeat {fp,node,label,rx,tx,heard:[...]} → upsert presence
 */
export class ConfigRoom {
  constructor(state) {
    this.state = state;
    this.v = 0;
    this.config = null;
    this.nodes = new Map(); // fp -> { fp, node, label, rx, tx, heard, at }
    this.loaded = false;
  }

  async _load() {
    if (this.loaded) return;
    const stored = await this.state.storage.get(["v", "config"]);
    this.v = stored.get("v") || 0;
    this.config = stored.get("config") || null;
    this.loaded = true;
  }

  _pruneNodes() {
    const now = Date.now();
    for (const [fp, n] of this.nodes) {
      if (now - n.at > 20000) this.nodes.delete(fp);
    }
  }

  _nodeList() {
    this._pruneNodes();
    return Array.from(this.nodes.values()).sort((a, b) =>
      a.fp < b.fp ? -1 : 1
    );
  }

  async fetch(request) {
    await this._load();
    const url = new URL(request.url);
    const path = url.pathname;
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o), {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        },
      });

    if (path === "/api/dev/state") {
      return json({ v: this.v, config: this.config, nodes: this._nodeList() });
    }

    if (path === "/api/dev/config" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "bad json" }, 400);
      }
      if (body && body.config) {
        this.config = body.config;
        this.v = (this.v + 1) >>> 0;
        await this.state.storage.put({ v: this.v, config: this.config });
      }
      return json({ v: this.v, config: this.config });
    }

    if (path === "/api/dev/heartbeat" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "bad json" }, 400);
      }
      if (body && body.fp) {
        this.nodes.set(String(body.fp).slice(0, 16), {
          fp: String(body.fp).slice(0, 16),
          node: body.node | 0,
          label: String(body.label || "").slice(0, 24),
          rx: body.rx | 0,
          tx: body.tx | 0,
          heard: Array.isArray(body.heard) ? body.heard.slice(0, 16) : [],
          at: Date.now(),
        });
      }
      return json({ v: this.v, config: this.config, nodes: this._nodeList() });
    }

    return json({ error: "not found" }, 404);
  }
}
