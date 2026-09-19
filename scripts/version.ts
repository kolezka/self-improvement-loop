// One version for the whole repo: root package.json, every workspace
// package.json, and .claude-plugin/plugin.json. The release workflow runs this
// first, then builds dist/ from the bumped tree.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");

/** Every manifest that carries the plugin version, root first. */
export function manifestPaths(): string[] {
  const out = [join(ROOT, "package.json"), join(ROOT, ".claude-plugin", "plugin.json")];
  for (const dir of ["packages", "apps"]) {
    const base = join(ROOT, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const p = join(base, name, "package.json");
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

export function readVersion(path: string): string {
  return JSON.parse(readFileSync(path, "utf8")).version;
}

export function currentVersion(): string {
  return readVersion(join(ROOT, "package.json"));
}

export function nextVersion(current: string, bump: string): string {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) throw new Error(`current version is not semver: ${current}`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`bump must be major, minor, patch or an explicit x.y.z version, got: ${bump}`);
}

/** Rewrites the first "version" field of each manifest, leaving formatting alone. */
export function setVersion(version: string): string[] {
  const written: string[] = [];
  for (const p of manifestPaths()) {
    const text = readFileSync(p, "utf8");
    const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
    if (next === text && readVersion(p) !== version) throw new Error(`no version field to rewrite in ${p}`);
    if (next !== text) {
      writeFileSync(p, next);
      written.push(p);
    }
  }
  return written;
}

if (import.meta.main) {
  const bump = process.argv[2];
  if (!bump) {
    console.error("usage: bun scripts/version.ts <major|minor|patch|x.y.z>");
    process.exit(2);
  }
  const version = nextVersion(currentVersion(), bump);
  setVersion(version);
  // Stdout is only the new version, so CI can capture it directly.
  console.log(version);
}
