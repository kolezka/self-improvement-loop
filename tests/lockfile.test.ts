// bun.lock records every workspace version and is a sourceHash() input
// (scripts/build.ts). A version bump that leaves it behind is invisible until
// someone runs a plain `bun install`, which rewrites the lockfile and fails
// tests/dist.test.ts on a checkout they never touched. This catches that one
// cause, the version bump, where the message still names it.
//
// It is not a check that the lockfile is current: a dropped dependency or a
// deleted workspace leaves this green and still rewrites bun.lock. The
// `lockfile is current` step in .github/workflows/ci.yml is that check.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LOCK = readFileSync(join(ROOT, "bun.lock"), "utf8");

function workspacePackages(): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  for (const group of ["packages", "apps"]) {
    for (const entry of readdirSync(join(ROOT, group)).sort()) {
      const file = join(ROOT, group, entry, "package.json");
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (e) {
        // A directory without a manifest is not a workspace. Anything else,
        // a permission error for instance, is a real problem and must not
        // shrink the list this test walks.
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (pkg.name && pkg.version) out.push({ name: pkg.name, version: pkg.version });
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

  test.each(packages.map((p) => [p.name, p.version] as const))(
    "%s is recorded at %s",
    (name, version) => {
      // The version is the next field after the name inside that workspace entry.
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const found = new RegExp(`"name":\\s*"${escaped}",\\s*"version":\\s*"([^"]+)"`).exec(
        LOCK.replace(/\s+/g, " "),
      );
      expect(found).not.toBeNull();
      expect(found![1]).toBe(version);
    },
  );
});
