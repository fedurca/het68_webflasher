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
  try {
    const id = env.CONFIG_ROOM.idFromName("global");
    const stub = env.CONFIG_ROOM.get(id);
    return await stub.fetch(request);
  } catch (e) {
    return err("dev room error: " + (e && e.message ? e.message : String(e)), 500);
  }
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
 * ConfigRoom — shared Durable Object for chirpdev.
 *
 * Holds shared tuning config, live node presence, a two-device autotune session
 * (web-path TX/RX reports for link-quality scoring), and a 10-slot memory bank
 * of named profiles (params + map + time-sync + audio clips).
 *
 * Endpoints (JSON):
 *   GET  /api/dev/state
 *   POST /api/dev/config     { config }
 *   POST /api/dev/heartbeat  { fp, node, label, rx, tx, heard }
 *   POST /api/dev/autotune   { action, ... }
 *   POST /api/dev/bank       { action, slot, name?, profile? }
 */
function emptyBankSlot(i) {
  return {
    slot: i,
    name: "",
    empty: true,
    config: null,
    map: null,
    sync: null,
    audio: null,
    ids: null,
    meta: null,
  };
}

function emptyBank() {
  const bank = [];
  for (let i = 0; i < 10; i++) bank.push(emptyBankSlot(i));
  return bank;
}

function freshAutotune() {
  return {
    active: false,
    sessionId: 0,
    leaderFp: "",
    phase: "idle",
    message: "",
    trialId: 0,
    trialStart: 0,
    config: null,
    scores: [],
    best: null,
    txLog: [],
    rxLog: [],
    sync: { pairs: {} },
    map: { nodes: [], scaleM: 1 },
    audio: {},
    updatedAt: Date.now(),
  };
}

export class ConfigRoom {
  constructor(state) {
    this.state = state;
    this.v = 0;
    this.config = null;
    this.nodes = new Map(); // fp -> presence
    this.bank = emptyBank();
    this.autotune = freshAutotune();
    this.loaded = false;
  }

  async _load() {
    if (this.loaded) return;
    const stored = await this.state.storage.get(["v", "config", "bank"]);
    this.v = stored.get("v") || 0;
    this.config = stored.get("config") || null;
    const bank = stored.get("bank");
    this.bank = Array.isArray(bank) && bank.length === 10 ? bank : emptyBank();
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

  _bankSummary() {
    return this.bank.map((s) => ({
      slot: s.slot,
      name: s.name || "",
      empty: !!s.empty,
      savedAt: s.meta && s.meta.savedAt ? s.meta.savedAt : null,
      airMs: s.meta && s.meta.airMs != null ? s.meta.airMs : null,
      hasAudio: !!(s.audio && s.audio.clips && s.audio.clips.length),
      hasMap: !!(s.map && s.map.nodes && s.map.nodes.length),
    }));
  }

  _autotunePublic() {
    const a = this.autotune;
    return {
      active: a.active,
      sessionId: a.sessionId,
      leaderFp: a.leaderFp,
      phase: a.phase,
      message: a.message,
      trialId: a.trialId,
      trialStart: a.trialStart,
      config: a.config,
      scores: a.scores.slice(-24),
      best: a.best,
      sync: a.sync,
      map: a.map,
      // Recent web-path announcements so peers can evaluate quality.
      txRecent: a.txLog.slice(-40),
      rxRecent: a.rxLog.slice(-40),
      audioFps: Object.keys(a.audio || {}),
      updatedAt: a.updatedAt,
    };
  }

  _scoreTrial(trialId) {
    const txs = this.autotune.txLog.filter((t) => t.trialId === trialId);
    const rxs = this.autotune.rxLog.filter((r) => r.trialId === trialId && r.ok);
    const byFp = {};
    for (const t of txs) {
      if (!byFp[t.fp]) byFp[t.fp] = { sent: 0, heard: 0 };
      byFp[t.fp].sent++;
      const hit = rxs.some(
        (r) =>
          r.fp !== t.fp &&
          r.payloadHex === t.payloadHex &&
          (r.fromFp == null || r.fromFp === t.fp)
      );
      if (hit) byFp[t.fp].heard++;
    }
    const fps = Object.keys(byFp).sort();
    const links = [];
    for (const fp of fps) {
      const s = byFp[fp];
      links.push({
        fromFp: fp,
        sent: s.sent,
        heard: s.heard,
        score: s.sent ? s.heard / s.sent : 0,
      });
    }
    const scores = links.map((l) => l.score);
    const minScore = scores.length ? Math.min(...scores) : 0;
    const meanScore = scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0;
    return {
      trialId,
      links,
      minScore,
      meanScore,
      sent: txs.length,
      heard: rxs.length,
    };
  }

  _touchAutotune() {
    this.autotune.updatedAt = Date.now();
  }

  _publicState() {
    return {
      v: this.v,
      config: this.config,
      nodes: this._nodeList(),
      autotune: this._autotunePublic(),
      bank: this._bankSummary(),
    };
  }

  async fetch(request) {
    try {
      return await this._handle(request);
    } catch (e) {
      return new Response(
        JSON.stringify({
          error: "room: " + (e && e.message ? e.message : String(e)),
        }),
        {
          status: 500,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          },
        }
      );
    }
  }

  async _handle(request) {
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

    const readBody = async () => {
      try {
        return await request.json();
      } catch (e) {
        return null;
      }
    };

    if (path === "/api/dev/state") {
      return json(this._publicState());
    }

    if (path === "/api/dev/config" && request.method === "POST") {
      const body = await readBody();
      if (!body) return json({ error: "bad json" }, 400);
      if (body.config) {
        this.config = body.config;
        this.v = (this.v + 1) >>> 0;
        await this.state.storage.put({ v: this.v, config: this.config });
      }
      return json({ v: this.v, config: this.config });
    }

    if (path === "/api/dev/heartbeat" && request.method === "POST") {
      const body = await readBody();
      if (!body) return json({ error: "bad json" }, 400);
      if (body.fp) {
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
      return json(this._publicState());
    }

    if (path === "/api/dev/autotune" && request.method === "POST") {
      const body = await readBody();
      if (!body || !body.action) return json({ error: "bad json" }, 400);
      const action = String(body.action);
      const a = this.autotune;

      if (action === "start") {
        const leaderFp = String(body.fp || "").slice(0, 16);
        if (!leaderFp) return json({ error: "fp required" }, 400);
        this.autotune = freshAutotune();
        this.autotune.active = true;
        this.autotune.sessionId = ((a.sessionId || 0) + 1) >>> 0 || 1;
        this.autotune.leaderFp = leaderFp;
        this.autotune.phase = "sync";
        this.autotune.message = "časová synchronizace";
        this._touchAutotune();
        return json(this._publicState());
      }

      if (action === "stop") {
        this.autotune.active = false;
        this.autotune.phase = this.autotune.best ? "done" : "idle";
        this.autotune.message = body.message
          ? String(body.message).slice(0, 120)
          : "zastaveno";
        this._touchAutotune();
        return json(this._publicState());
      }

      if (action === "phase") {
        if (body.phase) this.autotune.phase = String(body.phase).slice(0, 24);
        if (body.message != null)
          this.autotune.message = String(body.message).slice(0, 160);
        this._touchAutotune();
        return json(this._publicState());
      }

      if (action === "trial") {
        // Begin a new probe trial with a candidate config.
        if (!body.config) return json({ error: "config required" }, 400);
        this.autotune.trialId = (this.autotune.trialId + 1) >>> 0 || 1;
        this.autotune.trialStart = Date.now();
        this.autotune.config = body.config;
        this.autotune.phase = "probe";
        this.autotune.message = body.message
          ? String(body.message).slice(0, 160)
          : "zkouška #" + this.autotune.trialId;
        // Keep prior trial logs for scoring history; ring-buffer trims size.
        // Also publish as shared room config so followers adopt it.
        this.config = body.config;
        this.v = (this.v + 1) >>> 0;
        await this.state.storage.put({ v: this.v, config: this.config });
        this._touchAutotune();
        return json(this._publicState());
      }

      if (action === "tx_announce") {
        const entry = {
          trialId: body.trialId | 0,
          fp: String(body.fp || "").slice(0, 16),
          node: body.node | 0,
          seq: body.seq | 0,
          payloadHex: String(body.payloadHex || "")
            .toLowerCase()
            .slice(0, 64),
          txWallMs: body.txWallMs | 0,
          airMs: body.airMs | 0,
          at: Date.now(),
        };
        if (!entry.fp || !entry.payloadHex)
          return json({ error: "fp+payloadHex required" }, 400);
        this.autotune.txLog.push(entry);
        if (this.autotune.txLog.length > 200)
          this.autotune.txLog = this.autotune.txLog.slice(-200);
        this._touchAutotune();
        return json({ ok: true, autotune: this._autotunePublic() });
      }

      if (action === "rx_report") {
        const entry = {
          trialId: body.trialId | 0,
          fp: String(body.fp || "").slice(0, 16),
          fromFp: body.fromFp ? String(body.fromFp).slice(0, 16) : null,
          fromNode: body.fromNode != null ? body.fromNode | 0 : null,
          seq: body.seq | 0,
          payloadHex: String(body.payloadHex || "")
            .toLowerCase()
            .slice(0, 64),
          ok: !!body.ok,
          rho: typeof body.rho === "number" ? body.rho : 0,
          rxWallMs: body.rxWallMs | 0,
          at: Date.now(),
        };
        if (!entry.fp) return json({ error: "fp required" }, 400);
        // Match announce for delay estimate.
        const tx = this.autotune.txLog.find(
          (t) =>
            t.payloadHex === entry.payloadHex &&
            t.trialId === entry.trialId &&
            t.fp !== entry.fp
        );
        if (tx) {
          entry.fromFp = entry.fromFp || tx.fp;
          entry.delayMs = entry.rxWallMs - tx.txWallMs;
        }
        this.autotune.rxLog.push(entry);
        if (this.autotune.rxLog.length > 200)
          this.autotune.rxLog = this.autotune.rxLog.slice(-200);
        this._touchAutotune();
        return json({ ok: true, autotune: this._autotunePublic() });
      }

      if (action === "score") {
        const trialId =
          body.trialId != null ? body.trialId | 0 : this.autotune.trialId;
        const scored = this._scoreTrial(trialId);
        const airMs =
          body.airMs != null
            ? body.airMs | 0
            : this.autotune.config
              ? Math.round(
                  31 * (this.autotune.config.preChipMs || 1) +
                    248 * (this.autotune.config.dataChipMs || 4)
                )
              : 0;
        const threshold =
          typeof body.threshold === "number" ? body.threshold : 0.75;
        const minSent = body.minSent != null ? body.minSent | 0 : 1;
        const minLinks = body.minLinks != null ? body.minLinks | 0 : 1;
        const reliable =
          body.reliable != null
            ? !!body.reliable
            : scored.minScore >= threshold &&
              scored.sent >= minSent &&
              scored.links.length >= minLinks;
        const row = {
          trialId,
          config: body.config || this.autotune.config,
          airMs,
          minScore: scored.minScore,
          meanScore: scored.meanScore,
          links: scored.links,
          sent: scored.sent,
          heard: scored.heard,
          reliable,
          at: Date.now(),
        };
        const existing = this.autotune.scores.findIndex(
          (s) => s.trialId === trialId
        );
        if (existing >= 0) this.autotune.scores[existing] = row;
        else this.autotune.scores.push(row);
        if (this.autotune.scores.length > 40)
          this.autotune.scores = this.autotune.scores.slice(-40);
        if (
          row.reliable &&
          (!this.autotune.best ||
            row.airMs < this.autotune.best.airMs ||
            (row.airMs === this.autotune.best.airMs &&
              row.minScore > this.autotune.best.minScore))
        ) {
          this.autotune.best = {
            config: row.config,
            airMs: row.airMs,
            minScore: row.minScore,
            meanScore: row.meanScore,
            trialId: row.trialId,
          };
        }
        if (body.phase) this.autotune.phase = String(body.phase).slice(0, 24);
        if (body.message != null)
          this.autotune.message = String(body.message).slice(0, 160);
        this._touchAutotune();
        return json({ score: row, autotune: this._autotunePublic() });
      }

      if (action === "sync") {
        // Acoustic / web time sync pair measurement.
        const fpA = String(body.fpA || body.fp || "").slice(0, 16);
        const fpB = String(body.fpB || body.peerFp || "").slice(0, 16);
        if (!fpA || !fpB) return json({ error: "fpA+fpB required" }, 400);
        const key = fpA < fpB ? fpA + "|" + fpB : fpB + "|" + fpA;
        const prev = this.autotune.sync.pairs[key] || {};
        const offsetMs =
          typeof body.offsetMs === "number" ? body.offsetMs : prev.offsetMs;
        const rttMs =
          typeof body.rttMs === "number" ? body.rttMs : prev.rttMs;
        let distanceM =
          typeof body.distanceM === "number" ? body.distanceM : prev.distanceM;
        if (
          distanceM == null &&
          typeof body.delayMs === "number" &&
          body.delayMs > 0 &&
          body.delayMs < 500
        ) {
          // One-way acoustic delay → distance (343 m/s), clamp to room scale.
          distanceM = Math.min(30, Math.max(0.2, (body.delayMs / 1000) * 343));
        }
        this.autotune.sync.pairs[key] = {
          fpA: key.split("|")[0],
          fpB: key.split("|")[1],
          offsetMs: offsetMs != null ? offsetMs : 0,
          rttMs: rttMs != null ? rttMs : null,
          distanceM: distanceM != null ? distanceM : null,
          updatedAt: Date.now(),
        };
        this._touchAutotune();
        return json({
          ok: true,
          pair: this.autotune.sync.pairs[key],
          autotune: this._autotunePublic(),
        });
      }

      if (action === "map") {
        if (body.map && Array.isArray(body.map.nodes)) {
          this.autotune.map = {
            nodes: body.map.nodes.slice(0, 16).map((n) => ({
              fp: String(n.fp || "").slice(0, 16),
              node: n.node | 0,
              label: String(n.label || "").slice(0, 24),
              x: typeof n.x === "number" ? n.x : 0,
              y: typeof n.y === "number" ? n.y : 0,
              id: String(n.id || n.label || "").slice(0, 24),
            })),
            scaleM:
              typeof body.map.scaleM === "number" ? body.map.scaleM : 1,
          };
        }
        this._touchAutotune();
        return json({ ok: true, autotune: this._autotunePublic() });
      }

      if (action === "audio") {
        const fpKey = String(body.fp || "").slice(0, 16);
        if (!fpKey || !body.b64) return json({ error: "fp+b64 required" }, 400);
        const b64 = String(body.b64).slice(0, 48000); // ~36 KB cap
        this.autotune.audio[fpKey] = {
          fp: fpKey,
          label: String(body.label || "").slice(0, 24),
          b64,
          sr: body.sr | 0 || 8000,
          samples: body.samples | 0,
          trialId: body.trialId | 0,
          at: Date.now(),
        };
        // Keep at most 4 clips in the live session.
        const keys = Object.keys(this.autotune.audio);
        if (keys.length > 4) {
          keys
            .sort(
              (x, y) =>
                (this.autotune.audio[x].at || 0) -
                (this.autotune.audio[y].at || 0)
            )
            .slice(0, keys.length - 4)
            .forEach((k) => {
              delete this.autotune.audio[k];
            });
        }
        this._touchAutotune();
        return json({ ok: true, audioFps: Object.keys(this.autotune.audio) });
      }

      if (action === "done") {
        this.autotune.active = false;
        this.autotune.phase = this.autotune.best ? "done" : "failed";
        this.autotune.message = body.message
          ? String(body.message).slice(0, 160)
          : this.autotune.best
            ? "hotovo"
            : "nepodařilo se";
        this._touchAutotune();
        return json(this._publicState());
      }

      return json({ error: "unknown action" }, 400);
    }

    if (path === "/api/dev/bank" && request.method === "POST") {
      const body = await readBody();
      if (!body || !body.action) return json({ error: "bad json" }, 400);
      const action = String(body.action);
      const slot = body.slot | 0;
      if (slot < 0 || slot > 9) return json({ error: "slot 0-9" }, 400);

      if (action === "list") {
        return json({ bank: this._bankSummary() });
      }

      if (action === "get") {
        return json({ slot: this.bank[slot] });
      }

      if (action === "save") {
        const name = String(body.name || this.bank[slot].name || "")
          .trim()
          .slice(0, 40);
        const profile = body.profile || {};
        const cfg = profile.config || body.config || this.config;
        if (!cfg) return json({ error: "config required" }, 400);
        const airMs = Math.round(
          31 * (cfg.preChipMs || 1) + 248 * (cfg.dataChipMs || 4)
        );
        // Prefer explicit profile audio/map/sync; fall back to live autotune.
        let audio = profile.audio || null;
        if (!audio && this.autotune.audio) {
          const clips = Object.values(this.autotune.audio).map((c) => ({
            fp: c.fp,
            label: c.label,
            b64: c.b64,
            sr: c.sr,
            samples: c.samples,
          }));
          if (clips.length) audio = { clips };
        }
        const map =
          profile.map ||
          (this.autotune.map && this.autotune.map.nodes.length
            ? this.autotune.map
            : null);
        const sync = profile.sync || this.autotune.sync || null;
        const ids =
          profile.ids ||
          this._nodeList().map((n) => ({
            fp: n.fp,
            node: n.node,
            label: n.label,
          }));
        this.bank[slot] = {
          slot,
          name: name || "Profil " + (slot + 1),
          empty: false,
          config: cfg,
          map,
          sync,
          audio,
          ids,
          meta: {
            savedAt: Date.now(),
            airMs,
            minScore:
              profile.minScore != null
                ? profile.minScore
                : this.autotune.best
                  ? this.autotune.best.minScore
                  : null,
            meanScore:
              profile.meanScore != null
                ? profile.meanScore
                : this.autotune.best
                  ? this.autotune.best.meanScore
                  : null,
            sessionId: this.autotune.sessionId || null,
          },
        };
        await this.state.storage.put({ bank: this.bank });
        return json({ ok: true, bank: this._bankSummary(), slot: this.bank[slot] });
      }

      if (action === "rename") {
        if (this.bank[slot].empty) return json({ error: "empty slot" }, 400);
        this.bank[slot].name = String(body.name || "")
          .trim()
          .slice(0, 40);
        await this.state.storage.put({ bank: this.bank });
        return json({ ok: true, bank: this._bankSummary() });
      }

      if (action === "clear") {
        this.bank[slot] = emptyBankSlot(slot);
        await this.state.storage.put({ bank: this.bank });
        return json({ ok: true, bank: this._bankSummary() });
      }

      if (action === "load") {
        const s = this.bank[slot];
        if (s.empty) return json({ error: "empty slot" }, 400);
        this.config = s.config;
        this.v = (this.v + 1) >>> 0;
        await this.state.storage.put({ v: this.v, config: this.config });
        // Restore map/sync into live autotune view (without starting a session).
        if (s.map) this.autotune.map = s.map;
        if (s.sync) this.autotune.sync = s.sync;
        this._touchAutotune();
        return json({
          ok: true,
          v: this.v,
          config: this.config,
          slot: s,
          autotune: this._autotunePublic(),
          bank: this._bankSummary(),
        });
      }

      return json({ error: "unknown action" }, 400);
    }

    return json({ error: "not found" }, 404);
  }
}
