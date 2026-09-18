// bun.lock records every workspace version and is a sourceHash() input
// (scripts/build.ts). A version bump that leaves it behind is invisible until
// someone runs a plain `bun install`, which rewrites the lockfile and fails
// tests/dist.test.ts on a checkout they never touched. This catches the stale
// lockfile instead, where the cause is still readable.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LOCK = readFileSync(join(ROOT, "bun.lock"), "utf8");

function workspacePackages(): { dir: string; name: string; version: string }[] {
  const out: { dir: string; name: string; version: string }[] = [];
  for (const group of ["packages", "apps"]) {
    for (const entry of readdirSync(join(ROOT, group)).sort()) {
      const dir = `${group}/${entry}`;
      let raw: string;
      try {
        raw = readFileSync(join(ROOT, dir, "package.json"), "utf8");
      } catch {
        continue;
      }
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (pkg.name && pkg.version) out.push({ dir, name: pkg.name, version: pkg.version });
    }
  }
  return out;
}

describe("bun.lock", () => {
  const packages = workspacePackages();

  test("lists every workspace package", () => {
    expect(packages.length).toBeGreaterThan(0);
    for (const pkg of packages) expect(LOCK).toContain(`"${pkg.name}"`);
  });

  test.each(packages.map((p) => [p.name, p.version, p.dir] as const))(
    "%s is recorded at %s",
    (name, version) => {
      // The version is the next field after the name inside that workspace entry.
      const found = new RegExp(`"name":\\s*"${name.replace("/", "\\/")}",\\s*"version":\\s*"([^"]+)"`).exec(
        LOCK.replace(/\s+/g, " "),
      );
      expect(found).not.toBeNull();
      expect(found![1]).toBe(version);
    },
  );
});
