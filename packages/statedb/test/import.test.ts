import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fsx, paths, StateReadError } from "@sil/core";
import { appendRecord, closeState, importAll, type ImportIo, openState, readRecords, setImportIoForTest, type Stream, STREAMS } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-import-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  try {
    setImportIoForTest(null);
    closeState();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const seedRaw = (path: string, text: string): void => {
  fsx.ensureDir(dirname(path));
  writeFileSync(path, text);
};

const backups = (path: string): string[] =>
  readdirSync(dirname(path))
    .filter((name) => name.startsWith(`${basename(path)}.imported-`))
    .map((name) => join(dirname(path), name));

const rowCount = (stream: Stream): number =>
  (openState().query("SELECT count(*) AS n FROM log_records WHERE stream = ?").get(stream) as { n: number }).n;

interface ImportRow {
  id: number;
  state: string;
  backup_path: string | null;
  lines_imported: number;
  lines_quarantined: number;
  lines_blank: number;
  sha256: string | null;
  size: number | null;
  dev: number | null;
  ino: number | null;
  failure: string | null;
}

const importRows = (store: Stream): ImportRow[] =>
  openState().query("SELECT * FROM legacy_imports WHERE store = ? ORDER BY id").all(store) as ImportRow[];

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

const critic = (): string => STREAMS.critic.legacyPath();

/** A completed import of two lines, then the backup renamed back to the claim
 * name: the state a crash between COMMIT and the backup rename leaves. */
function crashAfterCommit(): { claim: string; backup: string; seeded: Buffer } {
  const p = critic();
  fsx.appendJsonl(p, { n: 1 });
  fsx.appendJsonl(p, { n: 2 });
  const seeded = readFileSync(p);
  expect(readRecords("critic", "strict").records).toEqual([{ n: 1 }, { n: 2 }]);
  const [backup] = backups(p);
  const claim = `${p}.importing`;
  renameSync(backup!, claim);
  expect(importRows("critic")[0]!.backup_path).toBe(backup!);
  return { claim, backup: backup!, seeded };
}

describe("legacy import", () => {
  test("the first open imports all four streams", () => {
    const counts: Record<Stream, number> = { reflect_runs: 1, critic: 2, human: 3, proposal_events: 4 };
    for (const [stream, n] of Object.entries(counts) as [Stream, number][]) {
      for (let i = 0; i < n; i++) fsx.appendJsonl(STREAMS[stream].legacyPath(), { stream, i });
    }
    const db = openState();
    for (const [stream, n] of Object.entries(counts) as [Stream, number][]) {
      const p = STREAMS[stream].legacyPath();
      expect(existsSync(p)).toBe(false);
      expect(existsSync(`${p}.importing`)).toBe(false);
      expect(backups(p)).toHaveLength(1);
      expect((db.query("SELECT count(*) AS n FROM log_records WHERE stream = ?").get(stream) as { n: number }).n).toBe(n);
    }
    const verified = db.query("SELECT store FROM legacy_imports WHERE state = 'verified' ORDER BY id").all() as { store: string }[];
    expect(verified.map((r) => r.store)).toEqual(["reflect_runs", "critic", "human", "proposal_events"]);
  });

  test("good, bad, blank and a newline-less last line import in file order with a byte-identical backup", () => {
    const p = critic();
    const text = '{"n":1}\n{"n":2}\nnot json\n\n{"n":3}\n{"n":4}';
    seedRaw(p, text);
    expect(readRecords("critic", "counted")).toEqual({ records: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], quarantined: 1 });
    expect(existsSync(p)).toBe(false);
    const list = backups(p);
    expect(list).toHaveLength(1);
    expect(sha256(readFileSync(list[0]!))).toBe(sha256(Buffer.from(text)));
    const [row] = importRows("critic");
    expect(row).toMatchObject({
      state: "verified",
      backup_path: list[0],
      lines_imported: 4,
      lines_quarantined: 1,
      lines_blank: 1,
      sha256: sha256(Buffer.from(text)),
      size: Buffer.byteLength(text),
    });
    const quarantine = openState().query("SELECT store, line_no, raw, import_id FROM quarantine").all();
    expect(quarantine).toEqual([{ store: "critic", line_no: 3, raw: "not json", import_id: row!.id }]);

    // A second read imports nothing and returns the same rows.
    expect(readRecords("critic", "counted")).toEqual({ records: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }], quarantined: 1 });
    expect(rowCount("critic")).toBe(4);
    expect(backups(p)).toHaveLength(1);
    expect(importRows("critic")).toHaveLength(1);
  });

  test("a spill after the import reads after the old rows and leaves a second backup", () => {
    const p = critic();
    fsx.appendJsonl(p, { n: 1 });
    expect(readRecords("critic", "strict").records).toEqual([{ n: 1 }]);
    appendRecord("critic", { n: 2 });
    fsx.appendJsonl(p, { n: 0, ts: "2000-01-01T00:00:00Z" });
    expect(readRecords("critic", "strict").records).toEqual([{ n: 1 }, { n: 2 }, { n: 0, ts: "2000-01-01T00:00:00Z" }]);
    expect(backups(p)).toHaveLength(2);
  });

  test("a crash after the claim rename leaves P.importing, imported once on the next read", () => {
    openState();
    const claim = `${critic()}.importing`;
    seedRaw(claim, '{"n":1}\n{"n":2}\n');
    expect(readRecords("critic", "strict").records).toEqual([{ n: 1 }, { n: 2 }]);
    expect(readRecords("critic", "strict").records).toEqual([{ n: 1 }, { n: 2 }]);
    expect(existsSync(claim)).toBe(false);
    expect(backups(critic())).toHaveLength(1);
    expect(rowCount("critic")).toBe(2);
  });

  test("a crash after commit before the backup rename: nothing new is imported and the claim becomes the backup", () => {
    const { claim, backup, seeded } = crashAfterCommit();
    expect(readRecords("critic", "strict").records).toEqual([{ n: 1 }, { n: 2 }]);
    expect(rowCount("critic")).toBe(2);
    expect(existsSync(claim)).toBe(false);
    expect(sha256(readFileSync(backup))).toBe(sha256(seeded));
    expect(importRows("critic")).toHaveLength(1);
  });

  test("a late append to the committed claim imports only the extra lines and grows the row size", () => {
    const { claim, backup } = crashAfterCommit();
    appendFileSync(claim, '{"n":3}\n{"n":4}\n');
    const grown = statSync(claim).size;
    expect(readRecords("critic", "strict").records).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    expect(rowCount("critic")).toBe(4);
    const [row] = importRows("critic");
    expect(row).toMatchObject({ state: "verified", size: grown, lines_imported: 4, sha256: sha256(readFileSync(backup)) });
    expect(existsSync(claim)).toBe(false);
  });

  test("a claimed file whose bytes changed under the same inode records failed and imports nothing", () => {
    const { claim } = crashAfterCommit();
    const ino = statSync(claim).ino;
    writeFileSync(claim, '{"n":9}\n{"n":8}\n{"n":7}\n');
    expect(statSync(claim).ino).toBe(ino);
    const error = caught(() => readRecords("critic", "counted"));
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message).toBe("the critic feedback log cannot be read (claimed file changed after import)");
    const failed = importRows("critic").filter((r) => r.state === "failed");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed.every((r) => r.failure === "claimed file changed after import" && r.ino === ino)).toBe(true);
    expect(rowCount("critic")).toBe(2);
    expect(existsSync(claim)).toBe(true);
    // Tolerant still returns what the DB has.
    expect(readRecords("critic", "tolerant").records).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("an append that lands just before the finalize stat is imported, not left in the backup", () => {
    const p = critic();
    const claim = `${p}.importing`;
    fsx.appendJsonl(p, { n: 1 });
    // An appender that opened the claimed inode before the claim rename and
    // writes after the read: it lands before the finalize stat, or, if there
    // is none, before the backup rename (so the lines end up in the backup).
    let claimRead = false;
    let appended = false;
    const lateAppend = (): void => {
      if (!claimRead || appended) return;
      appended = true;
      appendFileSync(claim, '{"n":2}\n{"n":3}\n');
    };
    const io: ImportIo = {
      stat: (path) => {
        if (path === claim) lateAppend();
        return statSync(path);
      },
      rename: (from, to) => {
        if (from === claim) lateAppend();
        renameSync(from, to);
      },
      readFile: (path) => {
        if (path === claim) claimRead = true;
        return readFileSync(path);
      },
    };
    setImportIoForTest(io);
    expect(readRecords("critic", "strict").records).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(appended).toBe(true);
    const [row] = importRows("critic");
    expect(row).toMatchObject({ state: "verified", lines_imported: 3 });
    expect(row!.size).toBe(statSync(row!.backup_path!).size);
  });

  test(
    "busy: strict says the log is being imported within about 2.5 s, tolerant returns current rows",
    () => {
      appendRecord("critic", { n: 1 });
      const raw = new Database(paths.loopStateDb());
      try {
        raw.run("BEGIN IMMEDIATE");
        fsx.appendJsonl(critic(), { n: 2 });
        const started = performance.now();
        const error = caught(() => readRecords("critic", "strict"));
        const elapsed = performance.now() - started;
        expect(error).toBeInstanceOf(StateReadError);
        expect((error as Error).message).toBe("the critic feedback log is being imported");
        expect(elapsed).toBeLessThan(2500);
        expect(readRecords("critic", "tolerant")).toEqual({ records: [{ n: 1 }], quarantined: 0 });
      } finally {
        if (raw.inTransaction) raw.run("ROLLBACK");
        raw.close();
      }
    },
    15_000,
  );

  test("a failed import fails only that read; a successful retry reads despite the failed row", () => {
    openState();
    const claim = `${critic()}.importing`;
    seedRaw(claim, '{"n":1}\n');
    chmodSync(claim, 0o000);
    try {
      const error = caught(() => readRecords("critic", "strict"));
      expect(error).toBeInstanceOf(StateReadError);
      expect((error as Error).message).toBe("the critic feedback log cannot be read (EACCES)");
      expect(importRows("critic").some((r) => r.state === "failed" && r.failure === "EACCES")).toBe(true);
    } finally {
      chmodSync(claim, 0o644);
    }
    let retried: unknown = null;
    let result: unknown = null;
    try {
      result = readRecords("critic", "strict");
    } catch (error) {
      retried = error;
    }
    expect(retried).toBeNull();
    expect(result).toEqual({ records: [{ n: 1 }], quarantined: 0 });
    expect(importRows("critic").some((r) => r.state === "failed")).toBe(true);
    expect(importRows("critic").some((r) => r.state === "verified")).toBe(true);
  });

  test("a 100 000 line file imports in one read under 2000 ms", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      lines.push(JSON.stringify({ ts: "2026-10-25T10:00:00.000Z", world: "default", reflection: `r-${i}`, verdict: "good", score: i % 7 }));
    }
    seedRaw(critic(), lines.join("\n") + "\n");
    const started = performance.now();
    const result = readRecords("critic", "strict");
    const elapsed = performance.now() - started;
    console.log(`import of 100000 lines: ${elapsed.toFixed(0)} ms`);
    expect(result.records).toHaveLength(100_000);
    expect(result.records[99_999]).toMatchObject({ reflection: "r-99999" });
    expect(elapsed).toBeLessThan(2000);
  }, 20_000);

  test(
    "two processes reading at once import the file exactly once",
    async () => {
      for (let i = 0; i < 5000; i++) fsx.appendJsonl(critic(), { i });
      const stateDir = process.env["SIL_STATE_DIR"]!;
      const src = join(import.meta.dir, "..", "src", "index.ts");
      const startAt = Date.now() + 1500;
      const program =
        `import { paths } from "@sil/core";\nimport { readRecords } from ${JSON.stringify(src)};\n` +
        'console.log("STATE " + paths.stateDir());\n' +
        `while (Date.now() < ${startAt}) {}\n` +
        'try { console.log("RESULT " + readRecords("critic", "strict").records.length); } catch (e) { console.log("RESULT " + e.name + " " + e.message); }\n';
      // Built only from tmp dirs: a child does not see process.env changes made after start.
      const env = {
        PATH: process.env["PATH"] ?? "",
        HOME: join(tmp, "home"),
        SIL_CONFIG_DIR: process.env["SIL_CONFIG_DIR"]!,
        SIL_STATE_DIR: stateDir,
        SIL_DATA_DIR: process.env["SIL_DATA_DIR"]!,
      };
      const kids = [0, 1].map(() =>
        Bun.spawn(["bun", "-e", program], { env, cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }),
      );
      const outputs = await Promise.all(kids.map(async (kid) => (await new Response(kid.stdout).text()).trim().split("\n")));
      const codes = await Promise.all(kids.map((kid) => kid.exited));
      expect(codes).toEqual([0, 0]);
      // Positive control: both children ran against this test's STATE dir.
      expect(outputs.map((o) => o[0])).toEqual([`STATE ${stateDir}`, `STATE ${stateDir}`]);
      expect(outputs.map((out) => out[1])).toEqual(["RESULT 5000", "RESULT 5000"]);
      const db = new Database(paths.loopStateDb(), { readonly: true });
      try {
        expect((db.query("SELECT count(*) AS n FROM log_records WHERE stream = 'critic'").get() as { n: number }).n).toBe(5000);
      } finally {
        db.close();
      }
    },
    20_000,
  );
});

const ioError = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code });

/** node:fs, except that `matches` paths throw `code` from `call`. */
function failingIo(call: "stat" | "readFile", matches: (path: string) => boolean, code: string): ImportIo {
  return {
    stat: (path) => {
      if (call === "stat" && matches(path)) throw ioError(code);
      return statSync(path);
    },
    rename: (from, to) => renameSync(from, to),
    readFile: (path) => {
      if (call === "readFile" && matches(path)) throw ioError(code);
      return readFileSync(path);
    },
  };
}

describe("importAll", () => {
  test("a first call on seeded files returns the outcomes of the import its open ran", () => {
    fsx.appendJsonl(STREAMS.critic.legacyPath(), { n: 1 });
    fsx.appendJsonl(STREAMS.human.legacyPath(), { n: 1 });
    fsx.appendJsonl(STREAMS.human.legacyPath(), { n: 2 });
    const result = importAll();
    expect(result.failures).toEqual([]);
    expect(result.outcomes.map((o) => [o.stream, o.imported, o.quarantined, o.blank])).toEqual([
      ["critic", 1, 0, 0],
      ["human", 2, 0, 0],
    ]);
    expect(result.outcomes.map((o) => o.backupPath)).toEqual([...backups(critic()), ...backups(STREAMS.human.legacyPath())]);
    // Nothing left: a second call reports nothing.
    expect(importAll()).toEqual({ outcomes: [], failures: [] });
  });

  test("a spill on an already open database is returned by the next call", () => {
    openState();
    fsx.appendJsonl(critic(), { n: 1 });
    const result = importAll();
    expect(result.failures).toEqual([]);
    expect(result.outcomes.map((o) => [o.stream, o.imported])).toEqual([["critic", 1]]);
  });

  test("one failing stream is listed and every other stream is still imported", () => {
    for (const stream of Object.keys(STREAMS) as Stream[]) fsx.appendJsonl(STREAMS[stream].legacyPath(), { stream });
    const failingClaim = `${STREAMS.reflect_runs.legacyPath()}.importing`;
    setImportIoForTest(failingIo("readFile", (path) => path === failingClaim, "EIO"));
    let result = { outcomes: [] as { stream: Stream }[], failures: [] as unknown[] };
    expect(caught(() => (result = importAll() as unknown as typeof result))).toBeNull();
    expect(result.failures).toEqual([{ stream: "reflect_runs", message: "the reflect runs log cannot be imported (EIO)" }]);
    expect(result.outcomes.map((o) => o.stream)).toEqual(["critic", "human", "proposal_events"]);
    for (const stream of ["critic", "human", "proposal_events"] as Stream[]) expect(rowCount(stream)).toBe(1);
    expect(importRows("reflect_runs").map((r) => [r.state, r.failure])).toEqual([["failed", "EIO"]]);
  });

  test("a pending check that cannot stat at first open records failed and the open goes on", () => {
    fsx.appendJsonl(STREAMS.human.legacyPath(), { n: 1 });
    setImportIoForTest(failingIo("stat", (path) => path === critic(), "EIO"));
    const db = openState();
    const failed = importRows("critic");
    expect(failed.map((r) => [r.state, r.failure, r.dev, r.ino])).toEqual([["failed", "EIO", null, null]]);
    expect(rowCount("human")).toBe(1);
    expect((db.query("SELECT count(*) AS n FROM legacy_imports WHERE state = 'verified'").get() as { n: number }).n).toBe(1);
  });
});
