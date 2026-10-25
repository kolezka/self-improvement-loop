// The one curation write path. Each request runs in a single BEGIN IMMEDIATE
// transaction: receipt lookup, tombstone and scope checks, revision compare,
// one change, history and receipt. Either all of it commits or none of it.

import { SQLiteError } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Lesson } from "@sil/core";
import {
  CURATION_REQUEST_ID_RE,
  CurationError,
  PROJECT_ID_RE,
  SHA256_HEX_RE,
  lessonKeyProblems,
} from "@sil/core/lesson-curation";
import type { CurationMutation, CurationReceipt, LessonKey, LessonScope } from "@sil/core/lesson-curation";
import { parseCurationMutation } from "@sil/core/lesson-curation-schema";
import { decodeRecordId, encodeRecordId, isBusy } from "./database.ts";
import type { CurationDatabase } from "./database.ts";
import { legacySourceDigestV1 } from "./source.ts";
import type { LegacySourceSnapshot } from "./source.ts";

/** A revision or create-only conflict that names the record's current revision. */
export class CurationConflictError extends CurationError {
  override name = "CurationConflictError";
  constructor(
    code: "CURATION_CONFLICT" | "CAPTURE_EXISTS",
    public readonly current: { key: LessonKey; revision: number },
  ) {
    super(code, [code === "CAPTURE_EXISTS" ? "key" : "expectedRevision"]);
  }
}

/** Code-level observer for tests. Not reachable from config or env. */
export interface MutationDeps {
  beforeCommit: () => void;
  afterCommit?: () => void;
}

const NO_DEPS: MutationDeps = { beforeCommit: () => {} };

type RecordRow = {
  revision: number;
  project_kind: string;
  project_id: string | null;
  important: number;
  text: string | null;
  baseline_digest: string | null;
  purged: number;
};

type RequestRow = {
  request_id: string;
  world: string;
  kind: string;
  id_json: string;
  project_kind: string;
  project_id: string | null;
  state: "committed" | "purged";
  payload_hash: string | null;
  revision: number | null;
  changed: number | null;
  started_at: string;
  finished_at: string;
};

type Target = { world: string; kind: string; idJson: string; projectKind: string; projectId: string | null };

function targetOf(key: LessonKey, scope: LessonScope): Target {
  return {
    world: key.world,
    kind: key.kind,
    idJson: encodeRecordId(key.id),
    projectKind: scope.project.kind,
    projectId: scope.project.kind === "project" ? scope.project.id : null,
  };
}

function sameTarget(row: RequestRow, t: Target): boolean {
  return (
    row.world === t.world &&
    row.kind === t.kind &&
    row.id_json === t.idJson &&
    row.project_kind === t.projectKind &&
    row.project_id === t.projectId
  );
}

function sameScope(row: { project_kind: string; project_id: string | null }, t: Target): boolean {
  return row.project_kind === t.projectKind && row.project_id === t.projectId;
}

/** JSON with object keys sorted at every level. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Digest of what the request asks for. No request id, no clock. */
function payloadHash(installationId: string, m: CurationMutation): string {
  const body = canonicalJson({
    v: 1,
    installation: installationId,
    key: m.key,
    scope: m.scope,
    expectedRevision: m.expectedRevision,
    change: m.change,
  });
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function receiptFrom(row: RequestRow, key: LessonKey): CurationReceipt {
  if (row.state === "purged") {
    return { state: "purged", requestId: row.request_id, key, startedAt: row.started_at, finishedAt: row.finished_at };
  }
  if (row.payload_hash === null || row.revision === null || (row.changed !== 0 && row.changed !== 1)) {
    throw new CurationError("STORAGE_UNAVAILABLE", ["receipt"]);
  }
  return {
    state: "committed",
    requestId: row.request_id,
    payloadHash: row.payload_hash,
    key,
    revision: row.revision,
    changed: row.changed === 1,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function checkBinding(db: CurationDatabase, binding: CurationMutation["binding"]): void {
  const expected = binding.kind === "installation" ? db.installationId : db.locationId;
  if (binding.id !== expected) throw new CurationError("INSTALLATION_MISMATCH", ["binding"]);
}

/** A snapshot the source reader produced for exactly this key. */
function checkSource(key: LessonKey, source: LegacySourceSnapshot): LegacySourceSnapshot {
  const bad = () => new CurationError("SOURCE_CONFLICT", ["source"]);
  if (typeof source !== "object" || source === null) throw bad();
  if (source.location !== "active" && source.location !== "archive" && source.location !== "both") throw bad();
  if (typeof source.digest !== "string" || !SHA256_HEX_RE.test(source.digest)) throw bad();
  const parsed = Lesson.safeParse(source.lesson);
  if (!parsed.success) throw bad();
  const lesson = parsed.data;
  if (lesson.world !== key.world || lesson.id !== key.id) throw bad();
  if (legacySourceDigestV1(lesson) !== source.digest) throw bad();
  return { lesson, digest: source.digest, location: source.location };
}

function mapSqliteErrors<T>(run: () => T): T {
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

/**
 * Host checks that depend on state outside this store. Both run inside the
 * transaction, after replay and tombstone checks, and only where needed.
 */
export interface CurationWriteContext {
  /** At most once: a first inbox annotation or an acknowledgement. */
  resolveSource(): LegacySourceSnapshot | null;
  /** At most once: a capture or a first inbox annotation, with the resolved source. */
  validateScope(source: LegacySourceSnapshot | null): void;
}

/**
 * What one write attempt is known to have done. `rolled-back` is proof that
 * nothing committed: the error came before COMMIT and the rollback finished.
 */
export type CurationWriteAttempt =
  | { state: "receipt"; receipt: CurationReceipt }
  | { state: "rolled-back"; error: unknown }
  | { state: "unknown"; error: unknown };

function mapSqliteError(error: unknown): unknown {
  if (error instanceof SQLiteError) {
    return new CurationError(isBusy(error) ? "STORAGE_BUSY" : "STORAGE_UNAVAILABLE", ["storage"]);
  }
  return error;
}

/** Validate, then try one curation change atomically. Never throws. */
export function attemptCurationMutation(
  db: CurationDatabase,
  input: CurationMutation,
  context: CurationWriteContext,
  deps: MutationDeps = NO_DEPS,
): CurationWriteAttempt {
  let m: CurationMutation;
  let hash: string;
  try {
    m = parseCurationMutation(input);
    checkBinding(db, m.binding);
    if (m.change.kind === "acknowledge-source" && m.key.kind !== "inbox") throw new CurationError("INVALID_INPUT", ["change.kind"]);
    hash = payloadHash(db.installationId, m);
  } catch (error) {
    return { state: "rolled-back", error };
  }
  const startedAt = new Date().toISOString();
  const sqlite = db.sqlite;
  try {
    sqlite.run("BEGIN IMMEDIATE");
  } catch (error) {
    // A failed BEGIN holds no write lock and wrote nothing.
    return sqlite.inTransaction ? { state: "unknown", error: mapSqliteError(error) } : { state: "rolled-back", error: mapSqliteError(error) };
  }
  let receipt: CurationReceipt;
  try {
    receipt = transact(db, m, hash, context, startedAt);
    deps.beforeCommit();
  } catch (error) {
    try {
      if (sqlite.inTransaction) sqlite.run("ROLLBACK");
    } catch {
      return { state: "unknown", error: mapSqliteError(error) };
    }
    return sqlite.inTransaction ? { state: "unknown", error: mapSqliteError(error) } : { state: "rolled-back", error: mapSqliteError(error) };
  }
  try {
    sqlite.run("COMMIT");
  } catch (error) {
    // A failed COMMIT is not proof of anything. Leave no open transaction behind.
    try {
      if (sqlite.inTransaction) sqlite.run("ROLLBACK");
    } catch {
      // Still unknown either way.
    }
    return { state: "unknown", error: mapSqliteError(error) };
  }
  try {
    deps.afterCommit?.();
  } catch (error) {
    return { state: "unknown", error };
  }
  return { state: "receipt", receipt };
}

/** Validate, then apply one curation change atomically. Returns the committed or replayed receipt. */
export function applyCurationMutationWith(
  db: CurationDatabase,
  input: CurationMutation,
  source: LegacySourceSnapshot | null,
  deps: MutationDeps,
): CurationReceipt {
  if (input?.key?.kind === "capture" && source !== null) {
    // Same order as before: shape errors first, then the stray source.
    parseCurationMutation(input);
    checkBinding(db, input.binding);
    throw new CurationError("INVALID_INPUT", ["source"]);
  }
  const outcome = attemptCurationMutation(db, input, { resolveSource: () => source, validateScope: () => {} }, deps);
  if (outcome.state === "receipt") return outcome.receipt;
  throw outcome.error;
}

export function applyCurationMutation(db: CurationDatabase, input: CurationMutation, source: LegacySourceSnapshot | null): CurationReceipt {
  return applyCurationMutationWith(db, input, source, NO_DEPS);
}

function transact(
  db: CurationDatabase,
  m: CurationMutation,
  hash: string,
  context: CurationWriteContext,
  startedAt: string,
): CurationReceipt {
  const sqlite = db.sqlite;
  const t = targetOf(m.key, m.scope);
  const key = m.key;

  // A known request replays its stored result before any other check.
  const prior = sqlite.query("SELECT * FROM requests WHERE request_id = ?").get(m.requestId) as RequestRow | null;
  if (prior !== null) {
    if (!sameTarget(prior, t)) throw new CurationError("CURATION_CONFLICT", ["requestId"]);
    if (prior.state === "purged") return receiptFrom(prior, key);
    if (prior.payload_hash !== hash) throw new CurationError("CURATION_CONFLICT", ["requestId"]);
    return receiptFrom(prior, key);
  }

  const row = sqlite
    .query("SELECT revision, project_kind, project_id, important, text, baseline_digest, purged FROM records WHERE world = ? AND kind = ? AND id_json = ?")
    .get(t.world, t.kind, t.idJson) as RecordRow | null;
  if (row !== null && !sameScope(row, t)) throw new CurationError("SCOPE_CONFLICT", ["scope"]);
  if (row === null) {
    const elsewhere = sqlite
      .query("SELECT 1 AS x FROM requests WHERE world = ? AND kind = ? AND id_json = ? AND (project_kind IS NOT ? OR project_id IS NOT ?) LIMIT 1")
      .get(t.world, t.kind, t.idJson, t.projectKind, t.projectId);
    if (elsewhere !== null) throw new CurationError("SCOPE_CONFLICT", ["scope"]);
  }

  const now = new Date().toISOString();
  const insertReceipt = (state: "committed" | "purged", revision: number | null, changed: boolean | null): void => {
    sqlite
      .query(
        `INSERT INTO requests (request_id, world, kind, id_json, project_kind, project_id, state, payload_hash, revision, changed, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.requestId,
        t.world,
        t.kind,
        t.idJson,
        t.projectKind,
        t.projectId,
        state,
        state === "committed" ? hash : null,
        revision,
        changed === null ? null : changed ? 1 : 0,
        startedAt,
        now,
      );
  };
  const purgedReceipt = (): CurationReceipt => {
    insertReceipt("purged", null, null);
    return { state: "purged", requestId: m.requestId, key, startedAt, finishedAt: now };
  };
  const committedReceipt = (revision: number, changed: boolean): CurationReceipt => {
    insertReceipt("committed", revision, changed);
    return { state: "committed", requestId: m.requestId, payloadHash: hash, key, revision, changed, startedAt, finishedAt: now };
  };
  const insertRevision = (
    revision: number,
    fields: { text?: string | null; important?: boolean | null; oldDigest?: string | null; newDigest?: string | null },
  ): void => {
    sqlite
      .query(
        `INSERT INTO revisions (world, kind, id_json, revision, change_kind, at, text, important, old_source_digest, new_source_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.world,
        t.kind,
        t.idJson,
        revision,
        m.change.kind,
        now,
        fields.text ?? null,
        fields.important === undefined || fields.important === null ? null : fields.important ? 1 : 0,
        fields.oldDigest ?? null,
        fields.newDigest ?? null,
      );
  };
  const insertRecord = (fields: { text: string | null; sourceJson: string | null; baseline: string | null; important: boolean; purged: boolean }): void => {
    sqlite
      .query(
        `INSERT INTO records (world, kind, id_json, project_kind, project_id, revision, important, text, original_text, source_json, baseline_digest, purged, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(t.world, t.kind, t.idJson, t.projectKind, t.projectId, fields.important ? 1 : 0, fields.text, fields.sourceJson, fields.baseline, fields.purged ? 1 : 0, now, now);
  };
  const readBack = (revision: number, purged: boolean): void => {
    const back = sqlite
      .query("SELECT revision, purged FROM records WHERE world = ? AND kind = ? AND id_json = ? AND project_kind = ? AND project_id IS ?")
      .get(t.world, t.kind, t.idJson, t.projectKind, t.projectId) as { revision: number; purged: number } | null;
    if (back === null || back.revision !== revision || back.purged !== (purged ? 1 : 0)) {
      throw new CurationError("STORAGE_UNAVAILABLE", ["record"]);
    }
  };
  const retireReceipts = (): void => {
    sqlite
      .query("UPDATE requests SET state = 'purged', payload_hash = NULL, revision = NULL, changed = NULL WHERE world = ? AND kind = ? AND id_json = ?")
      .run(t.world, t.kind, t.idJson);
  };

  const change = m.change;

  // Tombstones first: nothing but another purge request gets past one.
  if (row !== null && row.purged === 1) {
    if (change.kind !== "purge") throw new CurationError("PURGED", ["key"]);
    return purgedReceipt();
  }

  // The source is mutable outside this store. It is checked only after a
  // replay, scope and tombstone have had their say, and only where it is used:
  // a first annotation and an acknowledgement.
  const needsSource = (row === null && key.kind === "inbox") || change.kind === "acknowledge-source";
  const resolved = needsSource ? context.resolveSource() : null;
  const snapshot = resolved !== null ? checkSource(key, resolved) : null;

  if (change.kind === "capture") {
    if (row !== null) throw new CurationConflictError("CAPTURE_EXISTS", { key, revision: row.revision });
    if (m.expectedRevision !== 0) throw new CurationConflictError("CURATION_CONFLICT", { key, revision: 0 });
    context.validateScope(null);
    const s = change.source;
    const sourceJson = JSON.stringify({
      kind: s.kind,
      quote: s.quote,
      reference: s.reference,
      quoteRedacted: s.quoteRedacted,
      captureSessionId: s.captureSessionId,
      sourceConversationId: s.sourceConversationId,
      sourceRowId: s.sourceRowId,
      sourceAgentId: s.sourceAgentId,
    });
    insertRecord({ text: change.text, sourceJson, baseline: null, important: false, purged: false });
    insertRevision(1, { text: change.text });
    readBack(1, false);
    return committedReceipt(1, true);
  }

  // Only a saved capture can be changed; there is no virtual capture.
  if (row === null && key.kind === "capture") throw new CurationError("INVALID_INPUT", ["key"]);
  // A first annotation needs a real, matching source. Never a phantom.
  if (row === null && snapshot === null) throw new CurationError("SOURCE_CONFLICT", ["source"]);
  if (row === null) context.validateScope(snapshot);
  if (change.kind === "acknowledge-source" && (snapshot === null || snapshot.digest !== change.digest)) {
    throw new CurationError("SOURCE_CONFLICT", ["change.digest"]);
  }

  const current = row?.revision ?? 0;
  if (m.expectedRevision !== current) throw new CurationConflictError("CURATION_CONFLICT", { key, revision: current });
  const next = current + 1;

  if (change.kind === "purge") {
    if (row === null) {
      insertRecord({ text: null, sourceJson: null, baseline: null, important: false, purged: true });
    } else {
      sqlite
        .query(
          `UPDATE records SET revision = ?, important = 0, text = NULL, original_text = NULL, source_json = NULL,
             baseline_digest = NULL, purged = 1, updated_at = ?
           WHERE world = ? AND kind = ? AND id_json = ?`,
        )
        .run(next, now, t.world, t.kind, t.idJson);
      sqlite.query("DELETE FROM revisions WHERE world = ? AND kind = ? AND id_json = ?").run(t.world, t.kind, t.idJson);
    }
    insertRevision(next, {});
    retireReceipts();
    readBack(next, true);
    return purgedReceipt();
  }

  // Desired state, not a toggle: asking for what is already there changes nothing.
  const noop =
    (change.kind === "edit" && row !== null && row.text === change.text) ||
    (change.kind === "important" && (row?.important ?? 0) === (change.value ? 1 : 0)) ||
    // A first acknowledgment is a first annotation: it must save the baseline.
    (change.kind === "acknowledge-source" && row !== null && row.baseline_digest === change.digest);
  if (noop) return committedReceipt(current, false);

  if (row === null) {
    // First annotation of an existing inbox lesson: baseline is the source observed now.
    const baseline = snapshot!.digest;
    const text = change.kind === "edit" ? change.text : null;
    const important = change.kind === "important" && change.value;
    insertRecord({ text, sourceJson: null, baseline, important, purged: false });
    insertRevision(1, { text, important: change.kind === "important" ? change.value : null, newDigest: baseline });
    readBack(1, false);
    return committedReceipt(1, true);
  }

  const update = (set: string, values: Array<string | number | null>): void => {
    sqlite
      .query(`UPDATE records SET ${set}, revision = ?, updated_at = ? WHERE world = ? AND kind = ? AND id_json = ?`)
      .run(...values, next, now, t.world, t.kind, t.idJson);
  };
  if (change.kind === "edit") {
    update("text = ?", [change.text]);
    insertRevision(next, { text: change.text });
  } else if (change.kind === "important") {
    update("important = ?", [change.value ? 1 : 0]);
    insertRevision(next, { important: change.value });
  } else {
    update("baseline_digest = ?", [change.digest]);
    insertRevision(next, { oldDigest: row.baseline_digest, newDigest: change.digest });
  }
  readBack(next, false);
  return committedReceipt(next, true);
}

/** Receipt for a request under its own scope and key. Absent or out of scope reads as unknown. */
export function getCurationReceipt(db: CurationDatabase, scope: LessonScope, key: LessonKey, requestId: string): CurationReceipt {
  if (typeof requestId !== "string" || !CURATION_REQUEST_ID_RE.test(requestId)) throw new CurationError("INVALID_INPUT", ["requestId"]);
  const keyProblems = lessonKeyProblems(key).map((field) => `key.${field}`);
  if (keyProblems.length > 0) throw new CurationError("INVALID_INPUT", keyProblems);
  const project = scope?.project;
  const projectOk =
    project?.kind === "world" ||
    project?.kind === "unresolved" ||
    (project?.kind === "project" && typeof project.id === "string" && PROJECT_ID_RE.test(project.id));
  if (!projectOk) throw new CurationError("INVALID_INPUT", ["scope.project"]);
  if (scope.world !== key.world) throw new CurationError("SCOPE_CONFLICT", ["key.world"]);
  const t = targetOf(key, scope);
  const row = mapSqliteErrors(() => db.sqlite.query("SELECT * FROM requests WHERE request_id = ?").get(requestId) as RequestRow | null);
  if (row === null || !sameTarget(row, t)) return { state: "unknown", requestId };
  // The stored id must decode to the asked key exactly.
  if (decodeRecordId(row.id_json) !== key.id) return { state: "unknown", requestId };
  return receiptFrom(row, key);
}
