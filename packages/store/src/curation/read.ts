// The curated read model: legacy sources joined with curation records by
// structured key. Reads open the store read-only, never initialize it, never
// write a source and never copy legacy text into the database.

import { SQLiteError } from "bun:sqlite";
import { createHash } from "node:crypto";
import { loadConfig } from "@sil/core";
import type { Config } from "@sil/core";
import {
  CurationError,
  PROJECT_ID_RE,
  encodeLessonKey,
  isWellFormed,
  lessonKeyProblems,
  utf8Bytes,
} from "@sil/core/lesson-curation";
import type {
  CaptureSource,
  CurationPage,
  CurationQuery,
  CurationRevision,
  LessonKey,
  LessonScope,
  LessonView,
  SourceStatus,
  StoreBinding,
} from "@sil/core/lesson-curation";
import {
  CURATION_DEFAULT_PAGE_SIZE,
  CURATION_MAX_DIAGNOSTIC_BYTES,
  CURATION_MAX_PAGE_SIZE,
  CURATION_MAX_RESULT_BYTES,
  CURATION_MAX_SEARCH_CHARS,
} from "@sil/core/curation-read";
import type {
  CuratedLessonDetail,
  CuratedProvenance,
  CurationBrowsePage,
  CurationDiagnostic,
  CurationReadResult,
  CurationStoreIdentity,
  LegacySourceFileProblem,
} from "@sil/core/curation-read";
import type { GitProbeOptions } from "@sil/core/repo-root";
import { decodeRecordId, encodeRecordId, isBusy, openCurationStoreForRead } from "./database.ts";
import type { CurationDatabase, CurationReadHandle } from "./database.ts";
import { CURATION_GIT_PROBE, configuredWorld, projectResolver, sameScope, scopeFromRow, sourceScope } from "./projects.ts";
import type { ProjectResolver } from "./projects.ts";
import { LegacySourceError, inspectLegacySource, legacySourceFileName, observationFor, scanLegacySources } from "./sources.ts";
import { boundedResult, jsonBytes, resultTooLarge } from "./bounds.ts";
import type { LegacySourceObservation } from "./sources.ts";

export interface CurationReadOptions {
  config?: Config;
  git?: GitProbeOptions;
}

type RecordRow = {
  world: string;
  kind: string;
  id_json: string;
  project_kind: string;
  project_id: string | null;
  revision: number;
  important: number;
  text: string | null;
  source_json: string | null;
  baseline_digest: string | null;
  purged: number;
  created_at: string;
  updated_at: string;
};

const RECORD_COLUMNS =
  "world, kind, id_json, project_kind, project_id, revision, important, text, source_json, baseline_digest, purged, created_at, updated_at";

const damaged = (): CurationError => new CurationError("STORAGE_UNAVAILABLE", ["database_invalid"]);

/** Explicit 0/1 only. */
function flag(value: number): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw damaged();
}

// --- input checks --------------------------------------------------------

function checkKey(key: LessonKey): void {
  if (typeof key !== "object" || key === null) throw new CurationError("INVALID_INPUT", ["key"]);
  const problems = lessonKeyProblems(key).map((field) => `key.${field}`);
  if (problems.length > 0) throw new CurationError("INVALID_INPUT", problems);
}

function checkScope(scope: LessonScope): void {
  const project = scope?.project;
  const ok =
    typeof scope?.world === "string" &&
    (project?.kind === "world" || project?.kind === "unresolved" || (project?.kind === "project" && typeof project.id === "string" && PROJECT_ID_RE.test(project.id)));
  if (!ok) throw new CurationError("INVALID_INPUT", ["scope"]);
}

function checkLimit(limit: unknown): number {
  if (limit === undefined) return CURATION_DEFAULT_PAGE_SIZE;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > CURATION_MAX_PAGE_SIZE) throw new CurationError("INVALID_INPUT", ["limit"]);
  return limit;
}

// --- cursors -------------------------------------------------------------

const MAX_CURSOR_CHARS = 64 * 1024;

function fingerprint(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

function encodeCursor(body: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...body }), "utf8").toString("base64url");
}

/** Decode a cursor this module wrote for exactly this query. Anything else is INVALID_INPUT. */
function decodeCursor(cursor: unknown, expectedFingerprint: string): Record<string, unknown> {
  const invalid = () => new CurationError("INVALID_INPUT", ["cursor"]);
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid();
  const b = body as Record<string, unknown>;
  if (b["v"] !== 1 || b["f"] !== expectedFingerprint) throw invalid();
  return b;
}

// --- store access --------------------------------------------------------

function mapSqlite<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof SQLiteError) {
      if (isBusy(error)) throw new CurationError("STORAGE_BUSY", ["storage"]);
      throw new CurationError("STORAGE_UNAVAILABLE", ["storage"]);
    }
    throw error;
  }
}

/** One read-only handle and one read transaction for the whole read. */
function withRead<T>(binding: StoreBinding, run: (db: CurationDatabase | null, store: CurationStoreIdentity) => T): CurationReadResult<T> {
  const handle: CurationReadHandle = openCurationStoreForRead(binding);
  try {
    const db = handle.db;
    if (db === null) return boundedResult({ store: handle.identity, value: run(null, handle.identity) });
    return mapSqlite(() => {
      db.sqlite.run("BEGIN");
      try {
        return boundedResult({ store: handle.identity, value: run(db, handle.identity) });
      } finally {
        if (db.sqlite.inTransaction) db.sqlite.run("ROLLBACK");
      }
    });
  } finally {
    handle.db?.close();
  }
}

function recordFor(db: CurationDatabase | null, key: LessonKey): RecordRow | null {
  if (db === null) return null;
  return (db.sqlite
    .query(`SELECT ${RECORD_COLUMNS} FROM records WHERE world = ? AND kind = ? AND id_json = ?`)
    .get(key.world, key.kind, encodeRecordId(key.id)) as RecordRow | null) ?? null;
}

function recordsOf(db: CurationDatabase | null, world: string): RecordRow[] {
  if (db === null) return [];
  return db.sqlite.query(`SELECT ${RECORD_COLUMNS} FROM records WHERE world = ?`).all(world) as RecordRow[];
}

function storedProjectIds(db: CurationDatabase | null, world: string): Set<string> {
  if (db === null) return new Set();
  const rows = db.sqlite
    .query("SELECT DISTINCT project_id FROM records WHERE world = ? AND project_kind = 'project' AND purged = 0")
    .all(world) as Array<{ project_id: string }>;
  return new Set(rows.map((row) => row.project_id));
}

const CAPTURE_SOURCE_KEYS = "captureSessionId,kind,quote,quoteRedacted,reference,sourceAgentId,sourceConversationId,sourceRowId";

function captureSourceOf(json: string | null): CaptureSource {
  if (json === null) throw damaged();
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw damaged();
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw damaged();
  const v = raw as Record<string, unknown>;
  const nullableString = (x: unknown) => x === null || typeof x === "string";
  const ok =
    Object.keys(v).sort().join(",") === CAPTURE_SOURCE_KEYS &&
    (v["kind"] === "native_selection" || v["kind"] === "explicit_quote") &&
    typeof v["quoteRedacted"] === "boolean" &&
    ["quote", "reference", "captureSessionId", "sourceConversationId", "sourceRowId", "sourceAgentId"].every((k) => nullableString(v[k]));
  if (!ok) throw damaged();
  return v as unknown as CaptureSource;
}

// --- the join ------------------------------------------------------------

interface Item {
  detail: CuratedLessonDetail;
  bucket: "saved" | "inbox" | "archived";
  purged: boolean;
}

function keyOfRow(row: RecordRow): LessonKey {
  if (row.kind !== "capture" && row.kind !== "inbox") throw damaged();
  const key: LessonKey = { world: row.world, kind: row.kind, id: decodeRecordId(row.id_json) };
  if (lessonKeyProblems(key).length > 0) throw damaged();
  return key;
}

function purgedItem(key: LessonKey, scope: LessonScope, row: RecordRow): Item {
  const lesson: LessonView = {
    key,
    scope,
    revision: row.revision,
    important: false,
    effectiveText: null,
    originalText: null,
    source: null,
    sourceStatus: "purged",
    sourceDigest: null,
    baselineDigest: null,
    relatedPattern: null,
    created: row.created_at,
    updated: row.updated_at,
  };
  return { detail: { lesson, provenance: { kind: "purged" }, diagnostics: [] }, bucket: key.kind === "capture" ? "saved" : "inbox", purged: true };
}

/** A record joined with its source observation (inbox) or its own provenance (capture). */
function recordItem(r: ProjectResolver, row: RecordRow, seen: LegacySourceObservation | null): Item {
  const key = keyOfRow(row);
  const scope = scopeFromRow(row.world, row.project_kind, row.project_id);
  if (flag(row.purged)) return purgedItem(key, scope, row);
  const important = flag(row.important);
  if (key.kind === "capture") {
    if (row.text === null) throw damaged();
    const source = captureSourceOf(row.source_json);
    const lesson: LessonView = {
      key,
      scope,
      revision: row.revision,
      important,
      effectiveText: row.text,
      originalText: null,
      source,
      sourceStatus: "saved",
      sourceDigest: null,
      baselineDigest: null,
      relatedPattern: null,
      created: row.created_at,
      updated: row.updated_at,
    };
    return { detail: { lesson, provenance: { kind: "capture", source }, diagnostics: [] }, bucket: "saved", purged: false };
  }
  if (row.baseline_digest === null) throw damaged();
  return inboxItem(r, key, scope, seen ?? { state: "absent" }, {
    revision: row.revision,
    important,
    text: row.text,
    baseline: row.baseline_digest,
    created: row.created_at,
    updated: row.updated_at,
  });
}

type Annotation = { revision: number; important: boolean; text: string | null; baseline: string; created: string; updated: string };

/** An inbox lesson, annotated or not. `scope` is the record's, or the one its source maps to. */
function inboxItem(r: ProjectResolver, key: LessonKey, scope: LessonScope, seen: LegacySourceObservation, note: Annotation | null): Item {
  const diagnostics: CurationDiagnostic[] = [];
  let status: SourceStatus;
  let provenance: CuratedProvenance;
  let original: string | null = null;
  let digest: string | null = null;
  let pattern: string | null = null;
  let created = note?.created ?? "";
  let archived = false;
  let repo: string | null | undefined;

  if (seen.state === "present") {
    const { lesson, location } = seen.snapshot;
    digest = seen.snapshot.digest;
    original = lesson.text;
    pattern = lesson.pattern;
    created = lesson.created;
    repo = lesson.repo;
    archived = location !== "active";
    if (location === "both") diagnostics.push({ code: "duplicate_source_location" });
    if (note !== null && note.baseline !== digest) {
      status = "changed";
      diagnostics.push({ code: "source_changed", baselineDigest: note.baseline, currentDigest: digest });
    } else status = archived ? "archived" : "queued";
    provenance = {
      kind: "existing_lesson",
      state: "available",
      location,
      digest,
      reflectionId: lesson.reflection_id,
      repo: lesson.repo,
      pattern: lesson.pattern,
      created: lesson.created,
    };
  } else if (seen.state === "conflict") {
    status = "conflict";
    const active = seen.copies.find((c) => c.location === "active")!;
    if (note === null) created = active.created;
    repo = active.repo;
    diagnostics.push({ code: "source_conflict", copies: seen.copies.map((c) => ({ location: c.location, digest: c.digest })) });
    provenance = { kind: "existing_lesson", state: "conflict", copies: seen.copies };
  } else {
    // Only an annotation can outlive its source. The caller never builds a phantom.
    if (note === null) throw new Error("inboxItem: no source and no annotation");
    const problem = seen.state === "unusable" ? seen.problem : "missing";
    status = seen.state === "unusable" ? "invalid" : "missing";
    diagnostics.push({ code: "source_unavailable", problem });
    provenance = { kind: "existing_lesson", state: "unavailable", problem, retainedDigest: note.baseline };
  }
  if (scope.project.kind === "unresolved" && repo !== undefined) {
    const mapped = sourceScope(r, repo);
    if (mapped.unresolved !== null) diagnostics.push({ code: "repo_unresolved", reason: mapped.unresolved });
  }

  const lesson: LessonView = {
    key,
    scope,
    revision: note?.revision ?? 0,
    important: note?.important ?? false,
    effectiveText: note?.text ?? original,
    originalText: original,
    source: null,
    sourceStatus: status,
    sourceDigest: digest,
    baselineDigest: note?.baseline ?? null,
    relatedPattern: pattern,
    created,
    updated: note?.updated ?? created,
  };
  return { detail: { lesson, provenance, diagnostics }, bucket: archived ? "archived" : "inbox", purged: false };
}

/** Scope an unannotated source maps to, from its active copy when the copies disagree. */
function unannotatedScope(r: ProjectResolver, seen: LegacySourceObservation): LessonScope {
  const repo = seen.state === "present" ? seen.snapshot.lesson.repo : seen.state === "conflict" ? seen.copies.find((c) => c.location === "active")!.repo : null;
  return sourceScope(r, repo).scope;
}

// --- detail --------------------------------------------------------------

/**
 * One lesson by exact key in an exact scope. null when the key has neither a
 * record nor a source. A purged record comes back content-free.
 */
export function getCuratedLesson(
  scope: LessonScope,
  key: LessonKey,
  binding: StoreBinding,
  options: CurationReadOptions = {},
): CurationReadResult<CuratedLessonDetail | null> {
  checkKey(key);
  checkScope(scope);
  if (scope.world !== key.world) throw new CurationError("SCOPE_CONFLICT", ["key.world"]);
  const config = options.config ?? loadConfig();
  const world = configuredWorld(config, scope.world, "scope.world");
  return withRead(binding, (db) => {
    const row = recordFor(db, key);
    const r = projectResolver(world, config, options.git ?? CURATION_GIT_PROBE, storedProjectIds(db, world.name));
    let item: Item;
    if (row !== null) {
      const purged = flag(row.purged);
      // A tombstone hides the source: it is never read for a purged key.
      item = recordItem(r, row, purged || key.kind === "capture" ? null : inspectLegacySource(key));
    } else {
      if (key.kind === "capture") return null;
      const seen = inspectLegacySource(key);
      if (seen.state === "absent") return null;
      if (seen.state === "unusable") throw new LegacySourceError(seen.problem, seen.location);
      item = inboxItem(r, key, unannotatedScope(r, seen), seen, null);
    }
    if (!sameScope(item.detail.lesson.scope, scope)) throw new CurationError("SCOPE_CONFLICT", ["scope"]);
    return item.detail;
  });
}

/**
 * Scope of one lesson by exact key: the stored row's scope, or for an
 * unannotated inbox key the scope its source maps to. null when the key has
 * neither. Returns no content and never reads the source of a stored row.
 */
export function locateCuratedLesson(
  key: LessonKey,
  binding: StoreBinding,
  options: CurationReadOptions = {},
): CurationReadResult<LessonScope | null> {
  checkKey(key);
  const config = options.config ?? loadConfig();
  const world = configuredWorld(config, key.world, "key.world");
  return withRead(binding, (db) => {
    const row = recordFor(db, key);
    if (row !== null) {
      keyOfRow(row);
      flag(row.purged);
      return scopeFromRow(row.world, row.project_kind, row.project_id);
    }
    if (key.kind === "capture") return null;
    const seen = inspectLegacySource(key);
    if (seen.state === "absent") return null;
    if (seen.state === "unusable") throw new LegacySourceError(seen.problem, seen.location);
    const r = projectResolver(world, config, options.git ?? CURATION_GIT_PROBE, storedProjectIds(db, world.name));
    return unannotatedScope(r, seen);
  });
}

// --- browse --------------------------------------------------------------

const COLLECTIONS = new Set(["saved", "inbox", "archived", "all"]);

function browseFingerprint(q: CurationQuery): string {
  const p = q.scope.project;
  return fingerprint(["browse-v1", q.scope.world, p.kind, p.kind === "project" ? p.id : null, q.collection, q.important ?? null, q.search ?? null, "created-desc,key-asc"]);
}

function checkQuery(q: CurationQuery): { limit: number; search: string | null } {
  if (typeof q !== "object" || q === null) throw new CurationError("INVALID_INPUT", ["query"]);
  checkScope(q.scope);
  if (typeof q.collection !== "string" || !COLLECTIONS.has(q.collection)) throw new CurationError("INVALID_INPUT", ["collection"]);
  if (q.important !== undefined && typeof q.important !== "boolean") throw new CurationError("INVALID_INPUT", ["important"]);
  let search: string | null = null;
  if (q.search !== undefined) {
    if (typeof q.search !== "string" || q.search.length > CURATION_MAX_SEARCH_CHARS || !isWellFormed(q.search)) throw new CurationError("INVALID_INPUT", ["search"]);
    search = q.search.toLowerCase();
  }
  return { limit: checkLimit(q.limit), search };
}

type Sortable = { view: LessonView; sortKey: string };

/**
 * One page of the curated library in one scope. Order is created descending,
 * then encoded key ascending. The total counts every match before slicing.
 */
export function browseCuratedLessons(query: CurationQuery, binding: StoreBinding, options: CurationReadOptions = {}): CurationReadResult<CurationBrowsePage> {
  const { limit, search } = checkQuery(query);
  const fp = browseFingerprint(query);
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor, fp);
  if (after !== null && (typeof after["c"] !== "string" || typeof after["k"] !== "string")) throw new CurationError("INVALID_INPUT", ["cursor"]);
  const config = options.config ?? loadConfig();
  const world = configuredWorld(config, query.scope.world, "scope.world");

  return withRead(binding, (db, store) => {
    const r = projectResolver(world, config, options.git ?? CURATION_GIT_PROBE, storedProjectIds(db, world.name));
    const scan = scanLegacySources(world.name);
    const items: Item[] = [];
    const recorded = new Set<string>();
    const purgedFiles = new Set<string>();
    for (const row of recordsOf(db, world.name)) {
      const key = keyOfRow(row);
      if (key.kind === "inbox") recorded.add(key.id);
      // Purged rows hide their source, its diagnostics and themselves.
      if (flag(row.purged)) {
        if (key.kind === "inbox") purgedFiles.add(legacySourceFileName(key.id));
        continue;
      }
      items.push(recordItem(r, row, key.kind === "inbox" ? observationFor(scan, key.id) : null));
    }
    for (const [id, seen] of scan.sources) {
      if (recorded.has(id)) continue;
      const key: LessonKey = { world: world.name, kind: "inbox", id };
      items.push(inboxItem(r, key, unannotatedScope(r, seen), seen, null));
    }

    const matches: Sortable[] = [];
    for (const item of items) {
      const view = item.detail.lesson;
      if (!sameScope(view.scope, query.scope)) continue;
      if (query.collection !== "all" && item.bucket !== query.collection) continue;
      if (query.important !== undefined && view.important !== query.important) continue;
      if (search !== null && ![view.effectiveText, view.originalText].some((t) => t !== null && t.toLowerCase().includes(search))) continue;
      matches.push({ view, sortKey: encodeLessonKey(view.key) });
    }
    matches.sort((a, b) =>
      a.view.created !== b.view.created ? (a.view.created < b.view.created ? 1 : -1) : a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
    );
    const total = matches.length;
    let start = 0;
    if (after !== null) {
      const c = after["c"] as string;
      const k = after["k"] as string;
      start = matches.findIndex((m) => m.view.created < c || (m.view.created === c && m.sortKey > k));
      if (start < 0) start = matches.length;
    }

    const problems = scan.problems.filter((p) => !purgedFiles.has(p.file));
    const sourceProblems = fitProblems(problems);
    const envelope = (items: LessonView[], nextCursor: string | null) => ({
      store,
      value: { items, nextCursor, total, sourceProblems, sourceProblemsTotal: problems.length },
    });

    // Budget the whole result: store, totals, cursor and diagnostics included.
    const page: LessonView[] = [];
    let bytes = jsonBytes(envelope([], null));
    let i = start;
    for (; i < matches.length && page.length < limit; i++) {
      const m = matches[i]!;
      const more = i + 1 < matches.length;
      const cursorBytes = more ? jsonBytes(encodeCursor({ f: fp, c: m.view.created, k: m.sortKey })) - jsonBytes(null) : 0;
      const itemBytes = jsonBytes(m.view) + (page.length > 0 ? 1 : 0);
      // Fewer items rather than a clipped one; the previous item's cursor was already counted.
      if (bytes + itemBytes + cursorBytes > CURATION_MAX_RESULT_BYTES) {
        if (page.length === 0) throw resultTooLarge();
        break;
      }
      bytes += itemBytes;
      page.push(m.view);
    }
    const last = matches[i - 1];
    const nextCursor = i < matches.length && last !== undefined ? encodeCursor({ f: fp, c: last.view.created, k: last.sortKey }) : null;
    return envelope(page, nextCursor).value;
  });
}

/** The leading problems that fit the diagnostic budget. The caller reports the full count. */
function fitProblems(problems: LegacySourceFileProblem[]): LegacySourceFileProblem[] {
  const out: LegacySourceFileProblem[] = [];
  let bytes = 2;
  for (const problem of problems) {
    const size = jsonBytes(problem) + (out.length > 0 ? 1 : 0);
    if (bytes + size > CURATION_MAX_DIAGNOSTIC_BYTES) break;
    bytes += size;
    out.push(problem);
  }
  return out;
}

// --- history -------------------------------------------------------------

const CHANGE_KINDS = new Set(["capture", "edit", "important", "acknowledge-source", "purge"]);

type RevisionRow = {
  revision: number;
  change_kind: string;
  at: string;
  text: string | null;
  important: number | null;
  old_source_digest: string | null;
  new_source_digest: string | null;
};

/** Revisions of one record, newest first. A key with no record has an empty history. */
export function readCurationHistory(
  scope: LessonScope,
  key: LessonKey,
  binding: StoreBinding,
  cursor?: string,
  limit?: number,
  options: CurationReadOptions = {},
): CurationReadResult<CurationPage<CurationRevision>> {
  checkKey(key);
  checkScope(scope);
  if (scope.world !== key.world) throw new CurationError("SCOPE_CONFLICT", ["key.world"]);
  const size = checkLimit(limit);
  const p = scope.project;
  const fp = fingerprint(["history-v1", key.world, key.kind, encodeRecordId(key.id), p.kind, p.kind === "project" ? p.id : null]);
  const after = cursor === undefined ? null : decodeCursor(cursor, fp);
  if (after !== null && (typeof after["r"] !== "number" || !Number.isInteger(after["r"]))) throw new CurationError("INVALID_INPUT", ["cursor"]);
  configuredWorld(options.config ?? loadConfig(), scope.world, "scope.world");

  return withRead(binding, (db, store) => {
    const row = recordFor(db, key);
    if (db === null || row === null) return { items: [], nextCursor: null, total: 0 };
    if (!sameScope(scopeFromRow(row.world, row.project_kind, row.project_id), scope)) throw new CurationError("SCOPE_CONFLICT", ["scope"]);
    const idJson = encodeRecordId(key.id);
    const total = (db.sqlite.query("SELECT count(*) AS n FROM revisions WHERE world = ? AND kind = ? AND id_json = ?").get(key.world, key.kind, idJson) as { n: number })
      .n;
    const below = after === null ? Number.MAX_SAFE_INTEGER : (after["r"] as number);
    const rows = db.sqlite
      .query(
        `SELECT revision, change_kind, at, text, important, old_source_digest, new_source_digest FROM revisions
         WHERE world = ? AND kind = ? AND id_json = ? AND revision < ? ORDER BY revision DESC LIMIT ?`,
      )
      .all(key.world, key.kind, idJson, below, size + 1) as RevisionRow[];
    const candidates = rows.slice(0, size).map((rev): CurationRevision => {
      if (!CHANGE_KINDS.has(rev.change_kind)) throw damaged();
      return {
        revision: rev.revision,
        kind: rev.change_kind as CurationRevision["kind"],
        at: rev.at,
        text: rev.text,
        important: rev.important === null ? null : flag(rev.important),
        oldSourceDigest: rev.old_source_digest,
        newSourceDigest: rev.new_source_digest,
      };
    });
    // Same whole-result budget as browse: fewer revisions, never a clipped one.
    const items: CurationRevision[] = [];
    let bytes = jsonBytes({ store, value: { items: [], nextCursor: null, total } });
    for (let i = 0; i < candidates.length; i++) {
      const rev = candidates[i]!;
      const more = i + 1 < candidates.length || rows.length > size;
      const cursorBytes = more ? jsonBytes(encodeCursor({ f: fp, r: rev.revision })) - jsonBytes(null) : 0;
      const itemBytes = jsonBytes(rev) + (items.length > 0 ? 1 : 0);
      if (bytes + itemBytes + cursorBytes > CURATION_MAX_RESULT_BYTES) {
        if (items.length === 0) throw resultTooLarge();
        break;
      }
      bytes += itemBytes;
      items.push(rev);
    }
    const cut = items.length < candidates.length || rows.length > size;
    const nextCursor = cut && items.length > 0 ? encodeCursor({ f: fp, r: items[items.length - 1]!.revision }) : null;
    return { items, nextCursor, total };
  });
}
