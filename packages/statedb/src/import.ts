// Import of a legacy file into the loop state, one transaction per file
// (design D6): JSONL streams into log_records, documents into docs, alias
// maps into aliases. SQLite's write lock is the only mutex: no lease, no cursor.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertOneHop, fsx, isSlug, StateReadError, StateWriteError, ValidationError } from "@sil/core";
import { openState, openStateReporting } from "./open.ts";
import { listSpillSegments, spillDir } from "./spill.ts";
import { legacyWorlds, type StoreName, type StoreRef, STORES } from "./stores.ts";
import type { Stream } from "./streams.ts";

export interface ImportStat {
  size: number;
  dev: number;
  ino: number;
}

/** The importer's only filesystem calls. Tests wrap it to crash or append at an exact step. */
export interface ImportIo {
  stat(path: string): ImportStat;
  rename(from: string, to: string): void;
  readFile(path: string): Buffer;
}

const REAL_IMPORT_IO: ImportIo = {
  stat: (path) => statSync(path),
  rename: (from, to) => renameSync(from, to),
  readFile: (path) => readFileSync(path),
};

let importIo: ImportIo = REAL_IMPORT_IO;

/** The legacy-file calls in use; the export's temp files go through them too. */
export const legacyIo = (): ImportIo => importIo;

/** Swap the importer's filesystem calls; null restores node:fs. */
export function setImportIoForTest(io: ImportIo | null): void {
  importIo = io ?? REAL_IMPORT_IO;
}

export interface ImportOutcome {
  store: StoreName;
  world: string | null;
  imported: number;
  quarantined: number;
  blank: number;
  backupPath: string;
}

export interface ImportFailure {
  store: StoreName;
  world: string | null;
  message: string;
}

export interface ImportAllResult {
  outcomes: ImportOutcome[];
  failures: ImportFailure[];
}

const labelOf = (ref: StoreRef): string => STORES[ref.store].label(ref.world);

/** An import that did not finish. `busy` means another process held the write
 * lock past the busy timeout; otherwise a `failed` row was recorded. */
export class ImportError extends StateWriteError {
  readonly store: StoreName;
  readonly world: string | null;

  constructor(
    ref: StoreRef,
    readonly reason: string,
    readonly busy: boolean,
  ) {
    super(busy ? `${labelOf(ref)} is being imported` : `${labelOf(ref)} cannot be imported (${reason})`);
    this.store = ref.store;
    this.world = ref.world;
  }
}

/** A refusal with a fixed reason, recorded as the `failure` text. */
class Refused extends Error {}

const CHANGED = "claimed file changed after import";
const RAW_CAP_BYTES = 64 * 1024;

/** A quarantined line's raw text, cut to the first 64 KiB. */
export const capRaw = (piece: string): string =>
  Buffer.byteLength(piece) > RAW_CAP_BYTES ? Buffer.from(piece).subarray(0, RAW_CAP_BYTES).toString("utf8") : piece;

const sqliteCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
};

export const isBusy = (error: unknown): boolean => sqliteCode(error).startsWith("SQLITE_BUSY");

/** A short, path-free reason. Our own error messages carry no paths by rule;
 * node:fs messages do, so for anything else only the code is kept. */
export function reasonOf(error: unknown): string {
  if (error instanceof ImportError) return error.reason;
  if (error instanceof Refused || error instanceof StateReadError || error instanceof StateWriteError) return error.message;
  const code = sqliteCode(error);
  if (code) return code;
  return error instanceof Error ? error.name : "unknown error";
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const stampNow = (): string => new Date().toISOString().replace(/[:.]/g, "");

function statOrNull(path: string): ImportStat | null {
  try {
    return importIo.stat(path);
  } catch (error) {
    if (fsx.errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** Set by `sil state export --legacy-paths` (design D14); `sil state migrate` clears it. */
export const SUSPENDED_KEY = "legacy_import_suspended";

/** The export time while legacy imports are suspended, else null. */
export function importSuspendedAt(db: Database): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(SUSPENDED_KEY) as { value: string } | null;
  return row?.value ?? null;
}

const originalPath = (ref: StoreRef): string => STORES[ref.store].legacyPath(ref.world);
const claimPath = (ref: StoreRef): string => `${originalPath(ref)}.importing`;

/** One file the importer claims: the old path `P` or a sealed segment of it
 * (D5). `original` is the row's `original_path`; backups always sit next to `P`. */
interface Claimable {
  original: string;
  claim: string;
  backupBase: string;
}

const mainClaimable = (ref: StoreRef): Claimable => ({ original: originalPath(ref), claim: claimPath(ref), backupBase: originalPath(ref) });

/** A segment of `P` by its path inside the spill dir, without `.importing`. */
const segmentClaimable = (ref: StoreRef, segment: string): Claimable => ({
  original: segment,
  claim: `${segment}.importing`,
  backupBase: originalPath(ref),
});

/** Only a JSONL stream grows by appends. Every writer renames a document into
 * place whole, so a claimed document of another size is a changed file. */
const growsByAppend = (ref: StoreRef): boolean => STORES[ref.store].kind === "stream";

/** The `world` key of a `docs` or `aliases` row: '' for a global document. */
const rowWorld = (ref: StoreRef): string => ref.world ?? "";

/** The D6 pending check: two stats, plus the spill dir for a stream (D5). No database access. */
function isPending(ref: StoreRef): boolean {
  try {
    if (statOrNull(originalPath(ref)) !== null || statOrNull(claimPath(ref)) !== null) return true;
    if (!growsByAppend(ref)) return false;
    const { segments, claims } = listSpillSegments(originalPath(ref));
    return segments.length > 0 || claims.length > 0;
  } catch (error) {
    throw new ImportError(ref, reasonOf(error), false);
  }
}

function rollback(db: Database): void {
  if (db.inTransaction) db.run("ROLLBACK");
}

function begin(db: Database, ref: StoreRef): void {
  try {
    db.run("BEGIN IMMEDIATE");
  } catch (error) {
    if (isBusy(error)) throw new ImportError(ref, "busy", true);
    throw new ImportError(ref, reasonOf(error), false);
  }
}

interface ImportRow {
  id: number;
  backup_path: string | null;
  size: number;
  sha256: string;
  dev: number;
  ino: number;
}

interface Counts {
  imported: number;
  quarantined: number;
  blank: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Steps 4 and 5 for the bytes from `offset` on: every nonempty line becomes a
 * row in file order or a quarantine row. `firstLineNo` is the number of lines before `offset`. */
function importLines(db: Database, ref: StoreRef, importId: number, source: string, bytes: Buffer, offset: number, firstLineNo: number): Counts {
  const stream = ref.store as Stream;
  const pieces = bytes.subarray(offset).toString("utf8").split("\n");
  if (pieces.at(-1) === "") pieces.pop();
  const now = new Date().toISOString();
  const insert = db.query("INSERT INTO log_records (stream, ts, world, body, recorded_at, import_id) VALUES (?, ?, ?, ?, ?, ?)");
  // A bad line has no trusted world of its own: a global stream's quarantine row
  // has none, a per-world stream's gets the world of the file.
  const quarantine = db.query(
    "INSERT INTO quarantine (store, world, source, import_id, line_no, reason, raw, quarantined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const counts: Counts = { imported: 0, quarantined: 0, blank: 0 };
  const reject = (piece: string, lineNo: number, reason: string): void => {
    quarantine.run(stream, ref.world, source, importId, lineNo, reason, capRaw(piece), now);
    counts.quarantined += 1;
  };
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const lineNo = firstLineNo + i + 1;
    const text = piece.trim();
    if (!text) {
      counts.blank += 1;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      reject(piece, lineNo, "not JSON");
      continue;
    }
    if (!isRecord(value)) {
      reject(piece, lineNo, "not a JSON object");
      continue;
    }
    const ts = typeof value["ts"] === "string" ? value["ts"] : null;
    const world = typeof value["world"] === "string" ? value["world"].normalize("NFC") : ref.world;
    try {
      insert.run(stream, ts, world, text, now, importId);
      counts.imported += 1;
    } catch (error) {
      // A constraint failure aborts only this statement, not the transaction.
      if (!sqliteCode(error).startsWith("SQLITE_CONSTRAINT")) throw error;
      reject(piece, lineNo, "rejected by the database");
    }
  }
  if (counts.imported + counts.quarantined + counts.blank !== pieces.length) throw new Refused("line count mismatch");
  return counts;
}

/** One quarantine row for a whole document or aliases file. */
function quarantineFile(db: Database, ref: StoreRef, importId: number, source: string, reason: string, text: string): Counts {
  db.query(
    "INSERT INTO quarantine (store, world, source, import_id, line_no, reason, raw, quarantined_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
  ).run(ref.store, ref.world, source, importId, reason, capRaw(text), new Date().toISOString());
  return { imported: 0, quarantined: 1, blank: 0 };
}

/** Step 4 for a document: the whole file becomes its `docs` row, replacing the
 * one for its name and world, or one quarantine row. */
function importDoc(db: Database, ref: StoreRef, importId: number, source: string, bytes: Buffer): Counts {
  const text = bytes.toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return quarantineFile(db, ref, importId, source, "not JSON", text);
  }
  if (!isRecord(value)) return quarantineFile(db, ref, importId, source, "not a JSON object", text);
  db.query(
    `INSERT INTO docs (name, world, body, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (name, world) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
  ).run(ref.store, rowWorld(ref), JSON.stringify(value), new Date().toISOString());
  return { imported: 1, quarantined: 0, blank: 0 };
}

/** The pairs of an aliases file under today's strict rules
 * (`loadAliasesStrict`) and the one-hop rule, or the reason it fails them. */
function aliasPairs(ref: StoreRef, text: string): [string, string][] | string {
  const label = labelOf(ref);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "not JSON";
  }
  if (!isRecord(raw)) return `${label} are not a map of names`;
  const pairs: Record<string, string> = {};
  for (const [alias, canonical] of Object.entries(raw)) {
    if (typeof canonical !== "string" || !isSlug(alias) || !isSlug(canonical)) return `${label} hold an entry that is not two pattern names`;
    pairs[alias] = canonical;
  }
  try {
    assertOneHop(pairs);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return error.message;
  }
  return Object.entries(pairs);
}

/** Step 4 for aliases: a file that passes replaces every row of its world; one
 * that fails is quarantined whole and no pair is imported. */
function importAliases(db: Database, ref: StoreRef, importId: number, source: string, bytes: Buffer): Counts {
  const text = bytes.toString("utf8");
  const pairs = aliasPairs(ref, text);
  if (typeof pairs === "string") return quarantineFile(db, ref, importId, source, pairs, text);
  const world = rowWorld(ref);
  db.query("DELETE FROM aliases WHERE world = ?").run(world);
  const insert = db.query("INSERT INTO aliases (world, alias, canonical) VALUES (?, ?, ?)");
  for (const [alias, canonical] of pairs) insert.run(world, alias, canonical);
  return { imported: pairs.length, quarantined: 0, blank: 0 };
}

/** Step 4 for the whole claimed file, by store kind. */
function importBody(db: Database, ref: StoreRef, importId: number, source: string, bytes: Buffer): Counts {
  switch (STORES[ref.store].kind) {
    case "stream":
      return importLines(db, ref, importId, source, bytes, 0, 0);
    case "doc":
      return importDoc(db, ref, importId, source, bytes);
    case "aliases":
      return importAliases(db, ref, importId, source, bytes);
  }
}

function countNewlines(bytes: Buffer, end: number): number {
  let n = 0;
  for (let at = bytes.indexOf(0x0a); at !== -1 && at < end; at = bytes.indexOf(0x0a, at + 1)) n += 1;
  return n;
}

/** Import the bytes past a verified row's size and grow the row to cover them. Streams only. */
function importTail(db: Database, ref: StoreRef, row: ImportRow, bytes: Buffer): Counts {
  if (!row.backup_path) throw new Refused("verified import has no backup name");
  if (sha256(bytes.subarray(0, row.size)) !== row.sha256) throw new Refused(CHANGED);
  const counts = importLines(db, ref, row.id, row.backup_path, bytes, row.size, countNewlines(bytes, row.size));
  db.query(
    `UPDATE legacy_imports SET size = ?, sha256 = ?, lines_imported = lines_imported + ?,
       lines_quarantined = lines_quarantined + ?, lines_blank = lines_blank + ?, verified_at = ? WHERE id = ?`,
  ).run(bytes.length, sha256(bytes), counts.imported, counts.quarantined, counts.blank, new Date().toISOString(), row.id);
  return counts;
}

/** Step 2 for a claim left by a crash, or steps 4 and 5 for a fresh claim. */
function importClaim(db: Database, ref: StoreRef, target: Claimable, claim: ImportStat, startedAt: string): { row: ImportRow; counts: Counts } {
  const bytes = importIo.readFile(target.claim);
  const original = target.original;
  const backupName = (id: number): string => `${target.backupBase}.imported-${stampNow()}-${id}`;
  const known = db
    .query(
      `SELECT id, backup_path, size, sha256, dev, ino FROM legacy_imports
       WHERE store = ? AND world IS ? AND dev = ? AND ino = ? AND state = 'verified' ORDER BY id DESC LIMIT 1`,
    )
    .get(ref.store, ref.world, claim.dev, claim.ino) as ImportRow | null;
  if (known) {
    // An export row (D14) has no backup yet; it gets one the way a fresh import does.
    if (!known.backup_path) {
      known.backup_path = backupName(known.id);
      db.query("UPDATE legacy_imports SET backup_path = ? WHERE id = ?").run(known.backup_path, known.id);
    }
    if (known.size === bytes.length && known.sha256 === sha256(bytes)) return { row: known, counts: { imported: 0, quarantined: 0, blank: 0 } };
    if (growsByAppend(ref) && known.size < bytes.length) return { row: known, counts: importTail(db, ref, known, bytes) };
    throw new Refused(CHANGED);
  }
  const { id } = db
    .query(
      "INSERT INTO legacy_imports (store, world, original_path, state, dev, ino, started_at) VALUES (?, ?, ?, 'verified', ?, ?, ?) RETURNING id",
    )
    .get(ref.store, ref.world, original, claim.dev, claim.ino, startedAt) as { id: number };
  const backupPath = backupName(id);
  const counts = importBody(db, ref, id, backupPath, bytes);
  const digest = sha256(bytes);
  db.query(
    `UPDATE legacy_imports SET backup_path = ?, lines_imported = ?, lines_quarantined = ?, lines_blank = ?,
       sha256 = ?, size = ?, verified_at = ? WHERE id = ?`,
  ).run(backupPath, counts.imported, counts.quarantined, counts.blank, digest, bytes.length, new Date().toISOString(), id);
  return { row: { id, backup_path: backupPath, size: bytes.length, sha256: digest, dev: claim.dev, ino: claim.ino }, counts };
}

/** Roll back, record a `failed` row in its own transaction, and throw. */
function fail(db: Database, ref: StoreRef, error: unknown, claim: ImportStat | null, startedAt: string, original = originalPath(ref)): never {
  rollback(db);
  if (error instanceof ImportError) throw error;
  if (isBusy(error)) throw new ImportError(ref, "busy", true);
  const reason = reasonOf(error);
  recordFailure(db, ref, reason, claim, startedAt, original);
  throw new ImportError(ref, reason, false);
}

/** A `failed` row in its own transaction. */
function recordFailure(db: Database, ref: StoreRef, reason: string, claim: ImportStat | null, startedAt: string, original = originalPath(ref)): void {
  try {
    db.run("BEGIN IMMEDIATE");
    db.query(
      "INSERT INTO legacy_imports (store, world, original_path, state, failure, dev, ino, started_at) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)",
    ).run(ref.store, ref.world, original, reason, claim?.dev ?? null, claim?.ino ?? null, startedAt);
    db.run("COMMIT");
  } catch {
    // The row is only history for `sil state status`; the import failure the caller throws is what it sees.
    rollback(db);
  }
}

/** Step 6: under the lock, import whatever a stream grew past the row, else
 * rename the claim to its backup. */
function finalize(db: Database, ref: StoreRef, target: Claimable, rowId: number, counts: Counts): string {
  const claim = target.claim;
  for (;;) {
    const startedAt = new Date().toISOString();
    begin(db, ref);
    let current: ImportStat | null = null;
    try {
      const row = db.query("SELECT id, backup_path, size, sha256, dev, ino FROM legacy_imports WHERE id = ?").get(rowId) as ImportRow;
      if (!row.backup_path) throw new Refused("verified import has no backup name");
      current = statOrNull(claim);
      if (!current) {
        if (!statOrNull(row.backup_path)) throw new Refused("claimed file and backup are missing");
        db.run("COMMIT");
        return row.backup_path;
      }
      if (current.dev !== row.dev || current.ino !== row.ino) {
        // Another importer finished this claim and reused its name.
        db.run("COMMIT");
        return row.backup_path;
      }
      if (current.size !== row.size) {
        if (!growsByAppend(ref) || current.size < row.size) throw new Refused(CHANGED);
        const more = importTail(db, ref, row, importIo.readFile(claim));
        counts.imported += more.imported;
        counts.quarantined += more.quarantined;
        counts.blank += more.blank;
        db.run("COMMIT");
        continue;
      }
      if (statOrNull(row.backup_path)) throw new Refused("import backup already exists");
      importIo.rename(claim, row.backup_path);
      db.run("COMMIT");
      return row.backup_path;
    } catch (error) {
      fail(db, ref, error, current, startedAt, target.original);
    }
  }
}

/** Run the D6 import for one store on `db`. Handles a claim left by a crash
 * first, then a stream's sealed segments, then the old path once; a spill
 * created after that waits for the next check. */
export function importStoreOn(db: Database, ref: StoreRef): ImportOutcome[] {
  const { outcomes, error } = importCollecting(db, ref);
  if (error) throw error;
  return outcomes;
}

/** importStoreOn for a global JSONL stream. */
export function importStreamOn(db: Database, stream: Stream): ImportOutcome[] {
  return importStoreOn(db, { store: stream, world: null });
}

/** importStoreOn, but a failure comes back next to the outcomes already
 * committed in this call (a leftover claim can import before the old path fails). */
function importCollecting(db: Database, ref: StoreRef): { outcomes: ImportOutcome[]; error: ImportError | null } {
  const outcomes: ImportOutcome[] = [];
  try {
    importPasses(db, ref, outcomes);
    return { outcomes, error: null };
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    return { outcomes, error };
  }
}

/** D5 import order for one store: a leftover claim of `P`; for a stream, each
 * segment claim a crash left, then each sealed segment in name order (oldest
 * first); then `P`. Stops early when legacy imports are suspended. */
function importPasses(db: Database, ref: StoreRef, outcomes: ImportOutcome[]): void {
  const main = mainClaimable(ref);
  if (!importOne(db, ref, main, true, outcomes)) return;
  if (growsByAppend(ref)) {
    const dir = spillDir(main.original);
    let listed: { segments: string[]; claims: string[] };
    try {
      listed = listSpillSegments(main.original);
    } catch (error) {
      fail(db, ref, error, null, new Date().toISOString());
    }
    for (const name of listed.claims) {
      if (!importOne(db, ref, segmentClaimable(ref, join(dir, name.slice(0, -".importing".length))), true, outcomes)) return;
    }
    for (const name of listed.segments) {
      if (!importOne(db, ref, segmentClaimable(ref, join(dir, name)), false, outcomes)) return;
    }
  }
  importOne(db, ref, main, false, outcomes);
}

/** Import one file: a claim already in place (a crash left it, or another
 * importer is finalizing it), else, unless `claimOnly`, the file claimed by
 * rename. False when legacy imports are suspended. */
function importOne(db: Database, ref: StoreRef, target: Claimable, claimOnly: boolean, outcomes: ImportOutcome[]): boolean {
  const startedAt = new Date().toISOString();
  begin(db, ref);
  let claim: ImportStat | null = null;
  let result: { row: ImportRow; counts: Counts };
  try {
    // Checked under the write lock, so an export that commits first always wins.
    if (importSuspendedAt(db) !== null) {
      db.run("COMMIT");
      return false;
    }
    claim = statOrNull(target.claim);
    if (!claim) {
      if (claimOnly || !claimByRename(target)) {
        db.run("COMMIT");
        return true;
      }
      claim = importIo.stat(target.claim);
    }
    result = importClaim(db, ref, target, claim, startedAt);
    db.run("COMMIT");
  } catch (error) {
    fail(db, ref, error, claim, startedAt, target.original);
  }
  const backupPath = finalize(db, ref, target, result.row.id, result.counts);
  outcomes.push({ store: ref.store, world: ref.world, ...result.counts, backupPath });
  return true;
}

/** Claim a file by rename. ENOENT means it is gone (a hook sealed `P`, the
 * spill bound unlinked a segment, or there was nothing): nothing pending now. */
function claimByRename(target: Claimable): boolean {
  try {
    importIo.rename(target.original, target.claim);
    return true;
  } catch (error) {
    if (fsx.errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** Global stores in import order: the streams, then the global documents.
 * A function, not a constant: stores.ts and this module import each other. */
const globalStores = (): StoreName[] => (Object.keys(STORES) as StoreName[]).filter((store) => !STORES[store].perWorld);
const PER_WORLD_STORES = ["refine_attempts", "aliases", "payload_samples"] as const;

// The payload corpus (loadPayloadCorpus) and the bundle still read payloads/<w>.jsonl until the next task,
// so first open and sil state migrate skip it; ensureImported stays ungated.
export const FIRST_OPEN_DEFERRED: ReadonlySet<StoreName> = new Set(["payload_samples"]);

/** Import one store into `result`, collecting its failure instead of throwing. */
function importInto(db: Database, ref: StoreRef, result: ImportAllResult): void {
  try {
    let pending: boolean;
    try {
      pending = isPending(ref);
    } catch (error) {
      // No stat succeeded, so the row has no dev or ino.
      recordFailure(db, ref, (error as ImportError).reason, null, new Date().toISOString());
      throw error;
    }
    if (!pending) return;
    const collected = importCollecting(db, ref);
    result.outcomes.push(...collected.outcomes);
    if (collected.error) throw collected.error;
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    result.failures.push({ store: ref.store, world: ref.world, message: error.message });
  }
}

/** The first-open import (design D4): streams, then global documents, then
 * every world with a legacy refine attempts, aliases or payload samples file. A failure here
 * never fails the open: it is recorded, and the next store access retries. */
export function importAllOn(db: Database): ImportAllResult {
  const result: ImportAllResult = { outcomes: [], failures: [] };
  if (importSuspendedAt(db) !== null) return result;
  for (const store of globalStores()) importInto(db, { store, world: null }, result);
  for (const store of PER_WORLD_STORES) {
    if (FIRST_OPEN_DEFERRED.has(store)) continue;
    let worlds: string[];
    try {
      worlds = legacyWorlds(store);
    } catch (error) {
      // No world is known, so there is no legacy path to record a row for.
      result.failures.push({ store, world: null, message: `the legacy ${store} files cannot be listed (${fsx.errnoCode(error) || reasonOf(error)})` });
      continue;
    }
    for (const world of worlds) importInto(db, { store, world }, result);
  }
  return result;
}

/** Import the store's legacy file when the pending check finds one. [] when nothing was pending. */
export function ensureImported(ref: StoreRef): ImportOutcome[] {
  if (!isPending(ref)) return [];
  return importStoreOn(openState(), ref);
}

/** Import every store (see importAllOn), collecting failures instead of
 * throwing. When this call is the one that opens the database, the import
 * that first open ran is this call's result. */
export function importAll(): ImportAllResult {
  let opened: ReturnType<typeof openStateReporting>;
  try {
    opened = openStateReporting();
  } catch (error) {
    const failures = globalStores().map((store) => ({
      store,
      world: null,
      message: `${labelOf({ store, world: null })} cannot be imported (${reasonOf(error)})`,
    }));
    return { outcomes: [], failures };
  }
  return opened.firstOpen ?? importAllOn(opened.db);
}
