/**
 * HET68 web flasher — Cloudflare Worker
 *
 * Proxies GitHub Releases so the browser can list versions and download UF2
 * assets (GitHub release CDN does not send CORS headers).
 */

const GITHUB_API = "https://api.github.com";
const RELEASES_CACHE_TTL = 60; // seconds
const FIRMWARE_CACHE_TTL = 300;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": `public, max-age=${RELEASES_CACHE_TTL}`,
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status, {
    "cache-control": "no-store",
  });
}

function githubHeaders() {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "het68-webflasher",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Supported board variants and how their UF2 assets are named. */
const BOARDS = [
  {
    id: "pico2",
    label: "Raspberry Pi Pico 2",
    short: "Pico 2",
    description: "RP2350 · bez Wi‑Fi",
    assetPatterns: [/^het68-.+-pico2\.uf2$/i],
    // Exclude wireless / plus variants that also contain "pico2"
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

async function handleFirmware(request, env, tag, boardId) {
  const repo = env.FIRMWARE_REPO || "fedurca/het68";
  const board = BOARDS.find((b) => b.id === boardId);
  if (!board) return err(`Neznámá deska: ${boardId}`, 404);
  if (!tag || !/^[A-Za-z0-9._-]+$/.test(tag)) {
    return err("Neplatný tag release", 400);
  }

  const apiUrl = `${GITHUB_API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const metaRes = await fetch(apiUrl, { headers: githubHeaders() });
  if (metaRes.status === 404) return err(`Release ${tag} neexistuje`, 404);
  if (!metaRes.ok) {
    return err(`GitHub API ${metaRes.status}`, 502);
  }

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

  if (!dlRes.ok) {
    return err(`Stažení UF2 selhalo (${dlRes.status})`, 502);
  }

  const headers = new Headers();
  headers.set(
    "content-type",
    asset.content_type || "application/octet-stream"
  );
  headers.set(
    "content-disposition",
    `attachment; filename="${asset.name}"`
  );
  headers.set("access-control-allow-origin", "*");
  headers.set(
    "cache-control",
    `public, max-age=${FIRMWARE_CACHE_TTL}`
  );
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

  if (request.method !== "GET") {
    return err("Method not allowed", 405);
  }

  if (url.pathname === "/api/health") {
    return json({ ok: true, service: "het68-webflasher" });
  }

  if (url.pathname === "/api/releases") {
    return handleReleases(env);
  }

  const fw = url.pathname.match(
    /^\/api\/firmware\/([^/]+)\/([a-z0-9-]+)\/?$/i
  );
  if (fw) {
    return handleFirmware(request, env, decodeURIComponent(fw[1]), fw[2]);
  }

  return err("Not found", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
