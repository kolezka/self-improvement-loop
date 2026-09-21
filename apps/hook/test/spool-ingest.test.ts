// ingestSpool: the Stop/SessionEnd side of the module handshake. In-process
// cases exercise every target kind and the refusal paths directly; the last
// case runs a real Stop subprocess to prove the wiring in handlers.ts.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as paths from "@sil/core/paths";
import { readJsonl } from "@sil/core/fsx";
import { serializeSpool, SPOOL_FILE_NAME, SPOOL_VERSION } from "@sil/core/spool";
import type { Spool } from "@sil/core/spool";
import { ingestSpool, ORPHAN_SPOOL_OLDER_THAN_MS, sweepOrphanSpools } from "../src/spool-ingest.ts";
import { cleanupHookEnv, makeHookEnv, runHook } from "./helpers.ts";
import type { HookEnv } from "./helpers.ts";

const MAIN_TS = new URL("../src/main.ts", import.meta.url).pathname;

let hookEnv: HookEnv;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  hookEnv = makeHookEnv();
  for (const key of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_PLUGIN_ROOT"]) {
    ORIGINAL_ENV[key] = process.env[key];
    process.env[key] = hookEnv.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cleanupHookEnv(hookEnv);
});

function spoolFile(sessionId: string): string {
  return `${paths.sessionDir(sessionId)}/${SPOOL_FILE_NAME}`;
}

function writeSpool(sessionId: string, overrides: Partial<Spool> = {}): string {
  const spool: Spool = {
    version: SPOOL_VERSION,
    session_id: sessionId,
    written_at: "2026-09-21T00:00:00.000Z",
    appends: [],
    moves: [],
    ...overrides,
  };
  const dir = paths.sessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  const file = spoolFile(sessionId);
  writeFileSync(file, serializeSpool(spool));
  return file;
}

describe("ingestSpool", () => {
  test("absent spool is a no-op, no log", () => {
    const result = ingestSpool("sess-absent");
    expect(result).toEqual({ appends: 0, moves: 0, skipped: 0 });
  });

  test("one entry of every target kind lands in the right file", () => {
    const sessionId = "sess-full";
    writeSpool(sessionId, {
      appends: [
        { target: { kind: "usage-events" }, line: JSON.stringify({ ts: "x", kind: "skill", ref: "skill:foo" }) },
        { target: { kind: "hook-runs" }, line: JSON.stringify({ ts: "x", kind: "hook_run", ref: "hook:bar" }) },
        { target: { kind: "nudge-fires" }, line: JSON.stringify({ ts: "x", session_id: sessionId, event: "PreToolUse" }) },
        { target: { kind: "payload-samples", world: "default" }, line: JSON.stringify({ ts: "x", tool_name: "Bash" }) },
        { target: { kind: "session-file", name: "module-note.json" }, line: JSON.stringify({ hello: "world" }) },
      ],
    });

    const result = ingestSpool(sessionId);
    expect(result).toEqual({ appends: 5, moves: 0, skipped: 0 });

    expect(readJsonl(paths.usageEventsFile())).toEqual([{ ts: "x", kind: "skill", ref: "skill:foo" }]);
    expect(readJsonl(paths.hookRunsFile())).toEqual([{ ts: "x", kind: "hook_run", ref: "hook:bar" }]);
    expect(readJsonl(paths.nudgeFiresFile())).toEqual([{ ts: "x", session_id: sessionId, event: "PreToolUse" }]);
    expect(readJsonl(paths.payloadSamplesFile("default"))).toEqual([{ ts: "x", tool_name: "Bash" }]);
    expect(readFileSync(`${paths.sessionDir(sessionId)}/module-note.json`, "utf8")).toBe(`${JSON.stringify({ hello: "world" })}\n`);

    expect(existsSync(spoolFile(sessionId))).toBe(false);
  });

  test("a move outside the state dir is refused", () => {
    const sessionId = "sess-move-outside";
    const insideSource = `${paths.stateDir()}/inbox/default/x.json`;
    mkdirSync(`${paths.stateDir()}/inbox/default`, { recursive: true });
    writeFileSync(insideSource, "{}");
    const outsideDest = join(tmpdir(), `spool-escape-${Date.now()}.json`);

    writeSpool(sessionId, { moves: [{ from: insideSource, to: outsideDest }] });
    const result = ingestSpool(sessionId);

    expect(result).toEqual({ appends: 0, moves: 0, skipped: 1 });
    expect(existsSync(insideSource)).toBe(true);
    expect(existsSync(outsideDest)).toBe(false);
  });

  test("a legitimate move inside the state dir is applied", () => {
    const sessionId = "sess-move-inside";
    const from = `${paths.stateDir()}/inbox/default/y.json`;
    const to = `${paths.stateDir()}/inbox/default/archive/y.json`;
    mkdirSync(`${paths.stateDir()}/inbox/default`, { recursive: true });
    writeFileSync(from, '{"lesson":"y"}');

    writeSpool(sessionId, { moves: [{ from, to }] });
    const result = ingestSpool(sessionId);

    expect(result).toEqual({ appends: 0, moves: 1, skipped: 0 });
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(to, "utf8")).toBe('{"lesson":"y"}');
  });

  test("a missing move source is skipped without being counted", () => {
    const sessionId = "sess-move-missing";
    const from = `${paths.stateDir()}/inbox/default/never-written.json`;
    const to = `${paths.stateDir()}/inbox/default/archive/never-written.json`;

    writeSpool(sessionId, { moves: [{ from, to }] });
    const result = ingestSpool(sessionId);

    expect(result).toEqual({ appends: 0, moves: 0, skipped: 0 });
  });

  test("a session file name with a separator is refused", () => {
    const sessionId = "sess-unsafe-name";
    writeSpool(sessionId, {
      appends: [{ target: { kind: "session-file", name: "../escape.json" }, line: "{}" }],
    });

    const result = ingestSpool(sessionId);
    expect(result).toEqual({ appends: 0, moves: 0, skipped: 1 });
    expect(existsSync(`${paths.sessionDir(sessionId)}/../escape.json`)).toBe(false);
  });

  test("corrupt JSON deletes the spool and is counted skipped", () => {
    const sessionId = "sess-corrupt";
    const dir = paths.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(spoolFile(sessionId), "not valid json{{{");

    const result = ingestSpool(sessionId);
    expect(result).toEqual({ appends: 0, moves: 0, skipped: 1 });
    expect(existsSync(spoolFile(sessionId))).toBe(false);
  });

  test("mismatched session_id skips everything and deletes the spool", () => {
    const sessionId = "sess-mismatch";
    writeSpool(sessionId, {
      session_id: "some-other-session",
      appends: [{ target: { kind: "usage-events" }, line: JSON.stringify({ kind: "skill" }) }],
    });

    const result = ingestSpool(sessionId);
    expect(result).toEqual({ appends: 0, moves: 0, skipped: 1 });
    expect(existsSync(spoolFile(sessionId))).toBe(false);
    expect(existsSync(paths.usageEventsFile())).toBe(false);
  });

  test("calling twice is a no-op the second time", () => {
    const sessionId = "sess-twice";
    writeSpool(sessionId, {
      appends: [{ target: { kind: "usage-events" }, line: JSON.stringify({ kind: "skill" }) }],
    });

    const first = ingestSpool(sessionId);
    expect(first).toEqual({ appends: 1, moves: 0, skipped: 0 });

    const second = ingestSpool(sessionId);
    expect(second).toEqual({ appends: 0, moves: 0, skipped: 0 });
    expect(readJsonl(paths.usageEventsFile()).length).toBe(1);
  });

  test("a blocked payload-samples or session-file write never throws, and is counted skipped", () => {
    const sessionId = "sess-eexist";
    // Blocks ensureDir(dirname(payloadSamplesFile)): "payloads" exists as a
    // plain file, so mkdirSync(..., { recursive: true }) throws EEXIST.
    mkdirSync(`${paths.stateDir()}/usage`, { recursive: true });
    writeFileSync(`${paths.stateDir()}/usage/payloads`, "blocker");
    // Blocks appendFileSync on the session file itself: a directory sits
    // where plainAppend expects to write a file, so it throws EISDIR.
    const sessionFileTarget = `${paths.sessionDir(sessionId)}/module-note.json`;
    mkdirSync(sessionFileTarget, { recursive: true });

    writeSpool(sessionId, {
      appends: [
        { target: { kind: "usage-events" }, line: JSON.stringify({ kind: "skill" }) },
        { target: { kind: "payload-samples", world: "default" }, line: JSON.stringify({ ts: "x" }) },
        { target: { kind: "session-file", name: "module-note.json" }, line: JSON.stringify({ hello: "world" }) },
      ],
    });

    let result: { appends: number; moves: number; skipped: number } | undefined;
    expect(() => {
      result = ingestSpool(sessionId);
    }).not.toThrow();
    expect(result).toEqual({ appends: 1, moves: 0, skipped: 2 });
    // The spool is deleted regardless, so a standing failure never retries
    // the lines that did succeed and never leaks the spool forever.
    expect(existsSync(spoolFile(sessionId))).toBe(false);

    const second = ingestSpool(sessionId);
    expect(second).toEqual({ appends: 0, moves: 0, skipped: 0 });
    expect(readJsonl(paths.usageEventsFile()).length).toBe(1);
  });

  test("50 nudge-fires appends become one locked write, not one per line", () => {
    const sessionId = "sess-batch";
    const appends = Array.from({ length: 50 }, (_, i) => ({
      target: { kind: "nudge-fires" as const },
      line: JSON.stringify({ ts: "x", session_id: sessionId, event: "PreToolUse", pattern: `p-${i}` }),
    }));
    writeSpool(sessionId, { appends });

    const mkdirSpy = spyOn(nodeFs, "mkdirSync");
    const result = ingestSpool(sessionId);
    // Every withDirLock acquisition mkdirs a "<file>.lockdir" directory;
    // counting those (not all mkdirSync calls) isolates lock acquisitions
    // from unrelated ensureDir calls.
    const lockAttempts = mkdirSpy.mock.calls.filter((call) => String(call[0]).endsWith(".lockdir")).length;
    mkdirSpy.mockRestore();

    expect(result).toEqual({ appends: 50, moves: 0, skipped: 0 });
    const lines = readFileSync(paths.nudgeFiresFile(), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(50);
    // No contention in this test, so one grouped write acquires the lock
    // exactly once; the pre-fix code acquired it once per line (50 times).
    expect(lockAttempts).toBe(1);
  });
});

describe("sweepOrphanSpools", () => {
  function backdateSpool(sessionId: string, ageMs: number): void {
    const file = spoolFile(sessionId);
    const past = new Date(Date.now() - ageMs);
    utimesSync(file, past, past);
  }

  test("orphan spools older than the cutoff are applied and removed; a fresh one is left", () => {
    const stale1 = "sess-orphan-1";
    const stale2 = "sess-orphan-2";
    const fresh = "sess-orphan-fresh";

    for (const id of [stale1, stale2, fresh]) {
      writeSpool(id, { appends: [{ target: { kind: "usage-events" }, line: JSON.stringify({ kind: "skill", ref: id }) }] });
    }
    backdateSpool(stale1, ORPHAN_SPOOL_OLDER_THAN_MS + 60_000);
    backdateSpool(stale2, ORPHAN_SPOOL_OLDER_THAN_MS + 60_000);
    // fresh keeps its just-written mtime.

    const result = sweepOrphanSpools({ olderThanMs: ORPHAN_SPOOL_OLDER_THAN_MS, limit: 5 });

    expect(result).toEqual({ swept: 2 });
    expect(existsSync(spoolFile(stale1))).toBe(false);
    expect(existsSync(spoolFile(stale2))).toBe(false);
    expect(existsSync(spoolFile(fresh))).toBe(true);

    const events = readJsonl(paths.usageEventsFile());
    expect(events.map((e) => e["ref"]).sort()).toEqual([stale1, stale2].sort());
  });

  test("a session whose lock is held by a live process is skipped", () => {
    const sessionId = "sess-orphan-locked";
    writeSpool(sessionId, { appends: [{ target: { kind: "usage-events" }, line: JSON.stringify({ kind: "skill" }) }] });
    backdateSpool(sessionId, ORPHAN_SPOOL_OLDER_THAN_MS + 60_000);

    // Simulate another process holding this session's lock: a lock dir whose
    // pid file names this test's own (alive) process.
    const lockDir = `${paths.sessionDir(sessionId)}/lock.lockdir`;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(`${lockDir}/pid`, `${process.pid}\n`, "utf8");

    const result = sweepOrphanSpools({ olderThanMs: ORPHAN_SPOOL_OLDER_THAN_MS, limit: 5 });

    expect(result).toEqual({ swept: 0 });
    expect(existsSync(spoolFile(sessionId))).toBe(true);
  });

  test("respects the limit, leaving the rest for the next sweep", () => {
    const ids = ["sess-limit-1", "sess-limit-2", "sess-limit-3"];
    for (const id of ids) {
      writeSpool(id, { appends: [{ target: { kind: "usage-events" }, line: JSON.stringify({ kind: "skill" }) }] });
      backdateSpool(id, ORPHAN_SPOOL_OLDER_THAN_MS + 60_000);
    }

    const result = sweepOrphanSpools({ olderThanMs: ORPHAN_SPOOL_OLDER_THAN_MS, limit: 2 });

    expect(result.swept).toBe(2);
    const remaining = ids.filter((id) => existsSync(spoolFile(id)));
    expect(remaining.length).toBe(1);
  });
});

describe("ingestSpool through a real Stop event", () => {
  test("a spool written before Stop is ingested and deleted", () => {
    const sessionId = "sess-stop-spool";
    mkdirSync(paths.stateDir(), { recursive: true });
    writeFileSync(
      paths.hookSnapshotFile(),
      JSON.stringify({
        version: 1,
        worlds: [{ name: "default", repos: [], nudges_dir: "", rules_file: "", rules_inject: false }],
        worker: { idle_minutes: 10, curriculum_interval_minutes: 60, min_tool_uses: 6, auto_kick: false },
        plugin_root: hookEnv.pluginRoot,
      }),
    );
    writeSpool(sessionId, {
      appends: [{ target: { kind: "usage-events" }, line: JSON.stringify({ kind: "skill", ref: "skill:from-module" }) }],
    });

    const payload = { session_id: sessionId, hook_event_name: "Stop", stop_hook_active: false, cwd: hookEnv.root };
    const result = runHook(MAIN_TS, hookEnv, payload);
    expect(result.exitCode).toBe(0);

    expect(existsSync(spoolFile(sessionId))).toBe(false);
    expect(readJsonl(paths.usageEventsFile())).toEqual([{ kind: "skill", ref: "skill:from-module" }]);
  });
});
