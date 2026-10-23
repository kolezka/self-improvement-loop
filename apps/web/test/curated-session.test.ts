// CuratedSession against an in-memory host: authority after a store swap,
// mount ownership of snapshots, exact-route precedence and invalidation,
// project intent, history paging, purge readback, Open existing and read
// freshness. The pane renders this same session.

import { describe, expect, test } from "bun:test";
import { encodeLessonKey } from "@sil/core/lesson-curation";
import { CuratedSession, type SessionDeps } from "../src/lib/curated-session.ts";
import { lessonRouteHash } from "../src/lib/curated-lessons.ts";
import { FakeHost, I, J, LOCATION, PROJECT_B, WORLD } from "./curated-host.ts";

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const A = { world: WORLD, kind: "capture" as const, id: "0b7c6f1e-4d1a-4c3b-9a55-2f1e8d7c6b5a" };
const B = { world: WORLD, kind: "capture" as const, id: "1b7c6f1e-4d1a-4c3b-9a55-2f1e8d7c6b5a" };
const WORLD_SCOPE = { world: WORLD, project: { kind: "world" as const } };
const B_SCOPE = { world: WORLD, project: { kind: "project" as const, id: PROJECT_B } };
const DRAFT = "SENTINEL unsent wording";

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  s: CuratedSession;
  toasts: Array<{ message: string; kind: string }>;
  hashes: string[];
  location: { hash: string };
  clock: { now: number };
}

function harness(host: FakeHost, storage: MemoryStorage, hash = "#/artifacts", shared?: { location: { hash: string }; clock: { now: number } }, fetchOverride?: typeof fetch): Harness {
  const toasts: Harness["toasts"] = [];
  const hashes: string[] = [];
  const location = shared?.location ?? { hash };
  const clock = shared?.clock ?? { now: 1_000 };
  const deps: SessionDeps & { now: () => number } = {
    world: WORLD,
    fetch: fetchOverride ?? host.fetch,
    headers: () => ({}),
    origin: "http://host",
    storage: () => storage as unknown as Storage,
    hash: () => location.hash,
    replaceHash: (next) => {
      location.hash = next;
      hashes.push(next);
    },
    toast: (message, kind) => toasts.push({ message, kind }),
    requestLeave: (proceed) => proceed(),
    setWorld: () => {},
    openReview: () => {},
    uuid: () => crypto.randomUUID(),
    timeoutMs: 60_000,
    now: () => clock.now,
  };
  return { s: new CuratedSession(deps), toasts, hashes, location, clock };
}

/** Mounted at I with record A open in the world-wide scope. */
async function openA(host: FakeHost, storage = new MemoryStorage()): Promise<Harness> {
  const h = harness(host, storage);
  await h.s.mount();
  h.s.chooseProject(WORLD_SCOPE.project);
  await settle();
  h.s.openLesson({ key: A, scope: WORLD_SCOPE });
  await settle();
  expect(h.s.view.editor.draft?.text).toBe("A words");
  return h;
}

function hostWithA(): FakeHost {
  const host = new FakeHost();
  host.addStore(I);
  host.current = I;
  host.seed(I, { key: A, text: "A words" });
  return host;
}

function storedSnapshot(storage: MemoryStorage): string {
  return [...storage.map.entries()].filter(([k]) => k.includes("curation-editor")).map(([, v]) => v).join("\n");
}

describe("group A: authority, recovery and mount ownership", () => {
  test("a read refused for another installation hides the editor and blocks writes before any save", async () => {
    const host = hostWithA();
    const h = await openA(host);
    h.s.editText(`A words ${DRAFT}`);
    const j = host.addStore(J);
    host.current = J;
    await h.s.refresh();
    await settle();
    expect(h.s.view.editor.draft).toBeNull();
    expect(h.s.view.editor.gate).not.toBe("ready");
    expect(h.s.view.items).toEqual([]);
    const posts = host.writes();
    await h.s.submit({ kind: "save" });
    await settle();
    expect(host.writes()).toBe(posts);
    expect(j.records.size).toBe(0);
    expect(j.receipts.size).toBe(0);
  });

  test("after a refused save, restoring I and refreshing recovers the exact unsaved wording", async () => {
    const host = hostWithA();
    const h = await openA(host);
    h.s.editText(`A words ${DRAFT}`);
    const j = host.addStore(J);
    host.current = J;
    await h.s.submit({ kind: "save" });
    await settle();
    expect(h.s.view.editor.gate).toBe("mismatch");
    expect(j.records.size).toBe(0);
    host.current = I;
    await h.s.refresh();
    await settle();
    await h.s.refresh();
    await settle();
    expect(h.s.view.editor.gate).toBe("ready");
    expect(h.s.view.editor.draft?.text).toBe(`A words ${DRAFT}`);
    expect(h.s.view.editor.loaded?.revision).toBe(1);
  });

  test("a restored I identity is not browsed as J on remount (installation- and location-bound)", async () => {
    for (const binding of ["installation", "location"] as const) {
      const host = binding === "installation" ? hostWithA() : new FakeHost();
      const storage = new MemoryStorage();
      let expected: string;
      if (binding === "installation") {
        const first = await openA(host, storage);
        first.s.editText(`A words ${DRAFT}`);
        const release = host.hold((method) => method === "POST");
        const sent = first.s.submit({ kind: "save" });
        await settle();
        first.s.dispose();
        release();
        await sent;
        expected = I;
      } else {
        // A bootstrap capture: its target stays bound to the location, with a proven origin.
        const first = harness(host, storage);
        await first.s.mount();
        first.s.chooseProject(WORLD_SCOPE.project);
        await settle();
        first.s.startCapture();
        first.s.editText("bootstrapped words");
        first.s.editSource({ quote: "q" });
        await first.s.submit({ kind: "save" });
        await settle();
        expect(first.s.view.editor.target?.binding.kind).toBe("location");
        expected = host.current!;
        expect(first.s.view.editor.expectedInstallation).toBe(expected);
        first.s.dispose();
      }
      const j = host.addStore(J);
      host.current = J;
      host.seed(J, { key: B, text: "J ONLY ROW" });
      const second = harness(host, storage);
      await second.s.mount();
      second.s.chooseProject(WORLD_SCOPE.project);
      await settle();
      expect({ binding, texts: second.s.view.items.map((item) => item.effectiveText) }).toEqual({ binding, texts: [] });
      expect(second.s.view.choices).toEqual([]);
      expect(second.s.view.editor.draft).toBeNull();
      expect(second.s.view.block?.expected).toBe(expected);
      expect(second.s.view.block?.current).toBe(J);
      expect(j.records.get(`capture:${B.id}`)?.revision).toBe(1);
      expect(j.receipts.size).toBe(0);
    }
  });

  test("a bootstrap with no proven origin does not browse the store that appeared", async () => {
    const host = new FakeHost();
    const storage = new MemoryStorage();
    const first = harness(host, storage);
    await first.s.mount();
    first.s.chooseProject(WORLD_SCOPE.project);
    await settle();
    first.s.startCapture();
    first.s.editText("bootstrap words");
    first.s.editSource({ quote: "q" });
    // The store appears before the bootstrap lands: the host refuses it.
    host.current = host.addStore(J).installationId;
    host.seed(J, { key: B, text: "J ONLY ROW" });
    await first.s.submit({ kind: "save" });
    await settle();
    expect(first.s.view.editor.phase).toBe("unknown");
    await first.s.refresh();
    await settle();
    expect(first.s.view.items.map((item) => item.effectiveText)).not.toContain("J ONLY ROW");
    expect(first.s.view.block?.reason).toBe("unknown-origin");
    expect(host.stores.get(J)!.records.size).toBe(1);
  });

  test("an unmounted pane's late completion cannot overwrite the newer pane's snapshot, hash or toasts", async () => {
    const host = hostWithA();
    host.seed(I, { key: B, text: "B words" });
    const storage = new MemoryStorage();
    const old = await openA(host, storage);
    old.s.editText("A words R1");
    const releaseR1 = host.hold((method) => method === "POST");
    const r1 = old.s.submit({ kind: "save" });
    await settle();
    old.s.dispose();
    const fresh = harness(host, storage, "#/artifacts", { location: old.location, clock: old.clock });
    await fresh.s.mount();
    await settle();
    fresh.s.openLesson({ key: B, scope: WORLD_SCOPE });
    await settle();
    fresh.s.editText("B words R2");
    const releaseR2 = host.hold((method) => method === "POST");
    const r2 = fresh.s.submit({ kind: "save" });
    await settle();
    const r2Id = fresh.s.view.editor.pending?.requestId;
    expect(r2Id).toBeDefined();
    const hashBefore = old.location.hash;
    releaseR1();
    await r1;
    await settle();
    expect(storedSnapshot(storage)).toContain(r2Id!);
    expect(old.toasts).toEqual([]);
    expect(old.location.hash).toBe(hashBefore);
    releaseR2();
    await r2;
  });
});

describe("group B: exact route and project intent", () => {
  test("a direct link to B wins over a stored A snapshot, and A's pending id is kept", async () => {
    const host = hostWithA();
    host.seed(I, { key: B, text: "B words" });
    const storage = new MemoryStorage();
    const first = await openA(host, storage);
    first.s.editText("A words pending");
    const release = host.hold((method) => method === "POST");
    const sent = first.s.submit({ kind: "save" });
    await settle();
    const pendingA = first.s.view.editor.pending!.requestId;
    first.s.dispose();
    const second = harness(host, storage, lessonRouteHash(I, B));
    await second.s.mount();
    await settle();
    expect(second.s.view.editor.target?.key).toEqual(B);
    expect(host.calls.some((c) => c.path === "/api/lessons/locate" && c.query["key"] === encodeLessonKey(B))).toBe(true);
    expect(second.s.view.editor.unresolved.map((u) => u.requestId)).toContain(pendingA);
    release();
    await sent;
  });

  test("a direct link to B wins over a clean stored A snapshot", async () => {
    const host = hostWithA();
    host.seed(I, { key: B, text: "B words" });
    const storage = new MemoryStorage();
    const first = await openA(host, storage);
    first.s.dispose();
    const second = harness(host, storage, lessonRouteHash(I, B));
    await second.s.mount();
    await settle();
    expect(second.s.view.editor.target?.key).toEqual(B);
    expect(second.s.view.editor.draft?.text).toBe("B words");
    const gets = host.calls.filter((c) => c.path === "/api/lessons/get").map((c) => c.query["key"]);
    expect(gets.at(-1)).toBe(encodeLessonKey(B));
  });

  test("a project change asks first when the editor is dirty; Stay keeps scope, Discard closes the old editor", async () => {
    const host = hostWithA();
    const h = await openA(host);
    h.s.editText(`A words ${DRAFT}`);
    h.s.selectProject(PROJECT_B);
    expect(h.s.view.leavePrompt).not.toBeNull();
    expect(h.s.view.project).toEqual(WORLD_SCOPE.project);
    h.s.stay();
    expect(h.s.view.project).toEqual(WORLD_SCOPE.project);
    expect(h.s.view.editor.draft?.text).toBe(`A words ${DRAFT}`);
    h.s.selectProject(PROJECT_B);
    h.s.discardAndGo();
    await settle();
    expect(h.s.view.project).toEqual(B_SCOPE.project);
    expect(h.s.view.editor.target).toBeNull();
  });

  test("a later route intent cancels an earlier lookup", async () => {
    for (const next of ["#/artifacts", "#/artifacts/lesson/not-a-uuid/xyz", "project"] as const) {
      const host = hostWithA();
      const h = harness(host, new MemoryStorage());
      await h.s.mount();
      h.s.chooseProject(WORLD_SCOPE.project);
      await settle();
      const release = host.hold((_m, path) => path === "/api/lessons/locate");
      h.location.hash = lessonRouteHash(I, A);
      h.s.onRouteChange("#/artifacts");
      await settle();
      if (next === "project") h.s.selectProject(PROJECT_B);
      else {
        const old = h.location.hash;
        h.location.hash = next;
        h.s.onRouteChange(old);
      }
      release();
      await settle();
      expect(h.s.view.editor.target).toBeNull();
      expect(h.location.hash.includes(encodeLessonKey(A))).toBe(false);
    }
  });

  test("a rejected link hides the previous record and looks nothing up", async () => {
    const enc = (k: object) => Buffer.from(JSON.stringify(Object.values(k))).toString("base64url");
    const routes = {
      wrongInstallation: lessonRouteHash(J, B),
      foreign: `#/artifacts/lesson/${I}/${enc({ world: "other-world", kind: "capture", id: B.id })}`,
      invalid: "#/artifacts/lesson/not-a-uuid/xyz",
    };
    for (const [name, route] of Object.entries(routes)) {
      const host = hostWithA();
      const h = await openA(host);
      const locates = host.calls.filter((c) => c.path === "/api/lessons/locate").length;
      const old = h.location.hash;
      h.location.hash = route;
      h.s.onRouteChange(old);
      await settle();
      expect({ name, target: h.s.view.editor.target }).toEqual({ name, target: null });
      expect(host.calls.filter((c) => c.path === "/api/lessons/locate").length).toBe(locates);
    }
  });
});

describe("group C: history, purge, conflicts and freshness", () => {
  test("history pages past 20 revisions down to r1", async () => {
    const host = hostWithA();
    const rec = host.stores.get(I)!.records.get(`capture:${A.id}`)!;
    for (let r = 2; r <= 25; r++) rec.history.push({ revision: r, kind: "important", at: "2026-10-22T10:00:00.000Z", text: null, important: r % 2 === 0, oldSourceDigest: null, newSourceDigest: null });
    rec.revision = 25;
    const h = await openA(host);
    await settle();
    expect(h.s.view.extras?.historyTotal).toBe(25);
    expect(h.s.view.extras?.historyCursor).not.toBeNull();
    await h.s.loadMoreHistory();
    await settle();
    expect(h.s.view.extras?.history?.map((e) => e.revision)).toContain(1);
    expect(h.s.view.extras?.historyCursor).toBeNull();
  });

  test("no purge success before a fresh tombstone read", async () => {
    const host = hostWithA();
    const h = await openA(host);
    const release = host.hold((method, path) => method === "GET" && path === "/api/lessons/get");
    const done = h.s.submit({ kind: "purge", confirmed: true });
    await settle();
    expect(h.toasts.filter((t) => t.kind === "ok")).toEqual([]);
    release();
    await done;
    await settle();
    expect(h.toasts.filter((t) => t.kind === "ok").length).toBe(1);
    expect(h.s.view.purgeCheck).toBe("verified");
  });

  test("a PURGED refusal never reports a purge as established without readback", async () => {
    const host = hostWithA();
    const h = await openA(host);
    host.stores.get(I)!.records.get(`capture:${A.id}`)!.purged = true;
    const release = host.hold((method, path) => method === "GET" && path === "/api/lessons/get");
    h.s.editText("A words more");
    const done = h.s.submit({ kind: "save" });
    await settle();
    expect(h.s.view.editor.phase).toBe("purged");
    expect(h.toasts.filter((t) => t.kind === "ok")).toEqual([]);
    host.current = null;
    release();
    await done;
    await settle();
    expect(h.toasts.filter((t) => t.kind === "ok")).toEqual([]);
    expect(h.s.view.purgeCheck).toBe("unavailable");
    expect(h.s.view.editor.draft).toBeNull();
  });

  test("CAPTURE_EXISTS offers Open existing, keeping wording until a deliberate choice", async () => {
    const host = hostWithA();
    const h = harness(host, new MemoryStorage());
    await h.s.mount();
    h.s.chooseProject(WORLD_SCOPE.project);
    await settle();
    h.s.startCapture();
    const recordId = h.s.view.editor.target!.key.id;
    host.seed(I, { key: { world: WORLD, kind: "capture", id: recordId }, text: "already stored", revision: 3 });
    h.s.editText("my capture wording");
    h.s.editSource({ quote: "q" });
    await h.s.submit({ kind: "save" });
    await settle();
    expect(h.s.view.captureExists).toBe(true);
    expect(h.s.view.editor.draft?.text).toBe("my capture wording");
    h.s.openExisting();
    expect(h.s.view.leavePrompt).not.toBeNull();
    h.s.discardAndGo();
    await settle();
    expect(h.s.view.editor.mode).toBe("existing");
    expect(h.s.view.editor.target?.key.id).toBe(recordId);
    expect(h.s.view.editor.loaded?.revision).toBe(3);
    expect(h.s.view.editor.draft?.text).toBe("already stored");
  });

  test("freshness comes from the accepted read, keeps a stale label after failure and resets on scope change", async () => {
    const host = hostWithA();
    const storage = new MemoryStorage();
    const h = harness(host, storage);
    h.clock.now = 5_000;
    await h.s.mount();
    h.s.chooseProject(WORLD_SCOPE.project);
    await settle();
    expect(h.s.view.listReadAt).toBe(5_000);
    h.s.openLesson({ key: A, scope: WORLD_SCOPE });
    await settle();
    expect(h.s.view.detailReadAt).toBe(5_000);
    h.clock.now = 9_000;
    host.failPath = "/api/lessons/browse";
    await h.s.reloadList();
    await settle();
    expect(h.s.view.listReadAt).toBe(5_000);
    expect(h.s.view.listStale).toBe(true);
    host.failPath = null;
    h.s.closeEditor();
    h.s.selectProject(PROJECT_B);
    await settle();
    expect(h.s.view.listReadAt).toBe(9_000);
    expect(h.s.view.listStale).toBe(false);
  });
});

/** Host fetch whose next POST commits and then loses its response. */
function losing(host: FakeHost): { fetch: typeof fetch; loseNext: () => void } {
  let lose = false;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await host.fetch(input, init);
    if (lose && init?.method === "POST") {
      lose = false;
      throw new TypeError("synthetic: response lost after commit");
    }
    return response;
  }) as typeof fetch;
  return { fetch: f, loseNext: () => (lose = true) };
}

/** I with A open, an edit committed at r2 whose response was lost: phase unknown with request R. */
async function unknownCommittedSave(): Promise<{ host: FakeHost; h: Harness; requestId: string; storage: MemoryStorage }> {
  const host = hostWithA();
  const lost = losing(host);
  const storage = new MemoryStorage();
  const h = harness(host, storage, "#/artifacts", undefined, lost.fetch);
  await h.s.mount();
  h.s.chooseProject(WORLD_SCOPE.project);
  await settle();
  h.s.openLesson({ key: A, scope: WORLD_SCOPE });
  await settle();
  h.s.editText(`A words ${DRAFT}`);
  lost.loseNext();
  await h.s.submit({ kind: "save" });
  await settle();
  expect(h.s.view.editor.phase).toBe("unknown");
  const requestId = h.s.view.editor.pending!.requestId;
  expect(host.stores.get(I)!.receipts.get(requestId)?.revision).toBe(2);
  return { host, h, requestId, storage };
}

const heldIds = (h: Harness) => [h.s.view.editor.pending?.requestId, ...h.s.view.editor.unresolved.map((u) => u.requestId)];

describe("read context: cancellation progress", () => {
  test("a same-I refresh does not strand a pending purge readback", async () => {
    const host = hostWithA();
    const h = await openA(host);
    const release = host.hold((_method, path) => path === "/api/lessons/get");
    const done = h.s.submit({ kind: "purge", confirmed: true });
    await settle();
    expect(h.s.view.purgeCheck).toBe("pending");
    await h.s.refresh();
    release();
    await done;
    await settle();
    expect(host.stores.get(I)!.records.get(`capture:${A.id}`)?.purged).toBe(true);
    expect(h.s.view.editor.target?.key).toEqual(A);
    expect(h.s.view.purgeCheck).toBe("verified");
    expect(h.toasts.filter((toast) => toast.kind === "ok")).toHaveLength(1);
  });

  test("an identity-changing refresh terminates purge verification and later refresh recovers it", async () => {
    const host = hostWithA();
    const h = await openA(host);
    const release = host.hold((_method, path) => path === "/api/lessons/get");
    const done = h.s.submit({ kind: "purge", confirmed: true });
    await settle();
    host.addStore(J);
    host.current = J;
    await h.s.refresh();
    release();
    await done;
    expect(host.stores.get(I)!.records.get(`capture:${A.id}`)?.purged).toBe(true);
    expect(h.s.view.editor.target?.key).toEqual(A);
    expect(h.s.view.purgeCheck).toBe("unavailable");
    expect(h.toasts.filter((toast) => toast.kind === "ok")).toEqual([]);
    host.current = I;
    await h.s.refresh();
    await settle();
    expect(h.s.view.purgeCheck).toBe("verified");
    expect(h.toasts.filter((toast) => toast.kind === "ok")).toEqual([]);
  });

  test("an abandoned purge verification cannot change a newer B view", async () => {
    const host = hostWithA();
    host.seed(I, { key: B, text: "B words" });
    const h = await openA(host);
    const release = host.hold((_method, path) => path === "/api/lessons/get");
    const done = h.s.submit({ kind: "purge", confirmed: true });
    await settle();
    expect(h.s.view.purgeCheck).toBe("pending");
    h.s.closeEditor();
    h.s.openLesson({ key: B, scope: WORLD_SCOPE });
    await settle();
    release();
    await done;
    expect(host.stores.get(I)!.records.get(`capture:${A.id}`)?.purged).toBe(true);
    expect(h.s.view.editor.target?.key).toEqual(B);
    expect(h.s.view.editor.loaded?.effectiveText).toBe("B words");
    expect(h.s.view.purgeCheck).toBeNull();
    expect(h.toasts.filter((toast) => toast.kind === "ok")).toEqual([]);
  });

  test("closing hydrated A during first handshake reaches a usable same-I project", async () => {
    const host = hostWithA();
    const storage = new MemoryStorage();
    const first = await openA(host, storage);
    first.s.dispose();
    const h = harness(host, storage);
    const release = host.hold((_method, path) => path === "/api/lessons/projects");
    const mounting = h.s.mount();
    await settle();
    expect(h.s.view.editor.target?.key).toEqual(A);
    h.s.closeEditor();
    release();
    await mounting;
    await settle();
    expect(h.s.view.editor.target).toBeNull();
    expect(h.s.view.store).toEqual({ state: "ready", installationId: I });
    expect(h.s.installationId).toBe(I);
    expect(h.s.view.choices.length).toBeGreaterThan(0);
    expect(h.s.view.project).toEqual(WORLD_SCOPE.project);
    expect(h.s.view.block).toBeNull();
    expect(h.s.view.handshakeError).toBeNull();
  });

  test("closing hydrated I while J replaces it cannot adopt J during restarted discovery", async () => {
    const host = hostWithA();
    const storage = new MemoryStorage();
    const first = await openA(host, storage);
    first.s.dispose();
    const h = harness(host, storage);
    const release = host.hold((_method, path) => path === "/api/lessons/projects");
    const mounting = h.s.mount();
    await settle();
    host.addStore(J);
    host.seed(J, { key: B, text: "J ONLY ROW" });
    host.current = J;
    h.s.closeEditor();
    release();
    await mounting;
    await settle();
    expect(h.s.view.editor.target).toBeNull();
    expect(h.s.view.block?.expected).toBe(I);
    expect(h.s.view.block?.reason).toBe("mismatch");
    expect(h.s.view.items).toEqual([]);
    expect(h.s.view.choices).toEqual([]);
    expect(h.s.installationId).toBeNull();
  });

  test("Back to list after observed purge cannot retain its old cached row", async () => {
    const host = hostWithA();
    const h = await openA(host);
    const release = host.hold((_method, path) => path === "/api/lessons/browse");
    const done = h.s.submit({ kind: "purge", confirmed: true });
    await settle();
    expect(host.stores.get(I)!.records.get(`capture:${A.id}`)?.purged).toBe(true);
    expect(h.s.view.purgeCheck).toBe("verified");
    expect(h.toasts.filter((toast) => toast.kind === "ok")).toHaveLength(1);
    h.s.closeEditor();
    expect(h.s.view.items.map((item) => item.key.id)).not.toContain(A.id);
    release();
    await done;
    await settle();
    expect(h.s.view.editor.target).toBeNull();
    expect(h.s.view.items.map((item) => item.key.id)).not.toContain(A.id);
    expect(h.s.view.project).toEqual(WORLD_SCOPE.project);
    expect(h.s.view.block).toBeNull();
  });
});

describe("read context: identity, ordering and leave veto", () => {
  test("a store appearing during an uninitialized browse needs a fresh handshake", async () => {
    const host = new FakeHost();
    const h = harness(host, new MemoryStorage());
    await h.s.mount();
    h.s.chooseProject(WORLD_SCOPE.project);
    await settle();
    expect(h.s.view.store?.state).toBe("uninitialized");
    expect(h.s.view.listReadAt).toBe(1_000);
    host.addStore(J);
    host.seed(J, { key: A, text: "J new words" });
    host.current = J;
    h.clock.now = 2_000;
    await h.s.reloadList();
    expect(h.s.view.items).toEqual([]);
    expect(h.s.view.listReadAt).toBe(1_000);
    expect(h.s.view.listStale).toBe(true);
    expect(h.s.view.listError).toContain("store changed");
    expect(h.s.installationId).toBeNull();
    await h.s.refresh();
    await settle();
    expect(h.s.view.block).toBeNull();
    expect(h.s.installationId).toBe(J);
    expect(h.s.view.items.map((row) => row.effectiveText)).toEqual(["J new words"]);
  });

  test("a route during a held cold-start handshake starts fresh discovery", async () => {
    const host = hostWithA();
    const h = harness(host, new MemoryStorage());
    const release = host.hold((_method, path) => path === "/api/lessons/projects");
    const mounting = h.s.mount();
    await settle();
    const oldHash = h.location.hash;
    h.location.hash = lessonRouteHash(I, A);
    h.s.onRouteChange(oldHash);
    release();
    await mounting;
    await settle();
    expect(h.s.view.block).toBeNull();
    expect(h.s.view.routeError).toBeNull();
    expect(h.s.view.editor.loaded?.effectiveText).toBe("A words");
    expect(host.calls.filter((call) => call.path === "/api/lessons/projects").length).toBeGreaterThanOrEqual(2);
  });

  test("changing the search query invalidates an older browse before debounce", async () => {
    const host = hostWithA();
    const h = await openA(host);
    expect(h.s.view.listReadAt).toBe(1_000);
    const release = host.hold((_method, path) => path === "/api/lessons/browse", { respondFirst: true });
    h.clock.now = 2_000;
    const old = h.s.reloadList();
    await settle();
    h.s.setSearch("different query");
    release();
    await old;
    expect(h.s.view.search).toBe("different query");
    expect(h.s.view.listReadAt).toBe(1_000);
    await h.s.reloadList();
    expect(h.s.view.listReadAt).toBe(2_000);
  });

  test("typing does not invalidate a fresh detail read or source metadata", async () => {
    const host = hostWithA();
    const h = await openA(host);
    const release = host.hold((_method, path) => path === "/api/lessons/get", { respondFirst: true });
    const loading = h.s.loadDetail();
    await settle();
    h.s.editText("A unsent wording");
    release();
    await loading;
    expect(h.s.view.editor.draft?.text).toBe("A unsent wording");
    expect(h.s.view.extras?.provenance.kind).toBe("capture");
    expect(h.s.view.detailReadAt).not.toBeNull();
  });

  test("quarantined leave validates a candidate before discarding private wording", async () => {
    const host = hostWithA();
    const storage = new MemoryStorage();
    const target = { scope: WORLD_SCOPE, binding: { kind: "location" as const, id: LOCATION }, installationId: I, key: A };
    const unresolved = Array.from({ length: 64 }, () => ({ requestId: `lc_${crypto.randomUUID()}`, scope: WORLD_SCOPE, binding: target.binding, key: { world: WORLD, kind: "capture", id: crypto.randomUUID() } }));
    const pendingId = `lc_${crypto.randomUUID()}`;
    storage.setItem(`sil-curation-editor:v2:${WORLD}`, JSON.stringify({ owner: "earlier", snapshot: { version: 4, expectedInstallation: I, address: target.binding, target, mode: "existing", pendingRequestId: pendingId, pendingIdentity: { requestId: pendingId, ...target }, unresolved, tombstones: [], tombstonesSaturated: false, resolutions: [] } }));
    const h = harness(host, storage, lessonRouteHash(I, A));
    await h.s.mount();
    await settle();
    h.s.editText("private unsent wording");
    expect(h.s.dirty).toBe(true);
    host.addStore(J);
    host.current = J;
    await h.s.refresh();
    expect(h.s.view.editor.gate).toBe("mismatch");
    let proceeded = false;
    expect(h.s.guardLeave(() => { proceeded = true; })).toBe(false);
    expect(h.s.view.leavePrompt?.quarantined).toBe(true);
    h.s.discardAndGo();
    expect(proceeded).toBe(false);
    expect(h.s.view.editor.pending?.requestId).toBe(pendingId);
    expect(h.s.view.editor.unresolved).toHaveLength(64);
    expect(h.s.dirty).toBe(true);
    expect(h.location.hash).toBe(lessonRouteHash(I, A));
    host.current = I;
    await h.s.refresh();
    await settle();
    expect(h.s.view.editor.draft?.text).toBe("private unsent wording");
  });

  test("a clean pending editor also vetoes App leave when unresolved is full", async () => {
    const host = hostWithA();
    const storage = new MemoryStorage();
    const target = { scope: WORLD_SCOPE, binding: { kind: "installation" as const, id: I }, key: A };
    const unresolved = Array.from({ length: 64 }, () => ({ requestId: `lc_${crypto.randomUUID()}`, scope: WORLD_SCOPE, binding: target.binding, key: { world: WORLD, kind: "capture", id: crypto.randomUUID() } }));
    const pendingId = `lc_${crypto.randomUUID()}`;
    storage.setItem(`sil-curation-editor:v2:${WORLD}`, JSON.stringify({ owner: "earlier", snapshot: { version: 4, expectedInstallation: I, address: target.binding, target, mode: "existing", pendingRequestId: pendingId, pendingIdentity: { requestId: pendingId, ...target }, unresolved, tombstones: [], tombstonesSaturated: false, resolutions: [] } }));
    const h = harness(host, storage, lessonRouteHash(I, A));
    await h.s.mount();
    await settle();
    let proceeded = false;
    expect(h.s.guardLeave(() => { proceeded = true; })).toBe(false);
    expect(h.s.view.leavePrompt).toBeNull();
    expect(proceeded).toBe(false);
    expect(h.s.view.editor.pending?.requestId).toBe(pendingId);
    expect(h.s.view.editor.unresolved).toHaveLength(64);
    expect(h.location.hash).toBe(lessonRouteHash(I, A));
  });

  test("an old detail refusal after closing A cannot revoke a loaded B project", async () => {
    const host = hostWithA();
    host.seed(I, { key: B, scope: B_SCOPE, text: "B current words" });
    const h = await openA(host);
    host.addStore(J);
    host.current = J;
    const release = host.hold((_method, path) => path === "/api/lessons/get", { respondFirst: true });
    const old = h.s.loadDetail();
    await settle();
    host.current = I;
    h.s.selectProject(PROJECT_B);
    await settle();
    expect(h.s.view.items.map((row) => row.effectiveText)).toEqual(["B current words"]);
    release();
    await old;
    expect(h.s.view.block).toBeNull();
    expect(h.s.view.items.map((row) => row.effectiveText)).toEqual(["B current words"]);
    expect(h.s.view.editor.target).toBeNull();
  });

  test("deselecting a project rejects an old browse refusal and success without another GET", async () => {
    for (const failure of [true, false]) {
      const host = hostWithA();
      const h = await openA(host);
      if (failure) {
        host.addStore(J);
        host.current = J;
      }
      const release = host.hold((_method, path) => path === "/api/lessons/browse", { respondFirst: true });
      const old = h.s.reloadList();
      await settle();
      host.current = I;
      h.s.selectProject("");
      await settle();
      release();
      await old;
      expect(h.s.view.project).toBeNull();
      expect(h.s.view.block).toBeNull();
      expect(h.s.view.items).toEqual([]);
      expect(h.s.view.listReadAt).toBeNull();
    }
  });

  test("a stale successful detail does not replace a newer project or its freshness", async () => {
    const host = hostWithA();
    host.seed(I, { key: B, scope: B_SCOPE, text: "B current words" });
    const h = await openA(host);
    const release = host.hold((_method, path) => path === "/api/lessons/get", { respondFirst: true });
    const old = h.s.loadDetail();
    await settle();
    h.s.selectProject(PROJECT_B);
    await settle();
    release();
    await old;
    expect(h.s.view.editor.target).toBeNull();
    expect(h.s.view.extras).toBeNull();
    expect(h.s.view.detailReadAt).toBeNull();
    expect(h.s.view.items.map((row) => row.effectiveText)).toEqual(["B current words"]);
  });

  test("wrong successful store metadata is rejected for projects, browse, detail and locate", async () => {
    for (const path of ["/api/lessons/projects", "/api/lessons/browse", "/api/lessons/get", "/api/lessons/locate"]) {
      const host = hostWithA();
      host.seed(I, { key: B, text: "B words" });
      let tamper = false;
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await host.fetch(input, init);
        if (!tamper || new URL(String(input)).pathname !== path || !response.ok) return response;
        const body = await response.json() as { store: { locationId: string; installationId: string | null }; value: unknown };
        return new Response(JSON.stringify({ ...body, store: { ...body.store, installationId: J } }), { status: 200 });
      }) as typeof fetch;
      const h = harness(host, new MemoryStorage(), "#/artifacts", undefined, fetcher);
      await h.s.mount();
      h.s.chooseProject(WORLD_SCOPE.project);
      await settle();
      h.s.openLesson({ key: A, scope: WORLD_SCOPE });
      await settle();
      tamper = true;
      if (path === "/api/lessons/projects") await h.s.handshake();
      if (path === "/api/lessons/browse") await h.s.reloadList();
      if (path === "/api/lessons/get") await h.s.loadDetail();
      if (path === "/api/lessons/locate") await h.s.openRoute({ kind: "record", installationId: I, key: B });
      expect({ path, reason: h.s.view.block?.reason }).toEqual({ path, reason: "mismatch" });
      expect(h.s.view.items).toEqual([]);
      expect(h.s.view.extras).toBeNull();
      expect(h.s.view.editor.loaded).toBeNull();
      expect(h.s.view.choices).toEqual([]);
    }
  });

  test("a wrong successful receipt store cannot settle a known-origin pending request", async () => {
    const host = hostWithA();
    const storage = new MemoryStorage();
    const target = { scope: WORLD_SCOPE, binding: { kind: "location" as const, id: LOCATION }, installationId: I, key: A };
    const pendingId = `lc_${crypto.randomUUID()}`;
    storage.setItem(`sil-curation-editor:v2:${WORLD}`, JSON.stringify({ owner: "earlier", snapshot: { version: 4, expectedInstallation: I, address: target.binding, target, mode: "existing", pendingRequestId: pendingId, pendingIdentity: { requestId: pendingId, ...target }, unresolved: [], tombstones: [], tombstonesSaturated: false, resolutions: [] } }));
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await host.fetch(input, init);
      if (new URL(String(input)).pathname !== "/api/lessons/receipt" || !response.ok) return response;
      const body = await response.json() as { store: { locationId: string; installationId: string | null }; value: unknown };
      return new Response(JSON.stringify({ ...body, store: { ...body.store, installationId: J } }), { status: 200 });
    }) as typeof fetch;
    const h = harness(host, storage, "#/artifacts", undefined, fetcher);
    await h.s.mount();
    await settle();
    await h.s.checkOutcome();
    expect(h.s.view.block?.reason).toBe("mismatch");
    expect(h.s.view.editor.pending?.requestId).toBe(pendingId);
    expect(h.s.view.editor.expectedInstallation).toBe(I);
    expect(host.calls.find((call) => call.path === "/api/lessons/receipt")?.query.binding).toBe(`installation:${I}`);
  });

  test("a wrong successful purge readback cannot verify or toast", async () => {
    const host = hostWithA();
    let tamper = false;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await host.fetch(input, init);
      if (!tamper || new URL(String(input), "http://host").pathname !== "/api/lessons/get" || !response.ok) return response;
      const body = await response.json() as { store: { locationId: string; installationId: string | null }; value: unknown };
      return new Response(JSON.stringify({ ...body, store: { ...body.store, installationId: J } }), { status: 200 });
    }) as typeof fetch;
    const h = harness(host, new MemoryStorage(), "#/artifacts", undefined, fetcher);
    await h.s.mount();
    h.s.chooseProject(WORLD_SCOPE.project);
    await settle();
    h.s.openLesson({ key: A, scope: WORLD_SCOPE });
    await settle();
    tamper = true;
    await h.s.submit({ kind: "purge", confirmed: true });
    expect(host.stores.get(I)!.records.get(`capture:${A.id}`)?.purged).toBe(true);
    expect(h.s.view.block?.reason).toBe("mismatch");
    expect(h.s.view.purgeCheck).toBe("unavailable");
    expect(h.toasts.filter((toast) => toast.kind === "ok")).toEqual([]);
    expect(h.s.view.editor.tombstones.map((item) => item.key)).toContainEqual(A);
  });

  test("a wrong successful history store cannot append a valid-looking page", async () => {
    const host = hostWithA();
    const rec = host.stores.get(I)!.records.get(`capture:${A.id}`)!;
    for (let revision = 2; revision <= 25; revision++) rec.history.push({ revision, kind: "edit", at: "2026-10-22T10:00:00.000Z", text: `I r${revision}`, important: null, oldSourceDigest: null, newSourceDigest: null });
    rec.revision = 25;
    let falsifyHistory = false;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await host.fetch(input, init);
      if (falsifyHistory && new URL(String(input)).pathname === "/api/lessons/history" && response.ok) {
        const body = await response.json() as { store: { locationId: string; installationId: string | null }; value: unknown };
        return new Response(JSON.stringify({ ...body, store: { ...body.store, installationId: J } }), { status: 200 });
      }
      return response;
    }) as typeof fetch;
    const h = harness(host, new MemoryStorage(), "#/artifacts", undefined, fetcher);
    await h.s.mount();
    h.s.chooseProject(WORLD_SCOPE.project);
    await settle();
    h.s.openLesson({ key: A, scope: WORLD_SCOPE });
    await settle();
    expect(h.s.view.extras?.history?.length).toBe(20);
    falsifyHistory = true;
    await h.s.loadMoreHistory();
    expect(h.s.view.extras?.history?.length ?? 0).toBeLessThanOrEqual(20);
    expect(h.s.view.editor.gate).not.toBe("ready");
    expect(h.s.view.block?.reason).toBe("mismatch");
  });

  test("App leave and internal project navigation both veto saturated parking", async () => {
    const host = hostWithA();
    const storage = new MemoryStorage();
    const target = { scope: WORLD_SCOPE, binding: { kind: "installation" as const, id: I }, key: A };
    const unresolved = Array.from({ length: 64 }, () => ({ requestId: `lc_${crypto.randomUUID()}`, scope: WORLD_SCOPE, binding: target.binding, key: { world: WORLD, kind: "capture", id: crypto.randomUUID() } }));
    const pendingId = `lc_${crypto.randomUUID()}`;
    storage.setItem(`sil-curation-editor:v2:${WORLD}`, JSON.stringify({ owner: "earlier", snapshot: { version: 4, expectedInstallation: I, address: target.binding, target, mode: "existing", pendingRequestId: pendingId, pendingIdentity: { requestId: pendingId, ...target }, unresolved, tombstones: [], tombstonesSaturated: false, resolutions: [] } }));
    const h = harness(host, storage, lessonRouteHash(I, A));
    await h.s.mount();
    await settle();
    h.s.editText("A unsent wording");
    let proceeded = false;
    expect(h.s.guardLeave(() => { proceeded = true; })).toBe(false);
    h.s.discardAndGo();
    expect(proceeded).toBe(false);
    expect(h.s.view.editor.target?.key).toEqual(A);
    expect(h.s.view.editor.pending?.requestId).toBe(pendingId);
    expect(h.s.view.editor.unresolved).toHaveLength(64);
    expect(h.location.hash).toBe(lessonRouteHash(I, A));
    h.s.selectProject(PROJECT_B);
    if (h.s.view.leavePrompt !== null) h.s.discardAndGo();
    expect(h.s.view.project).toEqual(WORLD_SCOPE.project);
    expect(h.s.view.editor.pending?.requestId).toBe(pendingId);
  });

  test("a proven location-origin pending receipt reads I, never the new store at L", async () => {
    const host = hostWithA();
    const storage = new MemoryStorage();
    const target = { scope: WORLD_SCOPE, binding: { kind: "location" as const, id: LOCATION }, installationId: I, key: A };
    const pendingId = `lc_${crypto.randomUUID()}`;
    storage.setItem(`sil-curation-editor:v2:${WORLD}`, JSON.stringify({ owner: "earlier", snapshot: { version: 4, expectedInstallation: I, address: target.binding, target, mode: "existing", pendingRequestId: pendingId, pendingIdentity: { requestId: pendingId, ...target }, unresolved: [], tombstones: [], tombstonesSaturated: false, resolutions: [] } }));
    const h = harness(host, storage);
    await h.s.mount();
    await settle();
    host.addStore(J);
    host.current = J;
    await h.s.checkOutcome();
    const receiptRead = host.calls.find((call) => call.path === "/api/lessons/receipt");
    expect(receiptRead?.query.binding).toBe(`installation:${I}`);
    expect(h.s.view.editor.pending?.requestId).toBe(pendingId);
    expect(h.s.view.editor.expectedInstallation).toBe(I);
    expect(h.s.view.block?.reason).toBe("mismatch");
    expect(host.stores.get(J)!.receipts.size).toBe(0);
  });

  test("an exact positive bootstrap receipt proves its own origin without rewriting the submitted binding", async () => {
    const host = new FakeHost();
    let losePost = true;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await host.fetch(input, init);
      if (init?.method === "POST" && losePost) {
        losePost = false;
        throw new TypeError("synthetic lost response");
      }
      return response;
    }) as typeof fetch;
    const h = harness(host, new MemoryStorage(), "#/artifacts", undefined, fetcher);
    await h.s.mount();
    h.s.chooseProject(WORLD_SCOPE.project);
    await settle();
    h.s.startCapture();
    h.s.editText("bootstrap words");
    h.s.editSource({ quote: "q" });
    await h.s.submit({ kind: "save" });
    const pending = h.s.view.editor.pending!;
    expect(pending.binding.kind).toBe("location");
    expect(h.s.view.editor.expectedInstallation).toBeNull();
    await h.s.refresh();
    expect(h.s.view.block?.reason).toBe("unknown-origin");
    await h.s.checkOutcome();
    await settle();
    expect(h.s.view.editor.pending).toBeNull();
    expect(h.s.view.editor.expectedInstallation).toBe(host.current);
    expect(h.s.view.editor.target?.binding.kind).toBe("location");
    expect(h.s.view.editor.loaded?.effectiveText).toBe("bootstrap words");
    const receiptRead = host.calls.find((call) => call.path === "/api/lessons/receipt");
    expect(receiptRead?.query.binding).toBe(`location:${LOCATION}`);
    expect(receiptRead?.query.requestId).toBe(pending.requestId);
  });

  test("an unknown-origin receipt at the original location never assigns its current store", async () => {
    const host = new FakeHost();
    const h = harness(host, new MemoryStorage());
    await h.s.mount();
    h.s.chooseProject(WORLD_SCOPE.project);
    await settle();
    h.s.startCapture();
    h.s.editText("bootstrap words");
    h.s.editSource({ quote: "q" });
    host.current = host.addStore(J).installationId;
    await h.s.submit({ kind: "save" });
    await h.s.refresh();
    const id = h.s.view.editor.pending?.requestId;
    expect(id).toBeDefined();
    await h.s.checkOutcome();
    expect(h.s.view.editor.pending?.requestId).toBe(id);
    expect(h.s.view.editor.expectedInstallation).toBeNull();
    expect(h.s.view.block?.reason).toBe("unknown-origin");
  });
});

describe("fix round 2: one read boundary", () => {
  test("handshake race: status says I, the I-bound projects read is refused after the swap", async () => {
    const host = hostWithA();
    const h = await openA(host);
    h.s.editText(`A words ${DRAFT}`);
    const release = host.hold((_m, path) => path === "/api/lessons/projects");
    const refreshing = h.s.refresh();
    await settle();
    host.addStore(J);
    host.current = J;
    release();
    await refreshing;
    await settle();
    expect(h.s.view.editor.draft).toBeNull();
    expect(h.s.view.editor.gate).not.toBe("ready");
    expect(h.s.view.block).not.toBeNull();
    const posts = host.writes();
    await h.s.submit({ kind: "save" });
    expect(host.writes()).toBe(posts);
  });

  test("loading older history after the swap revokes the old record", async () => {
    const host = hostWithA();
    const rec = host.stores.get(I)!.records.get(`capture:${A.id}`)!;
    for (let r = 2; r <= 25; r++) rec.history.push({ revision: r, kind: "important", at: "2026-10-22T10:00:00.000Z", text: null, important: r % 2 === 0, oldSourceDigest: null, newSourceDigest: null });
    rec.revision = 25;
    const h = await openA(host);
    await settle();
    expect(h.s.view.extras?.historyCursor).not.toBeNull();
    host.addStore(J);
    host.current = J;
    await h.s.loadMoreHistory();
    await settle();
    expect(h.s.view.editor.draft).toBeNull();
    expect(h.s.view.editor.gate).not.toBe("ready");
    expect(h.s.view.block).not.toBeNull();
    expect(h.s.view.extras).toBeNull();
  });

  test("a receipt read refused after the swap revokes and keeps the original request id", async () => {
    const { host, h, requestId } = await unknownCommittedSave();
    host.addStore(J);
    host.current = J;
    await h.s.checkOutcome();
    await settle();
    expect(h.s.view.editor.draft).toBeNull();
    expect(h.s.view.block).not.toBeNull();
    expect(heldIds(h)).toContain(requestId);
    expect(host.stores.get(J)!.receipts.size).toBe(0);
  });

  test("a busy receipt read keeps the outcome unknown and never says nothing was saved", async () => {
    const { host, h, requestId } = await unknownCommittedSave();
    host.failPath = "/api/lessons/receipt";
    await h.s.checkOutcome();
    await settle();
    expect(h.toasts.map((t) => t.message).join(" | ")).not.toContain("Nothing was saved");
    expect(h.s.view.editor.phase).toBe("unknown");
    expect(h.s.view.editor.pending?.requestId).toBe(requestId);
  });

  test("a late refusal from a superseded read does not touch the newer context", async () => {
    const host = hostWithA();
    host.seed(I, { key: B, text: "B words" });
    const h = await openA(host);
    const release = host.hold((_m, path) => path === "/api/lessons/get");
    const old = h.s.loadDetail();
    await settle();
    h.s.openLesson({ key: B, scope: WORLD_SCOPE });
    await settle();
    expect(h.s.view.editor.draft?.text).toBe("B words");
    host.addStore(J);
    host.current = J;
    release();
    await old;
    await settle();
    host.current = I;
    expect(h.s.view.block).toBeNull();
    expect(h.s.view.editor.gate).toBe("ready");
    expect(h.s.view.editor.draft?.text).toBe("B words");
  });

  test("valid reads through the boundary stay accepted (positive control)", async () => {
    const host = hostWithA();
    const h = await openA(host);
    h.clock.now = 7_000;
    await h.s.refresh();
    await settle();
    expect(h.s.view.block).toBeNull();
    expect(h.s.view.editor.gate).toBe("ready");
    expect(h.s.view.listReadAt).toBe(7_000);
    expect(h.s.view.detailReadAt).toBe(7_000);
  });
});

describe("fix round 2: full route identity", () => {
  test("the same key at another installation is refused; the identical route is a no-op", async () => {
    const host = hostWithA();
    const h = await openA(host);
    const locates = () => host.calls.filter((c) => c.path === "/api/lessons/locate").length;
    const before = locates();
    let old = h.location.hash;
    h.location.hash = lessonRouteHash(I, A);
    h.s.onRouteChange(old);
    await settle();
    expect(h.s.view.editor.target?.key).toEqual(A);
    expect(locates()).toBe(before);
    old = h.location.hash;
    h.location.hash = lessonRouteHash(J, A);
    h.s.onRouteChange(old);
    await settle();
    expect(h.s.view.editor.target).toBeNull();
    expect(h.s.view.routeError).not.toBeNull();
    expect(locates()).toBe(before);
  });

  test("a location-bound record compares its proven installation", async () => {
    const host = new FakeHost();
    const h = harness(host, new MemoryStorage());
    await h.s.mount();
    h.s.chooseProject(WORLD_SCOPE.project);
    await settle();
    h.s.startCapture();
    h.s.editText("bootstrapped words");
    h.s.editSource({ quote: "q" });
    await h.s.submit({ kind: "save" });
    await settle();
    const target = h.s.view.editor.target!;
    expect(target.binding.kind).toBe("location");
    const k = host.current!;
    let old = h.location.hash;
    h.location.hash = lessonRouteHash(k, target.key);
    h.s.onRouteChange(old);
    await settle();
    expect(h.s.view.editor.target?.key).toEqual(target.key);
    old = h.location.hash;
    h.location.hash = lessonRouteHash(J, target.key);
    h.s.onRouteChange(old);
    await settle();
    expect(h.s.view.editor.target).toBeNull();
  });
});

describe("fix round 2: Browse current instead", () => {
  async function blockedOnJ(choices: Array<"world" | "b"> = ["b"]) {
    const { host, h, requestId, storage } = await unknownCommittedSave();
    host.addStore(J);
    host.choicesFor.set(J, choices);
    host.current = J;
    host.seed(J, { key: B, text: "J ONLY ROW" });
    await h.s.refresh();
    await settle();
    expect(h.s.view.block).not.toBeNull();
    return { host, h, requestId, storage };
  }

  test("parks I ids, resets the URL and the project, and never queries J with I's project", async () => {
    const { host, h, requestId, storage } = await blockedOnJ();
    h.s.browseCurrentInstead();
    if (h.s.view.leavePrompt !== null) h.s.discardAndGo();
    await settle();
    expect(h.s.view.block).toBeNull();
    expect(h.location.hash).toBe("#/artifacts");
    expect(h.s.view.project).toBeNull();
    expect(heldIds(h)).toContain(requestId);
    const jBrowses = host.calls.filter((c) => c.path === "/api/lessons/browse" && c.query["binding"] === `installation:${J}`);
    expect(jBrowses.filter((c) => c.query["project"] === "world")).toEqual([]);
    expect(storedSnapshot(storage)).toContain(requestId);
    expect(storedSnapshot(storage)).not.toContain("SENTINEL");
  });

  test("stays blocked when the fresh handshake fails or reveals another store", async () => {
    for (const variant of ["fail", "change"] as const) {
      const { host, h } = await blockedOnJ();
      let release: (() => void) | null = null;
      if (variant === "fail") host.failPath = "/api/lessons/projects";
      else release = host.hold((_m, path) => path === "/api/lessons/store");
      h.s.browseCurrentInstead();
      if (h.s.view.leavePrompt !== null) h.s.discardAndGo();
      await settle();
      if (release !== null) {
        const k = host.addStore("33333333-3333-4333-8333-333333333333").installationId;
        host.current = k;
        release();
      }
      await settle();
      expect({ variant, blocked: h.s.view.block !== null }).toEqual({ variant, blocked: true });
      expect(h.s.binding).toBeNull();
    }
  });

  test("refuses when the old record cannot be parked (unresolved capacity)", async () => {
    const host = hostWithA();
    const storage = new MemoryStorage();
    const target = { scope: WORLD_SCOPE, binding: { kind: "installation", id: I }, key: A };
    const unresolved = Array.from({ length: 64 }, () => ({ requestId: `lc_${crypto.randomUUID()}`, scope: WORLD_SCOPE, binding: { kind: "installation", id: I }, key: { world: WORLD, kind: "capture", id: crypto.randomUUID() } }));
    const pendingId = `lc_${crypto.randomUUID()}`;
    const snapshot = { version: 4, expectedInstallation: I, address: { kind: "installation", id: I }, target, mode: "existing", pendingRequestId: pendingId, pendingIdentity: { requestId: pendingId, ...target }, unresolved, tombstones: [], tombstonesSaturated: false, resolutions: [] };
    storage.setItem(`sil-curation-editor:v2:${WORLD}`, JSON.stringify({ owner: "earlier", snapshot }));
    host.addStore(J);
    host.current = J;
    const h = harness(host, storage);
    await h.s.mount();
    await settle();
    expect(h.s.view.block).not.toBeNull();
    h.s.browseCurrentInstead();
    if (h.s.view.leavePrompt !== null) h.s.discardAndGo();
    await settle();
    expect(h.s.view.block).not.toBeNull();
    expect(heldIds(h)).toContain(pendingId);
    expect(h.s.view.editor.unresolved.length).toBe(64);
  });

  test("a project change that cannot park the open record keeps the old scope and URL", async () => {
    const host = hostWithA();
    const storage = new MemoryStorage();
    const target = { scope: WORLD_SCOPE, binding: { kind: "installation", id: I }, key: A };
    const unresolved = Array.from({ length: 64 }, () => ({ requestId: `lc_${crypto.randomUUID()}`, scope: WORLD_SCOPE, binding: { kind: "installation", id: I }, key: { world: WORLD, kind: "capture", id: crypto.randomUUID() } }));
    const pendingId = `lc_${crypto.randomUUID()}`;
    const snapshot = { version: 4, expectedInstallation: I, address: { kind: "installation", id: I }, target, mode: "existing", pendingRequestId: pendingId, pendingIdentity: { requestId: pendingId, ...target }, unresolved, tombstones: [], tombstonesSaturated: false, resolutions: [] };
    storage.setItem(`sil-curation-editor:v2:${WORLD}`, JSON.stringify({ owner: "earlier", snapshot }));
    const h = harness(host, storage, lessonRouteHash(I, A));
    await h.s.mount();
    await settle();
    expect(h.s.view.project).toEqual(WORLD_SCOPE.project);
    h.s.selectProject(PROJECT_B);
    await settle();
    expect(h.s.view.project).toEqual(WORLD_SCOPE.project);
    expect(h.s.view.editor.target?.key).toEqual(A);
    expect(h.s.view.routeError).toContain("could not be set aside");
    expect(h.location.hash).toBe(lessonRouteHash(I, A));
    expect(heldIds(h)).toContain(pendingId);
  });

  test("while blocked no successful-empty list or fresh timestamp is shown", async () => {
    const host = hostWithA();
    const h = await openA(host);
    expect(h.s.view.listReadAt).not.toBeNull();
    host.addStore(J);
    host.current = J;
    await h.s.refresh();
    await settle();
    expect(h.s.view.block).not.toBeNull();
    expect(h.s.view.items).toEqual([]);
    expect(h.s.view.listReadAt).toBeNull();
    expect(h.s.view.listStale).toBe(false);
  });
});

describe("fix round 2: refresh keeps paged history", () => {
  test("a refresh of the same revision keeps the older pages already loaded", async () => {
    const host = hostWithA();
    const rec = host.stores.get(I)!.records.get(`capture:${A.id}`)!;
    for (let r = 2; r <= 25; r++) rec.history.push({ revision: r, kind: "important", at: "2026-10-22T10:00:00.000Z", text: null, important: r % 2 === 0, oldSourceDigest: null, newSourceDigest: null });
    rec.revision = 25;
    const h = await openA(host);
    await settle();
    await h.s.loadMoreHistory();
    await settle();
    expect(h.s.view.extras?.history?.length).toBe(25);
    await h.s.refresh();
    await settle();
    expect(h.s.view.extras?.history?.length).toBe(25);
    expect(h.s.view.extras?.historyCursor).toBeNull();
  });
});

describe("fix round 2: accepted detail only", () => {
  test("a late older detail response does not replace the accepted newer read", async () => {
    const host = hostWithA();
    const h = await openA(host);
    h.clock.now = 2_000;
    const release = host.hold((_m, path) => path === "/api/lessons/get", { respondFirst: true });
    const old = h.s.loadDetail();
    await settle();
    const rec = host.stores.get(I)!.records.get(`capture:${A.id}`)!;
    rec.revision = 2;
    rec.text = "A words r2";
    rec.history.push({ revision: 2, kind: "edit", at: "2026-10-22T10:00:00.000Z", text: "A words r2", important: null, oldSourceDigest: null, newSourceDigest: null });
    h.clock.now = 3_000;
    await h.s.loadDetail();
    await settle();
    expect(h.s.view.editor.loaded?.revision).toBe(2);
    expect(h.s.view.detailReadAt).toBe(3_000);
    h.clock.now = 4_000;
    release();
    await old;
    await settle();
    expect(h.s.view.editor.loaded?.revision).toBe(2);
    expect(h.s.view.detailReadAt).toBe(3_000);
  });

  test("a wrong-key detail response is not presented; a valid same-revision read is", async () => {
    const host = hostWithA();
    host.seed(I, { key: B, text: "B words" });
    const h = await openA(host);
    const accepted = h.s.view.detailReadAt;
    h.clock.now = 5_000;
    host.wrongKeyOnce = B;
    await h.s.loadDetail();
    await settle();
    expect(h.s.view.detailReadAt).toBe(accepted);
    expect(h.s.view.extras?.key).toEqual(A);
    h.clock.now = 6_000;
    await h.s.loadDetail();
    await settle();
    expect(h.s.view.detailReadAt).toBe(6_000);
  });
});

void LOCATION;
