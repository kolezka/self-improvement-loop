import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fsx, paths } from "@sil/core";
import { closeState, ensureImported, openState, setImportIoForTest, type StoreName, STORES } from "../src/index.ts";
import { ImportError } from "../src/import.ts";
import { legacyWorlds } from "../src/stores.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-import-docs-"));
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

const KOLEZKA = "koleżka".normalize("NFC");
const KOLEZKA_NFD = "koleżka".normalize("NFD");

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const seedRaw = (path: string, text: string): void => {
  fsx.ensureDir(dirname(path));
  writeFileSync(path, text);
};

const backups = (path: string): string[] =>
  readdirSync(dirname(path))
    .filter((name) => name.startsWith(`${basename(path)}.imported-`))
    .sort()
    .map((name) => join(dirname(path), name));

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

interface ImportRow {
  id: number;
  store: string;
  world: string | null;
  state: string;
  backup_path: string | null;
  lines_imported: number;
  lines_quarantined: number;
  lines_blank: number;
  sha256: string | null;
  size: number | null;
  failure: string | null;
}

const importRows = (store: StoreName): ImportRow[] =>
  openState().query("SELECT * FROM legacy_imports WHERE store = ? ORDER BY id").all(store) as ImportRow[];

const docBody = (name: string, world: string): unknown => {
  const row = openState().query("SELECT body FROM docs WHERE name = ? AND world = ?").get(name, world) as { body: string } | null;
  return row ? JSON.parse(row.body) : null;
};

const aliasRows = (world: string): [string, string][] =>
  (openState().query("SELECT alias, canonical FROM aliases WHERE world = ? ORDER BY alias").all(world) as { alias: string; canonical: string }[]).map(
    (r) => [r.alias, r.canonical],
  );

interface QuarantineRow {
  store: string;
  world: string | null;
  reason: string;
  raw: string;
  import_id: number | null;
}

const quarantineRows = (store: StoreName): QuarantineRow[] =>
  openState().query("SELECT store, world, reason, raw, import_id FROM quarantine WHERE store = ? ORDER BY id").all(store) as QuarantineRow[];

const cleared = (): string => STORES.queue_cleared.legacyPath(null);

describe("legacy document import", () => {
  test("the first open imports every document kind and keeps byte-identical backups", () => {
    const seeds: { path: string; value: unknown }[] = [
      { path: cleared(), value: { default: "2026-10-01T00:00:00.000Z" } },
      { path: STORES.worker_status.legacyPath(null), value: { state: "idle", pid: 12 } },
      { path: STORES.refine_attempts.legacyPath("default"), value: { "skill-a": 1 } },
      { path: STORES.refine_attempts.legacyPath(KOLEZKA), value: { "skill-b": 2 } },
      { path: STORES.aliases.legacyPath("default"), value: { old: "new" } },
    ];
    // The NFD spelling of the world directory, built by hand: paths.* would normalize it.
    const nfd = { path: join(paths.dataDir(), "worlds", KOLEZKA_NFD, "aliases.json"), value: { a: "b", c: "d" } };
    const hashes = new Map<string, string>();
    for (const seed of [...seeds, nfd]) {
      fsx.writeJson(seed.path, seed.value);
      hashes.set(seed.path, sha256(readFileSync(seed.path)));
    }
    // Platform split (D9): the importer reads only the NFC path, as today's readers
    // do. APFS folds the NFD name onto it; ext4 (CI) does not, so there it stays put.
    const folds = existsSync(STORES.aliases.legacyPath(KOLEZKA));
    const imported = folds ? [...seeds, nfd] : seeds;

    const db = openState();

    for (const seed of imported) {
      expect(existsSync(seed.path)).toBe(false);
      expect(existsSync(`${seed.path}.importing`)).toBe(false);
      const found = backups(seed.path);
      expect(found).toHaveLength(1);
      expect(sha256(readFileSync(found[0]!))).toBe(hashes.get(seed.path)!);
    }
    const verified = db.query("SELECT store, world FROM legacy_imports WHERE state = 'verified' ORDER BY id").all() as {
      store: string;
      world: string | null;
    }[];
    expect(verified).toHaveLength(imported.length);
    expect(verified.filter((r) => r.world !== null).map((r) => [r.store, r.world])).toEqual([
      ["refine_attempts", "default"],
      ["refine_attempts", KOLEZKA],
      ["aliases", "default"],
      ...(folds ? [["aliases", KOLEZKA]] : []),
    ]);
    expect((db.query("SELECT count(*) AS n FROM docs").get() as { n: number }).n).toBe(4);
    expect(docBody("queue_cleared", "")).toEqual({ default: "2026-10-01T00:00:00.000Z" });
    expect(docBody("worker_status", "")).toEqual({ state: "idle", pid: 12 });
    expect(docBody("refine_attempts", "default")).toEqual({ "skill-a": 1 });
    expect(docBody("refine_attempts", KOLEZKA)).toEqual({ "skill-b": 2 });
    expect(aliasRows("default")).toEqual([["old", "new"]]);
    if (folds) {
      expect(aliasRows(KOLEZKA)).toEqual([
        ["a", "b"],
        ["c", "d"],
      ]);
    } else {
      expect(sha256(readFileSync(nfd.path))).toBe(hashes.get(nfd.path)!);
      expect(existsSync(`${nfd.path}.importing`)).toBe(false);
      expect(backups(nfd.path)).toHaveLength(0);
      expect(importRows("aliases").filter((r) => r.world === KOLEZKA)).toHaveLength(0);
      expect(aliasRows(KOLEZKA)).toEqual([]);
    }
  });

  test("a non-object document and a non-JSON document each land as one quarantine row with their world", () => {
    const array = STORES.refine_attempts.legacyPath("default");
    const broken = STORES.refine_attempts.legacyPath("beta");
    seedRaw(array, "[1,2]\n");
    seedRaw(broken, "{ not json");

    openState();

    expect(quarantineRows("refine_attempts").map((r) => [r.world, r.reason, r.raw])).toEqual([
      ["beta", "not JSON", "{ not json"],
      ["default", "not a JSON object", "[1,2]\n"],
    ]);
    expect((openState().query("SELECT count(*) AS n FROM docs").get() as { n: number }).n).toBe(0);
    const rows = importRows("refine_attempts");
    expect(rows.map((r) => [r.world, r.state, r.lines_imported, r.lines_quarantined, r.lines_blank])).toEqual([
      ["beta", "verified", 0, 1, 0],
      ["default", "verified", 0, 1, 0],
    ]);
    expect(quarantineRows("refine_attempts").map((r) => r.import_id)).toEqual(rows.map((r) => r.id));
    expect(backups(array)).toHaveLength(1);
    expect(backups(broken)).toHaveLength(1);
    expect(existsSync(array)).toBe(false);
  });

  test("an aliases file that chains quarantines with the one-hop message and inserts no row", () => {
    const p = STORES.aliases.legacyPath("default");
    fsx.writeJson(p, { a: "b", b: "c" });
    const seeded = readFileSync(p);

    openState();

    expect(aliasRows("default")).toEqual([]);
    expect(quarantineRows("aliases").map((r) => [r.world, r.reason])).toEqual([
      ["default", '"b" is a key (-> "c") and also the value of "a" (-> "b"); aliases resolve one hop only'],
    ]);
    const found = backups(p);
    expect(found).toHaveLength(1);
    expect(readFileSync(found[0]!)).toEqual(seeded);
  });

  test("an aliases file with a non-slug value quarantines with the strict reader's message", () => {
    fsx.writeJson(STORES.aliases.legacyPath("default"), { a: "Not A Slug" });

    openState();

    expect(aliasRows("default")).toEqual([]);
    expect(quarantineRows("aliases").map((r) => [r.world, r.reason])).toEqual([
      ["default", 'the aliases of world "default" hold an entry that is not two pattern names'],
    ]);
  });

  test("an aliases file that is not a map quarantines with the strict reader's message", () => {
    fsx.writeJson(STORES.aliases.legacyPath("default"), ["a", "b"]);

    openState();

    expect(quarantineRows("aliases").map((r) => r.reason)).toEqual(['the aliases of world "default" are not a map of names']);
  });

  test("an aliases import replaces that world's rows and leaves other worlds alone", () => {
    fsx.writeJson(STORES.aliases.legacyPath("default"), { old: "new", x: "y" });
    fsx.writeJson(STORES.aliases.legacyPath("beta"), { p: "q" });
    openState();
    fsx.writeJson(STORES.aliases.legacyPath("default"), { other: "thing" });

    const outcomes = ensureImported({ store: "aliases", world: "default" });

    expect(outcomes.map((o) => [o.store, o.world, o.imported, o.quarantined, o.blank])).toEqual([["aliases", "default", 1, 0, 0]]);
    expect(aliasRows("default")).toEqual([["other", "thing"]]);
    expect(aliasRows("beta")).toEqual([["p", "q"]]);
  });

  test("a spill document after import replaces the row and leaves a second backup", () => {
    const p = cleared();
    fsx.writeJson(p, { default: "first" });
    const first = sha256(readFileSync(p));
    openState();
    fsx.writeJson(p, { default: "second" });

    const outcomes = ensureImported({ store: "queue_cleared", world: null });

    expect(outcomes.map((o) => [o.store, o.world, o.imported])).toEqual([["queue_cleared", null, 1]]);
    expect(docBody("queue_cleared", "")).toEqual({ default: "second" });
    const found = backups(p);
    expect(found).toHaveLength(2);
    const rows = importRows("queue_cleared");
    expect(rows).toHaveLength(2);
    const firstRow = rows[0]!;
    expect(sha256(readFileSync(firstRow.backup_path!))).toBe(firstRow.sha256!);
    expect(firstRow.sha256).toBe(first);
  });

  test("a claimed document whose size changed after commit records failed and keeps the first body", () => {
    const p = cleared();
    fsx.writeJson(p, { default: "first" });
    const seeded = readFileSync(p);
    openState();
    // The state a crash between COMMIT and the backup rename leaves.
    const [backup] = backups(p);
    const claim = `${p}.importing`;
    renameSync(backup!, claim);
    const ino = statSync(claim).ino;
    writeFileSync(claim, Buffer.concat([seeded, Buffer.from('{"n":2}\n')]));
    expect(statSync(claim).ino).toBe(ino);

    const error = caught(() => ensureImported({ store: "queue_cleared", world: null }));

    const failed = importRows("queue_cleared").filter((r) => r.state === "failed");
    expect(failed.map((r) => r.failure)).toEqual(["claimed file changed after import"]);
    expect(error).toBeInstanceOf(ImportError);
    expect((error as ImportError).reason).toBe("claimed file changed after import");
    expect(docBody("queue_cleared", "")).toEqual({ default: "first" });
    expect(existsSync(claim)).toBe(true);
    expect((openState().query("SELECT count(*) AS n FROM log_records").get() as { n: number }).n).toBe(0);
  });

  test("a claimed document that grows before the finalize stat records failed, with no tail import", () => {
    const p = cleared();
    const claim = `${p}.importing`;
    fsx.writeJson(p, { default: "first" });
    let claimRead = false;
    let grown = false;
    setImportIoForTest({
      stat: (path) => {
        if (path === claim && claimRead && !grown) {
          grown = true;
          appendFileSync(claim, '{"n":2}\n');
        }
        return statSync(path);
      },
      rename: (from, to) => renameSync(from, to),
      readFile: (path) => {
        if (path === claim) claimRead = true;
        return readFileSync(path);
      },
    });

    const error = caught(() => openState());

    expect(error).toBeNull();
    expect(grown).toBe(true);
    const rows = importRows("queue_cleared");
    expect(rows.map((r) => [r.state, r.failure])).toEqual([
      ["verified", null],
      ["failed", "claimed file changed after import"],
    ]);
    expect(existsSync(claim)).toBe(true);
    expect((openState().query("SELECT count(*) AS n FROM log_records").get() as { n: number }).n).toBe(0);
  });

  test("a legacy file for a world not in config imports under its own name", () => {
    fsx.writeJson(STORES.refine_attempts.legacyPath("stray"), { "skill-s": 3 });
    expect(legacyWorlds("refine_attempts")).toEqual(["stray"]);

    openState();

    expect(docBody("refine_attempts", "stray")).toEqual({ "skill-s": 3 });
    expect(importRows("refine_attempts").map((r) => [r.world, r.state])).toEqual([["stray", "verified"]]);
  });

  test("legacyWorlds skips backups and dot names and reports a claim by its world", () => {
    const dir = join(paths.stateDir(), "curriculum", "refine-attempts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "default.json.imported-x-1"), "{}");
    writeFileSync(join(dir, "default.json.importing"), "{}");
    writeFileSync(join(dir, ".DS_Store"), "");

    expect(legacyWorlds("refine_attempts")).toEqual(["default"]);
  });

  test(
    "busy: a held write lock makes ensureImported throw a busy ImportError within about 2.5 s",
    () => {
      openState();
      fsx.writeJson(cleared(), { default: "x" });
      const raw = new Database(paths.loopStateDb());
      try {
        raw.run("BEGIN IMMEDIATE");
        const started = performance.now();
        const error = caught(() => ensureImported({ store: "queue_cleared", world: null }));
        const elapsed = performance.now() - started;
        expect(error).toBeInstanceOf(ImportError);
        expect((error as ImportError).busy).toBe(true);
        expect(elapsed).toBeLessThan(2500);
      } finally {
        if (raw.inTransaction) raw.run("ROLLBACK");
        raw.close();
      }
      expect(existsSync(cleared())).toBe(true);
    },
    15_000,
  );
});
