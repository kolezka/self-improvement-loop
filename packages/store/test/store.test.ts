import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "@sil/core";
import {
  listLessons,
  listQueue,
  listReflections,
  loadLedger,
  moveEntry,
  parseLedger,
  patternCounts,
  putLesson,
  reflectionPattern,
  saveAliases,
  saveLedger,
  section,
  splitFrontMatter,
  writeEntry,
  writeReflection,
} from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-store-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const body = (pattern: string) =>
  `Last updated: 2026-09-14\n\nPattern: ${pattern}\n\n## What worked\nx\n## What failed & why\ny\n## Reusable lesson\nDo the thing.\n## Verification\nran\n## Not verified\nnone\n`;

describe("reflections", () => {
  test("pattern line is the identity", () => {
    expect(reflectionPattern(body("verify-callsites"))).toBe("verify-callsites");
    expect(reflectionPattern("no pattern here")).toBeNull();
    expect(reflectionPattern("Pattern: Not_A_Slug")).toBeNull();
  });

  test("write then list, newest first, with front matter", () => {
    writeReflection("w", { id: "2026-09-10-a-0001", session_id: "s1" }, body("a"));
    writeReflection("w", { id: "2026-09-12-a-0002" }, body("a"));
    writeReflection("w", { id: "2026-09-11-b-0003" }, body("b"));
    const items = listReflections("w");
    expect(items.map((r) => r.id)).toEqual(["2026-09-12-a-0002", "2026-09-11-b-0003", "2026-09-10-a-0001"]);
    expect(items[2]!.session_id).toBe("s1");
    expect(items[0]!.lesson).toBe("Do the thing.");
    expect(patternCounts("w")).toEqual({ a: 2, b: 1 });
  });

  test("aliases fold counts one hop", () => {
    writeReflection("w", { id: "1" }, body("old-name"));
    writeReflection("w", { id: "2" }, body("new-name"));
    saveAliases("w", { "old-name": "new-name" });
    expect(patternCounts("w")).toEqual({ "new-name": 2 });
  });

  test("never overwrites and requires a pattern", () => {
    writeReflection("w", { id: "dup" }, body("a"));
    expect(() => writeReflection("w", { id: "dup" }, body("a"))).toThrow();
    expect(() => writeReflection("w", {}, "no pattern")).toThrow();
  });

  test("a V1 mirror document without front matter is readable", () => {
    const dir = join(tmp, "mirror");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-08-01-verify-callsites.md"), body("verify-callsites"));
    const items = listReflections("w", [dir]);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("2026-08-01-verify-callsites");
  });

  test("front matter split and section extraction", () => {
    const [meta, rest] = splitFrontMatter("---\nid: x\n---\nPattern: a\n\n## Reusable lesson\nL\n## Verification\nV\n");
    expect(meta["id"]).toBe("x");
    expect(section(rest, "## Reusable lesson")).toBe("L");
  });
});

describe("the reflection walk and symlinks", () => {
  test("a directory symlink is never followed, and nothing is counted twice", () => {
    writeReflection("w", { id: "2026-09-10-a-0001" }, body("a"));
    const dir = paths.reflectionsDir("w");

    // `reflections/sub/loop -> ..` re-enters the tree. Followed, the walk
    // recurses until the OS refuses and yields one reflection ~41 times, which
    // clears any promotion threshold on its own.
    mkdirSync(join(dir, "sub"), { recursive: true });
    symlinkSync("..", join(dir, "sub", "loop"), "dir");

    // A symlink to any directory ingests whatever markdown lives there.
    const foreign = join(tmp, "foreign");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "outside.md"), `---\nid: outside\nworld: w\ncreated: 2026-09-01\n---\n${body("a")}`);
    symlinkSync(foreign, join(dir, "elsewhere"), "dir");

    const items = listReflections("w");

    expect(items.map((r) => r.id)).toEqual(["2026-09-10-a-0001"]);
    expect(patternCounts("w")["a"]).toBe(1);
  });
});

describe("ledger", () => {
  test("V1 list shape and flat map shape both load", () => {
    const v1 = parseLedger(JSON.stringify([{ pattern: "a", status: "promoted", last_updated: "2026-01-01T00:00:00Z" }]));
    expect(v1.entries["a"]!.status).toBe("promoted");
    const flat = parseLedger(JSON.stringify({ b: { pattern: "b", last_updated: "2026-01-01T00:00:00Z" } }));
    expect(flat.entries["b"]!.status).toBe("staged");
  });

  test("the real V1 shape loads: entries is a list under version", () => {
    // Copied from the shape V1 actually wrote: `entries` is a LIST, not a map,
    // and an old row may predate `last_updated` entirely.
    const p = join(tmp, "promotions.json");
    writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        entries: [
          {
            pattern: "verify-callsites",
            promoted_at_count: 3,
            status: "promoted",
            artifact_type: "skill",
            last_updated: "2026-09-01T00:00:00Z",
          },
          { pattern: "enumerate-full-set", promoted_at_count: 5, status: "promoted", artifact_type: "rule" },
        ],
      }),
    );

    const ledger = loadLedger(p);

    expect(Object.keys(ledger.entries).sort()).toEqual(["enumerate-full-set", "verify-callsites"]);
    expect(ledger.entries["verify-callsites"]!.promoted_at_count).toBe(3);
    expect(ledger.entries["enumerate-full-set"]!.artifact_type).toBe("rule");
    // A row with no `last_updated` is dated now rather than rejected.
    expect(ledger.entries["enumerate-full-set"]!.last_updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("a corrupt ledger names the file", () => {
    const p = join(tmp, "promotions.json");
    writeFileSync(p, "{ not json");
    expect(() => loadLedger(p)).toThrow(/unreadable ledger .*promotions.json/);
  });

  test("save drops nulls and sorts keys", () => {
    const p = join(tmp, "l.json");
    const ledger = parseLedger(JSON.stringify({ b: { pattern: "b", last_updated: "t" }, a: { pattern: "a", last_updated: "t" } }));
    saveLedger(p, ledger);
    const text = readFileSync(p, "utf8");
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'));
    expect(text).not.toContain("null");
  });
});

describe("inbox and queue", () => {
  test("lessons list newest first and skip malformed files", () => {
    putLesson({ id: "l1", world: "w", pattern: "a", text: "one", created: "2026-01-01T00:00:00Z", reflection_id: null, repo: null, deliveries: 0 });
    putLesson({ id: "l2", world: "w", pattern: "a", text: "two", created: "2026-01-02T00:00:00Z", reflection_id: null, repo: null, deliveries: 0 });
    writeFileSync(join(paths.inboxDir("w"), "bad.json"), "{");
    expect(listLessons("w").map((l) => l.id)).toEqual(["l2", "l1"]);
  });

  test("queue entries move between buckets with a sanitised name", () => {
    const entry = { session_id: "../evil", transcript_path: "/t", cwd: "/c", world: "w", git_head: null, first_stop: "a", last_stop: "b", stops: 1, ended: false, tool_uses: 0, attempts: 0, result: null };
    const p = writeEntry("pending", entry);
    expect(p).toContain(join("queue", "pending", ".._evil.json"));
    moveEntry(entry, "pending", "done", "ok");
    expect(listQueue("pending")).toHaveLength(0);
    expect(listQueue("done")[0]!.result).toBe("ok");
  });
});
