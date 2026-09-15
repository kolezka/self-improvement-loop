import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import * as paths from "@sil/core/paths";
import { maybeKickWorker, setSpawnLogForTests } from "../src/kick.ts";
import { DEFAULT_WORKER } from "../src/snapshot.ts";
import type { HookSnapshot } from "../src/snapshot.ts";
import { cleanupHookEnv, makeHookEnv } from "./helpers.ts";
import type { HookEnv } from "./helpers.ts";

let hookEnv: HookEnv;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  hookEnv = makeHookEnv();
  for (const key of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_PLUGIN_ROOT"]) {
    ORIGINAL_ENV[key] = process.env[key];
    process.env[key] = hookEnv.env[key];
  }
  setSpawnLogForTests(`${hookEnv.root}/spawn.log`);
});

afterEach(() => {
  setSpawnLogForTests(null);
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cleanupHookEnv(hookEnv);
});

function snapshot(overrides: Partial<HookSnapshot["worker"]> = {}): HookSnapshot {
  return {
    version: 1,
    worlds: [{ name: "default", repos: [], nudges_dir: "", rules_file: "", rules_inject: false }],
    worker: { ...DEFAULT_WORKER, ...overrides },
    plugin_root: hookEnv.pluginRoot,
  };
}

function spawnLogLines(): string[] {
  try {
    return readFileSync(`${hookEnv.root}/spawn.log`, "utf8").trim().split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function writeSnapshotFile(): void {
  mkdirSync(paths.stateDir(), { recursive: true });
  writeFileSync(paths.hookSnapshotFile(), JSON.stringify(snapshot()));
}

describe("maybeKickWorker", () => {
  test("does nothing when the snapshot file does not exist", () => {
    // No writeSnapshotFile() call: it genuinely does not exist.
    maybeKickWorker(snapshot());
    expect(spawnLogLines().length).toBe(0);
  });

  test("does nothing when auto_kick is false", () => {
    writeSnapshotFile();
    maybeKickWorker(snapshot({ auto_kick: false }));
    expect(spawnLogLines().length).toBe(0);
  });

  test("blocked when the lock file names a live pid", () => {
    writeSnapshotFile();
    writeFileSync(paths.workerLockFile(), String(process.pid));
    maybeKickWorker(snapshot());
    expect(spawnLogLines().length).toBe(0);
  });

  test("not blocked by a stale lock file naming a dead pid", () => {
    writeSnapshotFile();
    // A pid far above any realistic pid_max: reliably not a live process.
    writeFileSync(paths.workerLockFile(), "4194303");
    mkdirSync(paths.queueDir("pending"), { recursive: true });
    writeFileSync(`${paths.queueDir("pending")}/some-session.json`, "{}");
    maybeKickWorker(snapshot());
    expect(spawnLogLines().length).toBe(1);
  });

  test("throttled by a recent last-kick touch", () => {
    writeSnapshotFile();
    writeFileSync(`${paths.stateDir()}/last-kick`, "");
    mkdirSync(paths.queueDir("pending"), { recursive: true });
    writeFileSync(`${paths.queueDir("pending")}/some-session.json`, "{}");
    maybeKickWorker(snapshot());
    expect(spawnLogLines().length).toBe(0);
  });

  test("skipped when nothing is pending and the curriculum marker is current", () => {
    writeSnapshotFile();
    writeFileSync(`${paths.stateDir()}/last-curriculum-default`, "");
    maybeKickWorker(snapshot());
    expect(spawnLogLines().length).toBe(0);
  });

  test("fires when the pending queue is non-empty", () => {
    writeSnapshotFile();
    writeFileSync(`${paths.stateDir()}/last-curriculum-default`, "");
    mkdirSync(paths.queueDir("pending"), { recursive: true });
    writeFileSync(`${paths.queueDir("pending")}/some-session.json`, "{}");
    maybeKickWorker(snapshot());
    expect(spawnLogLines().length).toBe(1);
  });

  test("fires when the curriculum marker is missing entirely", () => {
    writeSnapshotFile();
    // No last-curriculum-default marker at all, and no pending queue.
    maybeKickWorker(snapshot());
    expect(spawnLogLines().length).toBe(1);
  });

  test("fires when the curriculum marker is older than the interval", () => {
    writeSnapshotFile();
    const marker = `${paths.stateDir()}/last-curriculum-default`;
    writeFileSync(marker, "");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(marker, old, old);
    maybeKickWorker(snapshot({ curriculum_interval_minutes: 60 }));
    expect(spawnLogLines().length).toBe(1);
  });
});
