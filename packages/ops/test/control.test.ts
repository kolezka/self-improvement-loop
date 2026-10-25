// The control executor runs only the explicit read allowlist. Each test swaps
// registry entries for counting stubs and restores the real registry after,
// the same snapshot/restore pattern as registry.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { ConfigError, StateReadError, StateWriteError, ValidationError } from "@sil/core";
import { CurationError } from "@sil/core/lesson-curation";
import { QueueReadError } from "@sil/store";
import { ProposalChanged } from "../src/handlers/console.ts";
import { CONTROL_MAX_REQUEST_BYTES, CONTROL_MAX_RESPONSE_BYTES, ControlProtocolError, encodeControlResponse, type ControlResult } from "@sil/core/control-protocol";
import "../src/index.ts";
import { CONTROL_READ_OPS, decodeControlRequestBytes, executeControlRead, redactMessage } from "../src/control.ts";
import { setDeps } from "../src/deps.ts";
import { REGISTRY, type Op } from "../src/registry.ts";
import { createControlFixture, FIXTURE_LAST_RUN, FIXTURE_QUEUE, type ControlFixture } from "../../../tests/control-fixture.ts";

let snapshot: [string, Op][];
let calls: Record<string, number>;
let restoreDeps: () => void;
let providerCalls: number;

function stub(name: string, fn: (args: unknown) => unknown, args: Op["args"] = z.object({})): void {
  const real = REGISTRY.get(name);
  REGISTRY.set(name, {
    name,
    tier: real?.tier ?? "read",
    gate: real?.gate ?? "none",
    args: real?.args ?? args,
    doc: "",
    fn: (a: unknown) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return fn(a);
    },
  });
}

function req(reads: { id: string; op: string; args?: Record<string, unknown> }[]) {
  return { version: 1, requestId: "r", reads: reads.map((r) => ({ id: r.id, op: r.op, args: r.args ?? {} })) };
}

function err(result: ControlResult | undefined): { code: string; message: string; retryable: boolean } {
  expect(result).toBeDefined();
  expect(result!.ok).toBe(false);
  if (result!.ok) throw new Error("unreachable");
  return result!.error;
}

beforeEach(() => {
  snapshot = [...REGISTRY.entries()];
  calls = {};
  providerCalls = 0;
  const countProvider = () => {
    providerCalls += 1;
    throw new Error("provider must not be called");
  };
  restoreDeps = setDeps({
    providers: new Proxy({}, { get: () => countProvider }) as never,
  });
  // Every mutating op the registry knows becomes a counter, so a dispatch of
  // any of them shows up as a call.
  for (const [name, op] of snapshot) {
    if (op.tier !== "read") stub(name, () => "mutated");
  }
  stub("health.report", () => "probed");
  stub("llm.status", () => "probed");
});

afterEach(() => {
  restoreDeps();
  REGISTRY.clear();
  for (const [name, op] of snapshot) REGISTRY.set(name, op);
});

const mutationCalls = () =>
  Object.entries(calls)
    .filter(([name]) => !CONTROL_READ_OPS.includes(name))
    .reduce((n, [, c]) => n + c, 0);

describe("allowlist", () => {
  test("is exactly the fourteen bridge reads, three console reads and eight curated lesson reads", () => {
    expect([...CONTROL_READ_OPS].sort()).toEqual(
      [
        "worlds.list",
        "worker.status",
        "review.queue",
        "review.detail",
        "review.diff",
        "router.inventory",
        "reflections.list",
        "reflections.get",
        "reflections.count",
        "lessons.list",
        "queue.list",
        "queue.detail",
        "logs.tail",
        "health.build",
        "console.bootstrap",
        "console.page",
        "console.proposalPage",
        "lessons.projects",
        "lessons.context",
        "lessons.browse",
        "lessons.get",
        "lessons.history",
        "lessons.receipt",
        "lessons.store",
        "lessons.locate",
      ].sort(),
    );
  });

  test("every allowlisted op is registered as tier read", () => {
    for (const name of CONTROL_READ_OPS) expect(snapshot.find(([n]) => n === name)?.[1].tier).toBe("read");
  });

  test("a mutating op is refused per read and never dispatched", async () => {
    expect((await executeControlRead({ version: 1, requestId: "r", reads: [{ id: "x", op: "config.set", args: {} }] })).results.x!.ok).toBe(false);
    expect(mutationCalls()).toBe(0);
  });

  test.each(["config.set", "loop.run", "skill.accept", "queue.skip", "health.report", "llm.status", "config.get", "nope.missing"])(
    "%s is refused as OpNotAllowed with no call",
    async (op) => {
      const resp = await executeControlRead(req([{ id: "x", op }]));
      expect(err(resp.results["x"]).code).toBe("OpNotAllowed");
      expect(Object.values(calls).reduce((a, b) => a + b, 0)).toBe(0);
      expect(providerCalls).toBe(0);
    },
  );

  test.each(["bogus", "", "worker status", "__proto__", "constructor", "toString", "hasOwnProperty", "Worker.Status", "op\u0000name", "x".repeat(4000)])(
    "unknown op string case %# is a per-read OpNotAllowed, never dispatched or echoed",
    async (op) => {
      stub("worker.status", () => ({ pending: 1 }));
      const resp = await executeControlRead(req([{ id: "w", op: "worker.status" }, { id: "x", op }]));
      const e = err(resp.results["x"]);
      expect(e.code).toBe("OpNotAllowed");
      if (op.length > 0) expect(e.message).not.toContain(op);
      expect(err(resp.results["w"]).code).toBe("BatchRejected");
      expect(calls).toEqual({});
    },
  );

  test("a forbidden op anywhere in the batch stops every read in it", async () => {
    stub("worker.status", () => ({ pending: 1 }));
    const resp = await executeControlRead(req([{ id: "a", op: "worker.status" }, { id: "b", op: "config.set", args: { config: {} } }]));
    expect(calls["worker.status"]).toBeUndefined();
    expect(err(resp.results["a"]).code).toBe("BatchRejected");
    expect(err(resp.results["b"]).code).toBe("OpNotAllowed");
    expect(mutationCalls()).toBe(0);
  });
});

describe("argument validation before dispatch", () => {
  test("an unknown argument key is InvalidArgs, and the batch does not run", async () => {
    stub("worker.status", () => ({ pending: 1 }));
    stub("worlds.list", () => []);
    const resp = await executeControlRead(req([{ id: "a", op: "worlds.list" }, { id: "b", op: "worker.status", args: { extra: 1 } }]));
    expect(err(resp.results["b"]).code).toBe("InvalidArgs");
    expect(err(resp.results["a"]).code).toBe("BatchRejected");
    expect(calls).toEqual({});
  });

  test("a bad world name is InvalidArgs", async () => {
    stub("review.queue", () => []);
    const resp = await executeControlRead(req([{ id: "a", op: "review.queue", args: { world: "../etc" } }]));
    expect(err(resp.results["a"]).code).toBe("InvalidArgs");
    expect(calls).toEqual({});
  });

  test("a prototype-like argument key is refused, not silently dropped", async () => {
    stub("worker.status", () => ({ pending: 1 }));
    const args = JSON.parse('{"__proto__":{"world":"x"}}');
    const resp = await executeControlRead(req([{ id: "a", op: "worker.status", args }]));
    expect(err(resp.results["a"]).code).toBe("InvalidArgs");
    expect(calls).toEqual({});
  });

  test("validated args reach the handler", async () => {
    let seen: unknown;
    stub("logs.tail", (a) => {
      seen = a;
      return ["l"];
    });
    const resp = await executeControlRead(req([{ id: "a", op: "logs.tail", args: { name: "worker", lines: 5 } }]));
    expect(resp.results["a"]).toEqual({ ok: true, value: ["l"] });
    expect(seen).toEqual({ name: "worker", lines: 5 });
  });
});

describe("structural errors throw", () => {
  test.each([
    ["zero reads", req([])],
    ["nine reads", req(Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, op: "worker.status" })))],
    ["duplicate ids", req([{ id: "a", op: "worker.status" }, { id: "a", op: "worker.status" }])],
    ["unknown version", { ...req([{ id: "a", op: "worker.status" }]), version: 2 }],
    ["not an object", "worker.status"],
  ])("%s", async (_name, value) => {
    stub("worker.status", () => ({}));
    await expect(executeControlRead(value)).rejects.toBeInstanceOf(ControlProtocolError);
    expect(calls).toEqual({});
  });
});

describe("per-read execution results", () => {
  test("one domain failure leaves the healthy read's real value", async () => {
    stub("worker.status", () => ({ pending: 3, last_run: "t" }));
    stub("lessons.list", () => {
      throw new ConfigError("no world named fixture2");
    });
    const resp = await executeControlRead(req([{ id: "ok", op: "worker.status" }, { id: "bad", op: "lessons.list", args: { world: "fixture2" } }]));
    expect(resp.results["ok"]).toEqual({ ok: true, value: { pending: 3, last_run: "t" } });
    const e = err(resp.results["bad"]);
    expect(e.code).toBe("ConfigError");
    expect(e.message).toContain("no world named fixture2");
  });

  // Merge guard: main's strict-read errors and the PR's curation errors both
  // reach the caller by their own code, in one batch through the same path.
  test("strict-read and curation errors both keep their own code and message", async () => {
    stub("worker.status", () => {
      throw new StateReadError("worker state: EACCES");
    });
    stub("queue.list", () => {
      throw new QueueReadError("queue pending: ENOTDIR");
    });
    stub("console.bootstrap", () => {
      throw new ProposalChanged("proposal changed between pages");
    });
    stub("lessons.store", () => {
      throw new CurationError("STORAGE_BUSY");
    });
    const resp = await executeControlRead(
      req([
        { id: "state", op: "worker.status" },
        { id: "queue", op: "queue.list" },
        { id: "proposal", op: "console.bootstrap", args: { cwd: "/fixture" } },
        { id: "busy", op: "lessons.store" },
      ]),
    );
    expect(err(resp.results["state"])).toEqual({ code: "StateReadError", message: "worker state: EACCES", retryable: false });
    expect(err(resp.results["queue"])).toEqual({ code: "QueueReadError", message: "queue pending: ENOTDIR", retryable: false });
    expect(err(resp.results["proposal"])).toEqual({ code: "ProposalChanged", message: "proposal changed between pages", retryable: false });
    expect(err(resp.results["busy"])).toEqual({ code: "STORAGE_BUSY", message: "curation storage busy", retryable: true });

    stub("lessons.store", () => {
      throw new CurationError("PURGED", ["key"]);
    });
    const purged = await executeControlRead(req([{ id: "p", op: "lessons.store" }]));
    expect(err(purged.results["p"])).toEqual({ code: "PURGED", message: "lesson curation was purged: key", retryable: false });
  });

  test("a StateWriteError keeps its own code and message, like a StateReadError", async () => {
    stub("worker.status", () => {
      throw new StateWriteError("loop state: EACCES");
    });
    const resp = await executeControlRead(req([{ id: "state", op: "worker.status" }]));
    expect(err(resp.results["state"])).toEqual({ code: "StateWriteError", message: "loop state: EACCES", retryable: false });
  });

  test("console reads and curated lesson reads are registered and allowed", () => {
    for (const name of ["console.bootstrap", "console.page", "console.proposalPage", "lessons.list", "lessons.browse", "lessons.receipt", "lessons.store"]) {
      expect(CONTROL_READ_OPS).toContain(name);
      expect(REGISTRY.get(name)?.tier).toBe("read");
    }
    // Curation mutations stay registered but never become control reads.
    for (const name of ["lessons.capture", "lessons.edit", "lessons.setImportant", "lessons.acknowledgeSource", "lessons.purge"]) {
      expect(REGISTRY.has(name)).toBe(true);
      expect(CONTROL_READ_OPS).not.toContain(name);
    }
  });

  test("a failed read is an error, never an empty list or zero", async () => {
    stub("queue.list", () => {
      throw new ValidationError("queue unreadable");
    });
    const resp = await executeControlRead(req([{ id: "q", op: "queue.list" }]));
    expect(resp.results["q"]!.ok).toBe(false);
    expect(Object.hasOwn(resp.results["q"]!, "value")).toBe(false);
  });

  test("error messages are redacted and an unexpected error carries no stack", async () => {
    stub("worker.status", () => {
      throw new ValidationError("bad key sk-live-abcdef0123456789 and Authorization: Bearer abc.def.ghi and api_key=hunter22");
    });
    stub("worlds.list", () => {
      const e = new TypeError("boom at secret place");
      e.stack = "TypeError: boom\n    at handler (/Users/someone/secret.ts:1:1)";
      throw e;
    });
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    let resp;
    try {
      resp = await executeControlRead(req([{ id: "a", op: "worker.status" }, { id: "b", op: "worlds.list" }]));
    } finally {
      console.error = realError;
    }
    // The unexpected error is diagnosed on stderr, once, without its stack.
    expect(errors.length).toBe(1);
    const line = errors[0]!;
    expect(line).toContain("worlds.list failed: TypeError: boom");
    expect(line).not.toContain("    at ");
    expect(line).not.toContain("/Users/someone");
    const a = err(resp.results["a"]);
    expect(a.message).not.toContain("sk-live-abcdef0123456789");
    expect(a.message).not.toContain("abc.def.ghi");
    expect(a.message).not.toContain("hunter22");
    expect(a.message).toContain("[redacted]");
    const b = err(resp.results["b"]);
    expect(b.code).toBe("InternalError");
    expect(b.message).not.toContain("secret");
    expect(b.message).not.toContain("    at ");
  });

  test("an undefined value is reported as null, so the envelope still decodes", async () => {
    stub("worker.status", () => undefined);
    const resp = await executeControlRead(req([{ id: "a", op: "worker.status" }]));
    expect(resp.results["a"]).toEqual({ ok: true, value: null });
  });

  test("an unserialisable value is a per-read error", async () => {
    stub("worker.status", () => ({ n: 1n }));
    const resp = await executeControlRead(req([{ id: "a", op: "worker.status" }]));
    expect(err(resp.results["a"]).code).toBe("UnserializableResult");
  });

  test("a result that would push the envelope past 1048576 bytes becomes ResponseTooLarge", async () => {
    stub("logs.tail", () => "a".repeat(CONTROL_MAX_RESPONSE_BYTES + 1));
    stub("worker.status", () => ({ pending: 2 }));
    const resp = await executeControlRead(req([{ id: "big", op: "logs.tail", args: { name: "worker" } }, { id: "small", op: "worker.status" }]));
    expect(err(resp.results["big"]).code).toBe("ResponseTooLarge");
    expect(resp.results["small"]).toEqual({ ok: true, value: { pending: 2 } });
    expect(new TextEncoder().encode(encodeControlResponse(resp)).length).toBeLessThanOrEqual(CONTROL_MAX_RESPONSE_BYTES);
  });

  test("prototype-like read ids come back as own result keys", async () => {
    stub("worker.status", () => ({ pending: 1 }));
    stub("worlds.list", () => ["w"]);
    const resp = await executeControlRead(req([{ id: "__proto__", op: "worker.status" }, { id: "constructor", op: "worlds.list" }]));
    expect(Object.hasOwn(resp.results, "__proto__")).toBe(true);
    expect(Object.hasOwn(resp.results, "constructor")).toBe(true);
    expect(resp.results["__proto__"]).toEqual({ ok: true, value: { pending: 1 } });
    expect(resp.results["constructor"]).toEqual({ ok: true, value: ["w"] });
  });
});

describe("real handlers against the seeded fixture", () => {
  let fx: ControlFixture;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_CONFIG_DIR"];

  beforeEach(() => {
    // Real ops, not stubs, for this block.
    REGISTRY.clear();
    for (const [name, op] of snapshot) REGISTRY.set(name, op);
    fx = createControlFixture();
    for (const k of KEYS) {
      saved[k] = process.env[k];
      process.env[k] = fx.env[k]!;
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fx.cleanup();
  });

  test("worker.status decodes the seeded queue counts and last run", async () => {
    const resp = await executeControlRead(req([{ id: "w", op: "worker.status" }, { id: "l", op: "worlds.list" }]));
    const w = resp.results["w"]!;
    expect(w.ok).toBe(true);
    if (!w.ok) throw new Error("unreachable");
    const value = w.value as { pending: number; done: number; failed: number; last_run: string | null };
    expect({ pending: value.pending, done: value.done, failed: value.failed }).toEqual({ ...FIXTURE_QUEUE });
    expect(value.last_run).toBe(FIXTURE_LAST_RUN);
    const l = resp.results["l"]!;
    expect(l.ok && (l.value as { name: string }[]).map((x) => x.name)).toEqual(["fixture"]);
    expect(providerCalls).toBe(0);
  });
});

const enc = new TextEncoder();

describe("decodeControlRequestBytes (host only)", () => {
  const body = (note: string) => JSON.stringify(req([{ id: "a", op: "worker.status", args: { note } }]));

  test("decodes a UTF-8 request", () => {
    expect(decodeControlRequestBytes(enc.encode(body("é"))).reads[0]!.args).toEqual({ note: "é" });
  });

  test("rejects malformed UTF-8", () => {
    const good = enc.encode(body("XX"));
    const at = new TextDecoder().decode(good).indexOf("XX");
    const bad = good.slice();
    bad[at] = 0xc3;
    bad[at + 1] = 0x28;
    expect(() => decodeControlRequestBytes(bad)).toThrow(/UTF-8/);
    expect(() => decodeControlRequestBytes(bad)).toThrow(ControlProtocolError);
  });

  test("rejects invalid JSON", () => {
    expect(() => decodeControlRequestBytes(enc.encode("{nope"))).toThrow(ControlProtocolError);
  });

  test("limits UTF-8 bytes, not string length", () => {
    // Each "é" is one UTF-16 unit but two UTF-8 bytes.
    const room = CONTROL_MAX_REQUEST_BYTES - enc.encode(body("")).length;
    const atLimit = body("é".repeat(room / 2));
    expect(enc.encode(atLimit).length).toBe(CONTROL_MAX_REQUEST_BYTES);
    expect(() => decodeControlRequestBytes(enc.encode(atLimit))).not.toThrow();
    const over = body("é".repeat(room / 2) + "e");
    expect(enc.encode(over).length).toBe(CONTROL_MAX_REQUEST_BYTES + 1);
    expect(over.length).toBeLessThan(CONTROL_MAX_REQUEST_BYTES);
    expect(() => decodeControlRequestBytes(enc.encode(over))).toThrow(/too large/);
  });
});

describe("redactMessage", () => {
  const SECRET = "fixture-secret-value";

  test.each([
    ["plain assignment", `api_key=${SECRET}`],
    ["double-quoted assignment", `api_key="${SECRET}"`],
    ["single-quoted assignment", `api_key='${SECRET}'`],
    ["colon with spaces", `token : ${SECRET}`],
    ["JSON object", JSON.stringify({ api_key: SECRET })],
    ["JSON with spaces", '{ "client_secret" : "' + SECRET + '" }'],
    ["JSON nested in a string", JSON.stringify(JSON.stringify({ password: SECRET }))],
    ["env-style name", `LITELLM_API_KEY=${SECRET}`],
    ["quoted value with escaped quote", `api_key="${SECRET}\\"tail"`],
    ["bearer header", `Authorization: Bearer ${SECRET}`],
    ["sk token", `bad key sk-${SECRET}`],
  ])("%s hides the value", (_name, message) => {
    const out = redactMessage(`request failed: ${message}`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[redacted]");
    expect(out).toStartWith("request failed: ");
  });

  test.each([
    ["escaped quote inside a double-quoted value", 'password="fixture-prefix\\"fixture-tail"'],
    ["escaped quote inside a single-quoted value", "password='fixture-prefix\\'fixture-tail'"],
    ["JSON value holding a quote", JSON.stringify({ password: 'fixture-prefix"fixture-tail' })],
    ["JSON value holding a backslash then a quote", JSON.stringify({ password: 'fixture-prefix\\"fixture-tail' })],
    ["JSON nested in a string, value holding a quote", JSON.stringify(JSON.stringify({ api_key: 'fixture-prefix"fixture-tail' }))],
    ["escaped-quote context, inner escaped quote", 'api_key=\\"fixture-prefix\\\\\\"fixture-tail\\"'],
    ["unterminated quote", 'token="fixture-prefix fixture-tail'],
    ["doubled backslash before the closing quote", 'secret="fixture-prefix\\\\" fixture-tail'],
  ])("%s: neither the prefix nor the suffix survives", (name, message) => {
    const out = redactMessage(`error: ${message}`);
    expect(out).not.toContain("fixture-prefix");
    if (name !== "doubled backslash before the closing quote") expect(out).not.toContain("fixture-tail");
    expect(out).toContain("[redacted]");
  });

  test("a doubled backslash ends the quoted value, and what follows is ordinary text", () => {
    // `"a\\"` is a complete value ending in a literal backslash.
    expect(redactMessage('secret="fixture-prefix\\\\" then ok')).toBe("secret=[redacted] then ok");
  });

  test("a backslash at the input bound inside a quoted value masks to the end", () => {
    const head = `${"x".repeat(970)} password="fixture-prefix`;
    const message = head + "\\".repeat(1000 - head.length) + '"fixture-tail"';
    expect(message.slice(0, 1000).endsWith("\\")).toBe(true);
    const out = redactMessage(message);
    expect(out).not.toContain("fixture-prefix");
    expect(out).not.toContain("fixture-tail");
    expect(out).not.toContain("\\");
  });

  test("a leaked suffix cannot reach a real error envelope", async () => {
    stub("worker.status", () => {
      throw new ValidationError('password="fixture-prefix\\"fixture-tail"');
    });
    const resp = await executeControlRead(req([{ id: "a", op: "worker.status" }]));
    const text = JSON.stringify(resp);
    expect(err(resp.results["a"]).code).toBe("ValidationError");
    expect(text).not.toContain("fixture-prefix");
    expect(text).not.toContain("fixture-tail");
  });

  test("a quoted secret cut by the length bound is still hidden", () => {
    // The opening quote lands inside the bound, the closing one past it.
    const message = `${"x".repeat(990)} api_key="${SECRET}${"y".repeat(2000)}"`;
    const out = redactMessage(message);
    expect(out).not.toContain("fixture-secret");
    expect(out.length).toBeLessThanOrEqual(503);
  });

  test("a secret straddling the final 500 character cut leaves no prefix of it", () => {
    // Redacted, this is still over 500 characters, so the final cut applies.
    const message = `${"x".repeat(495)} api_key=${SECRET}`;
    const out = redactMessage(message);
    expect(out).not.toContain("fixture-s");
    expect(out.endsWith("...")).toBe(true);
  });

  test.each([
    "no world named fixture2",
    "max_tokens: 4000 exceeds the endpoint limit",
    "tokens: 12 used",
    'reflections.get: id "abc-1" not found',
  ])("keeps a useful message intact: %s", (message) => {
    expect(redactMessage(message)).toBe(message);
  });
});
