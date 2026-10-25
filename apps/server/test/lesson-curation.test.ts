// Curated lessons over HTTP and `sil ops`: the same envelope bytes, the same
// dispatcher, the same receipts. The real HTTP server and the real CLI each
// run as a child whose startup environment is the inert curation fixture, so
// the no-model marker watches the processes that actually serve requests.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { Lesson, paths } from "@sil/core";
import { decodeControlResponse } from "@sil/core/control-protocol";
import { decodeCurationMutationResponse, type CurationMutationResponse } from "@sil/core/control-mutation";
import { encodeLessonKey, type CurationMutation, type CurationPrecondition, type LessonKey } from "@sil/core/lesson-curation";
import { encodeCurationMutationRequest } from "@sil/core/lesson-curation-wire";
import { appendRecord, closeState } from "@sil/statedb";
import { openCurationStoreForRead } from "@sil/store";
import { createCurationFixture, useFixtureEnv, type CurationFixture } from "../../../tests/curation-fixture.ts";
import { FIXTURE_CLAUDE_MARKER } from "../../../tests/control-fixture.ts";
import { LOCAL_HEADER, TOKEN_HEADER } from "../src/guard.ts";

const TOKEN = "lesson-curation-token";
const CLI = join(import.meta.dir, "..", "..", "cli", "src", "main.ts");
const SERVER_CHILD = join(import.meta.dir, "..", "..", "..", "tests", "http-server-child.ts");

type ServerInfo = { port: number; pid: number; resolvedClaude: string; fake: string; controlExit: number | null };

let fx: CurationFixture;
// Only for direct store inspection from this test process; the server never reads it.
let restoreEnv: () => void;
let serverChild: Bun.Subprocess<"pipe", "pipe", "pipe">;
let serverInfo: ServerInfo;

beforeEach(async () => {
  fx = createCurationFixture();
  restoreEnv = useFixtureEnv(fx);
  serverChild = Bun.spawn([process.execPath, SERVER_CHILD, fx.root, TOKEN], { env: fx.env, cwd: fx.root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = serverChild.stdout.getReader();
  let line = "";
  while (!line.includes("\n")) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`server child exited: ${await new Response(serverChild.stderr).text()}`);
    line += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  serverInfo = JSON.parse(line.slice(0, line.indexOf("\n"))) as ServerInfo;
});

afterEach(async () => {
  serverChild.stdin.end();
  const exited = await Promise.race([serverChild.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
  if (!exited) serverChild.kill();
  await serverChild.exited;
  closeState();
  restoreEnv();
  fx.cleanup();
});

const url = (path: string) => `http://127.0.0.1:${serverInfo.port}${path}`;
const good = (extra: Record<string, string> = {}): Record<string, string> => ({ [LOCAL_HEADER]: "1", [TOKEN_HEADER]: TOKEN, ...extra });
const curationDir = () => join(fx.env["SIL_DATA_DIR"]!, "curation");

async function post(op: string, body: string, headers: Record<string, string> = good({ "content-type": "application/json" })): Promise<Response> {
  return fetch(url(`/api/${op.replace(/\./g, "/")}`), { method: "POST", headers, body });
}

async function get(op: string, query: Record<string, string>): Promise<Response> {
  return fetch(url(`/api/${op.replace(/\./g, "/")}?${new URLSearchParams(query)}`), { headers: good() });
}

async function sil(stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, "ops"], { env: fx.env, cwd: fx.root, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  return { code: child.exitCode, stdout, stderr };
}

async function locationId(): Promise<string> {
  const store = (await (await get("lessons.store", {})).json()) as { binding: { id: string } };
  return store.binding.id;
}

function capture(location: string, text = "Prefer rg over grep."): CurationMutation {
  return {
    requestId: `lc_${crypto.randomUUID()}`,
    binding: { kind: "location", id: location },
    scope: { world: fx.world, project: { kind: "world" } },
    key: { world: fx.world, kind: "capture", id: crypto.randomUUID() },
    expectedRevision: 0,
    change: {
      kind: "capture",
      text,
      source: { kind: "explicit_quote", quote: "the quoted session line", reference: null, quoteRedacted: false, captureSessionId: null, sourceConversationId: null, sourceRowId: null, sourceAgentId: null },
    },
  };
}

const wire = (m: CurationMutation, precondition: CurationPrecondition) => encodeCurationMutationRequest({ mutation: m, precondition }, null);

function success(r: CurationMutationResponse) {
  if (!("receipt" in r)) throw new Error(`expected success: ${JSON.stringify(r)}`);
  return r;
}

/** Every file under the fixture root, with content hash and size. */
function inventory(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        out.set(`${relative(fx.root, p)}/`, "dir");
        walk(p);
      } else {
        out.set(relative(fx.root, p), `${createHash("sha256").update(readFileSync(p)).digest("hex")}:${st.size}`);
      }
    }
  };
  walk(fx.root);
  return out;
}

function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).sort();
}

describe("guarded transport", () => {
  test("an unauthorized mutation is refused before dispatch", async () => {
    const loc = await locationId();
    const body = wire(capture(loc), { kind: "uninitialized", locationId: loc });
    const noLocal = await post("lessons.capture", body, { [TOKEN_HEADER]: TOKEN, "content-type": "application/json" });
    const badToken = await post("lessons.capture", body, { [LOCAL_HEADER]: "1", [TOKEN_HEADER]: "wrong", "content-type": "application/json" });
    expect(noLocal.status).toBeGreaterThanOrEqual(400);
    expect(noLocal.status).toBeLessThan(500);
    expect(badToken.status).toBeGreaterThanOrEqual(400);
    expect(badToken.status).toBeLessThan(500);
    expect(existsSync(curationDir())).toBe(false);
  });

  test("a wrong Host header is refused before dispatch", async () => {
    const loc = await locationId();
    const r = await post("lessons.capture", wire(capture(loc), { kind: "uninitialized", locationId: loc }), good({ "content-type": "application/json", host: "evil.example" }));
    expect(r.status).toBe(403);
    expect(existsSync(curationDir())).toBe(false);
  });

  test("a GET on a mutation route is refused", async () => {
    expect((await fetch(url("/api/lessons/capture"), { headers: good() })).status).toBe(405);
  });

  test("a 16385-byte body is refused before dispatch; 16384 is decoded", async () => {
    const loc = await locationId();
    const m = capture(loc);
    const text = wire(m, { kind: "uninitialized", locationId: loc });
    const over = text.replace('"text":"Prefer', `"text":"${"x".repeat(16385 - text.length)}Prefer`);
    expect(new TextEncoder().encode(over).length).toBe(16385);
    const r = await post("lessons.capture", over);
    expect(r.status).toBe(413);
    expect(existsSync(curationDir())).toBe(false);
    const fits = text.replace('"text":"Prefer', `"text":"${"x".repeat(16384 - text.length)}Prefer`);
    const ok = await post("lessons.capture", fits);
    // Decoded and dispatched: the domain refuses the 4000-byte text bound, not the transport.
    expect(ok.status).toBe(400);
    const res = decodeCurationMutationResponse(await ok.text(), m.requestId);
    expect("error" in res && res.error.code).toBe("INVALID_INPUT");
    expect(existsSync(curationDir())).toBe(false);
  });

  test("an envelope for another op on this route is refused", async () => {
    const loc = await locationId();
    const r = await post("lessons.edit", wire(capture(loc), { kind: "uninitialized", locationId: loc }));
    expect(r.status).toBe(400);
    expect(existsSync(curationDir())).toBe(false);
  });

  test("a refusal maps to its status and a failure envelope without echoing the body", async () => {
    const loc = await locationId();
    const m = capture(loc, "token: sk-abcdefghijklmnop1234");
    const r = await post("lessons.capture", wire(m, { kind: "uninitialized", locationId: loc }));
    expect(r.status).toBe(422);
    const text = await r.text();
    expect(text).not.toContain("sk-abcdef");
    const res = decodeCurationMutationResponse(text, m.requestId);
    expect("error" in res && res.error.code).toBe("SENSITIVE_CONTENT");
  });

  test("a curation read error keeps its safe code over HTTP", async () => {
    const r = await get("lessons.get", { key: encodeLessonKey(capture("a".repeat(64)).key), project: "world", binding: "installation:8c4f2f9e-3b1a-4d6c-9e8f-7a6b5c4d3e2f" });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("INSTALLATION_MISMATCH");
  });

  test("lessons.locate over HTTP returns only the stored scope and the store that answered", async () => {
    const loc = await locationId();
    const m = capture(loc, "SENTINEL locate wording");
    const res = await post("lessons.capture", wire(m, { kind: "uninitialized", locationId: loc }));
    const first = success(decodeCurationMutationResponse(await res.text(), m.requestId));
    const binding = `installation:${first.store.installationId}`;
    const ok = await get("lessons.locate", { key: encodeLessonKey(m.key), binding });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(JSON.parse(text)).toEqual({ store: { locationId: loc, installationId: first.store.installationId }, value: m.scope });
    expect(text).not.toContain("SENTINEL");
    expect(text).not.toContain("quoted session line");
    const wrong = await get("lessons.locate", { key: encodeLessonKey(m.key), binding: "installation:8c4f2f9e-3b1a-4d6c-9e8f-7a6b5c4d3e2f" });
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as { code: string }).code).toBe("INSTALLATION_MISMATCH");
    const extra = await get("lessons.locate", { key: encodeLessonKey(m.key), binding, project: "secret-value" });
    expect(extra.status).toBe(400);
    const body = await extra.text();
    expect(JSON.parse(body).code).toBe("InvalidArgs");
    expect(body).not.toContain("secret-value");
  });

  test("curated read argument errors are typed InvalidArgs over HTTP and the bridge, without echoing input", async () => {
    const loc = await locationId();
    const m = capture(loc);
    const captured = success(decodeCurationMutationResponse((await sil(wire(m, { kind: "uninitialized", locationId: loc }))).stdout.trim(), m.requestId));
    const base = { world: fx.world, project: "world", binding: `installation:${captured.store.installationId}`, collection: "saved" };
    // Positive control: the valid request decodes.
    const valid = await get("lessons.browse", base);
    expect(valid.status).toBe(200);
    expect(((await valid.json()) as { value: { items: Array<{ key: LessonKey }> } }).value.items.map((i) => i.key)).toEqual([m.key]);

    const cases: Array<[string, string, Record<string, string>]> = [
      ["bad boolean", "lessons.browse", { ...base, important: "no" }],
      ["malformed key", "lessons.get", { key: "!!not-a-key", project: "world", binding: base.binding }],
      ["malformed binding", "lessons.get", { key: encodeLessonKey(m.key), project: "world", binding: "installation:nope" }],
      ["unknown field", "lessons.browse", { ...base, evilFieldName: "evilFieldValue" }],
    ];
    for (const [name, op, query] of cases) {
      const r = await get(op, query);
      const text = await r.text();
      expect([name, r.status]).toEqual([name, 400]);
      const body = JSON.parse(text) as { code?: string; detail?: string };
      expect([name, body.code]).toEqual([name, "InvalidArgs"]);
      expect(typeof body.detail).toBe("string");
      expect(text).not.toContain("evilField");
      expect(text).not.toContain("!!not-a-key");
      const bridge = await sil(JSON.stringify({ version: 1, requestId: "b", reads: [{ id: "b", op, args: query }] }));
      const res = decodeControlResponse(bridge.stdout.trim(), "b").results["b"];
      expect([name, res?.ok === false && res.error.code]).toEqual([name, "InvalidArgs"]);
    }
  });

  test("legacy routes keep their ZodError body shape", async () => {
    const r = await get("logs.tail", { name: "not-a-log" });
    expect(r.status).toBe(400);
    expect(Object.keys((await r.json()) as object)).toEqual(["detail"]);
  });

  test("lessons.list keeps its old contract", async () => {
    const r = await get("lessons.list", { world: fx.world });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });
});

describe("one dispatcher across CLI and HTTP", () => {
  test("capture over CLI, edit over HTTP, then the same record, receipts and identity on both", async () => {
    const loc = await locationId();
    // Instrument checks before trusting silence: the fake claude records a call
    // in this fixture, and the inventory sees the seeded learning state.
    const marker = join(fx.root, FIXTURE_CLAUDE_MARKER);
    // The serving process itself resolved the fake and recorded its control call.
    expect(serverInfo.resolvedClaude).toBe(join(fx.root, "bin", "claude"));
    expect(serverInfo.controlExit).toBe(0);
    // The CLI children get the same env; record their control too.
    const probe = Bun.spawnSync(["/bin/sh", "-c", "claude --positive-control"], { env: fx.env, cwd: fx.root });
    expect(probe.exitCode).toBe(0);
    const controls = "--server-positive-control\n--positive-control\n";
    expect(readFileSync(marker, "utf8")).toBe(controls);
    // Populated learning state as sentinels: any write to these shows in the diff.
    // Feedback and proposal events live in the loop-state database, so it is
    // seeded and closed here and its files join the inventory.
    appendRecord("human", { ref: "skill:x", vote: "good" });
    appendRecord("critic", { ref: "skill:x", score: 1 });
    appendRecord("proposal_events", { event: "staged", pattern: "x" });
    closeState();
    const sentinels: Array<[string, string]> = [
      [join(paths.reflectionsDir(fx.world), "2026-10-01-sentinel-0001.md"), "sentinel reflection\n"],
      [join(paths.inboxDir(fx.world), "sentinel-inbox.json"), JSON.stringify(Lesson.parse({ id: "sentinel-inbox", world: fx.world, pattern: "p", text: "sentinel", created: "2026-10-01T00:00:00.000Z" }))],
    ];
    for (const [file, body] of sentinels) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, body);
    }
    const before = inventory();
    const seededPaths = [
      "state/queue/pending/fixture-pending-1.json",
      "state/queue/done/fixture-done-1.json",
      "state/logs/worker.log",
      "config/config.yaml",
      "config/llm.yaml",
      ...sentinels.map(([file]) => relative(fx.root, file)),
      relative(fx.root, paths.loopStateDb()),
    ];
    for (const seeded of seededPaths) expect(before.has(seeded)).toBe(true);

    const m = capture(loc);
    const captureText = wire(m, { kind: "uninitialized", locationId: loc });
    const viaCli = await sil(captureText);
    expect(viaCli.code).toBe(0);
    const captured = success(decodeCurationMutationResponse(viaCli.stdout.trim(), m.requestId));
    const installationId = captured.store.installationId;
    expect(captured.store.locationId).toBe(loc);
    expect(captured.receipt).toMatchObject({ requestId: m.requestId, state: "completed", result: { key: m.key, revision: 1, changed: true } });

    // The bootstrap bytes cannot run again: the store exists now.
    const again = await post("lessons.capture", captureText);
    expect(again.status).toBe(409);
    const refused = decodeCurationMutationResponse(await again.text(), m.requestId);
    expect("error" in refused && refused.error.code).toBe("INSTALLATION_MISMATCH");
    // A pinned retry of the same domain payload over HTTP replays the CLI's receipt exactly.
    const pinnedRetry = wire(m, { kind: "installation", id: installationId });
    expect(JSON.parse(pinnedRetry).mutation.args.mutation).toEqual(JSON.parse(captureText).mutation.args.mutation);
    const replay = await post("lessons.capture", pinnedRetry);
    expect(replay.status).toBe(200);
    expect(success(decodeCurationMutationResponse(await replay.text(), m.requestId))).toEqual(captured);

    const pinned: CurationPrecondition = { kind: "installation", id: installationId };
    const edit: CurationMutation = { ...m, requestId: `lc_${crypto.randomUUID()}`, binding: { kind: "installation", id: installationId }, expectedRevision: 1, change: { kind: "edit", text: "Prefer rg; grep only when rg is missing." } };
    const viaHttp = await post("lessons.edit", wire(edit, pinned));
    expect(viaHttp.status).toBe(200);
    const edited = success(decodeCurationMutationResponse(await viaHttp.text(), edit.requestId));
    expect(edited.store).toEqual(captured.store);
    expect(edited.receipt).toMatchObject({ state: "completed", result: { key: m.key, revision: 2, changed: true } });

    // The same record through an HTTP GET and a CLI control read.
    const key = encodeLessonKey(m.key);
    const binding = `installation:${installationId}`;
    const httpGet = (await (await get("lessons.get", { key, project: "world", binding })).json()) as {
      store: { installationId: string };
      value: { lesson: { effectiveText: string; revision: number; source: { quote: string } } };
    };
    const cliRead = await sil(JSON.stringify({ version: 1, requestId: "g", reads: [{ id: "g", op: "lessons.get", args: { key, project: "world", binding } }] }));
    const cliGet = decodeControlResponse(cliRead.stdout.trim(), "g").results["g"];
    if (!cliGet?.ok) throw new Error(`cli read failed: ${cliRead.stdout}`);
    expect(cliGet.value).toEqual(httpGet);
    expect(httpGet.store.installationId).toBe(installationId);
    expect(httpGet.value.lesson.effectiveText).toBe("Prefer rg; grep only when rg is missing.");
    expect(httpGet.value.lesson.revision).toBe(2);
    expect(httpGet.value.lesson.source.quote).toBe("the quoted session line");

    // Receipt reads agree with what each transport returned.
    const receipt = (await (await get("lessons.receipt", { key, project: "world", binding, requestId: m.requestId })).json()) as {
      store: { installationId: string };
      value: { state: string; payloadHash: string; revision: number };
    };
    expect(receipt.store.installationId).toBe(installationId);
    expect(receipt.value).toMatchObject({ state: "committed", revision: 1, payloadHash: captured.receipt.payloadHash });

    // Direct store inspection.
    const handle = openCurationStoreForRead({ kind: "installation", id: installationId });
    const row = handle.db!.sqlite.query("SELECT revision, text, source_json FROM records").all() as Array<{ revision: number; text: string; source_json: string }>;
    handle.db!.close();
    expect(row).toHaveLength(1);
    expect(row[0]!.revision).toBe(2);
    expect(row[0]!.text).toBe("Prefer rg; grep only when rg is missing.");
    expect(JSON.parse(row[0]!.source_json).quote).toBe("the quoted session line");

    // Nothing outside the curation store changed, and no model was called.
    const diff = changed(before, inventory());
    expect(diff.length).toBeGreaterThan(0);
    expect(diff.filter((p) => !p.startsWith("data/curation/") && p !== "data/curation/")).toEqual([]);
    expect(readFileSync(marker, "utf8")).toBe(controls);
  });

  test("a replay through the CLI survives a source that broke after the first annotation", async () => {
    const dir = paths.inboxDir(fx.world);
    mkdirSync(dir, { recursive: true });
    const write = (id: string) => {
      const lesson = Lesson.parse({ id, world: fx.world, pattern: "legacy-pattern", text: `legacy text ${id}`, created: "2026-10-01T00:00:00.000Z" });
      const file = join(dir, `${paths.safeComponent(id)}.json`);
      writeFileSync(file, JSON.stringify(lesson));
      return file;
    };
    const file7 = write("legacy-7");
    const file8 = write("legacy-8");

    const loc = await locationId();
    const seedM = capture(loc);
    const seed = success(decodeCurationMutationResponse((await sil(wire(seedM, { kind: "uninitialized", locationId: loc }))).stdout.trim(), seedM.requestId));
    const installationId = seed.store.installationId;
    const pinned: CurationPrecondition = { kind: "installation", id: installationId };
    const annotate = (id: string): CurationMutation => {
      const key: LessonKey = { world: fx.world, kind: "inbox", id };
      return { requestId: `lc_${crypto.randomUUID()}`, binding: { kind: "installation", id: installationId }, scope: { world: fx.world, project: { kind: "world" } }, key, expectedRevision: 0, change: { kind: "important", value: true } };
    };

    const m = annotate("legacy-7");
    const text = wire(m, pinned);
    const first = await post("lessons.setImportant", text);
    expect(first.status).toBe(200);
    const committed = success(decodeCurationMutationResponse(await first.text(), m.requestId));
    expect(committed.receipt).toMatchObject({ state: "completed", result: { key: m.key, revision: 1, changed: true } });

    writeFileSync(file7, "{broken");
    writeFileSync(file8, "{broken");
    const again = await sil(text);
    expect(again.code).toBe(0);
    expect(success(decodeCurationMutationResponse(again.stdout.trim(), m.requestId))).toEqual(committed);

    // Positive control: a new first annotation does read the broken source and does not succeed.
    const fresh = annotate("legacy-8");
    const r = await sil(wire(fresh, pinned));
    const res = decodeCurationMutationResponse(r.stdout.trim(), fresh.requestId);
    expect("error" in res).toBe(true);
  });
});
