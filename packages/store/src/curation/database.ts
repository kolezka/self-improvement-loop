// Private curation database: lifecycle, identity and schema. One SQLite file
// plus an identity marker under <dataDir>/curation. Inspection never writes.
// Initialization runs only on an explicit request and never repairs or
// replaces inconsistent state on its own.

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { paths } from "@sil/core";
import { CurationError, SHA256_HEX_RE, UUID_RE } from "@sil/core/lesson-curation";
import type { CurationErrorCode, CurationPrecondition, StoreBinding } from "@sil/core/lesson-curation";

export const CURATION_SCHEMA_VERSION = 1;
export const CURATION_BUSY_TIMEOUT_MS = 1000;
const MARKER_FORMAT = "sil-curation-identity";
const MAX_MARKER_BYTES = 4096;
// How long an opener waits for another process's initialization guard. The
// guard is never removed on elapsed time: after this the open fails busy.
const GUARD_WAIT_MS = 2000;
const GUARD_POLL_MS = 20;

export const curationDir = (): string => join(paths.dataDir(), "curation");
export const curationIdentityFile = (): string => join(curationDir(), "identity.json");
export const curationDatabaseFile = (): string => join(curationDir(), "curation.sqlite");
export const curationGuardFile = (): string => join(curationDir(), "init.lock");

/** Why a store is not usable. Safe to show: no paths, no values. */
export type StoreProblem =
  | "uninitialized"
  | "initialization_guard_held"
  | "initialization_interrupted"
  | "database_missing"
  | "database_without_marker"
  | "marker_invalid"
  | "database_invalid"
  | "identity_mismatch"
  | "unsupported_schema"
  | "unsupported_filesystem"
  | "insecure_permissions"
  | "unsafe_path"
  | "settings_unverified"
  | "storage_busy"
  | "unreadable";

export type StoreStatus =
  | { state: "uninitialized"; binding: { kind: "location"; id: string } }
  | { state: "ready"; binding: { kind: "installation"; id: string }; schemaVersion: typeof CURATION_SCHEMA_VERSION }
  | { state: "error"; code: CurationErrorCode; problem: StoreProblem; recoveryRequired: boolean };

/** A CurationError that also names the store problem. */
export class CurationStoreError extends CurationError {
  override name = "CurationStoreError";
  constructor(
    code: CurationErrorCode,
    public readonly problem: StoreProblem,
  ) {
    super(code, [problem]);
  }
}

// Problems a human must resolve by hand. Busy and unsupported placement are
// conditions, not damaged state.
const RECOVERY: ReadonlySet<StoreProblem> = new Set([
  "initialization_guard_held",
  "initialization_interrupted",
  "database_missing",
  "database_without_marker",
  "marker_invalid",
  "database_invalid",
  "identity_mismatch",
  "insecure_permissions",
  "unsafe_path",
]);

function fail(code: CurationErrorCode, problem: StoreProblem): never {
  throw new CurationStoreError(code, problem);
}

export interface CurationDatabase {
  readonly sqlite: Database;
  readonly installationId: string;
  /** curationLocationId() of the data directory this handle was opened at. */
  readonly locationId: string;
  close(): void;
}

// --- schema --------------------------------------------------------------

// Legacy inbox ids may hold controls or lone surrogates, which bun:sqlite
// binds lossily. Every id column stores JSON.stringify(id), which is ASCII
// safe for those units and decodes back exactly.
const SCHEMA_V1 = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE records (
  world TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('capture', 'inbox')),
  id_json TEXT NOT NULL CHECK (json_valid(id_json) AND json_type(id_json) = 'text'),
  project_kind TEXT NOT NULL CHECK (project_kind IN ('project', 'world', 'unresolved')),
  project_id TEXT CHECK ((project_kind = 'project') = (project_id IS NOT NULL)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  important INTEGER NOT NULL DEFAULT 0 CHECK (important IN (0, 1)),
  text TEXT,
  original_text TEXT,
  source_json TEXT CHECK (source_json IS NULL OR json_valid(source_json)),
  baseline_digest TEXT,
  purged INTEGER NOT NULL DEFAULT 0 CHECK (purged IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world, kind, id_json),
  CHECK (purged = 0 OR (text IS NULL AND original_text IS NULL AND source_json IS NULL
    AND baseline_digest IS NULL AND important = 0))
) STRICT;

CREATE INDEX records_by_scope ON records (world, project_kind, project_id);

CREATE TRIGGER records_identity_immutable
BEFORE UPDATE OF world, kind, id_json, project_kind, project_id, created_at ON records
WHEN OLD.world IS NOT NEW.world OR OLD.kind IS NOT NEW.kind OR OLD.id_json IS NOT NEW.id_json
  OR OLD.project_kind IS NOT NEW.project_kind OR OLD.project_id IS NOT NEW.project_id
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'curation record identity and scope are immutable');
END;

CREATE TRIGGER records_purge_final
BEFORE UPDATE OF purged ON records
WHEN OLD.purged = 1 AND NEW.purged = 0
BEGIN
  SELECT RAISE(ABORT, 'purged curation record cannot be restored');
END;

CREATE TABLE revisions (
  world TEXT NOT NULL,
  kind TEXT NOT NULL,
  id_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('capture', 'edit', 'important', 'acknowledge-source', 'purge')),
  at TEXT NOT NULL,
  text TEXT,
  important INTEGER CHECK (important IS NULL OR important IN (0, 1)),
  old_source_digest TEXT,
  new_source_digest TEXT,
  PRIMARY KEY (world, kind, id_json, revision),
  FOREIGN KEY (world, kind, id_json) REFERENCES records (world, kind, id_json)
) STRICT;

CREATE TABLE requests (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) = 39 AND substr(request_id, 1, 3) = 'lc_'),
  world TEXT NOT NULL,
  kind TEXT NOT NULL,
  id_json TEXT NOT NULL,
  project_kind TEXT NOT NULL CHECK (project_kind IN ('project', 'world', 'unresolved')),
  project_id TEXT CHECK ((project_kind = 'project') = (project_id IS NOT NULL)),
  state TEXT NOT NULL CHECK (state IN ('committed', 'purged')),
  payload_hash TEXT CHECK ((state = 'committed') = (payload_hash IS NOT NULL)),
  revision INTEGER CHECK (state = 'purged' OR revision IS NOT NULL),
  changed INTEGER CHECK (changed IS NULL OR changed IN (0, 1)),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
) STRICT;

CREATE INDEX requests_by_target ON requests (world, kind, id_json);

CREATE TRIGGER requests_target_immutable
BEFORE UPDATE OF request_id, world, kind, id_json, project_kind, project_id ON requests
WHEN OLD.request_id IS NOT NEW.request_id OR OLD.world IS NOT NEW.world OR OLD.kind IS NOT NEW.kind
  OR OLD.id_json IS NOT NEW.id_json OR OLD.project_kind IS NOT NEW.project_kind
  OR OLD.project_id IS NOT NEW.project_id
BEGIN
  SELECT RAISE(ABORT, 'curation request target and scope are immutable');
END;

-- No foreign key to records: an unannotated inbox lesson has no row, yet a
-- no-op on it needs a durable receipt. Any other receipt needs its record,
-- and a receipt always shares its record's scope.
CREATE TRIGGER requests_target_checked
BEFORE INSERT ON requests
WHEN EXISTS (
    SELECT 1 FROM requests q
    WHERE q.world = NEW.world AND q.kind = NEW.kind AND q.id_json = NEW.id_json
      AND (q.project_kind IS NOT NEW.project_kind OR q.project_id IS NOT NEW.project_id))
  OR (NOT EXISTS (
    SELECT 1 FROM records r
    WHERE r.world = NEW.world AND r.kind = NEW.kind AND r.id_json = NEW.id_json
      AND r.project_kind IS NEW.project_kind AND r.project_id IS NEW.project_id)
  AND (EXISTS (
      SELECT 1 FROM records r WHERE r.world = NEW.world AND r.kind = NEW.kind AND r.id_json = NEW.id_json)
    OR NEW.kind <> 'inbox' OR NEW.state <> 'committed' OR NEW.revision IS NOT 0 OR NEW.changed IS NOT 0))
BEGIN
  SELECT RAISE(ABORT, 'curation receipt target has no matching record');
END;

-- Without the old foreign key, nothing else stops a tombstone row from being
-- deleted and its key reused while retired requests remain.
CREATE TRIGGER records_never_deleted
BEFORE DELETE ON records
BEGIN
  SELECT RAISE(ABORT, 'curation records are never deleted');
END;

CREATE TRIGGER records_match_receipts
BEFORE INSERT ON records
WHEN EXISTS (
  SELECT 1 FROM requests q
  WHERE q.world = NEW.world AND q.kind = NEW.kind AND q.id_json = NEW.id_json
    AND (q.project_kind IS NOT NEW.project_kind OR q.project_id IS NOT NEW.project_id))
BEGIN
  SELECT RAISE(ABORT, 'curation record scope differs from its receipt target');
END;
`;

// Canonical schema rows, built lazily from SCHEMA_V1 so importing this module
// does no SQLite work.
let expectedSchema: string | null = null;

function schemaFingerprint(sqlite: Database): string {
  return JSON.stringify(sqlite.query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all());
}

function expectedSchemaFingerprint(): string {
  if (expectedSchema === null) {
    const reference = new Database(":memory:");
    try {
      reference.run(SCHEMA_V1);
      expectedSchema = schemaFingerprint(reference);
    } finally {
      reference.close();
    }
  }
  return expectedSchema;
}

/** Column value for a lesson id. Lossless for every JS string. */
export function encodeRecordId(id: string): string {
  return JSON.stringify(id);
}

/** Inverse of encodeRecordId. Refuses anything it would not have produced. */
export function decodeRecordId(stored: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    fail("STORAGE_UNAVAILABLE", "database_invalid");
  }
  if (typeof parsed !== "string" || JSON.stringify(parsed) !== stored) fail("STORAGE_UNAVAILABLE", "database_invalid");
  return parsed;
}

// --- location and filesystem ---------------------------------------------

function nearestExisting(path: string): string {
  let dir = resolve(path);
  for (;;) {
    if (existsSync(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

/** Canonical data directory: realpath of the deepest existing ancestor plus the rest. */
function canonicalDataDir(): string {
  const target = resolve(paths.dataDir());
  const existing = nearestExisting(target);
  const real = realpathSync(existing);
  const rest = target.slice(existing.length).split(sep).filter((part) => part.length > 0);
  return join(real, ...rest);
}

/** Bare lowercase sha256 of the canonical data directory. Stable before init. */
export function curationLocationId(): string {
  return createHash("sha256").update(`sil-curation-location-v1\0${canonicalDataDir()}`).digest("hex");
}

export type FilesystemClass = "local" | "unsupported" | "unknown";

const DARWIN_LOCAL = new Set(["apfs", "hfs"]);
const LINUX_LOCAL = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "tmpfs", "zfs", "overlay"]);
const KNOWN_REMOTE = new Set([
  "nfs",
  "nfs4",
  "smbfs",
  "cifs",
  "smb3",
  "afpfs",
  "webdav",
  "ftp",
  "9p",
  "ceph",
  "glusterfs",
  "lustre",
  "virtiofs",
  "autofs",
  "sshfs",
  "osxfuse",
  "macfuse",
  "fuse",
]);

interface MountEntry {
  mountPoint: string;
  fsType: string;
  local: boolean | null;
}

function contains(mountPoint: string, path: string): boolean {
  if (mountPoint === "/") return path.startsWith("/");
  return path === mountPoint || path.startsWith(`${mountPoint}/`);
}

function classifyEntries(entries: MountEntry[], path: string, localTypes: ReadonlySet<string>): FilesystemClass {
  let best: MountEntry | null = null;
  // Later entries shadow earlier ones at the same mount point.
  for (const entry of entries) {
    if (contains(entry.mountPoint, path) && (best === null || entry.mountPoint.length >= best.mountPoint.length)) best = entry;
  }
  if (best === null) return "unknown";
  const type = best.fsType.toLowerCase();
  if (KNOWN_REMOTE.has(type) || type.startsWith("fuse.") || best.local === false) return "unsupported";
  if (localTypes.has(type)) return "local";
  return "unknown";
}

/** Classify `path` against `/sbin/mount` output. Requires the `local` flag. */
export function classifyDarwinMounts(mountOutput: string, path: string): FilesystemClass {
  const entries: MountEntry[] = [];
  for (const line of mountOutput.split("\n")) {
    const m = /^.+? on (\/.*) \(([^()]*)\)$/.exec(line);
    if (!m) continue;
    const flags = m[2]!.split(",").map((part) => part.trim());
    entries.push({ mountPoint: m[1]!, fsType: flags[0] ?? "", local: flags.includes("local") });
  }
  // An apfs or hfs mount without the local flag is not trusted as local.
  return classifyEntries(entries, path, DARWIN_LOCAL);
}

function unescapeMountinfo(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** Classify `path` against /proc/self/mountinfo text. */
export function classifyLinuxMountinfo(mountinfo: string, path: string): FilesystemClass {
  const entries: MountEntry[] = [];
  for (const line of mountinfo.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const head = line.slice(0, separator).split(" ");
    const tail = line.slice(separator + 3).split(" ");
    if (head.length < 6 || tail.length < 1) continue;
    entries.push({ mountPoint: unescapeMountinfo(head[4]!), fsType: tail[0]!, local: null });
  }
  return classifyEntries(entries, path, LINUX_LOCAL);
}

const MAX_MOUNT_TABLE_BYTES = 4 * 1024 * 1024;

/** Read-only, bounded probe of the filesystem holding `path`. */
export function probeFilesystem(path: string): FilesystemClass {
  let real: string;
  try {
    real = realpathSync(nearestExisting(path));
  } catch {
    return "unknown";
  }
  try {
    if (process.platform === "darwin") {
      const run = Bun.spawnSync(["/sbin/mount"], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdout: "pipe", stderr: "ignore", timeout: 2000 });
      if (run.exitCode !== 0 || run.stdout.length > MAX_MOUNT_TABLE_BYTES) return "unknown";
      return classifyDarwinMounts(run.stdout.toString("utf8"), real);
    }
    if (process.platform === "linux") {
      const text = readFileSync("/proc/self/mountinfo", "utf8");
      if (text.length > MAX_MOUNT_TABLE_BYTES) return "unknown";
      return classifyLinuxMountinfo(text, real);
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

// --- marker --------------------------------------------------------------

type Marker = { installationId: string; state: "initializing" | "ready"; createdAt: string };

function readMarker(path: string): Marker {
  let text: string;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) fail("STORAGE_UNAVAILABLE", "unsafe_path");
    if (st.size > MAX_MARKER_BYTES) fail("STORAGE_UNAVAILABLE", "marker_invalid");
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof CurationError) throw error;
    fail("STORAGE_UNAVAILABLE", "unreadable");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("STORAGE_UNAVAILABLE", "marker_invalid");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("STORAGE_UNAVAILABLE", "marker_invalid");
  const v = raw as Record<string, unknown>;
  if (v["format"] !== MARKER_FORMAT) fail("STORAGE_UNAVAILABLE", "marker_invalid");
  if (typeof v["version"] === "number" && Number.isInteger(v["version"]) && v["version"] > CURATION_SCHEMA_VERSION) {
    fail("UNSUPPORTED_SCHEMA", "unsupported_schema");
  }
  const keys = Object.keys(v).sort().join(",");
  if (
    v["version"] !== CURATION_SCHEMA_VERSION ||
    keys !== "createdAt,format,installationId,state,version" ||
    typeof v["installationId"] !== "string" ||
    !UUID_RE.test(v["installationId"]) ||
    (v["state"] !== "initializing" && v["state"] !== "ready") ||
    typeof v["createdAt"] !== "string"
  ) {
    fail("STORAGE_UNAVAILABLE", "marker_invalid");
  }
  return { installationId: v["installationId"], state: v["state"], createdAt: v["createdAt"] };
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Write a new owner-only file and fsync it. Fails if it already exists. */
function createFile(path: string, content: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeMarker(marker: Marker): void {
  const target = curationIdentityFile();
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const body = { format: MARKER_FORMAT, version: CURATION_SCHEMA_VERSION, ...marker };
  createFile(tmp, `${JSON.stringify(body)}\n`);
  renameSync(tmp, target);
  fsyncDir(dirname(target));
}

// --- permissions ---------------------------------------------------------

function checkOwnerOnly(path: string, kind: "dir" | "file"): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    fail("STORAGE_UNAVAILABLE", "unreadable");
  }
  if (st.isSymbolicLink() || (kind === "dir" ? !st.isDirectory() : !st.isFile())) fail("STORAGE_UNAVAILABLE", "unsafe_path");
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) fail("STORAGE_UNAVAILABLE", "insecure_permissions");
  if ((st.mode & 0o077) !== 0) fail("STORAGE_UNAVAILABLE", "insecure_permissions");
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail("STORAGE_UNAVAILABLE", "unreadable");
  }
  checkOwnerOnly(dir, "dir");
}

// --- database checks -----------------------------------------------------

/** Version, schema and identity checks shared by inspection and open. */
function verifyDatabase(sqlite: Database, installationId: string): void {
  const version = (sqlite.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version > CURATION_SCHEMA_VERSION) fail("UNSUPPORTED_SCHEMA", "unsupported_schema");
  if (version !== CURATION_SCHEMA_VERSION) fail("STORAGE_UNAVAILABLE", "database_invalid");
  // Exact stored definitions, so a same-name object with other SQL fails.
  if (schemaFingerprint(sqlite) !== expectedSchemaFingerprint()) fail("STORAGE_UNAVAILABLE", "database_invalid");
  const meta = sqlite.query("SELECT key, value FROM meta ORDER BY key").all() as Array<{ key: string; value: string }>;
  const byKey = new Map(meta.map((row) => [row.key, row.value]));
  if (
    meta.map((row) => row.key).join(",") !== "created_at,installation_id,schema_version" ||
    byKey.get("schema_version") !== String(CURATION_SCHEMA_VERSION)
  ) {
    fail("STORAGE_UNAVAILABLE", "database_invalid");
  }
  if (byKey.get("installation_id") !== installationId) fail("STORAGE_UNAVAILABLE", "identity_mismatch");
}

export function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"));
}

function withSqliteErrors<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof CurationError) throw error;
    if (isBusy(error)) fail("STORAGE_BUSY", "storage_busy");
    fail("STORAGE_UNAVAILABLE", "database_invalid");
  }
}

/** Apply and read back the required connection settings. */
function configureConnection(sqlite: Database): void {
  sqlite.run(`PRAGMA busy_timeout = ${CURATION_BUSY_TIMEOUT_MS}`);
  sqlite.run("PRAGMA journal_mode = DELETE");
  sqlite.run("PRAGMA secure_delete = ON");
  sqlite.run("PRAGMA synchronous = FULL");
  sqlite.run("PRAGMA foreign_keys = ON");
  const read = (pragma: string): unknown => Object.values(sqlite.query(`PRAGMA ${pragma}`).get() as object)[0];
  const ok =
    read("busy_timeout") === CURATION_BUSY_TIMEOUT_MS &&
    String(read("journal_mode")).toLowerCase() === "delete" &&
    read("secure_delete") === 1 &&
    read("synchronous") === 2 &&
    read("foreign_keys") === 1;
  if (!ok) fail("STORAGE_UNAVAILABLE", "settings_unverified");
}

// --- inspection ----------------------------------------------------------

export interface CurationStoreDeps {
  probeFilesystem: (path: string) => FilesystemClass;
  /** Observer called after each durable initialization step. Not reachable from config or env. */
  onInitStep: (step: InitStep) => void;
  /** Observer called after each directory-entry look during inspection. */
  onProbe?: (entry: ProbeEntry) => void;
}

export type ProbeEntry = "directory" | "marker" | "database" | "guard";

export type InitStep = "guard-acquired" | "marker-initializing" | "database-created" | "marker-ready" | "guard-released";

const DEFAULT_DEPS: CurationStoreDeps = { probeFilesystem, onInitStep: () => {} };

type Inspected = { state: "uninitialized" } | { state: "ready"; installationId: string };

function checkFilesystem(deps: CurationStoreDeps): void {
  if (deps.probeFilesystem(curationDir()) !== "local") fail("STORAGE_UNAVAILABLE", "unsupported_filesystem");
}

/**
 * Whether the directory entry itself exists. Never follows a symlink: any
 * symlink or wrong type is unsafe, so nothing can be initialized over it.
 */
function occupied(path: string, kind: "dir" | "file"): boolean {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    fail("STORAGE_UNAVAILABLE", "unreadable");
  }
  if (st.isSymbolicLink() || (kind === "dir" ? !st.isDirectory() : !st.isFile())) fail("STORAGE_UNAVAILABLE", "unsafe_path");
  return true;
}

/** Read-only state check. Throws CurationStoreError on anything but a clean state. */
function inspectState(deps: CurationStoreDeps): Inspected {
  const look = (entry: ProbeEntry, path: string, kind: "dir" | "file"): boolean => {
    const present = occupied(path, kind);
    deps.onProbe?.(entry);
    return present;
  };
  const dir = curationDir();
  const markerPath = curationIdentityFile();
  const dbPath = curationDatabaseFile();
  for (let attempt = 0; ; attempt++) {
    if (!look("directory", dir, "dir")) return { state: "uninitialized" };
    checkOwnerOnly(dir, "dir");
    const hasMarker = look("marker", markerPath, "file");
    const hasDb = look("database", dbPath, "file");
    const hasGuard = look("guard", curationGuardFile(), "file");
    if (!hasMarker) {
      // An initializer writes the marker before the database, so a marker
      // that appeared since the first look means it moved on. Look again.
      if ((hasDb || hasGuard) && attempt < 2 && occupied(markerPath, "file")) continue;
      if (hasDb) fail("STORAGE_UNAVAILABLE", "database_without_marker");
      if (hasGuard) fail("STORAGE_BUSY", "initialization_guard_held");
      return { state: "uninitialized" };
    }
    checkOwnerOnly(markerPath, "file");
    const marker = readMarker(markerPath);
    if (marker.state === "initializing") fail("STORAGE_UNAVAILABLE", "initialization_interrupted");
    // The database is created before the ready marker, so judge it by a look
    // taken after reading ready, not by the earlier one.
    if (!hasDb && !occupied(dbPath, "file")) fail("STORAGE_UNAVAILABLE", "database_missing");
    checkOwnerOnly(dbPath, "file");
    withSqliteErrors(() => {
      const sqlite = new Database(dbPath, { readonly: true, strict: true });
      try {
        sqlite.run(`PRAGMA busy_timeout = ${CURATION_BUSY_TIMEOUT_MS}`);
        verifyDatabase(sqlite, marker.installationId);
      } finally {
        sqlite.close();
      }
    });
    return { state: "ready", installationId: marker.installationId };
  }
}

export function inspectCurationStoreWith(deps: CurationStoreDeps): StoreStatus {
  try {
    checkFilesystem(deps);
    const state = inspectState(deps);
    if (state.state === "uninitialized") return { state: "uninitialized", binding: { kind: "location", id: curationLocationId() } };
    return { state: "ready", binding: { kind: "installation", id: state.installationId }, schemaVersion: CURATION_SCHEMA_VERSION };
  } catch (error) {
    if (error instanceof CurationStoreError) {
      return { state: "error", code: error.code, problem: error.problem, recoveryRequired: RECOVERY.has(error.problem) };
    }
    return { state: "error", code: "STORAGE_UNAVAILABLE", problem: "unreadable", recoveryRequired: false };
  }
}

/** Current store state. Never creates a directory or file. */
export function inspectCurationStore(): StoreStatus {
  return inspectCurationStoreWith(DEFAULT_DEPS);
}

// --- open and initialize -------------------------------------------------

class OpenCurationDatabase implements CurationDatabase {
  #closed = false;
  constructor(
    readonly sqlite: Database,
    readonly installationId: string,
    readonly locationId: string,
  ) {}
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.sqlite.close();
  }
}

function checkBinding(binding: StoreBinding, state: Inspected): void {
  if (binding.kind === "installation") {
    if (!UUID_RE.test(binding.id)) throw new CurationError("INVALID_INPUT", ["binding"]);
    // A pinned installation never matches a store that has none yet.
    if (state.state !== "ready" || state.installationId !== binding.id) fail("INSTALLATION_MISMATCH", "identity_mismatch");
    return;
  }
  if (binding.kind !== "location" || !SHA256_HEX_RE.test(binding.id)) throw new CurationError("INVALID_INPUT", ["binding"]);
  // A location binding only bootstraps: it must name this data directory.
  if (binding.id !== curationLocationId()) fail("INSTALLATION_MISMATCH", "identity_mismatch");
}

/** An explicit mutation precondition. Absent means the caller's existing semantics. */
function checkExpected(expected: CurationPrecondition | undefined, state: Inspected): void {
  if (expected === undefined) return;
  if (expected.kind === "installation") {
    if (state.state !== "ready" || state.installationId !== expected.id) fail("INSTALLATION_MISMATCH", "identity_mismatch");
  } else if (state.state === "ready") {
    // A bootstrap request never joins a store that exists, however recently it appeared.
    fail("INSTALLATION_MISMATCH", "identity_mismatch");
  }
}

/** The installation id this handle's database names, or null if it cannot say. */
function handleInstallationId(sqlite: Database): string | null {
  try {
    const row = sqlite.query("SELECT value FROM meta WHERE key = 'installation_id'").get() as { value: unknown } | null;
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    // Unreadable or unexpected schema: verifyDatabase reports it with its own code.
    return null;
  }
}

/**
 * Open the database behind an inspected ready marker. With `expectedId`, an
 * explicit precondition, a database on this same handle that names another
 * installation is INSTALLATION_MISMATCH, checked before any connection
 * setting touches it. Without one, every failure keeps its storage code.
 */
function openReady(installationId: string, expectedId?: string): CurationDatabase {
  const dbPath = curationDatabaseFile();
  const locationId = curationLocationId();
  return withSqliteErrors(() => {
    const sqlite = new Database(dbPath, { readwrite: true, create: false, strict: true });
    try {
      if (expectedId !== undefined) {
        const actual = handleInstallationId(sqlite);
        if (actual !== null && actual !== expectedId) fail("INSTALLATION_MISMATCH", "identity_mismatch");
      }
      configureConnection(sqlite);
      verifyDatabase(sqlite, installationId);
    } catch (error) {
      sqlite.close();
      throw error;
    }
    return new OpenCurationDatabase(sqlite, installationId, locationId);
  });
}

function tryAcquireGuard(): boolean {
  try {
    createFile(curationGuardFile(), `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    fail("STORAGE_UNAVAILABLE", "unreadable");
  }
  fsyncDir(curationDir());
  return true;
}

function releaseGuard(): void {
  unlinkSync(curationGuardFile());
  fsyncDir(curationDir());
}

/** The single initializer. Runs with the guard held and the store absent. */
function initialize(deps: CurationStoreDeps, progress: { wrote: boolean }): string {
  const installationId = randomUUID();
  const createdAt = new Date().toISOString();
  progress.wrote = true;
  writeMarker({ installationId, state: "initializing", createdAt });
  deps.onInitStep("marker-initializing");
  const dbPath = curationDatabaseFile();
  createFile(dbPath, "");
  withSqliteErrors(() => {
    const sqlite = new Database(dbPath, { readwrite: true, create: false, strict: true });
    try {
      configureConnection(sqlite);
      sqlite.transaction(() => {
        sqlite.run(SCHEMA_V1);
        const insert = sqlite.query("INSERT INTO meta (key, value) VALUES (?, ?)");
        insert.run("installation_id", installationId);
        insert.run("schema_version", String(CURATION_SCHEMA_VERSION));
        insert.run("created_at", createdAt);
        sqlite.run(`PRAGMA user_version = ${CURATION_SCHEMA_VERSION}`);
      })();
      verifyDatabase(sqlite, installationId);
    } finally {
      sqlite.close();
    }
  });
  checkOwnerOnly(dbPath, "file");
  deps.onInitStep("database-created");
  writeMarker({ installationId, state: "ready", createdAt });
  deps.onInitStep("marker-ready");
  return installationId;
}

/** Like inspectState, but a guard with nothing else behind it reads as uninitialized. */
function inspectStateAllowingGuard(deps: CurationStoreDeps): Inspected {
  try {
    return inspectState(deps);
  } catch (error) {
    if (error instanceof CurationStoreError && error.problem === "initialization_guard_held") return { state: "uninitialized" };
    throw error;
  }
}

/** Inspect, or null while another process may still be initializing. */
function inspectOrWait(deps: CurationStoreDeps): Inspected | null {
  try {
    return inspectState(deps);
  } catch (error) {
    if (!(error instanceof CurationStoreError)) throw error;
    // A held guard, or an initializing marker under a held guard, looks the
    // same whether its owner is alive or dead. Wait, then report it.
    if (error.problem === "initialization_guard_held") return null;
    if (error.problem === "initialization_interrupted" && occupied(curationGuardFile(), "file")) return null;
    throw error;
  }
}

export function openCurationStoreWith(
  binding: StoreBinding,
  options: { initialize: boolean; expect?: CurationPrecondition },
  deps: CurationStoreDeps,
): CurationDatabase {
  checkFilesystem(deps);
  const expected = options.expect;
  if (expected?.kind === "uninitialized" && (binding.kind !== "location" || binding.id !== expected.locationId)) {
    throw new CurationError("INVALID_INPUT", ["precondition"]);
  }
  // An installation precondition never initializes.
  if (!options.initialize || expected?.kind === "installation") {
    const state = inspectState(deps);
    checkBinding(binding, state);
    checkExpected(expected, state);
    // openReady verifies this id against the database it opens.
    if (state.state === "ready") return openReady(state.installationId, expected?.kind === "installation" ? expected.id : undefined);
    fail("STORAGE_UNAVAILABLE", "uninitialized");
  }

  const deadline = Date.now() + GUARD_WAIT_MS;
  for (;;) {
    const state = inspectOrWait(deps);
    if (state !== null) {
      checkBinding(binding, state);
      checkExpected(expected, state);
      if (state.state === "ready") return openReady(state.installationId);
      ensurePrivateDir(curationDir());
      if (tryAcquireGuard()) break;
    }
    // Never remove another process's guard. Past the deadline, report the
    // exact state a strict inspection sees.
    if (Date.now() >= deadline) {
      inspectState(deps);
      fail("STORAGE_BUSY", "initialization_guard_held");
    }
    Bun.sleepSync(GUARD_POLL_MS);
  }
  deps.onInitStep("guard-acquired");
  const progress = { wrote: false };
  let installationId: string;
  try {
    // Someone may have finished between our inspection and the guard. The
    // guard on disk is ours now, so it does not count as held.
    const now = inspectStateAllowingGuard(deps);
    checkBinding(binding, now);
    // Under our own guard: a store that appeared since the first look is refused here.
    checkExpected(expected, now);
    installationId = now.state === "ready" ? now.installationId : initialize(deps, progress);
  } catch (error) {
    // Once a marker is written, the guard stays for a human to see.
    if (!progress.wrote) releaseGuard();
    throw error;
  }
  releaseGuard();
  deps.onInitStep("guard-released");
  return openReady(installationId);
}

/**
 * Open the store for a caller bound to `binding`. With `initialize`, an absent
 * store is created under an exclusive guard. Inconsistent state always fails.
 */
export function openCurationStore(binding: StoreBinding, options: { initialize: boolean }): CurationDatabase {
  return openCurationStoreWith(binding, options, DEFAULT_DEPS);
}

/**
 * Open for one mutation under its precondition. Initializes only for an
 * uninitialized precondition, and then only a store that is still absent
 * under the initialization guard.
 */
export function openCurationStoreForMutation(binding: StoreBinding, precondition: CurationPrecondition): CurationDatabase {
  return openCurationStoreWith(binding, { initialize: precondition.kind === "uninitialized", expect: precondition }, DEFAULT_DEPS);
}

// --- read-only access ----------------------------------------------------

/** What a read handle actually opened. `db` is null only for a verified uninitialized store. */
export interface CurationReadHandle {
  identity: { locationId: string; installationId: string | null };
  db: CurationDatabase | null;
}

export function openCurationStoreForReadWith(binding: StoreBinding, deps: CurationStoreDeps): CurationReadHandle {
  checkFilesystem(deps);
  const state = inspectState(deps);
  checkBinding(binding, state);
  const locationId = curationLocationId();
  if (state.state === "uninitialized") return { identity: { locationId, installationId: null }, db: null };
  return withSqliteErrors(() => {
    // readonly: no journal mode, pragma or schema write can reach the file.
    const sqlite = new Database(curationDatabaseFile(), { readonly: true, strict: true });
    try {
      sqlite.run(`PRAGMA busy_timeout = ${CURATION_BUSY_TIMEOUT_MS}`);
      sqlite.run("PRAGMA query_only = ON");
      verifyDatabase(sqlite, state.installationId);
      // Identity comes from this handle, not from the earlier marker look.
      const row = sqlite.query("SELECT value FROM meta WHERE key = 'installation_id'").get() as { value: string } | null;
      if (row === null || row.value !== state.installationId) fail("STORAGE_UNAVAILABLE", "identity_mismatch");
      if (binding.kind === "installation" && row.value !== binding.id) fail("INSTALLATION_MISMATCH", "identity_mismatch");
      return { identity: { locationId, installationId: row.value }, db: new OpenCurationDatabase(sqlite, row.value, locationId) };
    } catch (error) {
      sqlite.close();
      throw error;
    }
  });
}

/**
 * Open the store for reading only. Never creates, initializes, repairs or
 * reconfigures anything. An uninitialized store yields `db: null`; any other
 * state that is not ready fails.
 */
export function openCurationStoreForRead(binding: StoreBinding): CurationReadHandle {
  return openCurationStoreForReadWith(binding, DEFAULT_DEPS);
}
