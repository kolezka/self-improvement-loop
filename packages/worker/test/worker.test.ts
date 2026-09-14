import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { fsx, paths, ProviderError, saveLlm, type Config, type QueueEntry, type World } from "@sil/core";
import { listQueue, loadEntry, writeEntry } from "@sil/store";
import {
  eligible,
  Lock,
  MAX_ATTEMPTS,
  moveToTerminal,
  pruneQueueBucket,
  reapStaleSessionDirs,
  runOnce,
} from "../src/index.ts";
import { setSilDirs, restoreEnv, writeSampleTranscript } from "../../transcript/test/fixture.ts";

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sil-worker-"));
  savedEnv = setSilDirs(tmpDir);
});

afterEach(() => {
  restoreEnv(savedEnv);
  rmSync(tmpDir, { recursive: true, force: true });
});

function prepareEnv(): void {
  saveLlm({ endpoints: [], active: null, local_models: [], models: { critic: "test-model" } });
}

function writePending(
  sessionId: string,
  opts: { ended: boolean; transcriptOk?: boolean; toolUses?: number; world?: string },
): QueueEntry {
  const cwd = join(tmpDir, sessionId);
  const transcriptOk = opts.transcriptOk ?? true;
  const transcriptPath = transcriptOk ? writeSampleTranscript(cwd, sessionId) : join(cwd, "missing.jsonl");
  const entry: QueueEntry = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    world: opts.world ?? "default",
    git_head: "abc123",
    first_stop: "2026-09-14T10:00:00Z",
    last_stop: "2026-09-14T10:05:00Z",
    stops: 1,
    ended: opts.ended,
    tool_uses: opts.toolUses ?? 5,
    attempts: 0,
    result: null,
  };
  writeEntry("pending", entry);
  return entry;
}

function goodAnswer(): string {
  return JSON.stringify({
    record: true,
    pattern: "some-lesson",
    what_worked: "ok",
    what_failed: "n/a",
    lesson: "do the thing",
    verification: "ran it",
    not_verified: [],
    lesson_short: null,
    confidence: 0.9,
    artifacts_used: [],
    artifacts_helpful: [],
    artifacts_misfired: [],
    rules_relevant: [],
  });
}

async function goodChat(): Promise<string> {
  return goodAnswer();
}

function world(name = "default"): World {
  return {
    name,
    llm: "cloud",
    repos: [],
    target: null,
    layout: { skills_dir: "skills", nudges_dir: "nudges", agents_dir: "agents", rules_file: "RULES.md", ledger: "promotions.json" },
    remote: "none",
    rules_inject: true,
    outline: null,
    llm_config: null,
  };
}

function cfg(opts: { idleMinutes?: number; minToolUses?: number } = {}): Config {
  return {
    version: 1,
    worlds: [world()],
    promotion: { threshold: 3, per_run_cap: 3, auto_merge: false, retire_after_days: 45 },
    worker: { idle_minutes: opts.idleMinutes ?? 10, curriculum_interval_minutes: 60, min_tool_uses: opts.minToolUses ?? 1, auto_kick: true },
    web: { port: 8766 },
  };
}

// --- run_once: eligible entry ------------------------------------------------

describe("runOnce eligible entry", () => {
  test("moves an eligible entry to done", async () => {
    prepareEnv();
    writePending("sess-good", { ended: true });

    const summary = await runOnce(cfg(), { reflect: true, curriculum: false, chat: goodChat });

    expect(summary.reflected).toEqual(["sess-good"]);
    expect(summary.failed).toEqual([]);
    expect(loadEntry("pending", "sess-good")).toBeNull();
    const done = loadEntry("done", "sess-good");
    expect(done).not.toBeNull();
    expect(done!.result?.startsWith("recorded:")).toBe(true);
  });
});

describe("runOnce non-idle non-ended entry", () => {
  test("leaves the entry pending and its session dir intact", async () => {
    prepareEnv();
    writePending("sess-fresh", { ended: false });
    const sessionDir = paths.sessionDir("sess-fresh");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "start.json"), "{}", "utf8");

    const summary = await runOnce(cfg(), { reflect: true, curriculum: false, chat: goodChat });

    expect(summary.skipped).toEqual(["sess-fresh"]);
    expect(summary.reflected).toEqual([]);
    expect(loadEntry("pending", "sess-fresh")).not.toBeNull();
    expect(existsSync(sessionDir)).toBe(true);
  });
});

describe("runOnce missing transcript", () => {
  test("moves the entry to failed", async () => {
    prepareEnv();
    writePending("sess-no-transcript", { ended: true, transcriptOk: false });

    const summary = await runOnce(cfg(), { reflect: true, curriculum: false, chat: goodChat });

    expect(summary.failed).toEqual(["sess-no-transcript"]);
    expect(loadEntry("pending", "sess-no-transcript")).toBeNull();
    const failed = loadEntry("failed", "sess-no-transcript");
    expect(failed).not.toBeNull();
    expect(failed!.result).toContain("transcript missing");
  });
});

describe("runOnce lock held", () => {
  test("returns a locked summary and leaves the entry untouched", async () => {
    prepareEnv();
    writePending("sess-locked", { ended: true });

    const lock = new Lock();
    lock.acquire();
    try {
      const summary = await runOnce(cfg(), { reflect: true, curriculum: false, chat: goodChat });
      expect(summary.locked).toBe(true);
      expect(summary.reflected).toEqual([]);
      expect(summary.failed).toEqual([]);
    } finally {
      lock.release();
    }
    expect(loadEntry("pending", "sess-locked")).not.toBeNull();
  });
});

describe("runOnce survives a chat exception", () => {
  test("fails the bad session and reflects the good one", async () => {
    prepareEnv();
    writePending("sess-bad", { ended: true });
    writePending("sess-good", { ended: true });

    const flakyChat = async (_role: string, messages: unknown): Promise<string> => {
      const content = JSON.stringify(messages);
      if (content.includes("sess-bad")) throw new Error("boom");
      return goodAnswer();
    };

    const summary = await runOnce(cfg(), { reflect: true, curriculum: false, chat: flakyChat });

    expect(summary.failed).toContain("sess-bad");
    expect(summary.reflected).toContain("sess-good");
    const failed = loadEntry("failed", "sess-bad");
    expect(failed).not.toBeNull();
    expect(failed!.result).toContain("boom");
    expect(loadEntry("done", "sess-good")).not.toBeNull();
  });
});

// --- eligible() ----------------------------------------------------------------

describe("eligible", () => {
  test("true for an ended entry with enough tool uses", () => {
    prepareEnv();
    const entry = writePending("sess-e", { ended: true, toolUses: 3 });
    const [ok, reason] = eligible(entry, cfg(), new Date());
    expect(ok).toBe(true);
    expect(reason).toBe("eligible");
  });

  test("false below min_tool_uses", () => {
    prepareEnv();
    const entry = writePending("sess-e2", { ended: true, toolUses: 0 });
    const [ok, reason] = eligible(entry, cfg({ minToolUses: 99 }), new Date());
    expect(ok).toBe(false);
    expect(reason).toBe("below min_tool_uses");
  });

  test("true when the transcript has been idle long enough", () => {
    prepareEnv();
    const entry = writePending("sess-e3", { ended: false, toolUses: 3 });
    const future = new Date(Date.now() + 20 * 60_000);
    const [ok] = eligible(entry, cfg({ idleMinutes: 10, minToolUses: 1 }), future);
    expect(ok).toBe(true);
  });
});

// --- Lock ------------------------------------------------------------------------

describe("Lock", () => {
  test("reclaims a lock whose recorded pid is dead", () => {
    prepareEnv();
    const lockPath = paths.workerLockFile();
    fsx.ensureDir(join(lockPath, ".."));
    writeFileSync(lockPath, "999999999", "utf8"); // a pid that cannot exist

    const lock = new Lock();
    expect(() => lock.acquire()).not.toThrow();
    lock.release();
  });
});

// --- session dir reaping -----------------------------------------------------

describe("moveToTerminal", () => {
  test.each(["done", "failed"] as const)("reaps the session dir on move to %s", (toBucket) => {
    prepareEnv();
    const entry = writePending("sess-close", { ended: true });
    const sessionDir = paths.sessionDir(entry.session_id);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "start.json"), "{}", "utf8");

    moveToTerminal(entry, toBucket, "done");

    expect(existsSync(sessionDir)).toBe(false);
  });
});

describe("reapStaleSessionDirs", () => {
  test("removes only dirs older than the cutoff", () => {
    prepareEnv();
    const oldDir = paths.sessionDir("sess-old");
    const freshDir = paths.sessionDir("sess-fresh");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(freshDir, { recursive: true });

    const oldTime = (Date.now() - 8 * 86_400_000) / 1000;
    utimesSync(oldDir, oldTime, oldTime);

    const removed = reapStaleSessionDirs(new Date());

    expect(removed).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
  });
});

// --- lock file left empty and free --------------------------------------------

describe("runOnce lock file", () => {
  test("leaves the lock file empty and free", async () => {
    prepareEnv();
    writePending("sess-good", { ended: true });

    await runOnce(cfg(), { reflect: true, curriculum: false, chat: goodChat });

    expect(readFileSync(paths.workerLockFile(), "utf8")).toBe("");
    expect(Lock.held()).toBe(false);
  });
});

// --- prune queue bucket --------------------------------------------------------

describe("pruneQueueBucket", () => {
  test("keeps the newest entries", () => {
    prepareEnv();
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 5; i++) {
      const ts = new Date(base + i * 1000).toISOString().replace(/\.\d+Z$/, "Z");
      const entry: QueueEntry = {
        session_id: `sess-${i}`,
        transcript_path: join(tmpDir, `sess-${i}`, "transcript.jsonl"),
        cwd: join(tmpDir, `sess-${i}`),
        world: "default",
        git_head: null,
        first_stop: ts,
        last_stop: ts,
        stops: 1,
        ended: false,
        tool_uses: 0,
        attempts: 0,
        result: null,
      };
      writeEntry("done", entry);
    }

    const removed = pruneQueueBucket("done", 3);

    expect(removed).toBe(2);
    const remaining = new Set(listQueue("done").map((e) => e.session_id));
    expect(remaining).toEqual(new Set(["sess-2", "sess-3", "sess-4"]));
  });
});

// --- transient provider failure keeps the session queued ----------------------

describe("transient provider failure", () => {
  test("keeps the session queued up to MAX_ATTEMPTS then fails it", async () => {
    // No saveLlm here: the critic must fail to resolve the model role before
    // even reaching chat, and that ModelNotConfigured (a ConfigError) must
    // retry the same as a ProviderError from the chat call itself.
    const entryCfg = cfg({ minToolUses: 0 });
    const transcript = writeSampleTranscript(tmpDir);
    const entry: QueueEntry = {
      session_id: "s-retry",
      transcript_path: transcript,
      cwd: tmpDir,
      world: "default",
      git_head: null,
      first_stop: "2026-09-14T00:00:00Z",
      last_stop: "2026-09-14T00:00:00Z",
      stops: 1,
      ended: true,
      tool_uses: 9,
      attempts: 0,
      result: null,
    };
    writeEntry("pending", entry);

    const down = async (): Promise<string> => {
      throw new ProviderError("provider unreachable");
    };

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const summary = await runOnce(entryCfg, { curriculum: false, chat: down });
      expect(summary.skipped).toEqual(["s-retry"]);
      expect(summary.failed).toEqual([]);
      const again = loadEntry("pending", "s-retry");
      expect(again).not.toBeNull();
      expect(again!.attempts).toBe(attempt);
      expect((again!.result ?? "").startsWith("failed:")).toBe(true);
    }

    const summary = await runOnce(entryCfg, { curriculum: false, chat: down });
    expect(summary.failed).toEqual(["s-retry"]);
    expect(loadEntry("pending", "s-retry")).toBeNull();
    expect(loadEntry("failed", "s-retry")).not.toBeNull();
  });
});
