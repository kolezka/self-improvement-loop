import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ledgerPath, loadConfig, paths, type PromotionEntry, targetRoot } from "@sil/core";
import { git } from "@sil/curriculum";
import { loadLedger, saveLedger } from "@sil/store";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-curriculum-"));
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

describe("sil curriculum run --apply", () => {
  test("refuses to run while the worker lock is held by a live pid", async () => {
    const initCode = await run(["init"]);
    expect(initCode).toBe(0);

    const lockPath = paths.workerLockFile();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, String(process.pid), "utf8");

    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await run(["curriculum", "run", "--apply", "--world", "default"]);
    } finally {
      console.error = origErr;
    }

    expect(code).toBe(2);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("worker lock held");
    expect(errs[0]).not.toContain("at ");
  });

  test("without --apply does not touch the lock and succeeds", async () => {
    const initCode = await run(["init"]);
    expect(initCode).toBe(0);

    const lockPath = paths.workerLockFile();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, String(process.pid), "utf8");

    const code = await run(["curriculum", "run", "--world", "default"]);
    expect(code).toBe(0);
  });
});

describe("sil curriculum repair-promoted-at", () => {
  test("dry run against an empty ledger reports nothing to repair and writes nothing", async () => {
    expect(await run(["init"])).toBe(0);

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await run(["curriculum", "repair-promoted-at", "--world", "default"]);
    } finally {
      console.log = orig;
    }

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("nothing to repair");
  });

  test("--apply against an empty ledger commits nothing", async () => {
    expect(await run(["init"])).toBe(0);
    const code = await run(["curriculum", "repair-promoted-at", "--apply", "--world", "default"]);
    expect(code).toBe(0);
  });

  test("--apply against a damaged history repairs promoted_at, revised_at and revisions, and commits the fix", async () => {
    expect(await run(["init"])).toBe(0);

    const cfg = loadConfig();
    const world = cfg.worlds.find((w) => w.name === "default")!;
    const repo = targetRoot(world);
    const rel = "promotions.json";
    const skillRel = "skills/p/SKILL.md";

    const row = (overrides: Partial<PromotionEntry> & { pattern: string }): PromotionEntry => ({
      promoted_at_count: 3,
      rejected_at_count: 0,
      status: "staged",
      artifact_type: "skill",
      served_by: { type: "skill", path: skillRel },
      last_updated: "2026-01-01T00:00:00.000Z",
      promoted_at: null,
      revised_at: null,
      revisions: 0,
      commit: null,
      feedback: null,
      ...overrides,
    });

    const commit = (entries: Record<string, PromotionEntry>, content: string, message: string): void => {
      saveLedger(ledgerPath(world), { version: 1, entries });
      mkdirSync(dirname(join(repo, skillRel)), { recursive: true });
      writeFileSync(join(repo, skillRel), content, "utf8");
      git.git(repo, ["add", "--", rel, skillRel]);
      git.git(repo, ["commit", "-q", "-m", message]);
    };

    commit(
      { p: row({ pattern: "p", status: "promoted", promoted_at: "2026-01-01T00:00:00.000Z", revised_at: "2026-01-01T00:00:00.000Z" }) },
      "v1",
      "feat(skill): promote p (reviewed)",
    );
    // The bug the accept fix (elsewhere in this branch) no longer commits:
    // an accepted redraft reset promoted_at to that commit's own date.
    commit(
      { p: row({ pattern: "p", status: "promoted", promoted_at: "2026-01-10T00:00:00.000Z", revised_at: "2026-01-10T00:00:00.000Z" }) },
      "v2",
      "feat(skill): p (reviewed)",
    );

    const code = await run(["curriculum", "repair-promoted-at", "--apply", "--world", "default"]);
    expect(code).toBe(0);

    const after = loadLedger(ledgerPath(world)).entries["p"]!;
    expect(after.promoted_at).toBe("2026-01-01T00:00:00.000Z");
    expect(after.revised_at).toBe("2026-01-10T00:00:00.000Z");
    expect(after.revisions).toBe(1);
    expect(git.git(repo, ["log", "-1", "--format=%s"])).toBe("chore(ledger): repair promoted_at from history");
  });
});
