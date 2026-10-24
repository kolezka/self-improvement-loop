// Pure client side of curation reads: flat args, strict decoders and the
// readback check. Shared by the web adapter and the native console.

import { describe, expect, test } from "bun:test";
import {
  CurationReadError,
  browseQuery,
  decodeBrowsePage,
  decodeHistory,
  decodeLessonDetail,
  decodeLocatedResult,
  decodeProjects,
  decodeReadResult,
  decodeReceiptRead,
  decodeStoreStatus,
  decodeView,
  flatBinding,
  flatProject,
  parseFlatProject,
  readbackConfirms,
} from "../src/curation-client.ts";

const WORLD = "curation-test";
const I = "5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716";
const LOCATION = "d".repeat(64);
const PROJECT = `p1_${"b".repeat(64)}`;
const RECORD = "0b7c6f1e-4d1a-4c3b-9a55-2f1e8d7c6b5a";
const REQ = "lc_6a1e2f3d-8c4b-4e5a-b7f6-0d9c8b7a6e5f";
const KEY = { world: WORLD, kind: "capture", id: RECORD };
const STAMP = "2026-10-22T10:00:00.000Z";

function view(over: Record<string, unknown> = {}) {
  return {
    key: KEY,
    scope: { world: WORLD, project: { kind: "project", id: PROJECT } },
    revision: 2,
    important: false,
    effectiveText: "Run the red test first.",
    originalText: null,
    source: {
      kind: "native_selection",
      quote: "quoted",
      reference: null,
      quoteRedacted: false,
      captureSessionId: "s1",
      sourceConversationId: null,
      sourceRowId: "toolu_1",
      sourceAgentId: null,
    },
    sourceStatus: "saved",
    sourceDigest: null,
    baselineDigest: null,
    relatedPattern: null,
    created: STAMP,
    updated: STAMP,
    ...over,
  };
}

function malformed(run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CurationReadError);
  expect((caught as CurationReadError).code).toBe("MALFORMED");
}

describe("flat read args", () => {
  test("bindings and projects flatten to the shared schema strings", () => {
    expect(flatBinding({ kind: "installation", id: I })).toBe(`installation:${I}`);
    expect(flatProject({ kind: "world" })).toBe("world");
    expect(flatProject({ kind: "project", id: PROJECT })).toBe(PROJECT);
    expect(parseFlatProject(PROJECT)).toEqual({ kind: "project", id: PROJECT });
    expect(parseFlatProject("unresolved")).toEqual({ kind: "unresolved" });
    expect(parseFlatProject("p1_short")).toBeNull();
  });

  test("a false importance filter is sent as the string false, an empty search not at all", () => {
    const query = browseQuery({
      world: WORLD,
      project: { kind: "world" },
      binding: { kind: "location", id: LOCATION },
      collection: "all",
      important: false,
      search: "",
      limit: 25,
    });
    expect(query).toEqual({ world: WORLD, project: "world", binding: `location:${LOCATION}`, collection: "all", important: "false", limit: "25" });
  });
});

describe("strict decoders", () => {
  test("a whole lesson view decodes and any extra or wrong field is malformed", () => {
    expect(decodeView(view()).revision).toBe(2);
    malformed(() => decodeView({ ...view(), extra: 1 }));
    malformed(() => decodeView(view({ revision: -1 })));
    malformed(() => decodeView(view({ scope: { world: "other-world", project: { kind: "world" } } })));
    malformed(() => decodeView(view({ sourceStatus: "deleted" })));
  });

  test("a read result keeps the store that answered and refuses a bad identity", () => {
    const decoded = decodeReadResult({ store: { locationId: LOCATION, installationId: I }, value: view() }, decodeView);
    expect(decoded.store).toEqual({ locationId: LOCATION, installationId: I });
    malformed(() => decodeReadResult({ store: { locationId: "x", installationId: I }, value: view() }, decodeView));
    malformed(() => decodeReadResult({ store: { locationId: LOCATION, installationId: "nope" }, value: view() }, decodeView));
  });

  test("detail, browse, history, projects and store status decode their exact shapes", () => {
    const detail = decodeLessonDetail({ lesson: view(), provenance: { kind: "purged" }, diagnostics: [{ code: "duplicate_source_location" }] });
    expect(detail.provenance).toEqual({ kind: "purged" });
    const page = decodeBrowsePage({ items: [view()], nextCursor: null, total: 1, sourceProblems: [], sourceProblemsTotal: 0 });
    expect(page.items).toHaveLength(1);
    const history = decodeHistory({
      items: [{ revision: 1, kind: "capture", at: STAMP, text: "t", important: null, oldSourceDigest: null, newSourceDigest: null }],
      nextCursor: null,
      total: 1,
    });
    expect(history.items[0]?.kind).toBe("capture");
    malformed(() => decodeHistory({ items: [{ revision: 1, kind: "rename", at: STAMP, text: null, important: null, oldSourceDigest: null, newSourceDigest: null }], nextCursor: null, total: 1 }));
    const projects = decodeProjects([{ scope: { world: WORLD, project: { kind: "world" } }, label: "World-wide", root: null, available: true, origins: ["configured"] }]);
    expect(projects[0]?.label).toBe("World-wide");
    expect(decodeStoreStatus({ state: "ready", binding: { kind: "installation", id: I } })).toEqual({ state: "ready", installationId: I });
    expect(decodeStoreStatus({ state: "uninitialized", binding: { kind: "location", id: LOCATION } })).toEqual({ state: "uninitialized", locationId: LOCATION });
    malformed(() => decodeStoreStatus({ state: "ready", binding: { kind: "location", id: LOCATION } }));
  });

  test("a receipt read is bound to its request id", () => {
    expect(decodeReceiptRead({ state: "unknown", requestId: REQ }, REQ)).toEqual({ state: "unknown", requestId: REQ });
    const committed = decodeReceiptRead(
      { state: "committed", requestId: REQ, payloadHash: "h", key: KEY, revision: 3, changed: true, startedAt: STAMP, finishedAt: STAMP },
      REQ,
    );
    expect(committed.state).toBe("committed");
    malformed(() => decodeReceiptRead({ state: "unknown", requestId: "lc_other" }, REQ));
  });

  test("a located result for another installation is a mismatch, not a scope", () => {
    const store = { locationId: LOCATION, installationId: I };
    expect(decodeLocatedResult({ store, value: { world: WORLD, project: { kind: "world" } } }, I, KEY as never).value).toEqual({ world: WORLD, project: { kind: "world" } });
    let caught: unknown;
    try {
      decodeLocatedResult({ store, value: null }, "22222222-2222-4222-8222-222222222222", KEY as never);
    } catch (error) {
      caught = error;
    }
    expect((caught as CurationReadError).code).toBe("INSTALLATION_MISMATCH");
  });
});

describe("readback", () => {
  test("only a fresh read of the same record at or past the committed revision confirms", () => {
    const v = decodeView(view({ revision: 3 }));
    expect(readbackConfirms(3, KEY as never, v)).toBe(true);
    expect(readbackConfirms(4, KEY as never, v)).toBe(false);
    expect(readbackConfirms(3, { ...KEY, id: "11111111-1111-4111-8111-111111111111" } as never, v)).toBe(false);
  });
});
