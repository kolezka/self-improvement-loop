// The worker status lives in the loop-state database. A legacy
// worker-status.json is imported on the first read; a broken one, or one the
// import cannot reach yet, must fail the read, never look like "never ran".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AliasSemanticConfig, LlmConfig, paths, saveLlm, StateReadError, type Config } from "@sil/core";
import { closeState, openState, readDoc, saveDoc } from "@sil/statedb";
import { writeEntry } from "@sil/store";
import { runOnce, status } from "../src/index.ts";
import { restoreEnv, setSilDirs, writeSampleTranscript } from "../../transcript/test/fixture.ts";

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sil-worker-status-db-"));
  savedEnv = setSilDirs(tmpDir);
});

afterEach(() => {
  try {
    closeState();
  } finally {
    restoreEnv(savedEnv);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

const legacyFile = (): string => join(paths.stateDir(), "worker-status.json");

function seedLegacy(text: string): void {
  mkdirSync(paths.stateDir(), { recursive: true });
  writeFileSync(legacyFile(), text, "utf8");
}

function cfg(): Config {
  return {
    version: 1,
    worlds: [
      {
        name: "default",
        llm: "cloud",
        repos: [],
        target: null,
        layout: { skills_dir: "skills", nudges_dir: "nudges", agents_dir: "agents", rules_file: "RULES.md", ledger: "promotions.json" },
        remote: "none",
        rules_inject: true,
        outline: null,
        llm_config: null,
        claude_config_dir: null,
      } as Config["worlds"][number],
    ],
    promotion: { threshold: 3, per_run_cap: 3, max_rule_chars: 500, auto_merge: false, retire_after_days: 45, observe_min_sessions: 20, observe_max_days: 14, max_rewords: 2, escalate_ratio: 0.9 },
    worker: { idle_minutes: 10, curriculum_interval_minutes: 60, min_tool_uses: 99, auto_kick: true },
    web: { port: 8766, host: "127.0.0.1", allowed_hosts: [] },
    alias_semantic: AliasSemanticConfig.parse({}),
  };
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("worker status in the loop-state database", () => {
  test("runOnce writes the status row and no worker-status.json", async () => {
    saveLlm(LlmConfig.parse({ endpoints: [{ name: "test", base_url: "http://test" }], active: "test", models: { critic: "test-model" } }));
    const cwd = join(tmpDir, "sess-one");
    writeEntry("pending", {
      session_id: "sess-one",
      transcript_path: writeSampleTranscript(cwd, "sess-one"),
      cwd,
      world: "default",
      git_head: "abc123",
      first_stop: "2026-09-14T10:00:00Z",
      last_stop: "2026-09-14T10:05:00Z",
      stops: 1,
      ended: true,
      tool_uses: 0,
      attempts: 0,
      result: null,
    });

    const summary = await runOnce(cfg(), { reflect: true, curriculum: false, chat: async () => "{}" });
    expect(summary.skipped).toEqual(["sess-one"]);

    expect(existsSync(legacyFile())).toBe(false);
    const row = readDoc("worker_status", null, "strict");
    expect(typeof row?.["last_run"]).toBe("string");
    expect(status().last_run).toBe(row?.["last_run"] as string);
  });

  test("a legacy worker-status.json reads through status() and becomes a backup", () => {
    seedLegacy(JSON.stringify({ last_run: "2026-10-01T00:00:00.000Z", last_summary: null }));

    const s = status();
    expect(s.last_run).toBe("2026-10-01T00:00:00.000Z");
    expect(s.last_summary).toBeNull();
    expect(existsSync(legacyFile())).toBe(false);
    expect(readdirSync(paths.stateDir()).some((n) => n.startsWith("worker-status.json.imported-"))).toBe(true);
  });

  test("a legacy file that is not JSON makes status() throw, not read as never ran", () => {
    seedLegacy("{ not json");

    const error = caught(() => status());
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message).toContain("the worker status could not be imported");
  });

  test("a status row whose body is JSON null fails status(), not 'never ran'", () => {
    saveDoc("worker_status", null, { last_run: "2026-10-01T00:00:00.000Z", last_summary: null });
    expect(status().last_run).toBe("2026-10-01T00:00:00.000Z");
    closeState();
    const db = new Database(paths.loopStateDb());
    try {
      db.run("UPDATE docs SET body = 'null' WHERE name = 'worker_status'");
    } finally {
      db.close();
    }
    const error = caught(() => status());
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message).toContain("the worker status is not a JSON object");
  });

  test("a last_summary that is not a record fails status() with the labeled shape error", () => {
    saveDoc("worker_status", null, { last_run: "2026-10-01T00:00:00.000Z", last_summary: [] });
    const error = caught(() => status());
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message).toBe("the worker status has a last_summary that is not a record");
  });

  test(
    "busy: a cold handle under a write lock fails the status read with SQLITE_BUSY",
    () => {
      const lastRun = "2026-10-01T00:00:00.000Z";
      saveDoc("worker_status", null, { last_run: lastRun, last_summary: null });
      expect(status().last_run).toBe(lastRun);
      closeState();
      const raw = new Database(paths.loopStateDb());
      try {
        raw.run("BEGIN IMMEDIATE");
        const error = caught(() => status());
        expect(error).toBeInstanceOf(StateReadError);
        expect((error as Error).message).toContain("the worker status cannot be read");
        expect((error as Error).message).toContain("SQLITE_BUSY");
      } finally {
        if (raw.inTransaction) raw.run("ROLLBACK");
        raw.close();
      }
      expect(status().last_run).toBe(lastRun);
    },
    15_000,
  );

  test(
    "busy: a held write lock with a legacy file makes status() say it is being imported",
    () => {
      openState();
      seedLegacy(JSON.stringify({ last_run: "2026-10-01T00:00:00.000Z", last_summary: null }));
      const raw = new Database(paths.loopStateDb());
      try {
        raw.run("BEGIN IMMEDIATE");
        const error = caught(() => status());
        expect(error).toBeInstanceOf(StateReadError);
        expect((error as Error).message).toContain("the worker status is being imported");
      } finally {
        if (raw.inTransaction) raw.run("ROLLBACK");
        raw.close();
      }
    },
    15_000,
  );
});
