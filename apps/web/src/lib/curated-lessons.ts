// Web adapter for curated lessons. Pure helpers: exact-record routes, flat
// read args, strict response decoding, the guarded mutation transport and
// session storage for opaque ids. The shared editor state machine lives in
// @sil/core/lesson-curation-ui; nothing here decides authority.

import { classifyMutationFailure, decodeCurationMutationResponse, type CurationTransportReceipt, type ExecutingStore } from "@sil/core/control-mutation";
import type { CuratedLessonDetail, CuratedProvenance, CurationBrowsePage, ProjectChoice, ProjectDescriptor } from "@sil/core/curation-read";
import {
  CurationError,
  PROJECT_ID_RE,
  SHA256_HEX_RE,
  UUID_RE,
  decodeLessonKey,
  encodeLessonKey,
  lessonKeyProblems,
  type CaptureSource,
  type CurationReceipt,
  type CurationRevision,
  type LessonKey,
  type LessonScope,
  type LessonView,
  type ProjectScope,
  type StoreBinding,
} from "@sil/core/lesson-curation";
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

// --- flat read args --------------------------------------------------------

export const flatBinding = (binding: StoreBinding): string => `${binding.kind}:${binding.id}`;
export const flatProject = (project: ProjectScope): string => (project.kind === "project" ? project.id : project.kind);

export function parseFlatProject(value: unknown): ProjectScope | null {
  if (value === "world" || value === "unresolved") return { kind: value };
  if (typeof value === "string" && PROJECT_ID_RE.test(value)) return { kind: "project", id: value };
  return null;
}

export type BrowseCollection = "saved" | "inbox" | "archived" | "all";
export interface BrowseInput {
  world: string;
  project: ProjectScope;
  binding: StoreBinding;
  collection: BrowseCollection;
  important?: boolean;
  search?: string;
  cursor?: string;
  limit?: number;
}

/** Exact strings for the shared flat schema. A false importance filter stays "false". */
export function browseQuery(input: BrowseInput): Record<string, string> {
  const out: Record<string, string> = {
    world: input.world,
    project: flatProject(input.project),
    binding: flatBinding(input.binding),
    collection: input.collection,
  };
  if (input.important !== undefined) out["important"] = input.important ? "true" : "false";
  if (input.search !== undefined && input.search !== "") out["search"] = input.search;
  if (input.cursor !== undefined) out["cursor"] = input.cursor;
  if (input.limit !== undefined) out["limit"] = String(input.limit);
  return out;
}

// --- strict decoding -------------------------------------------------------

/** A read failed: the host code, TRANSPORT (no response) or MALFORMED (not the expected shape). */
export class CurationReadError extends Error {
  override name = "CurationReadError";
  constructor(
    readonly code: string,
    readonly status: number | null,
  ) {
    super(`curation read failed: ${code}`);
  }
}

type Rec = Record<string, unknown>;
const malformed = (): never => {
  throw new CurationReadError("MALFORMED", null);
};

function rec(value: unknown): Rec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed();
  return value as Rec;
}
function exact(value: unknown, keys: readonly string[]): Rec {
  const r = rec(value);
  const own = Object.keys(r);
  if (own.length !== keys.length || !keys.every((k) => Object.hasOwn(r, k))) malformed();
  return r;
}
const str = (v: unknown): string => (typeof v === "string" ? v : malformed());
const strOrNull = (v: unknown): string | null => (v === null ? null : str(v));
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : malformed());
const nat = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : malformed());
const digestOrNull = (v: unknown): string | null => (v === null ? null : SHA256_HEX_RE.test(str(v)) ? (v as string) : malformed());
function list<T>(v: unknown, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) return malformed();
  return v.map(item);
}

export function decodeKey(value: unknown): LessonKey {
  const r = exact(value, ["world", "kind", "id"]);
  const key = { world: str(r["world"]), kind: str(r["kind"]), id: str(r["id"]) } as LessonKey;
  if (lessonKeyProblems(key).length > 0) malformed();
  return key;
}

export function decodeScope(value: unknown): LessonScope {
  const r = exact(value, ["world", "project"]);
  const p = rec(r["project"]);
  let project: ProjectScope;
  if (p["kind"] === "project") {
    exact(p, ["kind", "id"]);
    const id = str(p["id"]);
    if (!PROJECT_ID_RE.test(id)) malformed();
    project = { kind: "project", id };
  } else if (p["kind"] === "world" || p["kind"] === "unresolved") {
    exact(p, ["kind"]);
    project = { kind: p["kind"] };
  } else return malformed();
  return { world: str(r["world"]), project };
}

const SOURCE_KEYS = ["kind", "quote", "reference", "quoteRedacted", "captureSessionId", "sourceConversationId", "sourceRowId", "sourceAgentId"];
function decodeSource(value: unknown): CaptureSource {
  const r = exact(value, SOURCE_KEYS);
  if (r["kind"] !== "explicit_quote" && r["kind"] !== "native_selection") malformed();
  return {
    kind: r["kind"] as CaptureSource["kind"],
    quote: strOrNull(r["quote"]),
    reference: strOrNull(r["reference"]),
    quoteRedacted: bool(r["quoteRedacted"]),
    captureSessionId: strOrNull(r["captureSessionId"]),
    sourceConversationId: strOrNull(r["sourceConversationId"]),
    sourceRowId: strOrNull(r["sourceRowId"]),
    sourceAgentId: strOrNull(r["sourceAgentId"]),
  };
}

const STATUSES = ["saved", "queued", "archived", "missing", "changed", "conflict", "invalid", "purged"];
const VIEW_KEYS = ["key", "scope", "revision", "important", "effectiveText", "originalText", "source", "sourceStatus", "sourceDigest", "baselineDigest", "relatedPattern", "created", "updated"];
export function decodeView(value: unknown): LessonView {
  const r = exact(value, VIEW_KEYS);
  const key = decodeKey(r["key"]);
  const scope = decodeScope(r["scope"]);
  if (scope.world !== key.world) malformed();
  const status = str(r["sourceStatus"]);
  if (!STATUSES.includes(status)) malformed();
  return {
    key,
    scope,
    revision: nat(r["revision"]),
    important: bool(r["important"]),
    effectiveText: strOrNull(r["effectiveText"]),
    originalText: strOrNull(r["originalText"]),
    source: r["source"] === null ? null : decodeSource(r["source"]),
    sourceStatus: status as LessonView["sourceStatus"],
    sourceDigest: digestOrNull(r["sourceDigest"]),
    baselineDigest: digestOrNull(r["baselineDigest"]),
    relatedPattern: strOrNull(r["relatedPattern"]),
    created: str(r["created"]),
    updated: str(r["updated"]),
  };
}

function decodeProvenance(value: unknown): CuratedProvenance {
  const r = rec(value);
  if (r["kind"] === "purged") return exact(r, ["kind"]) && { kind: "purged" };
  if (r["kind"] === "capture") {
    exact(r, ["kind", "source"]);
    return { kind: "capture", source: decodeSource(r["source"]) };
  }
  if (r["kind"] !== "existing_lesson") return malformed();
  if (r["state"] === "available") {
    exact(r, ["kind", "state", "location", "digest", "reflectionId", "repo", "pattern", "created"]);
    const location = str(r["location"]);
    if (!["active", "archive", "both"].includes(location)) malformed();
    return {
      kind: "existing_lesson",
      state: "available",
      location: location as "active" | "archive" | "both",
      digest: str(r["digest"]),
      reflectionId: strOrNull(r["reflectionId"]),
      repo: strOrNull(r["repo"]),
      pattern: str(r["pattern"]),
      created: str(r["created"]),
    };
  }
  if (r["state"] === "conflict") {
    exact(r, ["kind", "state", "copies"]);
    return {
      kind: "existing_lesson",
      state: "conflict",
      copies: list(r["copies"], (c) => {
        const x = exact(c, ["location", "digest", "reflectionId", "repo", "pattern", "created", "text"]);
        const location = str(x["location"]);
        if (location !== "active" && location !== "archive") malformed();
        return {
          location: location as "active" | "archive",
          digest: str(x["digest"]),
          reflectionId: strOrNull(x["reflectionId"]),
          repo: strOrNull(x["repo"]),
          pattern: str(x["pattern"]),
          created: str(x["created"]),
          text: str(x["text"]),
        };
      }),
    };
  }
  if (r["state"] === "unavailable") {
    exact(r, ["kind", "state", "problem", "retainedDigest"]);
    return { kind: "existing_lesson", state: "unavailable", problem: str(r["problem"]) as never, retainedDigest: strOrNull(r["retainedDigest"]) };
  }
  return malformed();
}

export function decodeLessonDetail(value: unknown): CuratedLessonDetail {
  const r = exact(value, ["lesson", "provenance", "diagnostics"]);
  // Diagnostics are display-only codes; keep only objects with a string code.
  const diagnostics = list(r["diagnostics"], (d) => {
    const x = rec(d);
    str(x["code"]);
    return x as unknown as CuratedLessonDetail["diagnostics"][number];
  });
  return { lesson: decodeView(r["lesson"]), provenance: decodeProvenance(r["provenance"]), diagnostics };
}

export type StoreState = { state: "ready"; installationId: string } | { state: "uninitialized"; locationId: string } | { state: "error"; code: string };

export function decodeStoreStatus(value: unknown): StoreState {
  const r = rec(value);
  if (r["state"] === "ready") {
    const b = exact(rec(r["binding"]), ["kind", "id"]);
    if (b["kind"] !== "installation" || !UUID_RE.test(str(b["id"]))) malformed();
    return { state: "ready", installationId: b["id"] as string };
  }
  if (r["state"] === "uninitialized") {
    const b = exact(rec(r["binding"]), ["kind", "id"]);
    if (b["kind"] !== "location" || !SHA256_HEX_RE.test(str(b["id"]))) malformed();
    return { state: "uninitialized", locationId: b["id"] as string };
  }
  if (r["state"] === "error") return { state: "error", code: str(r["code"]) };
  return malformed();
}

export type ReadStore = { locationId: string; installationId: string | null };

/** `{ store, value }` from the read handle that answered. */
export function decodeReadResult<T>(value: unknown, decodeValue: (v: unknown) => T): { store: ReadStore; value: T } {
  const r = exact(value, ["store", "value"]);
  const s = exact(r["store"], ["locationId", "installationId"]);
  const locationId = str(s["locationId"]);
  const installationId = strOrNull(s["installationId"]);
  if (!SHA256_HEX_RE.test(locationId) || (installationId !== null && !UUID_RE.test(installationId))) malformed();
  return { store: { locationId, installationId }, value: decodeValue(r["value"]) };
}

/** Keep the executing store until the session has checked the current read context. */
export function decodeLocatedResult(value: unknown, installationId: string, key: LessonKey): { store: ReadStore; value: LessonScope | null } {
  const result = decodeReadResult(value, (v) => (v === null ? null : decodeScope(v)));
  if (result.store.installationId !== installationId) throw new CurationReadError("INSTALLATION_MISMATCH", null);
  if (result.value !== null && result.value.world !== key.world) malformed();
  return result;
}

/** Compatibility projection for callers that need only the located scope. */
export function decodeLocated(value: unknown, installationId: string, key: LessonKey): LessonScope | null {
  return decodeLocatedResult(value, installationId, key).value;
}

export function decodeBrowsePage(value: unknown): CurationBrowsePage {
  const r = exact(value, ["items", "nextCursor", "total", "sourceProblems", "sourceProblemsTotal"]);
  return {
    items: list(r["items"], decodeView),
    nextCursor: strOrNull(r["nextCursor"]),
    total: nat(r["total"]),
    sourceProblems: list(r["sourceProblems"], (p) => {
      const x = exact(p, ["location", "file", "problem"]);
      return { location: str(x["location"]) as "active" | "archive", file: str(x["file"]), problem: str(x["problem"]) as never };
    }),
    sourceProblemsTotal: nat(r["sourceProblemsTotal"]),
  };
}

const REVISION_KINDS = ["capture", "edit", "important", "acknowledge-source", "purge"];
export interface HistoryPage {
  items: CurationRevision[];
  nextCursor: string | null;
  total: number;
}
/** One history page, newest first, with the cursor for the next older page. */
export function decodeHistory(value: unknown): HistoryPage {
  const r = exact(value, ["items", "nextCursor", "total"]);
  const items = list(r["items"], (x) => {
    const e = exact(x, ["revision", "kind", "at", "text", "important", "oldSourceDigest", "newSourceDigest"]);
    const kind = str(e["kind"]);
    if (!REVISION_KINDS.includes(kind)) malformed();
    return {
      revision: nat(e["revision"]),
      kind: kind as CurationRevision["kind"],
      at: str(e["at"]),
      text: strOrNull(e["text"]),
      important: e["important"] === null ? null : bool(e["important"]),
      oldSourceDigest: digestOrNull(e["oldSourceDigest"]),
      newSourceDigest: digestOrNull(e["newSourceDigest"]),
    };
  });
  return { items, nextCursor: strOrNull(r["nextCursor"]), total: nat(r["total"]) };
}

export function decodeProjects(value: unknown): ProjectChoice[] {
  return list(value, (x) => {
    const c = exact(x, ["scope", "label", "root", "available", "origins"]);
    return {
      scope: decodeScope(c["scope"]),
      label: str(c["label"]),
      root: strOrNull(c["root"]),
      available: bool(c["available"]),
      origins: list(c["origins"], (o) => str(o) as ProjectChoice["origins"][number]),
    };
  });
}

export function decodeReceiptRead(value: unknown, requestId: string): CurationReceipt {
  const r = rec(value);
  if (r["requestId"] !== requestId) malformed();
  if (r["state"] === "unknown") return { state: "unknown", requestId };
  if (r["state"] === "purged") {
    exact(r, ["state", "requestId", "key", "startedAt", "finishedAt"]);
    return { state: "purged", requestId, key: decodeKey(r["key"]), startedAt: str(r["startedAt"]), finishedAt: str(r["finishedAt"]) };
  }
  if (r["state"] === "committed") {
    exact(r, ["state", "requestId", "payloadHash", "key", "revision", "changed", "startedAt", "finishedAt"]);
    return {
      state: "committed",
      requestId,
      payloadHash: str(r["payloadHash"]),
      key: decodeKey(r["key"]),
      revision: nat(r["revision"]),
      changed: bool(r["changed"]),
      startedAt: str(r["startedAt"]),
      finishedAt: str(r["finishedAt"]),
    };
  }
  return malformed();
}

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

/** A commit counts as shown only once a fresh read of the same record is at least that revision. */
export function readbackConfirms(committedRevision: number, key: LessonKey, view: LessonView): boolean {
  return view.key.world === key.world && view.key.kind === key.kind && view.key.id === key.id && view.revision >= committedRevision;
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
