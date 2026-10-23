// Curation mutations: one BEGIN IMMEDIATE transaction per request. Record,
// history and receipt commit together or not at all, retries replay the
// stored receipt, and stale or conflicting writes never overwrite a winner.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import type { CurationReceipt } from "@sil/core/lesson-curation";
import { CurationConflictError, applyCurationMutation, curationDatabaseFile, encodeRecordId, getCurationReceipt, openCurationStore } from "../src/index.ts";
import type { CurationDatabase } from "../src/index.ts";
import { applyCurationMutationWith } from "../src/curation/mutations.ts";
import { createCurationFixture, useFixtureEnv } from "../../../tests/curation-fixture.ts";
import type { CurationFixture } from "../../../tests/curation-fixture.ts";
import {
  PROJECT_A,
  PROJECT_B,
  apply,
  captureChange,
  captureKey,
  dump,
  inboxKey,
  mutation,
  newRequestId,
  openStore,
  parseChild,
  readRecord,
  readRevisionNumbers,
  rejection,
  runApply,
  source,
  spawnApply,
  waitForFile,
  worldScope,
} from "./curation-mutation-helpers.ts";

let fx: CurationFixture;
let restoreEnv: () => void;
let db: CurationDatabase;

beforeEach(() => {
  fx = createCurationFixture();
  restoreEnv = useFixtureEnv(fx);
  db = openStore();
});

afterEach(() => {
  db.close();
  restoreEnv();
  fx.cleanup();
});

const committed = (receipt: CurationReceipt) => {
  if (receipt.state !== "committed") throw new Error(`expected committed, got ${receipt.state}`);
  return receipt;
};

describe("capture", () => {
  test("capture retry commits one revision", () => {
    const key = captureKey(fx.world);
    const input = mutation(db, key, captureChange("Prefer rg over grep."), 0);
    const first = apply(db, input);
    const replay = apply(db, structuredClone(input));
    expect(replay).toEqual(first);
    expect(readRevisionNumbers(db, key)).toEqual([1]);
    const receipt = committed(first);
    expect(receipt).toMatchObject({ requestId: input.requestId, key, revision: 1, changed: true });
    expect(receipt.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(getCurationReceipt(db, input.scope, key, input.requestId)).toEqual(first);
    const row = readRecord(db, key)!;
    expect(row).toMatchObject({ revision: 1, text: "Prefer rg over grep.", original_text: null, important: 0, purged: 0, baseline_digest: null });
    expect(JSON.parse(row["source_json"] as string)).toEqual((input.change as { source: unknown }).source);
    expect(db.sqlite.query("SELECT COUNT(*) AS n FROM requests").get()).toEqual({ n: 1 });
  });

  test("same id different payload fails", () => {
    const key = captureKey(fx.world);
    const input = mutation(db, key, captureChange("first wording"), 0);
    apply(db, input);
    const before = dump(db);
    const changedText = { ...input, change: captureChange("second wording") };
    expect(() => apply(db, changedText)).toThrow(/CURATION_CONFLICT/);
    // Same request against another record: refused without naming that record.
    const otherTarget = mutation(db, captureKey(fx.world), captureChange("first wording"), 0, { requestId: input.requestId });
    const error = rejection(() => applyCurationMutation(db, otherTarget, null));
    expect(error.code).toBe("CURATION_CONFLICT");
    expect(error).not.toBeInstanceOf(CurationConflictError);
    expect(error.message).not.toContain(key.id);
    expect(dump(db)).toEqual(before);
  });

  test("new request cannot overwrite capture id", () => {
    const key = captureKey(fx.world);
    apply(db, mutation(db, key, captureChange("the original"), 0));
    const before = dump(db);
    const newRequestSameCapture = mutation(db, key, captureChange("a retyped save"), 0);
    expect(() => apply(db, newRequestSameCapture)).toThrow(/CAPTURE_EXISTS/);
    const error = rejection(() => applyCurationMutation(db, newRequestSameCapture, null));
    expect(error).toBeInstanceOf(CurationConflictError);
    expect((error as CurationConflictError).current).toEqual({ key, revision: 1 });
    // No content dedupe: identical text under a new request is still create-only.
    expect(() => apply(db, mutation(db, key, captureChange("the original"), 0))).toThrow(/CAPTURE_EXISTS/);
    expect(dump(db)).toEqual(before);
    expect(getCurationReceipt(db, worldScope(fx.world), key, newRequestSameCapture.requestId).state).toBe("unknown");
  });

  test("a capture needs expected revision zero and no legacy source", () => {
    const key = captureKey(fx.world);
    expect(() => apply(db, mutation(db, key, captureChange("x"), 1))).toThrow(/CURATION_CONFLICT/);
    expect(() => apply(db, mutation(db, key, captureChange("x"), 0), source(fx.world, key.id))).toThrow(/INVALID_INPUT/);
    expect(dump(db).records).toEqual([]);
  });

  test("an edit of a capture that was never saved is refused", () => {
    const key = captureKey(fx.world);
    expect(() => apply(db, mutation(db, key, { kind: "edit", text: "x" }, 0))).toThrow(/INVALID_INPUT/);
    expect(dump(db).requests).toEqual([]);
  });

  test("the shared parser runs at the boundary", () => {
    const key = captureKey(fx.world);
    expect(() => apply(db, mutation(db, key, captureChange("   "), 0))).toThrow(/INVALID_INPUT/);
    expect(() => apply(db, mutation(db, key, captureChange(`key ${"AKIA"}ABCDEFGHIJKLMNOP`), 0))).toThrow(/SENSITIVE_CONTENT/);
    expect(dump(db).records).toEqual([]);
  });
});

describe("receipts", () => {
  test("absent receipt stays unknown", () => {
    const key = captureKey(fx.world);
    const unseenId = newRequestId();
    expect(getCurationReceipt(db, worldScope(fx.world), key, unseenId).state).toBe("unknown");
    expect(getCurationReceipt(db, worldScope(fx.world), key, unseenId)).toEqual({ state: "unknown", requestId: unseenId });
    apply(db, mutation(db, key, captureChange("saved"), 0));
    expect(getCurationReceipt(db, worldScope(fx.world), key, unseenId).state).toBe("unknown");
  });

  test("cross-world request lookup", () => {
    const key = captureKey(fx.world);
    const input = mutation(db, key, captureChange("scoped"), 0, { scope: { world: fx.world, project: { kind: "project", id: PROJECT_A } } });
    apply(db, input);
    expect(getCurationReceipt(db, input.scope, key, input.requestId).state).toBe("committed");
    const unknown: CurationReceipt = { state: "unknown", requestId: input.requestId };
    // Another world, another project, world-wide scope and another key all read as unknown.
    expect(getCurationReceipt(db, worldScope("other-world"), { ...key, world: "other-world" }, input.requestId)).toEqual(unknown);
    expect(getCurationReceipt(db, { world: fx.world, project: { kind: "project", id: PROJECT_B } }, key, input.requestId)).toEqual(unknown);
    expect(getCurationReceipt(db, worldScope(fx.world), key, input.requestId)).toEqual(unknown);
    expect(getCurationReceipt(db, input.scope, captureKey(fx.world), input.requestId)).toEqual(unknown);
    expect(() => getCurationReceipt(db, worldScope("other-world"), key, input.requestId)).toThrow(/scope conflict/);
    expect(() => getCurationReceipt(db, input.scope, key, "lc_not-a-uuid")).toThrow(/invalid curation input/);
  });

  test("a mutation in another scope cannot reach a record", () => {
    const key = captureKey(fx.world);
    const scope = { world: fx.world, project: { kind: "project" as const, id: PROJECT_A } };
    apply(db, mutation(db, key, captureChange("scoped"), 0, { scope }));
    const before = dump(db);
    const error = rejection(() => applyCurationMutation(db, mutation(db, key, { kind: "edit", text: "moved" }, 1, { scope: worldScope(fx.world) }), null));
    expect(error.code).toBe("SCOPE_CONFLICT");
    expect(error).not.toBeInstanceOf(CurationConflictError);
    const otherProject = mutation(db, key, { kind: "important", value: true }, 1, { scope: { world: fx.world, project: { kind: "project", id: PROJECT_B } } });
    expect(() => apply(db, otherProject)).toThrow(/SCOPE_CONFLICT/);
    expect(dump(db)).toEqual(before);
  });

  test("binding is checked against the opened handle", () => {
    const key = captureKey(fx.world);
    const wrongInstallation = { ...mutation(db, key, captureChange("x"), 0), binding: { kind: "installation" as const, id: crypto.randomUUID() } };
    expect(() => apply(db, wrongInstallation)).toThrow(/INSTALLATION_MISMATCH/);
    const wrongLocation = { ...mutation(db, key, captureChange("x"), 0), binding: { kind: "location" as const, id: "0".repeat(64) } };
    expect(() => apply(db, wrongLocation)).toThrow(/INSTALLATION_MISMATCH/);
    expect(dump(db).requests).toEqual([]);
    expect(db.locationId).toMatch(/^[0-9a-f]{64}$/);
    // The handle keeps the location it was opened at, whatever the env says later.
    const opened = db.locationId;
    process.env["SIL_DATA_DIR"] = join(fx.root, "elsewhere");
    try {
      expect(db.locationId).toBe(opened);
      const byLocation = { ...mutation(db, key, captureChange("x"), 0), binding: { kind: "location" as const, id: opened } };
      expect(committed(apply(db, byLocation)).revision).toBe(1);
    } finally {
      process.env["SIL_DATA_DIR"] = fx.env["SIL_DATA_DIR"]!;
    }
  });
});

describe("edits and bookmarks", () => {
  test("stale edits preserve winner", () => {
    const key = captureKey(fx.world);
    apply(db, mutation(db, key, captureChange("v1"), 0));
    const winner = apply(db, mutation(db, key, { kind: "edit", text: "winner" }, 1));
    expect(committed(winner)).toMatchObject({ revision: 2, changed: true });
    const before = dump(db);
    const staleEdit = mutation(db, key, { kind: "edit", text: "loser" }, 1);
    expect(() => apply(db, staleEdit)).toThrow(/CURATION_CONFLICT/);
    const error = rejection(() => applyCurationMutation(db, staleEdit, null)) as CurationConflictError;
    expect(error.current).toEqual({ key, revision: 2 });
    expect(dump(db)).toEqual(before);
    expect(readRecord(db, key)).toMatchObject({ text: "winner", revision: 2 });
    expect(readRevisionNumbers(db, key)).toEqual([1, 2]);
    expect(db.sqlite.query("SELECT revision, change_kind, text, important FROM revisions ORDER BY revision").all()).toEqual([
      { revision: 1, change_kind: "capture", text: "v1", important: null },
      { revision: 2, change_kind: "edit", text: "winner", important: null },
    ]);
  });

  test("importance is desired-state not toggle", () => {
    const key = captureKey(fx.world);
    apply(db, mutation(db, key, captureChange("bookmark me"), 0));
    const on = committed(apply(db, mutation(db, key, { kind: "important", value: true }, 1)));
    expect(on).toMatchObject({ revision: 2, changed: true });
    const again = committed(apply(db, mutation(db, key, { kind: "important", value: true }, 2)));
    expect(again).toMatchObject({ revision: 2, changed: false });
    expect(readRecord(db, key)).toMatchObject({ important: 1, revision: 2, text: "bookmark me" });
    const off = committed(apply(db, mutation(db, key, { kind: "important", value: false }, 2)));
    expect(off).toMatchObject({ revision: 3, changed: true });
    expect(readRecord(db, key)).toMatchObject({ important: 0, revision: 3, text: "bookmark me" });
    expect(db.sqlite.query("SELECT revision, change_kind, text, important FROM revisions WHERE revision > 1 ORDER BY revision").all()).toEqual([
      { revision: 2, change_kind: "important", text: null, important: 1 },
      { revision: 3, change_kind: "important", text: null, important: 0 },
    ]);
  });

  test("current-revision no-op", () => {
    const key = captureKey(fx.world);
    apply(db, mutation(db, key, captureChange("same"), 0));
    const before = dump(db);
    const noop = mutation(db, key, { kind: "edit", text: "same" }, 1);
    const receipt = committed(apply(db, noop));
    expect(receipt).toMatchObject({ revision: 1, changed: false });
    const after = dump(db);
    expect(after.records).toEqual(before.records);
    expect(after.revisions).toEqual(before.revisions);
    expect(after.requests).toHaveLength(2);
    // A later write advances the record; the no-op replay still returns its own receipt.
    apply(db, mutation(db, key, { kind: "edit", text: "newer" }, 1));
    expect(apply(db, noop)).toEqual(receipt);
  });

  test("stale no-op conflict", () => {
    const key = captureKey(fx.world);
    apply(db, mutation(db, key, captureChange("x"), 0));
    apply(db, mutation(db, key, { kind: "important", value: true }, 1));
    const before = dump(db);
    expect(() => apply(db, mutation(db, key, { kind: "important", value: true }, 1))).toThrow(/CURATION_CONFLICT/);
    expect(dump(db)).toEqual(before);
  });

  test("a replay is checked before the revision it was sent with", () => {
    const key = captureKey(fx.world);
    apply(db, mutation(db, key, captureChange("x"), 0));
    const edit = mutation(db, key, { kind: "edit", text: "y" }, 1);
    const first = apply(db, edit);
    apply(db, mutation(db, key, { kind: "important", value: true }, 2));
    expect(apply(db, edit)).toEqual(first);
    expect(readRevisionNumbers(db, key)).toEqual([1, 2, 3]);
  });
});

describe("inbox annotations", () => {
  const legacyId = "2026-10-01-legacy\u0000\ud800";

  test("missing source on first annotation", () => {
    const key = inboxKey(fx.world, legacyId);
    const input = mutation(db, key, { kind: "important", value: true }, 0);
    expect(() => apply(db, input, null)).toThrow(/SOURCE_CONFLICT/);
    const good = source(fx.world, legacyId);
    expect(() => apply(db, input, source("other-world", legacyId))).toThrow(/SOURCE_CONFLICT/);
    expect(() => apply(db, input, source(fx.world, "another-id"))).toThrow(/SOURCE_CONFLICT/);
    expect(() => apply(db, input, { ...good, digest: "f".repeat(64) })).toThrow(/SOURCE_CONFLICT/);
    expect(() => apply(db, input, { ...good, location: "elsewhere" as never })).toThrow(/SOURCE_CONFLICT/);
    expect(() => apply(db, input, { ...good, lesson: { ...good.lesson, text: "" } })).toThrow(/SOURCE_CONFLICT/);
    expect(dump(db).records).toEqual([]);
    expect(dump(db).requests).toEqual([]);
    expect(getCurationReceipt(db, input.scope, key, input.requestId).state).toBe("unknown");

    const receipt = committed(apply(db, input, good));
    expect(receipt).toMatchObject({ revision: 1, changed: true });
    expect(readRecord(db, key)).toMatchObject({
      id_json: encodeRecordId(legacyId),
      revision: 1,
      important: 1,
      text: null,
      original_text: null,
      source_json: null,
      baseline_digest: good.digest,
    });
    expect(db.sqlite.query("SELECT change_kind, important, old_source_digest, new_source_digest FROM revisions").all()).toEqual([
      { change_kind: "important", important: 1, old_source_digest: null, new_source_digest: good.digest },
    ]);
    // No raw legacy text copied anywhere.
    expect(JSON.stringify(dump(db))).not.toContain("legacy lesson text");
  });

  test("an unannotated no-op stores a receipt without materializing a record", () => {
    const key = inboxKey(fx.world, legacyId);
    const noop = mutation(db, key, { kind: "important", value: false }, 0);
    const receipt = committed(apply(db, noop, source(fx.world, legacyId)));
    expect(receipt).toMatchObject({ revision: 0, changed: false });
    expect(dump(db).records).toEqual([]);
    expect(getCurationReceipt(db, noop.scope, key, noop.requestId)).toEqual(receipt);
    // Still needs a real source: no phantom receipt either.
    expect(() => apply(db, mutation(db, key, { kind: "important", value: false }, 0), null)).toThrow(/SOURCE_CONFLICT/);
    apply(db, mutation(db, key, { kind: "important", value: true }, 0), source(fx.world, legacyId));
    expect(apply(db, noop, null)).toEqual(receipt);
    // A first annotation in another scope cannot adopt this receipt's target.
    const otherKey = inboxKey(fx.world, "scoped-legacy");
    apply(db, mutation(db, otherKey, { kind: "important", value: false }, 0), source(fx.world, "scoped-legacy"));
    const elsewhere = mutation(db, otherKey, { kind: "important", value: true }, 0, { scope: { world: fx.world, project: { kind: "project", id: PROJECT_A } } });
    expect(() => apply(db, elsewhere, source(fx.world, "scoped-legacy"))).toThrow(/SCOPE_CONFLICT/);
    expect(readRecord(db, otherKey)).toBeNull();
  });

  test("inbox edit changes only human wording and acknowledge keeps it", () => {
    const key = inboxKey(fx.world, legacyId);
    const original = source(fx.world, legacyId);
    apply(db, mutation(db, key, { kind: "edit", text: "my wording" }, 0), original);
    expect(readRecord(db, key)).toMatchObject({ text: "my wording", original_text: null, baseline_digest: original.digest, important: 0 });
    // Editing again does not move the baseline, even if the source changed meanwhile.
    const changed = source(fx.world, legacyId, "the source text changed");
    apply(db, mutation(db, key, { kind: "edit", text: "my wording 2" }, 1), changed);
    expect(readRecord(db, key)).toMatchObject({ text: "my wording 2", baseline_digest: original.digest });

    const stale = mutation(db, key, { kind: "acknowledge-source", digest: original.digest }, 2);
    expect(() => apply(db, stale, changed)).toThrow(/SOURCE_CONFLICT/);
    expect(() => apply(db, mutation(db, key, { kind: "acknowledge-source", digest: changed.digest }, 2), null)).toThrow(/SOURCE_CONFLICT/);
    const ack = committed(apply(db, mutation(db, key, { kind: "acknowledge-source", digest: changed.digest }, 2), changed));
    expect(ack).toMatchObject({ revision: 3, changed: true });
    expect(readRecord(db, key)).toMatchObject({ text: "my wording 2", baseline_digest: changed.digest, important: 0 });
    expect(db.sqlite.query("SELECT revision, change_kind, text, old_source_digest, new_source_digest FROM revisions ORDER BY revision").all()).toEqual([
      { revision: 1, change_kind: "edit", text: "my wording", old_source_digest: null, new_source_digest: original.digest },
      { revision: 2, change_kind: "edit", text: "my wording 2", old_source_digest: null, new_source_digest: null },
      { revision: 3, change_kind: "acknowledge-source", text: null, old_source_digest: original.digest, new_source_digest: changed.digest },
    ]);
    const again = committed(apply(db, mutation(db, key, { kind: "acknowledge-source", digest: changed.digest }, 3), changed));
    expect(again).toMatchObject({ revision: 3, changed: false });
    expect(() => apply(db, mutation(db, captureKey(fx.world), { kind: "acknowledge-source", digest: changed.digest }, 0))).toThrow(/INVALID_INPUT/);
  });

  test("every first annotation that changes something saves its baseline", () => {
    const original = source(fx.world, legacyId);
    const firsts = {
      edit: { kind: "edit", text: "wording" },
      important: { kind: "important", value: true },
      "acknowledge-source": { kind: "acknowledge-source", digest: original.digest },
    } as const;
    for (const [name, change] of Object.entries(firsts)) {
      const key = inboxKey(fx.world, `${legacyId}-${name}`);
      const snapshot = source(fx.world, key.id);
      const first = { ...change, ...(change.kind === "acknowledge-source" ? { digest: snapshot.digest } : {}) };
      const receipt = committed(apply(db, mutation(db, key, first, 0), snapshot));
      expect({ name, revision: receipt.revision, changed: receipt.changed }).toEqual({ name, revision: 1, changed: true });
      expect(readRecord(db, key)).toMatchObject({ revision: 1, baseline_digest: snapshot.digest, original_text: null, source_json: null });
      expect(
        db.sqlite.query("SELECT revision, change_kind, old_source_digest, new_source_digest FROM revisions WHERE id_json = ?").all(encodeRecordId(key.id)),
      ).toEqual([{ revision: 1, change_kind: change.kind, old_source_digest: null, new_source_digest: snapshot.digest }]);
    }
  });

  test("a first acknowledgment keeps the acknowledged baseline when the source moves on", () => {
    const key = inboxKey(fx.world, legacyId);
    const original = source(fx.world, legacyId);
    const ack = mutation(db, key, { kind: "acknowledge-source", digest: original.digest }, 0);
    const receipt = committed(apply(db, ack, original));
    expect(receipt).toMatchObject({ revision: 1, changed: true });
    expect(readRecord(db, key)).toMatchObject({ revision: 1, baseline_digest: original.digest, text: null, important: 0 });
    // The same baseline again is a no-op at the current revision.
    expect(committed(apply(db, mutation(db, key, { kind: "acknowledge-source", digest: original.digest }, 1), original))).toMatchObject({
      revision: 1,
      changed: false,
    });
    // The source changes: the stored baseline still names what was acknowledged.
    const changed = source(fx.world, legacyId, "the source moved on");
    expect(readRecord(db, key)).toMatchObject({ baseline_digest: original.digest });
    expect(apply(db, ack, changed)).toEqual(receipt);
    const second = committed(apply(db, mutation(db, key, { kind: "acknowledge-source", digest: changed.digest }, 1), changed));
    expect(second).toMatchObject({ revision: 2, changed: true });
    expect(readRecord(db, key)).toMatchObject({ revision: 2, baseline_digest: changed.digest });
    expect(readRevisionNumbers(db, key)).toEqual([1, 2]);
  });

  test("a committed replay does not depend on the current source", () => {
    const key = inboxKey(fx.world, legacyId);
    const original = source(fx.world, legacyId);
    const first = mutation(db, key, { kind: "important", value: true }, 0);
    const edit = mutation(db, key, { kind: "edit", text: "wording" }, 1);
    const ack = mutation(db, key, { kind: "acknowledge-source", digest: source(fx.world, legacyId, "v2").digest }, 2);
    const receipts = [
      apply(db, first, original),
      apply(db, edit, null),
      apply(db, ack, source(fx.world, legacyId, "v2")),
    ];
    const before = dump(db);
    const archived = source(fx.world, legacyId, "v2", "archive");
    const changed = source(fx.world, legacyId, "v3 changed again");
    const broken = { ...original, digest: "f".repeat(64) };
    [first, edit, ack].forEach((input, i) => {
      // Missing, archived, changed again, or an unreadable snapshot: the stored receipt wins.
      for (const snapshot of [null, archived, changed, broken]) expect(apply(db, input, snapshot)).toEqual(receipts[i]!);
    });
    expect(dump(db)).toEqual(before);
  });

  test("existing wording, importance and purge work without a source", () => {
    const key = inboxKey(fx.world, legacyId);
    apply(db, mutation(db, key, { kind: "edit", text: "kept" }, 0), source(fx.world, legacyId));
    expect(committed(apply(db, mutation(db, key, { kind: "important", value: true }, 1), null)).revision).toBe(2);
    expect(committed(apply(db, mutation(db, key, { kind: "edit", text: "kept 2" }, 2), null)).revision).toBe(3);
    // A stale or broken snapshot is not consulted where no source is needed.
    const stale = { ...source(fx.world, legacyId), digest: "e".repeat(64) };
    expect(committed(apply(db, mutation(db, key, { kind: "important", value: false }, 3), stale)).revision).toBe(4);
    expect(committed(apply(db, mutation(db, key, { kind: "important", value: true }, 4), stale)).revision).toBe(5);
    expect(readRecord(db, key)).toMatchObject({ text: "kept 2", important: 1, revision: 5 });
    // Acknowledgement still needs the source it acknowledges.
    expect(() => apply(db, mutation(db, key, { kind: "acknowledge-source", digest: "a".repeat(64) }, 5), null)).toThrow(/SOURCE_CONFLICT/);
    const purgeInput = mutation(db, key, { kind: "purge", confirmed: true }, 5);
    expect(apply(db, purgeInput, null).state).toBe("purged");
    const broken = { ...source(fx.world, legacyId), digest: "f".repeat(64) };
    expect(apply(db, purgeInput, broken).state).toBe("purged");
    // A tombstone answers PURGED before any source check.
    expect(() => apply(db, mutation(db, key, { kind: "important", value: false }, 6), broken)).toThrow(/PURGED/);
  });

  test("stored scope is checked before the source", () => {
    const key = inboxKey(fx.world, legacyId);
    apply(db, mutation(db, key, { kind: "important", value: true }, 0), source(fx.world, legacyId));
    const broken = { ...source(fx.world, legacyId), digest: "f".repeat(64) };
    const elsewhere = mutation(db, key, { kind: "edit", text: "x" }, 1, { scope: { world: fx.world, project: { kind: "project", id: PROJECT_A } } });
    expect(() => apply(db, elsewhere, broken)).toThrow(/SCOPE_CONFLICT/);
  });

  test("an annotation outlives its source", () => {
    const key = inboxKey(fx.world, legacyId);
    apply(db, mutation(db, key, { kind: "important", value: true }, 0), source(fx.world, legacyId));
    const receipt = committed(apply(db, mutation(db, key, { kind: "edit", text: "kept" }, 1), null));
    expect(receipt.revision).toBe(2);
  });
});

describe("atomicity", () => {
  // TEMP triggers live in the per-connection temp schema, so the stored
  // schema is untouched and no production fault hook is needed.
  const statements = {
    "insert records": "BEFORE INSERT ON main.records",
    "update records": "BEFORE UPDATE ON main.records",
    "insert revisions": "BEFORE INSERT ON main.revisions",
    "delete revisions": "BEFORE DELETE ON main.revisions",
    "insert requests": "BEFORE INSERT ON main.requests",
    "update requests": "BEFORE UPDATE ON main.requests",
  } as const;
  type Statement = keyof typeof statements;

  const scenarios: Record<string, { statements: Statement[]; prepare: () => () => ReturnType<typeof mutation> }> = {
    capture: {
      statements: ["insert records", "insert revisions", "insert requests"],
      prepare: () => () => mutation(db, captureKey(fx.world, "00000000-0000-4000-8000-0000000000aa"), captureChange("atomic"), 0),
    },
    edit: {
      statements: ["update records", "insert revisions", "insert requests"],
      prepare: () => {
        const key = captureKey(fx.world);
        apply(db, mutation(db, key, captureChange("before"), 0));
        return () => mutation(db, key, { kind: "edit", text: "after" }, 1, { requestId: "lc_00000000-0000-4000-8000-0000000000bb" });
      },
    },
    "no-op": {
      statements: ["insert requests"],
      prepare: () => {
        const key = captureKey(fx.world);
        apply(db, mutation(db, key, captureChange("same"), 0));
        return () => mutation(db, key, { kind: "edit", text: "same" }, 1, { requestId: "lc_00000000-0000-4000-8000-0000000000cc" });
      },
    },
    purge: {
      statements: ["update records", "delete revisions", "insert revisions", "update requests", "insert requests"],
      prepare: () => {
        const key = captureKey(fx.world);
        apply(db, mutation(db, key, captureChange("secret-ish"), 0));
        return () => mutation(db, key, { kind: "purge", confirmed: true }, 1, { requestId: "lc_00000000-0000-4000-8000-0000000000dd" });
      },
    },
  };

  for (const [name, scenario] of Object.entries(scenarios)) {
    for (const statement of scenario.statements) {
      test(`transaction rollback after ${statement} (${name})`, () => {
        const build = scenario.prepare();
        const input = build();
        const before = dump(db);
        db.sqlite.run(`CREATE TEMP TRIGGER injected_fault ${statements[statement]} BEGIN SELECT RAISE(ABORT, 'injected fault'); END`);
        expect(() => apply(db, input)).toThrow(/STORAGE_UNAVAILABLE/);
        expect(db.sqlite.inTransaction).toBe(false);
        expect(dump(db)).toEqual(before);
        expect(getCurationReceipt(db, input.scope, input.key, input.requestId).state).toBe("unknown");
        // Positive control: without the fault the same request commits.
        db.sqlite.run("DROP TRIGGER temp.injected_fault");
        expect(["committed", "purged"]).toContain(apply(db, input).state);
      });
    }
  }

  test("transaction rollback after a failure just before commit", () => {
    const key = captureKey(fx.world);
    const input = mutation(db, key, captureChange("never committed"), 0);
    const before = dump(db);
    expect(() =>
      applyCurationMutationWith(db, input, null, {
        beforeCommit: () => {
          throw new Error("interrupted");
        },
      }),
    ).toThrow(/interrupted/);
    expect(db.sqlite.inTransaction).toBe(false);
    expect(dump(db)).toEqual(before);
  });
});

describe("process races", () => {
  const capturePlan = (requestId: string, text: string, key = captureKey(fx.world, "00000000-0000-4000-8000-000000000001")) =>
    mutation(db, key, captureChange(text), 0, { requestId });

  async function holdThenRace(first: ReturnType<typeof mutation>, second: ReturnType<typeof mutation>, holdMs: number) {
    const paused = join(fx.root, "paused");
    const barrier = join(fx.root, "barrier");
    const ready = join(fx.root, "ready");
    const a = spawnApply(fx, { mutation: first, source: null, pause: { paused, barrier } });
    await waitForFile(paused);
    const b = spawnApply(fx, { mutation: second, source: null, ready });
    await waitForFile(ready);
    await Bun.sleep(holdMs);
    writeFileSync(barrier, "");
    return { a: parseChild(await a), b: parseChild(await b) };
  }

  test("two processes replaying one request commit it once", async () => {
    const input = capturePlan(newRequestId(), "raced");
    const { a, b } = await holdThenRace(input, structuredClone(input), 150);
    expect(a.receipt).toBeDefined();
    expect(b.receipt).toEqual(a.receipt);
    expect(readRevisionNumbers(db, input.key)).toEqual([1]);
    expect(dump(db).requests).toHaveLength(1);
    expect(readRecord(db, input.key)).toMatchObject({ text: "raced", revision: 1 });
  });

  test("two processes racing one revision leave one winner", async () => {
    const key = captureKey(fx.world);
    apply(db, mutation(db, key, captureChange("base"), 0));
    const winner = mutation(db, key, { kind: "edit", text: "first" }, 1);
    const loser = mutation(db, key, { kind: "edit", text: "second" }, 1);
    const { a, b } = await holdThenRace(winner, loser, 150);
    expect(a.receipt).toMatchObject({ state: "committed", revision: 2 });
    expect(b.error).toEqual(expect.objectContaining({ code: "CURATION_CONFLICT", current: { key, revision: 2 } }));
    expect(readRecord(db, key)).toMatchObject({ text: "first", revision: 2 });
    expect(readRevisionNumbers(db, key)).toEqual([1, 2]);
    expect(getCurationReceipt(db, loser.scope, key, loser.requestId).state).toBe("unknown");
  });

  test("two processes creating one capture id leave one capture", async () => {
    const { a, b } = await holdThenRace(capturePlan(newRequestId(), "late original"), capturePlan(newRequestId(), "retyped"), 150);
    expect(a.receipt).toMatchObject({ state: "committed", revision: 1 });
    expect(b.error).toEqual(expect.objectContaining({ code: "CAPTURE_EXISTS" }));
    expect(readRecord(db, capturePlan("lc_x", "x").key)).toMatchObject({ text: "late original" });
  });

  test("a writer held past the busy timeout fails busy and writes nothing", async () => {
    const holder = capturePlan(newRequestId(), "holder");
    const blocked = capturePlan(newRequestId(), "blocked", captureKey(fx.world));
    const { a, b } = await holdThenRace(holder, blocked, 1500);
    expect(b.error).toEqual(expect.objectContaining({ code: "STORAGE_BUSY" }));
    expect(a.receipt).toMatchObject({ state: "committed" });
    expect(readRecord(db, blocked.key)).toBeNull();
    expect(getCurationReceipt(db, blocked.scope, blocked.key, blocked.requestId).state).toBe("unknown");
  });

  test("a process killed before commit leaves nothing behind", async () => {
    const key = captureKey(fx.world);
    apply(db, mutation(db, key, captureChange("base"), 0));
    const before = dump(db);
    const edit = mutation(db, key, { kind: "edit", text: "lost" }, 1);
    const result = await runApply(fx, { mutation: edit, source: null, crash: true });
    expect(result.signalCode).toBe("SIGKILL");
    // The child died inside its write transaction: a hot journal is left behind.
    const journal = `${curationDatabaseFile()}-journal`;
    expect(existsSync(journal)).toBe(true);
    const installationId = db.installationId;
    db.close();
    db = openCurationStore({ kind: "installation", id: installationId }, { initialize: false });
    expect(dump(db)).toEqual(before);
    expect(getCurationReceipt(db, edit.scope, key, edit.requestId).state).toBe("unknown");
    // The retry with the same request id is a fresh, single commit.
    expect(committed(apply(db, edit)).revision).toBe(2);
    // The next committed write replaces the leftover journal.
    expect(existsSync(journal)).toBe(false);
  });
});
