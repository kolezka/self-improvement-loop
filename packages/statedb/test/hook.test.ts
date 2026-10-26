import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { paths } from "@sil/core";
import {
  closeHookDb,
  type HookIo,
  hookWrite,
  openForHook,
  REAL_HOOK_IO,
  setHookIoForTest,
  SPILL_MAX_SEGMENTS,
  SPILL_SEAL_BYTES,
  spillWrite,
} from "../src/hook.ts";
import { closeState, openState, readRecords, type Stream, STREAMS } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"] as const;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-hook-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  try {
    setHookIoForTest(null);
    closeHookDb();
    closeState();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

const legacy = (stream: Stream, world: string | null = null): string => STREAMS[stream].legacyPath(world);
const spillDirOf = (p: string): string => `${p}.spill`;
const dbPath = (): string => paths.loopStateDb();

/** A v3 database as the non-hook opener leaves it. */
function fresh(): void {
  openState();
  closeState();
}

const lines = (p: string): string[] => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l !== "") : []);
const hookLogLines = (): string[] => lines(paths.logFile("hook"));
const pragma = (db: Database, name: string): unknown => Object.values(db.query(`PRAGMA ${name}`).get() as object)[0];

function withRaw<T>(fn: (db: Database) => T): T {
  const db = new Database(dbPath(), { readwrite: true, create: false });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const rowBodies = (stream: Stream): string[] =>
  withRaw((db) => (db.query("SELECT body FROM log_records WHERE stream = ? ORDER BY id").all(stream) as { body: string }[]).map((r) => r.body));

/** Hold the write lock on the DB file from another connection. */
function lockDb(): Database {
  const locker = new Database(dbPath(), { readwrite: true, create: false });
  locker.run("BEGIN IMMEDIATE");
  return locker;
}

const ev = (n: number): Record<string, unknown> => ({ ts: `2026-10-26T10:00:${String(n).padStart(2, "0")}.000Z`, kind: "fire", ref: `r${n}`, n });

/** The real io, with `stat` of `target` reporting the seal size. */
function sealAt(target: string, extra: Partial<HookIo> = {}): HookIo {
  return {
    ...REAL_HOOK_IO,
    stat: (p) => {
      const real = REAL_HOOK_IO.stat(p);
      return p === target ? { ...real, size: SPILL_SEAL_BYTES } : real;
    },
    ...extra,
  };
}

const SEGMENT_NAME = /^\d{4}-\d{2}-\d{2}T\d{9}Z-(\d+)-(\d+)\.jsonl$/;

describe("openForHook and hookWrite on a ready database", () => {
  test("opens a v3 database with the hook pragmas and writes a row", () => {
    fresh();
    const handle = openForHook();
    expect(handle).not.toBeNull();
    expect(pragma(handle!.db, "synchronous")).toBe(1);
    expect(pragma(handle!.db, "busy_timeout")).toBe(25);
    expect(pragma(handle!.db, "foreign_keys")).toBe(1);
    expect(hookWrite("usage_events", [ev(1)])).toBe("db");
    closeHookDb();
    expect(readRecords("usage_events", "strict").records).toEqual([ev(1)]);
    expect(existsSync(legacy("usage_events"))).toBe(false);
  });

  test("a payload sample with no world field gets the world argument, as NFC", () => {
    fresh();
    const nfd = "koleżka".normalize("NFD");
    expect(hookWrite("payload_samples", [{ ts: "2026-10-26T10:00:00.000Z", tool: "Bash" }], nfd)).toBe("db");
    expect(hookWrite("payload_samples", [{ ts: "2026-10-26T10:00:01.000Z", world: "other" }], nfd)).toBe("db");
    closeHookDb();
    const worlds = withRaw((db) => db.query("SELECT world FROM log_records WHERE stream = 'payload_samples' ORDER BY id").all() as { world: string }[]);
    expect(worlds.map((r) => r.world)).toEqual(["koleżka".normalize("NFC"), "other"]);
  });

  test("a record that is not a JSON object is dropped with one log line, never spilled", () => {
    fresh();
    const bad = [1, "x", null, [1]] as unknown as Record<string, unknown>[];
    expect(hookWrite("usage_events", [bad[0]!, ev(1)])).toBe("db");
    expect(hookWrite("usage_events", bad.slice(1))).toBe("lost");
    closeHookDb();
    expect(rowBodies("usage_events")).toEqual([JSON.stringify(ev(1))]);
    expect(existsSync(legacy("usage_events"))).toBe(false);
    expect(hookLogLines().filter((l) => l.includes("not a JSON object"))).toHaveLength(1);
  });
});

describe("openForHook returns null and the hook spills", () => {
  const cases: [string, () => void][] = [
    ["no database file", () => {}],
    ["user_version 2", () => {
      fresh();
      withRaw((db) => db.run("PRAGMA user_version = 2"));
    }],
    ["user_version 4", () => {
      fresh();
      withRaw((db) => db.run("PRAGMA user_version = 4"));
    }],
    ["meta.fs_dev is another device", () => {
      fresh();
      const dev = statSync(paths.stateDir()).dev;
      withRaw((db) => db.query("UPDATE meta SET value = ? WHERE key = 'fs_dev'").run(String(dev + 1)));
    }],
  ];

  for (const [name, setup] of cases) {
    test(name, () => {
      setup();
      const before = hookLogLines().length;
      expect(openForHook()).toBeNull();
      expect(hookWrite("usage_events", [ev(1)])).toBe("spilled");
      expect(hookWrite("usage_events", [ev(2)])).toBe("spilled");
      expect(lines(legacy("usage_events"))).toEqual([JSON.stringify(ev(1)), JSON.stringify(ev(2))]);
      expect(hookLogLines().length - before).toBe(1);
      if (existsSync(dbPath())) expect(rowBodies("usage_events")).toEqual([]);
    });
  }
});

describe("busy database", () => {
  test("a held write lock spills inside the budget, and the process keeps spilling", () => {
    fresh();
    const locker = lockDb();
    try {
      const t0 = performance.now();
      expect(hookWrite("usage_events", [ev(1)])).toBe("spilled");
      const first = performance.now() - t0;
      expect(first).toBeLessThan(200);
      expect(lines(legacy("usage_events"))).toEqual([JSON.stringify(ev(1))]);

      const t1 = performance.now();
      expect(hookWrite("usage_events", [ev(2)])).toBe("spilled");
      const second = performance.now() - t1;
      expect(second).toBeLessThan(5);
      expect(lines(legacy("usage_events"))).toEqual([JSON.stringify(ev(1)), JSON.stringify(ev(2))]);
      console.log(`busy: first write spilled in ${first.toFixed(1)} ms, second in ${second.toFixed(2)} ms`);
      expect(hookLogLines().filter((l) => l.includes("SQLITE_BUSY"))).toHaveLength(1);
    } finally {
      locker.run("ROLLBACK");
      locker.close();
    }
    expect(rowBodies("usage_events")).toEqual([]);
  });

  test("a batch under a held lock spills whole", () => {
    fresh();
    const locker = lockDb();
    try {
      expect(hookWrite("hook_runs", [ev(1), ev(2), ev(3)])).toBe("spilled");
    } finally {
      locker.run("ROLLBACK");
      locker.close();
    }
    expect(rowBodies("hook_runs")).toEqual([]);
    expect(lines(legacy("hook_runs"))).toEqual([ev(1), ev(2), ev(3)].map((r) => JSON.stringify(r)));
  });

  test("a batch that fails after its first insert rolls back and spills whole", () => {
    fresh();
    // Test-only trigger: the second insert of the batch aborts.
    withRaw((db) =>
      db.run("CREATE TRIGGER boom BEFORE INSERT ON log_records WHEN json_extract(NEW.body, '$.n') = 2 BEGIN SELECT RAISE(ABORT, 'boom'); END"),
    );
    expect(hookWrite("hook_runs", [ev(1), ev(2), ev(3)])).toBe("spilled");
    closeHookDb();
    expect(rowBodies("hook_runs")).toEqual([]);
    expect(lines(legacy("hook_runs"))).toEqual([ev(1), ev(2), ev(3)].map((r) => JSON.stringify(r)));
  });
});

describe("spillWrite", () => {
  test("seals P at the bound into a named segment, and each seal takes the next seq", () => {
    const p = legacy("usage_events");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "old\n");
    setHookIoForTest(sealAt(p));

    expect(spillWrite("usage_events", ['{"n":1}'])).toBe(true);
    const first = readdirSync(spillDirOf(p));
    expect(first).toHaveLength(1);
    const m1 = SEGMENT_NAME.exec(first[0]!);
    expect(m1).not.toBeNull();
    expect(Number(m1![1])).toBe(process.pid);
    expect(readFileSync(join(spillDirOf(p), first[0]!), "utf8")).toBe("old\n");
    expect(readFileSync(p, "utf8")).toBe('{"n":1}\n');

    expect(spillWrite("usage_events", ['{"n":2}'])).toBe(true);
    const second = readdirSync(spillDirOf(p)).filter((n) => n !== first[0]);
    expect(second).toHaveLength(1);
    const m2 = SEGMENT_NAME.exec(second[0]!);
    expect(m2).not.toBeNull();
    expect(Number(m2![2])).toBe(Number(m1![2]) + 1);
    expect(readFileSync(join(spillDirOf(p), second[0]!), "utf8")).toBe('{"n":1}\n');
    expect(readFileSync(p, "utf8")).toBe('{"n":2}\n');
  });

  test("below the bound it only appends", () => {
    const p = legacy("nudge_fires");
    expect(spillWrite("nudge_fires", ['{"n":1}', '{"n":2}'])).toBe(true);
    expect(spillWrite("nudge_fires", ['{"n":3}'])).toBe(true);
    expect(readFileSync(p, "utf8")).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(existsSync(spillDirOf(p))).toBe(false);
  });

  test("a seal that loses the rename to another process still appends", () => {
    const p = legacy("usage_events");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "old\n");
    setHookIoForTest(
      sealAt(p, {
        rename: () => {
          throw Object.assign(new Error("ENOENT: no such file or directory, rename"), { code: "ENOENT" });
        },
      }),
    );
    expect(spillWrite("usage_events", ['{"n":1}'])).toBe(true);
    expect(readFileSync(p, "utf8")).toBe('old\n{"n":1}\n');
  });

  test("the bound drops the oldest unclaimed segments and never a claim", () => {
    const p = legacy("usage_events");
    const dir = spillDirOf(p);
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, "old\n");
    // An old segment a crashed importer claimed: its name sorts first.
    const claim = "2025-12-31T000000000Z-1-0.jsonl.importing";
    writeFileSync(join(dir, claim), "claimed\n");
    const existing = Array.from({ length: SPILL_MAX_SEGMENTS + 1 }, (_, i) => `2026-01-01T0000000${String(i).padStart(2, "0")}Z-1-${i}.jsonl`);
    for (const name of existing) writeFileSync(join(dir, name), `${name}\n`);
    setHookIoForTest(sealAt(p));

    expect(spillWrite("usage_events", ['{"n":1}'])).toBe(true);
    const after = readdirSync(dir).sort();
    const segments = after.filter((n) => n.endsWith(".jsonl"));
    expect(segments).toHaveLength(SPILL_MAX_SEGMENTS);
    expect(segments.slice(0, -1)).toEqual(existing.slice(2));
    expect(readFileSync(join(dir, segments.at(-1)!), "utf8")).toBe("old\n");
    expect(after).toContain(claim);
    expect(readFileSync(join(dir, claim), "utf8")).toBe("claimed\n");
    expect(hookLogLines().filter((l) => l.includes("dropped a spill segment of the usage log"))).toHaveLength(1);
  });

  test("a failed append returns false, and hookWrite reports the records lost", () => {
    setHookIoForTest({
      ...REAL_HOOK_IO,
      appendFile: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    expect(spillWrite("usage_events", ['{"n":1}'])).toBe(false);
    expect(hookWrite("usage_events", [ev(1)])).toBe("lost");
    expect(existsSync(legacy("usage_events"))).toBe(false);
  });
});

describe("thirty hooks at once", () => {
  test("every event lands once, in the database or the spill, and imports", async () => {
    fresh();
    const stateDir = process.env["SIL_STATE_DIR"]!;
    const hookModule = resolve(import.meta.dir, "../src/hook.ts");
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: join(tmp, "home"),
      SIL_CONFIG_DIR: process.env["SIL_CONFIG_DIR"]!,
      SIL_STATE_DIR: stateDir,
      SIL_DATA_DIR: process.env["SIL_DATA_DIR"]!,
    };
    const script = [
      `import { hookWrite } from ${JSON.stringify(hookModule)};`,
      "const n = Number(process.env.N);",
      "console.log(process.env.SIL_STATE_DIR);",
      `console.log(hookWrite("usage_events", [{ ts: new Date().toISOString(), kind: "fire", ref: "r" + n, n }]));`,
    ].join("\n");

    const locker = lockDb();
    const children = Array.from({ length: 30 }, (_, n) =>
      Bun.spawn([process.execPath, "-e", script], { env: { ...env, N: String(n) }, cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" }),
    );
    await Bun.sleep(50);
    locker.run("ROLLBACK");
    locker.close();

    const results = await Promise.all(
      children.map(async (child) => ({ code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() })),
    );
    for (const r of results) {
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const [seenDir, outcome] = r.out.trim().split("\n");
      // Positive control: the child saw the tmp STATE dir, not the real one.
      expect(seenDir).toBe(stateDir);
      expect(["db", "spilled"]).toContain(outcome!);
    }
    const spilled = results.filter((r) => r.out.trim().endsWith("spilled")).length;
    console.log(`thirty hooks: ${30 - spilled} wrote to the database, ${spilled} spilled`);

    const inDb = rowBodies("usage_events");
    const inSpill = lines(legacy("usage_events"));
    expect(inDb.length + inSpill.length).toBe(30);
    expect(new Set([...inDb, ...inSpill]).size).toBe(30);

    const imported = readRecords("usage_events", "strict").records;
    expect(imported).toHaveLength(30);
    expect(new Set(imported.map((r) => r["n"]))).toEqual(new Set(Array.from({ length: 30 }, (_, n) => n)));
  }, 30_000);
});

describe("close versus exit", () => {
  test("measures closeHookDb and the process wall time with and without it", async () => {
    fresh();
    // In process: close right after a write, as the last connection to the file.
    expect(hookWrite("usage_events", [ev(1)])).toBe("db");
    const t0 = performance.now();
    closeHookDb();
    const inProcess = performance.now() - t0;

    const hookModule = resolve(import.meta.dir, "../src/hook.ts");
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: join(tmp, "home"),
      SIL_CONFIG_DIR: process.env["SIL_CONFIG_DIR"]!,
      SIL_STATE_DIR: process.env["SIL_STATE_DIR"]!,
      SIL_DATA_DIR: process.env["SIL_DATA_DIR"]!,
    };
    const run = async (close: boolean): Promise<{ wall: number; closeMs: number }> => {
      const script = [
        `import { closeHookDb, hookWrite } from ${JSON.stringify(hookModule)};`,
        `if (hookWrite("usage_events", [{ ts: new Date().toISOString(), kind: "fire" }]) !== "db") process.exit(3);`,
        "const t = performance.now();",
        close ? "closeHookDb();" : "",
        "console.log(performance.now() - t);",
      ].join("\n");
      const t = performance.now();
      const child = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
      const code = await child.exited;
      const wall = performance.now() - t;
      expect(code).toBe(0);
      return { wall, closeMs: Number((await new Response(child.stdout).text()).trim()) };
    };
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const withClose: { wall: number; closeMs: number }[] = [];
    const withoutClose: { wall: number; closeMs: number }[] = [];
    for (let i = 0; i < 7; i++) {
      withClose.push(await run(true));
      withoutClose.push(await run(false));
    }
    console.log(
      `close vs exit: in-process closeHookDb ${inProcess.toFixed(2)} ms; ` +
        `child closeHookDb median ${median(withClose.map((r) => r.closeMs)).toFixed(2)} ms; ` +
        `child wall median with close ${median(withClose.map((r) => r.wall)).toFixed(1)} ms, without ${median(withoutClose.map((r) => r.wall)).toFixed(1)} ms`,
    );
    expect(rowBodies("usage_events")).toHaveLength(15);
  }, 30_000);
});
