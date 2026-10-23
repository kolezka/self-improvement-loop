// Web adapter for curated lessons: routes, flat read args, strict decoding,
// mutation outcome mapping, guarded session storage and leave guards. Pure
// helpers with injected fetch and storage; the Svelte pane is checked in a
// real browser separately.

import { describe, expect, test } from "bun:test";
import { encodeLessonKey, type LessonKey } from "@sil/core/lesson-curation";
import { encodeCurationMutationRequest } from "@sil/core/lesson-curation-wire";
import { LessonEditorController, type LessonHostObservation } from "@sil/core/lesson-curation-ui";
import { tokenFromFragment } from "../src/lib/api.ts";
import {
  CurationReadError,
  browseQuery,
  claimSnapshot,
  createLeaveGuards,
  curationRead,
  decodeLessonDetail,
  decodeLocated,
  decodeStoreStatus,
  lessonRouteHash,
  loadProjectPreference,
  loadSnapshot,
  parseLessonRoute,
  readbackConfirms,
  saveProjectPreference,
  saveSnapshot,
  sendCurationMutation,
} from "../src/lib/curated-lessons.ts";

const WORLD = "curation-test";
const I = "5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716";
const J = "22222222-2222-4222-8222-222222222222";
const LOCATION = "d".repeat(64);
const RECORD_ID = "0b7c6f1e-4d1a-4c3b-9a55-2f1e8d7c6b5a";
const KEY: LessonKey = { world: WORLD, kind: "capture", id: RECORD_ID };
const REQ = "lc_6a1e2f3d-8c4b-4e5a-b7f6-0d9c8b7a6e5f";
const PROJECT = `p1_${"b".repeat(64)}`;
const STAMP = "2026-10-22T10:00:00.000Z";
const SENTINEL = "SENTINEL draft wording";
const HEADERS = { "X-SIL-Local": "1", "X-SIL-Token": "t" };

type FetchCall = { url: string; init: RequestInit | undefined };
function fakeFetch(respond: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { fn, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}
const throwing = () => { throw new DOMException("denied", "SecurityError"); };

function view(overrides: Record<string, unknown> = {}) {
  return {
    key: KEY,
    scope: { world: WORLD, project: { kind: "world" } },
    revision: 2,
    important: false,
    effectiveText: "words",
    originalText: null,
    source: { kind: "explicit_quote", quote: "q", reference: null, quoteRedacted: false, captureSessionId: null, sourceConversationId: null, sourceRowId: null, sourceAgentId: null },
    sourceStatus: "saved",
    sourceDigest: null,
    baselineDigest: null,
    relatedPattern: null,
    created: STAMP,
    updated: STAMP,
    ...overrides,
  };
}

function prepared(kind: "capture" | "important" = "important", project: "world" | "project" = "world") {
  const scope = project === "world" ? { world: WORLD, project: { kind: "world" as const } } : { world: WORLD, project: { kind: "project" as const, id: PROJECT } };
  const change =
    kind === "capture"
      ? { kind: "capture" as const, text: "t", source: { kind: "explicit_quote" as const, quote: "q", reference: null, quoteRedacted: false, captureSessionId: null, sourceConversationId: null, sourceRowId: null, sourceAgentId: null } }
      : { kind: "important" as const, value: false };
  return {
    mutation: { requestId: REQ, binding: { kind: "installation" as const, id: I }, scope, key: KEY, expectedRevision: kind === "capture" ? 0 : 2, change },
    precondition: { kind: "installation" as const, id: I },
  };
}

describe("exact-record route", () => {
  const hash = lessonRouteHash(I, KEY);

  test("round-trips and is never read as a token", () => {
    expect(hash).toBe(`#/artifacts/lesson/${I}/${encodeLessonKey(KEY)}`);
    expect(parseLessonRoute(hash)).toEqual({ kind: "record", installationId: I, key: KEY });
    expect(tokenFromFragment(hash)).toBe("");
  });

  test("anything else is none or invalid, never a guessed record", () => {
    expect(parseLessonRoute("#/artifacts")).toEqual({ kind: "none" });
    expect(parseLessonRoute("#/review")).toEqual({ kind: "none" });
    for (const bad of [
      `#/artifacts/lesson/${I.toUpperCase()}/${encodeLessonKey(KEY)}`,
      `#/artifacts/lesson/not-a-uuid/${encodeLessonKey(KEY)}`,
      `#/artifacts/lesson/${I}/%%%`,
      `#/artifacts/lesson/${I}`,
      `#/artifacts/lesson/${I}/${encodeLessonKey(KEY)}/extra`,
    ]) {
      expect(parseLessonRoute(bad)).toEqual({ kind: "invalid" });
    }
  });
});

describe("flat read args", () => {
  test("a false importance filter is sent as the string false, not dropped", () => {
    expect(browseQuery({ world: WORLD, project: { kind: "world" }, binding: { kind: "installation", id: I }, collection: "all", important: false })).toEqual({
      world: WORLD,
      project: "world",
      binding: `installation:${I}`,
      collection: "all",
      important: "false",
    });
  });

  test("project, search, cursor and limit are flat strings; absent ones are omitted", () => {
    expect(
      browseQuery({ world: WORLD, project: { kind: "project", id: PROJECT }, binding: { kind: "location", id: LOCATION }, collection: "saved", search: "rg", cursor: "abc", limit: 25 }),
    ).toEqual({ world: WORLD, project: PROJECT, binding: `location:${LOCATION}`, collection: "saved", search: "rg", cursor: "abc", limit: "25" });
  });
});

describe("strict decoding", () => {
  test("store status: ready, uninitialized, error; anything else throws", () => {
    expect(decodeStoreStatus({ state: "ready", binding: { kind: "installation", id: I }, schemaVersion: 1 })).toEqual({ state: "ready", installationId: I });
    expect(decodeStoreStatus({ state: "uninitialized", binding: { kind: "location", id: LOCATION } })).toEqual({ state: "uninitialized", locationId: LOCATION });
    expect(decodeStoreStatus({ state: "error", code: "STORAGE_UNAVAILABLE", problem: "unreadable", recoveryRequired: false })).toEqual({ state: "error", code: "STORAGE_UNAVAILABLE" });
    expect(() => decodeStoreStatus({ state: "ready", binding: { kind: "installation", id: "nope" } })).toThrow();
  });

  test("a located scope must come from the linked installation and the key's world", () => {
    const ok = { store: { locationId: LOCATION, installationId: I }, value: { world: WORLD, project: { kind: "world" } } };
    expect(decodeLocated(ok, I, KEY)).toEqual({ world: WORLD, project: { kind: "world" } });
    expect(decodeLocated({ ...ok, value: null }, I, KEY)).toBeNull();
    expect(() => decodeLocated({ ...ok, store: { locationId: LOCATION, installationId: J } }, I, KEY)).toThrow(CurationReadError);
    expect(() => decodeLocated({ ...ok, value: { world: "other", project: { kind: "world" } } }, I, KEY)).toThrow();
    expect(() => decodeLocated({ ...ok, extra: 1 }, I, KEY)).toThrow();
    expect(() => decodeLocated({ ...ok, value: { world: WORLD, project: { kind: "project", id: "bad" } } }, I, KEY)).toThrow();
  });

  test("detail views are exact: unknown fields and wrong types are refused", () => {
    const detail = { lesson: view(), provenance: { kind: "capture", source: view().source }, diagnostics: [] };
    expect(decodeLessonDetail(detail).lesson.revision).toBe(2);
    expect(() => decodeLessonDetail({ ...detail, lesson: view({ revision: -1 }) })).toThrow();
    expect(() => decodeLessonDetail({ ...detail, lesson: { ...view(), html: "<b>x</b>" } })).toThrow();
    expect(() => decodeLessonDetail({ ...detail, lesson: view({ important: "true" }) })).toThrow();
  });
});

describe("typed reads", () => {
  test("errors keep their code; transport and malformed bodies are their own codes", async () => {
    const mismatch = fakeFetch(() => json(409, { detail: "different SIL installation", code: "INSTALLATION_MISMATCH" }));
    await expect(curationRead("lessons.locate", { key: "k", binding: `installation:${I}` }, (v) => v, { fetch: mismatch.fn, headers: HEADERS, origin: "http://x" })).rejects.toMatchObject({
      code: "INSTALLATION_MISMATCH",
      status: 409,
    });
    expect(mismatch.calls[0]!.url).toBe(`http://x/api/lessons/locate?key=k&binding=installation%3A${I}`);
    expect(mismatch.calls[0]!.init?.headers).toEqual(HEADERS);
    const down = fakeFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(curationRead("lessons.store", {}, (v) => v, { fetch: down.fn, headers: HEADERS, origin: "http://x" })).rejects.toMatchObject({ code: "TRANSPORT" });
    const garbled = fakeFetch(() => new Response("<html>", { status: 200 }));
    await expect(curationRead("lessons.store", {}, (v) => v, { fetch: garbled.fn, headers: HEADERS, origin: "http://x" })).rejects.toMatchObject({ code: "MALFORMED" });
  });
});

describe("mutation outcome mapping", () => {
  const deps = (f: typeof fetch, timeoutMs = 10_000) => ({ fetch: f, headers: HEADERS, timeoutMs });

  test("posts the canonical envelope to the op route and returns the executing store", async () => {
    const receipt = { requestId: REQ, payloadHash: "c".repeat(64), state: "completed", result: { key: KEY, revision: 3, changed: true }, error: null, startedAt: STAMP, finishedAt: STAMP };
    const f = fakeFetch(() => json(200, { version: 1, requestId: REQ, receipt, store: { locationId: LOCATION, installationId: I } }));
    const out = await sendCurationMutation(prepared(), null, deps(f.fn));
    expect(out).toEqual({ completion: { kind: "success", store: { locationId: LOCATION, installationId: I }, receipt }, conflictRevision: null });
    expect(f.calls[0]!.url).toBe("/api/lessons/setImportant");
    expect(f.calls[0]!.init?.method).toBe("POST");
    expect(f.calls[0]!.init?.body).toBe(encodeCurationMutationRequest(prepared(), null));
    expect(f.calls[0]!.init?.headers).toEqual({ ...HEADERS, "Content-Type": "application/json" });
  });

  test("a purged success is decoded, never a generic receipt", async () => {
    const receipt = { requestId: REQ, payloadHash: null, state: "purged", result: null, error: null, startedAt: STAMP, finishedAt: STAMP };
    const f = fakeFetch(() => json(200, { version: 1, requestId: REQ, receipt, store: { locationId: LOCATION, installationId: I } }));
    expect((await sendCurationMutation(prepared(), null, deps(f.fn))).completion).toEqual({ kind: "success", store: { locationId: LOCATION, installationId: I }, receipt });
  });

  test("only the closed refusal codes are refusals; conflict revision is only a hint", async () => {
    const conflict = fakeFetch(() => json(409, { version: 1, requestId: REQ, error: { code: "CURATION_CONFLICT", message: "m", retryable: false }, conflict: { revision: 7 } }));
    expect(await sendCurationMutation(prepared(), null, deps(conflict.fn))).toEqual({ completion: { kind: "refused", code: "CURATION_CONFLICT", fields: [] }, conflictRevision: 7 });
    for (const code of ["OUTCOME_UNKNOWN", "STORAGE_UNAVAILABLE", "SOMETHING_NEW"]) {
      for (const retryable of [false, true]) {
        const f = fakeFetch(() => json(500, { version: 1, requestId: REQ, error: { code, message: "m", retryable }, conflict: null }));
        expect((await sendCurationMutation(prepared(), null, deps(f.fn))).completion).toEqual({ kind: "unknown" });
      }
    }
  });

  test("transport errors, foreign bodies, another request id and timeouts are unknown", async () => {
    const bodies: Array<() => Response | Promise<Response>> = [
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => json(413, { detail: "too large" }),
      () => new Response("not json", { status: 200 }),
      () => json(200, { version: 1, requestId: "lc_11111111-2222-4333-8444-555555555555", error: { code: "INVALID_INPUT", message: "m", retryable: false }, conflict: null }),
    ];
    for (const body of bodies) {
      const f = fakeFetch(body);
      expect((await sendCurationMutation(prepared(), null, deps(f.fn))).completion).toEqual({ kind: "unknown" });
    }
    let aborted = false;
    const hang = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); });
    }));
    expect((await sendCurationMutation(prepared(), null, deps(hang.fn, 20))).completion).toEqual({ kind: "unknown" });
    expect(aborted).toBe(true);
  });

  test("a payload refused by the local encoder is never sent and is a definite refusal", async () => {
    const f = fakeFetch(() => json(200, {}));
    const out = await sendCurationMutation(prepared("capture", "project"), null, deps(f.fn));
    expect(out.completion).toEqual({ kind: "refused", code: "INVALID_INPUT", fields: ["project"] });
    expect(f.calls).toEqual([]);
  });
});

describe("guarded session storage", () => {
  function submittedEditor(): LessonEditorController {
    const editor = new LessonEditorController();
    const observation: LessonHostObservation = { connectionEpoch: "e", binding: { kind: "location", id: LOCATION }, installationId: I, pinnedLocationRetry: true };
    editor.connect("e");
    editor.observe(observation);
    editor.dispatch({ type: "open-lesson", scope: { world: WORLD, project: { kind: "world" } }, binding: { kind: "installation", id: I }, key: KEY });
    const target = editor.state.target!;
    const loaded = { type: "loaded" as const, generation: editor.state.generation, target, view: view() as never };
    editor.dispatch(loaded, { operation: "read", connectionEpoch: "e", generation: loaded.generation, target, installationId: I });
    editor.dispatch({ type: "edit-text", text: SENTINEL });
    editor.dispatch({ type: "submit", requestId: REQ, intent: { kind: "save" } });
    const { token } = editor.beginAttempt(REQ);
    editor.finishAttempt(token, { kind: "unknown" });
    return editor;
  }

  test("stores only the opaque snapshot, per world, and restores the submitted id for reconciliation", () => {
    const storage = new MemoryStorage();
    const editor = submittedEditor();
    expect(saveSnapshot(() => storage as unknown as Storage, WORLD, "pane-1", editor.snapshot())).toBe("written");
    const stored = [...storage.map.values()].join("\n");
    expect(stored).not.toContain("SENTINEL");
    expect(stored).toContain(REQ);
    expect(loadSnapshot(() => storage as unknown as Storage, "other-world")).toBeNull();
    const resumed = new LessonEditorController();
    resumed.connect("e2");
    resumed.dispatch({ type: "hydrate", snapshot: loadSnapshot(() => storage as unknown as Storage, WORLD) });
    expect(resumed.state.pending?.requestId).toBe(REQ);
    expect(resumed.state.pending?.mutation).toBeNull();
    expect(resumed.state.phase).toBe("unknown");
  });

  test("a throwing accessor or broken value never throws and never restores", () => {
    const editor = submittedEditor();
    expect(saveSnapshot(throwing as never, WORLD, "pane-1", editor.snapshot())).toBe("failed");
    expect(loadSnapshot(throwing as never, WORLD)).toBeNull();
    const storage = new MemoryStorage();
    storage.setItem(`sil-curation-editor:v2:${WORLD}`, "{not json");
    expect(loadSnapshot(() => storage as unknown as Storage, WORLD)).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  test("only the pane that claimed the key may write it; a newer claim wins", () => {
    const storage = new MemoryStorage();
    const get = () => storage as unknown as Storage;
    const editor = submittedEditor();
    expect(claimSnapshot(get, WORLD, "old", editor.snapshot())).toBe("written");
    expect(claimSnapshot(get, WORLD, "new", { ...editor.snapshot(), pendingRequestId: null, pendingIdentity: null })).toBe("written");
    expect(saveSnapshot(get, WORLD, "old", editor.snapshot())).toBe("not-owner");
    expect((loadSnapshot(get, WORLD) as { pendingRequestId: string | null }).pendingRequestId).toBeNull();
    expect(saveSnapshot(get, WORLD, "new", editor.snapshot())).toBe("written");
  });

  test("a project preference is used only for the same installation and a valid project", () => {
    const storage = new MemoryStorage();
    const get = () => storage as unknown as Storage;
    expect(saveProjectPreference(get, WORLD, I, { kind: "project", id: PROJECT })).toBe(true);
    expect(loadProjectPreference(get, WORLD, I)).toEqual({ kind: "project", id: PROJECT });
    expect(loadProjectPreference(get, WORLD, J)).toBeNull();
    expect(loadProjectPreference(get, "other-world", I)).toBeNull();
    storage.setItem(`sil-curation-project:v1:${WORLD}`, JSON.stringify({ installationId: I, project: "p1_bad" }));
    expect(loadProjectPreference(get, WORLD, I)).toBeNull();
    expect(loadProjectPreference(throwing as never, WORLD, I)).toBeNull();
  });
});

describe("readback before success", () => {
  test("needs the same record at the committed revision or newer", () => {
    expect(readbackConfirms(2, KEY, view() as never)).toBe(true);
    expect(readbackConfirms(3, KEY, view() as never)).toBe(false);
    expect(readbackConfirms(2, { ...KEY, id: "1b7c6f1e-4d1a-4c3b-9a55-2f1e8d7c6b5a" }, view() as never)).toBe(false);
  });
});

describe("leave guards", () => {
  test("only the owner can clear its guard; a late teardown keeps the newer guard", () => {
    const guards = createLeaveGuards();
    const ran: string[] = [];
    const oldOwner = guards.register(() => false);
    const newOwner = guards.register(() => false);
    guards.unregister(oldOwner);
    guards.request(() => ran.push("blocked"));
    expect(ran).toEqual([]);
    guards.unregister(newOwner);
    guards.request(() => ran.push("free"));
    expect(ran).toEqual(["free"]);
  });

  test("a guard may allow at once or keep the proceed callback for later", () => {
    const guards = createLeaveGuards();
    let kept: (() => void) | null = null;
    guards.register((proceed) => {
      kept = proceed;
      return false;
    });
    const ran: string[] = [];
    guards.request(() => ran.push("go"));
    expect(ran).toEqual([]);
    kept!();
    expect(ran).toEqual(["go"]);
  });
});
