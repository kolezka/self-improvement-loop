// The control protocol is the only contract between the native console and
// `sil ops`. These tests pin the envelope shape, the byte limits and the
// refusal of anything that is not exactly one response for this request.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTROL_MAX_READS,
  CONTROL_MAX_RESPONSE_BYTES,
  ControlProtocolError,
  decodeControlResponse,
  encodeControlResponse,
  parseControlRequest,
  type ControlResponse,
} from "../src/control-protocol.ts";

const enc = new TextEncoder();

function request(reads: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, requestId: "r", reads, ...extra };
}

function reads(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({ id: `x${i}`, op: "worker.status", args: {} }));
}

function reply(requestId: string, results: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, requestId, results });
}

describe("parseControlRequest", () => {
  test("accepts a well formed request and keeps every read", () => {
    const parsed = parseControlRequest(request(reads(2)));
    expect(parsed.requestId).toBe("r");
    expect(parsed.reads.map((r) => r.id)).toEqual(["x0", "x1"]);
  });

  test("accepts exactly CONTROL_MAX_READS reads", () => {
    expect(parseControlRequest(request(reads(CONTROL_MAX_READS))).reads.length).toBe(8);
  });

  test.each([
    ["zero reads", request([])],
    ["nine reads", request(reads(9))],
    ["unknown version", { ...request(reads(1)), version: 2 }],
    ["missing version", { requestId: "r", reads: reads(1) }],
    ["bad request id", { ...request(reads(1)), requestId: "a b" }],
    ["extra top level key", request(reads(1), { extra: true })],
    ["reads not an array", { ...request([]), reads: {} }],
    ["args an array", request([{ id: "a", op: "worker.status", args: [] }])],
    ["args null", request([{ id: "a", op: "worker.status", args: null }])],
    ["missing args", request([{ id: "a", op: "worker.status" }])],
    ["extra read key", request([{ id: "a", op: "worker.status", args: {}, x: 1 }])],
    ["bad read id", request([{ id: "a/b", op: "worker.status", args: {} }])],
    ["op not a string", request([{ id: "a", op: 7, args: {} }])],
    ["duplicate ids", request([{ id: "a", op: "worker.status", args: {} }, { id: "a", op: "worker.status", args: {} }])],
    ["an array", [request(reads(1))]],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(() => parseControlRequest(value)).toThrow(ControlProtocolError);
  });

  test.each(["bogus", "", "worker status", "__proto__", "constructor", "WORKER.STATUS", "é.ü", "x".repeat(5000)])(
    "an op is an opaque string, so case %# is structurally valid (the host allowlist decides)",
    (op) => {
      expect(parseControlRequest(request([{ id: "a", op, args: {} }])).reads[0]!.op).toBe(op);
    },
  );

  test("prototype-like read ids are plain ids, and duplicates of them are still caught", () => {
    const parsed = parseControlRequest(
      request([
        { id: "__proto__", op: "worker.status", args: {} },
        { id: "constructor", op: "worker.status", args: {} },
      ]),
    );
    expect(parsed.reads.map((r) => r.id)).toEqual(["__proto__", "constructor"]);
    const dup = JSON.parse('{"version":1,"requestId":"r","reads":[{"id":"__proto__","op":"worker.status","args":{}},{"id":"__proto__","op":"worker.status","args":{}}]}');
    expect(() => parseControlRequest(dup)).toThrow(/duplicate/);
  });

  test("a __proto__ key in the envelope is an unknown key, not a prototype swap", () => {
    const value = JSON.parse('{"version":1,"requestId":"r","reads":[{"id":"a","op":"worker.status","args":{}}],"__proto__":{"admin":true}}');
    expect(() => parseControlRequest(value)).toThrow(ControlProtocolError);
  });
});

describe("decodeControlResponse", () => {
  const ok = { x: { ok: true, value: { pending: 2 } } };

  test("decodes a response for this request", () => {
    const decoded = decodeControlResponse(reply("r", ok), "r");
    const x = decoded.results["x"]!;
    expect(x.ok).toBe(true);
    if (x.ok) expect(x.value).toEqual({ pending: 2 });
  });

  test("decodes an error result", () => {
    const decoded = decodeControlResponse(reply("r", { x: { ok: false, error: { code: "OpNotAllowed", message: "no", retryable: false } } }), "r");
    expect(decoded.results["x"]).toEqual({ ok: false, error: { code: "OpNotAllowed", message: "no", retryable: false } });
  });

  test("rejects an empty object", () => {
    expect(() => decodeControlResponse("{}", "r")).toThrow();
  });

  test("rejects a valid reply for another request", () => {
    const validReplyForOtherRequest = reply("other", ok);
    expect(() => decodeControlResponse(validReplyForOtherRequest, "other")).not.toThrow();
    expect(() => decodeControlResponse(validReplyForOtherRequest, "r")).toThrow();
  });

  test.each([
    ["invalid JSON", '{"version":1,'],
    ["two envelopes", reply("r", ok) + "\n" + reply("r", ok)],
    ["unknown version", JSON.stringify({ version: 2, requestId: "r", results: ok })],
    ["results an array", JSON.stringify({ version: 1, requestId: "r", results: [] })],
    ["result missing value", reply("r", { x: { ok: true } })],
    ["ok not boolean", reply("r", { x: { ok: "yes", value: 1 } })],
    ["error missing retryable", reply("r", { x: { ok: false, error: { code: "a", message: "b" } } })],
    ["error with both value and error", reply("r", { x: { ok: false, value: 1, error: { code: "a", message: "b", retryable: false } } })],
    ["bad result id", reply("r", { "a b": { ok: true, value: 1 } })],
    ["extra envelope key", JSON.stringify({ version: 1, requestId: "r", results: ok, extra: 1 })],
    ["too many results", reply("r", Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`x${i}`, { ok: true, value: i }])))],
  ])("rejects %s", (_name, text) => {
    expect(() => decodeControlResponse(text, "r")).toThrow();
  });

  test("rejects a response over CONTROL_MAX_RESPONSE_BYTES", () => {
    const shell = reply("r", { x: { ok: true, value: "" } });
    const fill = "a".repeat(CONTROL_MAX_RESPONSE_BYTES - enc.encode(shell).length);
    const atLimit = reply("r", { x: { ok: true, value: fill } });
    expect(enc.encode(atLimit).length).toBe(CONTROL_MAX_RESPONSE_BYTES);
    expect(() => decodeControlResponse(atLimit, "r")).not.toThrow();
    const over = reply("r", { x: { ok: true, value: fill + "a" } });
    expect(enc.encode(over).length).toBe(CONTROL_MAX_RESPONSE_BYTES + 1);
    expect(() => decodeControlResponse(over, "r")).toThrow(/too large/);
  });

  test("prototype-like result ids decode as own keys without touching the prototype", () => {
    const text = '{"version":1,"requestId":"r","results":{"__proto__":{"ok":true,"value":1},"constructor":{"ok":true,"value":2}}}';
    const decoded = decodeControlResponse(text, "r");
    expect(Object.hasOwn(decoded.results, "__proto__")).toBe(true);
    expect(Object.hasOwn(decoded.results, "constructor")).toBe(true);
    expect(decoded.results["__proto__"]).toEqual({ ok: true, value: 1 });
    expect(Object.getPrototypeOf(decoded.results)).not.toEqual({ ok: true, value: 1 });
    expect(({} as Record<string, unknown>)["ok"]).toBeUndefined();
  });
});

describe("encodeControlResponse", () => {
  test("round-trips through decodeControlResponse", () => {
    const resp: ControlResponse = { version: 1, requestId: "r", results: { x: { ok: true, value: [1, "é"] } } };
    expect(decodeControlResponse(encodeControlResponse(resp), "r")).toEqual(resp);
  });

  test("refuses to produce more than CONTROL_MAX_RESPONSE_BYTES", () => {
    const resp: ControlResponse = { version: 1, requestId: "r", results: { x: { ok: true, value: "a".repeat(CONTROL_MAX_RESPONSE_BYTES) } } };
    expect(() => encodeControlResponse(resp)).toThrow(/too large/);
  });
});

describe("control-protocol stays pure", () => {
  test("has no imports and names no Node, process or Bun API", () => {
    const text = readFileSync(join(import.meta.dir, "../src/control-protocol.ts"), "utf8");
    // Positive control: the reader sees real source.
    expect(text).toContain("decodeControlResponse");
    // A two-argument TextDecoder (strict UTF-8) is host only: the sandbox's
    // declared TextDecoder takes at most one argument.
    const offenders = [/^\s*import\s/m, /\brequire\(/, /process\./, /\bBun\./, /from\s+["']node:/, /TextDecoder\([^)]*,/].filter((re) => re.test(text));
    expect(offenders.map(String)).toEqual([]);
  });
});
