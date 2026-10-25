// Purge: clears curated content, content-bearing history and receipt hashes
// in the same transaction boundary as every other mutation, and leaves a
// tombstone no old or new request can resurrect. Logical purge only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CurationReceipt } from "@sil/core/lesson-curation";
import { applyCurationMutation, curationDatabaseFile, curationDir, encodeRecordId, getCurationReceipt } from "../src/index.ts";
import type { CurationDatabase } from "../src/index.ts";
import { createCurationFixture, useFixtureEnv } from "../../../tests/curation-fixture.ts";
import type { CurationFixture } from "../../../tests/curation-fixture.ts";
import {
  apply,
  captureChange,
  captureKey,
  dump,
  inboxKey,
  mutation,
  openStore,
  parseChild,
  readRecord,
  readRevisionNumbers,
  rejection,
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

const MARKER = "SYNTHETIC-PURGE-MARKER-4d1f";
const purge = { kind: "purge" as const, confirmed: true as const };

function fileHas(needle: string): boolean {
  return readFileSync(curationDatabaseFile()).includes(Buffer.from(needle, "utf8"));
}

function tombstoneExpectations(key: ReturnType<typeof captureKey>) {
  const row = readRecord(db, key)!;
  expect(row).toMatchObject({
    purged: 1,
    important: 0,
    text: null,
    original_text: null,
    source_json: null,
    baseline_digest: null,
    id_json: encodeRecordId(key.id),
  });
  expect(db.sqlite.query("SELECT change_kind, text, important, old_source_digest, new_source_digest FROM revisions").all()).toEqual([
    { change_kind: "purge", text: null, important: null, old_source_digest: null, new_source_digest: null },
  ]);
  for (const request of dump(db).requests as Array<Record<string, unknown>>) {
    expect(request).toMatchObject({ state: "purged", payload_hash: null, revision: null, changed: null });
  }
}

describe("purge", () => {
  test("purge prevents late resurrection", () => {
    const key = captureKey(fx.world);
    const capture = mutation(db, key, captureChange(`${MARKER} captured`, `${MARKER} quote`), 0);
    const edit = mutation(db, key, { kind: "edit", text: `${MARKER} edited` }, 1);
    const important = mutation(db, key, { kind: "important", value: true }, 2);
    const hashes = [capture, edit, important].map((input) => {
      const receipt = apply(db, input);
      if (receipt.state !== "committed") throw new Error("expected committed");
      return receipt.payloadHash;
    });
    // A pre-purge request that never reached the store before the purge.
    const latePrePurge = mutation(db, key, { kind: "edit", text: `${MARKER} late` }, 3);
    // Positive control: the marker and hashes are readable in the file before purge.
    expect(fileHas(MARKER)).toBe(true);
    for (const hash of hashes) expect(fileHas(hash)).toBe(true);

    const purgeInput = mutation(db, key, purge, 3);
    const receipt = apply(db, purgeInput);
    expect(receipt).toEqual({ state: "purged", requestId: purgeInput.requestId, key, startedAt: expect.any(String), finishedAt: expect.any(String) });
    tombstoneExpectations(key);
    expect(readRecord(db, key)).toMatchObject({ revision: 4 });
    expect(readRevisionNumbers(db, key)).toEqual([4]);

    for (const input of [capture, edit, important, purgeInput]) {
      const receiptAfterPurge = getCurationReceipt(db, input.scope, key, input.requestId);
      expect(receiptAfterPurge.state).toBe("purged");
      // A retired request replays as purged, whatever payload it carries now.
      expect(apply(db, input).state).toBe("purged");
      expect(apply(db, { ...input, change: { kind: "edit", text: "anything" } }).state).toBe("purged");
    }
    const before = dump(db);
    expect(() => apply(db, latePrePurge)).toThrow(/PURGED/);
    expect(() => apply(db, mutation(db, key, { kind: "edit", text: "x" }, 4))).toThrow(/PURGED/);
    expect(() => apply(db, mutation(db, key, { kind: "important", value: false }, 4))).toThrow(/PURGED/);
    expect(() => apply(db, mutation(db, key, captureChange("recreated"), 0))).toThrow(/PURGED/);
    expect(dump(db)).toEqual(before);
    expect(getCurationReceipt(db, latePrePurge.scope, key, latePrePurge.requestId).state).toBe("unknown");

    // Purge is idempotent, even from a new request at a stale revision.
    const again = mutation(db, key, purge, 1);
    expect(apply(db, again).state).toBe("purged");
    expect(getCurationReceipt(db, again.scope, key, again.requestId).state).toBe("purged");
    tombstoneExpectations(key);

    db.close();
    expect(readdirSync(curationDir()).sort()).toEqual(["curation.sqlite", "identity.json"]);
    expect(fileHas(MARKER)).toBe(false);
    for (const hash of hashes) expect(fileHas(hash)).toBe(false);
    db = openStore();
  });

  test("purge is version checked", () => {
    const key = captureKey(fx.world);
    apply(db, mutation(db, key, captureChange("x"), 0));
    apply(db, mutation(db, key, { kind: "edit", text: "y" }, 1));
    const before = dump(db);
    expect(() => apply(db, mutation(db, key, purge, 1))).toThrow(/CURATION_CONFLICT/);
    expect(dump(db)).toEqual(before);
  });

  test("a retired request id still refuses another target", () => {
    const key = captureKey(fx.world);
    const capture = mutation(db, key, captureChange("x"), 0);
    apply(db, capture);
    apply(db, mutation(db, key, purge, 1));
    const reused = mutation(db, captureKey(fx.world), captureChange("x"), 0, { requestId: capture.requestId });
    expect(rejection(() => applyCurationMutation(db, reused, null)).code).toBe("CURATION_CONFLICT");
    expect(getCurationReceipt(db, reused.scope, reused.key, capture.requestId).state).toBe("unknown");
  });

  test("purging an inbox annotation keeps a hidden-source tombstone", () => {
    const legacyId = "legacy-sensitive";
    const key = inboxKey(fx.world, legacyId);
    const snapshot = source(fx.world, legacyId, `${MARKER} raw legacy text`);
    apply(db, mutation(db, key, { kind: "edit", text: `${MARKER} human wording` }, 0), snapshot);
    const noop = mutation(db, key, { kind: "important", value: false }, 1);
    apply(db, noop);
    apply(db, mutation(db, key, purge, 1));
    tombstoneExpectations(key);
    expect(getCurationReceipt(db, noop.scope, key, noop.requestId).state).toBe("purged");
    // Neither an old snapshot nor a fresh first annotation brings it back.
    expect(() => apply(db, mutation(db, key, { kind: "important", value: true }, 0), snapshot)).toThrow(/PURGED/);
    expect(() => apply(db, mutation(db, key, { kind: "acknowledge-source", digest: snapshot.digest }, 2), snapshot)).toThrow(/PURGED/);
  });

  test("purging an unannotated inbox lesson needs its source and leaves a tombstone", () => {
    const key = inboxKey(fx.world, "never-annotated");
    const noop = mutation(db, key, { kind: "important", value: false }, 0);
    apply(db, noop, source(fx.world, key.id));
    expect(() => apply(db, mutation(db, key, purge, 0), null)).toThrow(/SOURCE_CONFLICT/);
    expect(readRecord(db, key)).toBeNull();
    const receipt: CurationReceipt = apply(db, mutation(db, key, purge, 0), source(fx.world, key.id));
    expect(receipt.state).toBe("purged");
    tombstoneExpectations(key);
    expect(readRecord(db, key)).toMatchObject({ revision: 1 });
    expect(getCurationReceipt(db, noop.scope, key, noop.requestId).state).toBe("purged");
  });

  test("purge writes no source files", () => {
    const key = inboxKey(fx.world, "legacy-file");
    const listing = () => readdirSync(fx.root, { recursive: true }).map(String).filter((path) => !path.includes("curation")).sort();
    const before = listing();
    apply(db, mutation(db, key, { kind: "important", value: true }, 0), source(fx.world, key.id));
    apply(db, mutation(db, key, purge, 1));
    expect(listing()).toEqual(before);
  });

  test("a late edit racing a purge in another process cannot restore content", async () => {
    const key = captureKey(fx.world);
    apply(db, mutation(db, key, captureChange("base"), 0));
    const paused = join(fx.root, "paused");
    const barrier = join(fx.root, "barrier");
    const ready = join(fx.root, "ready");
    const purger = spawnApply(fx, { mutation: mutation(db, key, purge, 1), source: null, pause: { paused, barrier } });
    await waitForFile(paused);
    const lateEdit = mutation(db, key, { kind: "edit", text: "late" }, 1);
    const editor = spawnApply(fx, { mutation: lateEdit, source: null, ready });
    await waitForFile(ready);
    await Bun.sleep(150);
    writeFileSync(barrier, "");
    const [purged, edited] = [parseChild(await purger), parseChild(await editor)];
    expect(purged.receipt).toMatchObject({ state: "purged" });
    expect(edited.error).toEqual(expect.objectContaining({ code: "PURGED", current: null }));
    tombstoneExpectations(key);
    expect(getCurationReceipt(db, worldScope(fx.world), key, lateEdit.requestId).state).toBe("unknown");
  });
});

describe("schema guards", () => {
  const insertRequest = (target: { kind: string; id: string; projectKind?: string; projectId?: string | null }, state = "committed", revision: number | null = 0, changed: number | null = 0) =>
    db.sqlite
      .query(
        `INSERT INTO requests (request_id, world, kind, id_json, project_kind, project_id, state, payload_hash, revision, changed, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 't', 't')`,
      )
      .run(
        `lc_${crypto.randomUUID()}`,
        fx.world,
        target.kind,
        encodeRecordId(target.id),
        target.projectKind ?? "world",
        target.projectId ?? null,
        state,
        state === "committed" ? "h" : null,
        revision,
        changed,
      );

  test("a receipt without a record is only an unannotated inbox no-op", () => {
    insertRequest({ kind: "inbox", id: "virtual" });
    expect(() => insertRequest({ kind: "inbox", id: "virtual" }, "committed", 1, 1)).toThrow(/receipt target/);
    expect(() => insertRequest({ kind: "inbox", id: "virtual" }, "purged", null, null)).toThrow(/receipt target/);
    expect(() => insertRequest({ kind: "capture", id: crypto.randomUUID() })).toThrow(/receipt target/);
  });

  test("a record row is never deleted, so a tombstone cannot be removed", () => {
    const sqlDelete = (key: ReturnType<typeof captureKey>) => {
      db.sqlite.query("DELETE FROM revisions WHERE world = ? AND kind = ? AND id_json = ?").run(key.world, key.kind, encodeRecordId(key.id));
      db.sqlite.query("DELETE FROM records WHERE world = ? AND kind = ? AND id_json = ?").run(key.world, key.kind, encodeRecordId(key.id));
    };
    // Tombstone with retired requests.
    const purged = captureKey(fx.world);
    apply(db, mutation(db, purged, captureChange("x"), 0));
    apply(db, mutation(db, purged, { kind: "purge", confirmed: true }, 1));
    const before = dump(db);
    expect(() => db.sqlite.transaction(() => sqlDelete(purged))()).toThrow(/never deleted/);
    expect(dump(db)).toEqual(before);
    expect(() => apply(db, mutation(db, purged, captureChange("resurrected"), 0))).toThrow(/PURGED/);
    // A live record and an inbox annotation are protected the same way.
    const live = captureKey(fx.world);
    apply(db, mutation(db, live, captureChange("live"), 0));
    const inbox = inboxKey(fx.world, "annotated");
    apply(db, mutation(db, inbox, { kind: "important", value: true }, 0), source(fx.world, inbox.id));
    const snapshot = dump(db);
    expect(() => db.sqlite.transaction(() => sqlDelete(live))()).toThrow(/never deleted/);
    expect(() => db.sqlite.transaction(() => sqlDelete(inbox))()).toThrow(/never deleted/);
    expect(() => db.sqlite.run("DELETE FROM records")).toThrow(/never deleted/);
    expect(dump(db)).toEqual(snapshot);
  });

  test("receipts and records agree on scope", () => {
    const key = captureKey(fx.world);
    apply(db, mutation(db, key, captureChange("x"), 0));
    expect(() => insertRequest({ kind: "capture", id: key.id, projectKind: "project", projectId: `p1_${"c".repeat(64)}` }, "committed", 1, 0)).toThrow(/receipt target/);
    insertRequest({ kind: "inbox", id: "virtual" });
    expect(() =>
      db.sqlite
        .query("INSERT INTO records (world, kind, id_json, project_kind, project_id, revision, created_at, updated_at) VALUES (?, 'inbox', ?, 'project', ?, 1, 't', 't')")
        .run(fx.world, encodeRecordId("virtual"), `p1_${"c".repeat(64)}`),
    ).toThrow(/receipt target/);
  });
});
