// One mounted curated-lessons pane: reads, writes, routes and snapshot
// persistence around the shared editor controller. Plain TypeScript with
// injected browser effects, so the pane and its tests run the same code.

import { LessonEditorController, type LessonEditorState, type LessonHostResult, type LessonIntent } from "@sil/core/lesson-curation-ui";
import { encodeLessonKey, type CaptureSource, type LessonKey, type LessonScope, type LessonView, type ProjectScope, type StoreBinding } from "@sil/core/lesson-curation";
import type { CuratedLessonDetail, ProjectChoice, ProjectDescriptor } from "@sil/core/curation-read";
import type { CurationRevision } from "@sil/core/lesson-curation";
import * as cl from "./curated-lessons.ts";

export type Filter = "saved" | "inbox" | "archived" | "important";
type Readback = { kind: "capture" | "edit" | "important" | "acknowledge-source" | "purge"; value?: boolean };
type ToastKind = "error" | "ok" | "info";
type ReadOutcome<T> = { ok: true; value: T } | { ok: false; stale: true } | { ok: false; stale: false; error: cl.CurationReadError };

export interface SessionDeps {
  world: string;
  fetch: typeof fetch;
  headers: () => Record<string, string>;
  origin: string;
  storage: () => Storage;
  /** The current URL fragment, including "#". */
  hash: () => string;
  /** Replace the fragment without a hashchange event. */
  replaceHash: (hash: string) => void;
  toast: (message: string, kind: ToastKind) => void;
  /** App-level navigation guarded by every registered pane. */
  requestLeave: (proceed: () => void) => void;
  setWorld: (world: string) => void;
  openReview: (pattern: string) => void;
  uuid: () => string;
  timeoutMs: number;
  /** Milliseconds since the epoch, for read freshness. */
  now: () => number;
}

export interface Extras {
  /** The detail request whose accepted response produced this presentation. */
  readSeq: number;
  generation: number;
  /** Revision of the accepted read; history pages stay valid while it is unchanged. */
  revision: number;
  key: LessonKey;
  provenance: CuratedLessonDetail["provenance"];
  diagnostics: CuratedLessonDetail["diagnostics"];
  history: CurationRevision[] | null;
  historyCursor: string | null;
  historyTotal: number | null;
  historyError: boolean;
}

/**
 * The pane may not browse the store it can see. `mismatch`: an identity this
 * pane holds belongs to another installation. `unknown-origin`: a bootstrap
 * request with no proven store, while a store now exists.
 */
export interface Block {
  reason: "mismatch" | "unknown-origin";
  expected: string | null;
  current: string | null;
}

export interface SessionView {
  editor: LessonEditorState;
  dirty: boolean;
  sending: boolean;
  canRetry: boolean;
  storageWorks: boolean;
  /** The store the server reports now. Not necessarily the one this pane browses. */
  store: cl.StoreState | null;
  locationId: string | null;
  handshakeError: string | null;
  block: Block | null;
  choices: ProjectChoice[];
  project: ProjectScope | null;
  filter: Filter;
  search: string;
  items: LessonView[];
  total: number;
  nextCursor: string | null;
  listLoading: boolean;
  listError: string | null;
  listReadAt: number | null;
  listStale: boolean;
  extras: Extras | null;
  detailError: string | null;
  detailReadAt: number | null;
  detailStale: boolean;
  confirmed: string | null;
  captureExists: boolean;
  purgeCheck: "pending" | "verified" | "unavailable" | null;
  leavePrompt: { quarantined: boolean } | null;
  foreignWorld: string | null;
  routeError: string | null;
}

export function sameKey(a: LessonKey, b: LessonKey): boolean {
  return a.world === b.world && a.kind === b.kind && a.id === b.id;
}
export function sameProject(a: ProjectScope, b: ProjectScope): boolean {
  return a.kind === b.kind && (a.kind !== "project" || a.id === (b as { id: string }).id);
}

const installationOfTarget = (t: { binding: StoreBinding; installationId?: string }): string | null =>
  t.binding.kind === "installation" ? t.binding.id : (t.installationId ?? null);

export class CuratedSession {
  readonly world: string;
  #deps: SessionDeps;
  /** This mount's identity for the shared snapshot key. */
  #owner: string;
  #alive = true;
  #epoch: string;
  #controller = new LessonEditorController();
  #listeners = new Set<() => void>();
  #listSeq = 0;
  #detailSeq = 0;
  #historySeq = 0;
  #receiptSeq = 0;
  #purgeSeq = 0;
  #handshakeSeq = 0;
  /** Invalidates every old read when its route, project, record or authority changes. */
  #contextSeq = 0;
  /** Installation offered by an explicit Browse-instead, pinned only if a fresh handshake confirms it. */
  #offered: string | null = null;
  /** Every route, project, open or close intent bumps this; older lookups compare and drop. */
  #intent = 0;
  #proceed: (() => void) | null = null;
  /** Installation this pane browses. null until the first handshake without constraint. */
  #pinned: string | null = null;
  /** A hydrated target closed before its first handshake still constrains recovery. */
  #pendingCloseExpected: string | null = null;
  #pendingCloseProject: ProjectScope | null = null;
  /** Choices of the store reported now, shown only while not blocked. */
  #currentChoices: ProjectChoice[] = [];
  view: SessionView;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
    this.world = deps.world;
    this.#owner = deps.uuid();
    this.#epoch = `web-${deps.uuid()}`;
    this.view = {
      editor: this.#controller.state,
      dirty: false,
      sending: false,
      canRetry: false,
      storageWorks: true,
      store: null,
      locationId: null,
      handshakeError: null,
      block: null,
      choices: [],
      project: null,
      filter: "saved",
      search: "",
      items: [],
      total: 0,
      nextCursor: null,
      listLoading: false,
      listError: null,
      listReadAt: null,
      listStale: false,
      extras: null,
      detailError: null,
      detailReadAt: null,
      detailStale: false,
      confirmed: null,
      captureExists: false,
      purgeCheck: null,
      leavePrompt: null,
      foreignWorld: null,
      routeError: null,
    };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Every visible change and every effect goes through the mount check. */
  #set(patch: Partial<SessionView>): void {
    if (!this.#alive) return;
    this.view = { ...this.view, ...patch };
    for (const listener of this.#listeners) listener();
  }

  #toast(message: string, kind: ToastKind): void {
    if (this.#alive) this.#deps.toast(message, kind);
  }

  #replaceHash(hash: string): void {
    if (this.#alive) this.#deps.replaceHash(hash);
  }

  get installationId(): string | null {
    return this.view.block === null ? this.#pinned : null;
  }

  /** Binding for browsing and new records. null while blocked. */
  get binding(): StoreBinding | null {
    if (this.view.block !== null) return null;
    if (this.#pinned !== null) return { kind: "installation", id: this.#pinned };
    return this.view.store?.state === "uninitialized" && this.view.locationId !== null
      ? { kind: "location", id: this.view.locationId } : null;
  }

  #readDeps(): cl.ReadDeps {
    return { fetch: this.#deps.fetch, headers: this.#deps.headers(), origin: this.#deps.origin };
  }

  /** Re-read the controller's projection and save its opaque snapshot, if this mount still owns it. */
  #sync(): void {
    if (!this.#alive) return;
    const c = this.#controller;
    const editor = c.state;
    const sending = c.sending;
    let canRetry = false;
    if (editor.pending !== null && !sending) {
      try {
        c.prepare(editor.pending.requestId);
        canRetry = true;
      } catch {
        canRetry = false;
      }
    }
    const write = cl.saveSnapshot(this.#deps.storage, this.world, this.#owner, c.snapshot());
    this.#set({ editor, dirty: c.dirty, sending, canRetry, storageWorks: write !== "failed" });
  }

  // --- the read boundary ----------------------------------------------------

  /** One gate for current success metadata and typed failures. Status is discovery only. */
  async #read<T>(op: string, args: Record<string, string>, decode: (value: unknown) => T, isCurrent: () => boolean): Promise<ReadOutcome<T>> {
    const epoch = this.#epoch;
    const controller = this.#controller;
    const context = this.#contextSeq;
    const current = () => this.#alive && epoch === this.#epoch && controller === this.#controller && context === this.#contextSeq && isCurrent();
    try {
      const value = await cl.curationRead(op, args, decode, this.#readDeps());
      if (!current()) return { ok: false, stale: true };
      const binding = args["binding"];
      if (binding !== undefined) {
        const result = value as { store?: cl.ReadStore };
        const store = result?.store;
        if (store === undefined) throw new cl.CurationReadError("MALFORMED", null);
        const expected = binding.slice(binding.indexOf(":") + 1);
        const matches = binding.startsWith("installation:")
          ? store.installationId === expected
          : binding.startsWith("location:") && store.locationId === expected;
        if (!matches) throw new cl.CurationReadError("INSTALLATION_MISMATCH", null);
        if (binding.startsWith("location:") && op !== "lessons.projects" && op !== "lessons.receipt" &&
            this.#pinned === null && store.installationId !== null) {
          throw new cl.CurationReadError("STORE_CHANGED", null);
        }
      }
      return { ok: true, value };
    } catch (e) {
      if (!current()) return { ok: false, stale: true };
      const error = e instanceof cl.CurationReadError ? e : new cl.CurationReadError("TRANSPORT", null);
      if (error.code === "INSTALLATION_MISMATCH") this.#revokeForIdentity();
      return { ok: false, stale: false, error };
    }
  }

  /** Historical mutation bindings are never reused as read pins after origin is known. */
  #recordReadBinding(target: { binding: StoreBinding; installationId?: string }): StoreBinding {
    const proven = installationOfTarget(target) ?? this.#controller.state.expectedInstallation;
    return proven === null ? target.binding : { kind: "installation", id: proven };
  }

  /** The server refused a read for the installation this pane holds. Which store answers now is unknown. */
  #revokeForIdentity(): void {
    this.#revoke();
    this.#set({ store: null });
    this.#applyBlock({ reason: "mismatch", expected: this.#pinned ?? this.#controller.state.expectedInstallation ?? this.#pendingCloseExpected, current: null });
  }

  // --- store identity -------------------------------------------------------

  /** Drop the controller's store observation. Keeps draft, expected identity and request ids. */
  #revoke(): void {
    this.#contextSeq++;
    this.#epoch = `web-${this.#deps.uuid()}`;
    this.#controller.connect(this.#epoch);
    this.#sync();
  }

  /** What this pane may browse given what it holds and what the server reports now. */
  #blockFor(current: string | null): Block | null {
    const editor = this.#controller.state;
    const expected = editor.target !== null ? editor.expectedInstallation : this.#pendingCloseExpected;
    if (expected !== null && current !== expected) return { reason: "mismatch", expected, current };
    const pending = editor.pending;
    if (expected === null && pending !== null && installationOfTarget(pending) === null && current !== null) {
      return { reason: "unknown-origin", expected: null, current };
    }
    if (expected === null && this.#pinned !== null && current !== this.#pinned) return { reason: "mismatch", expected: this.#pinned, current };
    return null;
  }

  #applyBlock(block: Block | null): void {
    if (block === null) {
      this.#set({ block: null, choices: this.#currentChoices });
      return;
    }
    this.#set({ block, choices: [], items: [], total: 0, nextCursor: null, extras: null, listReadAt: null, listStale: false, detailReadAt: null, detailStale: false });
  }

  async handshake(): Promise<boolean> {
    const seq = ++this.#handshakeSeq;
    const context = this.#contextSeq;
    const latest = () => seq === this.#handshakeSeq && context === this.#contextSeq;
    const offered = this.#offered;
    this.#offered = null;
    this.#set({ handshakeError: null });
    const statusRead = await this.#read("lessons.store", {}, cl.decodeStoreStatus, latest);
    if (!statusRead.ok) {
      if (!statusRead.stale) this.#set({ handshakeError: readMessage(statusRead.error) });
      return false;
    }
    const status = statusRead.value;
    if (status.state === "error") {
      this.#set({ handshakeError: `Curation storage is unavailable (${status.code}).` });
      return false;
    }
    const flat = status.state === "ready" ? `installation:${status.installationId}` : `location:${status.locationId}`;
    const projects = await this.#read("lessons.projects", { world: this.world, binding: flat }, (v) => cl.decodeReadResult(v, cl.decodeProjects), latest);
    if (!projects.ok) {
      if (!projects.stale) this.#set({ handshakeError: readMessage(projects.error) });
      return false;
    }
    const result = projects.value;
    {
      // Identity comes from the read handle, not from the earlier status look.
      if (status.state === "ready" && result.store.installationId !== status.installationId) {
        this.#set({ handshakeError: "The store changed while loading. Refresh to try again." });
        return false;
      }
      if (!result.value.every((choice) => choice.scope.world === this.world)) {
        this.#set({ handshakeError: "The store sent projects for another world." });
        return false;
      }
      const current = result.store.installationId;
      const beforePin = this.#pinned;
      const beforeStore = this.view.store;
      const beforeLocation = this.view.locationId;
      const beforeBlock = this.view.block;
      const beforeGate = this.#controller.state.gate;
      const beforeGeneration = this.#controller.state.generation;
      const expected = this.#controller.state.target !== null ? this.#controller.state.expectedInstallation : this.#pendingCloseExpected;
      const acceptingOffer = offered !== null && this.#controller.state.target === null && current === offered;
      if (acceptingOffer) this.#pinned = offered;
      const block = this.#blockFor(current);
      if (block === null) {
        if (this.#pinned === null) this.#pinned = expected ?? current;
        else if (expected !== null && expected !== this.#pinned && current === expected) this.#pinned = expected;
      }
      this.#currentChoices = result.value;
      this.#set({
        store: current === null ? { state: "uninitialized", locationId: result.store.locationId } : { state: "ready", installationId: current },
        locationId: result.store.locationId,
      });
      // A blocked pane gives up its old observation before it sees the new store.
      const contextBeforeCommit = this.#contextSeq;
      if (block !== null) this.#revoke();
      this.#controller.observe({ connectionEpoch: this.#epoch, binding: { kind: "location", id: result.store.locationId }, installationId: current, pinnedLocationRetry: true });
      this.#applyBlock(block);
      const statusChanged = current === null
        ? beforeStore?.state !== "uninitialized" || beforeStore.locationId !== result.store.locationId
        : beforeStore?.state !== "ready" || beforeStore.installationId !== current;
      const blockChanged = beforeBlock?.reason !== block?.reason || beforeBlock?.expected !== block?.expected || beforeBlock?.current !== block?.current;
      const authorityChanged = beforeGate !== this.#controller.state.gate || beforeGeneration !== this.#controller.state.generation;
      if ((statusChanged || beforeLocation !== result.store.locationId || beforePin !== this.#pinned || blockChanged || authorityChanged) &&
          this.#contextSeq === contextBeforeCommit) this.#contextSeq++;
      this.#sync();
      if (block === null) {
        const resumeProject = this.#pendingCloseProject;
        this.#pendingCloseExpected = null;
        this.#pendingCloseProject = null;
        if (resumeProject !== null && this.view.project === null && this.view.choices.some((choice) => sameProject(choice.scope.project, resumeProject))) {
          this.chooseProject(resumeProject);
        }
      }
      return true;
    }
  }

  /**
   * Leave the held identity and browse the store the server reports now. Pending
   * and earlier request ids stay in the snapshot for later checks.
   */
  browseCurrentInstead(): void {
    const offered = this.view.block?.current ?? null;
    if (offered === null) return;
    this.requestEditorChange(() => {
      if (!this.#closeTarget()) {
        this.#set({ routeError: "The earlier lesson could not be set aside: this tab holds too many unchecked saves. Nothing was changed." });
        return;
      }
      this.#intent++;
      this.#contextSeq++;
      this.#pendingCloseExpected = null;
      this.#pendingCloseProject = null;
      this.#replaceHash("#/artifacts");
      this.#set({ project: null, items: [], total: 0, nextCursor: null, listReadAt: null, listStale: false, routeError: null });
      // Stays blocked unless a fresh handshake shows exactly the offered store.
      this.#offered = offered;
      void this.handshake().then((ok) => {
        if (!ok || this.view.block !== null || this.#pinned !== offered) return;
        const preferred = cl.loadProjectPreference(this.#deps.storage, this.world, offered);
        if (preferred !== null && this.view.choices.some((c) => sameProject(c.scope.project, preferred))) this.chooseProject(preferred);
      });
    });
  }

  // --- projects and list ----------------------------------------------------

  chooseProject(scope: ProjectScope | null): void {
    const target = this.#controller.state.target;
    if (target !== null && (scope === null || !sameProject(target.scope.project, scope))) {
      if (!this.#closeTarget()) return this.#capacityRefused();
    }
    this.#intent++;
    this.#contextSeq++;
    this.#set({ project: scope, items: [], total: 0, nextCursor: null, listReadAt: null, listStale: false, listError: null });
    const installationId = this.installationId;
    if (scope !== null && installationId !== null && this.#alive) {
      this.#set({ storageWorks: cl.saveProjectPreference(this.#deps.storage, this.world, installationId, scope) && this.view.storageWorks });
    }
    void this.reloadList();
  }

  /** The picker changed. A dirty editor decides first; the old record never stays open under the new scope. */
  selectProject(value: string): void {
    const scope = value === "" ? null : cl.parseFlatProject(value);
    const current = this.view.project;
    if (scope !== null && current !== null && sameProject(scope, current)) return;
    if (scope === null && current === null) return;
    this.requestEditorChange(() => {
      if (!this.#closeTarget()) return this.#capacityRefused();
      if (cl.parseLessonRoute(this.#deps.hash()).kind !== "none") this.#replaceHash("#/artifacts");
      this.chooseProject(scope);
    });
  }

  async reloadList(append = false): Promise<void> {
    const project = this.view.project;
    const binding = this.binding;
    if (project === null || binding === null) return;
    const seq = ++this.#listSeq;
    this.#set({ listLoading: true });
    const filter = this.view.filter;
    const query = cl.browseQuery({
      world: this.world,
      project,
      binding,
      collection: filter === "important" ? "all" : filter,
      ...(filter === "important" ? { important: true } : {}),
      search: this.view.search.trim(),
      ...(append && this.view.nextCursor !== null ? { cursor: this.view.nextCursor } : {}),
    });
    const read = await this.#read("lessons.browse", query, (v) => cl.decodeReadResult(v, cl.decodeBrowsePage), () => seq === this.#listSeq);
    if (seq === this.#listSeq) this.#set({ listLoading: false });
    if (!read.ok) {
      if (!read.stale) this.#set({ listError: readMessage(read.error), listStale: this.view.block === null && this.view.listReadAt !== null });
      return;
    }
    const result = read.value;
    if (this.view.block !== null || result.store.installationId !== this.#pinned) return;
    if (!result.value.items.every((item) => item.key.world === this.world && item.scope.world === this.world && sameProject(item.scope.project, project))) {
      this.#set({ listError: "The store sent lessons for another project.", listStale: this.view.listReadAt !== null });
      return;
    }
    this.#set({
      items: append ? [...this.view.items, ...result.value.items] : result.value.items,
      total: result.value.total,
      nextCursor: result.value.nextCursor,
      listError: null,
      listReadAt: this.#deps.now(),
      listStale: false,
    });
  }

  setFilter(filter: Filter): void {
    this.#set({ filter, nextCursor: null });
    void this.reloadList();
  }

  setSearch(search: string): void {
    if (search === this.view.search) return;
    this.#listSeq++;
    this.#set({ search, listLoading: false });
  }

  /** A record's own scope, labelled from the choices, never the current picker selection. */
  scopeLabel(scope: LessonScope): string {
    const choice = this.view.choices.find((c) => c.scope.world === scope.world && sameProject(c.scope.project, scope.project));
    return choice?.label ?? cl.flatProject(scope.project);
  }

  // --- detail -----------------------------------------------------------------

  async loadDetail(): Promise<LessonView | null> {
    if (this.view.block !== null) return null;
    const c = this.#controller;
    const state = c.state;
    const target = state.target;
    if (target === null || state.phase === "purged") return null;
    const generation = state.generation;
    const epoch = this.#epoch;
    const seq = ++this.#detailSeq;
    this.#historySeq++;
    const args = { key: encodeLessonKey(target.key), project: cl.flatProject(target.scope.project), binding: cl.flatBinding(this.#recordReadBinding(target)) };
    const read = await this.#read("lessons.get", args, (v) => cl.decodeReadResult(v, (x) => (x === null ? null : cl.decodeLessonDetail(x))), () => seq === this.#detailSeq);
    if (!read.ok) {
      if (!read.stale && c.state.generation === generation) this.#set({ detailError: readMessage(read.error), detailStale: this.view.detailReadAt !== null });
      return null;
    }
    const detail = read.value;
    const result: LessonHostResult = { operation: "read", connectionEpoch: epoch, generation, target, installationId: detail.store.installationId };
    if (detail.value === null) {
      c.dispatch({ type: "detail-missing", generation, target }, result);
      this.#sync();
      return null;
    }
    c.dispatch({ type: "loaded", generation, target, view: detail.value.lesson }, result);
    this.#sync();
    // Present only what the controller actually accepted from this response.
    const accepted = c.state.generation === generation && c.state.loaded !== null && JSON.stringify(c.state.loaded) === JSON.stringify(detail.value.lesson);
    if (!accepted) return null;
    // Same record at the same revision: history has not changed, keep the pages already loaded.
    const prior = this.view.extras;
    const keep = prior !== null && sameKey(prior.key, detail.value.lesson.key) && prior.revision === detail.value.lesson.revision && prior.history !== null && !prior.historyError;
    this.#set({
      detailError: null,
      detailReadAt: this.#deps.now(),
      detailStale: false,
      extras: {
        readSeq: seq,
        generation,
        revision: detail.value.lesson.revision,
        key: detail.value.lesson.key,
        provenance: detail.value.provenance,
        diagnostics: detail.value.diagnostics,
        history: keep ? prior.history : null,
        historyCursor: keep ? prior.historyCursor : null,
        historyTotal: keep ? prior.historyTotal : null,
        historyError: false,
      },
    });
    if (!keep) void this.#loadHistory(seq, target.key, args, null);
    return c.state.loaded;
  }

  async #loadHistory(readSeq: number, key: LessonKey, args: Record<string, string>, cursor: string | null): Promise<void> {
    const seq = ++this.#historySeq;
    const sameRead = () => {
      const extras = this.view.extras;
      return seq === this.#historySeq && extras !== null && extras.readSeq === readSeq && sameKey(extras.key, key) && (cursor === null || extras.historyCursor === cursor);
    };
    const read = await this.#read("lessons.history", { ...args, limit: "20", ...(cursor === null ? {} : { cursor }) }, (v) => cl.decodeReadResult(v, cl.decodeHistory), sameRead);
    const extras = this.view.extras;
    if (extras === null || !sameRead()) return;
    if (!read.ok) {
      if (!read.stale) this.#set({ extras: { ...extras, historyError: true } });
      return;
    }
    const page = read.value.value;
    const history = cursor === null ? page.items : [...(extras.history ?? []), ...page.items];
    this.#set({ extras: { ...extras, history, historyCursor: page.nextCursor, historyTotal: page.total, historyError: false } });
  }

  /** The next older history page of the record shown now. */
  async loadMoreHistory(): Promise<void> {
    const extras = this.view.extras;
    const target = this.#controller.state.target;
    if (extras === null || extras.historyCursor === null || target === null || !sameKey(target.key, extras.key)) return;
    const args = { key: encodeLessonKey(target.key), project: cl.flatProject(target.scope.project), binding: cl.flatBinding(this.#recordReadBinding(target)) };
    await this.#loadHistory(extras.readSeq, extras.key, args, extras.historyCursor);
  }

  // --- navigation and the leave guard ---------------------------------------

  needsPrompt(): boolean {
    return this.#controller.dirty || (this.view.editor.gate === "mismatch" && this.view.editor.pending !== null);
  }

  /** Runs `change` now, or after the person chooses Discard. */
  requestEditorChange(change: () => void): void {
    if (!this.needsPrompt()) {
      change();
      return;
    }
    this.#proceed = change;
    this.#set({ leavePrompt: { quarantined: this.view.editor.gate === "mismatch" } });
  }

  /** App uses the same parking veto as internal navigation, even for a clean editor. */
  guardLeave(proceed: () => void): boolean {
    if (!this.needsPrompt()) {
      if (!this.#closeTarget()) {
        this.#capacityRefused();
        return false;
      }
      return true;
    }
    this.#proceed = proceed;
    this.#set({ leavePrompt: { quarantined: this.view.editor.gate === "mismatch" } });
    return false;
  }

  stay(): void {
    this.#proceed = null;
    this.#set({ leavePrompt: null });
    this.#controller.dispatch({ type: "stay" });
    this.#sync();
  }

  discardAndGo(): void {
    const prompt = this.view.leavePrompt;
    const proceed = this.#proceed;
    this.#proceed = null;
    this.#set({ leavePrompt: null });
    if (prompt === null || proceed === null) return;
    if (!this.#closeTarget(true)) return this.#capacityRefused();
    const handshakeSeq = this.#handshakeSeq;
    proceed();
    // Browse-instead already started its offered-store handshake.
    if (prompt.quarantined && handshakeSeq === this.#handshakeSeq) void this.handshake();
  }

  /** Consent permits dropping wording, not losing a pending ID at capacity. */
  #closeTarget(discard = false): boolean {
    const prior = this.#controller.state;
    if (prior.target === null) return true;
    const awaitingFirstStore = this.view.store === null && this.#handshakeSeq > 0;
    const heldExpected = prior.expectedInstallation ?? installationOfTarget(prior.target);
    const wasPurged = prior.phase === "purged";
    if (prior.gate === "mismatch") {
      if (!discard && this.#controller.dirty) return false;
      const candidate = new LessonEditorController();
      const epoch = `web-${this.#deps.uuid()}`;
      candidate.connect(epoch);
      candidate.dispatch({ type: "hydrate", snapshot: this.#controller.snapshot() });
      if (candidate.state.error?.fields.includes("snapshot")) return false;
      candidate.dispatch({ type: "close" });
      if (candidate.state.target !== null) return false;
      this.#controller = candidate;
      this.#epoch = epoch;
    } else {
      this.#controller.dispatch({ type: "close" });
      // The projected state hides blocked navigation while unverified.
      if (discard && this.#controller.state.target !== null) this.#controller.dispatch({ type: "discard" });
    }
    const closed = this.#controller.state.target === null;
    if (closed) {
      this.#contextSeq++;
      this.#clearRecordView();
      if (awaitingFirstStore) {
        this.#pendingCloseExpected = heldExpected;
        if (this.view.project === null && prior.target.scope.world === this.world) this.#pendingCloseProject = { ...prior.target.scope.project };
      }
    }
    this.#sync();
    if (closed && awaitingFirstStore) void this.handshake();
    if (closed && wasPurged && this.view.project !== null && this.view.block === null) void this.reloadList();
    return closed;
  }

  /** The controller refused to set the open record aside. Keep it, and its URL, and say why. */
  #capacityRefused(): void {
    const target = this.#controller.state.target;
    const origin = target === null ? null : (installationOfTarget(target) ?? this.#controller.state.expectedInstallation);
    if (target !== null && origin !== null) this.#replaceHash(cl.lessonRouteHash(origin, target.key));
    this.#set({ routeError: "The open lesson could not be set aside: this tab holds too many unchecked saves. Reload the page to continue." });
  }

  #clearRecordView(): void {
    this.#set({ extras: null, confirmed: null, captureExists: false, purgeCheck: null, detailError: null, detailReadAt: null, detailStale: false });
  }

  openLesson(view: { key: LessonKey; scope: LessonScope }): void {
    this.requestEditorChange(() => this.#open(view.key, view.scope));
  }

  #open(key: LessonKey, scope: LessonScope): void {
    const binding = this.binding;
    if (binding === null) return;
    this.#intent++;
    this.#controller.dispatch({ type: "open-lesson", scope, binding, key });
    const opened = this.#controller.state.target;
    if (opened === null || !sameKey(opened.key, key)) {
      this.#sync();
      return this.#capacityRefused();
    }
    this.#contextSeq++;
    this.#clearRecordView();
    this.#sync();
    const installationId = this.installationId;
    if (installationId !== null) this.#replaceHash(cl.lessonRouteHash(installationId, key));
    void this.loadDetail();
  }

  startCapture(): void {
    this.requestEditorChange(() => {
      const binding = this.binding;
      const project = this.view.project;
      if (binding === null || project === null) return;
      const source: CaptureSource = {
        kind: "explicit_quote",
        quote: null,
        reference: null,
        quoteRedacted: false,
        captureSessionId: null,
        sourceConversationId: null,
        sourceRowId: null,
        sourceAgentId: null,
      };
      this.#intent++;
      this.#controller.dispatch({ type: "open-capture", scope: { world: this.world, project }, binding, recordId: this.#deps.uuid(), source });
      if (this.#controller.state.mode !== "capture") {
        this.#sync();
        return this.#capacityRefused();
      }
      this.#contextSeq++;
      this.#clearRecordView();
      this.#sync();
    });
  }

  closeEditor(): void {
    this.requestEditorChange(() => {
      this.#intent++;
      if (!this.#closeTarget()) return this.#capacityRefused();
      this.#replaceHash("#/artifacts");
    });
  }

  /** CAPTURE_EXISTS: open the stored record with this key instead. The draft goes only after Discard. */
  openExisting(): void {
    const target = this.#controller.state.target;
    if (target === null || !this.view.captureExists) return;
    const key = { ...target.key };
    const scope = { world: target.scope.world, project: { ...target.scope.project } } as LessonScope;
    this.requestEditorChange(() => this.#open(key, scope));
  }

  // --- exact-record routes ----------------------------------------------------

  async openRoute(route: Extract<cl.LessonRoute, { kind: "record" }>): Promise<void> {
    const intent = ++this.#intent;
    this.#contextSeq++;
    this.#set({ routeError: null, foreignWorld: null });
    // A route can arrive while the first mount handshake is still in flight.
    if (this.#pinned === null && this.view.store === null && this.view.block === null) {
      if (!(await this.handshake()) || intent !== this.#intent || !this.#alive) return;
    }
    const refuse = (patch: Partial<SessionView>) => {
      // The previous record never stays under a link it does not match.
      if (this.#controller.state.target !== null && !this.#controller.dirty && !this.#closeTarget()) return this.#capacityRefused();
      this.#set(patch);
    };
    if (route.key.world !== this.world) return refuse({ foreignWorld: route.key.world });
    if (this.view.block !== null) return refuse({ routeError: "This lesson link cannot be opened until the installation question above is settled." });
    if (this.installationId !== route.installationId) {
      return refuse({ routeError: "Different SIL installation. This link was made for another installation, so nothing is looked up here." });
    }
    const read = await this.#read(
      "lessons.locate",
      { key: encodeLessonKey(route.key), binding: `installation:${route.installationId}` },
      (v) => cl.decodeLocatedResult(v, route.installationId, route.key),
      () => intent === this.#intent,
    );
    if (!read.ok) {
      if (!read.stale) refuse({ routeError: readMessage(read.error) });
      return;
    }
    const scope = read.value.value;
    if (scope === null) return refuse({ routeError: "No lesson with this ID in this installation." });
    const project = this.view.project;
    if (project === null || !sameProject(project, scope.project)) this.chooseProject(scope.project);
    this.#open(route.key, scope);
  }

  /** The record shown now is exactly this installation and key. Origins are never guessed. */
  #showsRoute(route: Extract<cl.LessonRoute, { kind: "record" }>): boolean {
    const target = this.view.editor.target;
    if (target === null || !sameKey(target.key, route.key)) return false;
    const origin = installationOfTarget(target) ?? this.view.editor.expectedInstallation;
    return origin !== null && origin === route.installationId && this.#pinned === route.installationId && this.view.block === null;
  }

  /** The fragment changed inside this pane. `oldHash` is the fragment before it. */
  onRouteChange(oldHash: string): void {
    this.#intent++;
    const route = cl.parseLessonRoute(this.#deps.hash());
    const current = this.view.editor.target;
    if (route.kind === "record" && this.#showsRoute(route)) return;
    if (route.kind === "none" && current === null) return;
    const apply = () => {
      if (route.kind === "record") void this.openRoute(route);
      else if (!this.#closeTarget()) this.#capacityRefused();
      else if (route.kind === "invalid") this.#set({ routeError: "This lesson link is not valid.", foreignWorld: null });
    };
    if (this.needsPrompt()) {
      // Show the old URL until the person decides.
      const target = this.#deps.hash();
      this.#replaceHash(oldHash);
      this.requestEditorChange(() => {
        this.#replaceHash(target);
        apply();
      });
      return;
    }
    apply();
  }

  switchWorld(): void {
    const next = this.view.foreignWorld;
    if (next === null) return;
    this.#deps.requestLeave(() => this.#deps.setWorld(next));
  }

  openReview(pattern: string): void {
    this.#deps.requestLeave(() => this.#deps.openReview(pattern));
  }

  // --- writes ---------------------------------------------------------------

  #projectDescriptor(): ProjectDescriptor | null {
    const state = this.#controller.state;
    const target = state.target;
    if (target === null || target.scope.project.kind !== "project" || state.mode !== "capture") return null;
    const project = target.scope.project;
    const choice = this.view.choices.find((c) => sameProject(c.scope.project, project));
    if (!choice || choice.root === null) return null;
    return { world: this.world, projectId: project.id, root: choice.root };
  }

  async submit(intent: LessonIntent): Promise<void> {
    if (this.view.block !== null) return;
    const requestId = cl.newRequestId();
    const mode = this.#controller.state.mode;
    this.#controller.dispatch({ type: "submit", requestId, intent });
    this.#sync();
    if (this.#controller.state.pending?.requestId !== requestId) return;
    const kind: Readback["kind"] = intent.kind === "save" ? (mode === "capture" ? "capture" : "edit") : intent.kind;
    await this.#send(requestId, intent.kind === "important" ? { kind, value: intent.value } : { kind });
  }

  async #send(requestId: string, readback: Readback | null): Promise<void> {
    const c = this.#controller;
    let attempt;
    try {
      attempt = c.beginAttempt(requestId);
    } catch {
      this.#sync();
      return;
    }
    this.#set({ confirmed: null, captureExists: false, purgeCheck: null });
    this.#sync();
    const out = await cl.sendCurationMutation(attempt.prepared, this.#projectDescriptor(), { fetch: this.#deps.fetch, headers: this.#deps.headers(), timeoutMs: this.#deps.timeoutMs });
    c.finishAttempt(attempt.token, out.completion);
    // An unmounted or replaced pane drops the completion; its id reconciles later.
    if (!this.#alive || c !== this.#controller) return;
    this.#sync();
    await this.#afterOutcome(out, readback);
  }

  async #afterOutcome(out: cl.MutationCompletion, readback: Readback | null): Promise<void> {
    const state = this.#controller.state;
    if (state.phase === "purged") {
      await this.#verifyPurged(readback?.kind === "purge");
      return;
    }
    if (state.phase === "conflict") {
      if (state.mode === "capture" && state.error?.code === "CAPTURE_EXISTS") {
        this.#set({ captureExists: true });
        return;
      }
      // The revision in the refusal is a hint: read the record itself.
      await this.loadDetail();
      return;
    }
    if (out.completion.kind !== "success" || state.pending !== null || out.completion.receipt.state !== "completed") return;
    const committed = out.completion.receipt.result;
    if (this.view.store?.state !== "ready") await this.handshake();
    await this.#confirmReadback(committed.key, committed.revision, readback);
  }

  /** Success for a purge is a fresh tombstone read of the same record, never the receipt alone. */
  async #verifyPurged(ownPurge: boolean): Promise<void> {
    const controller = this.#controller;
    const state = controller.state;
    const target = state.target;
    if (target === null) return;
    const intent = this.#intent;
    const seq = ++this.#purgeSeq;
    this.#set({ extras: null, purgeCheck: "pending" });
    const args = { key: encodeLessonKey(target.key), project: cl.flatProject(target.scope.project), binding: cl.flatBinding(this.#recordReadBinding(target)) };
    const read = await this.#read("lessons.get", args, (v) => cl.decodeReadResult(v, (x) => (x === null ? null : cl.decodeLessonDetail(x))), () => intent === this.#intent && seq === this.#purgeSeq);
    if (!read.ok && read.stale) {
      const now = this.#controller.state;
      if (this.#alive && controller === this.#controller && intent === this.#intent && seq === this.#purgeSeq &&
          this.view.purgeCheck === "pending" && now.phase === "purged" && now.target !== null &&
          sameKey(now.target.key, target.key) && sameProject(now.target.scope.project, target.scope.project) &&
          now.expectedInstallation === state.expectedInstallation) this.#set({ purgeCheck: "unavailable" });
      return;
    }
    const expected = state.expectedInstallation;
    const detail = read.ok ? read.value : null;
    const verified =
      detail !== null &&
      detail.value !== null &&
      detail.value.lesson.sourceStatus === "purged" &&
      sameKey(detail.value.lesson.key, target.key) &&
      (expected === null || detail.store.installationId === expected);
    this.#set({ purgeCheck: verified ? "verified" : "unavailable" });
    if (verified) {
      const items = this.view.items.filter((item) => !sameKey(item.key, target.key));
      if (items.length !== this.view.items.length) {
        this.#set({ items, total: Math.max(0, this.view.total - (this.view.items.length - items.length)), nextCursor: null,
          listReadAt: null, listStale: false });
      }
    }
    if (verified && ownPurge) this.#toast("Purged locally. Its curated wording, quotes and history are gone from this installation.", "ok");
    void this.reloadList();
  }

  async #confirmReadback(key: LessonKey, revision: number, readback: Readback | null): Promise<void> {
    const view = await this.loadDetail();
    if (view === null || !cl.readbackConfirms(revision, key, view)) {
      this.#set({ confirmed: null });
      return;
    }
    const message =
      readback?.kind === "capture"
        ? "Saved locally. Not installed or queued for learning."
        : readback?.kind === "important"
          ? readback.value
            ? "Marked important."
            : "No longer marked important."
          : readback?.kind === "acknowledge-source"
            ? "Current source accepted."
            : "Saved.";
    this.#set({ confirmed: message });
    this.#toast(message, "ok");
    const installationId = this.installationId;
    if (installationId !== null) this.#replaceHash(cl.lessonRouteHash(installationId, key));
    void this.reloadList();
  }

  async checkOutcome(): Promise<void> {
    const c = this.#controller;
    const pending = c.state.pending;
    if (pending === null) return;
    const target = { scope: pending.scope, binding: pending.binding, key: pending.key };
    const epoch = this.#epoch;
    const seq = ++this.#receiptSeq;
    const origin = installationOfTarget(pending);
    const readBinding: StoreBinding = origin === null ? pending.binding : { kind: "installation", id: origin };
    const read = await this.#read(
      "lessons.receipt",
      { key: encodeLessonKey(pending.key), project: cl.flatProject(pending.scope.project), binding: cl.flatBinding(readBinding), requestId: pending.requestId },
      (v) => cl.decodeReadResult(v, (x) => cl.decodeReceiptRead(x, pending.requestId)),
      () => seq === this.#receiptSeq && c.state.pending?.requestId === pending.requestId,
    );
    if (!read.ok) {
      // A failed read says nothing about whether the save committed.
      if (!read.stale) this.#toast(`Could not check the earlier save: ${readMessage(read.error)} Its outcome is still unknown.`, "error");
      return;
    }
    const r = read.value;
    {
      c.dispatch(
        { type: "receipt", generation: pending.generation, requestId: pending.requestId, target, receipt: r.value },
        { operation: "receipt", connectionEpoch: epoch, generation: pending.generation, target, requestId: pending.requestId, installationId: r.store.installationId },
      );
      this.#sync();
      if (r.value.state === "unknown") {
        this.#toast("No result recorded for this request yet. It may still be running.", "info");
        return;
      }
      if (c.state.pending === null || this.view.block !== null) await this.handshake();
      if (r.value.state === "committed" && c.state.pending === null) await this.#confirmReadback(r.value.key, r.value.revision, null);
      if (r.value.state === "purged") await this.#verifyPurged(false);
    }
  }

  async retry(): Promise<void> {
    const pending = this.#controller.state.pending;
    if (pending !== null) await this.#send(pending.requestId, null);
  }

  editText(text: string): void {
    this.#controller.dispatch({ type: "edit-text", text });
    this.#sync();
  }

  editSource(patch: Partial<CaptureSource>): void {
    const current = this.view.editor.draft?.source;
    if (!current) return;
    this.#controller.dispatch({ type: "edit-source", source: { ...current, ...patch } });
    this.#sync();
  }

  cancelEdit(): void {
    const editor = this.view.editor;
    if (editor.mode === "capture" && editor.pending === null) {
      this.requestEditorChange(() => {
        if (!this.#closeTarget()) this.#capacityRefused();
      });
      return;
    }
    this.#controller.dispatch({ type: "discard" });
    this.#sync();
  }

  rebase(): void {
    this.#controller.dispatch({ type: "rebase" });
    this.#sync();
  }

  /** Fresh store observation first, then list and detail, so a restored store can recover a held draft. */
  async refresh(): Promise<void> {
    if (this.view.sending || this.view.leavePrompt !== null) return;
    if (!(await this.handshake())) return;
    await this.reloadList();
    const state = this.#controller.state;
    if (state.target !== null && state.phase === "purged" && this.view.block === null && this.view.purgeCheck === "unavailable") {
      await this.#verifyPurged(false);
    } else if (state.target !== null && state.phase !== "purged" && (state.mode === "existing" || state.pending !== null)) {
      await this.loadDetail();
    }
  }

  /** True while unsent wording exists, even if the projection hides it. */
  get dirty(): boolean {
    return this.#controller.dirty;
  }

  // --- lifecycle -------------------------------------------------------------

  async mount(): Promise<void> {
    this.#controller.connect(this.#epoch);
    const saved = cl.loadSnapshot(this.#deps.storage, this.world);
    if (saved !== null) {
      this.#controller.dispatch({ type: "hydrate", snapshot: saved });
      if (this.#controller.state.error?.fields.includes("snapshot")) cl.clearSnapshot(this.#deps.storage, this.world);
    }
    // This mount now owns the key; an older pane's late writes are refused.
    cl.claimSnapshot(this.#deps.storage, this.world, this.#owner, this.#controller.snapshot());
    this.#sync();
    if (!(await this.handshake())) return;
    const hydrated = this.#controller.state.target;
    const route = cl.parseLessonRoute(this.#deps.hash());
    if (route.kind === "record" && !(hydrated !== null && sameKey(hydrated.key, route.key) && installationOfTarget(hydrated) === route.installationId)) {
      // An explicit link wins. A hydrated record moves aside with its ids kept.
      await this.openRoute(route);
      return;
    }
    if (route.kind === "invalid") {
      if (!this.#closeTarget()) return this.#capacityRefused();
      this.#set({ routeError: "This lesson link is not valid." });
      return;
    }
    if (hydrated !== null && hydrated.scope.world === this.world) {
      this.chooseProject(hydrated.scope.project);
      if (this.#controller.state.mode === "existing" || this.#controller.state.pending !== null) await this.loadDetail();
      return;
    }
    const installationId = this.installationId;
    if (installationId !== null) {
      const preferred = cl.loadProjectPreference(this.#deps.storage, this.world, installationId);
      if (preferred !== null && this.view.choices.some((c) => sameProject(c.scope.project, preferred))) this.chooseProject(preferred);
    }
  }

  dispose(): void {
    // Final write only if this mount still owns the key.
    cl.saveSnapshot(this.#deps.storage, this.world, this.#owner, this.#controller.snapshot());
    this.#alive = false;
    this.#contextSeq++;
    this.#listeners.clear();
  }
}

/** Wording for a failed read. A read failure never says anything about a save's outcome. */
export function readMessage(e: unknown): string {
  if (!(e instanceof cl.CurationReadError)) return "Something went wrong reading lessons.";
  switch (e.code) {
    case "TRANSPORT":
      return "The web server did not answer.";
    case "MALFORMED":
      return "The server sent a response this page cannot read.";
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

export function errorText(code: string, fields: string[] = []): string {
  switch (code) {
    case "INSTALLATION_MISMATCH":
      return "Different SIL installation. Nothing from it is shown or saved here.";
    case "STORE_UNRESOLVED":
      return "Cannot confirm which store holds this lesson, so nothing is shown.";
    case "CURATION_CONFLICT":
      return "This lesson changed elsewhere. Your wording is kept.";
    case "CAPTURE_EXISTS":
      return "A lesson with this ID is already stored. Your wording is kept.";
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
      return "Too many unresolved saves in this tab. Reload the page to continue.";
    case "INVALID_INPUT":
      return `Not saved: check ${fields.length ? fields.join(", ") : "the input"}.`;
    default:
      return `Request failed (${code}).`;
  }
}
