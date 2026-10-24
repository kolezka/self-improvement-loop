// The native console's bridge to `sil ops`: one fixed argv launch of the loaded
// plugin's own launcher, and a response that is either whole, bound to the
// request and complete, or a visible transport error. Never null, never an
// empty success.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_MAX_REQUEST_BYTES, CONTROL_MAX_RESPONSE_BYTES, type ControlRequest } from "@sil/core/control-protocol";
import type { EngineInterface } from "claude-code";
import {
  createControlFixture,
  FIXTURE_CLAUDE_MARKER,
  FIXTURE_LAST_RUN,
  FIXTURE_LOG_LINE,
  FIXTURE_QUEUE,
  type ControlFixture,
} from "../../../tests/control-fixture.ts";
import { readControl, runControlProcess } from "../src/ui/transport.ts";
import { FakeEngine, type CannedRun, type FakeRunResult } from "./fake-engine.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
// Spaces, both quote kinds and a `$`: a launch that went through a shell
// string would split or expand this.
const PLUGIN_ROOT = `/tmp/sil plugin "quoted" it's $HOME root`;
const UNRELATED_CWD = "/nonexistent/some other project";
const SECRET = "sk-transport-secret-0123456789";

const REQUEST: ControlRequest = {
  version: 1,
  requestId: "req-1",
  reads: [
    { id: "status", op: "worker.status", args: {} },
    { id: "log", op: "logs.tail", args: { name: "worker", lines: 5 } },
  ],
};

function envelope(results: Record<string, unknown>, requestId = REQUEST.requestId): string {
  return `${JSON.stringify({ version: 1, requestId, results })}\n`;
}

const GOOD = envelope({
  status: { ok: true, value: { pending: 2, note: "zażółć gęślą jaźń 🦀" } },
  log: { ok: false, error: { code: "not_found", message: "no worker log yet", retryable: false } },
});

function engine(result: FakeRunResult | { reject: string }, cwd = UNRELATED_CWD): FakeEngine {
  const run: CannedRun = { match: () => true, ...("reject" in result ? { reject: result.reject } : { result }) };
  return new FakeEngine({ sessionId: "s1", cwd, pluginRoot: PLUGIN_ROOT, runs: [run] });
}

function ok(stdout: string, extra: Partial<FakeRunResult> = {}): FakeRunResult {
  return { exitCode: 0, stdout, stderr: "", ...extra };
}

async function failure(promise: Promise<unknown>): Promise<{ name: string; code: string; message: string; stack: string }> {
  try {
    await promise;
  } catch (err) {
    const e = err as { name: string; code: string; message: string; stack?: string };
    return { name: e.name, code: e.code, message: e.message, stack: String(e.stack) };
  }
  throw new Error("expected the call to reject");
}

describe("readControl launch contract", () => {
  test("runs the loaded plugin's own launcher by argv, pinned root, request on stdin, 10 s", async () => {
    const f = engine(ok(GOOD));
    await readControl(f.$ as EngineInterface, REQUEST);

    expect(f.runCalls).toHaveLength(1);
    const call = f.runCalls[0]!;
    const pluginRoot = PLUGIN_ROOT;
    const request = REQUEST;
    expect(call.argv).toEqual(["/bin/sh", `${pluginRoot}/scripts/sil`, "ops"]);
    expect(call.init?.env?.SIL_PLUGIN_ROOT).toBe(pluginRoot);
    expect(JSON.parse(call.init!.stdin!)).toEqual(request);
    expect(call.init?.timeoutMs).toBe(10000);
    // Only the pin: no credential, no PATH rewrite, no cwd of its own.
    expect(Object.keys(call.init?.env ?? {})).toEqual(["SIL_PLUGIN_ROOT"]);
    expect(call.init?.cwd).toBeUndefined();
    // The engine object is reached for the root and the run, nothing else.
    expect(f.calls.filter((c) => !c.startsWith("process.run"))).toEqual([]);
  });

  test("decodes a whole response: multi-byte text intact, a per-read error stays an error", async () => {
    const f = engine(ok(GOOD));
    const response = await readControl(f.$ as EngineInterface, REQUEST);
    expect(response.requestId).toBe("req-1");
    expect(response.results["status"]).toEqual({ ok: true, value: { pending: 2, note: "zażółć gęślą jaźń 🦀" } });
    expect(response.results["log"]).toEqual({
      ok: false,
      error: { code: "not_found", message: "no worker log yet", retryable: false },
    });
  });

  test("runControlProcess returns the one envelope without its newline", async () => {
    const f = engine(ok(GOOD));
    const text = await runControlProcess(f.$ as EngineInterface, JSON.stringify(REQUEST));
    expect(text).toBe(GOOD.slice(0, -1));
    expect(f.runCalls[0]!.init?.stdin).toBe(JSON.stringify(REQUEST));
  });
});

describe("readControl refuses before launching", () => {
  test("a malformed request never reaches the process", async () => {
    const f = engine(ok(GOOD));
    const bad = { ...REQUEST, requestId: "has space" } as ControlRequest;
    const err = await failure(readControl(f.$ as EngineInterface, bad));
    expect(err).toMatchObject({ name: "ControlTransportError", code: "invalid_request" });
    expect(f.runCalls).toEqual([]);
  });

  test("a request over the byte bound never reaches the process, counted in bytes", async () => {
    const f = engine(ok(GOOD));
    // Under the bound in UTF-16 units, over it in UTF-8 bytes.
    const filler = "ż".repeat(Math.ceil(CONTROL_MAX_REQUEST_BYTES / 2));
    expect(filler.length).toBeLessThan(CONTROL_MAX_REQUEST_BYTES);
    const big: ControlRequest = { ...REQUEST, reads: [{ id: "a", op: "logs.tail", args: { filler } }] };
    const err = await failure(readControl(f.$ as EngineInterface, big));
    expect(err).toMatchObject({ name: "ControlTransportError", code: "request_too_large" });
    expect(f.runCalls).toEqual([]);
  });
});

describe("readControl refuses a request it cannot encode, before launching", () => {
  // Each passes parseControlRequest (args is a plain object) but cannot become
  // the JSON that would be sent. The secret stands for whatever the caller's
  // object carries: it must not surface in the error.
  const throwing = { toJSON: () => { throw new Error(`${SECRET} at /private/path/of/caller`); } };
  const cyclic: Record<string, unknown> = { name: "worker" };
  cyclic["self"] = cyclic;
  const getter = Object.defineProperty({}, "lines", {
    enumerable: true,
    get: () => { throw new TypeError(SECRET); },
  });
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a throwing toJSON", { filter: throwing }],
    ["a throwing toJSON on args itself", throwing],
    ["a cyclic value", cyclic],
    ["a BigInt", { lines: 10n }],
    ["a throwing getter", getter],
    ["a toJSON that drops args from the wire", { toJSON: () => undefined }],
    ["a toJSON that rewrites args into a non-object", { toJSON: () => [SECRET] }],
  ];

  for (const [name, args] of cases) {
    test(name, async () => {
      const f = engine(ok(GOOD));
      const request = { ...REQUEST, reads: [{ id: "a", op: "logs.tail", args }] } as ControlRequest;
      const err = await failure(readControl(f.$ as EngineInterface, request));
      expect(err.name).toBe("ControlTransportError");
      expect(err.code).toBe("invalid_request");
      expect(err.message).toBe("The control request is malformed and was not sent.");
      expect(err.stack).not.toContain(SECRET);
      expect(err.stack).not.toContain("/private/path/of/caller");
      expect(f.runCalls).toEqual([]);
      expect(f.calls).toEqual([]);
    });
  }
});

describe("readControl transport failures are visible and payload-free", () => {
  const cases: Array<[string, FakeRunResult | { reject: string }, string]> = [
    ["nonzero exit", { exitCode: 2, stdout: GOOD, stderr: `sil ops: invalid request ${SECRET}` }, "exit_nonzero"],
    ["rejected process start", { reject: `ENOENT: /bin/sh ${SECRET}` }, "launch_failed"],
    ["timeout", { reject: `timed out after 10000 ms ${SECRET}` }, "launch_failed"],
    ["stdout truncated", ok(GOOD, { isStdoutTruncated: true }), "truncated"],
    ["stderr truncated", ok(GOOD, { isStderrTruncated: true, stderr: SECRET }), "truncated"],
    ["no trailing newline", ok(GOOD.slice(0, -1)), "incomplete"],
    ["empty output", ok(""), "incomplete"],
    ["malformed JSON", ok(`{"version":1,"requestId":"req-1","results":{${SECRET}\n`), "malformed_response"],
    ["two envelopes", ok(GOOD + GOOD), "malformed_response"],
    ["wrong request id", ok(envelope({ status: { ok: true, value: 1 }, log: { ok: true, value: 2 } }, "req-other")), "request_mismatch"],
    ["a missing read", ok(envelope({ status: { ok: true, value: 1 } })), "result_mismatch"],
    ["an extra read", ok(envelope({ status: { ok: true, value: 1 }, log: { ok: true, value: 2 }, more: { ok: true, value: 3 } })), "result_mismatch"],
    ["no reads answered", ok(envelope({})), "result_mismatch"],
    [
      "response over the byte bound",
      ok(envelope({ status: { ok: true, value: "ż".repeat(CONTROL_MAX_RESPONSE_BYTES / 2) }, log: { ok: true, value: 1 } })),
      "response_too_large",
    ],
  ];

  for (const [name, result, code] of cases) {
    test(name, async () => {
      const f = engine(result);
      const err = await failure(readControl(f.$ as EngineInterface, REQUEST));
      expect(err.name).toBe("ControlTransportError");
      expect(err.code).toBe(code);
      expect(err.message.length).toBeGreaterThan(0);
      expect(err.message.length).toBeLessThanOrEqual(200);
      expect(err.message).not.toContain(SECRET);
      expect(err.message).not.toContain("zażółć");
      expect(f.runCalls).toHaveLength(1);
    });
  }
});

// The real launcher and the real built CLI, in the inert seeded fixture. The
// plugin root holds spaces and quotes, the engine's cwd is somewhere else, and
// a decoy installation is registered so a launcher that ignored the pin would
// run it instead.
describe("readControl through the real scripts/sil", () => {
  let fx: ControlFixture;
  let elsewhere: string;

  beforeEach(() => {
    fx = createControlFixture();
    elsewhere = mkdtempSync(join(tmpdir(), "sil-elsewhere-"));
  });
  afterEach(() => {
    fx.cleanup();
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test("decodes the seeded fixture state, with no model call and no decoy", async () => {
    const pluginRoot = join(fx.root, `plugin root "dq" 'sq' $HOME`);
    mkdirSync(join(pluginRoot, "scripts"), { recursive: true });
    copyFileSync(join(ROOT, "scripts/sil"), join(pluginRoot, "scripts/sil"));
    const built = await Bun.build({
      entrypoints: [join(ROOT, "apps/cli/src/main.ts")],
      outdir: join(pluginRoot, "dist"),
      naming: "cli.js",
      target: "bun",
      format: "esm",
    });
    expect(built.success).toBe(true);

    const decoyRoot = join(fx.root, "decoy");
    const decoyMarker = join(fx.root, "decoy-ran");
    mkdirSync(join(decoyRoot, "dist"), { recursive: true });
    writeFileSync(join(decoyRoot, "dist/cli.js"), `require("fs").writeFileSync(${JSON.stringify(decoyMarker)}, "x");\n`);
    const installed = join(fx.env["CLAUDE_CONFIG_DIR"]!, "plugins/installed_plugins.json");
    mkdirSync(join(installed, ".."), { recursive: true });
    writeFileSync(
      installed,
      JSON.stringify({ plugins: { "self-improvement-loop@decoy": [{ installPath: decoyRoot, lastUpdated: "2999-01-01" }] } }),
    );
    chmodSync(join(pluginRoot, "scripts/sil"), 0o644); // run through /bin/sh, not its own exec bit

    const f = new FakeEngine({ sessionId: "s1", cwd: elsewhere, pluginRoot, realRun: { env: fx.env } });
    const response = await readControl(f.$ as EngineInterface, {
      version: 1,
      requestId: "fixture-req",
      reads: [
        { id: "status", op: "worker.status", args: {} },
        { id: "log", op: "logs.tail", args: { name: "worker", lines: 5 } },
      ],
    });

    expect(f.runCalls[0]!.argv).toEqual(["/bin/sh", `${pluginRoot}/scripts/sil`, "ops"]);
    expect(response.requestId).toBe("fixture-req");
    const status = response.results["status"];
    expect(status?.ok).toBe(true);
    const s = (status as { ok: true; value: { pending: number; done: number; failed: number; last_run: string } }).value;
    expect({ pending: s.pending, done: s.done, failed: s.failed }).toEqual({ ...FIXTURE_QUEUE });
    expect(s.last_run).toBe(FIXTURE_LAST_RUN);
    expect(response.results["log"]?.ok).toBe(true);
    expect(JSON.stringify(response.results["log"])).toContain(FIXTURE_LOG_LINE);

    expect(existsSync(decoyMarker)).toBe(false);
    expect(existsSync(join(fx.root, FIXTURE_CLAUDE_MARKER))).toBe(false);
  }, 60_000);
});
