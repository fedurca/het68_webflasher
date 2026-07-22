/**
 * HET68 — Cloudflare Worker
 *
 * - www.* → 301 strip to apex (www.het68.cz → het68.cz) before auth/routing
 * - All public hosts require Basic Auth (dev:dev by default)
 * - After one successful login, a shared HttpOnly cookie on `.het68.cz` is set
 *   so other subdomains (flasher / chirp / qr / dev / apex) do not prompt again
 * - het68.cz → static marketing site
 * - flasher.het68.cz → web flasher
 * - qr.het68.cz → QR scrambler from fedurca/qr_scrambler
 * - chirp.het68.cz → acoustic chirp decoder
 * - dev.het68.cz → chirpdev tuning playground
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

const AUTH_COOKIE = "het68_auth";
const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

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

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const out = Object.create(null);
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Parent-domain cookie so one login covers apex + all *.het68.cz hosts. */
function authCookieDomain(hostname) {
  const host = (hostname || "").toLowerCase().split(":")[0];
  if (host === "het68.cz" || host.endsWith(".het68.cz")) return ".het68.cz";
  return null;
}

async function authToken(env) {
  const user = env.BASIC_AUTH_USER || "dev";
  const pass = env.BASIC_AUTH_PASS || "dev";
  const material = `het68-shared-auth|${user}|${pass}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function buildAuthCookie(hostname, token) {
  let cookie =
    `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE}`;
  const domain = authCookieDomain(hostname);
  if (domain) cookie += `; Domain=${domain}`;
  return cookie;
}

function withAuthCookie(response, hostname, token) {
  if (!response || !token) return response;
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", buildAuthCookie(hostname, token));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Accept either:
 *  - shared auth cookie (set after login on any *.het68.cz host), or
 *  - valid Basic Auth (then caller should attach Set-Cookie to the response).
 */
async function authorizeRequest(request, env) {
  const expected = await authToken(env);
  const cookies = parseCookies(request);
  const cookieVal = cookies[AUTH_COOKIE];
  if (cookieVal && timingSafeEqual(cookieVal, expected)) {
    return { ok: true, setCookie: false, token: expected };
  }
  if (checkBasicAuth(request, env)) {
    return { ok: true, setCookie: true, token: expected };
  }
  return { ok: false, setCookie: false, token: null };
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
    // Cookie is on Domain=.het68.cz, so it survives apex/subdomain hops.
    const wwwRedirect = wwwCanonicalRedirect(request);
    if (wwwRedirect) return wwwRedirect;

    const host = requestHostname(request);

    // Gate every public host + API. One Basic login sets a shared cookie on
    // .het68.cz so flasher / chirp / qr / dev / apex do not prompt again.
    const auth = await authorizeRequest(request, env);
    if (!auth.ok) return unauthorized();

    let response;

    // chirpdev shared-room API (tuning params + node presence)
    if (url.pathname.startsWith("/api/dev/")) {
      response = await handleDevApi(request, env);
    } else if (url.pathname.startsWith("/api/")) {
      // API available on both hosts
      response = await handleApi(request, env);
    } else if (isDevHost(host)) {
      response = await serveDevHost(request, env);
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

    if (auth.setCookie) {
      response = withAuthCookie(response, host, auth.token);
    }
    return response;
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

  _publicState() {
    return {
      v: this.v,
      config: this.config,
      nodes: this._nodeList(),
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
