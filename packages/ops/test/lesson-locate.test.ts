// lessons.locate: the scope of one lesson by exact key, from its stored row
// or, for an unannotated inbox key, from the same source resolver get uses.
// Read-only and content-free.

import "@sil/ops";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Lesson, paths } from "@sil/core";
import type { CurationMutationResponse } from "@sil/core/control-mutation";
import { encodeLessonKey, type CurationChange, type CurationMutation, type LessonKey, type LessonScope } from "@sil/core/lesson-curation";
import { toCurationMutationEnvelope } from "@sil/core/lesson-curation-wire";
import { curationDatabaseFile, curationDir, curationLocationId } from "@sil/store";
import { CONTROL_READ_OPS, executeControlRead } from "@sil/ops/control";
import { OPERATION_EFFECTS } from "@sil/ops/effects";
import { dispatchMutation } from "@sil/ops/mutation";
import { invoke, REGISTRY } from "@sil/ops";
import { createCurationFixture, useFixtureEnv, type CurationFixture } from "../../../tests/curation-fixture.ts";

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

const rid = (): string => `lc_${crypto.randomUUID()}`;
const SOURCE_TEXT = "SENTINEL legacy source wording";
const QUOTE = "SENTINEL quoted capture line";
const OTHER_INSTALLATION = "8c4f2f9e-3b1a-4d6c-9e8f-7a6b5c4d3e2f";

type Located = { store: { locationId: string; installationId: string | null }; value: LessonScope | null };

function successOf(r: CurationMutationResponse) {
  if (!("receipt" in r)) throw new Error(`expected success, got ${JSON.stringify(r)}`);
  return r;
}

function writeInbox(id: string, repo: string | null, text = SOURCE_TEXT): string {
  const dir = paths.inboxDir(fx.world);
  mkdirSync(dir, { recursive: true });
  const lesson = Lesson.parse({ id, world: fx.world, pattern: "legacy-pattern", text, created: "2026-10-01T00:00:00.000Z", repo });
  const file = join(dir, `${paths.safeComponent(id)}.json`);
  writeFileSync(file, JSON.stringify(lesson));
  return file;
}

async function seedCapture(): Promise<{ installationId: string; key: LessonKey; scope: LessonScope }> {
  const key: LessonKey = { world: fx.world, kind: "capture", id: crypto.randomUUID() };
  const scope: LessonScope = { world: fx.world, project: { kind: "world" } };
  const m: CurationMutation = {
    requestId: rid(),
    binding: { kind: "location", id: curationLocationId() },
    scope,
    key,
    expectedRevision: 0,
    change: {
      kind: "capture",
      text: "Prefer rg over grep.",
      source: { kind: "explicit_quote", quote: QUOTE, reference: null, quoteRedacted: false, captureSessionId: null, sourceConversationId: null, sourceRowId: null, sourceAgentId: null },
    },
  };
  const r = successOf(await dispatchMutation(toCurationMutationEnvelope({ mutation: m, precondition: { kind: "uninitialized", locationId: curationLocationId() } }, null)));
  return { installationId: r.store.installationId, key, scope };
}

async function change(installationId: string, key: LessonKey, scope: LessonScope, c: CurationChange, expectedRevision: number) {
  const m: CurationMutation = { requestId: rid(), binding: { kind: "installation", id: installationId }, scope, key, expectedRevision, change: c };
  return successOf(await dispatchMutation(toCurationMutationEnvelope({ mutation: m, precondition: { kind: "installation", id: installationId } }, null)));
}

const locate = (key: LessonKey, binding: string) => invoke("lessons.locate", { key: encodeLessonKey(key), binding }) as Promise<Located>;

function storeDigest(): string {
  return createHash("sha256").update(readFileSync(curationDatabaseFile())).digest("hex");
}

describe("lessons.locate", () => {
  test("is a registered, allowlisted, content-free read with no model or remote effect", () => {
    expect(REGISTRY.get("lessons.locate")?.tier).toBe("read");
    expect(REGISTRY.get("lessons.locate")?.gate).toBe("none");
    expect(CONTROL_READ_OPS).toContain("lessons.locate");
    expect(OPERATION_EFFECTS.get("lessons.locate")).toEqual({ kind: "read", family: "curation", scope: "world", model: false, remote: false, confirmation: "none" });
  });

  test("a capture locates to its stored scope without its content, and get accepts that scope", async () => {
    const seed = await seedCapture();
    const before = storeDigest();
    const found = await locate(seed.key, `installation:${seed.installationId}`);
    expect(found).toEqual({ store: { locationId: curationLocationId(), installationId: seed.installationId }, value: seed.scope });
    expect(JSON.stringify(found)).not.toContain("SENTINEL");
    expect(storeDigest()).toBe(before);
    const detail = (await invoke("lessons.get", { key: encodeLessonKey(seed.key), project: "world", binding: `installation:${seed.installationId}` })) as {
      value: { lesson: { scope: LessonScope } };
    };
    expect(detail.value.lesson.scope).toEqual(found.value!);
  });

  test("an unannotated inbox key locates through the source resolver, never the first project", async () => {
    const seed = await seedCapture();
    writeInbox("legacy-rel", "relative/repo");
    const key: LessonKey = { world: fx.world, kind: "inbox", id: "legacy-rel" };
    const found = await locate(key, `installation:${seed.installationId}`);
    expect(found.value).toEqual({ world: fx.world, project: { kind: "unresolved" } });
    expect(JSON.stringify(found)).not.toContain("SENTINEL");
    const detail = (await invoke("lessons.get", { key: encodeLessonKey(key), project: "unresolved", binding: `installation:${seed.installationId}` })) as {
      value: { lesson: { scope: LessonScope; originalText: string } };
    };
    expect(detail.value.lesson.scope).toEqual(found.value!);
    expect(detail.value.lesson.originalText).toBe(SOURCE_TEXT);
  });

  test("an annotated inbox key keeps its stored scope after the source changes or disappears", async () => {
    const seed = await seedCapture();
    const file = writeInbox("legacy-1", null);
    const key: LessonKey = { world: fx.world, kind: "inbox", id: "legacy-1" };
    const worldScope: LessonScope = { world: fx.world, project: { kind: "world" } };
    await change(seed.installationId, key, worldScope, { kind: "important", value: true }, 0);
    // The source now maps elsewhere; the stored row is authoritative.
    writeInbox("legacy-1", "relative/repo");
    expect((await locate(key, `installation:${seed.installationId}`)).value).toEqual(worldScope);
    rmSync(file);
    expect((await locate(key, `installation:${seed.installationId}`)).value).toEqual(worldScope);
  });

  test("a purged record locates to its scope and get shows the tombstone, not the content", async () => {
    const seed = await seedCapture();
    await change(seed.installationId, seed.key, seed.scope, { kind: "purge", confirmed: true }, 1);
    const found = await locate(seed.key, `installation:${seed.installationId}`);
    expect(found.value).toEqual(seed.scope);
    const detail = (await invoke("lessons.get", { key: encodeLessonKey(seed.key), project: "world", binding: `installation:${seed.installationId}` })) as {
      value: { lesson: { sourceStatus: string; effectiveText: string | null }; provenance: { kind: string } };
    };
    expect(detail.value.lesson.sourceStatus).toBe("purged");
    expect(detail.value.lesson.effectiveText).toBeNull();
    expect(JSON.stringify(detail)).not.toContain("SENTINEL");
  });

  test("missing capture and inbox keys are null", async () => {
    const seed = await seedCapture();
    const binding = `installation:${seed.installationId}`;
    expect((await locate({ world: fx.world, kind: "capture", id: crypto.randomUUID() }, binding)).value).toBeNull();
    expect((await locate({ world: fx.world, kind: "inbox", id: "never-written" }, binding)).value).toBeNull();
  });

  test("a wrong or not yet existing installation is refused before any lookup, and nothing is created", async () => {
    const key: LessonKey = { world: fx.world, kind: "capture", id: crypto.randomUUID() };
    await expect(locate(key, `installation:${OTHER_INSTALLATION}`)).rejects.toMatchObject({ code: "INSTALLATION_MISMATCH" });
    expect(existsSync(curationDir())).toBe(false);
    const seed = await seedCapture();
    await expect(locate(seed.key, `installation:${OTHER_INSTALLATION}`)).rejects.toMatchObject({ code: "INSTALLATION_MISMATCH" });
  });

  test("an unconfigured world key is refused", async () => {
    const seed = await seedCapture();
    await expect(locate({ world: "other-world", kind: "capture", id: crypto.randomUUID() }, `installation:${seed.installationId}`)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("args are strict and flat; get still requires its project", async () => {
    const seed = await seedCapture();
    const key = encodeLessonKey(seed.key);
    const binding = `installation:${seed.installationId}`;
    await expect(invoke("lessons.locate", { key, binding, project: "world" })).rejects.toThrow();
    await expect(invoke("lessons.locate", { key })).rejects.toThrow();
    await expect(invoke("lessons.locate", { key, binding: seed.installationId })).rejects.toThrow();
    await expect(invoke("lessons.get", { key, binding })).rejects.toThrow();
    await expect(invoke("lessons.get", { key, binding, project: "unresolved" })).rejects.toMatchObject({ code: "SCOPE_CONFLICT" });
  });

  test("runs through a control read batch with the store that answered", async () => {
    const seed = await seedCapture();
    const res = await executeControlRead({
      version: 1,
      requestId: "read-locate",
      reads: [{ id: "l", op: "lessons.locate", args: { key: encodeLessonKey(seed.key), binding: `installation:${seed.installationId}` } }],
    });
    expect(res.results["l"]).toEqual({ ok: true, value: { store: { locationId: curationLocationId(), installationId: seed.installationId }, value: seed.scope } });
  });
});

describe("lessons.history paging (contract the web pane pages through)", () => {
  test("a record with 25 revisions pages from newest to r1 with a cursor and a total", async () => {
    const seed = await seedCapture();
    for (let r = 1; r < 25; r++) await change(seed.installationId, seed.key, seed.scope, { kind: "important", value: r % 2 === 1 }, r);
    const base = { key: encodeLessonKey(seed.key), project: "world", binding: `installation:${seed.installationId}`, limit: "20" };
    type Page = { value: { items: Array<{ revision: number }>; nextCursor: string | null; total: number } };
    const first = (await invoke("lessons.history", base)) as Page;
    expect(first.value.total).toBe(25);
    expect(first.value.items.map((i) => i.revision)).toEqual(Array.from({ length: 20 }, (_, n) => 25 - n));
    expect(first.value.nextCursor).not.toBeNull();
    const second = (await invoke("lessons.history", { ...base, cursor: first.value.nextCursor! })) as Page;
    expect(second.value.items.map((i) => i.revision)).toEqual([5, 4, 3, 2, 1]);
    expect(second.value.nextCursor).toBeNull();
  });
});
