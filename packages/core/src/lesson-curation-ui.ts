// Shared lesson editor state machine for the native and web consoles. Pure:
// no I/O, clocks, randomness or host globals. Adapters own transport, focus
// and display, and supply generated ids. Host validation stays authoritative.

import { WORLD_NAME_RE } from "./consts.ts";
import { CURATION_REFUSAL_CODES, type CurationTransportReceipt, type ExecutingStore } from "./control-mutation.ts";
import {
  CURATION_ERROR_CODES,
  CURATION_REQUEST_ID_RE,
  CurationError,
  encodeLessonKey,
  hasVisibleText,
  isWellFormed,
  lessonKeyProblems,
  MAX_MUTATION_BYTES,
  MAX_QUOTE_BYTES,
  MAX_REFERENCE_BYTES,
  MAX_TEXT_BYTES,
  PROJECT_ID_RE,
  SHA256_HEX_RE,
  UUID_RE,
  utf8Bytes,
  type CaptureSource,
  type CurationChange,
  type CurationErrorCode,
  type CurationMutation,
  type CurationReceipt,
  type CurationRevision,
  type LessonKey,
  type LessonScope,
  type LessonView,
  type SourceStatus,
  type StoreBinding,
} from "./lesson-curation.ts";

export type LessonEditorPhase = "idle" | "editing" | "saving" | "saved" | "conflict" | "unknown" | "purged" | "error";
/** Full identity: which store, which project view, which record. */
export type LessonEditorTarget = { scope: LessonScope; binding: StoreBinding; key: LessonKey; installationId?: string };
/** Persisted constraints are not live authority. Keep this input outside native/browser state. */
export type LessonHostObservation = {
  connectionEpoch: string;
  binding: StoreBinding;
  installationId: string | null;
  /** Host opens with the expected UUID, disables initialization, and writes on that same handle. */
  pinnedLocationRetry: boolean;
};
/** Metadata from the handle that executed this exact operation, never a later path inspection. */
export type LessonHostResult = {
  operation: "read" | "mutation" | "receipt";
  connectionEpoch: string;
  generation: number;
  target: LessonEditorTarget;
  requestId?: string;
  installationId: string | null;
};
/** How one attempt ended when its response named no executing store. */
export type LessonAttemptOutcome = { kind: "unknown" } | { kind: "refused"; code: string; fields: string[] };
/** A decoded success: the executing handle's identity and its transport receipt. */
export type LessonAttemptSuccess = { kind: "success"; store: ExecutingStore; receipt: CurationTransportReceipt };
/** What one attempt actually sent. Recorded by the controller, never rebuilt from current selection. */
export type LessonAttemptCorrelation = {
  generation: number;
  requestId: string;
  target: LessonEditorTarget;
  precondition: PreparedLessonMutation["precondition"];
  /** Installation the request was bound to when sent; null for a bootstrap. */
  origin: string | null;
  /** The request already had an unknown outcome when this attempt began. */
  afterUnknown: boolean;
};
declare const attemptBrand: unique symbol;
/** Opaque and compared by reference. Only LessonEditorController.beginAttempt makes one. */
export type LessonAttemptToken = { readonly [attemptBrand]: true };
export type LessonEditorAuthority = { observation: LessonHostObservation | null; result?: LessonHostResult; attempt?: LessonAttemptCorrelation };
export type LessonStoreGate = "unverified" | "reading" | "ready" | "mismatch";
export type PreparedLessonMutation = {
  mutation: CurationMutation;
  precondition: { kind: "installation"; id: string } | { kind: "uninitialized"; locationId: string };
};
const NO_AUTHORITY: LessonEditorAuthority = { observation: null };
/** What the draft was edited from. `source` is the opening provenance of an uncommitted capture. */
export type LessonEditorBase = { revision: number; text: string; important: boolean; source: CaptureSource | null };
/** In-memory only. `source` is set only on a capture that is not committed yet. */
export type LessonDraft = { text: string; source: CaptureSource | null };
export type LessonIntent =
  | { kind: "save" }
  | { kind: "important"; value: boolean }
  | { kind: "acknowledge-source"; digest: string }
  | { kind: "purge"; confirmed: true };
export type LessonReconcileIdentity = LessonEditorTarget & { requestId: string };
/** `mutation` is null after hydrate or restore: reconcile by id, never replay. */
export type LessonPendingRequest = LessonReconcileIdentity & { generation: number; mutation: CurationMutation | null };
/** A purged record. Matching uses store and record (binding and key): a purged record stays purged in every project view. */
export type LessonTombstone = LessonEditorTarget;
/** Legacy cached identity hint. It can constrain an expected UUID, never grant live authority. */
export type LessonStoreResolution = {
  location: { kind: "location"; id: string };
  installation: { kind: "installation"; id: string };
};
export type LessonNavigation =
  | { type: "open-capture"; scope: LessonScope; binding: StoreBinding; recordId: string; source: CaptureSource }
  | { type: "open-lesson"; scope: LessonScope; binding: StoreBinding; key: LessonKey }
  | { type: "close" };
/**
 * EDITOR_SATURATED: a bound was reached; the action was refused so no correctness state is lost.
 * STORE_UNRESOLVED: a location and an installation binding may be the same store and a purged or
 * unresolved record could hide behind that; nothing is shown until a store resolution arrives.
 */
export type LessonEditorErrorCode = CurationErrorCode | "EDITOR_SATURATED" | "STORE_UNRESOLVED";
export type LessonEditorError = { code: LessonEditorErrorCode; fields: string[] };
/** Private reducer data. Render projectLessonEditor(state), not this draft-bearing value. */
export interface LessonEditorState {
  generation: number;
  gate: LessonStoreGate;
  needsFreshDetail: boolean;
  expectedInstallation: string | null;
  address: StoreBinding | null;
  target: LessonEditorTarget | null;
  /** "capture" until the first capture commits, then "existing". */
  mode: "capture" | "existing" | null;
  loaded: LessonView | null;
  history: CurationRevision[] | null;
  base: LessonEditorBase | null;
  draft: LessonDraft | null;
  pending: LessonPendingRequest | null;
  /** Requests abandoned by navigation whose outcome is still open. Never trimmed. */
  unresolved: LessonReconcileIdentity[];
  /** Purged records. Never trimmed. */
  tombstones: LessonTombstone[];
  /** A purge could not be remembered: every open is refused until the adapter replaces this state. */
  tombstonesSaturated: boolean;
  /** Legacy hints retained as constraints only. They never identify historical operations. */
  resolutions: LessonStoreResolution[];
  /** Navigation waiting for an explicit stay or discard. */
  blocked: LessonNavigation | null;
  phase: LessonEditorPhase;
  error: LessonEditorError | null;
}
/** Safe to persist in browser storage: opaque ids only, no wording. */
export type LessonEditorSnapshot = {
  version: 4;
  expectedInstallation: string | null;
  address: StoreBinding | null;
  target: LessonEditorTarget | null;
  mode: "capture" | "existing" | null;
  pendingRequestId: string | null;
  pendingIdentity: LessonReconcileIdentity | null;
  unresolved: LessonReconcileIdentity[];
  tombstones: LessonTombstone[];
  tombstonesSaturated: boolean;
  resolutions: LessonStoreResolution[];
};
export type LessonEditorEvent =
  | LessonNavigation
  | { type: "stay" }
  | { type: "discard" }
  | { type: "rebase" }
  | { type: "edit-text"; text: string }
  | { type: "edit-source"; source: CaptureSource }
  | { type: "submit"; requestId: string; intent: LessonIntent }
  | { type: "loaded"; generation: number; target: LessonEditorTarget; view: LessonView }
  | { type: "detail-missing"; generation: number; target: LessonEditorTarget }
  | { type: "history-loaded"; generation: number; target: LessonEditorTarget; revisions: CurationRevision[] }
  | { type: "read-failed"; generation: number; target: LessonEditorTarget; code: CurationErrorCode }
  | { type: "receipt"; generation: number; requestId: string; target: LessonEditorTarget; receipt: CurationReceipt }
  | {
      type: "rejected";
      generation: number;
      requestId: string;
      target: LessonEditorTarget;
      code: CurationErrorCode;
      fields: string[];
    }
  | { type: "attempt-outcome"; generation: number; requestId: string; target: LessonEditorTarget; outcome: LessonAttemptOutcome }
  | { type: "verify-store" }
  | { type: "disconnect" }
  | { type: "store-resolved"; resolution: LessonStoreResolution }
  | { type: "hydrate"; snapshot: unknown }
  | { type: "restore"; state: unknown };

/** Upper bound for an in-memory draft; submit enforces the real limits. */
export const MAX_DRAFT_BYTES = 64 * 1024;
export const MAX_UNRESOLVED = 64;
export const MAX_TOMBSTONES = 256;
export const MAX_RESOLUTIONS = 64;

const CONFLICT_CODES: ReadonlySet<CurationErrorCode> = new Set([
  "CURATION_CONFLICT",
  "CAPTURE_EXISTS",
  "SOURCE_CONFLICT",
  "SCOPE_CONFLICT",
]);
const PHASES: readonly LessonEditorPhase[] = ["idle", "editing", "saving", "saved", "conflict", "unknown", "purged", "error"];
const SOURCE_STATUSES: readonly SourceStatus[] = ["saved", "queued", "archived", "missing", "changed", "conflict", "invalid", "purged"];
const REVISION_KINDS: readonly CurationChange["kind"][] = ["capture", "edit", "important", "acknowledge-source", "purge"];
const SOURCE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SOURCE_FIELDS = [
  "kind",
  "quote",
  "reference",
  "quoteRedacted",
  "captureSessionId",
  "sourceConversationId",
  "sourceRowId",
  "sourceAgentId",
] as const;

export function initialLessonEditor(): LessonEditorState {
  return {
    generation: 0,
    gate: "unverified",
    needsFreshDetail: false,
    expectedInstallation: null,
    address: null,
    target: null,
    mode: null,
    loaded: null,
    history: null,
    base: null,
    draft: null,
    pending: null,
    unresolved: [],
    tombstones: [],
    tombstonesSaturated: false,
    resolutions: [],
    blocked: null,
    phase: "idle",
    error: null,
  };
}

/** Wording or, on an uncommitted capture, provenance differs from the base. */
export function isLessonEditorDirty(state: LessonEditorState): boolean {
  const { draft, base } = state;
  if (draft === null || base === null) return false;
  return draft.text !== base.text || !sameSourceOrNull(draft.source, base.source);
}

/** The host holds a newer revision than the one the draft was edited from. */
export function isLessonEditorStale(state: LessonEditorState): boolean {
  return state.loaded !== null && state.base !== null && state.loaded.revision > state.base.revision;
}

export function reduceLessonEditor(
  state: LessonEditorState,
  event: LessonEditorEvent,
  authority: LessonEditorAuthority = NO_AUTHORITY,
): LessonEditorState {
  if (!isRecord(event)) return state;
  if (event.type === "hydrate" || event.type === "restore") {
    if (state.target !== null || state.pending !== null || state.unresolved.length > 0 || state.tombstones.length > 0 || state.tombstonesSaturated) {
      return { ...state, error: invalid("activeImport") };
    }
    return event.type === "hydrate" ? hydrate(state, event.snapshot) : restore(state, event.state);
  }
  if (event.type === "disconnect") return { ...state, gate: state.gate === "mismatch" ? "mismatch" : "unverified",
    needsFreshDetail: state.target !== null, generation: state.generation + 1, loaded: null, history: null };
  if (event.type === "verify-store") return observeStore(state, authority.observation);
  if (event.type === "store-resolved") {
    if (!validResolution(event.resolution)) return { ...state, error: invalid("resolution") };
    const observed = authority.observation;
    if (!observed || !sameBinding(observed.binding, event.resolution.location) || observed.installationId !== event.resolution.installation.id) return state;
    return observeStore(state, observed);
  }
  // Handle-free outcomes: correlated by the attempt record, never by store observation.
  if (event.type === "attempt-outcome") return attemptOutcome(state, event, authority.attempt);
  // Mismatch survives edits, dismissals and navigation. Recovery needs a new verified read.
  if (state.gate === "mismatch" && !["receipt", "rejected"].includes(event.type)) return state;
  if (["loaded", "detail-missing", "history-loaded", "read-failed", "receipt", "rejected"].includes(event.type)) {
    if (!matchesHostResult(event, authority)) return state;
    if (event.type === "receipt" || event.type === "rejected") {
      const entry = state.pending?.requestId === event.requestId ? state.pending :
        state.unresolved.find((item) => item.requestId === event.requestId);
      if (!entry || !sameTarget(entry, event.target) || (entry === state.pending && state.pending.generation !== event.generation)) return state;
      const origin = installationOf(entry) ?? (entry === state.pending ? state.expectedInstallation : null);
      if ((origin !== null && origin !== authority.result!.installationId) ||
          (event.type === "rejected" && event.code === "INSTALLATION_MISMATCH")) {
        return state.pending === entry ? quarantine(state) : state;
      }
      // A refusal at the current path cannot settle an unknown historical request.
      if (event.type === "rejected" && installationOf(entry) === null) return state;
      state = attributeOperation(state, event, authority.result!);
    } else {
      if (!("target" in event) || !("generation" in event) || !isCurrentRead(state, event.generation, event.target)) return state;
      if (!authorityMatches(state, authority.observation) || state.gate === "unverified") return state;
      if (authority.result!.installationId !== state.expectedInstallation) return quarantine(state);
    }
  }
  if (["submit", "rebase", "edit-text", "edit-source"].includes(event.type) &&
      (state.gate !== "ready" || !authorityMatches(state, authority.observation))) {
    return { ...state, error: storeUnresolved() };
  }
  switch (event.type) {
    case "open-capture":
    case "open-lesson":
    case "close":
      return observeStore(requestNavigation(state, event), authority.observation);
    case "stay":
      return state.blocked === null ? state : { ...state, blocked: null };
    case "discard":
      return observeStore(discard(state), authority.observation);
    case "rebase":
      return rebase(state);
    case "edit-text":
      return editText(state, event.text);
    case "edit-source":
      return editSource(state, event.source);
    case "submit":
      return submit(state, event.requestId, event.intent);
    case "loaded":
      return loaded(state, event);
    case "detail-missing":
      if (state.mode !== "capture") return { ...state, error: invalid("missingDetail") };
      return { ...state, gate: "ready", needsFreshDetail: false, loaded: null, history: null, error: null };
    case "history-loaded":
      if (!isCurrentRead(state, event.generation, event.target) || !Array.isArray(event.revisions)) return state;
      return { ...state, history: event.revisions };
    case "read-failed":
      if (!isCurrentRead(state, event.generation, event.target) || !isCurationCode(event.code)) return state;
      return { ...state, error: { code: event.code, fields: [] }, phase: state.pending === null ? "error" : state.phase };
    case "receipt":
      return receipt(state, event);
    case "rejected":
      return rejected(state, event);
    default:
      return state;
  }
}

/** Never send the body alone: the transport must enforce the returned handle precondition. */
export function prepareLessonMutation(
  state: LessonEditorState,
  requestId: string,
  authority: LessonEditorAuthority = NO_AUTHORITY,
): PreparedLessonMutation {
  if (state.phase === "purged" || (state.target !== null && isTombstoned(state, state.target))) throw new CurationError("PURGED");
  const pending = state.pending;
  if (pending === null || pending.requestId !== requestId) throw new CurationError("INVALID_INPUT", ["requestId"]);
  if (pending.mutation === null) throw new CurationError("INVALID_INPUT", ["pending"]);
  if (state.gate === "mismatch") throw new CurationError("INSTALLATION_MISMATCH");
  if (state.gate !== "ready" || !authorityMatches(state, authority.observation) || isStoreUnresolved(state, pending)) {
    throw new CurationError("INSTALLATION_MISMATCH", ["authority"]);
  }
  const mutation = copyMutation(pending.mutation);
  const origin = installationOf(pending);
  if (mutation.binding.kind === "installation") {
    return { mutation, precondition: { kind: "installation", id: mutation.binding.id } };
  }
  if (origin !== null) {
    if (!authority.observation?.pinnedLocationRetry) throw new CurationError("INSTALLATION_MISMATCH", ["pinnedLocationRetry"]);
    return { mutation, precondition: { kind: "installation", id: origin } };
  }
  if (state.expectedInstallation !== null || state.phase !== "saving" || authority.observation?.installationId !== null) {
    throw new CurationError("INSTALLATION_MISMATCH", ["origin"]);
  }
  return { mutation, precondition: { kind: "uninitialized", locationId: mutation.binding.id } };
}

export function snapshotLessonEditor(state: LessonEditorState): LessonEditorSnapshot {
  // An uncommitted capture with nothing in flight has nothing to reconcile.
  const keepTarget = state.target !== null && (state.mode === "existing" || state.pending !== null) && state.phase !== "purged";
  return {
    version: 4,
    expectedInstallation: keepTarget ? state.expectedInstallation : null,
    address: keepTarget && state.address ? { ...state.address } : null,
    target: keepTarget && state.target ? copyTarget(state.target) : null,
    mode: keepTarget ? state.mode : null,
    pendingRequestId: keepTarget && state.pending ? state.pending.requestId : null,
    pendingIdentity: keepTarget && state.pending ? copyIdentity(state.pending) : null,
    unresolved: state.unresolved.map(copyIdentity),
    tombstones: state.tombstones.map(copyTarget),
    tombstonesSaturated: state.tombstonesSaturated,
    resolutions: state.resolutions.map(copyResolution),
  };
}

/** UI projection never exposes a quarantined draft, history, or frozen wire payload. */
export function projectLessonEditor(state: LessonEditorState): LessonEditorState {
  const copy = cloneEditor(state);
  if (state.gate !== "ready" || (state.target !== null && isStoreUnresolved(state, state.target))) {
    copy.loaded = null;
    copy.history = null;
    copy.base = null;
    copy.draft = null;
    copy.blocked = null;
  }
  if (copy.pending) copy.pending.mutation = null;
  return copy;
}

function cloneEditor(state: LessonEditorState): LessonEditorState {
  // The state contract is JSON data; cloning also prevents views from mutating the controller.
  return JSON.parse(JSON.stringify(state)) as LessonEditorState;
}

/** Adapters keep this instance private. $.state is a projection, never the next reducer input. */
export class LessonEditorController {
  #state = initialLessonEditor();
  #epoch: string | null = null;
  #observation: LessonHostObservation | null = null;
  #attempts = new Map<LessonAttemptToken, LessonAttemptCorrelation & { epoch: string }>();

  get state(): LessonEditorState { return projectLessonEditor(this.#state); }

  /** Unsent wording exists, even while the projection hides it. Content-free. */
  get dirty(): boolean { return isLessonEditorDirty(this.#state); }

  /** An attempt of the current pending request is open. */
  get sending(): boolean {
    const pending = this.#state.pending;
    if (pending === null) return false;
    for (const attempt of this.#attempts.values()) if (attempt.requestId === pending.requestId) return true;
    return false;
  }

  connect(connectionEpoch: string): void {
    // Old-epoch outcomes are lost: say unknown before the epoch changes.
    for (const { epoch: _epoch, ...attempt } of this.#attempts.values()) this.#reportOutcome(attempt, { kind: "unknown" });
    this.#attempts.clear();
    this.#epoch = connectionEpoch;
    this.#observation = null;
    this.#state = reduceLessonEditor(this.#state, { type: "disconnect" });
  }

  /** Only the adapter's current correlated inspection may enter here; stale requests are discarded upstream. */
  observe(observation: LessonHostObservation): void {
    if (this.#epoch === null || observation.connectionEpoch !== this.#epoch) return;
    if (!validBinding(observation.binding) || (observation.installationId !== null && !UUID_RE.test(observation.installationId))) return;
    this.#observation = { ...observation, binding: { ...observation.binding } };
    this.#state = reduceLessonEditor(this.#state, { type: "verify-store" }, { observation: this.#observation });
  }

  dispatch(event: LessonEditorEvent, result?: LessonHostResult): void {
    if (event.type === "hydrate" || event.type === "restore" || event.type === "disconnect") this.#observation = null;
    this.#state = reduceLessonEditor(this.#state, event, { observation: this.#observation, result });
  }

  prepare(requestId: string): PreparedLessonMutation {
    return prepareLessonMutation(this.#state, requestId, { observation: this.#observation });
  }

  /** Starts one send. A request id is not an attempt id: each send gets its own token. */
  beginAttempt(requestId: string): { token: LessonAttemptToken; prepared: PreparedLessonMutation } {
    const prepared = this.prepare(requestId);
    const pending = this.#state.pending;
    if (this.#epoch === null || pending === null) throw new CurationError("INSTALLATION_MISMATCH", ["authority"]);
    for (const attempt of this.#attempts.values()) {
      if (attempt.requestId === requestId) throw new CurationError("INVALID_INPUT", ["inFlight"]);
    }
    if (this.#attempts.size > MAX_UNRESOLVED) throw new CurationError("INVALID_INPUT", ["attempts"]);
    const token = Object.freeze(Object.create(null)) as LessonAttemptToken;
    const precondition = prepared.precondition.kind === "installation"
      ? { kind: "installation" as const, id: prepared.precondition.id }
      : { kind: "uninitialized" as const, locationId: prepared.precondition.locationId };
    this.#attempts.set(token, {
      epoch: this.#epoch,
      generation: pending.generation,
      requestId,
      target: copyTarget(pending),
      precondition,
      origin: installationOf(pending) ?? this.#state.expectedInstallation,
      afterUnknown: this.#state.phase === "unknown",
    });
    return { token, prepared };
  }

  /** Ends exactly this attempt. Any other token, or one from an earlier epoch, does nothing. */
  finishAttempt(token: LessonAttemptToken, completion: LessonAttemptOutcome | LessonAttemptSuccess): void {
    const entry = this.#attempts.get(token);
    if (entry === undefined || entry.epoch !== this.#epoch) return;
    this.#attempts.delete(token);
    const { epoch: _epoch, ...attempt } = entry;
    if (isRecord(completion) && completion.kind === "success") this.#finishSuccess(attempt, completion as LessonAttemptSuccess);
    else this.#reportOutcome(attempt, isRecord(completion) ? (completion as LessonAttemptOutcome) : { kind: "unknown" });
  }

  #reportOutcome(attempt: LessonAttemptCorrelation, outcome: LessonAttemptOutcome): void {
    const event: LessonEditorEvent = { type: "attempt-outcome", generation: attempt.generation, requestId: attempt.requestId,
      target: copyTarget(attempt.target), outcome };
    this.#state = reduceLessonEditor(this.#state, event, { observation: this.#observation, attempt });
  }

  #finishSuccess(attempt: LessonAttemptCorrelation, success: LessonAttemptSuccess): void {
    const receipt = receiptFromTransport(attempt, success.receipt);
    const store = success.store;
    const storeOk = isRecord(store) && typeof store.installationId === "string" && UUID_RE.test(store.installationId) &&
      typeof store.locationId === "string" && SHA256_HEX_RE.test(store.locationId);
    const agrees = storeOk && (attempt.precondition.kind === "installation"
      ? store.installationId === attempt.precondition.id
      : store.locationId === attempt.precondition.locationId);
    if (receipt === null || this.#epoch === null || !storeOk || (!agrees && attempt.origin === null)) {
      this.#reportOutcome(attempt, { kind: "unknown" });
      return;
    }
    const target = copyTarget(attempt.target);
    const event: LessonEditorEvent = { type: "receipt", generation: attempt.generation, requestId: attempt.requestId, target, receipt };
    const result: LessonHostResult = { operation: "mutation", connectionEpoch: this.#epoch, generation: attempt.generation, target,
      requestId: attempt.requestId, installationId: store.installationId };
    this.#state = reduceLessonEditor(this.#state, event, { observation: this.#observation, result });
    // Whatever the reducer did, the same request must not be left waiting on a send that ended.
    const pending = this.#state.pending;
    if (pending !== null && pending.requestId === attempt.requestId && pending.generation === attempt.generation && this.#state.phase === "saving") {
      this.#reportOutcome(attempt, { kind: "unknown" });
    }
  }

  snapshot(): LessonEditorSnapshot { return snapshotLessonEditor(this.#state); }

  /** Native hot reload only. Import this data with restore, never as runtime authority. */
  exportForRestore(): LessonEditorState { return cloneEditor(this.#state); }
}

// Navigation

function requestNavigation(state: LessonEditorState, nav: LessonNavigation): LessonEditorState {
  if (!validNavigation(nav)) return { ...state, error: invalid("navigation") };
  if (isLessonEditorDirty(state)) return { ...state, blocked: copyNavigation(nav) };
  return navigate(state, nav);
}

/** Refuses, without losing anything, when a bound would force dropping correctness state. */
function navigate(state: LessonEditorState, nav: LessonNavigation): LessonEditorState {
  if (nav.type !== "close" && state.tombstonesSaturated) {
    return { ...state, blocked: null, error: saturated("tombstones") };
  }
  if (state.pending !== null && state.unresolved.length >= MAX_UNRESOLVED) {
    return { ...state, blocked: null, error: saturated("unresolved") };
  }
  const generation = state.generation + 1;
  // Request ids are reserved on submit, so the pending id is never already listed.
  const unresolved = state.pending === null ? state.unresolved : [...state.unresolved, copyIdentity(state.pending)];
  const cleared: LessonEditorState = {
    ...initialLessonEditor(),
    generation,
    unresolved,
    tombstones: state.tombstones,
    tombstonesSaturated: state.tombstonesSaturated,
    resolutions: state.resolutions,
  };
  if (nav.type === "close") return cleared;
  const isCapture = nav.type === "open-capture";
  const key: LessonKey = isCapture ? { world: nav.scope.world, kind: "capture", id: nav.recordId } : { ...nav.key };
  const target: LessonEditorTarget = { scope: copyScope(nav.scope), binding: { ...nav.binding }, key };
  const mode = isCapture ? "capture" : "existing";
  cleared.expectedInstallation = expectedFor(target, cleared.resolutions);
  cleared.address = { ...nav.binding };
  cleared.needsFreshDetail = !isCapture;
  if (isTombstoned(cleared, target)) return { ...cleared, target, mode, phase: "purged" };
  if (isStoreUnresolved(cleared, target)) return { ...cleared, target, mode, phase: "error", error: storeUnresolved() };
  if (!isCapture) return { ...cleared, target, mode };
  const source = { ...nav.source };
  return {
    ...cleared,
    target,
    mode,
    base: { revision: 0, text: "", important: false, source },
    draft: { text: "", source: { ...source } },
  };
}

function discard(state: LessonEditorState): LessonEditorState {
  if (state.blocked !== null) return navigate(state, state.blocked);
  if (state.draft === null || state.base === null || state.phase === "purged") return state;
  return {
    ...state,
    draft: { text: state.base.text, source: state.base.source === null ? null : { ...state.base.source } },
    error: null,
    phase: state.pending === null ? "idle" : state.phase,
  };
}

function rebase(state: LessonEditorState): LessonEditorState {
  if (state.mode !== "existing" || state.pending !== null || state.draft === null || state.loaded === null) return state;
  if (!isLessonEditorStale(state)) return state;
  const next = { ...state, base: baseFromView(state.loaded), error: null };
  return { ...next, phase: isLessonEditorDirty(next) ? "editing" : "idle" };
}

// Drafting

function editText(state: LessonEditorState, text: unknown): LessonEditorState {
  if (state.draft === null || state.phase === "purged") return state;
  if (typeof text !== "string" || !isWellFormed(text) || utf8Bytes(text) > MAX_DRAFT_BYTES) {
    return { ...state, error: invalid("text") };
  }
  return settleEditPhase({ ...state, draft: { ...state.draft, text }, error: null });
}

function editSource(state: LessonEditorState, source: unknown): LessonEditorState {
  if (state.mode !== "capture" || state.draft === null || state.pending !== null || state.phase === "purged") return state;
  if (!validSource(source)) return { ...state, error: invalid("source") };
  return settleEditPhase({ ...state, draft: { ...state.draft, source: { ...source } }, error: null });
}

function settleEditPhase(next: LessonEditorState): LessonEditorState {
  if (next.pending !== null) return next;
  return { ...next, phase: isLessonEditorDirty(next) ? "editing" : "idle" };
}

// Submitting

function submit(state: LessonEditorState, requestId: unknown, intent: unknown): LessonEditorState {
  // A second click while a request is open keeps the first id and payload.
  if (state.pending !== null || state.phase === "purged" || state.blocked !== null) return state;
  if (state.target === null) return { ...state, error: invalid("target") };
  if (isTombstoned(state, state.target)) return { ...state, error: { code: "PURGED", fields: [] } };
  if (isStoreUnresolved(state, state.target)) return { ...state, error: storeUnresolved() };
  if (typeof requestId !== "string" || !CURATION_REQUEST_ID_RE.test(requestId)) return { ...state, error: invalid("requestId") };
  // An id still awaiting reconciliation is reserved for its own record, whatever the key.
  if (state.unresolved.some((item) => item.requestId === requestId)) return { ...state, error: invalid("requestId") };
  const built = buildChange(state, intent);
  if ("problems" in built) return { ...state, error: { code: "INVALID_INPUT", fields: built.problems } };
  const target = state.expectedInstallation === null ? state.target :
    { scope: copyScope(state.target.scope), key: { ...state.target.key }, binding: { kind: "installation" as const, id: state.expectedInstallation } };
  const mutation: CurationMutation = {
    requestId,
    binding: { ...target.binding },
    scope: copyScope(target.scope),
    key: { ...target.key },
    expectedRevision: built.expectedRevision,
    change: built.change,
  };
  if (utf8Bytes(JSON.stringify(mutation)) > MAX_MUTATION_BYTES) return { ...state, error: invalid("$") };
  const pending: LessonPendingRequest = { ...copyIdentity({ requestId, ...target }), generation: state.generation, mutation };
  return { ...state, target, pending, phase: "saving", error: null };
}

function buildChange(
  state: LessonEditorState,
  intent: unknown,
): { change: CurationChange; expectedRevision: number } | { problems: string[] } {
  if (!isRecord(intent)) return { problems: ["intent"] };
  const { base, draft, mode } = state;
  if (intent.kind === "save") {
    if (draft === null || base === null) return { problems: ["draft"] };
    const problems = textProblems(draft.text, "text", MAX_TEXT_BYTES);
    if (mode === "capture") {
      const source = draft.source;
      if (source === null) return { problems: ["source"] };
      problems.push(...textProblems(source.quote, "source.quote", MAX_QUOTE_BYTES));
      problems.push(...textProblems(source.reference, "source.reference", MAX_REFERENCE_BYTES));
      if (source.quote === null && source.reference === null) problems.push("source");
      if (problems.length > 0) return { problems };
      return { change: { kind: "capture", text: draft.text, source: { ...source } }, expectedRevision: 0 };
    }
    if (problems.length > 0) return { problems };
    return { change: { kind: "edit", text: draft.text }, expectedRevision: base.revision };
  }
  // Every other change needs a committed record to act on.
  if (mode !== "existing" || base === null) return { problems: ["intent"] };
  if (intent.kind === "important") {
    if (typeof intent.value !== "boolean") return { problems: ["intent.value"] };
    return { change: { kind: "important", value: intent.value }, expectedRevision: base.revision };
  }
  if (intent.kind === "acknowledge-source") {
    if (typeof intent.digest !== "string" || !SHA256_HEX_RE.test(intent.digest)) return { problems: ["intent.digest"] };
    return { change: { kind: "acknowledge-source", digest: intent.digest }, expectedRevision: base.revision };
  }
  if (intent.kind === "purge") {
    if (intent.confirmed !== true) return { problems: ["intent.confirmed"] };
    return { change: { kind: "purge", confirmed: true }, expectedRevision: base.revision };
  }
  return { problems: ["intent"] };
}

function textProblems(value: string | null, field: string, maxBytes: number): string[] {
  if (value === null) return [];
  return isWellFormed(value) && hasVisibleText(value) && utf8Bytes(value) <= maxBytes ? [] : [field];
}

// Async completions

function isCurrentRead(state: LessonEditorState, generation: unknown, target: unknown): boolean {
  return (
    generation === state.generation &&
    state.target !== null &&
    state.phase !== "purged" &&
    (state.gate === "ready" || state.gate === "reading") &&
    sameCanonicalTarget(state, target, state.target) &&
    !isTombstoned(state, state.target) &&
    !isStoreUnresolved(state, state.target)
  );
}

function loaded(state: LessonEditorState, event: { generation: number; target: LessonEditorTarget; view: LessonView }): LessonEditorState {
  if (!isCurrentRead(state, event.generation, event.target) || !state.target) return state;
  const view = event.view;
  if (!isRecord(view) || !isRevision(view.revision)) return state;
  // The adapter asked for this target but the host answered for another: say so, keep content.
  if (!sameKey(view.key, state.target.key)) return mismatch(state, "INVALID_INPUT", "view.key");
  if (!sameScope(view.scope, state.target.scope)) return mismatch(state, "SCOPE_CONFLICT", "view.scope");
  if (view.sourceStatus === "purged") return purge(state, state.target);
  const newestSeen = Math.max(state.loaded?.revision ?? -1, state.base?.revision ?? -1);
  if (view.revision < newestSeen) return state;
  // Nothing human is at stake: follow the host.
  if (state.base === null || (state.pending === null && !isLessonEditorDirty(state))) {
    const base = baseFromView(view);
    return {
      ...state,
      mode: "existing",
      gate: "ready",
      needsFreshDetail: false,
      loaded: view,
      base,
      draft: { text: base.text, source: null },
      phase: state.phase === "error" && state.pending === null ? "idle" : state.phase,
      error: state.pending === null ? null : state.error,
    };
  }
  // Keep the wording and the base; a newer `loaded` marks the draft stale.
  return { ...state, gate: "ready", needsFreshDetail: false, loaded: view, error: null };
}

function mismatch(state: LessonEditorState, code: CurationErrorCode, field: string): LessonEditorState {
  return { ...state, error: { code, fields: [field] }, phase: state.pending === null ? "error" : state.phase };
}

function receipt(
  state: LessonEditorState,
  event: { generation: number; requestId: string; target: LessonEditorTarget; receipt: CurationReceipt },
): LessonEditorState {
  const r = event.receipt;
  if (!isRecord(r) || r.requestId !== event.requestId) return state;
  const pending = state.pending;
  const forPending =
    pending !== null &&
    event.generation === pending.generation &&
    pending.requestId === event.requestId &&
    sameCanonicalTarget(state, event.target, pending);
  const forUnresolved = findUnresolved(state, event.requestId, event.target) >= 0;
  if (!forPending && !forUnresolved) return state;
  // The receipt's own key must name the request's record before anything is settled.
  if (r.state !== "unknown" && !sameKey(isRecord(event.target) ? event.target.key : null, r.key)) {
    return forPending ? mismatch(state, "INVALID_INPUT", "receipt.key") : { ...state, error: invalid("receipt.key") };
  }
  if (forUnresolved) return settleUnresolved(state, event.requestId, event.target, r) ?? state;
  if (pending === null) return state;
  // Unknown never means not committed: keep the identity and the payload.
  if (r.state === "unknown") return { ...state, phase: "unknown", error: null };
  if (r.state === "purged") return purge(state, pending);
  if (r.state !== "committed" || !isRevision(r.revision)) return state;
  return applyCommit(state, pending, r.revision);
}

function applyCommit(state: LessonEditorState, pending: LessonPendingRequest, revision: number): LessonEditorState {
  const change = pending.mutation?.change ?? null;
  if (change?.kind === "purge") return purge(state, pending);
  let base = state.base;
  let draft = state.draft;
  // A replayed or older revision never overwrites newer content.
  if (base !== null && change !== null && revision > base.revision) {
    base = { ...base, revision };
    if (change.kind === "capture" || change.kind === "edit") base.text = change.text;
    if (change.kind === "important") base.important = change.value;
  }
  // Provenance is stored with the capture; from now on the draft is wording only.
  if (state.mode === "capture") {
    if (base !== null) base = { ...base, source: null };
    if (draft !== null) draft = { ...draft, source: null };
  }
  const next: LessonEditorState = { ...state, mode: "existing", base, draft, pending: null, error: null };
  return { ...next, phase: isLessonEditorDirty(next) ? "editing" : "saved" };
}

function rejected(
  state: LessonEditorState,
  event: { generation: number; requestId: string; target: LessonEditorTarget; code: CurationErrorCode; fields: string[] },
): LessonEditorState {
  if (!isCurationCode(event.code)) return state;
  // A rejection is a definite answer, so it settles an abandoned request too.
  const settled = settleUnresolved(state, event.requestId, event.target, event.code === "PURGED" ? "purged" : "rejected");
  if (settled !== null) return settled;
  const pending = state.pending;
  if (pending === null || event.generation !== pending.generation || pending.requestId !== event.requestId) return state;
  if (!sameCanonicalTarget(state, event.target, pending)) return state;
  if (event.code === "PURGED") return purge(state, pending);
  const fields = Array.isArray(event.fields) ? event.fields.filter((field) => typeof field === "string") : [];
  return {
    ...state,
    pending: null,
    phase: CONFLICT_CODES.has(event.code) ? "conflict" : "error",
    error: { code: event.code, fields },
  };
}

/**
 * Settles an abandoned request by id and full target. Returns null when it is not abandoned.
 * A settled purge clears the current editor when it shows the same record.
 */
function settleUnresolved(
  state: LessonEditorState,
  requestId: string,
  target: unknown,
  outcome: CurationReceipt | "purged" | "rejected",
): LessonEditorState | null {
  const index = findUnresolved(state, requestId, target);
  if (index < 0) return null;
  if (outcome !== "purged" && outcome !== "rejected" && outcome.state === "unknown") return state;
  const entry = state.unresolved[index]!;
  const next = { ...state, unresolved: state.unresolved.filter((_, i) => i !== index) };
  const purged = outcome === "purged" || (typeof outcome === "object" && outcome.state === "purged");
  if (!purged) return next;
  if (next.target !== null && next.phase !== "purged") {
    if (sameRecord(next, next.target, entry)) return purge(next, entry);
    // Possibly the same record behind an unknown binding link: show nothing.
    if (sameKey(next.target.key, entry.key) && recordRelation(next.target, entry) === "unknown") {
      return addTombstone(failClosed(next), entry);
    }
  }
  return addTombstone(next, entry);
}

function findUnresolved(state: LessonEditorState, requestId: string, target: unknown): number {
  return state.unresolved.findIndex((item) => item.requestId === requestId && sameCanonicalTarget(state, target, item));
}

/** Clears visible content and waits for a store resolution. Pending identity is kept. */
function failClosed(state: LessonEditorState): LessonEditorState {
  return { ...state, gate: state.gate === "mismatch" ? "mismatch" : "unverified", needsFreshDetail: true, loaded: null, history: null,
    blocked: null, phase: "error", error: storeUnresolved() };
}

function installationOf(target: LessonEditorTarget): string | null {
  return target.binding.kind === "installation" ? target.binding.id : target.installationId ?? null;
}

function expectedFor(target: LessonEditorTarget | null, hints: LessonStoreResolution[]): string | null {
  if (!target) return null;
  return installationOf(target) ?? hints.find((hint) => sameBinding(hint.location, target.binding))?.installation.id ?? null;
}

function observationAddresses(target: LessonEditorTarget, observation: LessonHostObservation): boolean {
  return sameBinding(observation.binding, target.binding) ||
    (installationOf(target) !== null && installationOf(target) === observation.installationId);
}

function authorityMatches(state: LessonEditorState, observation: LessonHostObservation | null): boolean {
  return observation !== null && state.target !== null &&
    (observationAddresses(state.target, observation) || (state.address !== null && sameBinding(observation.binding, state.address))) &&
    observation.installationId === state.expectedInstallation;
}

function quarantine(state: LessonEditorState): LessonEditorState {
  return { ...state, gate: "mismatch", needsFreshDetail: true, generation: state.generation + (state.gate === "mismatch" ? 0 : 1),
    loaded: null, history: null, blocked: null, error: { code: "INSTALLATION_MISMATCH", fields: ["binding"] } };
}

function observeStore(state: LessonEditorState, observation: LessonHostObservation | null): LessonEditorState {
  if (!observation || !state.target || state.phase === "purged" ||
      !(observationAddresses(state.target, observation) || (state.address !== null && sameBinding(observation.binding, state.address)))) return state;
  const expected = state.expectedInstallation ?? expectedFor(state.target, state.resolutions);
  if (expected !== null && observation.installationId !== expected) return quarantine({ ...state, expectedInstallation: expected });
  if ((state.pending !== null && installationOf(state.pending) === null && observation.installationId !== null) ||
      (expected === null && state.mode === "existing" && state.base !== null)) {
    return { ...state, gate: "unverified", loaded: null, history: null, error: storeUnresolved() };
  }
  // A handshake proves the current editor's store, never an older request's origin.
  const target = observation.installationId === null || state.target.binding.kind === "installation"
    ? state.target : { ...state.target, installationId: observation.installationId };
  const recovering = state.gate === "unverified" || state.gate === "mismatch";
  const next: LessonEditorState = { ...state, target, expectedInstallation: expected ?? observation.installationId,
    generation: state.generation + (state.gate === "mismatch" ? 1 : 0),
    gate: recovering ? (state.mode === "capture" && state.pending === null && !state.needsFreshDetail ? "ready" : "reading") : state.gate };
  if (isTombstoned(next, target)) return purge(next, target);
  if (isStoreUnresolved(next, target)) return { ...next, error: storeUnresolved() };
  return { ...next, error: recovering ? null : state.error };
}

function matchesHostResult(event: LessonEditorEvent, authority: LessonEditorAuthority): boolean {
  const result = authority.result;
  if (!result || !authority.observation || result.connectionEpoch !== authority.observation.connectionEpoch) return false;
  if (!("target" in event) || !("generation" in event) || result.generation !== event.generation || !sameTarget(result.target, event.target)) return false;
  return "requestId" in event
    ? result.requestId === event.requestId && result.operation !== "read"
    : result.requestId === undefined && result.operation === "read";
}

/** An executed mutation can prove origin; an unknown receipt lookup cannot. */
function attributeOperation(
  state: LessonEditorState,
  event: Extract<LessonEditorEvent, { type: "receipt" | "rejected" }>,
  result: LessonHostResult,
): LessonEditorState {
  if (event.type !== "receipt" || result.installationId === null || event.receipt.requestId !== event.requestId ||
      (event.receipt.state === "unknown" ? result.operation !== "mutation" : !sameKey(event.receipt.key, event.target.key))) return state;
  const attribute = <T extends LessonReconcileIdentity>(entry: T): T =>
    entry.requestId === event.requestId && sameTarget(entry, event.target) && installationOf(entry) === null
      ? { ...entry, installationId: result.installationId! } : entry;
  const pending = state.pending === null ? null : attribute(state.pending);
  const unresolved = state.unresolved.map(attribute);
  if (pending === state.pending && unresolved.every((entry, index) => entry === state.unresolved[index])) return state;
  if (pending !== state.pending && pending !== null && state.expectedInstallation === null) {
    return { ...state, pending, unresolved, expectedInstallation: result.installationId,
      target: state.target === null ? null : { ...state.target, installationId: result.installationId } };
  }
  return { ...state, pending, unresolved };
}

// Attempts without executing identity

/** Rows of the attempt contract. Nothing here assigns store identity or grants ready or saved. */
function attemptOutcome(
  state: LessonEditorState,
  event: Extract<LessonEditorEvent, { type: "attempt-outcome" }>,
  attempt: LessonAttemptCorrelation | undefined,
): LessonEditorState {
  if (!attempt || attempt.generation !== event.generation || attempt.requestId !== event.requestId || !sameTarget(attempt.target, event.target)) return state;
  const pending = state.pending;
  if (pending === null || pending.requestId !== event.requestId || pending.generation !== event.generation || !sameTarget(pending, event.target)) return state;
  const outcome: unknown = event.outcome;
  if (!isRecord(outcome) || outcome.kind !== "refused" || typeof outcome.code !== "string" || !CURATION_REFUSAL_CODES.has(outcome.code)) {
    return markUnknown(state);
  }
  const code = outcome.code;
  const fields = Array.isArray(outcome.fields)
    ? outcome.fields.filter((field): field is string => typeof field === "string" && field.length <= 128).slice(0, 32) : [];
  const error = refusalError(code, fields);
  const origin = attempt.origin;
  // An earlier attempt may have committed; a later refusal cannot prove otherwise.
  if (attempt.afterUnknown || state.phase === "unknown") {
    if (code === "INSTALLATION_MISMATCH" && origin !== null) return { ...quarantine(state), phase: "unknown" };
    return { ...state, phase: "unknown", error: state.gate === "mismatch" ? state.error : error };
  }
  if (code === "INSTALLATION_MISMATCH") {
    if (origin !== null) return { ...quarantine(state), pending: null, phase: "error" };
    // Bootstrap: keep the location-only request so the existing hold refuses the new store.
    return { ...state, gate: state.gate === "mismatch" ? "mismatch" : "unverified", needsFreshDetail: true, loaded: null, history: null,
      blocked: null, phase: "unknown", error: { code: "INSTALLATION_MISMATCH", fields: ["binding"] } };
  }
  if (code === "PURGED") {
    const pinned = origin !== null && attempt.precondition.kind === "installation" && attempt.precondition.id === origin;
    return pinned ? purge(state, pending) : markUnknown(state);
  }
  if (state.gate === "mismatch") return { ...state, pending: null, phase: "error" };
  return { ...state, pending: null, phase: CONFLICT_CODES.has(code as CurationErrorCode) ? "conflict" : "error", error };
}

function markUnknown(state: LessonEditorState): LessonEditorState {
  const keep = state.gate === "mismatch" || state.error?.code === "STORE_UNRESOLVED" || state.error?.code === "INSTALLATION_MISMATCH";
  return { ...state, phase: "unknown", error: keep ? state.error : null };
}

/** Generic gate codes are not editor codes: the request itself was refused. */
function refusalError(code: string, fields: string[]): LessonEditorError {
  return isCurationCode(code) ? { code, fields } : { code: "INVALID_INPUT", fields: ["request"] };
}

/** The editor's receipt for a transport receipt. A purged receipt's key is the submitted target's. */
function receiptFromTransport(attempt: LessonAttemptCorrelation, value: unknown): CurationReceipt | null {
  if (!isRecord(value) || value.requestId !== attempt.requestId) return null;
  const { startedAt, finishedAt } = value;
  if (typeof startedAt !== "string" || typeof finishedAt !== "string") return null;
  if (value.state === "purged") return { state: "purged", requestId: attempt.requestId, key: { ...attempt.target.key }, startedAt, finishedAt };
  const result = value.result;
  if (value.state !== "completed" || !isRecord(result) || typeof value.payloadHash !== "string" || !isRevision(result.revision) ||
      typeof result.changed !== "boolean" || !isRecord(result.key)) return null;
  const key = result.key as LessonKey;
  return { state: "committed", requestId: attempt.requestId, payloadHash: value.payloadHash, key: { world: key.world, kind: key.kind, id: key.id },
    revision: result.revision, changed: result.changed, startedAt, finishedAt };
}

/** Terminal. Content is cleared even when the tombstone cannot be stored. */
function purge(state: LessonEditorState, record: LessonEditorTarget): LessonEditorState {
  return addTombstone(
    {
      ...state,
      loaded: null,
      history: null,
      base: null,
      draft: null,
      pending: null,
      blocked: null,
      phase: "purged",
      error: null,
    },
    record,
  );
}

function addTombstone(state: LessonEditorState, record: LessonEditorTarget): LessonEditorState {
  if (isTombstoned(state, record)) return state;
  // Full: fail closed. No further open until the adapter replaces the state.
  if (state.tombstones.length >= MAX_TOMBSTONES) {
    return { ...state, tombstonesSaturated: true, error: saturated("tombstones") };
  }
  return { ...state, tombstones: [...state.tombstones, copyTarget(record)] };
}

// Hydration (browser refresh) and restore (native hot reload)

const SNAPSHOT_KEYS = [
  "version",
  "target",
  "mode",
  "pendingRequestId",
  "unresolved",
  "tombstones",
  "tombstonesSaturated",
  "resolutions",
] as const;

function hydrate(state: LessonEditorState, snapshot: unknown): LessonEditorState {
  const rejectedState = { ...state, error: invalid("snapshot") };
  if (!isRecord(snapshot) || !exactKeys(snapshot, snapshot.version === 4 ? [...SNAPSHOT_KEYS, "expectedInstallation", "pendingIdentity", "address"] : SNAPSHOT_KEYS)) return rejectedState;
  if ((snapshot.version !== 3 && snapshot.version !== 4) || typeof snapshot.tombstonesSaturated !== "boolean") return rejectedState;
  const resolutions = parseResolutions(snapshot.resolutions);
  if (resolutions === null) return rejectedState;
  const target = snapshot.target;
  if (target !== null && !validTarget(target)) return rejectedState;
  const expected = snapshot.version === 4 ? snapshot.expectedInstallation : expectedFor(target, resolutions);
  if (!validExpected(expected, target)) return rejectedState;
  const address = snapshot.version === 4 ? snapshot.address : target?.binding ?? null;
  if (target === null ? address !== null : !validBinding(address)) return rejectedState;
  if (!validModeFor(snapshot.mode, target)) return rejectedState;
  const requestId = snapshot.pendingRequestId;
  if (requestId !== null && (target === null || !isRequestId(requestId))) return rejectedState;
  if (snapshot.version === 4 && requestId === null && snapshot.pendingIdentity !== null) return rejectedState;
  if (target !== null && snapshot.mode === "capture" && requestId === null) return rejectedState;
  const unresolved = parseUnresolved(snapshot.unresolved);
  const tombstones = parseTombstones(snapshot.tombstones);
  if (unresolved === null || tombstones === null) return rejectedState;
  if (requestId !== null && unresolved.some((item) => item.requestId === requestId)) return rejectedState;

  const generation = state.generation + 1;
  const base: LessonEditorState = {
    ...initialLessonEditor(),
    generation,
    unresolved,
    tombstones,
    tombstonesSaturated: snapshot.tombstonesSaturated,
    needsFreshDetail: target !== null,
    expectedInstallation: expected,
    address: address === null ? null : { ...(address as StoreBinding) },
    resolutions,
  };
  if (target === null) return base;
  // A purged target is never written to a snapshot; one that names it was rewritten.
  if (isTombstoned(base, target)) return rejectedState;
  const copied = copyTarget(target);
  const identity = snapshot.version === 4 ? snapshot.pendingIdentity : requestId === null ? null : { requestId, ...copied };
  if (requestId === null ? identity !== null : !validIdentity(identity) || identity.requestId !== requestId || !sameTarget(identity, copied)) return rejectedState;
  const pending: LessonPendingRequest | null =
    identity === null ? null : { ...copyIdentity(identity as LessonReconcileIdentity), generation, mutation: null };
  if (pending !== null && expected !== null && installationOf(pending) !== null && installationOf(pending) !== expected) return rejectedState;
  const restored = { ...base, target: copied, mode: snapshot.mode as "capture" | "existing", pending };
  if (isStoreUnresolved(restored, copied)) return { ...restored, phase: pending ? "unknown" : "error", error: storeUnresolved() };
  return { ...restored, phase: pending ? "unknown" : "idle" };
}

const STATE_KEYS = [
  "generation",
  "target",
  "mode",
  "loaded",
  "history",
  "base",
  "draft",
  "pending",
  "unresolved",
  "tombstones",
  "tombstonesSaturated",
  "resolutions",
  "blocked",
  "phase",
  "error",
] as const;

/** Every identity in the restored state must agree. Nothing is rewritten to make it agree. */
function restore(state: LessonEditorState, input: unknown): LessonEditorState {
  const rejectedState = { ...state, error: invalid("state") };
  if (!isRecord(input) || !exactKeys(input, Object.hasOwn(input, "gate") ? [...STATE_KEYS, "gate", "needsFreshDetail", "expectedInstallation", "address"] : STATE_KEYS)) return rejectedState;
  const s = input;
  if (!isRevision(s.generation) || !PHASES.includes(s.phase as LessonEditorPhase)) return rejectedState;
  if (typeof s.tombstonesSaturated !== "boolean") return rejectedState;
  if (s.target !== null && !validTarget(s.target)) return rejectedState;
  const target = s.target as LessonEditorTarget | null;
  if (!validModeFor(s.mode, target)) return rejectedState;
  const unresolved = parseUnresolved(s.unresolved);
  const tombstones = parseTombstones(s.tombstones);
  const resolutions = parseResolutions(s.resolutions);
  if (unresolved === null || tombstones === null || resolutions === null) return rejectedState;
  const expected = Object.hasOwn(s, "expectedInstallation") ? s.expectedInstallation : expectedFor(target, resolutions);
  if (!validExpected(expected, target)) return rejectedState;
  const address = Object.hasOwn(s, "address") ? s.address : target?.binding ?? null;
  if (target === null ? address !== null : !validBinding(address)) return rejectedState;
  if (s.loaded !== null) {
    if (target === null || !validView(s.loaded)) return rejectedState;
    if (!sameKey(s.loaded.key, target.key) || !sameScope(s.loaded.scope, target.scope)) return rejectedState;
  }
  if (s.history !== null && !(target !== null && Array.isArray(s.history) && s.history.every(validRevisionEntry))) return rejectedState;
  if (s.base !== null && !validBase(s.base, s.mode)) return rejectedState;
  if (s.draft !== null && !validDraft(s.draft, s.mode)) return rejectedState;
  if (s.draft !== null && s.base === null) return rejectedState;
  if (s.blocked !== null && !validNavigation(s.blocked)) return rejectedState;
  if (s.error !== null && !validError(s.error)) return rejectedState;
  if (s.pending !== null && !(target !== null && validPending(s.pending, target))) return rejectedState;
  const oldPending = s.pending as LessonPendingRequest | null;
  if (oldPending !== null && expected !== null && installationOf(oldPending) !== null && installationOf(oldPending) !== expected) return rejectedState;
  if (oldPending !== null && unresolved.some((item) => item.requestId === oldPending.requestId)) return rejectedState;
  const purgedPhase = s.phase === "purged";
  if (purgedPhase && (s.draft !== null || s.base !== null || s.loaded !== null || s.history !== null || s.pending !== null)) {
    return rejectedState;
  }
  const probe = { ...initialLessonEditor(), tombstones, unresolved, resolutions };
  if (purgedPhase) {
    // Purged must be provable: its tombstone is here, or the list failed closed.
    if (target === null) return rejectedState;
    if (!isTombstoned(probe, target) && !tombstones.some((item) => sameTarget(item, target)) && !s.tombstonesSaturated) return rejectedState;
  } else if (target !== null) {
    // Live content for a purged record, or for one an unknown binding link might hide, was rewritten.
    if (isTombstoned(probe, target)) return rejectedState;
  }

  // Responses issued before the reload carry the old generation and are dropped.
  const generation = Math.max(state.generation, s.generation) + 1;
  const pending: LessonPendingRequest | null =
    oldPending === null ? null : { ...copyIdentity(oldPending), generation, mutation: null };
  const error = s.error as LessonEditorError | null;
  return {
    generation,
    gate: "unverified",
    needsFreshDetail: target !== null,
    expectedInstallation: expected,
    address: address === null ? null : { ...(address as StoreBinding) },
    target: target === null ? null : copyTarget(target),
    mode: s.mode as LessonEditorState["mode"],
    loaded: null,
    history: null,
    base: s.base === null ? null : copyBase(s.base as LessonEditorBase),
    draft: s.draft === null ? null : copyDraft(s.draft as LessonDraft),
    pending,
    unresolved,
    tombstones,
    tombstonesSaturated: s.tombstonesSaturated,
    resolutions,
    blocked: s.blocked === null ? null : copyNavigation(s.blocked as LessonNavigation),
    phase: pending !== null ? "unknown" : (s.phase as LessonEditorPhase),
    error:
      target !== null && !purgedPhase && isStoreUnresolved(probe, target)
        ? storeUnresolved()
        : error === null
          ? null
          : { code: error.code, fields: [...error.fields] },
  };
}

// Validation of untrusted shapes

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys<K extends string>(value: unknown, keys: readonly K[]): value is Record<K, unknown> {
  if (!isRecord(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && CURATION_REQUEST_ID_RE.test(value);
}

function isCurationCode(value: unknown): value is CurationErrorCode {
  return typeof value === "string" && (CURATION_ERROR_CODES as readonly string[]).includes(value);
}

function isDigestOrNull(value: unknown): boolean {
  return value === null || (typeof value === "string" && SHA256_HEX_RE.test(value));
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function validScope(value: unknown): value is LessonScope {
  if (!exactKeys(value, ["world", "project"])) return false;
  if (typeof value.world !== "string" || !WORLD_NAME_RE.test(value.world)) return false;
  const project = value.project;
  if (exactKeys(project, ["kind", "id"])) return project.kind === "project" && typeof project.id === "string" && PROJECT_ID_RE.test(project.id);
  return exactKeys(project, ["kind"]) && (project.kind === "world" || project.kind === "unresolved");
}

function validBinding(value: unknown): value is StoreBinding {
  if (!exactKeys(value, ["kind", "id"]) || typeof value.id !== "string") return false;
  if (value.kind === "installation") return UUID_RE.test(value.id);
  if (value.kind === "location") return SHA256_HEX_RE.test(value.id);
  return false;
}

function validKey(value: unknown): value is LessonKey {
  if (!exactKeys(value, ["world", "kind", "id"])) return false;
  if (lessonKeyProblems(value as LessonKey).length > 0) return false;
  try {
    encodeLessonKey(value as LessonKey);
    return true;
  } catch {
    return false;
  }
}

function validTargetParts(value: Rec): boolean {
  return (
    validScope(value.scope) &&
    validBinding(value.binding) &&
    validKey(value.key) &&
    (value.key as LessonKey).world === (value.scope as LessonScope).world
  );
}

function identityKeys(value: unknown, keys: readonly string[]): value is Rec {
  if (!isRecord(value)) return false;
  const withOrigin = Object.hasOwn(value, "installationId");
  if (withOrigin && (typeof value.installationId !== "string" || !UUID_RE.test(value.installationId))) return false;
  if (withOrigin && isRecord(value.binding) && value.binding.kind === "installation" && value.installationId !== value.binding.id) return false;
  return exactKeys(value, withOrigin ? [...keys, "installationId"] : keys);
}

function validTarget(value: unknown): value is LessonEditorTarget {
  return identityKeys(value, ["scope", "binding", "key"]) && validTargetParts(value);
}

function validExpected(value: unknown, target: LessonEditorTarget | null): value is string | null {
  if (value !== null && (typeof value !== "string" || !UUID_RE.test(value))) return false;
  if (target === null) return value === null;
  const origin = installationOf(target);
  return origin === null || value === origin;
}

function validModeFor(mode: unknown, target: LessonEditorTarget | null | unknown): boolean {
  if (target === null) return mode === null;
  if (mode === "existing") return true;
  return mode === "capture" && (target as LessonEditorTarget).key.kind === "capture";
}

/** Shape and size only; visibility is checked on submit. */
function validSource(value: unknown): value is CaptureSource {
  if (!exactKeys(value, SOURCE_FIELDS)) return false;
  if (value.kind !== "native_selection" && value.kind !== "explicit_quote") return false;
  if (typeof value.quoteRedacted !== "boolean") return false;
  const sized = (text: unknown, max: number) =>
    text === null || (typeof text === "string" && isWellFormed(text) && utf8Bytes(text) <= max);
  if (!sized(value.quote, MAX_QUOTE_BYTES) || !sized(value.reference, MAX_REFERENCE_BYTES)) return false;
  const ids = [value.captureSessionId, value.sourceConversationId, value.sourceRowId, value.sourceAgentId];
  return ids.every((id) => id === null || (typeof id === "string" && SOURCE_ID_RE.test(id)));
}

function validNavigation(value: unknown): value is LessonNavigation {
  if (!isRecord(value)) return false;
  if (value.type === "close") return exactKeys(value, ["type"]);
  if (value.type === "open-lesson") return exactKeys(value, ["type", "scope", "binding", "key"]) && validTargetParts(value);
  if (value.type === "open-capture") {
    return (
      exactKeys(value, ["type", "scope", "binding", "recordId", "source"]) &&
      validScope(value.scope) &&
      validBinding(value.binding) &&
      typeof value.recordId === "string" &&
      UUID_RE.test(value.recordId) &&
      validSource(value.source)
    );
  }
  return false;
}

function validView(value: unknown): value is LessonView {
  return (
    exactKeys(value, [
      "key",
      "scope",
      "revision",
      "important",
      "effectiveText",
      "originalText",
      "source",
      "sourceStatus",
      "sourceDigest",
      "baselineDigest",
      "relatedPattern",
      "created",
      "updated",
    ]) &&
    validKey(value.key) &&
    validScope(value.scope) &&
    isRevision(value.revision) &&
    typeof value.important === "boolean" &&
    isStringOrNull(value.effectiveText) &&
    isStringOrNull(value.originalText) &&
    (value.source === null || validSource(value.source)) &&
    SOURCE_STATUSES.includes(value.sourceStatus as SourceStatus) &&
    isDigestOrNull(value.sourceDigest) &&
    isDigestOrNull(value.baselineDigest) &&
    isStringOrNull(value.relatedPattern) &&
    typeof value.created === "string" &&
    typeof value.updated === "string"
  );
}

function validRevisionEntry(value: unknown): boolean {
  return (
    exactKeys(value, ["revision", "kind", "at", "text", "important", "oldSourceDigest", "newSourceDigest"]) &&
    isRevision(value.revision) &&
    REVISION_KINDS.includes(value.kind as CurationChange["kind"]) &&
    typeof value.at === "string" &&
    isStringOrNull(value.text) &&
    (value.important === null || typeof value.important === "boolean") &&
    isDigestOrNull(value.oldSourceDigest) &&
    isDigestOrNull(value.newSourceDigest)
  );
}

function validBase(value: unknown, mode: unknown): value is LessonEditorBase {
  if (!exactKeys(value, ["revision", "text", "important", "source"])) return false;
  if (!isRevision(value.revision) || typeof value.text !== "string" || typeof value.important !== "boolean") return false;
  return value.source === null || (mode === "capture" && validSource(value.source));
}

function validDraft(value: unknown, mode: unknown): value is LessonDraft {
  if (!exactKeys(value, ["text", "source"])) return false;
  if (typeof value.text !== "string" || !isWellFormed(value.text) || utf8Bytes(value.text) > MAX_DRAFT_BYTES) return false;
  if (value.source === null) return true;
  return mode === "capture" && validSource(value.source);
}

function validError(value: unknown): value is LessonEditorError {
  return (
    exactKeys(value, ["code", "fields"]) &&
    (isCurationCode(value.code) || value.code === "EDITOR_SATURATED" || value.code === "STORE_UNRESOLVED") &&
    Array.isArray(value.fields) &&
    value.fields.length <= 32 &&
    value.fields.every((field) => typeof field === "string" && field.length <= 128)
  );
}

function validIdentity(value: unknown, extra: readonly string[] = []): value is LessonReconcileIdentity {
  return identityKeys(value, ["requestId", "binding", "scope", "key", ...extra]) && isRequestId(value.requestId) && validTargetParts(value);
}

/** Pending must name exactly the current target, and so must its payload. */
function validPending(value: unknown, target: LessonEditorTarget): boolean {
  if (!validIdentity(value, ["generation", "mutation"])) return false;
  const pending = value as unknown as Rec & LessonReconcileIdentity;
  if (!isRevision(pending.generation) || !sameTarget(pending, target)) return false;
  return pending.mutation === null || validMutation(pending.mutation, pending.requestId, target);
}

function validMutation(value: unknown, requestId: string, target: LessonEditorTarget): boolean {
  if (!exactKeys(value, ["requestId", "binding", "scope", "key", "expectedRevision", "change"])) return false;
  if (value.requestId !== requestId || !isRevision(value.expectedRevision)) return false;
  if (!validTargetParts(value) || !sameTarget(value, target)) return false;
  const change = value.change;
  if (!isRecord(change)) return false;
  switch (change.kind) {
    case "capture":
      return exactKeys(change, ["kind", "text", "source"]) && typeof change.text === "string" && validSource(change.source);
    case "edit":
      return exactKeys(change, ["kind", "text"]) && typeof change.text === "string";
    case "important":
      return exactKeys(change, ["kind", "value"]) && typeof change.value === "boolean";
    case "acknowledge-source":
      return exactKeys(change, ["kind", "digest"]) && typeof change.digest === "string" && SHA256_HEX_RE.test(change.digest);
    case "purge":
      return exactKeys(change, ["kind", "confirmed"]) && change.confirmed === true;
    default:
      return false;
  }
}

/** Over the bound or with duplicate ids is rejected, never trimmed. */
function parseUnresolved(value: unknown): LessonReconcileIdentity[] | null {
  if (!Array.isArray(value) || value.length > MAX_UNRESOLVED) return null;
  if (!value.every((item) => validIdentity(item))) return null;
  const items = value as LessonReconcileIdentity[];
  if (new Set(items.map((item) => item.requestId)).size !== items.length) return null;
  return items.map(copyIdentity);
}

function parseTombstones(value: unknown): LessonTombstone[] | null {
  if (!Array.isArray(value) || value.length > MAX_TOMBSTONES) return null;
  if (!value.every((item) => validTarget(item))) return null;
  return (value as LessonTombstone[]).map(copyTarget);
}

// Small helpers

function invalid(field: string): LessonEditorError {
  return { code: "INVALID_INPUT", fields: [field] };
}

function saturated(field: string): LessonEditorError {
  return { code: "EDITOR_SATURATED", fields: [field] };
}

function sameKey(a: unknown, b: LessonKey): boolean {
  return isRecord(a) && a.world === b.world && a.kind === b.kind && a.id === b.id;
}

function sameBinding(a: unknown, b: StoreBinding): boolean {
  return isRecord(a) && a.kind === b.kind && a.id === b.id;
}

function sameScope(a: unknown, b: LessonScope): boolean {
  if (!isRecord(a) || a.world !== b.world || !isRecord(a.project)) return false;
  const p = a.project;
  if (p.kind !== b.project.kind) return false;
  return b.project.kind !== "project" || p.id === b.project.id;
}

/** Binding, scope and key all match exactly: wire identity, used where nothing may be rewritten. */
function sameTarget(a: unknown, b: LessonEditorTarget): boolean {
  return isRecord(a) && sameBinding(a.binding, b.binding) && sameScope(a.scope, b.scope) && sameKey(a.key, b.key);
}

type StoreKnowledge = Pick<LessonEditorState, "resolutions">;

/** Historical identity uses its own proven origin, never a current location lookup. */
function recordRelation(a: LessonEditorTarget, b: LessonEditorTarget): "same" | "distinct" | "unknown" {
  const ai = installationOf(a);
  const bi = installationOf(b);
  if (ai !== null && bi !== null) return ai === bi ? "same" : "distinct";
  // Unknown location history could belong to any installation, even after path replacement.
  return "unknown";
}

/** Completion correlation uses the immutable wire target, not a mutable location map. */
function sameCanonicalTarget(_state: StoreKnowledge, a: unknown, b: LessonEditorTarget): boolean {
  return sameTarget(a, b);
}

/** Same stored record in every project view. */
function sameRecord(_state: StoreKnowledge, a: LessonEditorTarget, b: LessonEditorTarget): boolean {
  return sameKey(a.key, b.key) && recordRelation(a, b) === "same";
}

function isTombstoned(state: Pick<LessonEditorState, "tombstones" | "resolutions">, record: LessonEditorTarget): boolean {
  return state.tombstones.some((item) => sameRecord(state, item, record));
}

/** A purged or abandoned record with this key might be this one, behind an unlinked binding. */
function isStoreUnresolved(
  state: Pick<LessonEditorState, "tombstones" | "unresolved" | "resolutions">,
  record: LessonEditorTarget,
): boolean {
  const related = [...state.tombstones, ...state.unresolved];
  return related.some((item) => sameKey(item.key, record.key) && recordRelation(item, record) === "unknown");
}

function storeUnresolved(): LessonEditorError {
  return { code: "STORE_UNRESOLVED", fields: ["binding"] };
}

function validResolution(value: unknown): value is LessonStoreResolution {
  return (
    exactKeys(value, ["location", "installation"]) &&
    validBinding(value.location) &&
    (value.location as StoreBinding).kind === "location" &&
    validBinding(value.installation) &&
    (value.installation as StoreBinding).kind === "installation"
  );
}

/** One entry per location, within the bound. Rejected otherwise, never trimmed. */
function parseResolutions(value: unknown): LessonStoreResolution[] | null {
  if (!Array.isArray(value) || value.length > MAX_RESOLUTIONS) return null;
  if (!value.every(validResolution)) return null;
  const items = value as LessonStoreResolution[];
  if (new Set(items.map((item) => item.location.id)).size !== items.length) return null;
  return items.map(copyResolution);
}

function copyResolution(item: LessonStoreResolution): LessonStoreResolution {
  return { location: { kind: "location", id: item.location.id }, installation: { kind: "installation", id: item.installation.id } };
}

function sameSourceOrNull(a: CaptureSource | null, b: CaptureSource | null): boolean {
  if (a === null || b === null) return a === b;
  return SOURCE_FIELDS.every((field) => a[field] === b[field]);
}

function baseFromView(view: LessonView): LessonEditorBase {
  return { revision: view.revision, text: view.effectiveText ?? view.originalText ?? "", important: view.important, source: null };
}

function copyScope(scope: LessonScope): LessonScope {
  return { world: scope.world, project: { ...scope.project } };
}

function copyTarget(target: LessonEditorTarget): LessonEditorTarget {
  return { scope: copyScope(target.scope), binding: { ...target.binding }, key: { ...target.key },
    ...(target.installationId === undefined ? {} : { installationId: target.installationId }) };
}

function copyIdentity(item: LessonReconcileIdentity): LessonReconcileIdentity {
  return { requestId: item.requestId, ...copyTarget(item) };
}

function copyBase(base: LessonEditorBase): LessonEditorBase {
  return { ...base, source: base.source === null ? null : { ...base.source } };
}

function copyDraft(draft: LessonDraft): LessonDraft {
  return { text: draft.text, source: draft.source === null ? null : { ...draft.source } };
}

function copyNavigation(nav: LessonNavigation): LessonNavigation {
  if (nav.type === "close") return { type: "close" };
  if (nav.type === "open-lesson") return { type: "open-lesson", scope: copyScope(nav.scope), binding: { ...nav.binding }, key: { ...nav.key } };
  return {
    type: "open-capture",
    scope: copyScope(nav.scope),
    binding: { ...nav.binding },
    recordId: nav.recordId,
    source: { ...nav.source },
  };
}

function copyChange(change: CurationChange): CurationChange {
  return change.kind === "capture" ? { ...change, source: { ...change.source } } : { ...change };
}

function copyMutation(mutation: CurationMutation): CurationMutation {
  return {
    requestId: mutation.requestId,
    binding: { ...mutation.binding },
    scope: copyScope(mutation.scope),
    key: { ...mutation.key },
    expectedRevision: mutation.expectedRevision,
    change: copyChange(mutation.change),
  };
}
