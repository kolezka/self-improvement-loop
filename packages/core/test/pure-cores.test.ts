// The Claude Code hooks module runs in a sandbox that refuses any node:
// import anywhere in its bundle and has no `process` and no `Bun`. These
// files are the ones it imports, so a single node: import added to any of
// them breaks the fast path at load, not at call.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

const PURE_FILES = [
  "packages/core/src/layout.ts",
  "packages/core/src/lessons.ts",
  "packages/core/src/hook-snapshot.ts",
  "packages/core/src/samples.ts",
  "packages/core/src/consts.ts",
  "packages/nudges/src/dispatch-core.ts",
  "packages/nudges/src/gates.ts",
  "packages/nudges/src/lint.ts",
];

const BANNED = ['from "node:', "from 'node:", "process.env", "Bun.", "require("];

function source(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), "utf8");
}

describe("pure cores stay importable from a no-Node sandbox", () => {
  test("none of them names node:, process.env, Bun or require", () => {
    // Positive control first: an empty match must never be what makes this
    // pass. paths.ts is the Node binding and does import node:.
    expect(source("packages/core/src/paths.ts")).toContain('from "node:');

    const offenders: string[] = [];
    for (const file of PURE_FILES) {
      const text = source(file);
      for (const banned of BANNED) {
        if (text.includes(banned)) offenders.push(`${file}: ${banned}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
