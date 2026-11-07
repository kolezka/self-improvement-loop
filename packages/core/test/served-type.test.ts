// One rule for the artifact type of a ledger row. Five review rounds on PR #54
// came from copies of it disagreeing, so the rule lives in one function and
// this file keeps it that way.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { declaredType, type PromotionEntry, servedType } from "../src/schemas";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

function row(entry: Partial<PromotionEntry>): PromotionEntry {
  return { pattern: "kept-rule", artifact_type: "skill", served_by: null, ...entry } as PromotionEntry;
}

describe("a row's artifact type", () => {
  test("without a served_by the drafted type serves the row", () => {
    const entry = row({ artifact_type: "hook" });
    expect(servedType(entry)).toBe("hook");
    expect(declaredType(entry)).toBe("hook");
  });

  test("a served_by wins over the drafted type", () => {
    const entry = row({ artifact_type: "skill", served_by: { type: "agent", path: null } });
    expect(servedType(entry)).toBe("agent");
    expect(declaredType(entry)).toBe("agent");
  });

  // The case that broke five review rounds: a re-home to nothing declares
  // "none", but the row is still served by whatever its drafted type was, and a
  // branch that re-homes to nothing still differs from the live row.
  test("a served_by of none means not served, yet still declares none", () => {
    const entry = row({ artifact_type: "hook", served_by: { type: "none", path: null } });
    expect(servedType(entry)).toBe("hook");
    expect(declaredType(entry)).toBe("none");
  });

  test("a row drafted to nothing and re-homed to nothing is served by nothing", () => {
    const entry = row({ artifact_type: "none", served_by: { type: "none", path: null } });
    expect(servedType(entry)).toBe("none");
    expect(declaredType(entry)).toBe("none");
  });
});

/** Every .ts file under `<pkg>/src` of the workspace packages and apps. */
function sourceFiles(): string[] {
  const roots: string[] = [];
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(join(REPO_ROOT, group))) {
      const src = join(REPO_ROOT, group, name, "src");
      try {
        readdirSync(src);
      } catch {
        continue;
      }
      roots.push(src);
    }
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else if (item.name.endsWith(".ts")) files.push(path);
    }
  };
  for (const root of roots) walk(root);
  return files;
}

describe("the rule has no second copy", () => {
  // Reading `served_by.type` directly is how the copies started. Writers set
  // `served_by: { type: ... }` (no dot), so this only catches readers.
  test("only @sil/core/schemas reads served_by.type", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles()) {
      const text = readFileSync(path, "utf8");
      if (!/served_by\??\.type/.test(text)) continue;
      const rel = path.slice(REPO_ROOT.length + 1);
      if (rel === "packages/core/src/schemas.ts") continue;
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("the readers that used to keep a copy delegate to the shared rule", () => {
    const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");
    expect(read("packages/review/src/snapshot.ts")).toContain("servedType(entry)");
    expect(read("packages/curriculum/src/context.ts")).toContain("servedType(entry)");
    expect(read("packages/curriculum/src/run.ts")).toContain("declaredType(entry)");
  });
});
