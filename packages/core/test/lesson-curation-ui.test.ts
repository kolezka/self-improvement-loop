import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CurationError, type CaptureSource, type LessonKey, type LessonScope, type LessonView, type StoreBinding } from "../src/lesson-curation.ts";
import {
  initialLessonEditor,
  isLessonEditorDirty,
  isLessonEditorStale,
  prepareLessonMutation as prepareWithAuthority,
  reduceLessonEditor as reduceWithAuthority,
  LessonEditorController,
  projectLessonEditor,
  type LessonEditorAuthority,
  type LessonHostObservation,
  type LessonHostResult,
  snapshotLessonEditor,
  type LessonEditorEvent,
  type LessonEditorTarget,
  type LessonEditorState,
} from "../src/lesson-curation-ui.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const PROJECT_ID = `p1_${"b".repeat(64)}`;
const RECORD_ID = "0b7c6f1e-4d1a-4c3b-9a55-2f1e8d7c6b5a";
const REQ1 = "lc_6a1e2f3d-8c4b-4e5a-b7f6-0d9c8b7a6e5f";
const REQ2 = "lc_11111111-2222-4333-8444-555555555555";
const BINDING = { kind: "installation", id: "5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716" } as const;
const SCOPE: LessonScope = { world: "Koleżka", project: { kind: "project", id: PROJECT_ID } };
const OTHER_SCOPE: LessonScope = { world: "Work", project: { kind: "world" } };
const INBOX_KEY: LessonKey = { world: "Koleżka", kind: "inbox", id: "legacy id\u0000 with \"quotes\"" };
const CAPTURE_KEY: LessonKey = { world: "Koleżka", kind: "capture", id: RECORD_ID };
const SOURCE: CaptureSource = {
  kind: "explicit_quote",
  quote: "we renamed it and one caller broke",
  reference: null,
  quoteRedacted: false,
  captureSessionId: "sess-1",
  sourceConversationId: "conv-9",
  sourceRowId: null,
  sourceAgentId: null,
};
const STAMP = "2026-10-22T10:00:00.000Z";

function view(revision: number, text: string, overrides: Partial<LessonView> = {}): LessonView {
  return {
    key: INBOX_KEY,
    scope: SCOPE,
    revision,
    important: false,
    effectiveText: text,
    originalText: "original wording",
    source: null,
    sourceStatus: "saved",
    sourceDigest: null,
    baselineDigest: null,
    relatedPattern: null,
    created: STAMP,
    updated: STAMP,
    ...overrides,
  };
}

// Existing behavioral fixtures use a separate live host channel, never cached state as authority.
const fixtureAuthority = new WeakMap<LessonEditorState, LessonEditorAuthority>();
function reduceLessonEditor(state: LessonEditorState, event: LessonEditorEvent): LessonEditorState {
  let authority = fixtureAuthority.get(state) ?? { observation: null };
  if (event.type === "open-lesson" || event.type === "open-capture") {
    authority = { observation: { connectionEpoch: "fixture", binding: event.binding,
      installationId: event.binding.kind === "installation" ? event.binding.id : BINDING.id, pinnedLocationRetry: true } };
  } else if (event.type === "store-resolved") {
    authority = { observation: { connectionEpoch: "fixture", binding: event.resolution.location,
      installationId: event.resolution.installation.id, pinnedLocationRetry: true } };
  } else if (event.type === "hydrate" || event.type === "restore") {
    authority = { observation: null };
  }
  if ("generation" in event && "target" in event && authority.observation) {
    authority = { ...authority, result: { connectionEpoch: "fixture", generation: event.generation, target: event.target,
      operation: "requestId" in event ? "receipt" : "read", installationId: event.target.binding.kind === "installation" ? event.target.binding.id : BINDING.id,
      ...("requestId" in event ? { requestId: event.requestId } : {}) } };
  }
  const next = reduceWithAuthority(state, event, authority);
  fixtureAuthority.set(next, authority);
  return next;
}
function prepareLessonMutation(state: LessonEditorState, requestId: string) {
  return prepareWithAuthority(state, requestId, fixtureAuthority.get(state)).mutation;
}
function verifyFixture(state: LessonEditorState): LessonEditorState {
  const authority = { observation: { connectionEpoch: "fixture", binding: BINDING, installationId: BINDING.id, pinnedLocationRetry: true } };
  const next = reduceWithAuthority(state, { type: "verify-store" }, authority);
  fixtureAuthority.set(next, authority);
  return next;
}
function run(state: LessonEditorState, ...events: LessonEditorEvent[]): LessonEditorState {
  return events.reduce((current, event) => reduceLessonEditor(current, event), state);
}

/** Existing inbox lesson loaded at `revision` with clean draft. */
function openExisting(revision = 3, text = "old wording", overrides: Partial<LessonView> = {}): LessonEditorState {
  const opened = run(initialLessonEditor(), { type: "open-lesson", scope: SCOPE, binding: BINDING, key: INBOX_KEY });
  return run(opened, { type: "loaded", generation: opened.generation, target: tgt(INBOX_KEY), view: view(revision, text, overrides) });
}

function openCapture(): LessonEditorState {
  return run(initialLessonEditor(), { type: "open-capture", scope: SCOPE, binding: BINDING, recordId: RECORD_ID, source: SOURCE });
}

/** Full target identity for async completions. */
function tgt(key: LessonKey, scope: LessonScope = SCOPE, binding: StoreBinding = BINDING): LessonEditorTarget {
  return { scope, binding, key };
}

function committed(state: LessonEditorState, requestId: string, key: LessonKey, revision: number, target = tgt(key)): LessonEditorEvent {
  return {
    type: "receipt",
    generation: state.generation,
    requestId,
    target,
    receipt: { state: "committed", requestId, payloadHash: "c".repeat(64), key, revision, changed: true, startedAt: STAMP, finishedAt: STAMP },
  };
}

function purgedReceipt(generation: number, requestId: string, target: LessonEditorTarget): LessonEditorEvent {
  return {
    type: "receipt",
    generation,
    requestId,
    target,
    receipt: { state: "purged", requestId, key: target.key, startedAt: STAMP, finishedAt: STAMP },
  };
}

function unknownReceipt(state: LessonEditorState, requestId: string, key: LessonKey): LessonEditorEvent {
  return { type: "receipt", generation: state.generation, requestId, target: tgt(key), receipt: { state: "unknown", requestId } };
}

function curationError(fn: () => unknown): CurationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CurationError) return error;
    throw new Error(`expected CurationError, got ${String(error)}`);
  }
  throw new Error("expected CurationError, nothing was thrown");
}

describe("cancel and dirty navigation", () => {
  test("cancel before submit leaves nothing to send or reconcile", () => {
    const clean = run(openCapture(), { type: "close" });
    expect(clean.target).toBeNull();
    expect(clean.pending).toBeNull();
    expect(clean.unresolved).toEqual([]);

    const dirty = run(openCapture(), { type: "edit-text", text: "Grep call sites first." }, { type: "close" });
    expect(dirty.blocked).toEqual({ type: "close" });
    expect(dirty.draft?.text).toBe("Grep call sites first.");

    const discarded = run(dirty, { type: "discard" });
    expect(discarded.target).toBeNull();
    expect(discarded.draft).toBeNull();
    expect(discarded.pending).toBeNull();
    expect(discarded.unresolved).toEqual([]);
    expect(curationError(() => prepareLessonMutation(discarded, REQ1)).code).toBe("INVALID_INPUT");
  });

  test("a dirty world change waits for stay or discard", () => {
    const dirty = run(openExisting(), { type: "edit-text", text: "new wording" });
    const nav = { type: "open-lesson", scope: OTHER_SCOPE, binding: BINDING, key: { world: "Work", kind: "inbox", id: "x" } } as const;
    const blocked = run(dirty, nav);
    expect(blocked.blocked).toEqual(nav);
    expect(blocked.target?.scope).toEqual(SCOPE);
    expect(blocked.generation).toBe(dirty.generation);
    expect(blocked.draft?.text).toBe("new wording");

    const stayed = run(blocked, { type: "stay" });
    expect(stayed.blocked).toBeNull();
    expect(stayed.draft?.text).toBe("new wording");

    const moved = run(blocked, { type: "discard" });
    expect(moved.target?.scope).toEqual(OTHER_SCOPE);
    expect(moved.generation).toBe(dirty.generation + 1);
    expect(moved.draft).toBeNull();
    expect(moved.blocked).toBeNull();
  });

  test("a clean navigation needs no confirmation", () => {
    const state = run(openExisting(), { type: "open-lesson", scope: OTHER_SCOPE, binding: BINDING, key: { world: "Work", kind: "inbox", id: "x" } });
    expect(state.blocked).toBeNull();
    expect(state.target?.scope).toEqual(OTHER_SCOPE);
  });

  test("cancel during a pending save keeps reconciliation identity, never a rollback", () => {
    const saving = run(openExisting(), { type: "edit-text", text: "new wording" }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    const gen = saving.generation;
    const closed = run(saving, { type: "close" }, { type: "discard" });
    expect(closed.target).toBeNull();
    expect(closed.pending).toBeNull();
    expect(closed.phase).not.toBe("saved");
    expect(closed.unresolved).toEqual([{ requestId: REQ1, binding: BINDING, scope: SCOPE, key: INBOX_KEY }]);
    expect(JSON.stringify(closed.unresolved)).not.toContain("new wording");

    // The late answer settles the identity without resurrecting the editor.
    const late = run(closed, committed({ ...closed, generation: gen }, REQ1, INBOX_KEY, 4));
    expect(late.unresolved).toEqual([]);
    expect(late.target).toBeNull();
    expect(late.draft).toBeNull();

    // An unknown late answer keeps it open for later reconciliation.
    const stillUnknown = run(closed, unknownReceipt({ ...closed, generation: gen }, REQ1, INBOX_KEY));
    expect(stillUnknown.unresolved).toHaveLength(1);
  });
});

describe("saving", () => {
  test("a failed save preserves the draft and the base", () => {
    const saving = run(openExisting(), { type: "edit-text", text: "new wording" }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    const failed = run(saving, { type: "rejected", generation: saving.generation, requestId: REQ1, target: tgt(INBOX_KEY), code: "STORAGE_BUSY", fields: [] });
    expect(failed.phase).toBe("error");
    expect(failed.error).toEqual({ code: "STORAGE_BUSY", fields: [] });
    expect(failed.draft?.text).toBe("new wording");
    expect(failed.base).toEqual({ revision: 3, text: "old wording", important: false, source: null });
    expect(failed.pending).toBeNull();

    const conflict = run(saving, { type: "rejected", generation: saving.generation, requestId: REQ1, target: tgt(INBOX_KEY), code: "CURATION_CONFLICT", fields: [] });
    expect(conflict.phase).toBe("conflict");
    expect(conflict.draft?.text).toBe("new wording");
  });

  test("a double click reuses the first request id and payload", () => {
    const once = run(openExisting(), { type: "edit-text", text: "new wording" }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    const twice = run(once, { type: "submit", requestId: REQ2, intent: { kind: "save" } });
    expect(twice).toBe(once);
    expect(twice.pending?.requestId).toBe(REQ1);
    expect(prepareLessonMutation(twice, REQ1)).toEqual({
      requestId: REQ1,
      binding: BINDING,
      scope: SCOPE,
      key: INBOX_KEY,
      expectedRevision: 3,
      change: { kind: "edit", text: "new wording" },
    });
    expect(curationError(() => prepareLessonMutation(twice, REQ2)).code).toBe("INVALID_INPUT");
  });

  test("unmark sends false explicitly and changes nothing else", () => {
    const loaded = run(openExisting(3, "old wording", { important: true }), { type: "edit-text", text: "unsaved wording" });
    const pending = run(loaded, { type: "submit", requestId: REQ1, intent: { kind: "important", value: false } });
    expect(prepareLessonMutation(pending, REQ1).change).toEqual({ kind: "important", value: false });
    expect(pending.draft?.text).toBe("unsaved wording");

    const done = run(pending, committed(pending, REQ1, INBOX_KEY, 4));
    expect(done.base).toEqual({ revision: 4, text: "old wording", important: false, source: null });
    expect(done.draft?.text).toBe("unsaved wording");
    expect(done.phase).toBe("editing");

    // A truthy non-boolean is not an explicit desired value.
    const bogus = run(loaded, { type: "submit", requestId: REQ1, intent: { kind: "important", value: 0 as unknown as boolean } });
    expect(bogus.pending).toBeNull();
    expect(bogus.error?.code).toBe("INVALID_INPUT");
  });

  test("an unknown receipt never yields saved and replays the same payload", () => {
    const saving = run(openCapture(), { type: "edit-text", text: "Grep call sites first." }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    const first = prepareLessonMutation(saving, REQ1);
    expect(first.key).toEqual(CAPTURE_KEY);
    expect(first.expectedRevision).toBe(0);

    const unknown = run(saving, unknownReceipt(saving, REQ1, CAPTURE_KEY));
    expect(unknown.phase).toBe("unknown");
    expect(unknown.pending?.requestId).toBe(REQ1);
    expect(prepareLessonMutation(unknown, REQ1)).toEqual(first);

    // A retry click while unknown keeps the record id and request id.
    const retried = run(unknown, { type: "submit", requestId: REQ2, intent: { kind: "save" } });
    expect(retried.pending?.requestId).toBe(REQ1);
    expect(retried.target?.key.id).toBe(RECORD_ID);

    const saved = run(retried, committed(retried, REQ1, CAPTURE_KEY, 1));
    expect(saved.phase).toBe("saved");
    expect(saved.pending).toBeNull();
  });

  test("capture keeps source provenance apart from wording", () => {
    const edited = run(openCapture(), { type: "edit-text", text: "Grep call sites first." });
    expect(edited.draft?.source).toEqual(SOURCE);
    const resourced = run(edited, { type: "edit-source", source: { ...SOURCE, reference: "PR #12" } });
    expect(resourced.draft?.text).toBe("Grep call sites first.");

    const saving = run(resourced, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    expect(prepareLessonMutation(saving, REQ1).change).toEqual({
      kind: "capture",
      text: "Grep call sites first.",
      source: { ...SOURCE, reference: "PR #12" },
    });

    // After commit the record is an existing lesson; later saves carry text only.
    const saved = run(saving, committed(saving, REQ1, CAPTURE_KEY, 1));
    expect(saved.mode).toBe("existing");
    expect(saved.base).toEqual({ revision: 1, text: "Grep call sites first.", important: false, source: null });
    const next = run(saved, { type: "edit-text", text: "Grep every call site first." }, { type: "submit", requestId: REQ2, intent: { kind: "save" } });
    expect(prepareLessonMutation(next, REQ2)).toMatchObject({ expectedRevision: 1, change: { kind: "edit", text: "Grep every call site first." } });
    expect(Object.keys(prepareLessonMutation(next, REQ2).change).sort()).toEqual(["kind", "text"]);
  });

  test("importance cannot ride on an uncommitted capture", () => {
    const state = run(openCapture(), { type: "edit-text", text: "x" }, { type: "submit", requestId: REQ1, intent: { kind: "important", value: true } });
    expect(state.pending).toBeNull();
    expect(state.error?.code).toBe("INVALID_INPUT");
  });

  test("invalid wording is refused locally and the draft is kept", () => {
    const loaded = openExisting();
    const lone = run(loaded, { type: "edit-text", text: "bad \ud800 text" });
    expect(lone.draft?.text).toBe("old wording");
    expect(lone.error).toEqual({ code: "INVALID_INPUT", fields: ["text"] });

    const long = run(loaded, { type: "edit-text", text: "x".repeat(4001) }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    expect(long.pending).toBeNull();
    expect(long.draft?.text).toHaveLength(4001);
    expect(long.error).toEqual({ code: "INVALID_INPUT", fields: ["text"] });

    const blank = run(openCapture(), { type: "edit-text", text: "   " }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    expect(blank.pending).toBeNull();

    const badId = run(loaded, { type: "edit-text", text: "y" }, { type: "submit", requestId: "lc_nope", intent: { kind: "save" } });
    expect(badId.pending).toBeNull();
    expect(badId.error?.fields).toEqual(["requestId"]);

    const badRecord = run(initialLessonEditor(), { type: "open-capture", scope: SCOPE, binding: BINDING, recordId: "not-a-uuid", source: SOURCE });
    expect(badRecord.target).toBeNull();
    expect(badRecord.error?.code).toBe("INVALID_INPUT");
  });
});

describe("stale and late responses", () => {
  test("stale-generation and cross-target responses leave state unchanged", () => {
    const first = run(initialLessonEditor(), { type: "open-lesson", scope: SCOPE, binding: BINDING, key: INBOX_KEY });
    const oldGen = first.generation;
    const moved = run(first, { type: "open-lesson", scope: OTHER_SCOPE, binding: BINDING, key: { world: "Work", kind: "inbox", id: "x" } });
    expect(moved.generation).toBe(oldGen + 1);

    const events: LessonEditorEvent[] = [
      { type: "loaded", generation: oldGen, target: tgt(INBOX_KEY), view: view(9, "late") },
      { type: "history-loaded", generation: oldGen, target: tgt(INBOX_KEY), revisions: [] },
      { type: "read-failed", generation: oldGen, target: tgt(INBOX_KEY), code: "STORAGE_BUSY" },
      committed({ ...moved, generation: oldGen }, REQ1, INBOX_KEY, 4),
      { type: "rejected", generation: oldGen, requestId: REQ1, target: tgt(INBOX_KEY), code: "PURGED", fields: [] },
      // Right generation, wrong record.
      { type: "loaded", generation: moved.generation, target: tgt(INBOX_KEY), view: view(9, "late") },
    ];
    for (const event of events) expect(reduceLessonEditor(moved, event)).toBe(moved);

    // Reopening the same record: only the generation tells old reads apart.
    const reopened = run(first, { type: "close" }, { type: "open-lesson", scope: SCOPE, binding: BINDING, key: INBOX_KEY });
    expect(reopened.target?.key).toEqual(INBOX_KEY);
    for (const event of events.slice(0, 3)) expect(reduceLessonEditor(reopened, event)).toBe(reopened);

    const saving = run(openExisting(), { type: "edit-text", text: "n" }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    expect(reduceLessonEditor(saving, committed(saving, REQ2, INBOX_KEY, 4))).toBe(saving);
    expect(reduceLessonEditor(saving, committed(saving, REQ1, CAPTURE_KEY, 4))).toBe(saving);
  });

  test("a newer web revision while dirty marks stale without replacing text", () => {
    const dirty = run(openExisting(), { type: "edit-text", text: "my wording" });
    const stale = run(dirty, { type: "loaded", generation: dirty.generation, target: tgt(INBOX_KEY), view: view(5, "web wording") });
    expect(stale.draft?.text).toBe("my wording");
    expect(stale.base?.revision).toBe(3);
    expect(stale.loaded?.revision).toBe(5);
    expect(isLessonEditorStale(stale)).toBe(true);
    expect(isLessonEditorDirty(stale)).toBe(true);

    // Saving now still targets the revision the human edited from.
    const saving = run(stale, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    expect(prepareLessonMutation(saving, REQ1).expectedRevision).toBe(3);

    // An explicit rebase keeps the wording and moves the base.
    const rebased = run(stale, { type: "rebase" });
    expect(rebased.draft?.text).toBe("my wording");
    expect(rebased.base).toEqual({ revision: 5, text: "web wording", important: false, source: null });
    expect(isLessonEditorStale(rebased)).toBe(false);

    // A clean editor simply follows the web.
    const clean = openExisting();
    const followed = run(clean, { type: "loaded", generation: clean.generation, target: tgt(INBOX_KEY), view: view(5, "web wording") });
    expect(followed.draft?.text).toBe("web wording");
    expect(followed.base?.revision).toBe(5);

    // An older read never rolls the editor back.
    expect(reduceLessonEditor(followed, { type: "loaded", generation: followed.generation, target: tgt(INBOX_KEY), view: view(4, "older") })).toBe(followed);
  });

  test("an older committed revision never replaces newer content", () => {
    const saving = run(openExisting(), { type: "edit-text", text: "mine" }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    const newer = run(saving, { type: "loaded", generation: saving.generation, target: tgt(INBOX_KEY), view: view(5, "web wording") });
    expect(newer.draft?.text).toBe("mine");
    const done = run(newer, committed(newer, REQ1, INBOX_KEY, 4));
    expect(done.base).toEqual({ revision: 4, text: "mine", important: false, source: null });
    expect(done.loaded?.revision).toBe(5);
    expect(isLessonEditorStale(done)).toBe(true);
    expect(done.draft?.text).toBe("mine");
  });
});

describe("purge", () => {
  test("purged clears text and history and blocks replay and resurrection", () => {
    const loaded = openExisting();
    const withHistory = run(loaded, {
      type: "history-loaded",
      generation: loaded.generation,
      target: tgt(INBOX_KEY),
      revisions: [{ revision: 3, kind: "edit", at: STAMP, text: "old wording", important: null, oldSourceDigest: null, newSourceDigest: null }],
    });
    expect(withHistory.history).toHaveLength(1);
    const purging = run(withHistory, { type: "edit-text", text: "draft" }, { type: "submit", requestId: REQ1, intent: { kind: "purge", confirmed: true } });
    expect(prepareLessonMutation(purging, REQ1).change).toEqual({ kind: "purge", confirmed: true });

    const purged = run(purging, purgedReceipt(purging.generation, REQ1, tgt(INBOX_KEY)));
    expect(purged.phase).toBe("purged");
    expect(purged.loaded).toBeNull();
    expect(purged.draft).toBeNull();
    expect(purged.base).toBeNull();
    expect(purged.history).toBeNull();
    expect(purged.pending).toBeNull();
    expect(curationError(() => prepareLessonMutation(purged, REQ1)).code).toBe("PURGED");

    expect(reduceLessonEditor(purged, { type: "loaded", generation: purged.generation, target: tgt(INBOX_KEY), view: view(3, "old wording") })).toBe(purged);
    expect(reduceLessonEditor(purged, { type: "edit-text", text: "zombie" })).toBe(purged);
    expect(reduceLessonEditor(purged, { type: "submit", requestId: REQ2, intent: { kind: "save" } })).toBe(purged);

    const reopened = run(purged, { type: "open-lesson", scope: SCOPE, binding: BINDING, key: INBOX_KEY });
    expect(reopened.phase).toBe("purged");
    expect(reduceLessonEditor(reopened, { type: "loaded", generation: reopened.generation, target: tgt(INBOX_KEY), view: view(3, "old wording") })).toBe(reopened);
  });

  test("a PURGED rejection is terminal too", () => {
    const saving = run(openExisting(), { type: "edit-text", text: "x" }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    const purged = run(saving, { type: "rejected", generation: saving.generation, requestId: REQ1, target: tgt(INBOX_KEY), code: "PURGED", fields: [] });
    expect(purged.phase).toBe("purged");
    expect(purged.draft).toBeNull();
  });
});

describe("hydration after refresh", () => {
  function savingCapture(): LessonEditorState {
    return run(openCapture(), { type: "edit-text", text: "Secret-free wording." }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
  }

  test("a snapshot carries opaque ids only, never draft text", () => {
    const snapshot = snapshotLessonEditor(savingCapture());
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain("Secret-free wording.");
    expect(json).not.toContain(SOURCE.quote!);
    expect(snapshot).toEqual({
      version: 4,
      expectedInstallation: BINDING.id,
      address: BINDING,
      pendingIdentity: { requestId: REQ1, scope: SCOPE, binding: BINDING, key: CAPTURE_KEY },
      target: { scope: SCOPE, binding: BINDING, key: CAPTURE_KEY },
      mode: "capture",
      pendingRequestId: REQ1,
      unresolved: [],
      tombstones: [],
      tombstonesSaturated: false,
      resolutions: [],
    });
  });

  test("an unknown receipt after hydration offers reconciliation, not replay", () => {
    const snapshot = JSON.parse(JSON.stringify(snapshotLessonEditor(savingCapture())));
    const hydrated = run(initialLessonEditor(), { type: "hydrate", snapshot });
    expect(hydrated.phase).toBe("unknown");
    expect(hydrated.draft).toBeNull();
    expect(hydrated.pending?.requestId).toBe(REQ1);
    expect(hydrated.pending?.mutation).toBeNull();
    expect(curationError(() => prepareLessonMutation(hydrated, REQ1)).code).toBe("INVALID_INPUT");

    const stillUnknown = run(verifyFixture(hydrated), unknownReceipt(hydrated, REQ1, CAPTURE_KEY));
    expect(stillUnknown.phase).toBe("unknown");
    expect(curationError(() => prepareLessonMutation(stillUnknown, REQ1)).code).toBe("INVALID_INPUT");

    const settled = run(stillUnknown, committed(stillUnknown, REQ1, CAPTURE_KEY, 1));
    expect(settled.phase).toBe("saved");
    expect(settled.pending).toBeNull();
    expect(settled.mode).toBe("existing");
  });

  test("a late replay receipt after hydration does not roll back a newer read", () => {
    const opened = run(openExisting(), { type: "edit-text", text: "mine" }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    const hydrated = verifyFixture(run(initialLessonEditor(), { type: "hydrate", snapshot: snapshotLessonEditor(opened) }));
    const read = run(hydrated, { type: "loaded", generation: hydrated.generation, target: tgt(INBOX_KEY), view: view(6, "newest") });
    expect(read.base).toEqual({ revision: 6, text: "newest", important: false, source: null });
    const replay = run(read, committed(read, REQ1, INBOX_KEY, 4));
    expect(replay.base).toEqual({ revision: 6, text: "newest", important: false, source: null });
    expect(replay.draft?.text).toBe("newest");
    expect(replay.pending).toBeNull();
  });

  test("rewritten or invalid snapshots are rejected", () => {
    const good = JSON.parse(JSON.stringify(snapshotLessonEditor(savingCapture())));
    const bad: unknown[] = [
      { ...good, draft: { text: "smuggled" } },
      { ...good, version: 1 },
      { ...good, version: 2 },
      { ...good, tombstonesSaturated: "no" },
      { ...good, purgedKeys: [] },
      { ...good, tombstones: [tgt(CAPTURE_KEY)] },
      { ...good, pendingRequestId: "lc_bad" },
      { ...good, target: null, mode: null, pendingRequestId: null, expectedInstallation: null, address: null },
      { ...good, target: { ...good.target, binding: { kind: "installation", id: "nope" } } },
      { ...good, target: { ...good.target, key: { ...good.target.key, world: "Other" } } },
      { ...good, target: { ...good.target, key: { ...good.target.key, id: "not-uuid" } } },
      { ...good, tombstones: ["!!!"] },
      { ...good, tombstones: [{ ...tgt(INBOX_KEY), extra: 1 }] },
      { ...good, unresolved: [{ requestId: REQ2, binding: BINDING, scope: SCOPE, key: CAPTURE_KEY, mutation: {} }] },
      null,
      "x",
      [],
    ];
    for (const snapshot of bad) {
      const state = run(initialLessonEditor(), { type: "hydrate", snapshot });
      expect(state.target).toBeNull();
      expect(state.pending).toBeNull();
      expect(state.error?.code).toBe("INVALID_INPUT");
    }
  });

  test("a snapshot round-trips tombstones and unresolved identities", () => {
    const closed = run(
      openExisting(),
      { type: "edit-text", text: "n" },
      { type: "submit", requestId: REQ1, intent: { kind: "save" } },
      { type: "close" },
      { type: "discard" },
    );
    const snapshot = JSON.parse(JSON.stringify(snapshotLessonEditor(closed)));
    const hydrated = run(initialLessonEditor(), { type: "hydrate", snapshot });
    expect(hydrated.error).toBeNull();
    expect(hydrated.unresolved).toEqual(closed.unresolved);

    const withPurge = run(initialLessonEditor(), { type: "hydrate", snapshot: { ...snapshot, tombstones: [tgt(INBOX_KEY)] } });
    expect(run(withPurge, { type: "open-lesson", scope: SCOPE, binding: BINDING, key: INBOX_KEY }).phase).toBe("purged");
  });
});

describe("native hot reload", () => {
  test("a schema-valid in-memory draft survives, its payload does not", () => {
    const dirty = run(openExisting(), { type: "edit-text", text: "hot draft" }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    const restored = run(initialLessonEditor(), { type: "restore", state: JSON.parse(JSON.stringify(dirty)) });
    expect(restored.error).toBeNull();
    expect(restored.draft?.text).toBe("hot draft");
    expect(restored.pending?.requestId).toBe(REQ1);
    expect(restored.pending?.mutation).toBeNull();
    expect(restored.phase).toBe("unknown");
    expect(restored.generation).toBeGreaterThan(dirty.generation);
  });

  test("rewritten or invalid restored state is rejected", () => {
    const dirty = JSON.parse(JSON.stringify(run(openExisting(), { type: "edit-text", text: "hot draft" })));
    const capture = JSON.parse(JSON.stringify(run(openCapture(), { type: "edit-text", text: "x" })));
    const bad: unknown[] = [
      { ...dirty, draft: { ...dirty.draft, text: "lone \ud800" } },
      { ...dirty, extra: true },
      { ...dirty, draft: { ...dirty.draft, source: SOURCE } },
      { ...dirty, generation: -1 },
      { ...dirty, phase: "done" },
      { ...dirty, base: null },
      { ...dirty, loaded: { ...dirty.loaded, revision: "3" } },
      { ...dirty, pending: { requestId: REQ1, binding: BINDING, scope: SCOPE, key: CAPTURE_KEY, generation: 1, mutation: null } },
      { ...capture, draft: { ...capture.draft, source: { ...SOURCE, captureSessionId: "bad id with spaces" } } },
      { ...dirty, error: { code: "NOPE", fields: [] } },
    ];
    for (const state of bad) {
      const result = run(initialLessonEditor(), { type: "restore", state });
      expect(result.target).toBeNull();
      expect(result.draft).toBeNull();
      expect(result.error?.code).toBe("INVALID_INPUT");
    }
  });
});

// Review round 1. Each block pins a class of failure, not one symptom.
const BINDING_B: StoreBinding = { kind: "installation", id: "22222222-2222-4222-8222-222222222222" };
const SCOPE_B: LessonScope = { world: "Koleżka", project: { kind: "project", id: `p1_${"c".repeat(64)}` } };
const SCOPE_WORLD: LessonScope = { world: "Koleżka", project: { kind: "world" } };

function openFrom(state: LessonEditorState, binding: StoreBinding = BINDING, scope: LessonScope = SCOPE, key = INBOX_KEY): LessonEditorState {
  const opened = run(state, { type: "open-lesson", scope, binding, key });
  return run(opened, { type: "loaded", generation: opened.generation, target: tgt(key, scope, binding), view: view(3, "words", { scope, key }) });
}

function requestIdFor(i: number): string {
  return `lc_00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
}

function emptySnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 3,
    target: null,
    mode: null,
    pendingRequestId: null,
    unresolved: [],
    tombstones: [],
    tombstonesSaturated: false,
    resolutions: [],
    ...overrides,
  };
}

describe("review fix: a late purge reaches the reopened record", () => {
  function abandonedPurge(): { state: LessonEditorState; gen: number } {
    const purging = run(openFrom(initialLessonEditor()), { type: "submit", requestId: REQ1, intent: { kind: "purge", confirmed: true } });
    return { state: run(purging, { type: "close" }), gen: purging.generation };
  }

  test("same target reopened: text and history are cleared", () => {
    const { state, gen } = abandonedPurge();
    let reopened = openFrom(state);
    reopened = run(reopened, { type: "history-loaded", generation: reopened.generation, target: tgt(INBOX_KEY), revisions: [] });
    expect(reopened.draft?.text).toBe("words");

    const late = run(reopened, purgedReceipt(gen, REQ1, tgt(INBOX_KEY)));
    expect(late.phase).toBe("purged");
    expect(late.draft).toBeNull();
    expect(late.loaded).toBeNull();
    expect(late.history).toBeNull();
    expect(late.unresolved).toEqual([]);
    expect(reduceLessonEditor(late, { type: "edit-text", text: "zombie" })).toBe(late);
  });

  test("same record in another project view of the same store is cleared too", () => {
    const { state, gen } = abandonedPurge();
    const reopened = openFrom(state, BINDING, SCOPE_WORLD);
    const late = run(reopened, purgedReceipt(gen, REQ1, tgt(INBOX_KEY)));
    expect(late.phase).toBe("purged");
    expect(late.draft).toBeNull();
  });

  test("a PURGED rejection for the abandoned request clears it the same way", () => {
    const { state, gen } = abandonedPurge();
    const reopened = openFrom(state);
    const late = run(reopened, { type: "rejected", generation: gen, requestId: REQ1, target: tgt(INBOX_KEY), code: "PURGED", fields: [] });
    expect(late.phase).toBe("purged");
    expect(late.draft).toBeNull();
  });

  test("a different record stays untouched and is tombstoned", () => {
    const { state, gen } = abandonedPurge();
    const other = { world: "Koleżka", kind: "inbox", id: "other" } as const;
    const elsewhere = openFrom(state, BINDING, SCOPE, other);
    const late = run(elsewhere, purgedReceipt(gen, REQ1, tgt(INBOX_KEY)));
    expect(late.draft?.text).toBe("words");
    expect(late.tombstones).toEqual([tgt(INBOX_KEY)]);
  });
});

describe("review fix: async completions match the full target", () => {
  test("reads for another binding or project are ignored", () => {
    const state = openFrom(initialLessonEditor());
    const wrong = [tgt(INBOX_KEY, SCOPE_B), tgt(INBOX_KEY, SCOPE, BINDING_B)];
    for (const target of wrong) {
      expect(reduceLessonEditor(state, { type: "loaded", generation: state.generation, target, view: view(5, "x", { scope: target.scope }) })).toBe(state);
      expect(reduceLessonEditor(state, { type: "history-loaded", generation: state.generation, target, revisions: [] })).toBe(state);
      expect(reduceLessonEditor(state, { type: "read-failed", generation: state.generation, target, code: "STORAGE_BUSY" })).toBe(state);
    }
  });

  test("a view for another project is reported and never replaces the draft", () => {
    const state = openFrom(initialLessonEditor());
    const crossed = run(state, { type: "loaded", generation: state.generation, target: tgt(INBOX_KEY), view: view(5, "other project text", { scope: SCOPE_B }) });
    expect(crossed.draft?.text).toBe("words");
    expect(crossed.loaded?.scope).toEqual(SCOPE);
    expect(crossed.base?.revision).toBe(3);
    expect(crossed.error).toEqual({ code: "SCOPE_CONFLICT", fields: ["view.scope"] });
  });

  test("receipts and rejections for another binding or project leave the pending write alone", () => {
    const saving = run(openFrom(initialLessonEditor()), { type: "edit-text", text: "n" }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    for (const target of [tgt(INBOX_KEY, SCOPE_B), tgt(INBOX_KEY, SCOPE, BINDING_B)]) {
      expect(reduceLessonEditor(saving, committed(saving, REQ1, INBOX_KEY, 4, target))).toBe(saving);
      expect(reduceLessonEditor(saving, { type: "rejected", generation: saving.generation, requestId: REQ1, target, code: "PURGED", fields: [] })).toBe(saving);
    }
  });

  test("an abandoned request is settled only by its own binding and project", () => {
    const saving = run(openFrom(initialLessonEditor()), { type: "edit-text", text: "n" }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    const gen = saving.generation;
    const closed = run(saving, { type: "close" }, { type: "discard" });
    for (const target of [tgt(INBOX_KEY, SCOPE_B), tgt(INBOX_KEY, SCOPE, BINDING_B)]) {
      expect(run(closed, purgedReceipt(gen, REQ1, target)).unresolved).toHaveLength(1);
      expect(run(closed, purgedReceipt(gen, REQ1, target)).tombstones).toEqual([]);
    }
    expect(run(closed, purgedReceipt(gen, REQ1, tgt(INBOX_KEY))).unresolved).toEqual([]);
  });
});

describe("review fix: restore rejects any identity disagreement", () => {
  function savingJson(): Record<string, any> {
    const saving = run(openFrom(initialLessonEditor()), { type: "edit-text", text: "human draft" }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    return JSON.parse(JSON.stringify(saving));
  }

  test("a crossed installation or project anywhere is rejected, not rewritten", () => {
    const cases: Array<(s: Record<string, any>) => void> = [
      (s) => {
        s.pending.binding = BINDING_B;
        s.pending.mutation.binding = BINDING_B;
      },
      (s) => {
        s.pending.mutation.binding = BINDING_B;
      },
      // Payload already dropped (an earlier reload): pending identity alone must agree.
      (s) => {
        s.pending.mutation = null;
        s.pending.binding = BINDING_B;
      },
      (s) => {
        s.pending.mutation = null;
        s.pending.scope = SCOPE_B;
      },
      (s) => {
        s.pending.scope = SCOPE_B;
        s.pending.mutation.scope = SCOPE_B;
      },
      (s) => {
        s.pending.mutation.scope = SCOPE_B;
      },
      (s) => {
        s.target.scope = SCOPE_B;
      },
      (s) => {
        s.target.scope = SCOPE_B;
        s.loaded.scope = SCOPE_B;
      },
      (s) => {
        s.target.binding = BINDING_B;
      },
      (s) => {
        s.loaded.scope = SCOPE_B;
      },
    ];
    for (const mutate of cases) {
      const crossed = savingJson();
      mutate(crossed);
      const restored = run(initialLessonEditor(), { type: "restore", state: crossed });
      expect(restored.error?.code).toBe("INVALID_INPUT");
      expect(restored.target).toBeNull();
      expect(restored.pending).toBeNull();
    }
  });

  test("the untouched state still restores with its own identity", () => {
    const restored = run(initialLessonEditor(), { type: "restore", state: savingJson() });
    expect(restored.error).toBeNull();
    expect(restored.pending?.binding).toEqual(BINDING);
    expect(restored.pending?.scope).toEqual(SCOPE);
  });

  test("live content for a tombstoned target or duplicate unresolved ids are rejected", () => {
    const live = savingJson();
    live.tombstones = [tgt(INBOX_KEY)];
    expect(run(initialLessonEditor(), { type: "restore", state: live }).error?.code).toBe("INVALID_INPUT");

    const dup = savingJson();
    const id = { requestId: REQ2, binding: BINDING, scope: SCOPE, key: INBOX_KEY };
    dup.unresolved = [id, id];
    expect(run(initialLessonEditor(), { type: "restore", state: dup }).error?.code).toBe("INVALID_INPUT");
  });
});

describe("review fix: provenance-only edits are dirty", () => {
  const newQuote = { ...SOURCE, quote: "new quote" };

  test("close and navigation wait for stay or discard after a source-only edit", () => {
    const edited = run(openCapture(), { type: "edit-source", source: newQuote });
    expect(isLessonEditorDirty(edited)).toBe(true);
    expect(edited.phase).toBe("editing");
    expect(run(edited, { type: "close" }).blocked).toEqual({ type: "close" });
    const nav = { type: "open-lesson", scope: SCOPE_B, binding: BINDING, key: INBOX_KEY } as const;
    const blocked = run(edited, nav);
    expect(blocked.blocked).toEqual(nav);
    expect(blocked.draft?.source).toEqual(newQuote);
  });

  test("discard restores the opening provenance, and editing back is clean", () => {
    const edited = run(openCapture(), { type: "edit-source", source: newQuote });
    expect(run(edited, { type: "discard" }).draft?.source).toEqual(SOURCE);
    expect(isLessonEditorDirty(run(edited, { type: "edit-source", source: SOURCE }))).toBe(false);
  });
});

describe("review fix: tombstones are store-qualified and cover capture", () => {
  test("open-capture on a tombstoned record is terminal", () => {
    const hydrated = run(initialLessonEditor(), { type: "hydrate", snapshot: emptySnapshot({ tombstones: [tgt(CAPTURE_KEY)] }) });
    const opened = run(hydrated, { type: "open-capture", scope: SCOPE, binding: BINDING, recordId: RECORD_ID, source: SOURCE });
    expect(opened.phase).toBe("purged");
    expect(opened.draft).toBeNull();
    const tried = run(opened, { type: "edit-text", text: "valid wording" }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    expect(tried.pending).toBeNull();
    expect(curationError(() => prepareLessonMutation(tried, REQ1)).code).toBe("PURGED");
  });

  test("a purge in one installation does not block the same key in another", () => {
    let state = run(openFrom(initialLessonEditor()), { type: "submit", requestId: REQ1, intent: { kind: "purge", confirmed: true } });
    state = run(state, purgedReceipt(state.generation, REQ1, tgt(INBOX_KEY)));
    expect(state.tombstones).toEqual([tgt(INBOX_KEY)]);
    const other = openFrom(state, BINDING_B);
    expect(other.phase).not.toBe("purged");
    expect(other.draft?.text).toBe("words");
    // The first installation is still blocked, in any project view.
    expect(run(other, { type: "open-lesson", scope: SCOPE_WORLD, binding: BINDING, key: INBOX_KEY }).phase).toBe("purged");
    // And the same capture id in another installation opens normally.
    const capture = run(
      run(initialLessonEditor(), { type: "hydrate", snapshot: emptySnapshot({ tombstones: [tgt(CAPTURE_KEY)] }) }),
      { type: "open-capture", scope: SCOPE, binding: BINDING_B, recordId: RECORD_ID, source: SOURCE },
    );
    expect(capture.phase).toBe("idle");
  });
});

describe("review fix: bounds refuse visibly and never evict", () => {
  test("a purge with a full tombstone list still clears content and then fails closed", () => {
    const full = Array.from({ length: 256 }, (_, i) => tgt({ world: "Koleżka", kind: "inbox", id: `old-${i}` }));
    let state = run(initialLessonEditor(), { type: "hydrate", snapshot: emptySnapshot({ tombstones: full }) });
    state = run(openFrom(state), { type: "submit", requestId: REQ1, intent: { kind: "purge", confirmed: true } });
    const purged = run(state, purgedReceipt(state.generation, REQ1, tgt(INBOX_KEY)));
    expect(purged.phase).toBe("purged");
    expect(purged.draft).toBeNull();
    expect(purged.loaded).toBeNull();
    expect(purged.tombstones).toEqual(full);
    expect(purged.tombstonesSaturated).toBe(true);
    expect(purged.error).toEqual({ code: "EDITOR_SATURATED", fields: ["tombstones"] });

    // No open can prove it is not the forgotten record.
    const refused = run(purged, { type: "open-lesson", scope: SCOPE, binding: BINDING, key: INBOX_KEY });
    expect(refused.target).toEqual(purged.target);
    expect(refused.phase).toBe("purged");
    expect(refused.error?.code).toBe("EDITOR_SATURATED");
    expect(run(purged, { type: "open-capture", scope: SCOPE, binding: BINDING_B, recordId: RECORD_ID, source: SOURCE }).error?.code).toBe("EDITOR_SATURATED");
    expect(run(purged, { type: "close" }).target).toBeNull();

    // The saturation survives a refresh.
    const snap = JSON.parse(JSON.stringify(snapshotLessonEditor(purged)));
    expect(snap.tombstonesSaturated).toBe(true);
    const rehydrated = run(initialLessonEditor(), { type: "hydrate", snapshot: snap });
    expect(run(rehydrated, { type: "open-lesson", scope: SCOPE, binding: BINDING_B, key: INBOX_KEY }).error?.code).toBe("EDITOR_SATURATED");
  });

  test("navigation that would overflow unresolved ids is refused with the pending write kept", () => {
    const full = Array.from({ length: 64 }, (_, i) => ({
      requestId: requestIdFor(i),
      binding: BINDING,
      scope: SCOPE,
      key: { world: "Koleżka", kind: "inbox", id: `p-${i}` } as LessonKey,
    }));
    let state = run(initialLessonEditor(), { type: "hydrate", snapshot: emptySnapshot({ unresolved: full }) });
    state = run(openFrom(state), { type: "submit", requestId: REQ1, intent: { kind: "important", value: true } });
    const refused = run(state, { type: "close" });
    expect(refused.error).toEqual({ code: "EDITOR_SATURATED", fields: ["unresolved"] });
    expect(refused.target).toEqual(state.target);
    expect(refused.pending?.requestId).toBe(REQ1);
    expect(refused.unresolved).toEqual(full);
    expect(refused.generation).toBe(state.generation);

    // Dirty path: the confirmed discard is refused the same way and the draft survives.
    const dirty = run(state, { type: "edit-text", text: "keep me" }, { type: "close" }, { type: "discard" });
    expect(dirty.error?.code).toBe("EDITOR_SATURATED");
    expect(dirty.draft?.text).toBe("keep me");

    // Once one abandoned request settles, the navigation goes through.
    const first = full[0]!;
    const settled = run(refused, committed({ ...refused, generation: 0 }, first.requestId, first.key, 1, tgt(first.key)));
    expect(settled.unresolved).toHaveLength(63);
    const closed = run(settled, { type: "close" });
    expect(closed.target).toBeNull();
    expect(closed.unresolved).toHaveLength(64);
    expect(closed.unresolved.at(-1)?.requestId).toBe(REQ1);
  });

  test("over-bound snapshots are rejected, never trimmed", () => {
    const unresolved = Array.from({ length: 65 }, (_, i) => ({ requestId: requestIdFor(i), binding: BINDING, scope: SCOPE, key: INBOX_KEY }));
    const tombstones = Array.from({ length: 257 }, (_, i) => tgt({ world: "Koleżka", kind: "inbox", id: `t-${i}` }));
    for (const snapshot of [emptySnapshot({ unresolved }), emptySnapshot({ tombstones })]) {
      const state = run(initialLessonEditor(), { type: "hydrate", snapshot });
      expect(state.error?.code).toBe("INVALID_INPUT");
      expect(state.unresolved).toEqual([]);
      expect(state.tombstones).toEqual([]);
    }
  });
});

describe("authority regression RED", () => {
  test("mismatch cannot be erased by editing and submitting", () => {
    let state = run(initialLessonEditor(), { type: "store-resolved", resolution: LINK });
    state = openFrom(state, LOCATION);
    expect(state.draft?.text).toBe("words");
    state = run(state, { type: "store-resolved", resolution: { location: LINK.location, installation: BINDING_B as typeof BINDING } });
    expect(state.error?.code).toBe("INSTALLATION_MISMATCH");
    state = run(state, { type: "edit-text", text: "replacement write" }, { type: "submit", requestId: REQ1, intent: { kind: "save" } });
    expect(state.pending).toBeNull();
  });

  test("cached links cannot authorize a content-bearing completion", () => {
    const snapshot = emptySnapshot({ target: tgt(INBOX_KEY), mode: "existing", tombstones: [tgt(INBOX_KEY, SCOPE, LOCATION)] });
    const held = run(initialLessonEditor(), { type: "hydrate", snapshot });
    expect(held.error?.code).toBe("STORE_UNRESOLVED");
    let state = run(initialLessonEditor(), { type: "hydrate", snapshot: { ...snapshot, resolutions: [{ location: LINK.location, installation: BINDING_B }] } });
    state = run(state, { type: "loaded", generation: state.generation, target: tgt(INBOX_KEY), view: view(3, "old content") });
    expect(state.draft).toBeNull();
  });
});

// Review round 2: one store can be addressed by its location before bootstrap and by its
// installation after. Only an explicit store resolution links them.
const LOCATION: StoreBinding = { kind: "location", id: "d".repeat(64) };
const LOCATION_2: StoreBinding = { kind: "location", id: "e".repeat(64) };
const LINK = { location: { kind: "location", id: LOCATION.id }, installation: { kind: "installation", id: BINDING.id } } as const;

function abandonedPurgeAt(state: LessonEditorState, binding: StoreBinding): { state: LessonEditorState; gen: number } {
  const purging = run(openFrom(state, binding), { type: "submit", requestId: REQ1, intent: { kind: "purge", confirmed: true } });
  return { state: run(purging, { type: "close" }), gen: purging.generation };
}

const EPOCH = "connection-1";
function observation(binding: StoreBinding = LOCATION, installationId: string | null = BINDING.id, pinnedLocationRetry = true): LessonHostObservation {
  return { connectionEpoch: EPOCH, binding, installationId, pinnedLocationRetry };
}
function proof(event: LessonEditorEvent, installationId: string | null = BINDING.id, operation: LessonHostResult["operation"] = "read"): LessonHostResult {
  if (!("target" in event) || !("generation" in event)) throw new Error("Host proof requires an operation event");
  return { connectionEpoch: EPOCH, target: event.target, generation: event.generation, installationId, operation,
    ...("requestId" in event ? { requestId: event.requestId } : {}) };
}
function liveEditor(capture = false, installationId: string | null = BINDING.id): LessonEditorController {
  const editor = new LessonEditorController();
  editor.connect(EPOCH);
  editor.observe(observation(LOCATION, installationId));
  editor.dispatch(capture ? { type: "open-capture", scope: SCOPE, binding: LOCATION, recordId: RECORD_ID, source: SOURCE }
    : { type: "open-lesson", scope: SCOPE, binding: LOCATION, key: INBOX_KEY });
  return editor;
}
function readEditor(editor: LessonEditorController, revision = 3, text = "words", installationId: string = BINDING.id): void {
  const state = editor.state;
  if (!state.target) throw new Error("Missing read target");
  const event: LessonEditorEvent = { type: "loaded", generation: state.generation, target: state.target,
    view: view(revision, text, { key: state.target.key, scope: state.target.scope }) };
  editor.dispatch(event, proof(event, installationId));
}
function pendingEvent(editor: LessonEditorController, outcome: "unknown" | "committed" | "purged" = "committed"): LessonEditorEvent {
  const pending = editor.state.pending;
  if (!pending) throw new Error("Missing pending request");
  const target = { binding: pending.binding, scope: pending.scope, key: pending.key };
  if (outcome === "purged") return purgedReceipt(pending.generation, pending.requestId, target);
  if (outcome === "unknown") return { type: "receipt", generation: pending.generation, requestId: pending.requestId, target,
    receipt: { state: "unknown", requestId: pending.requestId } };
  return committed({ ...editor.state, generation: pending.generation }, pending.requestId, pending.key, 4, target);
}

describe("private live authority and latched quarantine", () => {
  test("dirty mismatch hides content and survives edits, navigation, discard and rebase until a fresh matching read", () => {
    const editor = liveEditor();
    readEditor(editor);
    expect(editor.state.draft?.text).toBe("words");
    editor.dispatch({ type: "edit-text", text: "keep my wording" });
    const old = editor.state;
    editor.observe(observation(LOCATION, BINDING_B.id));
    expect(editor.state.gate).toBe("mismatch");
    for (const event of [{ type: "edit-text", text: "wrong store" }, { type: "close" }, { type: "discard" }, { type: "rebase" },
      { type: "open-lesson", scope: SCOPE, binding: BINDING_B, key: INBOX_KEY },
      { type: "submit", requestId: REQ1, intent: { kind: "save" } }] as LessonEditorEvent[]) editor.dispatch(event);
    expect(editor.state.draft).toBeNull();
    expect(editor.state.base).toBeNull();
    expect(editor.state.loaded).toBeNull();
    expect(editor.state.pending).toBeNull();
    expect(editor.exportForRestore().draft?.text).toBe("keep my wording");
    const late: LessonEditorEvent = { type: "loaded", generation: old.generation, target: old.target!, view: view(5, "late words") };
    editor.dispatch(late, proof(late));
    expect(editor.state.draft).toBeNull();
    editor.observe(observation());
    expect(editor.state.gate).toBe("reading");
    expect(editor.state.draft).toBeNull();
    readEditor(editor, 5, "host changed");
    expect(editor.state.draft?.text).toBe("keep my wording");
    expect(editor.state.base?.revision).toBe(3);
    expect(isLessonEditorStale(editor.state)).toBe(true);
  });

  test("pending mismatch keeps original ID and bytes; a correct late receipt settles without unlocking", () => {
    const editor = liveEditor();
    readEditor(editor);
    editor.dispatch({ type: "edit-text", text: "pending words" });
    editor.dispatch({ type: "submit", requestId: REQ1, intent: { kind: "save" } });
    const bytes = JSON.stringify(editor.prepare(REQ1).mutation);
    const event = pendingEvent(editor);
    editor.observe(observation(LOCATION, BINDING_B.id));
    expect(curationError(() => editor.prepare(REQ1)).code).toBe("INSTALLATION_MISMATCH");
    const rejected: LessonEditorEvent = { type: "rejected", generation: editor.state.pending!.generation, requestId: REQ1,
      target: editor.state.pending!, code: "INSTALLATION_MISMATCH", fields: [] };
    editor.dispatch(rejected, proof(rejected, BINDING_B.id, "mutation"));
    editor.dispatch({ type: "close" });
    editor.dispatch({ type: "discard" });
    expect(editor.state.pending?.requestId).toBe(REQ1);
    expect(JSON.stringify(editor.exportForRestore().pending?.mutation)).toBe(bytes);
    editor.dispatch(event, proof(event, BINDING.id, "mutation"));
    expect(editor.state.pending).toBeNull();
    expect(editor.state.gate).toBe("mismatch");
    expect(editor.state.draft).toBeNull();
    expect(editor.state.expectedInstallation).toBe(BINDING.id);
  });

  test("honest and forged cached links and ready flags do not import authority", () => {
    const editor = liveEditor();
    readEditor(editor);
    editor.dispatch({ type: "edit-text", text: "native dirty text" });
    const native = editor.exportForRestore();
    for (const installation of [BINDING, BINDING_B]) {
      const resumed = new LessonEditorController();
      resumed.connect(EPOCH);
      resumed.dispatch({ type: "restore", state: { ...native, gate: "ready", resolutions: [{ location: LINK.location, installation }] } });
      expect(resumed.state.gate).toBe("unverified");
      expect(resumed.state.draft).toBeNull();
      expect(resumed.exportForRestore().draft?.text).toBe("native dirty text");
      readEditor(resumed);
      expect(resumed.state.draft).toBeNull();
      resumed.observe(observation());
      expect(resumed.state.draft).toBeNull();
      readEditor(resumed);
      expect(resumed.state.draft?.text).toBe("native dirty text");
      // Changing a published projection cannot change the private runtime.
      const projection = resumed.state;
      projection.expectedInstallation = BINDING_B.id;
      projection.draft!.text = "tampered";
      expect(resumed.state.draft?.text).toBe("native dirty text");
      expect(resumed.state.expectedInstallation).toBe(BINDING.id);
    }
    const browser = new LessonEditorController();
    browser.connect(EPOCH);
    browser.dispatch({ type: "hydrate", snapshot: editor.snapshot() });
    expect(browser.state.gate).toBe("unverified");
    readEditor(browser);
    expect(browser.state.draft).toBeNull();
  });

  test("a restored uncommitted capture stays hidden until a fresh detail result confirms absence", () => {
    const editor = liveEditor(true);
    editor.dispatch({ type: "edit-text", text: "native capture draft" });
    const resumed = new LessonEditorController();
    resumed.connect(EPOCH);
    resumed.dispatch({ type: "restore", state: editor.exportForRestore() });
    resumed.observe(observation());
    expect(resumed.state.draft).toBeNull();
    expect(resumed.exportForRestore().draft?.text).toBe("native capture draft");
    const absent: LessonEditorEvent = { type: "detail-missing", generation: resumed.state.generation, target: resumed.state.target! };
    resumed.dispatch(absent, proof(absent));
    expect(resumed.state.draft?.text).toBe("native capture draft");
    expect(resumed.state.mode).toBe("capture");
  });

  test("restored expected installation never bootstraps into missing or replacement storage", () => {
    const editor = liveEditor();
    readEditor(editor);
    editor.dispatch({ type: "edit-text", text: "retained" });
    for (const installationId of [null, BINDING_B.id]) {
      const resumed = new LessonEditorController();
      resumed.connect(EPOCH);
      resumed.dispatch({ type: "restore", state: editor.exportForRestore() });
      resumed.observe(observation(LOCATION, installationId));
      expect(resumed.state.gate).toBe("mismatch");
      resumed.dispatch({ type: "submit", requestId: REQ1, intent: { kind: "save" } });
      expect(resumed.state.pending).toBeNull();
      expect(resumed.exportForRestore().draft?.text).toBe("retained");
      expect(resumed.state.expectedInstallation).toBe(BINDING.id);
    }
  });

  test("disconnect cannot unlatch mismatch or permit navigation into the replacement", () => {
    const editor = liveEditor();
    readEditor(editor);
    editor.dispatch({ type: "edit-text", text: "preserved across reconnect" });
    editor.observe(observation(LOCATION, BINDING_B.id));
    editor.connect("new-epoch");
    editor.dispatch({ type: "open-lesson", scope: SCOPE, binding: BINDING_B, key: INBOX_KEY });
    editor.dispatch({ type: "discard" });
    expect(editor.state.gate).toBe("mismatch");
    expect(editor.state.expectedInstallation).toBe(BINDING.id);
    expect(editor.exportForRestore().draft?.text).toBe("preserved across reconnect");
  });

  test("import cannot replace an active editor and silently drop its outstanding identities", () => {
    const editor = liveEditor();
    readEditor(editor);
    editor.dispatch({ type: "edit-text", text: "keep active" });
    editor.dispatch({ type: "submit", requestId: REQ1, intent: { kind: "save" } });
    editor.dispatch({ type: "hydrate", snapshot: emptySnapshot() });
    expect(editor.state.pending?.requestId).toBe(REQ1);
    expect(editor.exportForRestore().draft?.text).toBe("keep active");
  });

  test("wrong epoch and unproven result cannot establish content authority", () => {
    const editor = liveEditor();
    const event: LessonEditorEvent = { type: "loaded", generation: editor.state.generation, target: editor.state.target!, view: view(3, "verified") };
    editor.dispatch(event);
    expect(editor.state.draft).toBeNull();
    editor.dispatch(event, { ...proof(event), connectionEpoch: "old-connection" });
    expect(editor.state.draft).toBeNull();
    editor.dispatch(event, proof(event));
    expect(editor.state.draft?.text).toBe("verified");
    editor.connect("connection-2");
    editor.observe(observation());
    expect(editor.state.gate).toBe("unverified");
    editor.dispatch(event, proof(event));
    expect(editor.state.draft).toBeNull();
  });
});

describe("origin-bound preparation", () => {
  test("initialized revision-zero inbox writes are installation-bound before the payload is frozen", () => {
    const editor = liveEditor();
    readEditor(editor, 0, "source wording");
    editor.dispatch({ type: "edit-text", text: "new wording" });
    editor.dispatch({ type: "submit", requestId: REQ1, intent: { kind: "save" } });
    const prepared = editor.prepare(REQ1);
    expect(prepared.mutation.binding).toEqual(BINDING);
    expect(prepared.mutation.expectedRevision).toBe(0);
    expect(prepared.precondition).toEqual(BINDING);
    expect(editor.state.target?.binding).toEqual(BINDING);
    expect(editor.state.pending?.mutation).toBeNull();
    // Inspection cannot authorize a body-only write if storage changes before execution.
    expect(prepared.mutation.binding).not.toEqual(BINDING_B);
    expect(prepared.precondition).not.toEqual(BINDING_B);
  });

  test("a real bootstrap retains exact bytes and requires the host's same-handle precondition for retry", () => {
    const editor = liveEditor(true, null);
    editor.dispatch({ type: "edit-text", text: "bootstrap words" });
    editor.dispatch({ type: "submit", requestId: REQ1, intent: { kind: "save" } });
    const first = editor.prepare(REQ1);
    expect(first.precondition).toEqual({ kind: "uninitialized", locationId: LOCATION.id });
    const bytes = JSON.stringify(first.mutation);
    const unknown = pendingEvent(editor, "unknown");
    // The mutation's actual handle proves origin even when commit status is unknown.
    editor.dispatch(unknown, proof(unknown, BINDING.id, "mutation"));
    expect(editor.state.pending?.installationId).toBe(BINDING.id);
    editor.observe(observation(LOCATION, BINDING.id, false));
    expect(curationError(() => editor.prepare(REQ1)).fields).toContain("pinnedLocationRetry");
    editor.observe(observation());
    const retry = editor.prepare(REQ1);
    expect(JSON.stringify(retry.mutation)).toBe(bytes);
    expect(retry.precondition).toEqual(BINDING);
    const committedEvent = pendingEvent(editor);
    editor.dispatch(committedEvent, proof(committedEvent, BINDING.id, "mutation"));
    editor.dispatch({ type: "edit-text", text: "later wording" });
    editor.dispatch({ type: "submit", requestId: REQ2, intent: { kind: "save" } });
    expect(editor.prepare(REQ2).mutation.binding).toEqual(BINDING);
  });

  test("restored pending origin must agree with the editor's retained installation constraint", () => {
    const editor = liveEditor(true, null);
    editor.dispatch({ type: "edit-text", text: "bootstrap" });
    editor.dispatch({ type: "submit", requestId: REQ1, intent: { kind: "save" } });
    const unknown = pendingEvent(editor, "unknown");
    editor.dispatch(unknown, proof(unknown, BINDING.id, "mutation"));
    const native = editor.exportForRestore();
    native.pending!.installationId = BINDING_B.id;
    const resumed = new LessonEditorController();
    resumed.dispatch({ type: "restore", state: native });
    expect(resumed.state.error?.code).toBe("INVALID_INPUT");
    expect(resumed.state.pending).toBeNull();
    const snapshot = editor.snapshot();
    snapshot.pendingIdentity!.installationId = BINDING_B.id;
    resumed.dispatch({ type: "hydrate", snapshot });
    expect(resumed.state.error?.code).toBe("INVALID_INPUT");
    expect(resumed.state.pending).toBeNull();
  });

  test("a current handshake or unknown receipt cannot assign origin to a bootstrap with no history", () => {
    const editor = liveEditor(true, null);
    editor.dispatch({ type: "edit-text", text: "uncertain" });
    editor.dispatch({ type: "submit", requestId: REQ1, intent: { kind: "save" } });
    editor.prepare(REQ1);
    const unknown = pendingEvent(editor, "unknown");
    editor.dispatch(unknown, proof(unknown, BINDING_B.id, "receipt"));
    editor.observe(observation(LOCATION, BINDING_B.id));
    expect(editor.state.pending?.installationId).toBeUndefined();
    expect(editor.state.expectedInstallation).toBeNull();
    expect(curationError(() => editor.prepare(REQ1)).code).toBe("INSTALLATION_MISMATCH");
    const resumed = new LessonEditorController();
    resumed.connect(EPOCH);
    resumed.dispatch({ type: "hydrate", snapshot: editor.snapshot() });
    resumed.observe(observation(LOCATION, BINDING_B.id));
    expect(resumed.state.pending?.installationId).toBeUndefined();
    expect(resumed.state.pending?.mutation).toBeNull();
    expect(curationError(() => resumed.prepare(REQ1)).code).toBe("INVALID_INPUT");
  });

  test("legacy location-only tombstones and unresolved IDs remain conservative after a fresh replacement handshake", () => {
    for (const field of ["tombstones", "unresolved"] as const) {
      const historical = field === "tombstones" ? [tgt(INBOX_KEY, SCOPE, LOCATION)] : [{ ...tgt(INBOX_KEY, SCOPE, LOCATION), requestId: REQ1 }];
      const editor = new LessonEditorController();
      editor.connect(EPOCH);
      editor.dispatch({ type: "hydrate", snapshot: emptySnapshot({ target: tgt(INBOX_KEY, SCOPE, BINDING_B), mode: "existing",
        [field]: historical, resolutions: [{ location: LINK.location, installation: BINDING_B }] }) });
      editor.observe(observation(LOCATION, BINDING_B.id));
      readEditor(editor, 3, "replacement content", BINDING_B.id);
      expect(editor.state.draft).toBeNull();
      expect(editor.state[field][0]?.installationId).toBeUndefined();
      expect(editor.state[field]).toEqual(historical);
    }
  });

  test("proven bootstrap origin survives navigation and a late purge clears every project view", () => {
    const editor = liveEditor(true, null);
    editor.dispatch({ type: "edit-text", text: "bootstrap" });
    editor.dispatch({ type: "submit", requestId: REQ1, intent: { kind: "save" } });
    const unknown = pendingEvent(editor, "unknown");
    const latePurge = pendingEvent(editor, "purged");
    editor.dispatch(unknown, proof(unknown, BINDING.id, "mutation"));
    editor.observe(observation());
    editor.dispatch({ type: "close" });
    editor.dispatch({ type: "discard" });
    expect(editor.state.unresolved[0]?.installationId).toBe(BINDING.id);
    expect(editor.state.unresolved[0]?.binding).toEqual(LOCATION);
    editor.dispatch({ type: "open-lesson", binding: BINDING, scope: SCOPE_WORLD, key: CAPTURE_KEY });
    readEditor(editor, 1, "committed words");
    expect(editor.state.draft?.text).toBe("committed words");
    editor.dispatch(latePurge, proof(latePurge, BINDING.id, "receipt"));
    expect(editor.state.phase).toBe("purged");
    expect(editor.state.draft).toBeNull();
    expect(editor.state.unresolved).toEqual([]);
    expect(editor.state.tombstones[0]?.installationId).toBe(BINDING.id);
  });

  test("a legacy location tombstone is an unresolved hold, not proof the current location record was purged", () => {
    const editor = new LessonEditorController();
    editor.connect(EPOCH);
    editor.dispatch({ type: "hydrate", snapshot: emptySnapshot({ tombstones: [tgt(INBOX_KEY, SCOPE, LOCATION)] }) });
    editor.observe(observation(LOCATION, BINDING_B.id));
    editor.dispatch({ type: "open-lesson", scope: SCOPE, binding: LOCATION, key: INBOX_KEY });
    expect(editor.state.phase).not.toBe("purged");
    expect(editor.state.error?.code).toBe("STORE_UNRESOLVED");
    expect(editor.state.tombstones[0]?.installationId).toBeUndefined();
    expect(editor.state.draft).toBeNull();
  });

  test("legacy hints retain bounds and never become imported authority", () => {
    const full = Array.from({ length: 64 }, (_, i) => ({ location: { kind: "location" as const, id: i.toString(16).padStart(64, "0") }, installation: BINDING }));
    const imported = run(initialLessonEditor(), { type: "hydrate", snapshot: emptySnapshot({ resolutions: full }) });
    expect(imported.resolutions).toEqual(full);
    expect(imported.gate).toBe("unverified");
    for (const resolutions of [[...full, LINK], [LINK, LINK]]) {
      expect(run(initialLessonEditor(), { type: "hydrate", snapshot: emptySnapshot({ resolutions }) }).error?.code).toBe("INVALID_INPUT");
    }
  });
});

describe("round 2: receipt payload, purged restore and reserved ids", () => {
  test("an abandoned receipt naming another key is refused and the identity is kept", () => {
    const { state, gen } = abandonedPurgeAt(initialLessonEditor(), BINDING);
    const reopened = openFrom(state);
    const other = { world: "Koleżka", kind: "inbox", id: "other" } as const;
    const wrong: LessonEditorEvent = {
      type: "receipt",
      generation: gen,
      requestId: REQ1,
      target: tgt(INBOX_KEY),
      receipt: { state: "purged", requestId: REQ1, key: other, startedAt: STAMP, finishedAt: STAMP },
    };
    const refused = run(reopened, wrong);
    expect(refused.error).toEqual({ code: "INVALID_INPUT", fields: ["receipt.key"] });
    expect(refused.phase).not.toBe("purged");
    expect(refused.draft?.text).toBe("words");
    expect(refused.unresolved).toHaveLength(1);
    expect(refused.tombstones).toEqual([]);
    // The matching answer, old generation and all, still settles it.
    expect(run(refused, purgedReceipt(gen, REQ1, tgt(INBOX_KEY))).phase).toBe("purged");
  });

  test("a purged restored state must carry its tombstone or a failed-closed list", () => {
    let purged = run(openFrom(initialLessonEditor()), { type: "submit", requestId: REQ1, intent: { kind: "purge", confirmed: true } });
    purged = run(purged, purgedReceipt(purged.generation, REQ1, tgt(INBOX_KEY)));
    const json = JSON.parse(JSON.stringify(purged));
    expect(run(initialLessonEditor(), { type: "restore", state: json }).error).toBeNull();

    const stripped = { ...json, tombstones: [], tombstonesSaturated: false };
    const rejected = run(initialLessonEditor(), { type: "restore", state: stripped });
    expect(rejected.error?.code).toBe("INVALID_INPUT");
    // Nothing from the rewritten copy is adopted; the adapter must reload from the host.
    expect(rejected.target).toBeNull();
    expect(rejected.phase).toBe("idle");

    const failedClosed = run(initialLessonEditor(), { type: "restore", state: { ...stripped, tombstonesSaturated: true } });
    expect(failedClosed.error).toBeNull();
    expect(failedClosed.phase).toBe("purged");

    expect(run(initialLessonEditor(), { type: "restore", state: { ...json, target: null, mode: null } }).error?.code).toBe("INVALID_INPUT");
  });

  test("unknown historical origin keeps restored drafts behind a hold even with cached links", () => {
    const live = JSON.parse(JSON.stringify(run(openExisting(), { type: "edit-text", text: "keep private" })));
    live.tombstones = [tgt(INBOX_KEY, SCOPE, LOCATION)];
    for (const resolutions of [[], [LINK]]) {
      const held = run(initialLessonEditor(), { type: "restore", state: { ...live, resolutions } });
      expect(held.error?.code).toBe("STORE_UNRESOLVED");
      expect(held.draft?.text).toBe("keep private");
      expect(projectLessonEditor(held).draft).toBeNull();
      expect(projectLessonEditor(verifyFixture(held)).draft).toBeNull();
    }
  });

  test("an unresolved request id is reserved on every key, below and at capacity", () => {
    const other = { world: "Koleżka", kind: "inbox", id: "other" } as const;
    let state = run(openFrom(initialLessonEditor()), { type: "submit", requestId: REQ1, intent: { kind: "important", value: true } });
    state = openFrom(run(state, { type: "close" }), BINDING, SCOPE, other);
    const reused = run(state, { type: "submit", requestId: REQ1, intent: { kind: "important", value: true } });
    expect(reused.pending).toBeNull();
    expect(reused.error).toEqual({ code: "INVALID_INPUT", fields: ["requestId"] });
    expect(run(state, { type: "submit", requestId: REQ2, intent: { kind: "important", value: true } }).pending?.requestId).toBe(REQ2);

    const full = Array.from({ length: 64 }, (_, i) => ({
      requestId: requestIdFor(i),
      binding: BINDING,
      scope: SCOPE,
      key: { world: "Koleżka", kind: "inbox", id: `p-${i}` } as LessonKey,
    }));
    const atCap = openFrom(run(initialLessonEditor(), { type: "hydrate", snapshot: emptySnapshot({ unresolved: full }) }));
    const capReuse = run(atCap, { type: "submit", requestId: requestIdFor(63), intent: { kind: "important", value: true } });
    expect(capReuse.pending).toBeNull();
    expect(capReuse.error?.fields).toEqual(["requestId"]);
    expect(capReuse.unresolved).toEqual(full);
  });
});

describe("pure module", () => {
  test("the import closure stays native-safe and free of I/O, clocks and randomness", () => {
    const BANNED = [
      'from "node:',
      "from 'node:",
      "process.",
      "Bun.",
      "require(",
      'from "zod"',
      "lesson-curation-schema",
      "sensitive-text",
      "Date",
      "Math.random",
      "crypto",
      "window",
      "document",
      "localStorage",
      "sessionStorage",
      "fetch(",
      "setTimeout",
      "structuredClone",
    ];
    const text = readFileSync(join(REPO_ROOT, "packages/core/src/lesson-curation-ui.ts"), "utf8");
    expect(BANNED.filter((banned) => text.includes(banned))).toEqual([]);

    // The whole relative closure stays native-safe, like the lesson-curation subpath.
    const CLOSURE_BANNED = ['from "node:', "from 'node:", "process.env", "Bun.", "require(", 'from "zod"', "lesson-curation-schema"];
    const seen = new Set<string>();
    const queue = ["lesson-curation-ui.ts"];
    const offenders: string[] = [];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(join(REPO_ROOT, "packages/core/src", file), "utf8");
      for (const banned of CLOSURE_BANNED) if (source.includes(banned)) offenders.push(`${file}: ${banned}`);
      for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = match[1]!;
        if (spec.startsWith("./")) queue.push(spec.slice(2));
        else offenders.push(`${file}: non-relative import ${spec}`);
      }
    }
    expect(seen.has("lesson-curation.ts")).toBe(true);
    expect(offenders).toEqual([]);
  });

  test("core exports the ui subpath", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "packages/core/package.json"), "utf8")) as { exports: Record<string, string> };
    expect(pkg.exports["./lesson-curation-ui"]).toBe("./src/lesson-curation-ui.ts");
  });
});
