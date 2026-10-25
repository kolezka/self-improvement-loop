// Web adapter for curated lessons. Pure helpers: exact-record routes, flat
// read args, strict response decoding, the guarded mutation transport and
// session storage for opaque ids. The shared editor state machine lives in
// @sil/core/lesson-curation-ui; nothing here decides authority.

import { classifyMutationFailure, decodeCurationMutationResponse, type CurationTransportReceipt, type ExecutingStore } from "@sil/core/control-mutation";
import { CurationReadError, flatProject, parseFlatProject } from "@sil/core/curation-client";
import type { ProjectDescriptor } from "@sil/core/curation-read";
import { CurationError, UUID_RE, decodeLessonKey, encodeLessonKey, type LessonKey, type ProjectScope } from "@sil/core/lesson-curation";
import { encodeCurationMutationRequest, curationOpFor, type PreparedCurationMutation } from "@sil/core/lesson-curation-wire";
import type { LessonAttemptOutcome, LessonAttemptSuccess, LessonEditorSnapshot } from "@sil/core/lesson-curation-ui";

/** Same budget as the control transport. Bounds waiting, never server work. */
export const MUTATION_TIMEOUT_MS = 10_000;
export const REFRESH_INTERVAL_MS = 10_000;

// --- routes ----------------------------------------------------------------

const ROUTE_PREFIX = "/artifacts/lesson/";

export type LessonRoute = { kind: "none" } | { kind: "invalid" } | { kind: "record"; installationId: string; key: LessonKey };

/** `#/artifacts/lesson/<installation uuid>/<encoded key>`. Starts with "/", so it is never a token. */
export function lessonRouteHash(installationId: string, key: LessonKey): string {
  return `#${ROUTE_PREFIX}${installationId}/${encodeLessonKey(key)}`;
}

export function parseLessonRoute(hash: string): LessonRoute {
  const raw = hash.replace(/^#/, "");
  if (!raw.startsWith(ROUTE_PREFIX)) return raw === ROUTE_PREFIX.slice(0, -1) ? { kind: "invalid" } : { kind: "none" };
  const parts = raw.slice(ROUTE_PREFIX.length).split("/");
  if (parts.length !== 2) return { kind: "invalid" };
  const [installationId, encoded] = parts as [string, string];
  if (!UUID_RE.test(installationId)) return { kind: "invalid" };
  try {
    return { kind: "record", installationId, key: decodeLessonKey(encoded) };
  } catch {
    return { kind: "invalid" };
  }
}

// --- flat read args and strict decoding ----------------------------------
// Pure, shared with the native console. Re-exported so callers keep importing
// them from here; CurationReadError is the same class either way.

export {
  CurationReadError,
  browseQuery,
  decodeBrowsePage,
  decodeHistory,
  decodeKey,
  decodeLessonDetail,
  decodeLocated,
  decodeLocatedResult,
  decodeProjects,
  decodeReadResult,
  decodeReceiptRead,
  decodeScope,
  decodeStoreStatus,
  decodeView,
  flatBinding,
  flatProject,
  parseFlatProject,
  readbackConfirms,
  type BrowseCollection,
  type BrowseInput,
  type HistoryPage,
  type ReadStore,
  type StoreState,
} from "@sil/core/curation-client";

type Rec = Record<string, unknown>;

// --- transports ------------------------------------------------------------

export interface ReadDeps {
  fetch: typeof fetch;
  headers: Record<string, string>;
  origin: string;
}

const pathFor = (op: string): string => `/api/${op.replace(/\./g, "/")}`;

/** One typed GET. Never the generic `call`, which drops the host code. */
export async function curationRead<T>(op: string, args: Record<string, string>, decode: (value: unknown) => T, deps: ReadDeps): Promise<T> {
  const url = new URL(pathFor(op), deps.origin);
  for (const [k, v] of Object.entries(args)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await deps.fetch(url.toString(), { headers: deps.headers });
  } catch {
    throw new CurationReadError("TRANSPORT", null);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new CurationReadError(res.ok ? "MALFORMED" : `HTTP_${res.status}`, res.status);
  }
  if (!res.ok) {
    const code = typeof (body as Rec | null)?.["code"] === "string" ? ((body as Rec)["code"] as string) : `HTTP_${res.status}`;
    throw new CurationReadError(code, res.status);
  }
  return decode(body);
}

export interface MutationDeps {
  fetch: typeof fetch;
  headers: Record<string, string>;
  timeoutMs: number;
}

export type MutationCompletion = { completion: LessonAttemptOutcome | LessonAttemptSuccess; conflictRevision: number | null };

/**
 * Sends one prepared mutation through the guarded route. Never throws. Only a
 * decoded success carries a store; only the closed refusal set is refused;
 * anything else, including a timeout, is unknown and never a cancellation.
 */
export async function sendCurationMutation(prepared: PreparedCurationMutation, project: ProjectDescriptor | null, deps: MutationDeps): Promise<MutationCompletion> {
  const requestId = prepared.mutation.requestId;
  let body: string;
  let op: string | undefined;
  try {
    body = encodeCurationMutationRequest(prepared, project);
    op = curationOpFor(prepared.mutation.change.kind);
  } catch (error) {
    // Nothing was sent: a local refusal is definite.
    if (error instanceof CurationError) return { completion: { kind: "refused", code: error.code, fields: [...error.fields] }, conflictRevision: null };
    return { completion: { kind: "refused", code: "INVALID_INPUT", fields: ["$"] }, conflictRevision: null };
  }
  if (op === undefined) return { completion: { kind: "refused", code: "INVALID_INPUT", fields: ["change.kind"] }, conflictRevision: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  const unknown: MutationCompletion = { completion: { kind: "unknown" }, conflictRevision: null };
  try {
    const res = await deps.fetch(pathFor(op), {
      method: "POST",
      headers: { ...deps.headers, "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    const response = decodeCurationMutationResponse(text, requestId);
    if ("receipt" in response) {
      const store: ExecutingStore = { ...response.store };
      const receipt: CurationTransportReceipt = response.receipt;
      return { completion: { kind: "success", store, receipt }, conflictRevision: null };
    }
    if (classifyMutationFailure(response.error) !== "refused") return unknown;
    return { completion: { kind: "refused", code: response.error.code, fields: [] }, conflictRevision: response.conflict?.revision ?? null };
  } catch {
    return unknown;
  } finally {
    clearTimeout(timer);
  }
}


export const newRequestId = (): string => `lc_${crypto.randomUUID()}`;

// --- session storage -------------------------------------------------------

type StorageAccess = () => Storage;
const snapshotKey = (world: string) => `sil-curation-editor:v2:${world}`;
const projectKey = (world: string) => `sil-curation-project:v1:${world}`;

/** "written", "not-owner" when a newer pane holds the key, or "failed" when storage refuses. */
export type SnapshotWrite = "written" | "not-owner" | "failed";

function storedOwner(s: Storage, world: string): string | null {
  const raw = s.getItem(snapshotKey(world));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Rec;
    return typeof value?.["owner"] === "string" ? (value["owner"] as string) : null;
  } catch {
    return null;
  }
}

/**
 * Writes controller.snapshot() only: opaque ids, never wording. The key names
 * its writing pane; a pane that no longer owns it never overwrites a newer one.
 */
export function saveSnapshot(storage: StorageAccess, world: string, owner: string, snapshot: LessonEditorSnapshot): SnapshotWrite {
  try {
    const s = storage();
    const current = storedOwner(s, world);
    if (current !== null && current !== owner) return "not-owner";
    s.setItem(snapshotKey(world), JSON.stringify({ owner, snapshot }));
    return "written";
  } catch {
    return "failed";
  }
}

/** A newly mounted pane takes the key, whoever wrote it last. */
export function claimSnapshot(storage: StorageAccess, world: string, owner: string, snapshot: LessonEditorSnapshot): SnapshotWrite {
  try {
    storage().setItem(snapshotKey(world), JSON.stringify({ owner, snapshot }));
    return "written";
  } catch {
    return "failed";
  }
}

/** The stored snapshot for this world, or null. Hydrate still validates it. */
export function loadSnapshot(storage: StorageAccess, world: string): unknown {
  try {
    const s = storage();
    const raw = s.getItem(snapshotKey(world));
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw) as Rec;
      if (typeof value !== "object" || value === null || !Object.hasOwn(value, "snapshot")) throw new Error("shape");
      return value["snapshot"];
    } catch {
      s.removeItem(snapshotKey(world));
      return null;
    }
  } catch {
    return null;
  }
}

export function clearSnapshot(storage: StorageAccess, world: string): void {
  try {
    storage().removeItem(snapshotKey(world));
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

export function saveProjectPreference(storage: StorageAccess, world: string, installationId: string, project: ProjectScope): boolean {
  try {
    storage().setItem(projectKey(world), JSON.stringify({ installationId, project: flatProject(project) }));
    return true;
  } catch {
    return false;
  }
}

/** A remembered project, only for the same installation and only if it is still a valid project value. */
export function loadProjectPreference(storage: StorageAccess, world: string, installationId: string): ProjectScope | null {
  try {
    const raw = storage().getItem(projectKey(world));
    if (raw === null) return null;
    const value = JSON.parse(raw) as Rec;
    if (typeof value !== "object" || value === null || value["installationId"] !== installationId) return null;
    return parseFlatProject(value["project"]);
  } catch {
    return null;
  }
}

// --- leave guards ----------------------------------------------------------

export type LeaveGuard = (proceed: () => void) => boolean;
export type LeaveGuardOwner = { readonly id: number };

/** One active guard. Only its owner can remove it, so a late teardown cannot clear a newer pane's guard. */
export function createLeaveGuards() {
  let current: { owner: LeaveGuardOwner; guard: LeaveGuard } | null = null;
  let next = 0;
  return {
    register(guard: LeaveGuard): LeaveGuardOwner {
      const owner = Object.freeze({ id: ++next });
      current = { owner, guard };
      return owner;
    },
    unregister(owner: LeaveGuardOwner): void {
      if (current?.owner === owner) current = null;
    },
    /** Runs proceed now, or leaves it to the guard, which may call it later. */
    request(proceed: () => void): void {
      if (current === null || current.guard(proceed)) proceed();
    },
  };
}
