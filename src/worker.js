/**
 * HET68 — Cloudflare Worker
 *
 * - www.* → 301 strip to apex (www.het68.cz → het68.cz) before routing
 * - Public hosts are open (no authentication)
 * - het68.cz → static marketing site
 * - flasher.het68.cz → web flasher (Pimoroni Pico Plus 2 W only)
 * - qr.het68.cz → QR scrambler from fedurca/qr_scrambler
 * - chirp.het68.cz → acoustic chirp decoder
 * - dev.het68.cz → chirpdev tuning playground
 * - api.het68.cz → API host (placeholder REST surface)
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

// Final hardware only: Pimoroni Pico Plus 2 W (RP2350B + 8 MB PSRAM).
// Older Pico / Pico W / Pico 2 / Pico 2 W images are no longer built.
const FINAL_BOARD = {
  id: "het68",
  label: "Pimoroni Pico Plus 2 W",
  short: "Plus 2 W",
  mcu: "RP2350",
  description: "Finální HW · RP2350B · 8 MB PSRAM · 16 MB flash · Wi‑Fi / BT",
  assetPatterns: [
    /^het68-.+-pico-plus2-w\.uf2$/i,
    /^het68-.+-pimoroni.*\.uf2$/i,
    /^het68-.+-plus2-w\.uf2$/i,
  ],
  rejectPatterns: [],
};

const BOARDS = [FINAL_BOARD];

const BOARD_ALIASES = {
  pimoroni: "het68",
  plus2w: "het68",
  "pico-plus2-w": "het68",
};

function resolveBoardId(boardId) {
  if (!boardId) return boardId;
  return BOARD_ALIASES[boardId] || boardId;
}

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
  boardId = resolveBoardId(boardId);
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

function isApiHost(hostname) {
  const host = (hostname || "").toLowerCase();
  return host === "api.het68.cz" || host.startsWith("api.");
}

/**
 * Resolve request host. Prefer flasher/qr/chirp/api when any candidate matches —
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
    if (
      isFlasherHost(h) ||
      isQrHost(h) ||
      isChirpHost(h) ||
      isDevHost(h) ||
      isApiHost(h)
    ) {
      return h;
    }
  }
  return candidates[0] || url.hostname.toLowerCase();
}

/**
 * api.het68.cz — dedicated API host. Public placeholder until the REST API ships.
 */
async function serveApiHost(request, env) {
  const url = new URL(request.url);
  let path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "86400",
      },
    });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return err("Method not allowed", 405);
  }

  if (path === "/health" || path === "/v1/health") {
    return json({
      ok: true,
      service: "het68-api",
      host: "api.het68.cz",
      auth: "none",
      status: "placeholder",
    });
  }

  const sharedRoot = new Set([
    "/theme.js",
    "/theme-boot.js",
    "/styles.css",
    "/docs.css",
    "/favicon.svg",
    "/build-info.json",
  ]);

  if (path === "/" || path === "" || path === "/index.html") {
    path = "/apihost/index.html";
  } else if (path.startsWith("/apihost/")) {
    // keep
  } else if (sharedRoot.has(path)) {
    // keep
  } else {
    return json(
      {
        ok: false,
        service: "het68-api",
        host: "api.het68.cz",
        auth: "none",
        status: "not_implemented",
        message: "API surface is not public yet — endpoints coming soon.",
        docs: "https://het68.cz/api/",
      },
      501
    );
  }

  const assetUrl = new URL(request.url);
  assetUrl.pathname = path;
  return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
}

/**
 * Map flasher subdomain paths onto /flasher/* assets and follow
 * asset-platform redirects internally so the browser stays on /.
 */
async function serveFlasherHost(request, env) {
  const url = new URL(request.url);
  let path = url.pathname;

  // Shared root assets (not under /flasher/)
  const sharedRoot = new Set([
    "/lang.js",
    "/theme.js",
    "/theme-boot.js",
    "/build-info.json",
    "/styles.css",
    "/docs.css",
    "/favicon.svg",
  ]);

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

  const sharedRoot = new Set([
    "/build-info.json",
    "/lang.js",
    "/theme.js",
    "/theme-boot.js",
  ]);

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
    path === "/theme.js" ||
    path === "/theme-boot.js" ||
    path.startsWith("/chirp/") // shared chirp assets (styles.css, etc.)
  ) {
    // keep as-is
  } else if (path === "/" || path === "" || path === "/index.html") {
    path = "/chirpdev/index.html";
  } else if (path === "/en" || path === "/en/" || path === "/en/index.html") {
    path = "/chirpdev/en/index.html";
  } else if (path === "/de" || path === "/de/" || path === "/de/index.html") {
    path = "/chirpdev/de/index.html";
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

/** Locale path for chirpdev playground (CS / EN / DE). */
function chirpdevPathForLang(lang) {
  if (lang === "en") return "/en/";
  if (lang === "de") return "/de/";
  return null; // cs → stay on /
}

function localeRedirect(request, url, pathForLang) {
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.searchParams.has("lang")) return null;

  // Cookie only. Accept-Language must not fight client localStorage
  // (HAR: / ↔ /en/ reload loop when LS=cs but edge still 302'd to /en/).
  const lang = cookieLang(request);
  if (!lang || lang === "cs") return null;
  const dest = pathForLang(lang);
  if (!dest) return null;
  return new Response(null, {
    status: 302,
    headers: {
      Location: new URL(dest, url).toString(),
      "Cache-Control": "private, no-store",
    },
  });
}

/** Mark every HTML/asset response as non-indexable (search + AI). */
function withNoIndex(response) {
  if (!response) return response;
  const headers = new Headers(response.headers);
  if (!headers.has("X-Robots-Tag")) {
    headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

    // Canonical host: always strip www.
    const wwwRedirect = wwwCanonicalRedirect(request);
    if (wwwRedirect) return wwwRedirect;

    const host = requestHostname(request);

    let response;

    if (isApiHost(host)) {
      response = await serveApiHost(request, env);
    } else if (url.pathname.startsWith("/api/dev/")) {
      // chirpdev shared-room API (tuning params + node presence)
      response = await handleDevApi(request, env);
    } else if (url.pathname.startsWith("/api/")) {
      // Firmware / releases proxy (flasher + apex paths)
      response = await handleApi(request, env);
    } else if (isDevHost(host)) {
      const redirect = localeRedirect(request, url, chirpdevPathForLang);
      response = redirect || (await serveDevHost(request, env));
    } else if (isFlasherHost(host)) {
      const redirect = localeRedirect(request, url, flasherPathForLang);
      response = redirect || (await serveFlasherHost(request, env));
    } else if (isQrHost(host)) {
      response = await serveQrHost(request, env);
    } else if (isChirpHost(host)) {
      const redirect = localeRedirect(request, url, chirpPathForLang);
      response = redirect || (await serveChirpHost(request, env));
    } else if (url.pathname === "/flasher" || url.pathname.startsWith("/flasher/")) {
      response = await serveAssets(request, env);
    } else if (url.pathname === "/qr" || url.pathname.startsWith("/qr/")) {
      response = await serveAssets(request, env);
    } else if (url.pathname === "/chirp" || url.pathname.startsWith("/chirp/")) {
      response = await serveAssets(request, env);
    } else if (url.pathname === "/chirpdev" || url.pathname.startsWith("/chirpdev/")) {
      response = await serveAssets(request, env);
    } else {
      const redirect = localeRedirect(request, url, sitePathForLang);
      response = redirect || (await serveAssets(request, env));
    }

    return withNoIndex(response);
  },
};

/**
 * ConfigRoom — shared Durable Object for chirpdev.
 *
 * Holds shared tuning config, live node presence, and a 10-slot memory bank of
 * named trial profiles (params + optional notes / map / audio metadata).
 *
 * Endpoints (JSON):
 *   GET  /api/dev/state
 *   POST /api/dev/config     { config }
 *   POST /api/dev/heartbeat  { fp, node, label, rx, tx, heard }
 *   POST /api/dev/bank       { action, slot, name?, profile? }
 */
function emptyBankSlot(i) {
  return {
    slot: i,
    name: "",
    empty: true,
    config: null,
    map: null,
    note: null,
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

export class ConfigRoom {
  constructor(state) {
    this.state = state;
    this.v = 0;
    this.config = null;
    this.nodes = new Map(); // fp -> presence
    this.bank = emptyBank();
    // Ephemeral shared debug-event ring (not persisted): every node posts its
    // notable events (decode / tx / mic / config / error) so the debug window
    // shows a merged, time-ordered stream across all connected nodes.
    this.events = [];
    this.eventSeq = 0;
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
      hasAudio: !!(
        s.audio &&
        ((s.audio.chunks | 0) > 0 ||
          (s.audio.clips && s.audio.clips.length))
      ),
      audioBytes: s.audio && s.audio.bytes != null ? s.audio.bytes | 0 : 0,
      hasMap: !!(s.map && s.map.nodes && s.map.nodes.length),
      note: s.note ? String(s.note).slice(0, 80) : "",
    }));
  }

  /** Delete chunked WAV blobs for a bank slot (keys bankwav:<slot>:<i>). */
  async _clearSlotChunks(slot) {
    const listed = await this.state.storage.list({
      prefix: `bankwav:${slot}:`,
    });
    const keys = Array.from(listed.keys());
    if (keys.length) await this.state.storage.delete(keys);
  }

  _recentEvents(sinceSeq) {
    if (sinceSeq == null) return this.events.slice(-80);
    return this.events.filter((e) => e.seq > sinceSeq);
  }

  _publicState(sinceSeq) {
    return {
      v: this.v,
      config: this.config,
      nodes: this._nodeList(),
      bank: this._bankSummary(),
      events: this._recentEvents(sinceSeq),
      eventSeq: this.eventSeq,
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
      const sinceSeq = url.searchParams.has("sinceSeq")
        ? parseInt(url.searchParams.get("sinceSeq"), 10)
        : null;
      return json(this._publicState(Number.isFinite(sinceSeq) ? sinceSeq : null));
    }

    if (path === "/api/dev/events" && request.method === "POST") {
      const body = await readBody();
      if (!body) return json({ error: "bad json" }, 400);
      const fp = String(body.fp || "").slice(0, 16);
      const node = body.node | 0;
      const label = String(body.label || "").slice(0, 24);
      const list = Array.isArray(body.events) ? body.events.slice(0, 40) : [];
      for (const e of list) {
        this.eventSeq = (this.eventSeq + 1) >>> 0 || 1;
        this.events.push({
          seq: this.eventSeq,
          at: Date.now(),
          t: e.t | 0,
          fp,
          node,
          label,
          kind: String(e.kind || "log").slice(0, 16),
          msg: String(e.msg || "").slice(0, 200),
          lvl: e.lvl | 0,
        });
      }
      if (this.events.length > 400) this.events = this.events.slice(-400);
      const sinceSeq = body.sinceSeq | 0;
      return json({
        ok: true,
        events: this._recentEvents(sinceSeq || null),
        eventSeq: this.eventSeq,
      });
    }

    if (path === "/api/dev/config" && request.method === "POST") {
      const body = await readBody();
      if (!body) return json({ error: "bad json" }, 400);
      if (body.config) {
        this.config = body.config;
        this.v = (this.v + 1) >>> 0;
        await this.state.storage.put({ v: this.v, config: this.config });
      }
      return json({ v: this.v, config: this.config, bank: this._bankSummary() });
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
        // Keep prior chunked audio unless client clears / replaces via chunk_*.
        const prevAudio = this.bank[slot] && !this.bank[slot].empty
          ? this.bank[slot].audio
          : null;
        let audio = profile.audio != null ? profile.audio : prevAudio;
        // Never embed raw PCM in the bank row — only metadata about chunks.
        if (audio && audio.b64) {
          delete audio.b64;
        }
        this.bank[slot] = {
          slot,
          name: name || "Profil " + (slot + 1),
          empty: false,
          config: cfg,
          map: profile.map || null,
          note: profile.note != null ? String(profile.note).slice(0, 240) : null,
          audio: audio,
          ids: profile.ids || null,
          meta: {
            savedAt: Date.now(),
            airMs,
            rx: profile.rx | 0,
            tx: profile.tx | 0,
            minScore: profile.minScore != null ? profile.minScore : null,
            goodput: profile.goodput != null ? profile.goodput : null,
            byFp: profile.byFp ? String(profile.byFp).slice(0, 16) : null,
            byLabel: profile.byLabel
              ? String(profile.byLabel).slice(0, 24)
              : null,
          },
        };
        await this.state.storage.put({ bank: this.bank });
        return json({
          ok: true,
          bank: this._bankSummary(),
          slot: this.bank[slot],
        });
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
        await this._clearSlotChunks(slot);
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
        return json({
          ok: true,
          v: this.v,
          config: this.config,
          slot: s,
          bank: this._bankSummary(),
          nodes: this._nodeList(),
        });
      }

      // Chunked WAV storage (≤ ~1.2 MB base64 per chunk; DO value limit 2 MB).
      if (action === "chunk_clear") {
        await this._clearSlotChunks(slot);
        if (this.bank[slot] && !this.bank[slot].empty) {
          this.bank[slot].audio = null;
          await this.state.storage.put({ bank: this.bank });
        }
        return json({ ok: true, bank: this._bankSummary() });
      }

      if (action === "chunk_put") {
        const index = body.index | 0;
        const total = body.total | 0;
        if (index < 0 || index > 63 || total < 1 || total > 64) {
          return json({ error: "bad chunk index/total" }, 400);
        }
        if (!body.b64) return json({ error: "b64 required" }, 400);
        const b64 = String(body.b64).slice(0, 1400000);
        await this.state.storage.put(`bankwav:${slot}:${index}`, {
          b64,
          index,
          total,
          sr: body.sr | 0,
          samples: body.samples | 0,
          bytes: body.bytes | 0,
          at: Date.now(),
        });
        // Update slot audio metadata when the last chunk lands (or on any put).
        if (this.bank[slot] && !this.bank[slot].empty) {
          this.bank[slot].audio = {
            format: "pcm16le",
            sr: body.sr | 0,
            samples: body.samples | 0,
            bytes: body.bytes | 0,
            chunks: total,
          };
          await this.state.storage.put({ bank: this.bank });
        }
        return json({
          ok: true,
          index,
          total,
          bank: this._bankSummary(),
        });
      }

      if (action === "chunk_get") {
        const index = body.index | 0;
        const row = await this.state.storage.get(`bankwav:${slot}:${index}`);
        if (!row) return json({ error: "chunk missing" }, 404);
        return json({
          ok: true,
          slot,
          index: row.index,
          total: row.total,
          b64: row.b64,
          sr: row.sr,
          samples: row.samples,
          bytes: row.bytes,
        });
      }

      if (action === "chunk_meta") {
        const s = this.bank[slot];
        return json({
          ok: true,
          empty: !s || !!s.empty,
          audio: s && s.audio ? s.audio : null,
        });
      }

      return json({ error: "unknown action" }, 400);
    }

    return json({ error: "not found" }, 404);
  }
}
