// The mutation wire between a console and `sil ops`. These tests pin the
// request envelope, the strict curation response decoder, the closed refusal
// set, and the receipt-only projections that must never hide a purge or turn
// an unknown outcome into a refusal.

import { describe, expect, test } from "bun:test";
import { CONTROL_MAX_RESPONSE_BYTES, ControlProtocolError } from "../src/control-protocol.ts";
import {
  CURATION_REFUSAL_CODES,
  MUTATION_MAX_REQUEST_BYTES,
  MutationOutcomeUnknown,
  MutationPurged,
  MutationRefused,
  OUTCOME_UNKNOWN_ERROR,
  classifyMutationFailure,
  controlEnvelopeKind,
  decodeCurationMutationResponse,
  decodeMutationResponse,
  encodeCurationMutationResponse,
  encodeMutationRequestEnvelope,
  mutationEnvelopeOf,
  mutationRequestOf,
  parseMutationRequestEnvelope,
  type CurationMutationResponse,
} from "../src/control-mutation.ts";

const RID = "lc_0b9e8f0a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const UUID = "8c4f2f9e-3b1a-4d6c-9e8f-7a6b5c4d3e2f";
const LOC = "a".repeat(64);
const HASH = "b".repeat(64);
const KEY = { world: "w", kind: "capture", id: UUID } as const;

function envelope(extra: Record<string, unknown> = {}, mutation: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    requestId: RID,
    mutation: { op: "lessons.edit", args: { v: 1 }, confirmed: false, ...mutation },
    ...extra,
  };
}

function committed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: RID,
    payloadHash: HASH,
    state: "completed",
    result: { key: KEY, revision: 2, changed: true },
    error: null,
    startedAt: "2026-10-23T10:00:00.000Z",
    finishedAt: "2026-10-23T10:00:00.010Z",
    ...overrides,
  };
}

function purged(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: RID,
    state: "purged",
    payloadHash: null,
    result: null,
    error: null,
    startedAt: "2026-10-23T10:00:00.000Z",
    finishedAt: "2026-10-23T10:00:00.010Z",
    ...overrides,
  };
}

const store = { locationId: LOC, installationId: UUID };

function success(receipt: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, requestId: RID, receipt, store, ...extra });
}

function failure(code: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, requestId: RID, error: { code, message: "m", retryable: false }, conflict: null, ...extra });
}

function protocolError(run: () => unknown): ControlProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof ControlProtocolError) return error;
    throw error;
  }
  throw new Error("expected a ControlProtocolError");
}

describe("parseMutationRequestEnvelope", () => {
  test("accepts the canonical envelope and rebuilds the outer request", () => {
    const env = parseMutationRequestEnvelope(envelope());
    expect(env.requestId).toBe(RID);
    expect(env.mutation.op).toBe("lessons.edit");
    const req = mutationRequestOf(env);
    expect(req).toEqual({ requestId: RID, op: "lessons.edit", args: { v: 1 }, confirmed: false });
    expect(mutationEnvelopeOf(req)).toEqual(env);
  });

  test("keeps an optional expectedState", () => {
    expect(parseMutationRequestEnvelope(envelope({}, { expectedState: "s" })).mutation.expectedState).toBe("s");
  });

  test("refuses a nested requestId in the wire mutation", () => {
    protocolError(() => parseMutationRequestEnvelope(envelope({}, { requestId: RID })));
  });

  test("refuses unknown, missing and prototype keys", () => {
    protocolError(() => parseMutationRequestEnvelope(envelope({ extra: 1 })));
    protocolError(() => parseMutationRequestEnvelope({ version: 1, requestId: RID }));
    protocolError(() => parseMutationRequestEnvelope(JSON.parse(`{"version":1,"requestId":"${RID}","mutation":{"op":"x","args":{},"confirmed":false},"__proto__":{}}`)));
    protocolError(() => parseMutationRequestEnvelope(envelope({}, { confirmed: "false" })));
    protocolError(() => parseMutationRequestEnvelope(envelope({ version: 2 })));
    protocolError(() => parseMutationRequestEnvelope(envelope({ requestId: "bad id" })));
  });
});

describe("encodeMutationRequestEnvelope", () => {
  test("encodes up to the whole-envelope limit and refuses one byte more, never clipping", () => {
    const base = JSON.stringify(parseMutationRequestEnvelope(envelope({}, { args: { pad: "" } }))).length;
    const fits = parseMutationRequestEnvelope(envelope({}, { args: { pad: "x".repeat(MUTATION_MAX_REQUEST_BYTES - base) } }));
    expect(new TextEncoder().encode(encodeMutationRequestEnvelope(fits)).length).toBe(MUTATION_MAX_REQUEST_BYTES);
    const over = parseMutationRequestEnvelope(envelope({}, { args: { pad: "x".repeat(MUTATION_MAX_REQUEST_BYTES - base + 1) } }));
    protocolError(() => encodeMutationRequestEnvelope(over));
  });

  test("counts UTF-8 bytes, not UTF-16 units", () => {
    expect(MUTATION_MAX_REQUEST_BYTES).toBe(16384);
    const base = JSON.stringify(parseMutationRequestEnvelope(envelope({}, { args: { pad: "" } }))).length;
    const units = Math.ceil((MUTATION_MAX_REQUEST_BYTES - base) / 3) + 1;
    const wide = parseMutationRequestEnvelope(envelope({}, { args: { pad: "€".repeat(units) } }));
    protocolError(() => encodeMutationRequestEnvelope(wide));
  });
});

describe("controlEnvelopeKind", () => {
  test("tells a read envelope from a mutation envelope by its complete key set", () => {
    expect(controlEnvelopeKind({ version: 1, requestId: "r", reads: [] })).toBe("read");
    expect(controlEnvelopeKind(envelope())).toBe("mutation");
  });

  test("refuses mixed, job and unknown envelopes", () => {
    protocolError(() => controlEnvelopeKind({ version: 1, requestId: "r", reads: [], mutation: {} }));
    protocolError(() => controlEnvelopeKind({ version: 1, requestId: "r", job: {} }));
    protocolError(() => controlEnvelopeKind({ version: 1, requestId: "r" }));
    protocolError(() => controlEnvelopeKind([]));
  });
});

describe("decodeCurationMutationResponse", () => {
  test("decodes a committed receipt with key, revision, changed and the executing store", () => {
    const r = decodeCurationMutationResponse(success(committed()), RID);
    if (!("receipt" in r)) throw new Error("expected success");
    expect(r.store).toEqual(store);
    expect(r.receipt.state).toBe("completed");
    if (r.receipt.state !== "completed") throw new Error("narrow");
    expect(r.receipt.result).toEqual({ key: KEY, revision: 2, changed: true });
  });

  test("decodes a purged receipt with its null hash, result and error", () => {
    const r = decodeCurationMutationResponse(success(purged()), RID);
    if (!("receipt" in r)) throw new Error("expected success");
    expect(r.receipt).toEqual(purged() as never);
    expect(r.store).toEqual(store);
  });

  test("refuses a completed receipt with a null hash", () => {
    protocolError(() => decodeCurationMutationResponse(success(committed({ payloadHash: null })), RID));
  });

  test("refuses purged business data in a purged receipt", () => {
    protocolError(() => decodeCurationMutationResponse(success(purged({ payloadHash: HASH })), RID));
    protocolError(() => decodeCurationMutationResponse(success(purged({ result: { key: KEY } })), RID));
    protocolError(() => decodeCurationMutationResponse(success(purged({ finishedAt: null })), RID));
  });

  test("accepts only completed or purged curation states", () => {
    for (const state of ["claimed", "running", "failed", "uncertain"]) {
      protocolError(() => decodeCurationMutationResponse(success(committed({ state })), RID));
    }
  });

  test("validates the committed result exactly", () => {
    protocolError(() => decodeCurationMutationResponse(success(committed({ result: { revision: 2, changed: true } })), RID));
    protocolError(() => decodeCurationMutationResponse(success(committed({ result: { key: KEY, revision: -1, changed: true } })), RID));
    protocolError(() => decodeCurationMutationResponse(success(committed({ result: { key: { ...KEY, id: "x" }, revision: 1, changed: true } })), RID));
    protocolError(() => decodeCurationMutationResponse(success(committed({ result: { key: KEY, revision: 1, changed: 1 } })), RID));
    protocolError(() => decodeCurationMutationResponse(success(committed({ error: { code: "x", message: "", retryable: false } })), RID));
    protocolError(() => decodeCurationMutationResponse(success(committed({ finishedAt: null })), RID));
  });

  test("binds every request id and the store strings", () => {
    const other = "lc_11111111-2222-4333-8444-555555555555";
    protocolError(() => decodeCurationMutationResponse(success(committed()), other));
    protocolError(() => decodeCurationMutationResponse(success(committed({ requestId: other })), RID));
    protocolError(() => decodeCurationMutationResponse(success(committed(), { store: { locationId: "x", installationId: UUID } }), RID));
    protocolError(() => decodeCurationMutationResponse(success(committed(), { store: { locationId: LOC, installationId: "nope" } }), RID));
    protocolError(() => decodeCurationMutationResponse(success(committed(), { store: { ...store, extra: 1 } }), RID));
  });

  test("keeps the success and failure arms exclusive", () => {
    protocolError(() => decodeCurationMutationResponse(success(committed(), { error: null }), RID));
    protocolError(() => decodeCurationMutationResponse(failure("PURGED", { store }), RID));
    protocolError(() => decodeCurationMutationResponse(failure("PURGED", { receipt: purged() }), RID));
    protocolError(() => decodeCurationMutationResponse(JSON.stringify({ version: 1, requestId: RID }), RID));
  });

  test("allows a conflict revision only with CURATION_CONFLICT and CAPTURE_EXISTS", () => {
    for (const code of ["CURATION_CONFLICT", "CAPTURE_EXISTS"]) {
      const r = decodeCurationMutationResponse(failure(code, { conflict: { revision: 3 } }), RID);
      if (!("error" in r)) throw new Error("expected failure");
      expect(r.conflict).toEqual({ revision: 3 });
    }
    protocolError(() => decodeCurationMutationResponse(failure("PURGED", { conflict: { revision: 3 } }), RID));
    protocolError(() => decodeCurationMutationResponse(failure("CURATION_CONFLICT", { conflict: { revision: 1.5 } }), RID));
  });

  test("decodes a refusal for a generic request id, but no generic success", () => {
    const text = JSON.stringify({ version: 1, requestId: "job-1", error: { code: "UNSUPPORTED_OPERATION", message: "m", retryable: false }, conflict: null });
    const r = decodeCurationMutationResponse(text, "job-1");
    expect("error" in r && r.error.code).toBe("UNSUPPORTED_OPERATION");
    let thrown: unknown;
    try {
      decodeMutationResponse(text, "job-1");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MutationRefused);
    const generic = JSON.stringify({ version: 1, requestId: "job-1", receipt: committed({ requestId: "job-1" }), store });
    protocolError(() => decodeCurationMutationResponse(generic, "job-1"));
  });

  test("refuses a request envelope echoed back as a response", () => {
    protocolError(() => decodeCurationMutationResponse(JSON.stringify(envelope()), RID));
  });

  test("keeps the parent response limit, not the request limit", () => {
    const big = "x".repeat(CONTROL_MAX_RESPONSE_BYTES);
    protocolError(() => decodeCurationMutationResponse(failure("PURGED", { error: { code: "PURGED", message: big, retryable: false } }), RID));
    const roomy = "y".repeat(20000);
    const r = decodeCurationMutationResponse(failure("PURGED", { error: { code: "PURGED", message: roomy, retryable: false } }), RID);
    expect("error" in r).toBe(true);
  });

  test("round-trips through the encoder", () => {
    const value = decodeCurationMutationResponse(success(committed()), RID);
    expect(decodeCurationMutationResponse(encodeCurationMutationResponse(value), RID)).toEqual(value);
  });
});

describe("outcome classification", () => {
  test("only the closed refusal codes are definite refusals", () => {
    expect([...CURATION_REFUSAL_CODES].sort()).toEqual(
      [
        "OpNotAllowed",
        "InvalidArgs",
        "UNSUPPORTED_OPERATION",
        "INVALID_INPUT",
        "SENSITIVE_CONTENT",
        "INSTALLATION_MISMATCH",
        "UNSUPPORTED_SCHEMA",
        "CURATION_CONFLICT",
        "CAPTURE_EXISTS",
        "SCOPE_CONFLICT",
        "SOURCE_CONFLICT",
        "PURGED",
        "STORAGE_BUSY",
      ].sort(),
    );
    for (const code of CURATION_REFUSAL_CODES) expect(classifyMutationFailure({ code, message: "", retryable: false })).toBe("refused");
  });

  test("unknown, ineligible and retryable errors never imply no effect", () => {
    for (const code of ["OUTCOME_UNKNOWN", "STORAGE_UNAVAILABLE", "InternalError", "SOMETHING_NEW", "constructor", "__proto__"]) {
      expect(classifyMutationFailure({ code, message: "", retryable: true })).toBe("unknown");
      expect(classifyMutationFailure({ code, message: "", retryable: false })).toBe("unknown");
    }
    expect(OUTCOME_UNKNOWN_ERROR).toEqual({ code: "OUTCOME_UNKNOWN", message: expect.any(String), retryable: false });
  });
});

describe("decodeMutationResponse (receipt-only projection)", () => {
  test("returns a completed receipt as an OperationReceipt", () => {
    const receipt = decodeMutationResponse(success(committed()), RID);
    expect(receipt).toEqual(committed() as never);
  });

  test("throws MutationPurged for a purged receipt instead of returning it", () => {
    let thrown: unknown;
    try {
      decodeMutationResponse(success(purged()), RID);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MutationPurged);
    expect((thrown as MutationPurged).receipt).toEqual(purged() as never);
  });

  test("throws MutationRefused only for a definite refusal", () => {
    let thrown: unknown;
    try {
      decodeMutationResponse(failure("CURATION_CONFLICT", { conflict: { revision: 4 } }), RID);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MutationRefused);
    expect((thrown as MutationRefused).conflict).toEqual({ revision: 4 });
  });

  test("throws MutationOutcomeUnknown for every other error, retryable or not", () => {
    for (const [code, retryable] of [["OUTCOME_UNKNOWN", false], ["STORAGE_UNAVAILABLE", true], ["NEW_CODE", true]] as const) {
      let thrown: unknown;
      try {
        decodeMutationResponse(JSON.stringify({ version: 1, requestId: RID, error: { code, message: "m", retryable }, conflict: null }), RID);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MutationOutcomeUnknown);
      expect(thrown).not.toBeInstanceOf(MutationRefused);
    }
  });

  test("a malformed response is a protocol error, never a receipt or refusal", () => {
    protocolError(() => decodeMutationResponse("not json", RID));
    protocolError(() => decodeMutationResponse(success(committed({ payloadHash: null })), RID));
  });

  test("the curation envelope keeps identity the projection drops", () => {
    const full: CurationMutationResponse = decodeCurationMutationResponse(success(committed()), RID);
    expect("store" in full && full.store).toEqual(store);
  });
});
