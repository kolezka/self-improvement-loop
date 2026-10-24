// CuratedSession against the real HTTP server and real curation store of an
// owned fixture. The store at the data location is swapped from I to J by
// renaming its directory (fixture only), then restored. J's own rows and
// receipts are read back through the server to prove nothing was written.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { decodeCurationMutationResponse } from "@sil/core/control-mutation";
import { encodeLessonKey, type CurationMutation } from "@sil/core/lesson-curation";
import { encodeCurationMutationRequest } from "@sil/core/lesson-curation-wire";
import { CuratedSession } from "../src/lib/curated-session.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { Lesson, paths } from "@sil/core";
import { createCurationFixture, useFixtureEnv, type CurationFixture } from "../../../tests/curation-fixture.ts";
import { LOCAL_HEADER, TOKEN_HEADER } from "../../server/src/guard.ts";

const TOKEN = "curated-session-token";
const SERVER_CHILD = join(import.meta.dir, "..", "..", "..", "tests", "http-server-child.ts");
const DRAFT = "SENTINEL unsent wording";

let fx: CurationFixture;
let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
let origin: string;
let posts: string[];

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

beforeEach(async () => {
  fx = createCurationFixture();
  child = Bun.spawn([process.execPath, SERVER_CHILD, fx.root, TOKEN], { env: fx.env, cwd: fx.root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let line = "";
  while (!line.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`server child exited: ${await new Response(child.stderr).text()}`);
    line += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const info = JSON.parse(line.slice(0, line.indexOf("\n"))) as { port: number; resolvedClaude: string; fake: string; controlExit: number };
  expect(info.resolvedClaude).toBe(info.fake);
  expect(info.controlExit).toBe(0);
  origin = `http://127.0.0.1:${info.port}`;
  posts = [];
});

afterEach(async () => {
  child.stdin.end();
  const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
  if (!exited) child.kill();
  await child.exited;
  fx.cleanup();
});

const headers = () => ({ [LOCAL_HEADER]: "1", [TOKEN_HEADER]: TOKEN });
const fetchServer = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.method === "POST") posts.push(String(input));
  return fetch(new URL(String(input), origin), init);
}) as typeof fetch;

function session(storage: MemoryStorage, clock: { now: number } | null = null): CuratedSession {
  const location = { hash: "#/artifacts" };
  return new CuratedSession({
    world: fx.world,
    fetch: fetchServer,
    headers,
    origin,
    storage: () => storage as unknown as Storage,
    hash: () => location.hash,
    replaceHash: (hash) => (location.hash = hash),
    toast: () => {},
    requestLeave: (proceed) => proceed(),
    setWorld: () => {},
    openReview: () => {},
    uuid: () => crypto.randomUUID(),
    timeoutMs: 10_000,
    now: () => (clock === null ? Date.now() : clock.now),
  });
}

async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

const curationDir = () => join(fx.env["SIL_DATA_DIR"]!, "curation");

async function storeId(): Promise<string | null> {
  const r = (await (await fetch(`${origin}/api/lessons/store`, { headers: headers() })).json()) as { state: string; binding: { id: string } };
  return r.state === "ready" ? r.binding.id : null;
}

/** Bootstrap a second installation J at the same location with one synthetic row. */
async function bootstrapJ(): Promise<string> {
  const store = (await (await fetch(`${origin}/api/lessons/store`, { headers: headers() })).json()) as { binding: { id: string } };
  const m: CurationMutation = {
    requestId: `lc_${crypto.randomUUID()}`,
    binding: { kind: "location", id: store.binding.id },
    scope: { world: fx.world, project: { kind: "world" } },
    key: { world: fx.world, kind: "capture", id: crypto.randomUUID() },
    expectedRevision: 0,
    change: { kind: "capture", text: "J ONLY ROW", source: { kind: "explicit_quote", quote: "j", reference: null, quoteRedacted: false, captureSessionId: null, sourceConversationId: null, sourceRowId: null, sourceAgentId: null } },
  };
  const body = encodeCurationMutationRequest({ mutation: m, precondition: { kind: "uninitialized", locationId: store.binding.id } }, null);
  const res = await fetch(`${origin}/api/lessons/capture`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body });
  const decoded = decodeCurationMutationResponse(await res.text(), m.requestId);
  if (!("receipt" in decoded)) throw new Error("J bootstrap failed");
  return decoded.store.installationId;
}

async function jRows(j: string): Promise<Array<{ text: string | null; revision: number }>> {
  const url = `${origin}/api/lessons/browse?world=${fx.world}&project=world&binding=installation:${j}&collection=all`;
  const page = (await (await fetch(url, { headers: headers() })).json()) as { value: { items: Array<{ effectiveText: string | null; revision: number }> } };
  return page.value.items.map((i) => ({ text: i.effectiveText, revision: i.revision }));
}

describe("real server: installation swap under a mounted pane", () => {
  test("hide on swap, no write to J, recovery on restore, and no J browsing on remount", async () => {
    const storage = new MemoryStorage();
    const s1 = session(storage);
    await s1.mount();
    s1.chooseProject({ kind: "world" });
    await settle();
    s1.startCapture();
    s1.editText("I wording");
    s1.editSource({ quote: "q" });
    await s1.submit({ kind: "save" });
    await settle();
    const i = await storeId();
    expect(i).not.toBeNull();
    expect(s1.view.editor.expectedInstallation).toBe(i!);
    expect(s1.view.confirmed).toBe("Saved locally. Not installed or queued for learning.");
    s1.editText(`I wording ${DRAFT}`);

    // Swap: I moves aside, J is created at the same location.
    renameSync(curationDir(), `${curationDir()}-I`);
    const j = await bootstrapJ();
    expect(j).not.toBe(i);
    const postsBefore = posts.length;
    await s1.refresh();
    await settle();
    expect(s1.view.block).toEqual({ reason: "mismatch", expected: i, current: j });
    expect(s1.view.editor.draft).toBeNull();
    expect(s1.view.items).toEqual([]);
    expect(s1.view.choices).toEqual([]);
    await s1.submit({ kind: "save" });
    await settle();
    expect(posts.length).toBe(postsBefore);
    expect(await jRows(j)).toEqual([{ text: "J ONLY ROW", revision: 1 }]);

    // Restore I: a fresh observation, then detail, recovers the unsaved wording.
    renameSync(curationDir(), `${curationDir()}-J`);
    renameSync(`${curationDir()}-I`, curationDir());
    await s1.refresh();
    await settle();
    expect(s1.view.block).toBeNull();
    expect(s1.view.editor.gate).toBe("ready");
    expect(s1.view.editor.draft?.text).toBe(`I wording ${DRAFT}`);

    // Remount against J: the restored I identity is not browsed as J.
    s1.dispose();
    renameSync(curationDir(), `${curationDir()}-I`);
    renameSync(`${curationDir()}-J`, curationDir());
    const s2 = session(storage);
    await s2.mount();
    s2.chooseProject({ kind: "world" });
    await settle();
    expect(s2.view.block?.expected).toBe(i!);
    expect(s2.view.block?.current).toBe(j);
    expect(s2.view.items).toEqual([]);
    expect(s2.view.choices).toEqual([]);
    expect(s2.view.editor.draft).toBeNull();
    expect(await jRows(j)).toEqual([{ text: "J ONLY ROW", revision: 1 }]);
    s2.dispose();
    expect(existsSync(`${curationDir()}-I`)).toBe(true);
  }, 30_000);
});

describe("real server: read boundary and accepted detail", () => {
  test("a history page refused after the swap revokes; restored I is untouched", async () => {
    const storage = new MemoryStorage();
    const s = session(storage);
    await s.mount();
    s.chooseProject({ kind: "world" });
    await settle();
    s.startCapture();
    s.editText("history wording");
    s.editSource({ quote: "q" });
    await s.submit({ kind: "save" });
    await settle();
    for (let r = 0; r < 22; r++) {
      await s.submit({ kind: "important", value: r % 2 === 0 });
      await settle(10);
    }
    await s.loadDetail();
    await settle();
    expect(s.view.extras?.historyTotal).toBe(23);
    expect(s.view.extras?.historyCursor).not.toBeNull();
    const i = await storeId();
    renameSync(curationDir(), `${curationDir()}-I`);
    const j = await bootstrapJ();
    const postsBefore = posts.length;
    await s.loadMoreHistory();
    await settle();
    expect(s.view.block).toEqual({ reason: "mismatch", expected: i, current: null });
    expect(s.view.editor.draft).toBeNull();
    expect(s.view.extras).toBeNull();
    await s.submit({ kind: "important", value: true });
    expect(posts.length).toBe(postsBefore);
    expect(await jRows(j)).toEqual([{ text: "J ONLY ROW", revision: 1 }]);
    s.dispose();
  }, 60_000);

  test("a changed legacy source at the same revision is presented as a fresh accepted read", async () => {
    const restore = useFixtureEnv(fx);
    const dir = paths.inboxDir(fx.world);
    restore();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "legacy-fresh.json");
    const write = (text: string) =>
      writeFileSync(file, JSON.stringify(Lesson.parse({ id: "legacy-fresh", world: fx.world, pattern: "legacy-pattern", text, created: "2026-10-20T09:00:00.000Z", repo: null, reflection_id: "refl-legacy-1" })));
    write("Legacy source wording one.");
    const clock = { now: 1_000 };
    const s = session(new MemoryStorage(), clock);
    await s.mount();
    s.chooseProject({ kind: "world" });
    await settle();
    s.openLesson({ key: { world: fx.world, kind: "inbox", id: "legacy-fresh" }, scope: { world: fx.world, project: { kind: "world" } } });
    await settle();
    clock.now = 2_000;
    await s.submit({ kind: "important", value: true });
    await settle();
    const before = s.view.extras?.provenance;
    expect(before?.kind === "existing_lesson" && before.state === "available" ? before.reflectionId : null).toBe("refl-legacy-1");
    const revision = s.view.editor.loaded?.revision;
    write("Legacy source wording two.");
    clock.now = 3_000;
    await s.loadDetail();
    await settle();
    expect(s.view.editor.loaded?.revision).toBe(revision!);
    expect(s.view.editor.loaded?.sourceStatus).toBe("changed");
    expect(s.view.detailReadAt).toBe(3_000);
    const after = s.view.extras?.provenance;
    const digest = (p: typeof after) => (p?.kind === "existing_lesson" && p.state === "available" ? p.digest : null);
    expect(digest(after)).not.toBe(digest(before));
    expect(s.view.extras?.diagnostics.map((d) => d.code)).toContain("source_changed");
    s.dispose();
  }, 30_000);
});

test("real server: a location-origin I record never appends J history at the same location", async () => {
  const storage = new MemoryStorage();
  const bindings: string[] = [];
  const submitted: Array<{ requestId: string; binding: CurationMutation["binding"] }> = [];
  const location = { hash: "#/artifacts" };
  const tracked = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), origin);
    if (url.pathname === "/api/lessons/history") bindings.push(url.searchParams.get("binding") ?? "");
    if (init?.method === "POST" && typeof init.body === "string") {
      const body = JSON.parse(init.body) as { requestId: string; mutation: { args: { mutation: CurationMutation } } };
      submitted.push({ requestId: body.requestId, binding: body.mutation.args.mutation.binding });
    }
    return fetchServer(input, init);
  }) as typeof fetch;
  const s = new CuratedSession({ world: fx.world, fetch: tracked, headers, origin, storage: () => storage as unknown as Storage,
    hash: () => location.hash, replaceHash: (next) => { location.hash = next; }, toast: () => {}, requestLeave: (proceed) => proceed(),
    setWorld: () => {}, openReview: () => {}, uuid: () => crypto.randomUUID(), timeoutMs: 10_000, now: () => Date.now() });
  async function write(binding: CurationMutation["binding"], key: CurationMutation["key"], revision: number, text: string): Promise<string> {
    const mutation: CurationMutation = { requestId: `lc_${crypto.randomUUID()}`, binding, scope: { world: fx.world, project: { kind: "world" } }, key,
      expectedRevision: revision, change: revision === 0
        ? { kind: "capture", text, source: { kind: "explicit_quote", quote: "fixture", reference: null, quoteRedacted: false, captureSessionId: null, sourceConversationId: null, sourceRowId: null, sourceAgentId: null } }
        : { kind: "edit", text } };
    const precondition = binding.kind === "location" ? { kind: "uninitialized" as const, locationId: binding.id } : { kind: "installation" as const, id: binding.id };
    const response = await fetch(`${origin}/api/lessons/${revision === 0 ? "capture" : "edit"}`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: encodeCurationMutationRequest({ mutation, precondition }, null) });
    expect(response.status).toBe(200);
    const decoded = decodeCurationMutationResponse(await response.text(), mutation.requestId);
    if (!("receipt" in decoded)) throw new Error("fixture mutation refused");
    return decoded.store.installationId;
  }
  try {
    await s.mount();
    s.chooseProject({ kind: "world" });
    await settle(5);
    s.startCapture();
    s.editText("I words");
    s.editSource({ quote: "I quote" });
    await s.submit({ kind: "save" });
    await settle(5);
    const target = s.view.editor.target!;
    const i = s.view.editor.expectedInstallation!;
    expect(target.binding.kind).toBe("location");
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.binding).toEqual(target.binding);
    expect(submitted[0]?.requestId.startsWith("lc_")).toBe(true);
    expect(i).toBeTruthy();
    for (let revision = 1; revision < 25; revision++) await write({ kind: "installation", id: i }, target.key, revision, `I history ${revision + 1}`);
    await s.refresh();
    for (let n = 0; n < 100 && s.view.extras?.history?.length !== 20; n++) await Bun.sleep(5);
    expect(s.view.extras?.history?.length).toBe(20);
    expect(s.view.extras?.historyCursor).not.toBeNull();
    renameSync(curationDir(), `${curationDir()}-I`);
    const status = (await (await fetch(`${origin}/api/lessons/store`, { headers: headers() })).json()) as { binding: { kind: "location"; id: string } };
    const j = await write(status.binding, target.key, 0, "J history 1");
    for (let revision = 1; revision < 25; revision++) await write({ kind: "installation", id: j }, target.key, revision, `J history ${revision + 1}`);
    const postsBefore = posts.length;
    await s.loadMoreHistory();
    const acceptedJHistory = s.view.extras?.history?.some((entry) => entry.text?.startsWith("J history")) ?? false;
    expect(bindings.at(-1)).toBe(`installation:${i}`);
    expect(acceptedJHistory).toBe(false);
    expect(s.view.block?.reason).toBe("mismatch");
    expect(posts.length).toBe(postsBefore);
    expect(s.view.editor.pending).toBeNull();
    console.log("location-origin read", JSON.stringify({ submittedBinding: submitted[0]?.binding, expectedInstallation: i, replacementInstallation: j,
      historyBinding: bindings.at(-1), acceptedJHistory, blockReason: s.view.block?.reason, additionalSessionPosts: posts.length - postsBefore }));
  } finally {
    s.dispose();
  }
}, 60_000);

void encodeLessonKey;
