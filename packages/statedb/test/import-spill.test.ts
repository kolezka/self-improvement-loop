import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fsx, paths, StateReadError, StateWriteError } from "@sil/core";
import { appendRecord, closeState, exportJsonl, type ImportIo, openState, readRecords, replaceStream, setImportIoForTest, stateStatus, type Stream, STREAMS } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-import-spill-"));
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

const KOLEZKA = "koleżka";
const KOLEZKA_NFD = KOLEZKA.normalize("NFD");

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const legacy = (stream: Stream, world: string | null = null): string => STREAMS[stream].legacyPath(world);
const events = (): string => legacy("usage_events");
const spill = (path: string): string => `${path}.spill`;

const seed = (path: string, records: Record<string, unknown>[]): void => {
  for (const record of records) fsx.appendJsonl(path, record);
};

const backups = (path: string): string[] =>
  readdirSync(dirname(path))
    .filter((name) => name.startsWith(`${basename(path)}.imported-`))
    .map((name) => join(dirname(path), name));

interface Row {
  id: number;
  store: string;
  world: string | null;
  state: string;
  original_path: string;
  backup_path: string | null;
}

const importRows = (store: string): Row[] =>
  openState()
    .query("SELECT id, store, world, state, original_path, backup_path FROM legacy_imports WHERE store = ? ORDER BY id")
    .all(store) as Row[];

const failedRows = (): Row[] =>
  openState().query("SELECT id, store, world, state, original_path, backup_path FROM legacy_imports WHERE state = 'failed'").all() as Row[];

const attempt = <T>(fn: () => T): { value: T | null; error: unknown } => {
  try {
    return { value: fn(), error: null };
  } catch (error) {
    return { value: null, error };
  }
};

describe("import of hook-written logs and sealed spill segments", () => {
  test("the first read of each hook stream imports it, per world for payload samples", () => {
    const seeds: { path: string; records: Record<string, unknown>[] }[] = [
      { path: events(), records: [{ e: 1 }, { e: 2 }, { e: 3 }] },
      { path: legacy("nudge_fires"), records: [{ f: 1 }, { f: 2 }] },
      { path: legacy("hook_runs"), records: [{ h: 1 }, { h: 2 }] },
      { path: legacy("payload_samples", "default"), records: [{ world: "default", p: 1 }, { world: "default", p: 2 }] },
    ];
    // The NFD spelling, built by hand: paths.* would normalize it.
    const nfd = { path: join(dirname(legacy("payload_samples", "default")), `${KOLEZKA_NFD}.jsonl`), records: [{ k: 1 }] };
    const hashes = new Map<string, string>();
    for (const s of [...seeds, nfd]) {
      seed(s.path, s.records);
      hashes.set(s.path, sha256(readFileSync(s.path)));
    }
    // Platform split (D9): APFS folds the NFD name onto the NFC path; ext4 (CI) does not.
    const folds = existsSync(legacy("payload_samples", KOLEZKA));

    expect(readRecords("usage_events", "strict").records.length).toBe(3);
    expect(readRecords("nudge_fires", "strict").records).toEqual([{ f: 1 }, { f: 2 }]);
    expect(readRecords("hook_runs", "strict").records).toEqual([{ h: 1 }, { h: 2 }]);
    expect(readRecords("payload_samples", "strict", "default").records).toEqual([
      { world: "default", p: 1 },
      { world: "default", p: 2 },
    ]);
    expect(readRecords("payload_samples", "strict", KOLEZKA).records).toEqual(folds ? [{ k: 1 }] : []);

    const imported = folds ? [...seeds, nfd] : seeds;
    for (const s of imported) {
      expect(existsSync(s.path)).toBe(false);
      expect(existsSync(`${s.path}.importing`)).toBe(false);
    }
    for (const s of seeds) {
      const found = backups(s.path);
      expect(found).toHaveLength(1);
      expect(sha256(readFileSync(found[0]!))).toBe(hashes.get(s.path)!);
    }
    if (folds) {
      const found = backups(legacy("payload_samples", KOLEZKA));
      expect(found).toHaveLength(1);
      expect(sha256(readFileSync(found[0]!))).toBe(hashes.get(nfd.path)!);
    } else {
      expect(existsSync(nfd.path)).toBe(true);
    }
    const verified = openState().query("SELECT store, world FROM legacy_imports WHERE state = 'verified' ORDER BY id").all() as {
      store: string;
      world: string | null;
    }[];
    expect(verified).toHaveLength(imported.length);
    expect(verified.filter((r) => r.world !== null)).toEqual([
      { store: "payload_samples", world: "default" },
      ...(folds ? [{ store: "payload_samples", world: KOLEZKA }] : []),
    ]);
    // A line without a world field takes the world of its file, NFC.
    if (folds) {
      const worlds = openState().query("SELECT world FROM log_records WHERE stream = 'payload_samples' AND body = ?").all('{"k":1}') as {
        world: string;
      }[];
      expect(worlds).toEqual([{ world: KOLEZKA }]);
    }
  });

  test("sealed segments import oldest first, then the open file", () => {
    const P = events();
    const older = join(spill(P), "20260101T000000000Z-1-0.jsonl");
    const newer = join(spill(P), "20260102T000000000Z-1-0.jsonl");
    // Seeded newest first so creation order cannot stand in for name order.
    seed(newer, [{ b: "c" }]);
    seed(older, [{ b: "a" }, { b: "b" }]);
    seed(P, [{ b: "d" }]);

    const bodies = readRecords("usage_events", "strict").records.map((r) => r["b"]);
    expect(bodies).toEqual(["a", "b", "c", "d"]);

    expect(statSync(spill(P)).isDirectory()).toBe(true);
    expect(readdirSync(spill(P)).filter((name) => name.endsWith(".jsonl"))).toEqual([]);
    expect(backups(P)).toHaveLength(3);
    const rows = importRows("usage_events");
    expect(rows.map((r) => [r.state, r.original_path])).toEqual([
      ["verified", older],
      ["verified", newer],
      ["verified", P],
    ]);
    for (const row of rows) expect(dirname(row.backup_path!)).toBe(dirname(P));
  });

  test("a segment claim left by a crash imports once and leaves a backup", () => {
    const P = events();
    openState();
    const claim = join(spill(P), "20260101T000000000Z-1-0.jsonl.importing");
    seed(claim, [{ n: 1 }, { n: 2 }]);
    expect(importRows("usage_events")).toEqual([]);

    expect(readRecords("usage_events", "strict").records).toEqual([{ n: 1 }, { n: 2 }]);
    expect(existsSync(claim)).toBe(false);
    expect(backups(P)).toHaveLength(1);
    expect(readRecords("usage_events", "strict").records).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("seal wins the race: the claim of P sees ENOENT, the segment imports, nothing fails", () => {
    const P = events();
    seed(P, [{ n: 1 }, { n: 2 }, { n: 3 }]);
    const segment = join(spill(P), "20260103T000000000Z-9-0.jsonl");
    let sealed = false;
    const io: ImportIo = {
      stat: (path) => {
        const st = statSync(path);
        if (!sealed && path === P) {
          // The hook seals P between the importer's stat and its claim.
          sealed = true;
          mkdirSync(spill(P), { recursive: true });
          renameSync(P, segment);
        }
        return st;
      },
      rename: (from, to) => renameSync(from, to),
      readFile: (path) => readFileSync(path),
    };
    setImportIoForTest(io);

    const first = attempt(() => readRecords("usage_events", "strict"));
    const second = attempt(() => readRecords("usage_events", "strict"));
    expect(sealed).toBe(true);
    expect(failedRows()).toEqual([]);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.value!.records).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(existsSync(segment)).toBe(false);
  });

  test("bound unlink wins over the segment claim: nothing fails, the rest imports", () => {
    const P = events();
    const s1 = join(spill(P), "20260101T000000000Z-1-0.jsonl");
    const s2 = join(spill(P), "20260102T000000000Z-1-0.jsonl");
    seed(s1, [{ b: "a" }, { b: "b" }]);
    seed(s2, [{ b: "c" }]);
    seed(P, [{ b: "d" }]);
    let unlinked = false;
    const io: ImportIo = {
      stat: (path) => statSync(path),
      rename: (from, to) => {
        if (!unlinked && from === s1) {
          // The hook's bound drops the oldest segment just before the claim.
          unlinked = true;
          unlinkSync(s1);
        }
        renameSync(from, to);
      },
      readFile: (path) => readFileSync(path),
    };
    setImportIoForTest(io);

    const read = attempt(() => readRecords("usage_events", "strict"));
    expect(unlinked).toBe(true);
    expect(failedRows()).toEqual([]);
    expect(read.error).toBeNull();
    const bodies = openState().query("SELECT DISTINCT json_extract(body, '$.b') AS b FROM log_records WHERE stream = 'usage_events' ORDER BY id").all();
    expect(bodies).toEqual([{ b: "c" }, { b: "d" }]);
    expect(read.value!.records.map((r) => r["b"])).toEqual(["c", "d"]);
    expect(importRows("usage_events").map((r) => [r.state, r.original_path])).toEqual([
      ["verified", s2],
      ["verified", P],
    ]);
    expect(readdirSync(spill(P)).filter((name) => name.endsWith(".jsonl") || name.endsWith(".importing"))).toEqual([]);
  });

  test("full D5 order: P's leftover claim, a segment claim, a segment, then P", () => {
    const P = events();
    openState();
    seed(`${P}.importing`, [{ b: "x" }]);
    seed(join(spill(P), "20260101T000000000Z-1-0.jsonl.importing"), [{ b: "y" }]);
    seed(join(spill(P), "20260102T000000000Z-1-0.jsonl"), [{ b: "z" }]);
    seed(P, [{ b: "w" }]);
    expect(readRecords("usage_events", "strict").records.map((r) => r["b"])).toEqual(["x", "y", "z", "w"]);
    expect(importRows("usage_events").map((r) => r.state)).toEqual(["verified", "verified", "verified", "verified"]);
  });

  test("claim wins the race: a line appended after the claim imports on the next read, once", () => {
    const P = events();
    seed(P, [{ n: 1 }, { n: 2 }]);
    let appended = false;
    const io: ImportIo = {
      stat: (path) => statSync(path),
      rename: (from, to) => {
        renameSync(from, to);
        if (!appended && from === P && to === `${P}.importing`) {
          appended = true;
          fsx.appendJsonl(P, { late: 1 });
        }
      },
      readFile: (path) => readFileSync(path),
    };
    setImportIoForTest(io);

    expect(readRecords("usage_events", "strict").records).toEqual([{ n: 1 }, { n: 2 }]);
    expect(appended).toBe(true);
    expect(readRecords("usage_events", "strict").records).toEqual([{ n: 1 }, { n: 2 }, { late: 1 }]);
    const counts = openState()
      .query("SELECT body, count(*) AS n FROM log_records WHERE stream = 'usage_events' GROUP BY body HAVING n > 1")
      .all();
    expect(counts).toEqual([]);
  });

  test("an old hook appending after the import: the new P imports once and both backups stay ok", () => {
    const P = events();
    seed(P, [{ n: 1 }, { n: 2 }]);
    expect(readRecords("usage_events", "strict").records).toEqual([{ n: 1 }, { n: 2 }]);
    seed(P, [{ n: 3 }, { n: 4 }]);
    expect(readRecords("usage_events", "strict").records).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    expect(backups(P)).toHaveLength(2);
    const imports = stateStatus().imports.filter((i) => i.store === "usage_events");
    expect(imports.map((i) => [i.state, i.backupCheck])).toEqual([
      ["verified", "ok"],
      ["verified", "ok"],
    ]);
  });

  test("a spill dir with no segment or claim is not pending", () => {
    const P = events();
    openState();
    mkdirSync(spill(P), { recursive: true });
    expect(stateStatus().streams.usage_events.pending).toBe(false);
    expect(readRecords("usage_events", "strict").records).toEqual([]);
    expect(importRows("usage_events")).toEqual([]);

    writeFileSync(join(spill(P), "x.jsonl.imported-1"), '{"n":1}\n');
    expect(stateStatus().streams.usage_events.pending).toBe(false);
    expect(readRecords("usage_events", "strict").records).toEqual([]);
    expect(importRows("usage_events")).toEqual([]);
  });

  test("a spill segment makes the stream pending in status", () => {
    const P = events();
    openState();
    seed(join(spill(P), "20260101T000000000Z-1-0.jsonl"), [{ n: 1 }]);
    expect(stateStatus().streams.usage_events.pending).toBe(true);
  });

  test("a payload file of a world not in config imports under its own name and status lists it", () => {
    seed(legacy("payload_samples", "stray"), [{ s: 1 }, { s: 2 }]);
    expect(readRecords("payload_samples", "strict", "stray").records).toEqual([{ s: 1 }, { s: 2 }]);
    const rows = openState().query("SELECT DISTINCT world FROM log_records WHERE stream = 'payload_samples'").all();
    expect(rows).toEqual([{ world: "stray" }]);
    expect(importRows("payload_samples").map((r) => [r.state, r.world])).toEqual([["verified", "stray"]]);
    expect(stateStatus().worldStreams).toContainEqual({ store: "payload_samples", world: "stray", rows: 2, quarantined: 0, pending: false });
  });

  test("a payload line that is not JSON quarantines under the file's world", () => {
    const P = legacy("payload_samples", "default");
    fsx.ensureDir(dirname(P));
    writeFileSync(P, '{"p":1}\nnot json\n');
    const error = attempt(() => readRecords("payload_samples", "strict", "default")).error;
    expect((error as Error).message).toBe('the payload samples of world "default" has 1 line that could not be imported');
    expect(readRecords("payload_samples", "counted", "default")).toEqual({ records: [{ p: 1 }], quarantined: 1 });
    expect(readRecords("payload_samples", "counted", "other")).toEqual({ records: [], quarantined: 0 });
    const q = openState().query("SELECT world FROM quarantine WHERE store = 'payload_samples'").all();
    expect(q).toEqual([{ world: "default" }]);
  });

  test("appendRecord on payload samples needs a world and writes it when the record has none", () => {
    openState();
    const error = attempt(() => appendRecord("payload_samples", { p: 1 })).error;
    expect(error).toBeInstanceOf(StateWriteError);
    expect((error as Error).message).toBe("payload samples cannot be written (world missing)");
    appendRecord("payload_samples", { p: 2 }, KOLEZKA_NFD);
    appendRecord("payload_samples", { p: 3, world: "default" }, KOLEZKA);
    expect(readRecords("payload_samples", "strict", KOLEZKA).records).toEqual([{ p: 2 }]);
    expect(readRecords("payload_samples", "strict", "default").records).toEqual([{ p: 3, world: "default" }]);
  });

  test("exportJsonl and replaceStream on payload samples touch only the named world", () => {
    appendRecord("payload_samples", { p: 1 }, "default");
    appendRecord("payload_samples", { p: 2 }, "other");
    expect(exportJsonl("payload_samples", "default")).toBe('{"p":1}\n');
    expect(replaceStream("payload_samples", '{"p":3}\n', "bundle", false, "default").written).toBe(false);
    expect(replaceStream("payload_samples", '{"p":3}\nbad\n', "bundle", true, "default")).toEqual({ written: true, imported: 1, quarantined: 1 });
    expect(readRecords("payload_samples", "counted", "default")).toEqual({ records: [{ p: 3 }], quarantined: 1 });
    expect(readRecords("payload_samples", "strict", "other").records).toEqual([{ p: 2 }]);
    expect(attempt(() => exportJsonl("payload_samples")).error).toBeInstanceOf(StateReadError);
  });

  test(
    "busy on a per-world stream: strict says the world's payload samples are being imported",
    () => {
      openState();
      seed(legacy("payload_samples", "default"), [{ p: 1 }]);
      const raw = new Database(paths.loopStateDb());
      try {
        raw.run("BEGIN IMMEDIATE");
        const error = attempt(() => readRecords("payload_samples", "strict", "default")).error;
        expect(error).toBeInstanceOf(StateReadError);
        expect((error as Error).message).toBe('the payload samples of world "default" is being imported');
      } finally {
        if (raw.inTransaction) raw.run("ROLLBACK");
        raw.close();
      }
    },
    15_000,
  );
});
