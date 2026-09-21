import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { AliasSemanticConfig, fsx, LlmConfig, LockHeld, paths, ProviderError, saveLlm, type Config, type QueueEntry, type World } from "@sil/core";
import { listQueue, loadEntry, writeEntry } from "@sil/store";
import { countToolUses } from "@sil/transcript";
import {
  ABANDONED_AFTER_DAYS,
  eligible,
  Lock,
  MAX_ATTEMPTS,
  moveToTerminal,
  pruneQueueBucket,
  reapStaleSessionDirs,
  runOnce,
  STATUS_SUMMARY_IDS,
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
  saveLlm(LlmConfig.parse({ endpoints: [{ name: "test", base_url: "http://test" }], active: "test", models: { critic: "test-model" } }));
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
    promotion: { threshold: 3, per_run_cap: 3, max_rule_chars: 500, auto_merge: false, retire_after_days: 45 },
    worker: { idle_minutes: opts.idleMinutes ?? 10, curriculum_interval_minutes: 60, min_tool_uses: opts.minToolUses ?? 1, auto_kick: true },
    web: { port: 8766, host: "127.0.0.1", allowed_hosts: [] },
    alias_semantic: AliasSemanticConfig.parse({}),
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
  // A session whose transcript is not on disk carries nothing to reflect on,
  // and that is not an error of the loop: `claude --print
  // --no-session-persistence` (what tools like jean use for their helper runs)
  // never writes one. Such an entry leaves the queue as skipped, so `failed`
  // keeps meaning "reflection was attempted and broke".
  test("retires the entry as skipped, not failed", async () => {
    prepareEnv();
    writePending("sess-no-transcript", { ended: true, transcriptOk: false });

    const summary = await runOnce(cfg(), { reflect: true, curriculum: false, chat: goodChat });

    expect(summary.failed).toEqual([]);
    expect(summary.skipped).toEqual(["sess-no-transcript"]);
    expect(loadEntry("pending", "sess-no-transcript")).toBeNull();
    expect(loadEntry("failed", "sess-no-transcript")).toBeNull();
    const done = loadEntry("done", "sess-no-transcript");
    expect(done).not.toBeNull();
    expect(done!.result).toContain("not persisted");
  });
});

describe("runOnce entry below min_tool_uses", () => {
  // The entry used to stay pending for ever: `eligible` returned a soft
  // "below min_tool_uses", so every run re-read the transcript and the queue
  // never drained (482 of 487 pending entries were in this state).
  test("retires an ended entry to done and reaps its session dir", async () => {
    prepareEnv();
    writePending("sess-tiny", { ended: true, toolUses: 0 });
    const sessionDir = paths.sessionDir("sess-tiny");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "start.json"), "{}", "utf8");

    const summary = await runOnce(cfg({ minToolUses: 99 }), { reflect: true, curriculum: false, chat: goodChat });

    expect(summary.skipped).toEqual(["sess-tiny"]);
    expect(loadEntry("pending", "sess-tiny")).toBeNull();
    const done = loadEntry("done", "sess-tiny");
    expect(done).not.toBeNull();
    expect(done!.result).toBe("skipped: below min_tool_uses");
    expect(existsSync(sessionDir)).toBe(false);
  });
});

describe("runOnce entry whose session already has a reflection", () => {
  // The reflection is written first and the queue entry moves after it. A
  // crash between the two leaves the entry pending, and a second reflection
  // for one session counts twice against the promotion threshold.
  test("moves the entry on without writing a second reflection", async () => {
    prepareEnv();
    const entry = writePending("sess-twice", { ended: true });
    await runOnce(cfg(), { reflect: true, curriculum: false, chat: goodChat });
    const files = () => readdirSync(paths.reflectionsDir("default")).filter((n) => n.endsWith(".md"));
    expect(files()).toHaveLength(1);

    writeEntry("pending", entry);
    const summary = await runOnce(cfg(), { reflect: true, curriculum: false, chat: goodChat });

    expect(files()).toHaveLength(1);
    expect(summary.reflected).toEqual([]);
    expect(summary.skipped).toEqual(["sess-twice"]);
    expect(loadEntry("pending", "sess-twice")).toBeNull();
    expect(loadEntry("done", "sess-twice")!.result).toContain("already");
  });

  // `claude --resume` keeps the session id and appends to the same transcript,
  // so the queue entry for the resumed work is new while the id is old. Skipping
  // on the id alone would drop every lesson a resumed session ever produces.
  test("reflects again when the entry is newer than the reflection", async () => {
    prepareEnv();
    const entry = writePending("sess-resumed", { ended: true });
    await runOnce(cfg(), { reflect: true, curriculum: false, chat: goodChat });
    const files = () => readdirSync(paths.reflectionsDir("default")).filter((n) => n.endsWith(".md"));
    expect(files()).toHaveLength(1);

    const later = new Date(Date.now() + 60_000).toISOString();
    writeEntry("pending", { ...entry, first_stop: later, last_stop: later });
    const summary = await runOnce(cfg(), { reflect: true, curriculum: false, chat: goodChat });

    expect(summary.reflected).toEqual(["sess-resumed"]);
    expect(files()).toHaveLength(2);
  });
});

describe("runOnce status file", () => {
  // worker.status is polled every 5 s by the web UI. A backlog pass wrote one
  // session id per entry, which grew the file to 19 KB.
  test("keeps a sample of session ids plus the full counts", async () => {
    prepareEnv();
    const total = STATUS_SUMMARY_IDS + 5;
    for (let i = 0; i < total; i++) writePending(`sess-many-${i}`, { ended: true, toolUses: 0 });

    const summary = await runOnce(cfg({ minToolUses: 99 }), { reflect: true, curriculum: false, chat: goodChat });
    expect(summary.skipped).toHaveLength(total);

    const raw = JSON.parse(readFileSync(join(paths.stateDir(), "worker-status.json"), "utf8")) as {
      last_summary: { skipped: string[]; counts: { skipped: number } };
    };
    expect(raw.last_summary.skipped).toHaveLength(STATUS_SUMMARY_IDS);
    expect(raw.last_summary.counts.skipped).toBe(total);
  });
});

describe("runOnce usage events", () => {
  // The legacy file here held 15.4 MB, 89% of it hook_run lines that no
  // scorecard reads, and every rebuild parsed all of it.
  test("compacts the event log once enough lines are dead", async () => {
    prepareEnv();
    const events = paths.usageEventsFile();
    for (let i = 0; i < 600; i++) {
      fsx.appendJsonl(events, { ts: fsx.nowIso(), session_id: `s${i}`, world: "default", kind: "hook_run", ref: "hook:PreToolUse" });
    }
    fsx.appendJsonl(events, { ts: fsx.nowIso(), session_id: "s-keep", world: "default", kind: "skill", ref: "skill:kept-thing" });

    await runOnce(cfg(), { reflect: false, curriculum: false, chat: goodChat });

    const kept = fsx.readJsonl<Record<string, unknown>>(events);
    expect(kept).toHaveLength(1);
    expect(kept[0]!["ref"]).toBe("skill:kept-thing");
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

  // An ended session cannot gain tool uses, so the verdict is terminal
  // ("skipped:"). Before this, such an entry stayed pending and every worker
  // run re-read its transcript.
  test("terminal skip below min_tool_uses for an ended entry", () => {
    prepareEnv();
    const entry = writePending("sess-e2", { ended: true, toolUses: 0 });
    const [ok, reason] = eligible(entry, cfg({ minToolUses: 99 }), new Date());
    expect(ok).toBe(false);
    expect(reason).toBe("skipped: below min_tool_uses");
  });

  test("soft skip below min_tool_uses while the session can still come back", () => {
    prepareEnv();
    const entry = writePending("sess-e2b", { ended: false, toolUses: 0 });
    // Idle past idle_minutes but young enough to resume and pass the bar.
    const later = new Date(Date.now() + 20 * 60_000);
    const [ok, reason] = eligible(entry, cfg({ idleMinutes: 10, minToolUses: 99 }), later);
    expect(ok).toBe(false);
    expect(reason).toBe("below min_tool_uses");
  });

  test("terminal skip below min_tool_uses once the transcript is abandoned", () => {
    prepareEnv();
    const entry = writePending("sess-e2c", { ended: false, toolUses: 0 });
    const muchLater = new Date(Date.now() + (ABANDONED_AFTER_DAYS * 86_400_000 + 3_600_000));
    const [ok, reason] = eligible(entry, cfg({ idleMinutes: 10, minToolUses: 99 }), muchLater);
    expect(ok).toBe(false);
    expect(reason).toBe("skipped: below min_tool_uses");
  });

  // The hook count lags the transcript: SessionEnd marks a session ended
  // without scanning it. Retiring is final, so the file decides, not the
  // stored number.
  test("counts the transcript before retiring an entry whose stored count is stale", () => {
    prepareEnv();
    const entry = writePending("sess-e2d", { ended: true, toolUses: 1 });
    const real = countToolUses(entry.transcript_path);
    expect(real).toBeGreaterThan(1);
    const [ok, reason] = eligible(entry, cfg({ minToolUses: real }), new Date());
    expect(ok).toBe(true);
    expect(reason).toBe("eligible");
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

  test("a second acquire without a release is refused", () => {
    prepareEnv();
    const first = new Lock();
    first.acquire();
    try {
      expect(() => new Lock().acquire()).toThrow(LockHeld);
    } finally {
      first.release();
    }
    expect(() => new Lock().acquire()).not.toThrow();
    new Lock().release();
  });

  /** Write a crashed worker's lock file and return its path. */
  function writeCrashedLock(): string {
    const lockPath = paths.workerLockFile();
    fsx.ensureDir(join(lockPath, ".."));
    writeFileSync(lockPath, "999999999", "utf8"); // a pid that cannot exist
    return lockPath;
  }

  // The invariant the reclaim path rests on: removing a crashed lock is done by
  // one process at a time. Deciding the winner by timing let two of them hold.
  test("a reclaimer that loses the reclaim mutex does not take the lock", () => {
    prepareEnv();
    const lockPath = writeCrashedLock();
    writeFileSync(`${lockPath}.reclaim`, "4194303", "utf8"); // another process is mid-reclaim

    expect(() => new Lock().acquire()).toThrow(LockHeld);
    expect(readFileSync(lockPath, "utf8")).toBe("999999999");
    expect(existsSync(`${lockPath}.reclaim`)).toBe(true); // the loser does not clear it
  });

  test("an abandoned reclaim mutex does not block the reclaim forever", () => {
    prepareEnv();
    const lockPath = writeCrashedLock();
    const mutex = `${lockPath}.reclaim`;
    writeFileSync(mutex, "4194303", "utf8");
    const longAgo = (Date.now() - 600_000) / 1000;
    utimesSync(mutex, longAgo, longAgo);

    const lock = new Lock();
    expect(() => lock.acquire()).not.toThrow();
    expect(Lock.held()).toBe(true);
    expect(existsSync(mutex)).toBe(false);
    lock.release();
  });

  test("a live lock is never unlinked by a reclaimer", () => {
    prepareEnv();
    const first = new Lock();
    first.acquire();
    try {
      expect(() => new Lock().acquire()).toThrow(LockHeld);
      expect(readFileSync(paths.workerLockFile(), "utf8")).toBe(String(process.pid));
    } finally {
      first.release();
    }
  });

  test("a successful reclaim leaves no mutex behind", () => {
    prepareEnv();
    const lockPath = writeCrashedLock();

    const lock = new Lock();
    lock.acquire();
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
    lock.release();
  });

  test("release leaves nothing that reads as held", () => {
    prepareEnv();
    const lock = new Lock();
    lock.acquire();
    lock.release();
    expect(Lock.held()).toBe(false);
    expect(existsSync(paths.workerLockFile())).toBe(false);
  });

  const RACERS = 8;

  /** `RACERS` processes calling acquire() at once. Each holds past the others'
   * attempts, so a second "ok" means two of them owned the lock at the same
   * time. */
  async function race(): Promise<string[]> {
    const src = join(import.meta.dir, "..", "src", "index.ts");
    // They all spin to the same wall-clock instant before calling acquire().
    // Left to their own start times, bun's startup spread is wider than the
    // window being tested and the processes never actually overlap: measured,
    // the unlink-then-create reclaim failed 2 runs in 6 unsynchronised and 6 in
    // 6 once they start together.
    const startAt = Date.now() + 2000;
    const program =
      `import { Lock } from ${JSON.stringify(src)};\nimport { paths } from "@sil/core";\n` +
      `if (!paths.workerLockFile().startsWith(${JSON.stringify(tmpDir)})) throw new Error("child escaped the test dir");\n` +
      `while (Date.now() < ${startAt}) {}\n` +
      'try { new Lock().acquire(); console.log("ok"); } catch { console.log("held"); }\n' +
      "await Bun.sleep(900);\n";

    // The env is passed explicitly. Measured: a child does NOT inherit
    // `process.env` mutations made after start, so without this the children
    // race on the operator's real worker lock instead of the test's.
    const env = { ...process.env, SIL_STATE_DIR: process.env["SIL_STATE_DIR"]! };
    const kids = Array.from({ length: RACERS }, () =>
      Bun.spawn(["bun", "-e", program], { env, stdout: "pipe", stderr: "pipe" }),
    );
    const outputs = await Promise.all(kids.map(async (kid) => (await new Response(kid.stdout).text()).trim()));
    await Promise.all(kids.map((kid) => kid.exited));
    return outputs;
  }

  test(
    "processes racing for a free lock produce exactly one holder",
    async () => {
      prepareEnv();

      const outputs = await race();

      expect(outputs.filter((o) => o === "ok")).toHaveLength(1);
      expect(outputs.filter((o) => o === "held")).toHaveLength(RACERS - 1);
    },
    20_000,
  );

  test(
    "processes racing to reclaim a crashed lock produce exactly one holder",
    async () => {
      // The sharp case, and the one measured failing: every process sees a dead
      // pid, so every one of them takes the reclaim path at once. Reclaiming by
      // unlink-then-create, each removed the file another had just written and
      // two came away believing they held the lock.
      prepareEnv();
      const lockPath = paths.workerLockFile();
      fsx.ensureDir(join(lockPath, ".."));
      writeFileSync(lockPath, "999999999", "utf8"); // a crashed worker's pid

      const outputs = await race();

      expect(outputs.filter((o) => o === "ok")).toHaveLength(1);
      expect(outputs.filter((o) => o === "held")).toHaveLength(RACERS - 1);
    },
    20_000,
  );
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
  test("leaves the lock free", async () => {
    prepareEnv();
    writePending("sess-good", { ended: true });

    await runOnce(cfg(), { reflect: true, curriculum: false, chat: goodChat });

    expect(existsSync(paths.workerLockFile())).toBe(false);
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
