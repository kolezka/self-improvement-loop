import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The release workflow runs scripts/bump-version.sh, which fails when any
// source file still carries the old version. A version literal in a test
// fixture once made every real release fail at that step. This runs the real
// script on a copy of the tracked tree, so any such literal fails here first.
const ROOT = join(import.meta.dir, "..");

describe("scripts/bump-version.sh", () => {
  test("a patch bump of the current tree succeeds", () => {
    const tmp = mkdtempSync(join(tmpdir(), "sil-bump-"));
    try {
      const files = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT }).stdout.toString().split("\0").filter(Boolean);
      for (const f of files) cpSync(join(ROOT, f), join(tmp, f), { recursive: true });
      const current = JSON.parse(readFileSync(join(tmp, "package.json"), "utf8")).version as string;
      const [major, minor, patch] = current.split(".").map(Number);
      const next = `${major}.${minor}.${patch! + 1}`;

      const run = Bun.spawnSync(["bash", "scripts/bump-version.sh", next, "--no-build"], {
        cwd: tmp,
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.stderr.toString()).not.toContain("still present in");
      expect(run.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(tmp, "package.json"), "utf8")).version).toBe(next);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
