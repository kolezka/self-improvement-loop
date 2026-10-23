// Legacy sources joined with curation records: digest, bounded source reads,
// active/archive lifecycle, read-only store access, purge hiding and paging.
// Delivery writers (listLessons, markDelivered) are used as they ship.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Lesson, paths } from "@sil/core";
import { CurationError } from "@sil/core/lesson-curation";
import type { CurationChange, LessonKey, LessonScope, StoreBinding } from "@sil/core/lesson-curation";
import {
  LegacySourceError,
  MAX_LEGACY_SOURCE_BYTES,
  applyCurationMutation,
  browseCuratedLessons,
  curationDatabaseFile,
  curationDir,
  curationLocationId,
  getCuratedLesson,
  legacySourceDigestV1,
  listLessons,
  markDelivered,
  openCurationStore,
  openCurationStoreForRead,
  projectIdForRoot,
  readCurationHistory,
  readLegacySource,
  sourceDigest,
} from "../src/index.ts";
import type { CurationDatabase } from "../src/index.ts";
import { createCurationFixture, useFixtureEnv } from "../../../tests/curation-fixture.ts";
import type { CurationFixture } from "../../../tests/curation-fixture.ts";
import { apply, captureChange, captureKey, dump, inboxKey, mutation, openStore, rejection, worldScope } from "./curation-mutation-helpers.ts";

let fx: CurationFixture;
let restoreEnv: () => void;

beforeEach(() => {
  fx = createCurationFixture();
  restoreEnv = useFixtureEnv(fx);
});

afterEach(() => {
  restoreEnv();
  fx.cleanup();
});

const BASE_CREATED = "2026-10-01T00:00:00.000Z";

function lessonOf(id: string, over: Partial<Lesson> = {}): Lesson {
  return Lesson.parse({ id, world: fx.world, pattern: "legacy-pattern", text: `lesson text ${id}`, created: BASE_CREATED, ...over });
}

function sourceDir(world: string, location: "active" | "archive"): string {
  const dir = location === "active" ? paths.inboxDir(world) : join(paths.inboxDir(world), "archive");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSource(lesson: Lesson, location: "active" | "archive" = "active", name?: string): string {
  const file = join(sourceDir(lesson.world, location), name ?? `${paths.safeComponent(lesson.id)}.json`);
  writeFileSync(file, `${JSON.stringify(lesson, null, 2)}\n`);
  return file;
}

const locationBinding = (): StoreBinding => ({ kind: "location", id: curationLocationId() });
const installationBinding = (db: CurationDatabase): StoreBinding => ({ kind: "installation", id: db.installationId });
const projectScope = (root: string): LessonScope => ({ world: fx.world, project: { kind: "project", id: projectIdForRoot(root) } });

function annotate(db: CurationDatabase, key: LessonKey, change: CurationChange, expectedRevision: number, scope: LessonScope = worldScope(key.world)) {
  return apply(db, mutation(db, key, change, expectedRevision, { scope }), readLegacySource(key));
}

/** Every entry under the fixture's SIL roots: type, mode, size, mtime and content hash. */
function tree(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        out[p] = `dir ${st.mode} ${st.mtimeMs}`;
        walk(p);
      } else if (st.isFile()) {
        const hash = (st.mode & 0o400) !== 0 ? createHash("sha256").update(readFileSync(p)).digest("hex") : "unreadable";
        out[p] = `file ${st.mode} ${st.size} ${st.mtimeMs} ${hash}`;
      } else out[p] = `other ${st.mode}`;
    }
  };
  for (const root of [fx.env["SIL_STATE_DIR"]!, fx.env["SIL_DATA_DIR"]!, fx.env["SIL_CONFIG_DIR"]!]) walk(root);
  return out;
}

/** Like annotate, but leaves a CurationError as thrown so rejection() can read its code. */
function annotateRaw(db: CurationDatabase, key: LessonKey, change: CurationChange, expectedRevision: number) {
  return applyCurationMutation(db, mutation(db, key, change, expectedRevision), readLegacySource(key));
}

function curationCode(run: () => unknown): string {
  const error = rejection(run);
  return error.code;
}

describe("source digest", () => {
  test("covers exactly world, id, pattern, text, reflection_id, repo and created", () => {
    const base = lessonOf("lesson-1", { reflection_id: "r-1", repo: "/repo/one" });
    expect(sourceDigest(base)).toBe(legacySourceDigestV1(base));
    // Delivery count is not part of the semantic digest.
    expect(sourceDigest({ ...base, deliveries: 4 })).toBe(sourceDigest(base));
    const changes: Array<Partial<Lesson>> = [
      { world: "other-world" },
      { id: "lesson-2" },
      { pattern: "other-pattern" },
      { text: "other text" },
      { reflection_id: "r-2" },
      { reflection_id: null },
      { repo: "/repo/two" },
      { repo: null },
      { created: "2026-10-02T00:00:00.000Z" },
    ];
    for (const change of changes) expect(sourceDigest({ ...base, ...change })).not.toBe(sourceDigest(base));
  });
});

describe("legacy source reader", () => {
  test("reads an active source and reports its location and digest", () => {
    const lesson = lessonOf("a-1");
    writeSource(lesson);
    const snapshot = readLegacySource(inboxKey(fx.world, "a-1"));
    expect(snapshot).toEqual({ lesson, digest: sourceDigest(lesson), location: "active" });
  });

  test("a missing source is null, never an error and never a phantom", () => {
    expect(readLegacySource(inboxKey(fx.world, "nope"))).toBeNull();
  });

  test("same-digest active and archive copies collapse to both; differing ones conflict", () => {
    const lesson = lessonOf("dup");
    const active = writeSource({ ...lesson, deliveries: 1 });
    const archive = writeSource({ ...lesson, deliveries: 5 }, "archive");
    const before = [readFileSync(active), readFileSync(archive)];
    const snapshot = readLegacySource(inboxKey(fx.world, "dup"));
    expect(snapshot?.location).toBe("both");
    expect(snapshot?.digest).toBe(sourceDigest(lesson));
    // Never repaired: both files stay byte for byte.
    expect([readFileSync(active), readFileSync(archive)]).toEqual(before);

    writeSource({ ...lesson, text: "rewritten" }, "archive");
    const error = rejection(() => readLegacySource(inboxKey(fx.world, "dup")));
    expect(error.code).toBe("SOURCE_CONFLICT");
  });

  test("oversize, corrupt, mismatched and symlinked sources are explicit errors", () => {
    const key = inboxKey(fx.world, "bad");
    const file = join(sourceDir(fx.world, "active"), "bad.json");

    writeFileSync(file, `{"pad":"${"x".repeat(MAX_LEGACY_SOURCE_BYTES)}"}`);
    let error = rejection(() => readLegacySource(key));
    expect(error).toBeInstanceOf(LegacySourceError);
    expect((error as LegacySourceError).problem).toBe("too_large");

    writeFileSync(file, "{not json");
    error = rejection(() => readLegacySource(key));
    expect((error as LegacySourceError).problem).toBe("invalid_json");

    writeFileSync(file, JSON.stringify({ id: "bad", world: fx.world }));
    expect((rejection(() => readLegacySource(key)) as LegacySourceError).problem).toBe("invalid_schema");

    // The file name says "bad" but its content is another lesson.
    writeFileSync(file, JSON.stringify(lessonOf("someone-else")));
    expect((rejection(() => readLegacySource(key)) as LegacySourceError).problem).toBe("identity_mismatch");

    // Same id, other world: never read across worlds.
    writeFileSync(file, JSON.stringify(lessonOf("bad", { world: "other-world" })));
    expect((rejection(() => readLegacySource(key)) as LegacySourceError).problem).toBe("identity_mismatch");

    unlinkSync(file);
    const outside = join(fx.root, "outside.json");
    writeFileSync(outside, JSON.stringify(lessonOf("bad")));
    symlinkSync(outside, file);
    expect((rejection(() => readLegacySource(key)) as LegacySourceError).problem).toBe("unsafe_path");
  });

  test("permission errors are not reported as a missing source", () => {
    const file = writeSource(lessonOf("locked"));
    chmodSync(file, 0o000);
    try {
      const error = rejection(() => readLegacySource(inboxKey(fx.world, "locked")));
      expect((error as LegacySourceError).problem).toBe("unreadable");
    } finally {
      chmodSync(file, 0o600);
    }
  });
});

describe("curated read model", () => {
  let db: CurationDatabase;
  beforeEach(() => {
    db = openStore();
  });
  afterEach(() => db.close());

  test("source read, first annotation, read back and acknowledge keep one key and the source bytes", () => {
    const lesson = lessonOf("seq", { reflection_id: "refl-7" });
    const file = writeSource(lesson);
    const bytes = readFileSync(file);
    const key = inboxKey(fx.world, "seq");

    const unannotated = getCuratedLesson(worldScope(fx.world), key, installationBinding(db)).value!;
    expect(unannotated.lesson.revision).toBe(0);
    expect(unannotated.lesson.sourceStatus).toBe("queued");
    expect(unannotated.lesson.baselineDigest).toBeNull();

    const receipt = annotate(db, key, { kind: "edit", text: "My wording." }, 0);
    expect(receipt.state).toBe("committed");

    const read = getCuratedLesson(worldScope(fx.world), key, installationBinding(db));
    expect(read.store).toEqual({ locationId: curationLocationId(), installationId: db.installationId });
    const detail = read.value!;
    expect(detail.lesson.key).toEqual(key);
    expect(detail.lesson.revision).toBe(1);
    expect(detail.lesson.effectiveText).toBe("My wording.");
    expect(detail.lesson.originalText).toBe(lesson.text);
    expect(detail.lesson.baselineDigest).toBe(sourceDigest(lesson));
    expect(detail.lesson.sourceDigest).toBe(sourceDigest(lesson));
    expect(detail.lesson.sourceStatus).toBe("queued");
    expect(detail.provenance).toMatchObject({ kind: "existing_lesson", state: "available", reflectionId: "refl-7", location: "active" });
    // The legacy text never lands in the database.
    expect(JSON.stringify(dump(db))).not.toContain(lesson.text);

    // The critic rewrites the source: changed, with both digests visible.
    const rewritten = { ...lesson, text: "critic rewrote this" };
    writeSource(rewritten);
    const changed = getCuratedLesson(worldScope(fx.world), key, installationBinding(db)).value!;
    expect(changed.lesson.sourceStatus).toBe("changed");
    expect(changed.lesson.effectiveText).toBe("My wording.");
    expect(changed.diagnostics).toContainEqual({ code: "source_changed", baselineDigest: sourceDigest(lesson), currentDigest: sourceDigest(rewritten) });

    // Acknowledge needs the displayed digest and the current revision.
    const stale = rejection(() => annotateRaw(db, key, { kind: "acknowledge-source", digest: sourceDigest(lesson) }, 1));
    expect(stale.code).toBe("SOURCE_CONFLICT");
    const oldRevision = rejection(() => annotateRaw(db, key, { kind: "acknowledge-source", digest: changed.lesson.sourceDigest! }, 0));
    expect(oldRevision.code).toBe("CURATION_CONFLICT");
    annotate(db, key, { kind: "acknowledge-source", digest: changed.lesson.sourceDigest! }, 1);
    const acked = getCuratedLesson(worldScope(fx.world), key, installationBinding(db)).value!;
    expect(acked.lesson.sourceStatus).toBe("queued");
    expect(acked.lesson.baselineDigest).toBe(sourceDigest(rewritten));
    expect(acked.lesson.effectiveText).toBe("My wording.");
    expect(acked.lesson.revision).toBe(2);
    // Reads never touched the source file beyond the explicit rewrite.
    expect(readFileSync(file).toString()).toBe(`${JSON.stringify(rewritten, null, 2)}\n`);
    expect(bytes.length).toBeGreaterThan(0);
  });

  test("delivery-only changes and archive movement keep key, important and wording", () => {
    const lesson = lessonOf("moving");
    writeSource(lesson);
    const key = inboxKey(fx.world, "moving");
    annotate(db, key, { kind: "important", value: true }, 0);
    annotate(db, key, { kind: "edit", text: "Bookmarked wording." }, 1);

    expect(markDelivered(fx.world, "moving")).toBe(1);
    let detail = getCuratedLesson(worldScope(fx.world), key, installationBinding(db)).value!;
    expect(detail.lesson.sourceStatus).toBe("queued");
    for (let i = 2; i <= 5; i++) markDelivered(fx.world, "moving");
    expect(existsSync(join(paths.inboxDir(fx.world), "archive", "moving.json"))).toBe(true);

    detail = getCuratedLesson(worldScope(fx.world), key, installationBinding(db)).value!;
    expect(detail.lesson.key).toEqual(key);
    expect(detail.lesson.important).toBe(true);
    expect(detail.lesson.effectiveText).toBe("Bookmarked wording.");
    expect(detail.lesson.sourceStatus).toBe("archived");
    expect(detail.lesson.sourceDigest).toBe(detail.lesson.baselineDigest);
    expect(detail.provenance).toMatchObject({ kind: "existing_lesson", state: "available", location: "archive" });
  });

  test("identical dual copies show once as archived with a diagnostic; differing copies are a conflict", () => {
    const same = lessonOf("same");
    writeSource({ ...same, deliveries: 2 });
    writeSource({ ...same, deliveries: 5 }, "archive");
    const diff = lessonOf("diff");
    writeSource(diff);
    writeSource({ ...diff, text: "archive text differs" }, "archive");

    const page = browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, installationBinding(db)).value;
    expect(page.total).toBe(2);
    const byId = new Map(page.items.map((item) => [item.key.id, item]));
    expect(byId.get("same")!.sourceStatus).toBe("archived");
    expect(byId.get("diff")!.sourceStatus).toBe("conflict");

    const sameDetail = getCuratedLesson(worldScope(fx.world), inboxKey(fx.world, "same"), installationBinding(db)).value!;
    expect(sameDetail.diagnostics).toContainEqual({ code: "duplicate_source_location" });
    const diffDetail = getCuratedLesson(worldScope(fx.world), inboxKey(fx.world, "diff"), installationBinding(db)).value!;
    expect(diffDetail.provenance.kind === "existing_lesson" && diffDetail.provenance.state).toBe("conflict");
    if (diffDetail.provenance.kind === "existing_lesson" && diffDetail.provenance.state === "conflict") {
      expect(diffDetail.provenance.copies.map((copy) => copy.location).sort()).toEqual(["active", "archive"]);
    }
    // No first annotation on a conflicted source.
    expect(curationCode(() => annotateRaw(db, inboxKey(fx.world, "diff"), { kind: "important", value: true }, 0))).toBe("SOURCE_CONFLICT");
  });

  test("an unknown first annotation fails; a saved one survives source removal without invented provenance", () => {
    const unknown = inboxKey(fx.world, "never-existed");
    expect(curationCode(() => annotateRaw(db, unknown, { kind: "important", value: true }, 0))).toBe("SOURCE_CONFLICT");
    expect(getCuratedLesson(worldScope(fx.world), unknown, installationBinding(db)).value).toBeNull();

    const lesson = lessonOf("goes-away", { reflection_id: "refl-9" });
    const file = writeSource(lesson);
    const key = inboxKey(fx.world, "goes-away");
    annotate(db, key, { kind: "edit", text: "Kept wording." }, 0);
    unlinkSync(file);

    const detail = getCuratedLesson(worldScope(fx.world), key, installationBinding(db)).value!;
    expect(detail.lesson.sourceStatus).toBe("missing");
    expect(detail.lesson.effectiveText).toBe("Kept wording.");
    expect(detail.lesson.originalText).toBeNull();
    expect(detail.lesson.sourceDigest).toBeNull();
    expect(detail.lesson.baselineDigest).toBe(sourceDigest(lesson));
    expect(detail.provenance).toEqual({ kind: "existing_lesson", state: "unavailable", problem: "missing", retainedDigest: sourceDigest(lesson) });
    expect(JSON.stringify(detail)).not.toContain("refl-9");
    const page = browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, installationBinding(db)).value;
    expect(page.items.map((item) => [item.key.id, item.sourceStatus])).toEqual([["goes-away", "missing"]]);
  });

  test("unreadable and invalid sources stay visible instead of reading as no lessons", () => {
    const lesson = lessonOf("broken");
    const file = writeSource(lesson);
    const key = inboxKey(fx.world, "broken");
    annotate(db, key, { kind: "edit", text: "Wording on a broken source." }, 0);
    writeFileSync(file, "{truncated");
    writeFileSync(join(sourceDir(fx.world, "active"), "stray.json"), JSON.stringify({ hello: 1 }));

    const page = browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, installationBinding(db)).value;
    expect(page.items.map((item) => [item.key.id, item.sourceStatus])).toEqual([["broken", "invalid"]]);
    expect(page.sourceProblems).toEqual([
      { location: "active", file: "broken.json", problem: "invalid_json" },
      { location: "active", file: "stray.json", problem: "invalid_schema" },
    ]);

    const dir = paths.inboxDir(fx.world);
    chmodSync(dir, 0o000);
    try {
      const error = rejection(() => browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, installationBinding(db)));
      expect(error).toBeInstanceOf(LegacySourceError);
      expect((error as LegacySourceError).problem).toBe("unreadable");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a purge tombstone hides the source from curation only", () => {
    const lesson = lessonOf("secret-ish");
    const file = writeSource(lesson);
    const bytes = readFileSync(file);
    const key = inboxKey(fx.world, "secret-ish");
    annotate(db, key, { kind: "edit", text: "Sensitive wording." }, 0);
    apply(db, mutation(db, key, { kind: "purge", confirmed: true }, 1), null);

    const page = browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, installationBinding(db)).value;
    expect(page.total).toBe(0);
    expect(page.items).toEqual([]);
    const detail = getCuratedLesson(worldScope(fx.world), key, installationBinding(db)).value!;
    expect(detail.provenance).toEqual({ kind: "purged" });
    expect(detail.lesson.sourceStatus).toBe("purged");
    expect(detail.lesson.effectiveText).toBeNull();
    expect(detail.lesson.originalText).toBeNull();
    expect(JSON.stringify(detail)).not.toContain(lesson.text);
    // Delivery is untouched: the file stays and the hook-side list still sees it.
    expect(readFileSync(file)).toEqual(bytes);
    expect(listLessons(fx.world).map((l) => l.id)).toEqual(["secret-ish"]);
  });

  test("pages are deterministic, totals come before slicing and cursors stay in their scope", () => {
    for (let i = 0; i < 26; i++) {
      writeSource(lessonOf(`w-${String(i).padStart(2, "0")}`, { created: `2026-10-${String(1 + (i % 20)).padStart(2, "0")}T00:00:00.000Z` }));
    }
    // Same created as w-00 and w-20: key order breaks the tie.
    writeSource(lessonOf("w-tie", { created: "2026-10-01T00:00:00.000Z" }));
    for (let i = 0; i < 3; i++) writeSource(lessonOf(`p-${i}`, { repo: fx.projectRoot }));
    const binding = installationBinding(db);

    const first = browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, binding).value;
    expect(first.total).toBe(27);
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    const second = browseCuratedLessons({ scope: worldScope(fx.world), collection: "all", cursor: first.nextCursor! }, binding).value;
    expect(second.total).toBe(27);
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();

    const all = [...first.items, ...second.items];
    expect(new Set(all.map((item) => item.key.id)).size).toBe(27);
    const sorted = [...all].sort((a, b) => (a.created === b.created ? 0 : a.created < b.created ? 1 : -1));
    expect(all.map((item) => item.created)).toEqual(sorted.map((item) => item.created));
    const tied = all.filter((item) => item.created === "2026-10-01T00:00:00.000Z").map((item) => item.key.id);
    expect(tied).toHaveLength(3);
    // Key order inside a tie is the encoded-key order, stable across calls.
    const again = browseCuratedLessons({ scope: worldScope(fx.world), collection: "all", limit: 100 }, binding).value;
    expect(again.items.map((item) => item.key.id)).toEqual(all.map((item) => item.key.id));
    expect(all.every((item) => item.scope.project.kind === "world")).toBe(true);

    const project = browseCuratedLessons({ scope: projectScope(fx.projectRoot), collection: "all" }, binding).value;
    expect(project.items.map((item) => item.key.id).sort()).toEqual(["p-0", "p-1", "p-2"]);
    expect(project.total).toBe(3);

    expect(curationCode(() => browseCuratedLessons({ scope: projectScope(fx.projectRoot), collection: "all", cursor: first.nextCursor! }, binding))).toBe(
      "INVALID_INPUT",
    );
    expect(curationCode(() => browseCuratedLessons({ scope: worldScope(fx.world), collection: "inbox", cursor: first.nextCursor! }, binding))).toBe(
      "INVALID_INPUT",
    );
    expect(curationCode(() => browseCuratedLessons({ scope: worldScope(fx.world), collection: "all", limit: 101 }, binding))).toBe("INVALID_INPUT");
    expect(curationCode(() => browseCuratedLessons({ scope: worldScope(fx.world), collection: "all", limit: 0 }, binding))).toBe("INVALID_INPUT");
    expect(
      curationCode(() => browseCuratedLessons({ scope: worldScope(fx.world), collection: "all", important: "true" as unknown as boolean }, binding)),
    ).toBe("INVALID_INPUT");
  });

  test("collections and the important filter split captures, queued and archived lessons", () => {
    writeSource(lessonOf("queued-1"));
    writeSource(lessonOf("archived-1"), "archive");
    const capture = captureKey(fx.world);
    apply(db, mutation(db, capture, captureChange("A saved capture."), 0), null);
    annotate(db, inboxKey(fx.world, "archived-1"), { kind: "important", value: true }, 0);
    const binding = installationBinding(db);
    const ids = (collection: "saved" | "inbox" | "archived" | "all", important?: boolean) =>
      browseCuratedLessons({ scope: worldScope(fx.world), collection, ...(important === undefined ? {} : { important }) }, binding)
        .value.items.map((item) => item.key.id)
        .sort();

    expect(ids("saved")).toEqual([capture.id]);
    expect(ids("inbox")).toEqual(["queued-1"]);
    expect(ids("archived")).toEqual(["archived-1"]);
    expect(ids("all")).toEqual([capture.id, "archived-1", "queued-1"].sort());
    expect(ids("all", true)).toEqual(["archived-1"]);
    expect(ids("all", false)).toEqual([capture.id, "queued-1"].sort());
    const saved = browseCuratedLessons({ scope: worldScope(fx.world), collection: "saved" }, binding).value.items[0]!;
    expect(saved.sourceStatus).toBe("saved");
    expect(saved.effectiveText).toBe("A saved capture.");
    const captureDetail = getCuratedLesson(worldScope(fx.world), capture, binding).value!;
    expect(captureDetail.provenance).toMatchObject({ kind: "capture", source: { kind: "explicit_quote", quote: "a quoted line" } });
  });

  test("a page is cut by bytes, never by clipping a lesson's text", () => {
    const long = "y".repeat(60 * 1024);
    for (let i = 0; i < 20; i++) writeSource(lessonOf(`big-${String(i).padStart(2, "0")}`, { text: long }));
    const page = browseCuratedLessons({ scope: worldScope(fx.world), collection: "all", limit: 100 }, installationBinding(db)).value;
    expect(page.total).toBe(20);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThan(20);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items.every((item) => item.effectiveText === long && item.originalText === long)).toBe(true);
  });

  test("history pages newest first with a cursor bound to the record", () => {
    writeSource(lessonOf("hist"));
    const key = inboxKey(fx.world, "hist");
    annotate(db, key, { kind: "edit", text: "one" }, 0);
    annotate(db, key, { kind: "edit", text: "two" }, 1);
    annotate(db, key, { kind: "important", value: true }, 2);
    const binding = installationBinding(db);

    const first = readCurationHistory(worldScope(fx.world), key, binding, undefined, 2).value;
    expect(first.total).toBe(3);
    expect(first.items.map((r) => [r.revision, r.kind, r.text, r.important])).toEqual([
      [3, "important", null, true],
      [2, "edit", "two", null],
    ]);
    const second = readCurationHistory(worldScope(fx.world), key, binding, first.nextCursor!, 2).value;
    expect(second.items.map((r) => r.revision)).toEqual([1]);
    expect(second.items[0]!.newSourceDigest).toBe(sourceDigest(lessonOf("hist")));
    expect(second.nextCursor).toBeNull();

    writeSource(lessonOf("other"));
    const otherKey = inboxKey(fx.world, "other");
    expect(curationCode(() => readCurationHistory(worldScope(fx.world), otherKey, binding, first.nextCursor!, 2))).toBe("INVALID_INPUT");
    expect(readCurationHistory(worldScope(fx.world), otherKey, binding).value).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  test("an exact read in the wrong scope is a scope conflict", () => {
    writeSource(lessonOf("scoped", { repo: fx.projectRoot }));
    const key = inboxKey(fx.world, "scoped");
    const binding = installationBinding(db);
    expect(getCuratedLesson(projectScope(fx.projectRoot), key, binding).value!.lesson.scope).toEqual(projectScope(fx.projectRoot));
    expect(curationCode(() => getCuratedLesson(worldScope(fx.world), key, binding))).toBe("SCOPE_CONFLICT");
    expect(curationCode(() => getCuratedLesson(worldScope("other-world"), inboxKey("other-world", "scoped"), binding))).toBe("INVALID_INPUT");
  });
});

describe("read-only store access", () => {
  test("an uninitialized store serves legacy sources without creating anything", () => {
    writeSource(lessonOf("fresh"));
    const before = tree();
    const result = browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, locationBinding());
    expect(result.store).toEqual({ locationId: curationLocationId(), installationId: null });
    expect(result.value.items.map((item) => [item.key.id, item.revision])).toEqual([["fresh", 0]]);
    expect(getCuratedLesson(worldScope(fx.world), inboxKey(fx.world, "fresh"), locationBinding()).value!.lesson.revision).toBe(0);
    expect(readCurationHistory(worldScope(fx.world), inboxKey(fx.world, "fresh"), locationBinding()).value.total).toBe(0);
    expect(existsSync(curationDir())).toBe(false);
    expect(tree()).toEqual(before);
  });

  test("an installation pin never falls back to an uninitialized location", () => {
    const pin: StoreBinding = { kind: "installation", id: "00000000-0000-4000-8000-000000000000" };
    expect(curationCode(() => browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, pin))).toBe("INSTALLATION_MISMATCH");
    expect(curationCode(() => browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, { kind: "location", id: "f".repeat(64) }))).toBe(
      "INSTALLATION_MISMATCH",
    );
    expect(existsSync(curationDir())).toBe(false);
  });

  test("reads of a ready store write nothing, also when they fail", () => {
    const db = openStore();
    writeSource(lessonOf("ro"));
    const key = inboxKey(fx.world, "ro");
    annotate(db, key, { kind: "edit", text: "ro wording" }, 0);
    const binding = installationBinding(db);
    db.close();

    const before = tree();
    browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, binding);
    getCuratedLesson(worldScope(fx.world), key, binding);
    readCurationHistory(worldScope(fx.world), key, binding);
    rejection(() => browseCuratedLessons({ scope: worldScope(fx.world), collection: "all", limit: 500 }, binding));
    rejection(() => getCuratedLesson(worldScope(fx.world), key, { kind: "installation", id: "00000000-0000-4000-8000-000000000000" }));
    expect(tree()).toEqual(before);
    expect(existsSync(`${curationDatabaseFile()}-journal`)).toBe(false);
  });

  test("the read handle refuses writes even with query_only switched off", () => {
    const db = openStore();
    const binding = installationBinding(db);
    // Positive control: the same statement is valid on a write handle.
    db.sqlite.run("BEGIN");
    db.sqlite.run("INSERT INTO meta (key, value) VALUES ('probe', 'x')");
    db.sqlite.run("ROLLBACK");
    db.close();
    const before = readFileSync(curationDatabaseFile());

    const handle = openCurationStoreForRead(binding);
    try {
      const sqlite = handle.db!.sqlite;
      sqlite.run("PRAGMA query_only = OFF");
      expect(() => sqlite.run("INSERT INTO meta (key, value) VALUES ('probe', 'x')")).toThrow(/readonly/i);
      // A journal-mode switch either errors or is ignored; it never takes.
      try {
        sqlite.run("PRAGMA journal_mode = WAL");
      } catch {}
      expect(String(Object.values(sqlite.query("PRAGMA journal_mode").get() as object)[0]).toLowerCase()).toBe("delete");
    } finally {
      handle.db?.close();
    }
    expect(readFileSync(curationDatabaseFile())).toEqual(before);
  });

  test("damaged or swapped storage fails visibly instead of hiding annotations", () => {
    const db = openStore();
    writeSource(lessonOf("kept"));
    annotate(db, inboxKey(fx.world, "kept"), { kind: "important", value: true }, 0);
    const binding = installationBinding(db);
    db.close();

    // A database from another installation behind this marker.
    const otherRoot = join(fx.root, "other-data");
    const saved = process.env["SIL_DATA_DIR"];
    process.env["SIL_DATA_DIR"] = otherRoot;
    openCurationStore({ kind: "location", id: curationLocationId() }, { initialize: true }).close();
    const otherDb = readFileSync(join(otherRoot, "curation", "curation.sqlite"));
    process.env["SIL_DATA_DIR"] = saved;
    const ours = readFileSync(curationDatabaseFile());
    writeFileSync(curationDatabaseFile(), otherDb);
    let error = rejection(() => browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, binding));
    expect(error.code).toBe("STORAGE_UNAVAILABLE");
    expect(error.fields).toEqual(["identity_mismatch"]);

    writeFileSync(curationDatabaseFile(), ours);
    rmSync(curationDatabaseFile());
    error = rejection(() => browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, binding));
    expect(error.fields).toEqual(["database_missing"]);
    error = rejection(() => getCuratedLesson(worldScope(fx.world), inboxKey(fx.world, "kept"), locationBinding()));
    expect(error.fields).toEqual(["database_missing"]);
    expect(error).toBeInstanceOf(CurationError);
  });
});

describe("source containment, tombstone diagnostics and result bounds", () => {
  const RESULT_CAP = 512 * 1024;
  const resultBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

  test("a symlinked directory between the state root and the world inbox is refused", () => {
    const outside = join(fx.root, "outside");
    const outsideWorld = join(outside, paths.safeComponent(fx.world));
    mkdirSync(outsideWorld, { recursive: true });
    writeFileSync(join(outsideWorld, "escaped.json"), JSON.stringify(lessonOf("escaped")));
    symlinkSync(outside, join(fx.env["SIL_STATE_DIR"]!, "inbox"));
    const error = rejection(() => readLegacySource(inboxKey(fx.world, "escaped")));
    expect(error).toBeInstanceOf(LegacySourceError);
    expect((error as LegacySourceError).problem).toBe("unsafe_path");
    const browse = rejection(() => browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, locationBinding()));
    expect((browse as LegacySourceError).problem).toBe("unsafe_path");
  });

  test("a symlinked configured state root itself is ordinary canonicalization and still reads", () => {
    writeSource(lessonOf("via-link"));
    const link = join(fx.root, "state-link");
    symlinkSync(fx.env["SIL_STATE_DIR"]!, link);
    const saved = process.env["SIL_STATE_DIR"];
    process.env["SIL_STATE_DIR"] = link;
    try {
      expect(readLegacySource(inboxKey(fx.world, "via-link"))?.lesson.id).toBe("via-link");
      expect(browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, locationBinding()).value.total).toBe(1);
    } finally {
      process.env["SIL_STATE_DIR"] = saved;
    }
  });

  test("a purged key's corrupt source is not named, while unrelated bad sources stay listed", () => {
    const db = openStore();
    try {
      const file = writeSource(lessonOf("sensitive-id"));
      const key = inboxKey(fx.world, "sensitive-id");
      annotate(db, key, { kind: "important", value: true }, 0);
      apply(db, mutation(db, key, { kind: "purge", confirmed: true }, 1), null);
      writeFileSync(file, "{invalid");
      writeFileSync(join(sourceDir(fx.world, "archive"), "sensitive-id.json"), "{also invalid");
      writeFileSync(join(sourceDir(fx.world, "active"), "unrelated.json"), "{broken");
      const bytes = readFileSync(file);

      const page = browseCuratedLessons({ scope: worldScope(fx.world), collection: "all" }, installationBinding(db)).value;
      expect(page.total).toBe(0);
      expect(page.sourceProblems).toEqual([{ location: "active", file: "unrelated.json", problem: "invalid_json" }]);
      expect(page.sourceProblemsTotal).toBe(1);
      expect(JSON.stringify(page)).not.toContain("sensitive-id");
      // The delivery file is left exactly as it was.
      expect(readFileSync(file)).toEqual(bytes);
    } finally {
      db.close();
    }
  });

  test("the whole browse result, items plus store, cursor and diagnostics, stays under 512 KiB", () => {
    const long = "z".repeat(60 * 1024);
    for (let i = 0; i < 20; i++) writeSource(lessonOf(`big-${String(i).padStart(2, "0")}`, { text: long }));
    const result = browseCuratedLessons({ scope: worldScope(fx.world), collection: "all", limit: 100 }, locationBinding());
    expect(resultBytes(result)).toBeLessThanOrEqual(RESULT_CAP);
    expect(result.value.items.length).toBeGreaterThan(0);
    expect(result.value.nextCursor).not.toBeNull();
    expect(result.value.items.every((item) => item.effectiveText === long)).toBe(true);
  });

  test("diagnostics overflow is counted, never silently dropped, and items still page", () => {
    const pad = "q".repeat(200);
    for (let i = 0; i < 400; i++) writeFileSync(join(sourceDir(fx.world, "active"), `${pad}-${String(i).padStart(3, "0")}.json`), "{bad");
    for (let i = 0; i < 8; i++) writeSource(lessonOf(`ok-${i}`, { text: "w".repeat(60 * 1024) }));
    const result = browseCuratedLessons({ scope: worldScope(fx.world), collection: "all", limit: 100 }, locationBinding());
    const page = result.value;
    expect(resultBytes(result)).toBeLessThanOrEqual(RESULT_CAP);
    expect(page.sourceProblemsTotal).toBe(400);
    expect(page.sourceProblems.length).toBeGreaterThan(0);
    expect(page.sourceProblems.length).toBeLessThan(400);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.total).toBe(8);
  });
});
