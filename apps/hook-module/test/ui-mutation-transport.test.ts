// The native console's mutation bridge to `sil ops`. Before launch a bad
// envelope is refused and provably not sent. Once the process was called,
// nothing the adapter sees proves the mutation did not commit, so every
// transport or decode failure is the fixed unknown outcome for the request id
// that was actually sent. Valid host answers pass through the strict decoder.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MUTATION_MAX_REQUEST_BYTES,
  OUTCOME_UNKNOWN_ERROR,
  classifyMutationFailure,
  encodeMutationRequestEnvelope,
  type CurationMutationFailure,
  type CurationPurgedReceipt,
  type MutationRequestEnvelope,
} from "@sil/core/control-mutation";
import type { EngineInterface } from "claude-code";
import { createControlFixture, type ControlFixture } from "../../../tests/control-fixture.ts";
import { mutateControl } from "../src/ui/transport.ts";
import { FakeEngine, type CannedRun, type FakeRunInit, type FakeRunResult } from "./fake-engine.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PLUGIN_ROOT = `/tmp/sil plugin "quoted" it's $HOME root`;
const UNRELATED_CWD = "/nonexistent/some other project";
const SECRET = "sk-mutation-secret-0123456789";

const RID = "lc_0b9e8f0a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER_RID = "lc_11111111-2222-4333-8444-555555555555";
const UUID = "8c4f2f9e-3b1a-4d6c-9e8f-7a6b5c4d3e2f";
const LOC = "a".repeat(64);
const HASH = "b".repeat(64);
const KEY = { world: "w", kind: "capture", id: UUID } as const;

function request(requestId = RID, args: Record<string, unknown> = { v: 1 }): MutationRequestEnvelope {
  return { version: 1, requestId, mutation: { op: "lessons.edit", args, confirmed: false } };
}

function committed(requestId = RID): Record<string, unknown> {
  return {
    requestId,
    payloadHash: HASH,
    state: "completed",
    result: { key: KEY, revision: 7, changed: true },
    error: null,
    startedAt: "2026-10-24T10:00:00.000Z",
    finishedAt: "2026-10-24T10:00:00.010Z",
  };
}

function successLine(requestId = RID, receipt: Record<string, unknown> = committed(requestId), store: unknown = { locationId: LOC, installationId: UUID }): string {
  return `${JSON.stringify({ version: 1, requestId, receipt, store })}\n`;
}

function failureLine(code: string, message: string, conflict: unknown = null, requestId = RID): string {
  return `${JSON.stringify({ version: 1, requestId, error: { code, message, retryable: false }, conflict })}\n`;
}

const UNKNOWN = (requestId: string): CurationMutationFailure => ({
  version: 1,
  requestId,
  error: { code: "OUTCOME_UNKNOWN", message: OUTCOME_UNKNOWN_ERROR.message, retryable: false },
  conflict: null,
});

function ok(stdout: string, extra: Partial<FakeRunResult> = {}): FakeRunResult {
  return { exitCode: 0, stdout, stderr: "", ...extra };
}

function engine(answer: FakeRunResult | { reject: string } | { respond: (init: FakeRunInit | undefined) => FakeRunResult }): FakeEngine {
  const run: CannedRun = { match: () => true, ...("stdout" in answer ? { result: answer } : answer) };
  return new FakeEngine({ sessionId: "s1", cwd: UNRELATED_CWD, pluginRoot: PLUGIN_ROOT, runs: [run] });
}

/** Answers for whatever request id the process actually received on stdin. */
function echoSuccess(init: FakeRunInit | undefined): FakeRunResult {
  const sent = JSON.parse(init?.stdin ?? "{}") as { requestId: string };
  return ok(successLine(sent.requestId));
}

async function preflightRefusal(promise: Promise<unknown>): Promise<{ name: string; code: string; message: string; stack: string }> {
  try {
    await promise;
  } catch (err) {
    const e = err as { name: string; code: string; message: string; stack?: string };
    return { name: e.name, code: e.code, message: e.message, stack: String(e.stack) };
  }
  throw new Error("expected the call to reject before launch");
}

describe("mutateControl launch contract", () => {
  test("same fixed launch as reads: argv, pinned root, envelope on stdin, 10 s", async () => {
    const f = engine(ok(successLine()));
    await mutateControl(f.$ as EngineInterface, request());
    expect(f.runCalls).toHaveLength(1);
    const call = f.runCalls[0]!;
    expect(call.argv).toEqual(["/bin/sh", `${PLUGIN_ROOT}/scripts/sil`, "ops"]);
    expect(call.init?.env).toEqual({ SIL_PLUGIN_ROOT: PLUGIN_ROOT });
    expect(call.init?.timeoutMs).toBe(10000);
    expect(call.init?.cwd).toBeUndefined();
    expect(call.init?.stdin).toBe(encodeMutationRequestEnvelope(request()));
    expect(f.calls.filter((c) => !c.startsWith("process.run"))).toEqual([]);
  });
});

describe("mutateControl refuses before launching", () => {
  const throwing = { toJSON: () => { throw new Error(`${SECRET} at /private/path/of/caller`); } };
  const cyclic: Record<string, unknown> = { name: "x" };
  cyclic["self"] = cyclic;
  const getter = Object.defineProperty({}, "body", { enumerable: true, get: () => { throw new TypeError(SECRET); } });
  const malformed: Array<[string, unknown]> = [
    ["not an object", null],
    ["a request id with a space", request("has space")],
    ["an unsupported version", { ...request(), version: 2 }],
    ["an extra envelope key", { ...request(), reads: [] }],
    ["a missing confirmed", { version: 1, requestId: RID, mutation: { op: "lessons.edit", args: {} } }],
    ["args that is not an object", { version: 1, requestId: RID, mutation: { op: "lessons.edit", args: [SECRET], confirmed: false } }],
    ["a throwing toJSON in args", request(RID, { body: throwing })],
    ["a cyclic args value", request(RID, cyclic)],
    ["a BigInt in args", request(RID, { n: 10n })],
    ["a throwing getter in args", request(RID, getter)],
    ["args whose toJSON turns into a non-object on the wire", request(RID, { toJSON: () => [SECRET] })],
  ];

  for (const [name, envelope] of malformed) {
    test(`malformed: ${name}`, async () => {
      const f = engine(ok(successLine()));
      const err = await preflightRefusal(mutateControl(f.$ as EngineInterface, envelope as MutationRequestEnvelope));
      expect(err).toMatchObject({ name: "ControlTransportError", code: "invalid_request" });
      expect(err.message).toBe("The control request is malformed and was not sent.");
      expect(err.stack).not.toContain(SECRET);
      expect(err.stack).not.toContain("/private/path/of/caller");
      expect(f.runCalls).toEqual([]);
      expect(f.calls).toEqual([]);
    });
  }

  test("oversized in UTF-8 bytes, though under the bound in UTF-16 units", async () => {
    const f = engine(ok(successLine()));
    const filler = "ż".repeat(Math.ceil(MUTATION_MAX_REQUEST_BYTES / 2));
    expect(filler.length).toBeLessThan(MUTATION_MAX_REQUEST_BYTES);
    const err = await preflightRefusal(mutateControl(f.$ as EngineInterface, request(RID, { filler })));
    expect(err).toMatchObject({ name: "ControlTransportError", code: "request_too_large" });
    expect(err.message).toBe(`The control request is over ${MUTATION_MAX_REQUEST_BYTES} bytes and was not sent.`);
    expect(err.message).not.toContain("ż");
    expect(f.runCalls).toEqual([]);
    expect(f.calls).toEqual([]);
  });
});

describe("mutateControl sends and binds the normalized envelope", () => {
  test("the wire carries what the envelope encodes to, not the caller's object", async () => {
    const f = engine({ respond: echoSuccess });
    const args = { keep: "zażółć", dropped: undefined, when: { toJSON: () => "2026-10-24" } };
    await mutateControl(f.$ as EngineInterface, request(RID, args));
    expect(JSON.parse(f.runCalls[0]!.init!.stdin!)).toEqual({
      version: 1,
      requestId: RID,
      mutation: { op: "lessons.edit", args: { keep: "zażółć", when: "2026-10-24" }, confirmed: false },
    });
  });

  test("a request id getter is read once: the response is bound to the id that was sent", async () => {
    let reads = 0;
    const envelope = Object.defineProperty(
      { version: 1, mutation: { op: "lessons.edit", args: { v: 1 }, confirmed: false } },
      "requestId",
      { enumerable: true, get: () => (reads++ === 0 ? RID : OTHER_RID) },
    ) as unknown as MutationRequestEnvelope; // requestId lives only on the getter
    const f = engine({ respond: echoSuccess });
    const response = await mutateControl(f.$ as EngineInterface, envelope);
    expect(JSON.parse(f.runCalls[0]!.init!.stdin!).requestId).toBe(RID);
    expect(response.requestId).toBe(RID);
    expect("receipt" in response && response.receipt.state).toBe("completed");
  });

  test("the caller rewriting its envelope mid-flight changes nothing", async () => {
    const f = engine({ respond: echoSuccess });
    const envelope = request();
    const pending = mutateControl(f.$ as EngineInterface, envelope);
    envelope.requestId = OTHER_RID;
    envelope.mutation.op = "lessons.purge";
    const response = await pending;
    expect(response.requestId).toBe(RID);
    expect("receipt" in response && response.receipt.requestId).toBe(RID);
  });

  test("an unknown outcome names the sent id even after the caller rewrote its envelope", async () => {
    const f = engine({ reject: `timed out after 10000 ms ${SECRET}` });
    const envelope = request();
    const pending = mutateControl(f.$ as EngineInterface, envelope);
    envelope.requestId = OTHER_RID;
    expect(await pending).toEqual(UNKNOWN(RID));
  });
});

describe("mutateControl after launch: any failure is the fixed unknown outcome", () => {
  const cases: Array<[string, FakeRunResult | { reject: string }]> = [
    ["timeout, even though the child may have written", { reject: `timed out after 10000 ms ${SECRET}` }],
    ["rejected process start", { reject: `ENOENT: /bin/sh ${SECRET}` }],
    ["nonzero exit with a success envelope on stdout", { exitCode: 1, stdout: successLine(), stderr: SECRET }],
    ["nonzero exit with a refusal on stdout", { exitCode: 2, stdout: failureLine("INVALID_INPUT", SECRET), stderr: SECRET }],
    ["stdout truncated", ok(successLine(), { isStdoutTruncated: true })],
    ["stderr truncated", ok(successLine(), { isStderrTruncated: true, stderr: SECRET })],
    ["partial output, cut mid-envelope", ok(successLine().slice(0, 40))],
    ["a whole envelope missing its newline", ok(successLine().slice(0, -1))],
    ["empty output", ok("")],
    ["malformed JSON", ok(`{"version":1,"requestId":"${RID}","receipt":{${SECRET}\n`)],
    ["two envelopes", ok(successLine() + successLine())],
    ["response for another request id", ok(successLine(OTHER_RID))],
    ["refusal for another request id", ok(failureLine("CURATION_CONFLICT", SECRET, { revision: 3 }, OTHER_RID))],
    ["receipt for another request id", ok(successLine(RID, committed(OTHER_RID)))],
    ["an invalid store", ok(successLine(RID, committed(), { locationId: SECRET, installationId: UUID }))],
    ["a read envelope instead of a mutation one", ok(`${JSON.stringify({ version: 1, requestId: RID, results: {} })}\n`)],
    ["a conflict hint on a non-conflict code", ok(failureLine("INVALID_INPUT", SECRET, { revision: 3 }))],
    ["response over the byte bound", ok(failureLine("INVALID_INPUT", "ż".repeat(600_000)))],
  ];

  for (const [name, result] of cases) {
    test(name, async () => {
      const f = engine(result);
      const response = await mutateControl(f.$ as EngineInterface, request());
      expect(response).toEqual(UNKNOWN(RID));
      expect("error" in response && classifyMutationFailure(response.error)).toBe("unknown");
      expect(JSON.stringify(response)).not.toContain(SECRET);
      expect(f.runCalls).toHaveLength(1);
    });
  }
});

describe("mutateControl passes valid host answers through the strict decoder", () => {
  test("a completed receipt keeps its key, revision, hash and executing store", async () => {
    const f = engine(ok(successLine()));
    const response = await mutateControl(f.$ as EngineInterface, request());
    expect(response).toEqual({
      version: 1,
      requestId: RID,
      receipt: {
        requestId: RID,
        payloadHash: HASH,
        state: "completed",
        result: { key: KEY, revision: 7, changed: true },
        error: null,
        startedAt: "2026-10-24T10:00:00.000Z",
        finishedAt: "2026-10-24T10:00:00.010Z",
      },
      store: { locationId: LOC, installationId: UUID },
    });
  });

  test("a purged receipt stays purged", async () => {
    const purged: CurationPurgedReceipt = { requestId: RID, state: "purged", payloadHash: null, result: null, error: null, startedAt: "a", finishedAt: "b" };
    const f = engine(ok(successLine(RID, purged)));
    const response = await mutateControl(f.$ as EngineInterface, request());
    expect("receipt" in response && response.receipt).toEqual(purged);
  });

  test("a host refusal keeps its code, message and conflict hint", async () => {
    const f = engine(ok(failureLine("CURATION_CONFLICT", "lesson changed since it was read", { revision: 9 })));
    const response = await mutateControl(f.$ as EngineInterface, request());
    expect(response).toEqual({
      version: 1,
      requestId: RID,
      error: { code: "CURATION_CONFLICT", message: "lesson changed since it was read", retryable: false },
      conflict: { revision: 9 },
    });
    expect("error" in response && classifyMutationFailure(response.error)).toBe("refused");
  });

  test("a host failure outside the refusal set is passed on, not reinterpreted", async () => {
    const f = engine(ok(failureLine("STORE_EXPLODED", "host said so")));
    const response = await mutateControl(f.$ as EngineInterface, request());
    expect(response).toEqual({
      version: 1,
      requestId: RID,
      error: { code: "STORE_EXPLODED", message: "host said so", retryable: false },
      conflict: null,
    });
  });
});

// The real launcher and built CLI in the inert seeded fixture. A read-tier op
// is refused by the host gate before any config or store is touched, so this
// proves the wire end to end without a curation store.
describe("mutateControl through the real scripts/sil", () => {
  let fx: ControlFixture;
  let elsewhere: string;

  beforeEach(() => {
    fx = createControlFixture();
    elsewhere = mkdtempSync(join(tmpdir(), "sil-mutation-elsewhere-"));
  });
  afterEach(() => {
    fx.cleanup();
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test("a host refusal arrives as a decoded failure envelope for the sent id", async () => {
    const pluginRoot = join(fx.root, `plugin root "dq" 'sq' $HOME`);
    mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
    copyFileSync(join(ROOT, "scripts/sil"), join(pluginRoot, "scripts/sil"));
    chmodSync(join(pluginRoot, "scripts/sil"), 0o644);
    const built = await Bun.build({
      entrypoints: [join(ROOT, "apps/cli/src/main.ts")],
      outdir: join(pluginRoot, "dist"),
      naming: "cli.js",
      target: "bun",
      format: "esm",
    });
    expect(built.success).toBe(true);

    const f = new FakeEngine({ sessionId: "s1", cwd: elsewhere, pluginRoot, realRun: { env: fx.env } });
    const envelope: MutationRequestEnvelope = { version: 1, requestId: RID, mutation: { op: "worker.status", args: {}, confirmed: false } };
    const response = await mutateControl(f.$ as EngineInterface, envelope);
    expect(f.runCalls).toHaveLength(1);
    expect(response).toEqual({
      version: 1,
      requestId: RID,
      error: { code: "OpNotAllowed", message: "op is not an allowed mutation", retryable: false },
      conflict: null,
    });
  }, 60_000);
});
