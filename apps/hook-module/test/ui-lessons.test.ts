// The Lessons view inside Activity, through the real register, render and
// lessons modules with a fake engine. The bridge is a stand-in for `sil ops`
// holding an in-memory curation store; it answers reads and mutations with the
// host's envelopes, so the decoders and the controller run for real.
// The real engine draws the same view in native-test/lessons.native.tsx.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlRequest } from "@sil/core/control-protocol";
import { encodeLessonKey, type LessonKey } from "@sil/core/lesson-curation";
import { screenRestore } from "../src/ui/lessons.ts";
import { lessonCommand, registerUi, resetUiForTests } from "../src/ui/register.ts";
import { FakeEngine, type FakeElement, type FakeRunResult } from "./fake-engine.ts";

const W = "world-a";
const I = "5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716";
const L = "d".repeat(64);
const P = `p1_${"b".repeat(64)}`;
const STAMP = "2026-10-24T10:00:00.000Z";
const HASH = "a".repeat(64);
const DIGEST = "c".repeat(64);
const SECRET = "api_key=ABCDEFGHIJKLMNOPQRSTUVWX";
const BOOT = { worlds: [W, "world-b"], selectedWorld: W, resolutionError: null, initialized: true };
const LESSONS_ID = "self-improvement-loop/lessons";

type Rec = Record<string, unknown>;
type Envelope = { version: 1; requestId: string; mutation: { op: string; args: { mutation: Rec; precondition: Rec; projectRoot: string | null }; confirmed: boolean } };
type Stored = { key: LessonKey; scope: Rec; revision: number; important: boolean; text: string | null; source: Rec | null; status: string; digest: string | null; related: string | null; history: Rec[] };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function viewOf(r: Stored): Rec {
  return {
    key: r.key,
    scope: r.scope,
    revision: r.revision,
    important: r.important,
    effectiveText: r.text,
    originalText: null,
    source: r.source,
    sourceStatus: r.status,
    sourceDigest: r.digest,
    baselineDigest: r.digest === null ? null : "e".repeat(64),
    relatedPattern: r.related,
    created: STAMP,
    updated: STAMP,
  };
}

type HostOptions = {
  holdMutations?: boolean;
  holdReads?: boolean;
  rejectMutation?: boolean;
  refuse?: string;
  big?: boolean;
  /** lessons.context resolves through the catch-all world: a capture must confirm it. */
  catchAll?: boolean;
  /** Extra project choices beyond the two defaults, with long labels. */
  projects?: number;
  /** lessons.browse answers pages of this size with a cursor. */
  pageSize?: number;
};

function host(options: HostOptions = {}) {
  const records = new Map<string, Stored>();
  const receipts = new Map<string, Rec>();
  const reads: Array<{ op: string; args: Rec }> = [];
  const mutations: Envelope[] = [];
  const held: Array<() => void> = [];
  const state = {
    holdMutations: options.holdMutations ?? false,
    holdReads: options.holdReads ?? false,
    rejectMutation: options.rejectMutation ?? false,
    refuse: options.refuse ?? null,
    /** What console.bootstrap answers; a test may move the configured worlds. */
    boot: BOOT as Rec,
    /** A read this returns a code for fails with that code; everything else answers. */
    failRead: null as ((op: string, args: Rec) => string | null) | null,
  };
  const store = { locationId: L, installationId: I };
  const ok = (value: unknown) => ({ ok: true, value });
  const choices = [
    { scope: { world: W, project: { kind: "project", id: P } }, label: "repo", root: "/work/repo", available: true, origins: ["configured"] },
    { scope: { world: W, project: { kind: "world" } }, label: "World-wide", root: null, available: true, origins: ["configured"] },
    ...Array.from({ length: options.projects ?? 0 }, (_, i) => ({
      scope: { world: W, project: { kind: "project", id: `p1_${i.toString(16).padStart(64, "0")}` } },
      label: `extra-project-${i}-${"l".repeat(200)}`,
      root: `/work/extra-${i}`,
      available: true,
      origins: ["source"],
    })),
  ];
  const read = (op: string, a: Rec): unknown => {
    reads.push({ op, args: a });
    const failed = state.failRead?.(op, a) ?? null;
    if (failed !== null) return { ok: false, error: { code: failed, message: "failed by the test", retryable: false } };
    if (op === "console.bootstrap") return ok(state.boot);
    if (op === "worker.status") return ok({ pending: 0, done: 0, failed: 0, lock_held: false, last_run: STAMP });
    if (options.big) {
      // The parent Activity section at its own bounds: full queue lists, a full
      // log tail and full pages, every text far longer than a row shows.
      const long = (tag: string) => `${tag} ${"w".repeat(5000)}`;
      // Under the bridge's 1 MiB reply limit; each drawn row is still over its 300-character cut.
      const entries = (tag: string) => Array.from({ length: 50 }, (_, i) => ({ session_id: `${tag}-${i}-${"s".repeat(400)}`, world: W, last_stop: STAMP, result: "r".repeat(1000) }));
      if (op === "queue.list") return ok({ pending: entries("p"), done: entries("d"), failed: entries("f"), hidden: { done: 9, failed: 9 }, cleared: { done: null, failed: null } });
      if (op === "logs.tail") return ok({ name: "worker", path: "/x", exists: true, size: 1, lines: Array.from({ length: 20 }, (_, i) => long(`log${i}`)) });
      if (op === "console.page") {
        const n = a.kind === "lessons" ? 5 : 10;
        const items = Array.from({ length: n }, (_, i) => ({ id: `x${i}`, world: W, pattern: `p-${i}`, text: long("t"), lesson: long("l"), created: STAMP }));
        return ok({ world: a.world, total: 999, offset: a.offset, limit: a.limit, items: items.slice(0, a.limit as number) });
      }
    }
    if (op === "queue.list") return ok({ pending: [], done: [], failed: [], hidden: { done: 0, failed: 0 }, cleared: { done: null, failed: null } });
    if (op === "logs.tail") return ok({ name: "worker", path: "/x", exists: false, size: 0, lines: [] });
    if (op === "console.page") {
      const items = a.kind === "lessons" ? [{ id: "l0", world: W, pattern: "p-one", text: "Inbox lesson from the fixture", created: STAMP }] : [];
      return ok({ world: a.world, total: items.length, offset: a.offset, limit: a.limit, items });
    }
    if (op === "lessons.store") return ok({ state: "ready", binding: { kind: "installation", id: I } });
    if (op === "lessons.projects") return ok({ store, value: choices.filter((c) => c.scope.world === a.world) });
    if (op === "lessons.context") return ok({ state: "resolved", scope: { world: a.world, project: { kind: "project", id: P } }, project: { world: a.world, projectId: P, root: "/work/repo" }, worldMatch: options.catchAll ? "catch_all" : "configured", requiresConfirmation: options.catchAll === true });
    if (op === "lessons.browse") {
      let items = [...records.values()].filter((r) => r.key.world === a.world && (r.scope.project as Rec).kind === (a.project === "world" ? "world" : "project"));
      if (a.important === "true") items = items.filter((r) => r.important);
      if (typeof a.search === "string") items = items.filter((r) => (r.text ?? "").includes(a.search as string));
      if (a.collection === "saved") items = items.filter((r) => r.key.kind === "capture");
      if (options.pageSize !== undefined) {
        const at = typeof a.cursor === "string" ? Number(a.cursor.slice(1)) : 0;
        const page = items.slice(at, at + options.pageSize);
        const next = at + options.pageSize < items.length ? `c${at + options.pageSize}` : null;
        return ok({ store, value: { items: page.map(viewOf), nextCursor: next, total: items.length, sourceProblems: [], sourceProblemsTotal: 0 } });
      }
      return ok({ store, value: { items: items.map(viewOf), nextCursor: null, total: items.length, sourceProblems: [], sourceProblemsTotal: 0 } });
    }
    const rec = typeof a.key === "string" ? records.get(a.key) : undefined;
    if (op === "lessons.get") {
      if (rec === undefined) return ok({ store, value: null });
      const provenance = rec.status === "purged" ? { kind: "purged" } : rec.key.kind === "capture" ? { kind: "capture", source: rec.source } : { kind: "existing_lesson", state: "available", location: "active", digest: DIGEST, reflectionId: null, repo: "/work/repo", pattern: "p-one", created: STAMP };
      return ok({ store, value: { lesson: viewOf(rec), provenance, diagnostics: [] } });
    }
    if (op === "lessons.history") return ok({ store, value: { items: rec?.history ?? [], nextCursor: null, total: rec?.history.length ?? 0 } });
    if (op === "lessons.receipt") return ok({ store, value: receipts.get(a.requestId as string) ?? { state: "unknown", requestId: a.requestId } });
    if (op === "lessons.locate") return ok({ store, value: rec === undefined ? null : rec.scope });
    return { ok: false, error: { code: "OpNotAllowed", message: "not in this test", retryable: false } };
  };
  const mutate = (env: Envelope): unknown => {
    mutations.push(env);
    const requestId = env.requestId;
    if (state.refuse !== null) return { version: 1, requestId, error: { code: state.refuse, message: "refused", retryable: false }, conflict: null };
    const m = env.mutation.args.mutation;
    const key = m.key as LessonKey;
    const id = encodeLessonKey(key);
    const change = m.change as Rec;
    let rec = records.get(id);
    if (change.kind === "capture") {
      rec = { key, scope: m.scope as Rec, revision: 0, important: false, text: null, source: change.source as Rec, status: "saved", digest: null, related: null, history: [] };
      records.set(id, rec);
    }
    if (rec === undefined) return { version: 1, requestId, error: { code: "INVALID_INPUT", message: "no record", retryable: false }, conflict: null };
    if (change.kind === "purge") {
      rec.status = "purged";
      rec.text = null;
      rec.source = null;
      rec.history = [];
      const receipt = { requestId, payloadHash: null, state: "purged", result: null, error: null, startedAt: STAMP, finishedAt: STAMP };
      receipts.set(requestId, { state: "purged", requestId, key, startedAt: STAMP, finishedAt: STAMP });
      return { version: 1, requestId, receipt, store };
    }
    rec.revision += 1;
    if (change.kind === "capture" || change.kind === "edit") rec.text = change.text as string;
    if (change.kind === "important") rec.important = change.value as boolean;
    if (change.kind === "acknowledge-source") rec.status = "queued";
    rec.history.unshift({ revision: rec.revision, kind: change.kind, at: STAMP, text: (change.text as string | undefined) ?? null, important: change.kind === "important" ? change.value : null, oldSourceDigest: null, newSourceDigest: null });
    receipts.set(requestId, { state: "committed", requestId, payloadHash: HASH, key, revision: rec.revision, changed: true, startedAt: STAMP, finishedAt: STAMP });
    return { version: 1, requestId, receipt: { requestId, payloadHash: HASH, state: "completed", result: { key, revision: rec.revision, changed: true }, error: null, startedAt: STAMP, finishedAt: STAMP }, store };
  };
  const respond = (init: { stdin?: string } | undefined): Promise<FakeRunResult> => {
    const body = JSON.parse(init?.stdin ?? "null") as Rec;
    if (Object.hasOwn(body, "mutation")) {
      const env = body as unknown as Envelope;
      if (state.rejectMutation) {
        mutations.push(env);
        return Promise.reject(new Error("timed out after 10000 ms at /private/secret/path"));
      }
      const answer = (): FakeRunResult => ({ exitCode: 0, stdout: `${JSON.stringify(mutate(env))}\n`, stderr: "" });
      if (!state.holdMutations) return Promise.resolve(answer());
      return new Promise((resolve) => held.push(() => resolve(answer())));
    }
    const request = body as unknown as ControlRequest;
    const answer = (): FakeRunResult => {
      const results: Rec = {};
      for (const r of request.reads) results[r.id] = read(r.op, r.args as Rec);
      return { exitCode: 0, stdout: `${JSON.stringify({ version: 1, requestId: request.requestId, results })}\n`, stderr: "" };
    };
    const lessonRead = request.reads.length === 1 && String(request.reads[0]?.op).startsWith("lessons.");
    if (!(state.holdReads && lessonRead)) return Promise.resolve(answer());
    return new Promise((resolve) => held.push(() => resolve(answer())));
  };
  return { records, receipts, reads, mutations, held, state, respond };
}

function harness(options: HostOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "sil-ui-lessons-"));
  roots.push(root);
  const h = host(options);
  const engine = new FakeEngine({ sessionId: "sess-1", cwd: "/work/repo", pluginRoot: join(root, "plugin root"), runs: [{ match: (argv) => argv[0] === "/bin/sh", respond: h.respond }] });
  resetUiForTests();
  registerUi(engine.on as never);
  const render = (props: Rec = { bodyColumns: 80, view: {} }) => engine.answer<FakeElement>("ui.render", { surface: "terminal", component: "Pane", requestId: "sil-console", props });
  const lessonsState = () => engine.state.get(LESSONS_ID)?.value as Rec | undefined;
  return { engine, host: h, render, lessonsState, root };
}
type H = ReturnType<typeof harness>;

async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
}

function findKey(node: unknown, key: string): FakeElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findKey(child, key);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof node === "object" && node !== null) {
    const el = node as FakeElement;
    if (el.props?.key === key) return el;
    return findKey(el.props?.children, key);
  }
  return undefined;
}

function findAll(node: unknown, type: string, out: FakeElement[] = []): FakeElement[] {
  if (Array.isArray(node)) for (const child of node) findAll(child, type, out);
  else if (typeof node === "object" && node !== null) {
    const el = node as FakeElement;
    if (el.type === type) out.push(el);
    findAll(el.props?.children, type, out);
  }
  return out;
}

function allText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(allText).join("");
  if (typeof node === "object" && node !== null) {
    const el = node as FakeElement;
    const own = ["label", "source", "value"].map((k) => (typeof el.props?.[k] === "string" ? `${el.props[k] as string} ` : "")).join("");
    return `${own}${allText(el.props?.children)}\n`;
  }
  return "";
}

async function press(t: H, key: string, props?: Rec): Promise<void> {
  const button = findKey(await t.render(props), key);
  if (!button) throw new Error(`no control ${key}`);
  (button.props.onPress as (e: unknown) => void)({ surface: "terminal" });
  await settle();
}

async function type(t: H, key: string, text: string, kind: "change" | "submit" = "change"): Promise<void> {
  const input = findKey(await t.render(), key);
  if (!input || input.type !== "Input") throw new Error(`no input ${key}`);
  const handler = (kind === "change" ? input.props.onInput : input.props.onSubmit) as (v: string, e: unknown) => void;
  handler(text, { surface: "terminal" });
  await settle();
}

async function openActivity(t: H): Promise<void> {
  await t.engine.answer("command.run", { command: "sil", args: "" });
  await settle();
  await press(t, "section-activity");
  await press(t, "activity-tab-lessons");
}

async function openLessons(t: H): Promise<void> {
  await openActivity(t);
  await press(t, "lessons-open");
}

const lessonOps = (t: H) => t.host.reads.filter((r) => r.op.startsWith("lessons.")).map((r) => r.op);
const forbiddenCalls = (t: H) => t.engine.calls.filter((c) => /^(fs\.|store\.)/.test(c) || (c.startsWith("process.run") && !c.includes("/scripts/sil ops")));

/** A committed capture in the fake store, opened in the editor. */
async function capturedLesson(t: H, text = "Run the red test first."): Promise<void> {
  await openLessons(t);
  t.engine.selection = { text, requestId: "toolu_1" };
  await press(t, "lesson-capture");
  await press(t, "lesson-save");
}

describe("one pane, one command, Lessons inside Activity", () => {
  test("/sil registers once, the pane is the one console, and Activity keeps its inbox with a closed Lessons entry", async () => {
    const t = harness();
    await t.engine.fire("session.start", { cwd: "/work/repo", surface: "terminal", isInteractive: true }, { cwd: "/work/repo" });
    expect(t.engine.countCalls("command.register")).toBe(1);
    expect(t.engine.registrations.filter((r) => r.event === "command.run")).toHaveLength(1);
    expect(t.engine.registrations.filter((r) => r.event === "ui.render")).toHaveLength(1);
    await openActivity(t);
    const tree = await t.render();
    expect(allText(tree)).toContain("Inbox lesson from the fixture");
    expect(findKey(tree, "lessons-open")?.props.label).toBe("Open lessons");
    expect(findAll(tree, "Input")).toEqual([]);
    // Closed, nothing curated is read.
    expect(lessonOps(t)).toEqual([]);
    expect(t.engine.panes.map((p) => p.id)).toEqual(["sil-console"]);
  });

  test("the Lessons view is drawn only under Activity's Lessons tab, framed as Curated lessons", async () => {
    const t = harness();
    await t.engine.answer("command.run", { command: "sil", args: "" });
    await settle();
    await press(t, "section-activity");
    // Queue first: no Lessons view.
    expect(findKey(await t.render(), "lesson-capture")).toBeUndefined();
    await press(t, "activity-tab-lessons");
    let tree = await t.render();
    expect(findKey(tree, "lesson-capture")).toBeDefined();
    expect(allText(tree)).toContain("Curated lessons");
    await press(t, "lessons-open");
    tree = await t.render();
    expect(findKey(tree, "lessons-close")).toBeDefined();
    // The card's title, not a second title line inside it.
    expect(allText(tree).split("\n").filter((l) => l.trim() === "Curated lessons")).toHaveLength(1);
    for (const tab of ["queue", "reflections", "log"]) {
      await press(t, `activity-tab-${tab}`);
      tree = await t.render();
      expect(findKey(tree, "lesson-capture")).toBeUndefined();
      expect(findKey(tree, "lessons-close")).toBeUndefined();
    }
  });

  test("/sil capture opens Activity on its Lessons tab", async () => {
    const t = harness();
    t.engine.selection = { text: "Selected passage", requestId: "toolu_tab" };
    await t.engine.answer("command.run", { command: "sil", args: "capture" });
    await settle();
    const saved = t.engine.state.get("self-improvement-loop/console")?.value as Rec;
    expect(saved).toMatchObject({ section: "activity", activityTab: "lessons" });
    expect(findKey(await t.render(), "lesson-text")?.props.value).toBe("Selected passage");
  });

  test("other /sil arguments keep the plain console; capture and lesson are the only new ones", () => {
    expect(lessonCommand("")).toEqual({ kind: "none" });
    expect(lessonCommand("  ")).toEqual({ kind: "none" });
    expect(lessonCommand("status")).toEqual({ kind: "none" });
    expect(lessonCommand("capture")).toEqual({ kind: "capture" });
    expect(lessonCommand(" lesson abc ")).toEqual({ kind: "lesson", key: "abc" });
    expect(lessonCommand("lesson")).toEqual({ kind: "usage" });
  });
});

describe("browse: project, filters, search, record", () => {
  test("the session's project is adopted, filters and search send the shared flat args, a row opens its record", async () => {
    const t = harness();
    await capturedLesson(t);
    const browse = t.host.reads.filter((r) => r.op === "lessons.browse");
    expect(browse[0]?.args).toMatchObject({ world: W, project: P, binding: `installation:${I}`, collection: "saved", limit: "10" });
    await press(t, "lessons-filter-important");
    expect(t.host.reads.filter((r) => r.op === "lessons.browse").at(-1)?.args).toMatchObject({ collection: "all", important: "true" });
    await press(t, "lessons-filter-saved");
    // Search runs on Enter only: a change is kept for the redraw but reads nothing.
    const browsed = t.host.reads.filter((r) => r.op === "lessons.browse").length;
    await type(t, "lessons-search", "red test", "change");
    expect(t.host.reads.filter((r) => r.op === "lessons.browse")).toHaveLength(browsed);
    await type(t, "lessons-search", "red test", "submit");
    expect(t.host.reads.filter((r) => r.op === "lessons.browse").at(-1)?.args).toMatchObject({ search: "red test" });
    await press(t, "lesson-close");
    await press(t, "lesson-row-0");
    const get = t.host.reads.filter((r) => r.op === "lessons.get").at(-1);
    expect(get?.args).toMatchObject({ project: P, binding: `installation:${I}` });
    expect(allText(await t.render())).toContain("Revision 1.");
    expect(t.host.reads.some((r) => r.op === "lessons.history")).toBe(true);
    expect(forbiddenCalls(t)).toEqual([]);
  });

  test("a search over 200 characters is refused, not cut, and nothing is searched", async () => {
    const t = harness();
    await openLessons(t);
    const before = t.host.reads.filter((r) => r.op === "lessons.browse").length;
    await type(t, "lessons-search", "x".repeat(201), "submit");
    expect(t.host.reads.filter((r) => r.op === "lessons.browse")).toHaveLength(before);
    expect(allText(await t.render())).toContain("Search is limited to 200 characters");
  });

  test("a late list reply for the old project is dropped after a project switch", async () => {
    const t = harness();
    await openLessons(t);
    t.host.state.holdReads = true;
    await press(t, "lessons-filter-archived");
    const lateRelease = t.host.held.shift()!;
    const select = findKey(await t.render(), "lessons-project")!;
    (select.props.onSelect as (v: string) => void)("world");
    await settle();
    // The new project's read is held too; the old one now answers late.
    t.host.records.set("late", { key: { world: W, kind: "capture", id: "11111111-1111-4111-8111-111111111111" }, scope: { world: W, project: { kind: "project", id: P } }, revision: 1, important: false, text: "OLD PROJECT ROW", source: null, status: "saved", digest: null, related: null, history: [] });
    lateRelease();
    await settle();
    expect(allText(await t.render())).not.toContain("OLD PROJECT ROW");
    t.host.state.holdReads = false;
    for (const release of t.host.held.splice(0)) release();
    await settle();
    expect(t.host.reads.filter((r) => r.op === "lessons.browse").at(-1)?.args).toMatchObject({ project: "world" });
    expect(allText(await t.render())).not.toContain("OLD PROJECT ROW");
  });
});

/** Characters the tree draws: every string prop (labels, Input values, code
 * sources, option labels) and every text child. Handlers and keys excluded. */
function treeChars(node: unknown): number {
  if (typeof node === "string") return node.length;
  if (typeof node === "number") return String(node).length;
  if (Array.isArray(node)) return node.reduce((n: number, c) => n + treeChars(c), 0);
  if (typeof node === "object" && node !== null) {
    const el = node as FakeElement;
    let n = 0;
    for (const [k, v] of Object.entries(el.props ?? {})) {
      if (k === "key" || k === "children" || k === "color") continue;
      if (typeof v === "string") n += v.length;
      if (k === "options" && Array.isArray(v)) for (const o of v as Rec[]) n += String(o.label ?? "").length + String(o.value ?? "").length;
    }
    return n + treeChars(el.props?.children);
  }
  return 0;
}

describe("display bounds", () => {
  test("one synthetic maximal fixture of Activity plus Lessons, measured, stays under the parent's 90000-character display budget", async () => {
    const t = harness({ big: true });
    const big = "é".repeat(4000);
    for (let i = 0; i < 12; i++) {
      const key: LessonKey = { world: W, kind: "capture", id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111` };
      t.host.records.set(encodeLessonKey(key), {
        key, scope: { world: W, project: { kind: "project", id: P } }, revision: 10, important: true, text: big,
        source: { kind: "explicit_quote", quote: "q".repeat(4000), reference: "r".repeat(1000), quoteRedacted: false, captureSessionId: "s".repeat(128), sourceConversationId: null, sourceRowId: "x".repeat(128), sourceAgentId: null },
        status: "saved", digest: null, related: "keep-tests-honest",
        history: Array.from({ length: 10 }, (_, j) => ({ revision: 10 - j, kind: "edit", at: STAMP, text: big, important: null, oldSourceDigest: null, newSourceDigest: null })),
      });
    }
    await openLessons(t);
    // An existing record with its detail, history and an over-limit draft held on screen.
    await press(t, "lesson-row-0");
    await type(t, "lesson-text", "x".repeat(8192));
    const existingTree = await t.render();
    const existing = treeChars(existingTree);
    // Positive controls: the Lessons tab's full inbox and the record's detail
    // are really drawn. The other Activity parts sit under their own tabs.
    const drawn = allText(existingTree);
    expect(drawn).toContain("Lessons 1-5 of 999");
    expect(drawn).not.toContain("log19 www");
    expect(drawn).not.toContain("Reflections 1-10 of 999");
    expect(drawn).toContain("Revision 10.");
    expect(drawn).toContain(`Quote: ${"q".repeat(100)}`);
    expect(drawn).toContain("History, newest first (10 of 10)");
    expect(findKey(existingTree, "lesson-text")?.props.value).toBe("x".repeat(8192));
    // An explicit-quote capture with every field at the field cap.
    await press(t, "lesson-close");
    await press(t, "lesson-discard");
    await press(t, "lesson-capture");
    for (const key of ["lesson-text", "lesson-quote", "lesson-reference"]) await type(t, key, "y".repeat(8192));
    const capture = treeChars(await t.render());
    console.log(`measured display chars: existing record ${existing}, capture ${capture}`);
    expect(existing).toBeLessThan(90000);
    expect(capture).toBeLessThan(90000);
  });

  test("a field longer than 8192 characters is refused whole, says so, and the older text is never saved in its place", async () => {
    const t = harness();
    await openLessons(t);
    await press(t, "lesson-capture");
    await type(t, "lesson-quote", "quote");
    await type(t, "lesson-text", "ok wording");
    await type(t, "lesson-text", "z".repeat(8193));
    let tree = await t.render();
    expect(findKey(tree, "lesson-text")?.props.value).toBe("ok wording");
    expect(allText(tree)).toContain("over 8192 characters and was not kept");
    expect(allText(tree)).toContain("The wording you typed was over 8192 characters and was not kept. This field shows the earlier text");
    expect(JSON.stringify(t.lessonsState())).not.toContain("z".repeat(100));
    // Save would send "ok wording" as if it were the rejected text: refused.
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(0);
    expect(allText(await t.render())).toContain("Edit that field before saving; nothing was sent.");
    // A new accepted edit clears it, and that text is what is saved.
    await type(t, "lesson-text", "short wording");
    tree = await t.render();
    expect(allText(tree)).not.toContain("The wording you typed was over");
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(1);
    expect((t.host.mutations[0]!.mutation.args.mutation.change as Rec).text).toBe("short wording");
  });
});

describe("/sil lesson <encoded key>", () => {
  test("opens the exact record after its scope is located; a bad or foreign key is refused in words", async () => {
    const t = harness();
    await capturedLesson(t);
    const key = t.host.mutations[0]!.mutation.args.mutation.key as LessonKey;
    await press(t, "lesson-close");
    expect(findKey(await t.render(), "lesson-text")).toBeUndefined();
    const out = await t.engine.answer<{ text: string }>("command.run", { command: "sil", args: `lesson ${encodeLessonKey(key)}` });
    await settle();
    expect(out.text).toBe("Opened the lesson in the self-improvement loop console.");
    expect(t.host.reads.filter((r) => r.op === "lessons.locate").at(-1)?.args).toEqual({ key: encodeLessonKey(key), binding: `installation:${I}` });
    expect(findKey(await t.render(), "lesson-text")?.props.value).toBe("Run the red test first.");
    const bad = await t.engine.answer<{ text: string }>("command.run", { command: "sil", args: "lesson not-a-key" });
    expect(bad.text).toBe("That lesson key is not valid.");
    const foreign = await t.engine.answer<{ text: string }>("command.run", { command: "sil", args: `lesson ${encodeLessonKey({ ...key, world: "world-b" })}` });
    expect(foreign.text).toContain("belongs to world");
    expect(t.host.mutations).toHaveLength(1);
  });
});

describe("capture", () => {
  test("/sil capture reads the selection before opening the pane and keeps provenance unverified and separate", async () => {
    const t = harness();
    t.engine.selection = { text: "Selected passage about tests", requestId: "toolu_9" };
    const out = await t.engine.answer<{ text: string }>("command.run", { command: "sil", args: "capture" });
    await settle();
    expect(t.engine.indexOfCall("ui.selection")).toBeGreaterThanOrEqual(0);
    expect(t.engine.indexOfCall("ui.selection")).toBeLessThan(t.engine.indexOfCall("ui.open"));
    expect(out.text).toContain("lesson capture");
    const tree = await t.render();
    const wording = findKey(tree, "lesson-text")!;
    expect(wording.props.value).toBe("Selected passage about tests");
    expect(wording.props.autoFocus).toBe(true);
    // A command does not know which transcript is in view: row only.
    expect(allText(tree)).toContain("Source conversation: unknown. Row: toolu_9. Agent: unknown.");
    await type(t, "lesson-text", "Write the failing test before the fix.");
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(1);
    const m = t.host.mutations[0]!.mutation;
    expect(m.op).toBe("lessons.capture");
    expect(m.confirmed).toBe(false);
    const change = m.args.mutation.change as Rec;
    expect(change.text).toBe("Write the failing test before the fix.");
    expect(change.source).toEqual({ kind: "native_selection", quote: "Selected passage about tests", reference: null, quoteRedacted: false, captureSessionId: "sess-1", sourceConversationId: null, sourceRowId: "toolu_9", sourceAgentId: null });
    expect(m.args.projectRoot).toBe("/work/repo");
    expect(allText(await t.render())).toContain("Saved locally. Not installed or queued for learning.");
    expect(forbiddenCalls(t)).toEqual([]);
  });

  test("a press in the pane knows the view: the main view names the conversation, an agent view names the agent", async () => {
    const t = harness();
    await openLessons(t);
    t.engine.selection = { text: "From the main view", requestId: "toolu_2" };
    await press(t, "lesson-capture", { bodyColumns: 80, view: {} });
    expect(allText(await t.render())).toContain("Source conversation: sess-1. Row: toolu_2. Agent: unknown.");
    // The quote became the proposed wording, so cancelling is a dirty close: Discard.
    await press(t, "lesson-close");
    await press(t, "lesson-discard");
    t.engine.selection = { text: "From an agent view", requestId: "toolu_3" };
    await press(t, "lesson-capture", { bodyColumns: 80, view: { agentId: "agent-7" } });
    expect(allText(await t.render())).toContain("Source conversation: unknown. Row: toolu_3. Agent: agent-7.");
  });

  test("no selection, or one without a row, never borrows transcript identity", async () => {
    const t = harness();
    await openLessons(t);
    t.engine.selection = undefined;
    await press(t, "lesson-capture");
    let tree = await t.render();
    expect(allText(tree)).toContain("Selection unavailable. Paste the relevant passage or add a reference.");
    expect(findKey(tree, "lesson-quote")?.type).toBe("Input");
    expect(findKey(tree, "lesson-reference")?.type).toBe("Input");
    await press(t, "lesson-close");
    t.engine.selection = { text: "Spans several rows" };
    await press(t, "lesson-capture", { bodyColumns: 80, view: {} });
    tree = await t.render();
    expect(allText(tree)).toContain("which transcript row it came from is not known");
    expect(allText(tree)).toContain("Source conversation: unknown. Row: unknown. Agent: unknown.");
    // Only the selection was asked for: no transcript, no file, no model.
    expect(forbiddenCalls(t)).toEqual([]);
  });

  test("an explicit quote and reference capture keeps them apart from the wording", async () => {
    const t = harness();
    await openLessons(t);
    await press(t, "lesson-capture");
    await type(t, "lesson-quote", "Pasted passage");
    await type(t, "lesson-reference", "chat on Tuesday");
    await type(t, "lesson-text", "My own wording");
    await press(t, "lesson-save");
    const change = t.host.mutations[0]!.mutation.args.mutation.change as Rec;
    expect(change.text).toBe("My own wording");
    expect(change.source).toMatchObject({ kind: "explicit_quote", quote: "Pasted passage", reference: "chat on Tuesday", captureSessionId: "sess-1", sourceRowId: null });
  });
});

describe("limits and secrets", () => {
  test("wording and quote stop at 4000 bytes and reference at 1000, refused before anything is sent", async () => {
    const t = harness();
    await openLessons(t);
    await press(t, "lesson-capture");
    await type(t, "lesson-quote", "q");
    await type(t, "lesson-text", "é".repeat(2000) + "x");
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(0);
    expect(allText(await t.render())).toContain("Not saved: check text");
    await type(t, "lesson-text", "é".repeat(2000));
    await type(t, "lesson-quote", "q".repeat(4001));
    // What was typed stays on screen; it is not replaced by the older quote.
    expect(findKey(await t.render(), "lesson-quote")?.props.value).toBe("q".repeat(4001));
    expect(allText(await t.render())).toContain("The quote is over its 4000-byte limit");
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(0);
    await type(t, "lesson-quote", "q".repeat(4000));
    await type(t, "lesson-reference", "r".repeat(1001));
    expect(allText(await t.render())).toContain("The reference is over its 1000-byte limit");
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(0);
    await type(t, "lesson-reference", "r".repeat(1000));
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(1);
  });

  test("a selection over 4000 bytes is not used and not cut", async () => {
    const t = harness();
    await openLessons(t);
    t.engine.selection = { text: "z".repeat(4001), requestId: "toolu_1" };
    await press(t, "lesson-capture");
    const tree = await t.render();
    expect(allText(tree)).toContain("over 4000 bytes and was not used");
    expect(findKey(tree, "lesson-text")?.props.value).toBe("");
  });

  test("a secret in the wording is refused locally and never reaches session state, the store or logs", async () => {
    const t = harness();
    await openLessons(t);
    await press(t, "lesson-capture");
    await type(t, "lesson-quote", "harmless quote");
    await type(t, "lesson-text", `SENTINEL-plain wording`);
    // The plain sentinel reached the draft and the screened restore data.
    expect(JSON.stringify(t.lessonsState())).toContain("SENTINEL-plain wording");
    await type(t, "lesson-text", `SENTINEL-secret ${SECRET}`);
    expect(findKey(await t.render(), "lesson-text")?.props.value).toBe(`SENTINEL-secret ${SECRET}`);
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(0);
    expect(allText(await t.render())).toContain("This looks like a secret in wording");
    const held = JSON.stringify(t.lessonsState());
    expect(held).not.toContain("SENTINEL-secret");
    expect(held).not.toContain("SENTINEL-plain");
    expect(t.lessonsState()?.withheld).toBe("sensitive");
    expect(t.lessonsState()?.restore).toBeNull();
    expect(t.engine.storeWrites).toEqual([]);
    expect(t.engine.calls.filter((c) => c.startsWith("ui.log") && c.includes("SENTINEL"))).toEqual([]);
  });

  test("a selection that looks like a secret is refused before it reaches the draft", async () => {
    const t = harness();
    await openLessons(t);
    t.engine.selection = { text: `see ${SECRET}`, requestId: "toolu_1" };
    await press(t, "lesson-capture");
    const tree = await t.render();
    expect(allText(tree)).toContain("looks like it holds a secret and was not used");
    expect(JSON.stringify(t.lessonsState())).not.toContain(SECRET);
    expect(allText(tree)).not.toContain(SECRET);
  });

  test("the restore screen keeps clean wording and withholds what is over the limits", () => {
    const base = { revision: 0, text: "", important: false, source: null };
    const state = (text: string) => ({ ...JSON.parse(JSON.stringify({ generation: 1, gate: "ready", needsFreshDetail: false, expectedInstallation: null, address: null, target: null, mode: null, loaded: null, history: null, pending: null, unresolved: [], tombstones: [], tombstonesSaturated: false, resolutions: [], blocked: null, phase: "editing", error: null })), base, draft: { text, source: null } });
    expect(screenRestore(state("fine") as never).withheld).toBeNull();
    expect(screenRestore(state("x".repeat(4001)) as never)).toEqual({ restore: null, withheld: "size" });
    expect(screenRestore(state(SECRET) as never)).toEqual({ restore: null, withheld: "sensitive" });
  });
});

describe("writes", () => {
  test("Important is one desired-state write without confirmation, and unmark sends false", async () => {
    const t = harness();
    await capturedLesson(t);
    expect(t.host.mutations).toHaveLength(1);
    await press(t, "lesson-important");
    expect(t.host.mutations).toHaveLength(2);
    expect(t.host.mutations[1]!.mutation).toMatchObject({ op: "lessons.setImportant", confirmed: false });
    expect(t.host.mutations[1]!.mutation.args.mutation.change).toEqual({ kind: "important", value: true });
    expect(allText(await t.render())).toContain("Marked important.");
    expect(findKey(await t.render(), "lesson-important")?.props.label).toBe("Unmark important");
    await press(t, "lesson-important");
    expect(t.host.mutations[2]!.mutation.args.mutation.change).toEqual({ kind: "important", value: false });
    expect(allText(await t.render())).toContain("No longer marked important.");
  });

  test("purge needs an explicit confirmation, is verified by a fresh read, and is never sent again", async () => {
    const t = harness();
    await capturedLesson(t);
    await press(t, "lesson-purge");
    expect(t.host.mutations).toHaveLength(1);
    expect(allText(await t.render())).toContain("It cannot be undone.");
    await press(t, "lesson-purge-cancel");
    expect(findKey(await t.render(), "lesson-purge-confirm")).toBeUndefined();
    await press(t, "lesson-purge");
    await press(t, "lesson-purge-confirm");
    expect(t.host.mutations).toHaveLength(2);
    expect(t.host.mutations[1]!.mutation).toMatchObject({ op: "lessons.purge", confirmed: true });
    const tree = await t.render();
    expect(allText(tree)).toContain("A fresh read confirmed the purge.");
    expect(findKey(tree, "lesson-purge")).toBeUndefined();
    expect(findKey(tree, "lesson-retry")).toBeUndefined();
    expect(findKey(tree, "lesson-text")).toBeUndefined();
    await press(t, "lessons-refresh");
    expect(t.host.mutations).toHaveLength(2);
  });

  test("a double Save while the first is in flight sends one request, and actions hide while pending", async () => {
    const t = harness({ holdMutations: true });
    await openLessons(t);
    await press(t, "lesson-capture");
    await type(t, "lesson-quote", "q");
    await type(t, "lesson-text", "once");
    const tree = await t.render();
    const save = findKey(tree, "lesson-save")!;
    (save.props.onPress as (e: unknown) => void)({});
    (save.props.onPress as (e: unknown) => void)({});
    await settle();
    expect(t.host.mutations).toHaveLength(0);
    expect(t.host.held).toHaveLength(1);
    const pending = await t.render();
    expect(allText(pending)).toContain("Saving...");
    expect(findKey(pending, "lesson-save")).toBeUndefined();
    t.host.state.holdMutations = false;
    t.host.held.shift()!();
    await settle();
    expect(t.host.mutations).toHaveLength(1);
    expect(allText(await t.render())).toContain("Saved locally.");
  });

  test("a lost response stays unknown: no automatic retry, a receipt lookup settles it", async () => {
    const t = harness({ rejectMutation: true });
    await openLessons(t);
    await press(t, "lesson-capture");
    await type(t, "lesson-quote", "q");
    await type(t, "lesson-text", "maybe stored");
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(1);
    const requestId = t.host.mutations[0]!.requestId;
    let tree = await t.render();
    expect(allText(tree)).toContain(`Save outcome unknown for request ${requestId}`);
    expect(allText(tree)).not.toContain("/private/secret/path");
    await press(t, "lessons-refresh");
    expect(t.host.mutations).toHaveLength(1);
    // The host did commit it after all; the lookup finds that.
    const m = t.host.mutations[0]!.mutation.args.mutation;
    t.host.receipts.set(requestId, { state: "committed", requestId, payloadHash: HASH, key: m.key, revision: 1, changed: true, startedAt: STAMP, finishedAt: STAMP });
    t.host.records.set(encodeLessonKey(m.key as LessonKey), { key: m.key as LessonKey, scope: m.scope as Rec, revision: 1, important: false, text: "maybe stored", source: (m.change as Rec).source as Rec, status: "saved", digest: null, related: null, history: [] });
    await press(t, "lesson-check");
    expect(t.host.reads.some((r) => r.op === "lessons.receipt" && r.args.requestId === requestId)).toBe(true);
    expect(t.host.mutations).toHaveLength(1);
    tree = await t.render();
    expect(allText(tree)).not.toContain("Save outcome unknown");
  });

  test("a changed source is acknowledged with its displayed digest", async () => {
    const t = harness();
    const key: LessonKey = { world: W, kind: "inbox", id: "inbox-1" };
    t.host.records.set(encodeLessonKey(key), { key, scope: { world: W, project: { kind: "project", id: P } }, revision: 0, important: false, text: "Inbox wording", source: null, status: "changed", digest: DIGEST, related: "keep-tests-honest", history: [] });
    await openLessons(t);
    await press(t, "lessons-filter-inbox");
    await press(t, "lesson-row-0");
    const tree = await t.render();
    expect(allText(tree)).toContain("Source: changed.");
    expect(findKey(tree, "lesson-related")?.props.label).toContain("keep-tests-honest");
    await press(t, "lesson-acknowledge");
    expect(t.host.mutations[0]!.mutation.op).toBe("lessons.acknowledgeSource");
    expect(t.host.mutations[0]!.mutation.args.mutation.change).toEqual({ kind: "acknowledge-source", digest: DIGEST });
  });

  test("a related proposal opens the read-only Review at its pattern", async () => {
    const t = harness();
    const key: LessonKey = { world: W, kind: "inbox", id: "inbox-2" };
    t.host.records.set(encodeLessonKey(key), { key, scope: { world: W, project: { kind: "project", id: P } }, revision: 0, important: false, text: "Inbox wording", source: null, status: "queued", digest: DIGEST, related: "keep-tests-honest", history: [] });
    await openLessons(t);
    await press(t, "lessons-filter-inbox");
    await press(t, "lesson-row-0");
    await press(t, "lesson-related");
    const console = t.engine.state.get("self-improvement-loop/console")?.value as Rec;
    expect(console.section).toBe("review");
    expect(console.selectedPattern).toBe("keep-tests-honest");
    expect(t.host.mutations).toHaveLength(0);
  });
});

describe("dirty drafts, scope changes and reload", () => {
  test("closing with a dirty draft keeps it in memory and sends nothing", async () => {
    const t = harness();
    await openLessons(t);
    await press(t, "lesson-capture");
    await type(t, "lesson-text", "unsent wording");
    await press(t, "lessons-close");
    // The person closes the pane.
    t.engine.panes = [];
    await t.engine.fire("ui.close", { id: "sil-console", origin: { kind: "person" } }, { value: undefined });
    await settle();
    await t.engine.answer("command.run", { command: "sil", args: "" });
    await settle();
    await press(t, "section-activity");
    await press(t, "lessons-open");
    expect(findKey(await t.render(), "lesson-text")?.props.value).toBe("unsent wording");
    expect(t.host.mutations).toHaveLength(0);
  });

  test("a project or world change with a dirty draft asks Stay or Discard, and Stay keeps everything", async () => {
    const t = harness();
    await capturedLesson(t);
    await type(t, "lesson-text", "edited but unsent");
    const select = findKey(await t.render(), "lessons-project")!;
    (select.props.onSelect as (v: string) => void)("world");
    await settle();
    expect(findKey(await t.render(), "lesson-discard")).toBeDefined();
    await press(t, "lesson-stay");
    expect(findKey(await t.render(), "lesson-text")?.props.value).toBe("edited but unsent");
    // Discard on the project question drops the wording and does switch the project.
    (findKey(await t.render(), "lessons-project")!.props.onSelect as (v: string) => void)("world");
    await settle();
    await press(t, "lesson-discard");
    expect(findKey(await t.render(), "lesson-text")).toBeUndefined();
    expect(findKey(await t.render(), "lessons-project")?.props.value).toBe("world");
    expect(t.host.reads.filter((r) => r.op === "lessons.browse").at(-1)?.args).toMatchObject({ project: "world" });
    // Back to the record, dirty again, for the world question.
    (findKey(await t.render(), "lessons-project")!.props.onSelect as (v: string) => void)(P);
    await settle();
    await press(t, "lesson-row-0");
    await type(t, "lesson-text", "edited again");
    await press(t, "world-world-b");
    const consoleState = t.engine.state.get("self-improvement-loop/console")?.value as Rec;
    expect(consoleState.world).toBe(W);
    expect(findKey(await t.render(), "lesson-discard")).toBeDefined();
    await press(t, "lesson-discard");
    expect((t.engine.state.get("self-improvement-loop/console")?.value as Rec).world).toBe("world-b");
    expect(t.host.mutations).toHaveLength(1);
  });

  test("a save in flight across a project switch settles on its own record, not the new view", async () => {
    const t = harness({ holdMutations: true });
    await openLessons(t);
    await press(t, "lesson-capture");
    await type(t, "lesson-quote", "q");
    await type(t, "lesson-text", "in flight");
    await press(t, "lesson-save");
    expect(t.host.held).toHaveLength(1);
    // While the save runs the project is held: no picker, a line says so.
    const pending = await t.render();
    expect(findKey(pending, "lessons-project")).toBeUndefined();
    expect(allText(pending)).toContain("Project: repo (held while the save runs).");
    t.host.state.holdMutations = false;
    t.host.held.shift()!();
    await settle();
    expect(t.host.mutations).toHaveLength(1);
    expect([...t.host.records.values()].map((r) => r.text)).toEqual(["in flight"]);
  });

  test("a hot reload restores the screened draft through restore and reads the store again; a pending payload is never replayed", async () => {
    const t = harness({ rejectMutation: true });
    await openLessons(t);
    await press(t, "lesson-capture");
    await type(t, "lesson-quote", "q");
    await type(t, "lesson-text", "draft across reload");
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(1);
    const held = t.lessonsState() as Rec;
    expect(JSON.stringify(held.restore)).toContain("draft across reload");
    expect(JSON.stringify(held.restore)).not.toContain('"mutation":{');
    // A reload: a fresh module instance over the same session state.
    resetUiForTests();
    const before = t.host.reads.length;
    await t.engine.fire("session.start", { cwd: "/work/repo", surface: "terminal", isInteractive: true }, { cwd: "/work/repo" });
    await settle();
    t.host.state.rejectMutation = false;
    await press(t, "section-activity").catch(() => undefined);
    await press(t, "lessons-refresh");
    expect(t.host.reads.slice(before).some((r) => r.op === "lessons.store")).toBe(true);
    const tree = await t.render();
    expect(allText(tree)).toContain("Save outcome unknown");
    expect(findKey(tree, "lesson-retry")).toBeUndefined();
    expect(t.host.mutations).toHaveLength(1);
  });

  test("malformed lesson state after a reload is reset with a visible error, not an empty view", async () => {
    const t = harness();
    t.engine.state.set(LESSONS_ID, { value: { version: 1, rev: "x" }, version: 1 });
    await t.engine.fire("session.start", { cwd: "/work/repo", surface: "terminal", isInteractive: true }, { cwd: "/work/repo" });
    await openLessons(t);
    expect(allText(await t.render())).toContain("unreadable and was reset");
  });

  test("a restore value rewritten to name another record's live content is refused", async () => {
    const t = harness();
    t.engine.state.set(LESSONS_ID, {
      value: { version: 1, rev: 1, open: true, world: W, filter: "saved", project: P, search: "", restore: { generation: 1, phase: "bogus" }, withheld: null, snapshot: null },
      version: 1,
    });
    await t.engine.fire("session.start", { cwd: "/work/repo", surface: "terminal", isInteractive: true }, { cwd: "/work/repo" });
    await openActivity(t);
    expect(allText(await t.render())).toContain("refused as invalid and was reset");
  });
});

// Review fix round 1: each finding through the public render and press path.
describe("review fix round 1", () => {
  const sentChange = (t: H, i: number) => t.host.mutations[i]!.mutation.args.mutation.change as Rec;

  test("positive control: a plain capture saves its own selection and wording", async () => {
    const t = harness();
    await openLessons(t);
    t.engine.selection = { text: "first quote", requestId: "toolu_a" };
    await press(t, "lesson-capture");
    await type(t, "lesson-text", "handwritten unsent wording");
    await press(t, "lesson-save");
    expect(sentChange(t, 0)).toMatchObject({ text: "handwritten unsent wording", source: { quote: "first quote", sourceRowId: "toolu_a" } });
  });

  test("F1: a blocked second Capture keeps the dirty draft and its own source; Stay keeps both", async () => {
    const t = harness();
    await openLessons(t);
    t.engine.selection = { text: "first quote", requestId: "toolu_a" };
    await press(t, "lesson-capture");
    await type(t, "lesson-text", "handwritten unsent wording");
    t.engine.selection = { text: "second quote", requestId: "toolu_b" };
    await press(t, "lesson-capture");
    const tree = await t.render();
    expect(findKey(tree, "lesson-discard")).toBeDefined();
    expect(findKey(tree, "lesson-text")?.props.value).toBe("handwritten unsent wording");
    expect(allText(tree)).toContain("Row: toolu_a.");
    await press(t, "lesson-stay");
    await press(t, "lesson-save");
    expect(sentChange(t, 0)).toMatchObject({ text: "handwritten unsent wording", source: { quote: "first quote", sourceRowId: "toolu_a" } });
  });

  test("F1: Discard on a blocked second Capture opens the second selection with its own source", async () => {
    const t = harness();
    await openLessons(t);
    t.engine.selection = { text: "first quote", requestId: "toolu_a" };
    await press(t, "lesson-capture");
    await type(t, "lesson-text", "handwritten unsent wording");
    t.engine.selection = { text: "second quote", requestId: "toolu_b" };
    await press(t, "lesson-capture");
    await press(t, "lesson-discard");
    expect(findKey(await t.render(), "lesson-text")?.props.value).toBe("second quote");
    await press(t, "lesson-save");
    expect(sentChange(t, 0)).toMatchObject({ text: "second quote", source: { quote: "second quote", sourceRowId: "toolu_b" } });
  });

  test("F2: a same-row click on a dirty record keeps the dropped-field guard; Stay then Save sends nothing", async () => {
    const t = harness();
    await capturedLesson(t);
    await press(t, "lesson-close");
    await press(t, "lesson-row-0");
    await type(t, "lesson-text", "ok wording");
    await type(t, "lesson-text", "z".repeat(8193));
    await press(t, "lesson-row-0");
    expect(findKey(await t.render(), "lesson-discard")).toBeDefined();
    await press(t, "lesson-stay");
    expect(allText(await t.render())).toContain("The wording you typed was over 8192 characters and was not kept.");
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(1);
  });

  test("F2: a blocked Capture keeps the retained over-limit quote guard; Stay then Save sends nothing", async () => {
    const t = harness();
    await openLessons(t);
    await press(t, "lesson-capture");
    await type(t, "lesson-quote", "short quote");
    await type(t, "lesson-text", "wording");
    await type(t, "lesson-quote", "q".repeat(4001));
    await press(t, "lesson-capture");
    await press(t, "lesson-stay");
    expect(findKey(await t.render(), "lesson-quote")?.props.value).toBe("q".repeat(4001));
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(0);
  });

  test("F3: a catch-all world needs an explicit confirmation before a capture is saved; refresh does not confirm", async () => {
    const t = harness({ catchAll: true });
    await openLessons(t);
    t.engine.selection = { text: "inferred scope quote", requestId: "toolu_c" };
    await press(t, "lesson-capture");
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(0);
    let tree = await t.render();
    const confirm = findKey(tree, "lesson-confirm-scope");
    expect(confirm?.props.label).toBe("Confirm world world-a, project repo");
    await press(t, "lessons-refresh");
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(0);
    await press(t, "lesson-confirm-scope");
    tree = await t.render();
    expect(findKey(tree, "lesson-confirm-scope")).toBeUndefined();
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(1);
    expect(t.host.mutations[0]!.mutation.args.mutation.scope).toEqual({ world: W, project: { kind: "project", id: P } });
  });

  test("F4: many projects and many browse pages stay bounded while every option and page stays reachable", async () => {
    const t = harness({ projects: 600, pageSize: 10 });
    for (let i = 0; i < 60; i++) {
      const key: LessonKey = { world: W, kind: "capture", id: `${String(i).padStart(8, "0")}-2222-4222-8222-222222222222` };
      t.host.records.set(encodeLessonKey(key), { key, scope: { world: W, project: { kind: "project", id: P } }, revision: 1, important: false, text: `page-row-${i} ${"t".repeat(300)}`, source: null, status: "saved", digest: null, related: null, history: [] });
    }
    await openLessons(t);
    let tree = await t.render();
    const select = findKey(tree, "lessons-project")!;
    const options = select.props.options as Rec[];
    // Positive control: the real choices are drawn, the current one among them.
    expect(options.some((o) => o.value === P)).toBe(true);
    expect(options.some((o) => String(o.label).startsWith("extra-project-0-"))).toBe(true);
    expect(options.length).toBeLessThanOrEqual(26);
    console.log(`F4 measured display chars: 602 projects, first window ${treeChars(tree)}`);
    expect(treeChars(tree)).toBeLessThan(90000);
    // Every option is reachable by its window.
    for (let i = 0; i < 30 && findKey(tree, "lessons-projects-next") !== undefined; i++) {
      await press(t, "lessons-projects-next");
      tree = await t.render();
    }
    expect((findKey(tree, "lessons-project")!.props.options as Rec[]).some((o) => String(o.label).startsWith("extra-project-599-"))).toBe(true);
    // Browse pages replace each other; the sixth page is reachable and drawn alone.
    for (let i = 0; i < 5; i++) await press(t, "lessons-more");
    tree = await t.render();
    expect(allText(tree)).toContain("page-row-50 ");
    expect(allText(tree)).not.toContain("page-row-0 ");
    expect(findAll(tree, "Button").filter((b) => String(b.props.key).startsWith("lesson-row-"))).toHaveLength(10);
    console.log(`F4 measured display chars: browse page 6 of 60 rows ${treeChars(tree)}`);
    expect(treeChars(tree)).toBeLessThan(90000);
    await press(t, "lessons-prev");
    expect(allText(await t.render())).toContain("page-row-40 ");
  });

  test("F5: typed but unsent search text survives a redraw and a refresh, and only Enter runs it", async () => {
    const t = harness();
    await openLessons(t);
    const before = t.host.reads.filter((r) => r.op === "lessons.browse").length;
    const search = findKey(await t.render(), "lessons-search")!;
    const onInput = search.props.onInput as ((v: string, e: unknown) => void) | undefined;
    onInput?.("draft query", { surface: "terminal" });
    await settle();
    await press(t, "lessons-refresh");
    t.engine.tick();
    await settle();
    expect(findKey(await t.render(), "lessons-search")?.props.value).toBe("draft query");
    expect(t.host.reads.filter((r) => r.op === "lessons.browse").slice(before).some((r) => r.args.search !== undefined)).toBe(false);
    await type(t, "lessons-search", "draft query", "submit");
    expect(t.host.reads.filter((r) => r.op === "lessons.browse").at(-1)?.args.search).toBe("draft query");
  });

  for (const outcome of ["throw", "unset"] as const) {
    test(`F6: a session-state write that ${outcome === "throw" ? "is refused" : "answers isSet false"} keeps the draft and says so without its text`, async () => {
      const t = harness();
      await openLessons(t);
      await press(t, "lesson-capture");
      t.engine.stateSetOutcome = (id) => (id === LESSONS_ID ? outcome : null);
      await type(t, "lesson-text", "SENTINEL-persist wording");
      t.engine.stateSetOutcome = null;
      const tree = await t.render();
      expect(findKey(tree, "lesson-text")?.props.value).toBe("SENTINEL-persist wording");
      expect(allText(tree)).toContain("could not be kept in session state");
      const logs = t.engine.calls.filter((c) => c.startsWith("ui.log"));
      expect(logs.some((c) => c.includes("could not be kept in session state"))).toBe(true);
      expect(logs.some((c) => c.includes("SENTINEL"))).toBe(false);
    });
  }

  test("F6: positive control: a write that lands shows no persistence warning", async () => {
    const t = harness();
    await openLessons(t);
    await press(t, "lesson-capture");
    await type(t, "lesson-text", "landed wording");
    expect(allText(await t.render())).not.toContain("could not be kept in session state");
    expect(JSON.stringify(t.lessonsState())).toContain("landed wording");
  });

  test("F7: the purge confirmation names the world and the record, and purges exactly that record", async () => {
    const t = harness();
    await capturedLesson(t);
    const key = t.host.mutations[0]!.mutation.args.mutation.key as LessonKey;
    await press(t, "lesson-purge");
    const text = allText(await t.render());
    expect(text).toContain(`world ${W}`);
    expect(text).toContain(`capture ${key.id}`);
    await press(t, "lesson-purge-confirm");
    expect(t.host.mutations[1]!.mutation).toMatchObject({ op: "lessons.purge" });
    expect(t.host.mutations[1]!.mutation.args.mutation.key).toEqual(key);
  });

  test("F8: while a save is in flight, edits, capture, rows, project and world changes are held; after it ends they return", async () => {
    const t = harness({ holdMutations: true });
    await capturedLessonHeldSetup(t);
    const pending = await t.render();
    expect(findKey(pending, "lesson-text")?.type).not.toBe("Input");
    expect(findKey(pending, "lesson-quote")?.type).not.toBe("Input");
    expect(findKey(pending, "lesson-capture")).toBeUndefined();
    expect(findKey(pending, "lessons-project")).toBeUndefined();
    expect(findKey(pending, "lesson-row-0")).toBeUndefined();
    expect(allText(pending)).toContain("Saving...");
    await press(t, "world-world-b");
    expect((t.engine.state.get("self-improvement-loop/console")?.value as Rec).world).toBe(W);
    expect(allText(await t.render())).toContain("wait for it to finish");
    t.host.state.holdMutations = false;
    t.host.held.shift()!();
    await settle();
    const after = await t.render();
    expect(findKey(after, "lesson-text")?.type).toBe("Input");
    expect(findKey(after, "lesson-capture")).toBeDefined();
    expect(t.host.mutations).toHaveLength(1);
  });

  test("F8: an unknown outcome does not lock the editor: recovery and leaving stay available", async () => {
    const t = harness({ rejectMutation: true });
    await capturedLessonHeldSetup(t);
    const tree = await t.render();
    expect(findKey(tree, "lesson-check")).toBeDefined();
    expect(findKey(tree, "lesson-capture")).toBeDefined();
    expect(findKey(tree, "lesson-close")).toBeDefined();
  });

  async function capturedLessonHeldSetup(t: H): Promise<void> {
    await openLessons(t);
    await press(t, "lesson-capture");
    await type(t, "lesson-quote", "q");
    await type(t, "lesson-text", "held wording");
    await press(t, "lesson-save");
  }
});

// Review fix round 2: each open item through the public render, press and Input path.
describe("review fix round 2", () => {
  const NO_SELECTION_NOTE = "Selection unavailable. Paste the relevant passage or add a reference.";
  const NO_ROW_NOTE = "Selected text kept as a quote; which transcript row it came from is not known.";

  async function reload(t: H): Promise<void> {
    // A fresh module instance over the same session state, through the real resume.
    resetUiForTests();
    await t.engine.fire("session.start", { cwd: "/work/repo", surface: "terminal", isInteractive: true }, { cwd: "/work/repo" });
    await settle();
    await press(t, "section-activity").catch(() => undefined);
    await press(t, "lessons-refresh");
  }

  test("item 1: a blocked Capture keeps the open capture's note; Stay keeps it, Discard shows the new one", async () => {
    const t = harness();
    await openLessons(t);
    t.engine.selection = undefined;
    await press(t, "lesson-capture");
    expect(allText(await t.render())).toContain(NO_SELECTION_NOTE);
    await type(t, "lesson-text", "dirty A wording");
    t.engine.selection = { text: "B quote" };
    await press(t, "lesson-capture");
    let tree = await t.render();
    expect(findKey(tree, "lesson-discard")).toBeDefined();
    expect(allText(tree)).toContain(NO_SELECTION_NOTE);
    expect(allText(tree)).not.toContain(NO_ROW_NOTE);
    await press(t, "lesson-stay");
    tree = await t.render();
    expect(allText(tree)).toContain(NO_SELECTION_NOTE);
    expect(allText(tree)).not.toContain(NO_ROW_NOTE);
    expect(findKey(tree, "lesson-text")?.props.value).toBe("dirty A wording");
    await press(t, "lesson-capture");
    await press(t, "lesson-discard");
    tree = await t.render();
    expect(allText(tree)).toContain(NO_ROW_NOTE);
    expect(allText(tree)).not.toContain(NO_SELECTION_NOTE);
    expect(findKey(tree, "lesson-text")?.props.value).toBe("B quote");
  });

  test("item 2: a catch-all capture restored by a hot reload still needs confirmation before Save", async () => {
    const t = harness({ catchAll: true });
    await openLessons(t);
    t.engine.selection = { text: "inferred scope quote", requestId: "toolu_c" };
    await press(t, "lesson-capture");
    expect(findKey(await t.render(), "lesson-confirm-scope")).toBeDefined();
    await reload(t);
    // Positive control: the screened capture came back and is ready to save.
    const tree = await t.render();
    expect(findKey(tree, "lesson-text")?.props.value).toBe("inferred scope quote");
    expect(findKey(tree, "lesson-save")).toBeDefined();
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(0);
    expect(allText(await t.render())).toContain("Confirm the inferred world and project");
    await press(t, "lesson-confirm-scope");
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(1);
    expect(t.host.mutations[0]!.mutation.args.mutation.scope).toEqual({ world: W, project: { kind: "project", id: P } });
  });

  test("item 2: a restored catch-all project with no open capture gates the next capture", async () => {
    const t = harness({ catchAll: true });
    await openLessons(t);
    await reload(t);
    t.engine.selection = { text: "after reload quote", requestId: "toolu_d" };
    await press(t, "lesson-capture");
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(0);
    expect(findKey(await t.render(), "lesson-confirm-scope")).toBeDefined();
  });

  test("item 2: a restored project whose fresh context read fails is not approval", async () => {
    const t = harness();
    await openLessons(t);
    t.engine.selection = { text: "context unknown quote", requestId: "toolu_e" };
    await press(t, "lesson-capture");
    t.host.state.failRead = (op) => (op === "lessons.context" ? "STORAGE_BUSY" : null);
    await reload(t);
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(0);
    await press(t, "lesson-confirm-scope");
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(1);
  });

  test("item 2: positive control: a configured (not inferred) project restored by a reload saves without a gate", async () => {
    const t = harness();
    await openLessons(t);
    t.engine.selection = { text: "configured quote", requestId: "toolu_f" };
    await press(t, "lesson-capture");
    await reload(t);
    expect(findKey(await t.render(), "lesson-confirm-scope")).toBeUndefined();
    await press(t, "lesson-save");
    expect(t.host.mutations).toHaveLength(1);
  });

  test("item 3: /sil capture during a clean in-flight write is held before any world rebind", async () => {
    const t = harness();
    await capturedLesson(t);
    const key = t.host.mutations[0]!.mutation.args.mutation.key as LessonKey;
    t.host.state.holdMutations = true;
    await press(t, "lesson-important");
    expect(t.host.held).toHaveLength(1);
    expect(allText(await t.render())).toContain("Saving...");
    const pendingBefore = JSON.stringify((t.lessonsState() as Rec).snapshot);
    expect(pendingBefore).toContain(key.id);
    // The console's world goes away: the next bootstrap adopts world-b.
    t.host.state.boot = { worlds: ["world-b"], selectedWorld: "world-b", resolutionError: null, initialized: true };
    t.engine.selection = { text: "capture during send", requestId: "toolu_g" };
    const reply = (await t.engine.answer("command.run", { command: "sil", args: "capture" })) as { text: string };
    await settle();
    expect((t.engine.state.get("self-improvement-loop/console")?.value as Rec).world).toBe("world-b");
    expect(reply.text).toContain("held");
    expect(reply.text).not.toContain("Opened a lesson capture");
    const held = t.lessonsState() as Rec;
    expect(held.world).toBe(W);
    expect(JSON.stringify(held.snapshot)).toBe(pendingBefore);
    let tree = await t.render();
    expect(allText(tree)).not.toContain("capture during send");
    expect(allText(tree)).toContain("Saving...");
    expect(t.host.held).toHaveLength(1);
    // The attempt ends: leaving and recovery come back.
    t.host.state.holdMutations = false;
    t.host.held.shift()!();
    await settle();
    tree = await t.render();
    expect(t.host.mutations).toHaveLength(2);
    expect(t.host.mutations[1]!.mutation.args.mutation.key).toEqual(key);
    expect(t.host.records.get(encodeLessonKey(key))?.important).toBe(true);
    expect(findKey(tree, "lesson-close")).toBeDefined();
    expect(findKey(tree, "lesson-capture")).toBeDefined();
    await press(t, "lesson-close");
    await press(t, "lessons-refresh");
    expect((t.lessonsState() as Rec).world).toBe("world-b");
  });

  test("item 4: a failed Next or Previous read keeps the shown page, its label and rows, and a retry works", async () => {
    const t = harness({ pageSize: 10 });
    for (let i = 0; i < 15; i++) {
      const key: LessonKey = { world: W, kind: "capture", id: `${String(i).padStart(8, "0")}-3333-4333-8333-333333333333` };
      t.host.records.set(encodeLessonKey(key), { key, scope: { world: W, project: { kind: "project", id: P } }, revision: 1, important: false, text: `paged-row-${i}`, source: null, status: "saved", digest: null, related: null, history: [] });
    }
    await openLessons(t);
    let tree = await t.render();
    expect(allText(tree)).toContain("page 1:");
    expect(allText(tree)).toContain("paged-row-0 ");
    t.host.state.failRead = (op, a) => (op === "lessons.browse" && a.cursor === "c10" ? "STORAGE_BUSY" : null);
    await press(t, "lessons-more");
    tree = await t.render();
    expect(allText(tree)).toContain("Lessons unavailable");
    expect(allText(tree)).not.toContain("page 2");
    expect(allText(tree)).toContain("page 1:");
    expect(findKey(tree, "lessons-prev")).toBeUndefined();
    expect(String(findKey(tree, "lesson-row-0")?.props.label)).toContain("paged-row-0 ");
    expect(allText(tree)).not.toContain("paged-row-10 ");
    // Retry: the same Next now reads page 2.
    t.host.state.failRead = null;
    await press(t, "lessons-more");
    tree = await t.render();
    expect(allText(tree)).toContain("page 2:");
    expect(String(findKey(tree, "lesson-row-0")?.props.label)).toContain("paged-row-10 ");
    expect(allText(tree)).not.toContain("Lessons unavailable");
    // A failed Previous keeps page 2 and its rows; a retry goes back.
    t.host.state.failRead = (op, a) => (op === "lessons.browse" && a.cursor === undefined ? "STORAGE_BUSY" : null);
    await press(t, "lessons-prev");
    tree = await t.render();
    expect(allText(tree)).toContain("page 2:");
    expect(String(findKey(tree, "lesson-row-0")?.props.label)).toContain("paged-row-10 ");
    await press(t, "lessons-first");
    expect(allText(await t.render())).toContain("page 2:");
    t.host.state.failRead = null;
    await press(t, "lessons-first");
    tree = await t.render();
    expect(allText(tree)).toContain("page 1:");
    expect(String(findKey(tree, "lesson-row-0")?.props.label)).toContain("paged-row-0 ");
  });

  test("item 4: a save's reread of the old page that lands after a page move does not relabel its rows", async () => {
    const t = harness({ pageSize: 10 });
    // A saved capture, open in the editor, then more rows than one page.
    await capturedLesson(t, "raced-row-0");
    for (let i = 1; i < 15; i++) {
      const key: LessonKey = { world: W, kind: "capture", id: `${String(i).padStart(8, "0")}-4444-4444-8444-444444444444` };
      t.host.records.set(encodeLessonKey(key), { key, scope: { world: W, project: { kind: "project", id: P } }, revision: 1, important: false, text: `raced-row-${i}`, source: null, status: "saved", digest: null, related: null, history: [] });
    }
    await press(t, "lessons-refresh");
    expect(allText(await t.render())).toContain("page 1: 10 shown of 15");
    const lastOp = () => t.host.reads.at(-1)?.op;
    const release = async (i: number) => {
      t.host.held.splice(i, 1)[0]!();
      await settle();
    };
    t.host.state.holdMutations = true;
    t.host.state.holdReads = true;
    await press(t, "lesson-important"); // held: [mutation]
    await press(t, "lessons-more"); // browsing stays open while a save runs; held: [mutation, page 2]
    await release(0); // the save lands and reads back its record: held [page 2, get]
    await release(1);
    expect(lastOp()).toBe("lessons.get");
    await release(1);
    expect(lastOp()).toBe("lessons.history");
    expect(t.host.held).toHaveLength(2); // [page 2, the save's reread of the shown page]
    t.host.state.holdReads = false;
    await release(0);
    expect(t.host.reads.at(-1)?.args.cursor).toBe("c10");
    await release(0);
    expect(lastOp()).toBe("lessons.browse");
    expect(t.host.reads.at(-1)?.args.cursor).toBeUndefined();
    const tree = await t.render();
    expect(allText(tree)).toContain("page 2:");
    expect(String(findKey(tree, "lesson-row-0")?.props.label)).toContain("raced-row-10 ");
  });
});

// Review fix round 3: a successful reread racing a page move.
describe("review fix round 3", () => {
  async function pagedHost(): Promise<H> {
    const t = harness({ pageSize: 10 });
    for (let i = 0; i < 25; i++) {
      const key: LessonKey = { world: W, kind: "capture", id: `${String(i).padStart(8, "0")}-5555-4555-8555-555555555555` };
      t.host.records.set(encodeLessonKey(key), { key, scope: { world: W, project: { kind: "project", id: P } }, revision: 1, important: false, text: `clock-row-${i}`, source: null, status: "saved", digest: null, related: null, history: [] });
    }
    await openLessons(t);
    return t;
  }
  const release = async (t: H, i: number) => {
    t.engine.heldClock.splice(i, 1)[0]!();
    await settle();
  };
  async function shows(t: H, page: number, firstRow: number): Promise<void> {
    const tree = await t.render();
    expect(allText(tree)).toContain(`page ${page}:`);
    expect(String(findKey(tree, "lesson-row-0")?.props.label)).toContain(`clock-row-${firstRow} `);
  }

  // A refresh's successful reread is between its reply and its clock read when
  // the page move starts; the move's own read finishes first.
  for (const move of [
    { name: "Next", from: 1, key: "lessons-more", to: 2, toRow: 10, fromRow: 0 },
    { name: "Previous", from: 3, key: "lessons-prev", to: 2, toRow: 10, fromRow: 20 },
    { name: "First", from: 3, key: "lessons-first", to: 1, toRow: 0, fromRow: 20 },
  ] as const) {
    test(`a refresh reread that finishes after ${move.name} does not put its rows under the new page label`, async () => {
      const t = await pagedHost();
      for (let p = 1; p < move.from; p++) await press(t, "lessons-more");
      await shows(t, move.from, move.fromRow);
      t.engine.holdClock = true;
      await press(t, "lessons-refresh");
      expect(t.engine.heldClock).toHaveLength(1); // the reread of the shown page, answered
      await press(t, move.key);
      expect(t.engine.heldClock).toHaveLength(2); // the move's page, answered
      t.engine.holdClock = false;
      await release(t, 1);
      await shows(t, move.to, move.toRow);
      await release(t, 0);
      await shows(t, move.to, move.toRow);
      // Positive control: the next refresh rereads the page now shown.
      await press(t, "lessons-refresh");
      await shows(t, move.to, move.toRow);
    });
  }

  test("a page move a later one overtook is dropped: Next then First shows the first page", async () => {
    const t = await pagedHost();
    await press(t, "lessons-more");
    await shows(t, 2, 10);
    t.engine.holdClock = true;
    await press(t, "lessons-more"); // page 3, answered
    await press(t, "lessons-first"); // page 1, answered
    expect(t.engine.heldClock).toHaveLength(2);
    t.engine.holdClock = false;
    await release(t, 1);
    await shows(t, 1, 0);
    await release(t, 0);
    await shows(t, 1, 0);
    expect(findKey(await t.render(), "lessons-prev")).toBeUndefined();
  });

  test("positive control: a refresh reread that finishes before Next leaves Next in charge", async () => {
    const t = await pagedHost();
    t.engine.holdClock = true;
    await press(t, "lessons-refresh");
    await press(t, "lessons-more");
    t.engine.holdClock = false;
    await release(t, 0);
    await release(t, 0);
    await shows(t, 2, 10);
  });
});
