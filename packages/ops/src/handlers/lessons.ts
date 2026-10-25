// Lesson curation: read handlers and the curation mutation owner. All SQL and
// business rules live in @sil/store; this file only wires host state (config,
// legacy sources, project roots) into the store's one write path.

import { loadConfig, type Config, type World } from "@sil/core";
import type { CurationTransportReceipt, ExecutingStore } from "@sil/core/control-mutation";
import type { CurationReadResult } from "@sil/core/curation-read";
import { CurationError, type CurationQuery, type CurationReceipt, type LessonScope } from "@sil/core/lesson-curation";
import type { CurationMutationArgs } from "@sil/core/lesson-curation-wire";
import {
  attemptCurationMutation,
  browseCuratedLessons,
  getCuratedLesson,
  getCurationReceipt,
  inspectCurationStore,
  listCurationProjects,
  locateCuratedLesson,
  openCurationStoreForMutation,
  openCurationStoreForRead,
  readCurationHistory,
  readLegacySource,
  resolveCurationContext,
  storedScopes,
  validateCurationScope,
  type CurationDatabase,
} from "@sil/store";
import type {
  LessonsBrowseArgs,
  LessonsContextArgs,
  LessonsHistoryArgs,
  LessonsLocateArgs,
  LessonsProjectsArgs,
  LessonsReceiptArgs,
  LessonsRecordArgs,
} from "../args.ts";

/** The configured world of that name, or INVALID_INPUT. Never a guessed default. */
export function configuredWorld(config: Config, name: string): World {
  const world = config.worlds.find((w) => w.name === name);
  if (world === undefined) throw new CurationError("INVALID_INPUT", ["world"]);
  return world;
}

const scopeOf = (world: string, project: LessonScope["project"]): LessonScope => ({ world, project });

export function lessonsProjects(a: LessonsProjectsArgs) {
  const config = loadConfig();
  return listCurationProjects(configuredWorld(config, a.world), a.binding, { config });
}

export function lessonsContext(a: LessonsContextArgs) {
  const config = loadConfig();
  return resolveCurationContext(a.cwd, configuredWorld(config, a.world), config);
}

export function lessonsBrowse(a: LessonsBrowseArgs) {
  const query: CurationQuery = { scope: scopeOf(a.world, a.project), collection: a.collection };
  if (a.important !== undefined) query.important = a.important;
  if (a.search !== undefined) query.search = a.search;
  if (a.cursor !== undefined) query.cursor = a.cursor;
  if (a.limit !== undefined) query.limit = a.limit;
  return browseCuratedLessons(query, a.binding);
}

export function lessonsGet(a: LessonsRecordArgs) {
  return getCuratedLesson(scopeOf(a.key.world, a.project), a.key, a.binding);
}

/** Scope of one lesson by exact key. No content, so a link can find its project. */
export function lessonsLocate(a: LessonsLocateArgs) {
  return locateCuratedLesson(a.key, a.binding);
}

export function lessonsHistory(a: LessonsHistoryArgs) {
  return readCurationHistory(scopeOf(a.key.world, a.project), a.key, a.binding, a.cursor, a.limit);
}

/** A receipt from the store this read actually opened. Absent is unknown, never failed. */
export function lessonsReceipt(a: LessonsReceiptArgs): CurationReadResult<CurationReceipt> {
  const handle = openCurationStoreForRead(a.binding);
  try {
    const value: CurationReceipt =
      handle.db === null ? { state: "unknown", requestId: a.requestId } : getCurationReceipt(handle.db, scopeOf(a.key.world, a.project), a.key, a.requestId);
    return { store: handle.identity, value };
  } finally {
    handle.db?.close();
  }
}

export function lessonsStore() {
  return inspectCurationStore();
}

// --- mutation owner -------------------------------------------------------

/**
 * `refused` only when this owner can prove nothing committed: the open failed
 * (an open never writes a record) or the store rolled the attempt back.
 * Anything else throws, and the dispatcher reports an unknown outcome.
 */
export type CurationOwnerResult =
  | { state: "receipt"; receipt: CurationTransportReceipt; store: ExecutingStore }
  | { state: "refused"; error: CurationError };

function transportReceipt(receipt: CurationReceipt): CurationTransportReceipt {
  if (receipt.state === "committed") {
    return {
      requestId: receipt.requestId,
      payloadHash: receipt.payloadHash,
      state: "completed",
      result: { key: receipt.key, revision: receipt.revision, changed: receipt.changed },
      error: null,
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt,
    };
  }
  if (receipt.state === "purged") {
    return { requestId: receipt.requestId, state: "purged", payloadHash: null, result: null, error: null, startedAt: receipt.startedAt, finishedAt: receipt.finishedAt };
  }
  throw new Error("a write attempt never yields an unknown receipt");
}

function projectIds(db: CurationDatabase, world: string): Set<string> {
  return new Set(storedScopes(db, world).flatMap((s) => (s.project.kind === "project" ? [s.project.id] : [])));
}

export async function executeCurationMutation(requestId: string, args: CurationMutationArgs): Promise<CurationOwnerResult> {
  const { mutation, precondition, projectRoot } = args;
  if (mutation.requestId !== requestId) throw new Error("request id was not checked before dispatch");
  const config = loadConfig();
  const world = configuredWorld(config, mutation.key.world);

  let db: CurationDatabase;
  try {
    db = openCurationStoreForMutation(mutation.binding, precondition);
  } catch (error) {
    if (error instanceof CurationError) return { state: "refused", error };
    throw error;
  }
  let outcome;
  try {
    const key = mutation.key;
    outcome = attemptCurationMutation(db, mutation, {
      resolveSource: () => (key.kind === "inbox" ? readLegacySource(key) : null),
      validateScope: (source) => {
        validateCurationScope({ world, config, scope: mutation.scope, key, source, projectRoot, storedProjectIds: projectIds(db, world.name) });
      },
    });
  } finally {
    // A close failure after a commit is an unknown outcome: let it throw.
    db.close();
  }
  if (outcome.state === "receipt") {
    return { state: "receipt", receipt: transportReceipt(outcome.receipt), store: { locationId: db.locationId, installationId: db.installationId } };
  }
  if (outcome.state === "rolled-back" && outcome.error instanceof CurationError) return { state: "refused", error: outcome.error };
  throw new Error("curation write outcome is not proven");
}
