#!/usr/bin/env node
/**
 * Fetch the latest qr_scrambler from GitHub into public/qr/
 * Used before every deploy so qr.het68.cz always ships the newest main.
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.QR_REPO || "fedurca/qr_scrambler";
const REF = process.env.QR_REF || "main";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "public", "qr");

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "het68-webflasher-fetch-qr",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function ghJson(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function downloadRaw(sha, path) {
  const url = `https://raw.githubusercontent.com/${REPO}/${sha}/${path}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "het68-webflasher-fetch-qr" },
  });
  if (!res.ok) {
    throw new Error(`Download failed ${res.status}: ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Browser tabs truncate from the end — keep semver at the start of <title>. */
function preferVersionFirstTitle(text) {
  let out = text;
  out = out.replace(
    /<title>\s*het68 QR\s+v(\d+\.\d+\.\d+)\s*<\/title>/gi,
    "<title>v$1 het68 QR</title>"
  );
  // build-single.js template: <title>het68 QR v${version}</title>
  out = out.replace(
    /<title>het68 QR v\$\{version\}<\/title>/g,
    "<title>v${version} het68 QR</title>"
  );
  out = out.replace(
    /document\.title\s*=\s*"het68 QR v"\s*\+\s*([^;\n]+);/g,
    'document.title = "v" + $1 + " het68 QR";'
  );
  return out;
}

function shouldRewriteTitle(path) {
  return /\.(html?|js|mjs)$/i.test(path);
}

async function main() {
  console.log(`Fetching ${REPO}@${REF} → public/qr/`);

  const commit = await ghJson(`/repos/${REPO}/commits/${encodeURIComponent(REF)}`);
  const sha = commit.sha;
  const short = sha.slice(0, 7);
  const message = (commit.commit?.message || "").split("\n")[0];
  console.log(`Resolved ${REF} → ${short} (${message})`);

  const tree = await ghJson(`/repos/${REPO}/git/trees/${sha}?recursive=1`);
  const files = (tree.tree || []).filter(
    (t) =>
      t.type === "blob" &&
      !t.path.startsWith(".") &&
      t.path !== "LICENSE" &&
      t.path !== "README.md" &&
      !t.path.toUpperCase().startsWith("LICENSE")
  );

  if (files.length === 0) {
    throw new Error("No deployable files found in qr_scrambler");
  }

  await rm(DEST, { recursive: true, force: true });
  await mkdir(DEST, { recursive: true });

  for (const file of files) {
    let buf = await downloadRaw(sha, file.path);
    if (shouldRewriteTitle(file.path)) {
      const before = buf.toString("utf8");
      const after = preferVersionFirstTitle(before);
      if (after !== before) {
        buf = Buffer.from(after, "utf8");
        console.log(`  ~ title → version-first (${file.path})`);
      }
    }
    const out = join(DEST, file.path);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, buf);
    console.log(`  + ${file.path} (${buf.length} B)`);
  }

  const meta = {
    repo: REPO,
    ref: REF,
    sha,
    short,
    message,
    fetched_at: new Date().toISOString(),
    files: files.map((f) => f.path),
  };
  await writeFile(join(DEST, "version.json"), JSON.stringify(meta, null, 2) + "\n");
  console.log(`Wrote public/qr/version.json (${short})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
