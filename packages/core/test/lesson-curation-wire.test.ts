// The curation request adapter (pure, client side) and its host parser. The
// prepared domain payload must cross unchanged, the outer purge confirmation
// must be proven rather than inferred, and the host must refuse every shape
// the adapter would never emit.

import { describe, expect, test } from "bun:test";
import { ControlProtocolError } from "../src/control-protocol.ts";
import { mutationRequestOf, parseMutationRequestEnvelope } from "../src/control-mutation.ts";
import { CurationError, type CurationChange, type CurationMutation, type CurationPrecondition } from "../src/lesson-curation.ts";
import { CURATION_MUTATION_OPS, encodeCurationMutationRequest, toCurationMutationEnvelope } from "../src/lesson-curation-wire.ts";
import { parseCurationMutationArgs } from "../src/lesson-curation-schema.ts";

const RID = "lc_0b9e8f0a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const INSTALL = "8c4f2f9e-3b1a-4d6c-9e8f-7a6b5c4d3e2f";
const CAPTURE_ID = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";
const LOC = "a".repeat(64);
const PROJECT = `p1_${"c".repeat(64)}`;

function change(kind: CurationChange["kind"]): CurationChange {
  switch (kind) {
    case "capture":
      return {
        kind,
        text: "Prefer rg.",
        source: { kind: "explicit_quote", quote: "use rg", reference: null, quoteRedacted: false, captureSessionId: null, sourceConversationId: null, sourceRowId: null, sourceAgentId: null },
      };
    case "edit":
      return { kind, text: "Prefer rg over grep." };
    case "important":
      return { kind, value: true };
    case "acknowledge-source":
      return { kind, digest: "d".repeat(64) };
    case "purge":
      return { kind, confirmed: true };
  }
}

function mutation(kind: CurationChange["kind"], extra: Partial<CurationMutation> = {}): CurationMutation {
  return {
    requestId: RID,
    binding: { kind: "installation", id: INSTALL },
    scope: { world: "w", project: { kind: "world" } },
    key: kind === "capture" || kind === "edit" ? { world: "w", kind: "capture", id: CAPTURE_ID } : { world: "w", kind: "inbox", id: "legacy-1" },
    expectedRevision: kind === "capture" ? 0 : 1,
    change: change(kind),
    ...extra,
  };
}

const installed: CurationPrecondition = { kind: "installation", id: INSTALL };

function invalid(run: () => unknown): CurationError {
  try {
    run();
  } catch (error) {
    if (error instanceof CurationError) return error;
    throw error;
  }
  throw new Error("expected a CurationError");
}

describe("toCurationMutationEnvelope", () => {
  test("maps every change kind to its op and carries one request id", () => {
    const expected: Record<string, string> = {
      capture: "lessons.capture",
      edit: "lessons.edit",
      important: "lessons.setImportant",
      "acknowledge-source": "lessons.acknowledgeSource",
      purge: "lessons.purge",
    };
    for (const kind of Object.keys(expected) as CurationChange["kind"][]) {
      const env = toCurationMutationEnvelope({ mutation: mutation(kind), precondition: installed }, null);
      expect(env.mutation.op).toBe(expected[kind]!);
      expect(env.requestId).toBe(RID);
      expect(Object.hasOwn(env.mutation, "requestId")).toBe(false);
      expect(Object.hasOwn(env.mutation, "expectedState")).toBe(false);
      expect(CURATION_MUTATION_OPS[env.mutation.op as keyof typeof CURATION_MUTATION_OPS]).toBe(kind);
    }
  });

  test("leaves the prepared domain payload byte for byte, including a historical location binding", () => {
    const prepared = { mutation: mutation("edit", { binding: { kind: "location", id: LOC } }), precondition: installed };
    const before = JSON.stringify(prepared.mutation);
    const env = toCurationMutationEnvelope(prepared, null);
    expect(JSON.stringify(env.mutation.args["mutation"])).toBe(before);
    expect(env.mutation.args).toEqual({ v: 1, mutation: prepared.mutation, precondition: installed, projectRoot: null });
    expect(JSON.stringify(prepared.mutation)).toBe(before);
  });

  test("sets the outer confirmation only for a confirmed purge", () => {
    expect(toCurationMutationEnvelope({ mutation: mutation("purge"), precondition: installed }, null).mutation.confirmed).toBe(true);
    expect(toCurationMutationEnvelope({ mutation: mutation("important"), precondition: installed }, null).mutation.confirmed).toBe(false);
    const malformed = mutation("purge", { change: { kind: "purge", confirmed: false } as unknown as CurationChange });
    expect(invalid(() => toCurationMutationEnvelope({ mutation: malformed, precondition: installed }, null)).code).toBe("INVALID_INPUT");
    const missing = mutation("purge", { change: { kind: "purge" } as unknown as CurationChange });
    expect(invalid(() => toCurationMutationEnvelope({ mutation: missing, precondition: installed }, null)).code).toBe("INVALID_INPUT");
  });

  test("takes projectRoot only from a matching descriptor for a project capture", () => {
    const scope = { world: "w", project: { kind: "project" as const, id: PROJECT } };
    const m = mutation("capture", { scope });
    const env = toCurationMutationEnvelope({ mutation: m, precondition: installed }, { world: "w", projectId: PROJECT, root: "/repo" });
    expect(env.mutation.args["projectRoot"]).toBe("/repo");
    expect(invalid(() => toCurationMutationEnvelope({ mutation: m, precondition: installed }, null)).code).toBe("INVALID_INPUT");
    const other = { world: "w", projectId: `p1_${"e".repeat(64)}`, root: "/repo" };
    expect(invalid(() => toCurationMutationEnvelope({ mutation: m, precondition: installed }, other)).code).toBe("INVALID_INPUT");
    const descriptor = { world: "w", projectId: PROJECT, root: "/repo" };
    expect(invalid(() => toCurationMutationEnvelope({ mutation: mutation("edit"), precondition: installed }, descriptor)).code).toBe("INVALID_INPUT");
  });

  test("refuses a malformed precondition or request id", () => {
    const bad = { kind: "installation", id: "nope" } as CurationPrecondition;
    expect(invalid(() => toCurationMutationEnvelope({ mutation: mutation("edit"), precondition: bad }, null)).code).toBe("INVALID_INPUT");
    expect(invalid(() => toCurationMutationEnvelope({ mutation: mutation("edit", { requestId: "r1" }), precondition: installed }, null)).code).toBe("INVALID_INPUT");
  });

  test("the encoder refuses an envelope over the whole-request limit", () => {
    const big = mutation("edit", { change: { kind: "edit", text: "x".repeat(16384) } });
    expect(() => encodeCurationMutationRequest({ mutation: big, precondition: installed }, null)).toThrow(ControlProtocolError);
    const text = encodeCurationMutationRequest({ mutation: mutation("edit"), precondition: installed }, null);
    expect(mutationRequestOf(parseMutationRequestEnvelope(JSON.parse(text))).requestId).toBe(RID);
  });
});

describe("parseCurationMutationArgs", () => {
  const args = (m: CurationMutation, precondition: unknown = installed, projectRoot: unknown = null) => ({ v: 1, mutation: m, precondition, projectRoot });

  test("accepts what the adapter emits", () => {
    for (const kind of ["capture", "edit", "important", "acknowledge-source", "purge"] as const) {
      const env = toCurationMutationEnvelope({ mutation: mutation(kind), precondition: installed }, null);
      expect(parseCurationMutationArgs(env.mutation.args).mutation).toEqual(mutation(kind));
    }
  });

  test("accepts a pinned retry: location binding under an installation precondition", () => {
    const m = mutation("edit", { binding: { kind: "location", id: LOC } });
    expect(parseCurationMutationArgs(args(m)).precondition).toEqual(installed);
  });

  test("accepts an uninitialized precondition only for the same location binding", () => {
    const m = mutation("capture", { binding: { kind: "location", id: LOC } });
    expect(parseCurationMutationArgs(args(m, { kind: "uninitialized", locationId: LOC })).precondition.kind).toBe("uninitialized");
    expect(invalid(() => parseCurationMutationArgs(args(m, { kind: "uninitialized", locationId: "b".repeat(64) }))).code).toBe("INVALID_INPUT");
    expect(invalid(() => parseCurationMutationArgs(args(mutation("capture"), { kind: "uninitialized", locationId: LOC }))).code).toBe("INVALID_INPUT");
  });

  test("refuses an installation binding that disagrees with its precondition", () => {
    const other = { kind: "installation", id: "11111111-2222-4333-8444-555555555555" };
    expect(invalid(() => parseCurationMutationArgs(args(mutation("edit"), other))).code).toBe("INVALID_INPUT");
  });

  test("refuses unknown, missing and prototype keys and a wrong version", () => {
    expect(invalid(() => parseCurationMutationArgs({ ...args(mutation("edit")), extra: 1 })).code).toBe("INVALID_INPUT");
    expect(invalid(() => parseCurationMutationArgs({ v: 1, mutation: mutation("edit"), precondition: installed })).code).toBe("INVALID_INPUT");
    expect(invalid(() => parseCurationMutationArgs({ ...args(mutation("edit")), v: 2 })).code).toBe("INVALID_INPUT");
    const proto = JSON.parse(`{"v":1,"mutation":${JSON.stringify(mutation("edit"))},"precondition":${JSON.stringify(installed)},"projectRoot":null,"__proto__":{"x":1}}`);
    expect(invalid(() => parseCurationMutationArgs(proto)).code).toBe("INVALID_INPUT");
    expect(invalid(() => parseCurationMutationArgs(args(mutation("edit"), { ...installed, extra: 1 }))).code).toBe("INVALID_INPUT");
  });

  test("requires projectRoot exactly for a project capture", () => {
    const scope = { world: "w", project: { kind: "project" as const, id: PROJECT } };
    expect(parseCurationMutationArgs(args(mutation("capture", { scope }), installed, "/repo")).projectRoot).toBe("/repo");
    expect(invalid(() => parseCurationMutationArgs(args(mutation("capture", { scope }), installed, null))).code).toBe("INVALID_INPUT");
    expect(invalid(() => parseCurationMutationArgs(args(mutation("capture", { scope }), installed, "relative"))).code).toBe("INVALID_INPUT");
    expect(invalid(() => parseCurationMutationArgs(args(mutation("edit"), installed, "/repo"))).code).toBe("INVALID_INPUT");
  });

  test("keeps the domain parser's own refusals", () => {
    const secret = mutation("edit", { change: { kind: "edit", text: "token: sk-abcdefghijklmnop1234" } });
    expect(invalid(() => parseCurationMutationArgs(args(secret))).code).toBe("SENSITIVE_CONTENT");
  });
});
