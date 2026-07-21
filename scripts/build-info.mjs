#!/usr/bin/env node
/**
 * Write public/build-info.json stamped at build/deploy time.
 * Consumed by the footer to show version, deploy date and age.
 */
import { readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function gitShort() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT })
      .toString()
      .trim();
  } catch (_) {
    return "";
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const info = {
    version: pkg.version,
    commit: gitShort(),
    deployedAt: new Date().toISOString(),
  };
  const out = join(ROOT, "public", "build-info.json");
  await writeFile(out, JSON.stringify(info, null, 2) + "\n");
  console.log(
    `Wrote public/build-info.json (v${info.version} ${info.commit} @ ${info.deployedAt})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
