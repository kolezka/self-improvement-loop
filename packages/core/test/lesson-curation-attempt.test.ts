// Per-attempt correlation for mutation outcomes that carry no executing store.
// A request id is not an attempt id; nothing here may invent store identity.

import { describe, expect, test } from "bun:test";
import type { CurationTransportReceipt, ExecutingStore } from "../src/control-mutation.ts";
import { CurationError, type CaptureSource, type LessonKey, type LessonScope, type LessonView, type StoreBinding } from "../src/lesson-curation.ts";
import {
  LessonEditorController,
  type LessonAttemptToken,
  type LessonEditorEvent,
  type LessonEditorTarget,
  type LessonHostObservation,
  type LessonHostResult,
} from "../src/lesson-curation-ui.ts";

const EPOCH = "epoch-1";
const EPOCH_2 = "epoch-2";
const I = "5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716";
const J = "22222222-2222-4222-8222-222222222222";
const LOCATION: StoreBinding = { kind: "location", id: "d".repeat(64) };
const PINNED: StoreBinding = { kind: "installation", id: I };
const SCOPE: LessonScope = { world: "Koleżka", project: { kind: "world" } };
const RECORD_ID = "0b7c6f1e-4d1a-4c3b-9a55-2f1e8d7c6b5a";
const KEY: LessonKey = { world: "Koleżka", kind: "capture", id: RECORD_ID };
const OTHER_KEY: LessonKey = { world: "Koleżka", kind: "capture", id: "1b7c6f1e-4d1a-4c3b-9a55-2f1e8d7c6b5a" };
const REQ1 = "lc_6a1e2f3d-8c4b-4e5a-b7f6-0d9c8b7a6e5f";
const REQ2 = "lc_11111111-2222-4333-8444-555555555555";
const DRAFT = "SENTINEL unsent wording";
const STAMP = "2026-10-22T10:00:00.000Z";
const SOURCE: CaptureSource = {
  kind: "explicit_quote",
  quote: "SENTINEL quoted line",
  reference: null,
  quoteRedacted: false,
  captureSessionId: null,
  sourceConversationId: null,
  sourceRowId: null,
  sourceAgentId: null,
};

const observation = (installationId: string | null, epoch = EPOCH): LessonHostObservation => ({
  connectionEpoch: epoch,
  binding: LOCATION,
  installationId,
  pinnedLocationRetry: true,
});

function view(revision: number, text: string): LessonView {
  return {
    key: KEY,
    scope: SCOPE,
    revision,
    important: false,
    effectiveText: text,
    originalText: null,
    source: SOURCE,
    sourceStatus: "saved",
    sourceDigest: null,
    baselineDigest: null,
    relatedPattern: null,
    created: STAMP,
    updated: STAMP,
  };
}

function read(editor: LessonEditorController, revision: number, text: string, epoch = EPOCH): void {
  const target = editor.state.target!;
  const event: LessonEditorEvent = { type: "loaded", generation: editor.state.generation, target, view: view(revision, text) };
  editor.dispatch(event, { operation: "read", connectionEpoch: epoch, generation: event.generation, target, installationId: I });
}

/** Committed record at installation I, loaded, edited and submitted as REQ1. */
function editing(): LessonEditorController {
  const editor = new LessonEditorController();
  editor.connect(EPOCH);
  editor.observe(observation(I));
  editor.dispatch({ type: "open-lesson", scope: SCOPE, binding: PINNED, key: KEY });
  read(editor, 3, "saved words");
  editor.dispatch({ type: "edit-text", text: DRAFT });
  editor.dispatch({ type: "submit", requestId: REQ1, intent: { kind: "save" } });
  expect(editor.state.phase).toBe("saving");
  return editor;
}

/** First capture into a store that does not exist yet. */
function bootstrapping(): LessonEditorController {
  const editor = new LessonEditorController();
  editor.connect(EPOCH);
  editor.observe(observation(null));
  editor.dispatch({ type: "open-capture", scope: SCOPE, binding: LOCATION, recordId: RECORD_ID, source: SOURCE });
  editor.dispatch({ type: "edit-text", text: DRAFT });
  editor.dispatch({ type: "submit", requestId: REQ1, intent: { kind: "save" } });
  expect(editor.state.phase).toBe("saving");
  return editor;
}

function completed(requestId: string, key: LessonKey = KEY, revision = 4): CurationTransportReceipt {
  return { requestId, payloadHash: "c".repeat(64), state: "completed", result: { key, revision, changed: true }, error: null, startedAt: STAMP, finishedAt: STAMP };
}
function purged(requestId: string): CurationTransportReceipt {
  return { requestId, state: "purged", payloadHash: null, result: null, error: null, startedAt: STAMP, finishedAt: STAMP };
}
const store = (installationId = I, locationId = LOCATION.id): ExecutingStore => ({ locationId, installationId });
const refused = (code: string) => ({ kind: "refused" as const, code, fields: [] });

function curationError(fn: () => unknown): CurationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CurationError) return error;
    throw error;
  }
  throw new Error("expected a CurationError");
}

function noDraftPersisted(editor: LessonEditorController): void {
  expect(JSON.stringify(editor.snapshot())).not.toContain("SENTINEL");
}

describe("attempt tokens", () => {
  test("prepare stays pure and repeatable; a second open attempt for the same request is refused", () => {
    const editor = editing();
    const a = editor.prepare(REQ1);
    const b = editor.prepare(REQ1);
    expect(b).toEqual(a);
    expect(editor.sending).toBe(false);
    const { token, prepared } = editor.beginAttempt(REQ1);
    expect(prepared).toEqual(a);
    expect(editor.sending).toBe(true);
    expect(curationError(() => editor.beginAttempt(REQ1)).fields).toEqual(["inFlight"]);
    expect(editor.prepare(REQ1)).toEqual(a);
    editor.finishAttempt(token, { kind: "unknown" });
    expect(editor.sending).toBe(false);
  });

  test("a late first completion cannot settle or unlock a retry of the same request", () => {
    const editor = editing();
    const first = editor.beginAttempt(REQ1);
    editor.finishAttempt(first.token, { kind: "unknown" });
    expect(editor.state.phase).toBe("unknown");
    const retry = editor.beginAttempt(REQ1);
    expect(retry.token).not.toBe(first.token);
    expect(retry.prepared).toEqual(first.prepared);
    editor.finishAttempt(first.token, refused("CURATION_CONFLICT"));
    editor.finishAttempt(first.token, { kind: "success", store: store(), receipt: completed(REQ1) });
    expect(editor.state.phase).toBe("unknown");
    expect(editor.state.pending?.requestId).toBe(REQ1);
    expect(editor.sending).toBe(true);
    expect(curationError(() => editor.beginAttempt(REQ1)).fields).toEqual(["inFlight"]);
    // The retry's own refusal still cannot prove the first attempt did nothing.
    editor.finishAttempt(retry.token, refused("CURATION_CONFLICT"));
    expect(editor.state.phase).toBe("unknown");
    expect(editor.state.pending?.requestId).toBe(REQ1);
    expect(editor.state.error?.code).toBe("CURATION_CONFLICT");
    expect(editor.prepare(REQ1)).toEqual(first.prepared);
    noDraftPersisted(editor);
  });

  test("a generic receipt for another target does not release the open attempt", () => {
    const editor = editing();
    const { token } = editor.beginAttempt(REQ1);
    const target: LessonEditorTarget = { scope: SCOPE, binding: PINNED, key: OTHER_KEY };
    const stray: LessonEditorEvent = {
      type: "receipt",
      generation: editor.state.pending!.generation,
      requestId: REQ1,
      target,
      receipt: { state: "committed", requestId: REQ1, payloadHash: "c".repeat(64), key: OTHER_KEY, revision: 9, changed: true, startedAt: STAMP, finishedAt: STAMP },
    };
    const result: LessonHostResult = { operation: "mutation", connectionEpoch: EPOCH, generation: stray.generation, target, requestId: REQ1, installationId: I };
    editor.dispatch(stray, result);
    expect(editor.state.phase).toBe("saving");
    expect(editor.sending).toBe(true);
    expect(curationError(() => editor.beginAttempt(REQ1)).fields).toEqual(["inFlight"]);
    editor.finishAttempt(token, { kind: "success", store: store(), receipt: completed(REQ1) });
    expect(editor.state.phase).toBe("saved");
  });

  test("tokens are opaque: a lookalike object is not an attempt", () => {
    const editor = editing();
    editor.beginAttempt(REQ1);
    editor.finishAttempt({} as LessonAttemptToken, refused("CURATION_CONFLICT"));
    expect(editor.state.phase).toBe("saving");
    expect(editor.sending).toBe(true);
  });
});

describe("handle-free outcomes on a first attempt", () => {
  test("unknown and undecodable failures never yield saved or new identity", () => {
    for (const outcome of [{ kind: "unknown" as const }, refused("OUTCOME_UNKNOWN"), refused("STORAGE_UNAVAILABLE"), { kind: "nonsense" } as never]) {
      const editor = editing();
      const { token, prepared } = editor.beginAttempt(REQ1);
      editor.finishAttempt(token, outcome);
      expect(editor.state.phase).toBe("unknown");
      expect(editor.state.pending?.requestId).toBe(REQ1);
      expect(editor.state.expectedInstallation).toBe(I);
      expect(editor.prepare(REQ1)).toEqual(prepared);
      editor.dispatch({ type: "submit", requestId: REQ2, intent: { kind: "save" } });
      expect(editor.state.pending?.requestId).toBe(REQ1);
      noDraftPersisted(editor);
    }
  });

  test("a definite refusal of the first attempt returns the draft for correction", () => {
    const editor = editing();
    const { token } = editor.beginAttempt(REQ1);
    editor.finishAttempt(token, refused("CURATION_CONFLICT"));
    expect(editor.state.pending).toBeNull();
    expect(editor.state.phase).toBe("conflict");
    expect(editor.state.error).toEqual({ code: "CURATION_CONFLICT", fields: [] });
    expect(editor.state.draft?.text).toBe(DRAFT);
    expect(editor.state.expectedInstallation).toBe(I);

    const gate = editing();
    const second = gate.beginAttempt(REQ1);
    gate.finishAttempt(second.token, refused("InvalidArgs"));
    expect(gate.state.phase).toBe("error");
    expect(gate.state.error).toEqual({ code: "INVALID_INPUT", fields: ["request"] });
  });

  test("a known-installation mismatch keeps the latch, hides wording and stays dirty", () => {
    const editor = editing();
    const { token } = editor.beginAttempt(REQ1);
    editor.finishAttempt(token, refused("INSTALLATION_MISMATCH"));
    expect(editor.state.gate).toBe("mismatch");
    expect(editor.state.pending).toBeNull();
    expect(editor.state.draft).toBeNull();
    expect(editor.dirty).toBe(true);
    editor.dispatch({ type: "edit-text", text: "other" });
    editor.dispatch({ type: "close" });
    editor.dispatch({ type: "discard" });
    expect(editor.state.gate).toBe("mismatch");
    expect(editor.state.expectedInstallation).toBe(I);
    // Only a matching handshake and a fresh read recover it.
    editor.observe(observation(I));
    expect(editor.state.draft).toBeNull();
    read(editor, 3, "saved words");
    expect(editor.state.gate).toBe("ready");
    expect(editor.state.draft?.text).toBe(DRAFT);
    editor.dispatch({ type: "submit", requestId: REQ2, intent: { kind: "save" } });
    expect(editor.state.pending?.requestId).toBe(REQ2);
  });

  test("a refusal that arrives while quarantined clears the attempt but keeps the latch", () => {
    const editor = editing();
    const { token } = editor.beginAttempt(REQ1);
    // The pinned address now answers with another installation.
    editor.observe({ connectionEpoch: EPOCH, binding: PINNED, installationId: J, pinnedLocationRetry: true });
    expect(editor.state.gate).toBe("mismatch");
    editor.finishAttempt(token, refused("CURATION_CONFLICT"));
    expect(editor.state.pending).toBeNull();
    expect(editor.state.gate).toBe("mismatch");
    expect(editor.state.error?.code).toBe("INSTALLATION_MISMATCH");
  });

  test("a bootstrap mismatch stays unknown and unverified and never adopts the new store", () => {
    const editor = bootstrapping();
    const { token, prepared } = editor.beginAttempt(REQ1);
    expect(prepared.precondition).toEqual({ kind: "uninitialized", locationId: LOCATION.id });
    editor.finishAttempt(token, refused("INSTALLATION_MISMATCH"));
    expect(editor.state.gate).toBe("unverified");
    expect(editor.state.phase).toBe("unknown");
    expect(editor.state.pending?.requestId).toBe(REQ1);
    editor.observe(observation(J));
    expect(editor.state.target?.installationId).toBeUndefined();
    expect(editor.state.expectedInstallation).toBeNull();
    expect(editor.state.draft).toBeNull();
    expect(() => editor.prepare(REQ1)).toThrow(CurationError);
    expect(editor.dirty).toBe(true);
    noDraftPersisted(editor);
    // Explicit discard parks the identity; it is never dropped.
    editor.dispatch({ type: "close" });
    editor.dispatch({ type: "discard" });
    expect(editor.state.target).toBeNull();
    expect(editor.state.unresolved.map((u) => u.requestId)).toEqual([REQ1]);
    expect(editor.state.unresolved[0]?.installationId).toBeUndefined();
  });

  test("PURGED clears content only for the pinned installation the attempt required", () => {
    const pinned = editing();
    const a = pinned.beginAttempt(REQ1);
    expect(a.prepared.precondition).toEqual({ kind: "installation", id: I });
    pinned.finishAttempt(a.token, refused("PURGED"));
    expect(pinned.state.phase).toBe("purged");
    expect(pinned.state.tombstones).toEqual([{ scope: SCOPE, binding: PINNED, key: KEY }]);

    const boot = bootstrapping();
    const b = boot.beginAttempt(REQ1);
    boot.finishAttempt(b.token, refused("PURGED"));
    expect(boot.state.phase).toBe("unknown");
    expect(boot.state.tombstones).toEqual([]);
  });
});

describe("refusals after an earlier unknown", () => {
  test("stay unknown, PURGED included, and a mismatch latches without dropping the request", () => {
    for (const code of ["PURGED", "STORAGE_BUSY", "INSTALLATION_MISMATCH"]) {
      const editor = editing();
      const first = editor.beginAttempt(REQ1);
      editor.finishAttempt(first.token, { kind: "unknown" });
      const retry = editor.beginAttempt(REQ1);
      editor.finishAttempt(retry.token, refused(code));
      expect(editor.state.phase).toBe("unknown");
      expect(editor.state.pending?.requestId).toBe(REQ1);
      expect(editor.state.tombstones).toEqual([]);
      expect(editor.state.gate).toBe(code === "INSTALLATION_MISMATCH" ? "mismatch" : "ready");
    }
  });
});

describe("identity-bearing completions", () => {
  test("a bootstrap success attributes the executing store and saves", () => {
    const editor = bootstrapping();
    const { token } = editor.beginAttempt(REQ1);
    editor.finishAttempt(token, { kind: "success", store: store(), receipt: completed(REQ1, KEY, 1) });
    expect(editor.state.phase).toBe("saved");
    expect(editor.state.expectedInstallation).toBe(I);
    expect(editor.state.pending).toBeNull();
  });

  test("a purged success takes its key from the submitted target", () => {
    const editor = editing();
    editor.dispatch({ type: "discard" });
    // Back to a clean committed record, then a confirmed purge.
    editor.dispatch({ type: "submit", requestId: REQ2, intent: { kind: "purge", confirmed: true } });
    expect(editor.state.pending?.requestId).toBe(REQ1);
    const { token } = editor.beginAttempt(REQ1);
    editor.finishAttempt(token, { kind: "success", store: store(), receipt: purged(REQ1) });
    expect(editor.state.phase).toBe("purged");
    expect(editor.state.tombstones.map((t) => t.key)).toEqual([KEY]);
  });

  test("a success from a store that contradicts the sent precondition is never attributed", () => {
    const boot = bootstrapping();
    const b = boot.beginAttempt(REQ1);
    boot.finishAttempt(b.token, { kind: "success", store: store(I, "e".repeat(64)), receipt: completed(REQ1, KEY, 1) });
    expect(boot.state.phase).toBe("unknown");
    expect(boot.state.expectedInstallation).toBeNull();
    expect(boot.state.pending?.installationId).toBeUndefined();

    const pinned = editing();
    const p = pinned.beginAttempt(REQ1);
    pinned.finishAttempt(p.token, { kind: "success", store: store(J), receipt: completed(REQ1) });
    expect(pinned.state.gate).toBe("mismatch");
    expect(pinned.state.phase).not.toBe("saved");
    expect(pinned.state.pending?.requestId).toBe(REQ1);
  });

  test("a receipt the editor cannot accept falls back to unknown, never a permanent saving", () => {
    const wrongKey = editing();
    const a = wrongKey.beginAttempt(REQ1);
    wrongKey.finishAttempt(a.token, { kind: "success", store: store(), receipt: completed(REQ1, OTHER_KEY) });
    expect(wrongKey.state.phase).toBe("unknown");
    expect(wrongKey.state.pending?.requestId).toBe(REQ1);

    const wrongId = editing();
    const b = wrongId.beginAttempt(REQ1);
    wrongId.finishAttempt(b.token, { kind: "success", store: store(), receipt: completed(REQ2) });
    expect(wrongId.state.phase).toBe("unknown");
  });

  test("with observation cleared, an open attempt completes as unknown and no new attempt starts", () => {
    const editor = editing();
    const { token } = editor.beginAttempt(REQ1);
    editor.dispatch({ type: "disconnect" });
    expect(() => editor.beginAttempt(REQ1)).toThrow(CurationError);
    editor.finishAttempt(token, { kind: "success", store: store(), receipt: completed(REQ1) });
    expect(editor.state.phase).toBe("unknown");
    expect(editor.state.pending?.requestId).toBe(REQ1);
    expect(editor.state.expectedInstallation).toBe(I);
    expect(editor.sending).toBe(false);
  });
});

describe("scope and connection changes", () => {
  test("an abandoned attempt never touches the next record; its later receipt settles the parked id", () => {
    const editor = editing();
    const { token } = editor.beginAttempt(REQ1);
    editor.dispatch({ type: "close" });
    editor.dispatch({ type: "discard" });
    expect(editor.state.unresolved.map((u) => u.requestId)).toEqual([REQ1]);
    editor.dispatch({ type: "open-lesson", scope: SCOPE, binding: PINNED, key: OTHER_KEY });
    const before = JSON.stringify(editor.state);
    editor.finishAttempt(token, refused("CURATION_CONFLICT"));
    expect(JSON.stringify(editor.state)).toBe(before);

    const late = editing();
    const t = late.beginAttempt(REQ1);
    late.dispatch({ type: "close" });
    late.dispatch({ type: "discard" });
    late.finishAttempt(t.token, { kind: "success", store: store(), receipt: completed(REQ1) });
    expect(late.state.unresolved).toEqual([]);
  });

  test("connect marks open attempts unknown; old completions are ignored; a new correlated lookup settles", () => {
    const editor = editing();
    const { token } = editor.beginAttempt(REQ1);
    editor.connect(EPOCH_2);
    expect(editor.state.phase).toBe("unknown");
    expect(editor.sending).toBe(false);
    editor.finishAttempt(token, { kind: "success", store: store(), receipt: completed(REQ1) });
    expect(editor.state.phase).toBe("unknown");
    expect(editor.state.pending?.requestId).toBe(REQ1);
    editor.observe(observation(I, EPOCH_2));
    const pending = editor.state.pending!;
    const target: LessonEditorTarget = { scope: pending.scope, binding: pending.binding, key: pending.key };
    const lookup: LessonEditorEvent = {
      type: "receipt",
      generation: pending.generation,
      requestId: REQ1,
      target,
      receipt: { state: "committed", requestId: REQ1, payloadHash: "c".repeat(64), key: KEY, revision: 4, changed: true, startedAt: STAMP, finishedAt: STAMP },
    };
    editor.dispatch(lookup, { operation: "receipt", connectionEpoch: EPOCH_2, generation: pending.generation, target, requestId: REQ1, installationId: I });
    expect(editor.state.pending).toBeNull();
    expect(editor.state.phase).toBe("saved");
  });
});
