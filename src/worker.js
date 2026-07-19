/**
 * HET68 — Cloudflare Worker
 *
 * - het68.cz / www → static marketing site (Basic Auth)
 * - flasher.het68.cz → web flasher (no auth)
 * - /api/* → GitHub Releases proxy (flasher host, or /flasher path in dev)
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
    id: "pico2",
    label: "Raspberry Pi Pico 2",
    short: "Pico 2",
    description: "RP2350 · bez Wi‑Fi",
    assetPatterns: [/^het68-.+-pico2\.uf2$/i],
    rejectPatterns: [/pico2w/i, /pico2-w/i, /plus/i, /pimoroni/i],
  },
  {
    id: "pico2w",
    label: "Raspberry Pi Pico 2 W",
    short: "Pico 2 W",
    description: "RP2350 · CYW43439 Wi‑Fi / BT",
    assetPatterns: [/^het68-.+-pico2w\.uf2$/i, /^het68-.+-pico2-w\.uf2$/i],
    rejectPatterns: [/plus/i, /pimoroni/i],
  },
  {
    id: "pimoroni",
    label: "Pimoroni Pico Plus 2 W",
    short: "Pimoroni Plus 2 W",
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
      boards: BOARDS.map(({ id, label, short, description }) => ({
        id,
        label,
        short,
        description,
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

/**
 * Map flasher subdomain paths onto /flasher/* assets and follow
 * asset-platform redirects internally so the browser stays on /.
 */
async function serveFlasherHost(request, env) {
  const url = new URL(request.url);
  let path = url.pathname;

  if (path === "/" || path === "" || path === "/index.html") {
    path = "/flasher/index.html";
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

async function serveAssets(request, env) {
  return env.ASSETS.fetch(request);
}

function preferredLocalePath(request) {
  const al = (request.headers.get("Accept-Language") || "").toLowerCase();
  if (!al) return null;
  const primary = al.split(",")[0]?.trim().slice(0, 2);
  if (primary === "en") return "/en/";
  if (primary === "de") return "/de/";
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname;

    // API available on both hosts
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }

    // flasher.het68.cz — no Basic Auth
    if (isFlasherHost(host)) {
      // Soft locale: / → /en/ when browser prefers English
      if (
        (url.pathname === "/" || url.pathname === "") &&
        !url.searchParams.has("lang")
      ) {
        const al = (request.headers.get("Accept-Language") || "").toLowerCase();
        const primary = al.split(",")[0]?.trim().slice(0, 2);
        if (primary === "en") {
          return Response.redirect(new URL("/en/", url).toString(), 302);
        }
      }
      return serveFlasherHost(request, env);
    }

    // Dev convenience: /flasher/* without auth
    if (url.pathname === "/flasher" || url.pathname.startsWith("/flasher/")) {
      return serveAssets(request, env);
    }

    // Marketing site — Basic Auth (Cloudflare stand-in for .htaccess)
    if (!checkBasicAuth(request, env)) {
      return unauthorized();
    }

    // Soft locale hint: / → /en/ or /de/ from Accept-Language
    if (
      (url.pathname === "/" || url.pathname === "") &&
      !url.searchParams.has("lang")
    ) {
      const destPath = preferredLocalePath(request);
      if (destPath) {
        return Response.redirect(new URL(destPath, url).toString(), 302);
      }
    }

    return serveAssets(request, env);
  },
};
