// Lessons inside the Activity section of the native /sil console: capture from
// a selection, browse, edit wording, Important, source acknowledgement and
// purge. One private LessonEditorController decides what may be sent and what
// counts as committed; this file runs its reads and writes through the parent's
// bridge (readControl, mutateControl) and keeps what the pane draws.
//
// What lives where:
// - The controller and the last reads live in this module instance only. The
//   pane draws them from here, never from `$.state`.
// - `$.state` key `lessons` holds view settings, the controller's opaque
//   snapshot and, when its text passes screening, a trimmed exportForRestore()
//   for a hot reload. A reload imports it only through the controller's
//   `restore` event and then reads the store again. Nothing goes to `$.store`.
// - The engine is reached as `$.noun.method` on each call's own `$`; no handle
//   is kept here.
//
// Nothing here calls a model, submits a prompt or reads a transcript. A capture
// reads the person's current selection and nothing else.

import type { EngineInterface } from "claude-code";
import {
  CurationReadError,
  browseQuery,
  decodeHistory,
  decodeLessonDetail,
  decodeLocatedResult,
  decodeProjects,
  decodeReadResult,
  decodeReceiptRead,
  decodeScope,
  decodeStoreStatus,
  decodeBrowsePage,
  flatBinding,
  flatProject,
  parseFlatProject,
  readbackConfirms,
  type ReadStore,
  type StoreState,
} from "@sil/core/curation-client";
import { CURATION_MAX_SEARCH_CHARS, type CuratedLessonDetail, type ProjectChoice, type ProjectDescriptor } from "@sil/core/curation-read";
import { classifyMutationFailure, type CurationMutationResponse } from "@sil/core/control-mutation";
import {
  CurationError,
  MAX_QUOTE_BYTES,
  MAX_REFERENCE_BYTES,
  MAX_TEXT_BYTES,
  decodeLessonKey,
  encodeLessonKey,
  hasVisibleText,
  isWellFormed,
  utf8Bytes,
  type CaptureSource,
  type CurationRevision,
  type LessonKey,
  type LessonScope,
  type LessonView,
  type ProjectScope,
  type StoreBinding,
} from "@sil/core/lesson-curation";
import {
  LessonEditorController,
  type LessonAttemptOutcome,
  type LessonAttemptSuccess,
  type LessonEditorState,
  type LessonHostResult,
  type LessonIntent,
} from "@sil/core/lesson-curation-ui";
import { toCurationMutationEnvelope } from "@sil/core/lesson-curation-wire";
import { containsSensitiveText } from "@sil/core/sensitive-text";
import { mutateControl, readControl } from "./transport.ts";

export type LessonFilter = "saved" | "inbox" | "archived" | "important";
export const LESSON_FILTERS: readonly LessonFilter[] = ["saved", "inbox", "archived", "important"];
/** Rows per browse page and history page drawn in the pane. */
export const LESSONS_PAGE_SIZE = 10;
/** Longest text one field holds, in characters. Anything savable is at most
 * 4000 bytes, so at most 4000 characters; this bound keeps the drawn tree,
 * whose Input values count toward the engine's character cut, measurable. */
export const MAX_FIELD_CHARS = 8192;
export const HISTORY_PAGE_SIZE = 10;

/** Ids the capture form keeps. The host's own rule for source ids. */
const SOURCE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const AGENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** A pending world or project change waiting for Stay or Discard. */
export type LessonsPrompt = { kind: "world"; world: string } | { kind: "project"; project: ProjectScope };

export interface LessonsDetail {
  key: LessonKey;
  revision: number;
  provenance: CuratedLessonDetail["provenance"];
  diagnostics: CuratedLessonDetail["diagnostics"];
  history: CurationRevision[] | null;
  historyTotal: number | null;
  historyError: boolean;
  readAt: string;
}

export interface LessonsList {
  items: LessonView[];
  total: number;
  nextCursor: string | null;
  readAt: string;
}

interface LessonsData {
  controller: LessonEditorController;
  epoch: string | null;
  /** Moves on every change of scope (world, project, record, store); a read
   * that began under another value is dropped. */
  ctx: number;
  open: boolean;
  world: string | null;
  store: StoreState | null;
  locationId: string | null;
  /** Installation this view browses, once a handshake confirmed it. */
  pinned: string | null;
  block: string | null;
  handshakeError: string | null;
  choices: ProjectChoice[];
  contextNote: string | null;
  project: ProjectScope | null;
  filter: LessonFilter;
  search: string;
  list: LessonsList | null;
  listError: string | null;
  detail: LessonsDetail | null;
  detailError: string | null;
  notice: { tone: "ok" | "error" | "info"; text: string } | null;
  captureNote: string | null;
  /** A selection read for a capture that still waits for a project. Module memory only. */
  pendingCapture: CaptureSource | null;
  prompt: LessonsPrompt | null;
  /** The record a purge question was asked for; null when none is asked. */
  purgeConfirm: LessonKey | null;
  purgeCheck: "pending" | "verified" | "unavailable" | null;
  /** A capture navigation the editor holds for Stay or Discard: its record id
   * and the quote to propose once it is accepted. Never applied before. */
  pendingPrefill: { recordId: string; quote: string | null; note: string | null } | null;
  /** A scope inferred through the catch-all world: a capture into it waits for
   * an explicit confirmation of exactly this world and project. */
  scopeConfirm: { world: string; project: string; confirmed: boolean } | null;
  /** The project came back from a reload, so whether it was inferred is not
   * known. A capture waits for confirmation until a fresh context read shows
   * this directory maps to it without inference. Module memory only. */
  scopeUnverified: boolean;
  /** First project choice of the drawn window. */
  projectOffset: number;
  /** The browse page shown and the cursors of the pages before it. */
  pageCursor: string | null;
  pageBack: Array<string | null>;
  /** Search text typed but not submitted. Module memory only. */
  searchDraft: string | null;
  /** Fixed text: the last session-state write did not land. */
  persistWarning: string | null;
  captureExists: boolean;
  restoreNote: string | null;
  /** Field text the editor refused (over its limit), kept so the field is
   * not redrawn with an older value. Module memory only, never published. */
  refused: Partial<Record<"text" | "quote" | "reference", string>>;
  /** Fields whose last typed text was over MAX_FIELD_CHARS and was dropped.
   * The field shows the older text, so Save is blocked until it is edited. */
  dropped: Partial<Record<"text" | "quote" | "reference", true>>;
  reading: number;
  refreshing: Promise<void> | null;
  rev: number;
}

function freshData(): LessonsData {
  return {
    controller: new LessonEditorController(),
    epoch: null,
    ctx: 0,
    open: false,
    world: null,
    store: null,
    locationId: null,
    pinned: null,
    block: null,
    handshakeError: null,
    choices: [],
    contextNote: null,
    project: null,
    filter: "saved",
    search: "",
    list: null,
    listError: null,
    detail: null,
    detailError: null,
    notice: null,
    captureNote: null,
    pendingCapture: null,
    prompt: null,
    purgeConfirm: null,
    purgeCheck: null,
    pendingPrefill: null,
    scopeConfirm: null,
    scopeUnverified: false,
    projectOffset: 0,
    pageCursor: null,
    pageBack: [],
    searchDraft: null,
    persistWarning: null,
    captureExists: false,
    restoreNote: null,
    refused: {},
    dropped: {},
    reading: 0,
    refreshing: null,
    rev: 0,
  };
}

let data = freshData();
let writes: Promise<unknown> = Promise.resolve();
let readSeq = 0;
/** Moves when a page move starts its read. A list read that a later page move
 * overtook never replaces the list. */
let listSeq = 0;
/** Whether this instance already looked at the held state. Once per instance. */
let resumed = false;

/** A fresh module instance, as a reload gives. Tests only. */
export function resetLessonsForTests(): void {
  data = freshData();
  writes = Promise.resolve();
  readSeq = 0;
  listSeq = 0;
  resumed = false;
}

// --- what the pane draws -------------------------------------------------------

export interface LessonsViewModel {
  open: boolean;
  world: string | null;
  editor: LessonEditorState;
  dirty: boolean;
  sending: boolean;
  canRetry: boolean;
  store: StoreState | null;
  block: string | null;
  handshakeError: string | null;
  choices: ProjectChoice[];
  contextNote: string | null;
  project: ProjectScope | null;
  filter: LessonFilter;
  search: string;
  list: LessonsList | null;
  listError: string | null;
  detail: LessonsDetail | null;
  detailError: string | null;
  notice: LessonsData["notice"];
  captureNote: string | null;
  pendingCapture: boolean;
  prompt: LessonsPrompt | null;
  purgeConfirm: LessonKey | null;
  purgeCheck: LessonsData["purgeCheck"];
  /** The inferred scope still to confirm for the open capture, or null. */
  scopeToConfirm: { world: string; project: string; restored: boolean } | null;
  projectOffset: number;
  page: number;
  searchDraft: string | null;
  persistWarning: string | null;
  captureExists: boolean;
  restoreNote: string | null;
  refused: LessonsData["refused"];
  dropped: LessonsData["dropped"];
  reading: boolean;
}

/** Copies of what the pane draws. The editor is the controller's projection. */
export function lessonsViewModel(): LessonsViewModel {
  const c = data.controller;
  const editor = c.state;
  let canRetry = false;
  if (editor.pending !== null && !c.sending) {
    try {
      c.prepare(editor.pending.requestId);
      canRetry = true;
    } catch {
      canRetry = false;
    }
  }
  return {
    open: data.open,
    world: data.world,
    editor,
    dirty: c.dirty,
    sending: c.sending,
    canRetry,
    store: data.store,
    block: data.block,
    handshakeError: data.handshakeError,
    choices: data.choices,
    contextNote: data.contextNote,
    project: data.project,
    filter: data.filter,
    search: data.search,
    list: data.list,
    listError: data.listError,
    detail: data.detail,
    detailError: data.detailError,
    notice: data.notice,
    captureNote: data.captureNote,
    pendingCapture: data.pendingCapture !== null,
    prompt: data.prompt,
    purgeConfirm: data.purgeConfirm === null ? null : { ...data.purgeConfirm },
    scopeToConfirm: scopeToConfirm(),
    projectOffset: data.projectOffset,
    page: data.pageBack.length + 1,
    searchDraft: data.searchDraft,
    persistWarning: data.persistWarning,
    purgeCheck: data.purgeCheck,
    captureExists: data.captureExists,
    restoreNote: data.restoreNote,
    refused: { ...data.refused },
    dropped: { ...data.dropped },
    reading: data.reading > 0,
  };
}

/** Unsent wording exists, even while the projection hides it. */
export function lessonsDirty(): boolean {
  return data.controller.dirty;
}

// --- session state ---------------------------------------------------------------

export type LessonsWithheld = "sensitive" | "size" | null;

/** What `$.state` key `lessons` holds; types/index.d.ts declares the same shape. */
export interface PublishedLessons {
  version: 1;
  rev: number;
  open: boolean;
  world: string | null;
  filter: LessonFilter;
  project: string | null;
  search: string;
  /** Trimmed exportForRestore(): no loaded view, history or frozen payload. */
  restore: unknown;
  withheld: LessonsWithheld;
  /** Opaque ids only, for when restore is withheld. */
  snapshot: unknown;
}

function textOk(value: unknown, max: number): boolean {
  return value === null || value === undefined || (typeof value === "string" && utf8Bytes(value) <= max && !containsSensitiveText(value));
}

function sourceOk(source: unknown): boolean {
  if (source === null || typeof source !== "object") return true;
  const s = source as { quote?: unknown; reference?: unknown };
  return textOk(s.quote, MAX_QUOTE_BYTES) && textOk(s.reference, MAX_REFERENCE_BYTES);
}

/** The export a reload may restore, or why it is withheld. Wording that looks
 * like a secret or is over the save limits never enters shared session state. */
export function screenRestore(exported: LessonEditorState): { restore: unknown; withheld: LessonsWithheld } {
  const trimmed = {
    ...exported,
    loaded: null,
    history: null,
    pending: exported.pending === null ? null : { ...exported.pending, mutation: null },
  };
  const texts: Array<[unknown, number]> = [
    [trimmed.base?.text ?? null, MAX_TEXT_BYTES],
    [trimmed.draft?.text ?? null, MAX_TEXT_BYTES],
  ];
  const sizeOk = texts.every(([t, max]) => t === null || (typeof t === "string" && utf8Bytes(t) <= max));
  const sources = [trimmed.base?.source ?? null, trimmed.draft?.source ?? null, trimmed.blocked?.type === "open-capture" ? trimmed.blocked.source : null];
  const sourceSizes = sources.every((s) => s === null || (utf8Bytes(s.quote ?? "") <= MAX_QUOTE_BYTES && utf8Bytes(s.reference ?? "") <= MAX_REFERENCE_BYTES));
  if (!sizeOk || !sourceSizes) return { restore: null, withheld: "size" };
  const clean = texts.every(([t]) => typeof t !== "string" || !containsSensitiveText(t)) && sources.every(sourceOk);
  if (!clean) return { restore: null, withheld: "sensitive" };
  return { restore: JSON.parse(JSON.stringify(trimmed)) as unknown, withheld: null };
}

function published(): PublishedLessons {
  const screened = screenRestore(data.controller.exportForRestore());
  const search = data.search.length <= CURATION_MAX_SEARCH_CHARS && !containsSensitiveText(data.search) ? data.search : "";
  return {
    version: 1,
    rev: data.rev,
    open: data.open,
    world: data.world,
    filter: data.filter,
    project: data.project === null ? null : flatProject(data.project),
    search,
    restore: screened.restore,
    withheld: screened.withheld,
    snapshot: JSON.parse(JSON.stringify(data.controller.snapshot())) as unknown,
  };
}

const PUBLISH_ATTEMPTS = 2;
const PERSIST_WARNING =
  "The lesson editor could not be kept in session state. Unsent wording is still here, but a reload of the plugin would bring back older wording or none.";

/** Writes the current state, one write at a time; every write redraws the
 * pane. A write the host refuses or answers isSet false is tried again once,
 * then reported: a fixed warning beside the editor and one fixed log line,
 * since a failed write cannot redraw. The draft stays in module memory. */
function publish($: EngineInterface): Promise<void> {
  data.rev += 1;
  const value = published();
  const run = async (): Promise<void> => {
    for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
      try {
        const set = await $.state.set({ plugin: "self-improvement-loop", key: "lessons" }, value as never);
        if (set.isSet) {
          data.persistWarning = null;
          return;
        }
      } catch {
        // Refused: tried again, then reported below with fixed text.
      }
    }
    if (data.persistWarning === null) {
      data.persistWarning = PERSIST_WARNING;
      try {
        $.ui.log(`self-improvement-loop: ${PERSIST_WARNING}`);
      } catch {
        // The warning stays beside the editor for the next redraw.
      }
    }
  };
  const result = writes.then(run, run);
  writes = result.catch(() => undefined);
  return result.catch(() => undefined);
}

const PUBLISHED_KEYS = ["version", "rev", "open", "world", "filter", "project", "search", "restore", "withheld", "snapshot"] as const;

/** A held value, checked: it crossed a reload and any plugin can read it. */
export function parsePublishedLessons(value: unknown): PublishedLessons | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const own = Object.keys(v);
  if (own.length !== PUBLISHED_KEYS.length || !PUBLISHED_KEYS.every((k) => Object.hasOwn(v, k))) return null;
  if (v.version !== 1 || typeof v.rev !== "number" || !Number.isSafeInteger(v.rev) || v.rev < 0) return null;
  if (typeof v.open !== "boolean" || !(v.world === null || typeof v.world === "string")) return null;
  if (!LESSON_FILTERS.includes(v.filter as LessonFilter)) return null;
  if (!(v.project === null || (typeof v.project === "string" && parseFlatProject(v.project) !== null))) return null;
  if (typeof v.search !== "string" || v.search.length > CURATION_MAX_SEARCH_CHARS) return null;
  if (!(v.withheld === null || v.withheld === "sensitive" || v.withheld === "size")) return null;
  if (v.withheld !== null && v.restore !== null) return null;
  return v as unknown as PublishedLessons;
}

/** After a hot reload: take the screened editor back through `restore`, then
 * read the store again. Never replays a pending payload (restore drops it).
 * Runs once per module instance, when the console starts (a reload with the
 * pane up, or /sil), so a session that never opens it reads nothing. */
export async function resumeLessons($: EngineInterface): Promise<void> {
  if (resumed) return;
  resumed = true;
  const held = await $.state.get({ plugin: "self-improvement-loop", key: "lessons" });
  if (held.value === undefined) return;
  const parsed = parsePublishedLessons(held.value);
  data = freshData();
  data.epoch = newEpoch();
  data.controller.connect(data.epoch);
  if (parsed === null) {
    data.restoreNote = "The lesson editor's state from before the reload was unreadable and was reset. Nothing was saved or sent.";
    await publish($);
    return;
  }
  data.open = parsed.open;
  data.world = parsed.world;
  data.filter = parsed.filter;
  data.project = parsed.project === null ? null : parseFlatProject(parsed.project);
  // A restored project is never approval: it is checked again before a capture saves.
  data.scopeUnverified = data.project !== null;
  data.search = parsed.search;
  data.rev = parsed.rev;
  if (parsed.restore !== null) {
    data.controller.dispatch({ type: "restore", state: parsed.restore });
    if (data.controller.state.error?.fields.includes("state")) {
      resetController();
      data.restoreNote = "The lesson editor's state from before the reload was refused as invalid and was reset. Nothing was saved or sent.";
    }
  } else if (parsed.snapshot !== null && parsed.snapshot !== undefined) {
    data.controller.dispatch({ type: "hydrate", snapshot: parsed.snapshot });
    if (data.controller.state.error?.fields.includes("snapshot")) {
      resetController();
      data.restoreNote = "The lesson editor's state from before the reload was refused as invalid and was reset. Nothing was saved or sent.";
    } else if (parsed.withheld !== null) {
      data.restoreNote =
        parsed.withheld === "sensitive"
          ? "Unsent wording was not kept across the reload because it may hold a secret. Request ids were kept."
          : "Unsent wording was not kept across the reload because it was over the save limit. Request ids were kept.";
    }
  }
  await publish($);
}

function resetController(): void {
  data.controller = new LessonEditorController();
  data.epoch = newEpoch();
  data.controller.connect(data.epoch);
}

function newEpoch(): string {
  return `native-${crypto.randomUUID()}`;
}

function ensureConnected(): void {
  if (data.epoch === null) {
    data.epoch = newEpoch();
    data.controller.connect(data.epoch);
  }
}

// --- reads ---------------------------------------------------------------------------

type ReadOutcome<T> = { ok: true; value: T } | { ok: false; stale: true } | { ok: false; stale: false; error: CurationReadError };

/** One curation read through the parent's bridge. Stale (the scope moved, or
 * the controller or epoch changed) is dropped; a failure carries a code only. */
async function lessonRead<T>($: EngineInterface, op: string, args: Record<string, string>, decode: (value: unknown) => T, isCurrent: () => boolean = () => true): Promise<ReadOutcome<T>> {
  const ctx = data.ctx;
  const controller = data.controller;
  const epoch = data.epoch;
  const current = () => ctx === data.ctx && controller === data.controller && epoch === data.epoch && isCurrent();
  readSeq += 1;
  data.reading += 1;
  try {
    let value: T;
    try {
      const response = await readControl($, { version: 1, requestId: `sil-lesson-${readSeq}`, reads: [{ id: "r", op, args }] });
      const result = response.results["r"];
      if (result === undefined) throw new CurationReadError("MALFORMED", null);
      if (!result.ok) throw new CurationReadError(typeof result.error.code === "string" ? result.error.code : "MALFORMED", null);
      value = decode(result.value);
    } catch (err) {
      if (!current()) return { ok: false, stale: true };
      return { ok: false, stale: false, error: err instanceof CurationReadError ? err : new CurationReadError("TRANSPORT", null) };
    }
    if (!current()) return { ok: false, stale: true };
    const binding = args["binding"];
    if (binding !== undefined) {
      const store = (value as { store?: ReadStore }).store;
      if (store === undefined) return { ok: false, stale: false, error: new CurationReadError("MALFORMED", null) };
      const id = binding.slice(binding.indexOf(":") + 1);
      const matches = binding.startsWith("installation:") ? store.installationId === id : store.locationId === id;
      if (!matches) return { ok: false, stale: false, error: new CurationReadError("INSTALLATION_MISMATCH", null) };
      if (binding.startsWith("location:") && op !== "lessons.projects" && op !== "lessons.receipt" && data.pinned === null && store.installationId !== null) {
        return { ok: false, stale: false, error: new CurationReadError("STORE_CHANGED", null) };
      }
    }
    return { ok: true, value };
  } finally {
    data.reading -= 1;
  }
}

function installationOf(t: { binding: StoreBinding; installationId?: string }): string | null {
  return t.binding.kind === "installation" ? t.binding.id : (t.installationId ?? null);
}

/** Binding for browsing and new records; null while blocked or unknown. */
function currentBinding(): StoreBinding | null {
  if (data.block !== null) return null;
  if (data.pinned !== null) return { kind: "installation", id: data.pinned };
  return data.store?.state === "uninitialized" && data.locationId !== null ? { kind: "location", id: data.locationId } : null;
}

function recordReadBinding(target: { binding: StoreBinding; installationId?: string }): StoreBinding {
  const proven = installationOf(target) ?? data.controller.state.expectedInstallation;
  return proven === null ? target.binding : { kind: "installation", id: proven };
}

function blockFor(current: string | null): string | null {
  const editor = data.controller.state;
  const expected = editor.target !== null ? editor.expectedInstallation : null;
  if (expected !== null && current !== expected) return "Different SIL installation. Nothing from it is shown or saved here.";
  const pending = editor.pending;
  if (expected === null && pending !== null && installationOf(pending) === null && current !== null) {
    return "An earlier save went to a store that has since been set up. Check its outcome before browsing.";
  }
  if (expected === null && data.pinned !== null && current !== data.pinned) return "Different SIL installation. Nothing from it is shown or saved here.";
  return null;
}

/** A fresh look at which store answers now, then the controller observes it. */
async function handshake($: EngineInterface): Promise<boolean> {
  const world = data.world;
  if (world === null) return false;
  ensureConnected();
  data.handshakeError = null;
  const status = await lessonRead($, "lessons.store", {}, decodeStoreStatus);
  if (!status.ok) {
    if (!status.stale) data.handshakeError = readMessage(status.error);
    return false;
  }
  if (status.value.state === "error") {
    data.handshakeError = `Curation storage is unavailable (${status.value.code}).`;
    return false;
  }
  const flat = status.value.state === "ready" ? `installation:${status.value.installationId}` : `location:${status.value.locationId}`;
  const projects = await lessonRead($, "lessons.projects", { world, binding: flat }, (v) => decodeReadResult(v, decodeProjects));
  if (!projects.ok) {
    if (!projects.stale) data.handshakeError = readMessage(projects.error);
    return false;
  }
  const result = projects.value;
  if (status.value.state === "ready" && result.store.installationId !== status.value.installationId) {
    data.handshakeError = "The store changed while loading. Refresh to try again.";
    return false;
  }
  if (!result.value.every((choice) => choice.scope.world === world)) {
    data.handshakeError = "The store sent projects for another world.";
    return false;
  }
  const current = result.store.installationId;
  const block = blockFor(current);
  if (block === null && data.pinned === null) data.pinned = data.controller.state.expectedInstallation ?? current;
  data.store = current === null ? { state: "uninitialized", locationId: result.store.locationId } : { state: "ready", installationId: current };
  data.locationId = result.store.locationId;
  data.block = block;
  data.choices = block === null ? result.value : [];
  if (block !== null) {
    data.list = null;
    data.detail = null;
  }
  data.controller.observe({ connectionEpoch: data.epoch!, binding: { kind: "location", id: result.store.locationId }, installationId: current, pinnedLocationRetry: true });
  return block === null;
}

/** Strict reading of `lessons.context`; null when it is anything else. */
function decodeContext(value: unknown): { scope: LessonScope; requiresConfirmation: boolean } | { choice: string } {
  if (value === null || typeof value !== "object") throw new CurationReadError("MALFORMED", null);
  const v = value as Record<string, unknown>;
  if (v.state === "resolved") return { scope: decodeScope(v.scope), requiresConfirmation: v.requiresConfirmation === true };
  if (v.state === "choice_required" && typeof v.reason === "string") return { choice: v.reason };
  throw new CurationReadError("MALFORMED", null);
}

/** The session's own project, used only when nothing was chosen yet. A project
 * restored by a reload is checked against the same read instead. */
async function adoptContext($: EngineInterface): Promise<void> {
  if (data.world === null) return;
  const restored = data.project;
  if (restored !== null && !data.scopeUnverified) return;
  let cwd: string;
  try {
    cwd = await $.session.cwd();
  } catch {
    if (restored === null) data.contextNote = "This session's directory is unknown. Choose a project.";
    return;
  }
  if (cwd === "") return;
  const world = data.world;
  const read = await lessonRead($, "lessons.context", { world, cwd }, decodeContext);
  if (!read.ok) {
    if (!read.stale && restored === null) data.contextNote = `This directory's project could not be resolved: ${readMessage(read.error)} Choose one.`;
    return;
  }
  const ctx = read.value;
  if (restored !== null) {
    // Anything but this exact project, resolved, keeps the restored one unverified.
    if ("choice" in ctx || ctx.scope.world !== world || !sameProject(ctx.scope.project, restored) || data.project !== restored) return;
    data.scopeUnverified = false;
    data.scopeConfirm = ctx.requiresConfirmation ? { world, project: flatProject(restored), confirmed: false } : null;
    if (ctx.requiresConfirmation) data.contextNote = "This world was inferred as the catch-all for this directory. A capture here waits for you to confirm the world and project.";
    return;
  }
  if ("choice" in ctx) {
    data.contextNote = "This directory does not map to one project. Choose one.";
    return;
  }
  if (ctx.scope.world !== data.world || !data.choices.some((c) => sameProject(c.scope.project, ctx.scope.project))) {
    data.contextNote = "This directory's project is not among the choices. Choose one.";
    return;
  }
  data.project = ctx.scope.project;
  data.scopeConfirm = ctx.requiresConfirmation ? { world: data.world, project: flatProject(ctx.scope.project), confirmed: false } : null;
  data.contextNote = ctx.requiresConfirmation ? "This world was inferred as the catch-all for this directory. A capture here waits for you to confirm the world and project." : null;
}

/** The inferred or unverified scope the open capture still needs confirmed, or null. */
function scopeToConfirm(): { world: string; project: string; restored: boolean } | null {
  const c = data.scopeConfirm;
  const target = data.controller.state.target;
  if (target === null || data.controller.state.mode !== "capture") return null;
  if (data.scopeUnverified) return { world: target.scope.world, project: flatProject(target.scope.project), restored: true };
  if (c === null || c.confirmed) return null;
  if (target.scope.world !== c.world || flatProject(target.scope.project) !== c.project) return null;
  return { world: c.world, project: c.project, restored: false };
}

/** Starts the list over from its first page. */
function resetPaging(): void {
  data.pageCursor = null;
  data.pageBack = [];
}

/** One browse page, replacing the one shown: pages are never accumulated.
 * `requested` reads another page than the shown one, and `moved` sets its page
 * history. The list, cursor and history change together, after every await,
 * and only if no later page move started and the scope did not move. */
async function reloadList($: EngineInterface, requested?: string | null, moved?: () => void): Promise<void> {
  const cursor = requested === undefined ? data.pageCursor : requested;
  const seq = requested === undefined ? listSeq : ++listSeq;
  const project = data.project;
  const binding = currentBinding();
  const world = data.world;
  if (project === null || binding === null || world === null) return;
  const filter = data.filter;
  const query = browseQuery({
    world,
    project,
    binding,
    collection: filter === "important" ? "all" : filter,
    ...(filter === "important" ? { important: true } : {}),
    search: data.search.trim(),
    limit: LESSONS_PAGE_SIZE,
    ...(cursor !== null ? { cursor } : {}),
  });
  const read = await lessonRead($, "lessons.browse", query, (v) => decodeReadResult(v, decodeBrowsePage));
  if (!read.ok) {
    if (!read.stale) data.listError = readMessage(read.error);
    return;
  }
  const page = read.value;
  if (data.block !== null || page.store.installationId !== data.pinned) return;
  if (!page.value.items.every((item) => item.key.world === world && item.scope.world === world && sameProject(item.scope.project, project))) {
    data.listError = "The store sent lessons for another project.";
    return;
  }
  const ctx = data.ctx;
  const readAt = await nowIso($);
  // Last check, then no await until the page is shown: a read a later page
  // move or a scope change overtook is dropped, as is a reread of a page no longer shown.
  if (seq !== listSeq || ctx !== data.ctx || data.block !== null || page.store.installationId !== data.pinned) return;
  if (requested === undefined && cursor !== data.pageCursor) return;
  data.list = { items: page.value.items, total: page.value.total, nextCursor: page.value.nextCursor, readAt };
  data.listError = null;
  moved?.();
}

async function nowIso($: EngineInterface): Promise<string> {
  try {
    return new Date(await $.clock.now()).toISOString();
  } catch {
    return "unknown time";
  }
}

async function loadDetail($: EngineInterface): Promise<LessonView | null> {
  if (data.block !== null) return null;
  const c = data.controller;
  const state = c.state;
  const target = state.target;
  if (target === null || state.phase === "purged") return null;
  const generation = state.generation;
  const epoch = data.epoch!;
  const args = { key: encodeLessonKey(target.key), project: flatProject(target.scope.project), binding: flatBinding(recordReadBinding(target)) };
  const read = await lessonRead($, "lessons.get", args, (v) => decodeReadResult(v, (x) => (x === null ? null : decodeLessonDetail(x))));
  if (!read.ok) {
    if (!read.stale && c.state.generation === generation) data.detailError = readMessage(read.error);
    return null;
  }
  const result: LessonHostResult = { operation: "read", connectionEpoch: epoch, generation, target, installationId: read.value.store.installationId };
  if (read.value.value === null) {
    c.dispatch({ type: "detail-missing", generation, target }, result);
    return null;
  }
  const lesson = read.value.value.lesson;
  c.dispatch({ type: "loaded", generation, target, view: lesson }, result);
  // Only what the controller accepted from this read is drawn.
  const accepted = c.state.generation === generation && c.state.loaded !== null && JSON.stringify(c.state.loaded) === JSON.stringify(lesson);
  if (!accepted) return null;
  const prior = data.detail;
  const keep = prior !== null && sameKey(prior.key, lesson.key) && prior.revision === lesson.revision && prior.history !== null && !prior.historyError;
  data.detailError = null;
  data.detail = {
    key: lesson.key,
    revision: lesson.revision,
    provenance: read.value.value.provenance,
    diagnostics: read.value.value.diagnostics,
    history: keep ? prior.history : null,
    historyTotal: keep ? prior.historyTotal : null,
    historyError: false,
    readAt: await nowIso($),
  };
  if (!keep) {
    const history = await lessonRead($, "lessons.history", { ...args, limit: String(HISTORY_PAGE_SIZE) }, (v) => decodeReadResult(v, decodeHistory));
    const shown = data.detail;
    if (shown !== null && sameKey(shown.key, lesson.key) && shown.revision === lesson.revision) {
      data.detail = history.ok
        ? { ...shown, history: history.value.value.items, historyTotal: history.value.value.total }
        : history.stale
          ? shown
          : { ...shown, historyError: true };
    }
  }
  return c.state.loaded;
}

/** Store first, then project, list and the open record. One at a time; the
 * parent's 10 s timer calls it while Activity is shown with Lessons open. */
export function refreshLessons($: EngineInterface): Promise<void> {
  if (!data.open) return Promise.resolve();
  if (data.refreshing !== null) return data.refreshing;
  const run = (async () => {
    // A save in flight or a decision on screen: nothing is read under it.
    if (data.controller.sending || data.prompt !== null) return;
    if (!(await handshake($))) return;
    await adoptContext($);
    await reloadList($);
    const state = data.controller.state;
    // A capture restored by a reload needs one read (absent, or saved meanwhile) before it is shown.
    if (state.target !== null && state.phase !== "purged" && (state.mode === "existing" || state.pending !== null || state.needsFreshDetail)) await loadDetail($);
    if (state.target !== null && state.phase === "purged" && data.purgeCheck === "unavailable") await verifyPurged($, false);
  })()
    .catch(() => {
      data.listError = "Lessons could not be read.";
    })
    .finally(() => {
      data.refreshing = null;
    })
    .then(() => publish($));
  data.refreshing = run;
  return run;
}

// --- capture source ---------------------------------------------------------------------

export type CaptureSelection = { source: CaptureSource | null; note: string | null };

function validId(value: unknown, re: RegExp): string | null {
  return typeof value === "string" && re.test(value) ? value : null;
}

function emptySource(sessionId: string | null): CaptureSource {
  return {
    kind: "explicit_quote",
    quote: null,
    reference: null,
    quoteRedacted: false,
    captureSessionId: sessionId,
    sourceConversationId: null,
    sourceRowId: null,
    sourceAgentId: null,
  };
}

/**
 * Reads the person's selection now, before anything that could clear it is
 * drawn. `view` is the transcript in view when known (a press in the pane);
 * null when not (a slash command). A row id only says where the text lay; the
 * conversation or agent is attached only when the view was known. Nothing else
 * is read: no last message, no transcript.
 */
export async function readCaptureSelection($: EngineInterface, view: { agentId?: string } | null): Promise<CaptureSelection> {
  let sessionId: string | null = null;
  try {
    sessionId = validId(await $.session.id(), SOURCE_ID_RE);
  } catch {
    sessionId = null;
  }
  let selected: Awaited<ReturnType<EngineInterface["ui"]["selection"]>>;
  try {
    selected = await $.ui.selection();
  } catch {
    return { source: emptySource(sessionId), note: "Selection unavailable. Paste the relevant passage or add a reference." };
  }
  const text = selected?.text;
  if (typeof text !== "string" || !isWellFormed(text) || !hasVisibleText(text)) {
    return { source: emptySource(sessionId), note: "Selection unavailable. Paste the relevant passage or add a reference." };
  }
  if (utf8Bytes(text) > MAX_QUOTE_BYTES) {
    return { source: emptySource(sessionId), note: `The selection is over ${MAX_QUOTE_BYTES} bytes and was not used. Paste a shorter passage or add a reference.` };
  }
  if (containsSensitiveText(text)) {
    return { source: emptySource(sessionId), note: "The selection looks like it holds a secret and was not used. Paste the passage without it, or add a reference." };
  }
  const row = validId(selected?.requestId, SOURCE_ID_RE);
  const viewKnown = view !== null && typeof view === "object";
  const agent = viewKnown ? validId(view.agentId, AGENT_ID_RE) : null;
  const viewIsMain = viewKnown && view.agentId === undefined;
  return {
    source: {
      kind: "native_selection",
      quote: text,
      reference: null,
      quoteRedacted: false,
      captureSessionId: sessionId,
      sourceConversationId: row !== null && viewIsMain ? sessionId : null,
      sourceRowId: row,
      sourceAgentId: row !== null ? agent : null,
    },
    note: row === null ? "Selected text kept as a quote; which transcript row it came from is not known." : viewKnown ? null : "Selected text kept with its row; which conversation it lies in is not known.",
  };
}

/** The original Task 7 contract: the source a capture opens with, or null when
 * there is no usable selection. */
export async function readCaptureSource($: EngineInterface, view: { agentId?: string } | null): Promise<CaptureSource | null> {
  const read = await readCaptureSelection($, view);
  return read.source !== null && read.source.kind === "native_selection" ? read.source : null;
}

// --- actions -------------------------------------------------------------------------------

export type LessonAction =
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "filter"; filter: LessonFilter }
  | { kind: "project"; project: string }
  | { kind: "more" }
  | { kind: "record"; index: number }
  | { kind: "capture"; view: { agentId?: string } | null }
  | { kind: "close-editor" }
  | { kind: "save" }
  | { kind: "important" }
  | { kind: "acknowledge" }
  | { kind: "purge" }
  | { kind: "purge-confirm" }
  | { kind: "purge-cancel" }
  | { kind: "stay" }
  | { kind: "discard" }
  | { kind: "rebase" }
  | { kind: "check" }
  | { kind: "retry" }
  | { kind: "open-existing" }
  | { kind: "refresh" }
  | { kind: "prev" }
  | { kind: "first" }
  | { kind: "projects"; offset: number }
  | { kind: "confirm-scope" };

/** Actions that would change the editor or its scope: held while a send runs. */
const HELD_WHILE_SENDING: ReadonlySet<LessonAction["kind"]> = new Set([
  "project", "record", "capture", "close-editor", "open-existing", "rebase", "save", "important", "acknowledge", "purge", "purge-confirm", "retry", "discard", "confirm-scope",
]);
const SENDING_NOTICE = "A save is in flight: wait for it to finish before changing the lesson, its scope or the world.";

export type LessonField = "search" | "text" | "quote" | "reference";

/** What a press or a pick in the Lessons view does. Never throws; a failure is
 * shown, never logged with content. */
export function lessonsAct($: EngineInterface, action: LessonAction, world: string | null): Promise<{ switchWorld: string | null }> {
  let switchWorld: string | null = null;
  return actOnce($, action, world, (w) => (switchWorld = w))
    .catch(() => {
      data.notice = { tone: "error", text: "That lesson action failed. Nothing was sent unless a save says so." };
    })
    .then(() => publish($))
    .then(() => ({ switchWorld }));
}

/** Binds the view to `world` unless that would drop unsent wording; then it
 * asks first and returns false. */
function rebindWorld(world: string | null): boolean {
  if (world === data.world) return true;
  if (lessonsDirty()) {
    if (world !== null) data.prompt = { kind: "world", world };
    return false;
  }
  bindWorld(world);
  return true;
}

async function actOnce($: EngineInterface, action: LessonAction, world: string | null, switchTo: (world: string) => void): Promise<void> {
  if (data.controller.sending && (HELD_WHILE_SENDING.has(action.kind) || world !== data.world)) {
    data.notice = { tone: "error", text: SENDING_NOTICE };
    return;
  }
  if (action.kind !== "stay" && action.kind !== "discard" && action.kind !== "close" && !rebindWorld(world)) return;
  switch (action.kind) {
    case "open":
      data.open = true;
      await publish($);
      await refreshLessons($);
      return;
    case "close":
      // The view goes, the editor stays: unsent wording is still there next time.
      data.open = false;
      return;
    case "refresh":
      await refreshLessons($);
      return;
    case "filter":
      if (data.filter === action.filter) return;
      data.filter = action.filter;
      data.ctx += 1;
      data.list = null;
      resetPaging();
      await reloadList($);
      return;
    case "project": {
      const project = parseFlatProject(action.project);
      if (project === null || !data.choices.some((c) => sameProject(c.scope.project, project))) return;
      if (data.project !== null && sameProject(data.project, project)) {
        // The same option picked again is an explicit choice: it confirms an inferred or restored scope.
        data.scopeUnverified = false;
        if (data.scopeConfirm !== null && data.scopeConfirm.project === flatProject(project)) data.scopeConfirm = { ...data.scopeConfirm, confirmed: true };
        return;
      }
      if (lessonsDirty()) {
        data.prompt = { kind: "project", project };
        return;
      }
      await applyProject($, project);
      return;
    }
    // Paging: the cursor history moves only with the list it belongs to. A
    // failed read leaves the shown page, its label and its rows as they were.
    case "more": {
      const next = data.list?.nextCursor ?? null;
      if (next === null) return;
      const back = [...data.pageBack, data.pageCursor];
      data.ctx += 1;
      await reloadList($, next, () => {
        data.pageBack = back;
        data.pageCursor = next;
      });
      return;
    }
    case "prev": {
      if (data.pageBack.length === 0) return;
      const cursor = data.pageBack.at(-1) ?? null;
      const back = data.pageBack.slice(0, -1);
      data.ctx += 1;
      await reloadList($, cursor, () => {
        data.pageCursor = cursor;
        data.pageBack = back;
      });
      return;
    }
    case "first":
      if (data.pageBack.length === 0) return;
      data.ctx += 1;
      await reloadList($, null, resetPaging);
      return;
    case "projects":
      if (!Number.isSafeInteger(action.offset) || action.offset < 0 || action.offset >= Math.max(1, data.choices.length)) return;
      data.projectOffset = action.offset;
      return;
    case "confirm-scope": {
      const pending = scopeToConfirm();
      if (pending === null) return;
      data.scopeUnverified = false;
      data.scopeConfirm = { world: pending.world, project: pending.project, confirmed: true };
      data.contextNote = null;
      return;
    }
    case "record": {
      const item = data.list?.items[action.index];
      if (item === undefined) return;
      await openRecord($, item.key, item.scope);
      return;
    }
    case "capture":
      await openCapture($, await readCaptureSelection($, action.view));
      return;
    case "close-editor":
      if (lessonsDirty()) {
        data.controller.dispatch({ type: "close" });
        return;
      }
      closeEditor();
      return;
    case "save": {
      const mode = data.controller.state.mode;
      await submit($, { kind: "save" }, mode === "capture" ? "capture" : "edit");
      return;
    }
    case "important": {
      const base = data.controller.state.base;
      if (base === null) return;
      // One desired-state write: the opposite of what the record holds, sent as a boolean.
      await submit($, { kind: "important", value: !base.important }, "important");
      return;
    }
    case "acknowledge": {
      const digest = data.controller.state.loaded?.sourceDigest ?? null;
      if (digest === null) return;
      await submit($, { kind: "acknowledge-source", digest }, "acknowledge-source");
      return;
    }
    case "purge": {
      const target = data.controller.state.target;
      data.purgeConfirm = target === null ? null : { ...target.key };
      return;
    }
    case "purge-cancel":
      data.purgeConfirm = null;
      return;
    case "purge-confirm": {
      const asked = data.purgeConfirm;
      data.purgeConfirm = null;
      const target = data.controller.state.target;
      // Only the record the question named; the controller checks its revision.
      if (asked === null || target === null || !sameKey(asked, target.key)) {
        if (asked !== null) data.notice = { tone: "error", text: "The open lesson is not the one the purge question named. Nothing was purged." };
        return;
      }
      await submit($, { kind: "purge", confirmed: true }, "purge");
      return;
    }
    case "stay":
      data.prompt = null;
      data.pendingPrefill = null;
      data.controller.dispatch({ type: "stay" });
      return;
    case "discard": {
      const prompt = data.prompt;
      data.prompt = null;
      if (prompt !== null) {
        if (!closeEditor(true)) return;
        if (prompt.kind === "project") await applyProject($, prompt.project);
        else {
          bindWorld(prompt.world);
          switchTo(prompt.world);
        }
        return;
      }
      const before = data.controller.state.generation;
      data.controller.dispatch({ type: "discard" });
      const after = data.controller.state;
      const prefill = data.pendingPrefill;
      data.pendingPrefill = null;
      if (after.generation === before) {
        // A plain revert: the fields show the base again, so their guards go.
        data.refused = {};
        data.dropped = {};
        return;
      }
      // The held navigation was accepted: only now does the old view go.
      data.ctx += 1;
      clearRecordView();
      if (after.mode === "capture" && prefill !== null && after.target?.key.id === prefill.recordId) {
        data.captureNote = prefill.note;
        if (prefill.quote !== null) data.controller.dispatch({ type: "edit-text", text: prefill.quote });
      } else if (after.target !== null && after.mode === "existing") await loadDetail($);
      return;
    }
    case "rebase":
      data.controller.dispatch({ type: "rebase" });
      return;
    case "check":
      await checkOutcome($);
      return;
    case "retry": {
      const pending = data.controller.state.pending;
      if (pending !== null) await send($, pending.requestId, null);
      return;
    }
    case "open-existing": {
      const target = data.controller.state.target;
      if (target === null || !data.captureExists) return;
      await openRecord($, { ...target.key }, { world: target.scope.world, project: { ...target.scope.project } } as LessonScope);
      return;
    }
  }
}

/** Typing into one of the view's fields. Wording and source go to the
 * controller (memory, then screened session state); search waits for Enter. */
export function lessonsInput($: EngineInterface, field: LessonField, value: string, kind: "change" | "submit"): Promise<void> {
  const c = data.controller;
  if (field !== "search" && c.sending) {
    data.notice = { tone: "error", text: SENDING_NOTICE };
    return publish($);
  }
  if (value.length > MAX_FIELD_CHARS) {
    // Refused whole, never cut. The field is drawn again with what it held
    // before, so it says so beside the field and Save waits for a new edit:
    // the older text is never saved as if it were what was typed.
    if (field !== "search") data.dropped[field] = true;
    data.notice = { tone: "error", text: `That text is over ${MAX_FIELD_CHARS} characters and was not kept. Nothing was saved or searched.` };
    return publish($);
  }
  if (field !== "search") delete data.dropped[field];
  if (field === "search") {
    // Typed text is kept so a redraw shows it; only Enter runs the search.
    data.searchDraft = value;
    if (kind !== "submit") return Promise.resolve();
    if (value.length > CURATION_MAX_SEARCH_CHARS) {
      data.notice = { tone: "error", text: `Search is limited to ${CURATION_MAX_SEARCH_CHARS} characters. Nothing was searched.` };
      return publish($);
    }
    if (containsSensitiveText(value)) {
      data.notice = { tone: "error", text: "That search looks like it holds a secret and was not run." };
      return publish($);
    }
    data.search = value;
    data.searchDraft = null;
    data.ctx += 1;
    data.list = null;
    data.notice = null;
    resetPaging();
    return reloadList($).catch(() => undefined).then(() => publish($));
  }
  if (field === "text") {
    c.dispatch({ type: "edit-text", text: value });
    noteRefusal("text", value, c.state.error?.fields.includes("text") === true);
    return publish($);
  }
  const source = c.state.draft?.source;
  if (!source) return Promise.resolve();
  const next: CaptureSource = { ...source, ...(field === "quote" ? { quote: value === "" ? null : value } : { reference: value === "" ? null : value }) };
  c.dispatch({ type: "edit-source", source: next });
  noteRefusal(field, value, c.state.error?.fields.includes("source") === true);
  return publish($);
}

const FIELD_LIMITS = { text: MAX_TEXT_BYTES, quote: MAX_QUOTE_BYTES, reference: MAX_REFERENCE_BYTES } as const;

/** The editor refused this edit: keep what was typed on screen and block Save
 * until it fits. A later accepted edit clears it. */
function noteRefusal(field: "text" | "quote" | "reference", value: string, refused: boolean): void {
  if (refused) data.refused[field] = value;
  else delete data.refused[field];
  const over = Object.keys(data.refused) as Array<keyof typeof FIELD_LIMITS>;
  data.notice = over.length > 0 ? { tone: "error", text: `${over.map((f) => `The ${f === "text" ? "wording" : f} is over its ${FIELD_LIMITS[f]}-byte limit`).join(". ")}. Nothing is saved until it fits.` } : data.notice?.tone === "error" && data.notice.text.includes("-byte limit") ? null : data.notice;
}

/** The console's world moved. A dirty editor decides first: false means the
 * switch waits for Stay or Discard, and the view is opened so it can ask. */
export function lessonsWorldChanging($: EngineInterface, world: string): boolean {
  if (data.world === null || data.world === world) return true;
  if (data.controller.sending) {
    data.notice = { tone: "error", text: SENDING_NOTICE };
    data.open = true;
    void publish($);
    return false;
  }
  const bound = rebindWorld(world);
  if (!bound) data.open = true;
  void publish($);
  return bound;
}

function bindWorld(world: string | null): void {
  if (data.world === world) return;
  if (data.controller.state.target !== null) closeEditor(true);
  data.world = world;
  data.ctx += 1;
  data.project = null;
  data.choices = [];
  data.list = null;
  data.scopeConfirm = null;
  data.scopeUnverified = false;
  data.projectOffset = 0;
  data.searchDraft = null;
  resetPaging();
  data.listError = null;
  data.contextNote = null;
  data.pendingCapture = null;
  data.captureNote = null;
  data.notice = null;
  data.prompt = null;
  data.pinned = null;
  data.store = null;
  data.block = null;
}

async function applyProject($: EngineInterface, project: ProjectScope): Promise<void> {
  const target = data.controller.state.target;
  if (target !== null && !sameProject(target.scope.project, project) && !closeEditor()) return;
  data.project = project;
  data.ctx += 1;
  data.list = null;
  data.listError = null;
  data.contextNote = null;
  // A project picked by the person is an explicit choice, not an inference.
  data.scopeConfirm = null;
  data.scopeUnverified = false;
  resetPaging();
  if (data.pendingCapture !== null) {
    const source = data.pendingCapture;
    data.pendingCapture = null;
    await openCapture($, { source, note: data.captureNote });
    return;
  }
  await reloadList($);
}

function clearRecordView(): void {
  data.refused = {};
  data.dropped = {};
  data.detail = null;
  data.detailError = null;
  data.purgeConfirm = null;
  data.purgeCheck = null;
  data.captureExists = false;
}

/** Sets the open record aside. False when the controller refused (a dirty
 * draft without consent, or a full list of unchecked saves). */
function closeEditor(discard = false): boolean {
  const prior = data.controller.state;
  if (prior.target === null) return true;
  if (prior.gate === "mismatch") {
    if (!discard && data.controller.dirty) return false;
    const candidate = new LessonEditorController();
    const epoch = newEpoch();
    candidate.connect(epoch);
    candidate.dispatch({ type: "hydrate", snapshot: data.controller.snapshot() });
    if (candidate.state.error?.fields.includes("snapshot")) return false;
    candidate.dispatch({ type: "close" });
    if (candidate.state.target !== null) return false;
    data.controller = candidate;
    data.epoch = epoch;
  } else {
    data.controller.dispatch({ type: "close" });
    if (discard && data.controller.state.target !== null) data.controller.dispatch({ type: "discard" });
  }
  const closed = data.controller.state.target === null;
  if (closed) {
    data.ctx += 1;
    clearRecordView();
  } else {
    data.notice = { tone: "error", text: "The open lesson could not be set aside: too many unchecked saves. Nothing was changed." };
  }
  return closed;
}

async function openRecord($: EngineInterface, key: LessonKey, scope: LessonScope): Promise<void> {
  const binding = currentBinding();
  if (binding === null) return;
  const before = data.controller.state.generation;
  data.controller.dispatch({ type: "open-lesson", scope, binding, key });
  const opened = data.controller.state;
  // Held for Stay or Discard (a dirty draft), or refused: the view and every
  // field guard stay exactly as they are, the same row included.
  if (opened.generation === before || opened.target === null || !sameKey(opened.target.key, key)) return;
  data.ctx += 1;
  clearRecordView();
  data.notice = null;
  await loadDetail($);
}

/** Opens the capture form with what the selection gave. Without a project the
 * selection waits in memory for one; without a store the form waits too. */
async function openCapture($: EngineInterface, selection: CaptureSelection): Promise<void> {
  if (data.controller.sending) {
    data.notice = { tone: "error", text: SENDING_NOTICE };
    return;
  }
  if (data.world === null) {
    data.notice = { tone: "error", text: "Choose a world before capturing a lesson." };
    return;
  }
  if (currentBinding() === null || data.choices.length === 0) await handshake($);
  await adoptContext($);
  const binding = currentBinding();
  if (binding === null) {
    data.notice = { tone: "error", text: data.handshakeError ?? data.block ?? "The curation store is not known yet. Refresh and try again." };
    data.pendingCapture = selection.source;
    data.captureNote = selection.note;
    return;
  }
  if (data.project === null) {
    data.pendingCapture = selection.source;
    data.captureNote = selection.note;
    data.notice = { tone: "info", text: "Choose a project for this capture." };
    return;
  }
  const source = selection.source ?? emptySource(null);
  const recordId = crypto.randomUUID();
  const before = data.controller.state.generation;
  data.controller.dispatch({ type: "open-capture", scope: { world: data.world, project: data.project }, binding, recordId, source });
  const opened = data.controller.state;
  if (opened.generation === before || opened.mode !== "capture" || opened.target?.key.id !== recordId) {
    // Held for Stay or Discard: nothing shown changes until it is accepted,
    // the open capture's note included. The new wording and note wait.
    data.pendingPrefill = opened.generation === before ? { recordId, quote: source.quote, note: selection.note } : null;
    return;
  }
  data.ctx += 1;
  clearRecordView();
  data.captureNote = selection.note;
  data.notice = null;
  // The proposed wording is the quote itself, never a rewrite.
  if (source.quote !== null) data.controller.dispatch({ type: "edit-text", text: source.quote });
}

/** `/sil capture`: the selection was read before the pane opened. */
export async function openLessonCapture($: EngineInterface, selection: CaptureSelection, world: string | null): Promise<string | null> {
  // Before any rebind or view change: a clean editor can still have a write in flight.
  if (data.controller.sending) {
    data.notice = { tone: "error", text: SENDING_NOTICE };
    await publish($);
    return `The capture was held. ${SENDING_NOTICE}`;
  }
  data.open = true;
  if (!rebindWorld(world)) {
    await publish($);
    return "The lesson editor holds unsent wording for another world. Save or discard it first.";
  }
  await openCapture($, selection).catch(() => {
    data.notice = { tone: "error", text: "The capture form could not open." };
  });
  await publish($);
  return null;
}

/** `/sil lesson <encoded key>`: the exact record, after its scope is found. */
export async function openLessonByKey($: EngineInterface, encoded: string, world: string | null): Promise<string> {
  let key: LessonKey;
  try {
    key = decodeLessonKey(encoded);
  } catch {
    return "That lesson key is not valid.";
  }
  if (world !== key.world) return `That lesson belongs to world ${JSON.stringify(key.world)}. Switch the console to it first.`;
  if (data.controller.sending) return SENDING_NOTICE;
  if (lessonsDirty()) return "The lesson editor holds unsent wording. Save or discard it first.";
  if (!rebindWorld(world)) return "The lesson editor holds unsent wording. Save or discard it first.";
  data.open = true;
  try {
    if (!(await handshake($)) || data.pinned === null) {
      await publish($);
      return data.handshakeError ?? data.block ?? "The curation store could not be read.";
    }
    const read = await lessonRead($, "lessons.locate", { key: encodeLessonKey(key), binding: `installation:${data.pinned}` }, (v) => decodeLocatedResult(v, data.pinned!, key));
    if (!read.ok) {
      await publish($);
      return read.stale ? "The lesson view changed while looking it up." : readMessage(read.error);
    }
    const scope = read.value.value;
    if (scope === null) {
      await publish($);
      return "No lesson with this key in this installation.";
    }
    if (data.project === null || !sameProject(data.project, scope.project)) {
      data.project = scope.project;
      data.ctx += 1;
      data.list = null;
    }
    await openRecord($, key, scope);
    await reloadList($);
  } catch {
    await publish($);
    return "The lesson could not be opened.";
  }
  await publish($);
  return "Opened the lesson in the self-improvement loop console.";
}

// --- writes ----------------------------------------------------------------------------------

type Readback = "capture" | "edit" | "important" | "acknowledge-source" | "purge";

function projectDescriptor(): ProjectDescriptor | null {
  const state = data.controller.state;
  const target = state.target;
  if (target === null || target.scope.project.kind !== "project" || state.mode !== "capture") return null;
  const project = target.scope.project;
  const choice = data.choices.find((c) => sameProject(c.scope.project, project));
  if (!choice || choice.root === null || data.world === null) return null;
  return { world: data.world, projectId: project.id, root: choice.root };
}

/** Fields of the wording or source that look like a secret. Checked before
 * anything is sent; the host checks again. */
function sensitiveFields(intent: LessonIntent): string[] {
  if (intent.kind !== "save") return [];
  const draft = data.controller.state.draft;
  if (draft === null) return [];
  const fields: string[] = [];
  if (containsSensitiveText(draft.text)) fields.push("wording");
  if (draft.source?.quote && containsSensitiveText(draft.source.quote)) fields.push("quote");
  if (draft.source?.reference && containsSensitiveText(draft.source.reference)) fields.push("reference");
  return fields;
}

async function submit($: EngineInterface, intent: LessonIntent, readback: Readback): Promise<void> {
  if (data.block !== null) return;
  const unconfirmed = intent.kind === "save" ? scopeToConfirm() : null;
  if (unconfirmed !== null) {
    data.notice = { tone: "error", text: `Confirm the ${unconfirmed.restored ? "restored" : "inferred"} world and project before saving this capture. Nothing was sent.` };
    return;
  }
  if (intent.kind === "save" && Object.keys(data.dropped).length > 0) {
    data.notice = { tone: "error", text: "A field shows older text because what was typed there was too long and not kept. Edit that field before saving; nothing was sent." };
    return;
  }
  if (intent.kind === "save" && Object.keys(data.refused).length > 0) {
    data.notice = { tone: "error", text: "A field is over its limit. Shorten it; nothing was sent." };
    return;
  }
  const sensitive = sensitiveFields(intent);
  if (sensitive.length > 0) {
    data.notice = { tone: "error", text: `This looks like a secret in ${sensitive.join(", ")}. Remove it and save again. Nothing was sent.` };
    return;
  }
  const requestId = `lc_${crypto.randomUUID()}`;
  data.controller.dispatch({ type: "submit", requestId, intent });
  if (data.controller.state.pending?.requestId !== requestId) return;
  await send($, requestId, readback);
}

/** One attempt of the pending request. The controller's token is the only
 * thing that can end it; the transport's answer is mapped, never trusted. */
async function send($: EngineInterface, requestId: string, readback: Readback | null): Promise<void> {
  const c = data.controller;
  let attempt: ReturnType<LessonEditorController["beginAttempt"]>;
  try {
    attempt = c.beginAttempt(requestId);
  } catch {
    return;
  }
  data.notice = null;
  data.captureExists = false;
  data.purgeCheck = null;
  await publish($);
  let completion: LessonAttemptOutcome | LessonAttemptSuccess;
  try {
    const envelope = toCurationMutationEnvelope(attempt.prepared, projectDescriptor());
    const response: CurationMutationResponse = await mutateControl($, envelope);
    if ("receipt" in response) completion = { kind: "success", store: { ...response.store }, receipt: response.receipt };
    else completion = classifyMutationFailure(response.error) === "refused" ? { kind: "refused", code: response.error.code, fields: [] } : { kind: "unknown" };
  } catch (err) {
    // Refused before launch: nothing was sent.
    completion = err instanceof CurationError ? { kind: "refused", code: err.code, fields: [...err.fields] } : { kind: "refused", code: "INVALID_INPUT", fields: ["request"] };
  }
  c.finishAttempt(attempt.token, completion);
  if (c !== data.controller) return;
  await afterOutcome($, completion, readback);
}

async function afterOutcome($: EngineInterface, completion: LessonAttemptOutcome | LessonAttemptSuccess, readback: Readback | null): Promise<void> {
  const state = data.controller.state;
  if (state.phase === "purged") {
    await verifyPurged($, readback === "purge");
    return;
  }
  if (state.phase === "conflict") {
    if (state.mode === "capture" && state.error?.code === "CAPTURE_EXISTS") {
      data.captureExists = true;
      return;
    }
    await loadDetail($);
    return;
  }
  if (completion.kind !== "success" || state.pending !== null || completion.receipt.state !== "completed") return;
  const committed = completion.receipt.result;
  if (data.store?.state !== "ready") await handshake($);
  await confirmReadback($, committed.key, committed.revision, readback);
}

async function confirmReadback($: EngineInterface, key: LessonKey, revision: number, readback: Readback | null): Promise<void> {
  const view = await loadDetail($);
  if (view === null || !readbackConfirms(revision, key, view)) {
    data.notice = { tone: "info", text: "The save was recorded but a fresh read has not shown it yet. Refresh to check." };
    return;
  }
  const text =
    readback === "capture"
      ? "Saved locally. Not installed or queued for learning."
      : readback === "important"
        ? view.important
          ? "Marked important."
          : "No longer marked important."
        : readback === "acknowledge-source"
          ? "Current source accepted."
          : "Saved.";
  data.notice = { tone: "ok", text };
  await reloadList($);
}

/** A purge counts once a fresh read of the same record says purged. */
async function verifyPurged($: EngineInterface, own: boolean): Promise<void> {
  const target = data.controller.state.target;
  if (target === null) return;
  const expected = data.controller.state.expectedInstallation;
  data.detail = null;
  data.purgeCheck = "pending";
  const args = { key: encodeLessonKey(target.key), project: flatProject(target.scope.project), binding: flatBinding(recordReadBinding(target)) };
  const read = await lessonRead($, "lessons.get", args, (v) => decodeReadResult(v, (x) => (x === null ? null : decodeLessonDetail(x))));
  if (!read.ok && read.stale) return;
  const detail = read.ok ? read.value : null;
  const verified =
    detail !== null && detail.value !== null && detail.value.lesson.sourceStatus === "purged" && sameKey(detail.value.lesson.key, target.key) &&
    (expected === null || detail.store.installationId === expected);
  data.purgeCheck = verified ? "verified" : "unavailable";
  if (verified && own) data.notice = { tone: "ok", text: "Purged locally. Its curated wording, quotes and history are gone from this installation." };
  if (verified) await reloadList($);
}

/** Looks up the pending request's receipt. Never resends it. */
async function checkOutcome($: EngineInterface): Promise<void> {
  const c = data.controller;
  const pending = c.state.pending;
  if (pending === null) return;
  if (!(await handshake($)) && data.block === null) return;
  const target = { scope: pending.scope, binding: pending.binding, key: pending.key };
  const epoch = data.epoch!;
  const origin = installationOf(pending);
  const binding: StoreBinding = origin === null ? pending.binding : { kind: "installation", id: origin };
  const read = await lessonRead(
    $,
    "lessons.receipt",
    { key: encodeLessonKey(pending.key), project: flatProject(pending.scope.project), binding: flatBinding(binding), requestId: pending.requestId },
    (v) => decodeReadResult(v, (x) => decodeReceiptRead(x, pending.requestId)),
    () => c.state.pending?.requestId === pending.requestId,
  );
  if (!read.ok) {
    if (!read.stale) data.notice = { tone: "error", text: `Could not check the earlier save: ${readMessage(read.error)} Its outcome is still unknown.` };
    return;
  }
  c.dispatch(
    { type: "receipt", generation: pending.generation, requestId: pending.requestId, target, receipt: read.value.value },
    { operation: "receipt", connectionEpoch: epoch, generation: pending.generation, target, requestId: pending.requestId, installationId: read.value.store.installationId },
  );
  const receipt = read.value.value;
  if (receipt.state === "unknown") {
    data.notice = { tone: "info", text: "No result recorded for this request yet. It may still be running." };
    return;
  }
  if (c.state.pending === null || data.block !== null) await handshake($);
  if (receipt.state === "committed" && c.state.pending === null) await confirmReadback($, receipt.key, receipt.revision, null);
  if (receipt.state === "purged") await verifyPurged($, false);
}

// --- small helpers -----------------------------------------------------------------------------

export function sameKey(a: LessonKey, b: LessonKey): boolean {
  return a.world === b.world && a.kind === b.kind && a.id === b.id;
}

export function sameProject(a: ProjectScope, b: ProjectScope): boolean {
  return a.kind === b.kind && (a.kind !== "project" || a.id === (b as { id: string }).id);
}

/** Wording for a failed read. A read failure never says anything about a save. */
export function readMessage(e: CurationReadError): string {
  switch (e.code) {
    case "TRANSPORT":
      return "The control bridge did not answer.";
    case "MALFORMED":
      return "The bridge sent an answer this console cannot read.";
    case "INSTALLATION_MISMATCH":
      return "Different SIL installation. Nothing from it is shown here.";
    case "STORE_CHANGED":
      return "The store changed while loading. Refresh to check its identity.";
    case "STORAGE_BUSY":
      return "Curation storage is busy. Try again.";
    case "STORAGE_UNAVAILABLE":
      return "Curation storage is unavailable.";
    case "UNSUPPORTED_SCHEMA":
      return "This installation's curation store has an unsupported version.";
    case "SCOPE_CONFLICT":
      return "This lesson belongs to another project.";
    default:
      return `Could not read lessons (${e.code}).`;
  }
}

/** Wording for an editor error code. Codes and field names only, never input. */
export function editorErrorText(code: string, fields: readonly string[] = []): string {
  switch (code) {
    case "INSTALLATION_MISMATCH":
      return "Different SIL installation. Nothing from it is shown or saved here.";
    case "STORE_UNRESOLVED":
      return "Cannot confirm which store holds this lesson, so nothing is shown.";
    case "CURATION_CONFLICT":
      return "This lesson changed elsewhere. Your wording is kept.";
    case "CAPTURE_EXISTS":
      return "A lesson with this id is already stored. Your wording is kept.";
    case "SCOPE_CONFLICT":
      return "This lesson belongs to another project.";
    case "SOURCE_CONFLICT":
      return "The delivery source disagrees with itself. Nothing was changed.";
    case "SENSITIVE_CONTENT":
      return `This looks like a secret${fields.length ? ` in ${fields.join(", ")}` : ""}. Remove it and save again.`;
    case "STORAGE_BUSY":
      return "Storage is busy. Nothing was saved. Try again.";
    case "STORAGE_UNAVAILABLE":
      return "Curation storage is unavailable.";
    case "UNSUPPORTED_SCHEMA":
      return "This installation's curation store has an unsupported version.";
    case "PURGED":
      return "This lesson was purged.";
    case "EDITOR_SATURATED":
      return "Too many unresolved saves in this session. Restart the session to continue.";
    case "INVALID_INPUT":
      return `Not saved: check ${fields.length ? fields.join(", ") : "the input"}.`;
    default:
      return `Request failed (${code}).`;
  }
}
