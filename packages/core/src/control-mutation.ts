// Wire contract for one bounded mutation between a console and `sil ops`.
// Pure on purpose (no zod, no Node, no Bun) so the native console can load it.
// The read protocol in control-protocol.ts stays byte for byte the parent's.

import {
  CONTROL_ID_RE,
  CONTROL_MAX_RESPONSE_BYTES,
  ControlProtocolError,
  utf8ByteLength,
  type ControlError,
} from "./control-protocol.ts";
import { CURATION_REQUEST_ID_RE, MAX_MUTATION_BYTES, SHA256_HEX_RE, UUID_RE, lessonKeyProblems, type LessonKey } from "./lesson-curation.ts";

export type MutationRequest = {
  requestId: string;
  op: string;
  args: Record<string, unknown>;
  expectedState?: string;
  confirmed: boolean;
};
export type MutationRequestEnvelope = {
  version: 1;
  requestId: string;
  mutation: Omit<MutationRequest, "requestId">;
};
// Generic contract, exactly as the parent planned it.
export type OperationReceipt = {
  requestId: string;
  payloadHash: string;
  state: "claimed" | "running" | "completed" | "failed" | "uncertain";
  result: unknown | null;
  error: ControlError | null;
  startedAt: string;
  finishedAt: string | null;
};
export type OperationEffects = {
  scope: "installation" | "world";
  model: boolean;
  remote: boolean;
  confirmation: "none" | "reviewed-state" | "explicit";
};
export type ExecutingStore = { locationId: string; installationId: string };
export type CurationCommittedOperationReceipt = {
  requestId: string;
  payloadHash: string;
  state: "completed";
  result: { key: LessonKey; revision: number; changed: boolean };
  error: null;
  startedAt: string;
  finishedAt: string;
};
export type CurationPurgedReceipt = {
  requestId: string;
  state: "purged";
  payloadHash: null;
  result: null;
  error: null;
  startedAt: string;
  finishedAt: string;
};
export type CurationTransportReceipt = CurationCommittedOperationReceipt | CurationPurgedReceipt;
export type CurationMutationSuccess = {
  version: 1;
  requestId: string;
  receipt: CurationTransportReceipt;
  store: ExecutingStore;
};
export type CurationMutationFailure = {
  version: 1;
  requestId: string;
  error: ControlError;
  /** Refetch hint only, never authority to rebase or write. */
  conflict: { revision: number } | null;
};
export type CurationMutationResponse = CurationMutationSuccess | CurationMutationFailure;

/** Whole request envelope, UTF-8 bytes. */
export const MUTATION_MAX_REQUEST_BYTES = MAX_MUTATION_BYTES;

/** Codes the host emits only when it can prove the mutation did not commit. */
export const CURATION_REFUSAL_CODES: ReadonlySet<string> = new Set([
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
]);
const CONFLICT_CODES = new Set(["CURATION_CONFLICT", "CAPTURE_EXISTS"]);

export const OUTCOME_UNKNOWN_ERROR: ControlError = Object.freeze({
  code: "OUTCOME_UNKNOWN",
  message: "mutation outcome unknown: look up its receipt by request id",
  retryable: false,
});

/** The host proved the mutation did not commit. */
export class MutationRefused extends Error {
  override name = "MutationRefused";
  constructor(
    readonly error: ControlError,
    readonly conflict: { revision: number } | null,
  ) {
    super(`mutation refused: ${error.code}`);
  }
}
/** The mutation may or may not have committed. Reconcile by request id; never retry blindly. */
export class MutationOutcomeUnknown extends Error {
  override name = "MutationOutcomeUnknown";
  constructor(readonly error: ControlError | null) {
    super("mutation outcome unknown");
  }
}
/** The request is purged. A generic receipt cannot represent that. */
export class MutationPurged extends Error {
  override name = "MutationPurged";
  constructor(readonly receipt: CurationPurgedReceipt) {
    super("mutation target was purged");
  }
}

function fail(message: string): never {
  throw new ControlProtocolError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) fail(`${where}: unexpected key`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${where}: missing ${key}`);
}

function sameKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${where}: invalid JSON`);
  }
}

/** Validate an already parsed mutation request envelope. Throws ControlProtocolError. */
export function parseMutationRequestEnvelope(value: unknown): MutationRequestEnvelope {
  if (!isPlainObject(value)) fail("request: must be a JSON object");
  exactKeys(value, ["version", "requestId", "mutation"], [], "request");
  if (value["version"] !== 1) fail("request: unsupported version");
  const requestId = value["requestId"];
  if (typeof requestId !== "string" || !CONTROL_ID_RE.test(requestId)) fail("request: invalid requestId");
  const m = value["mutation"];
  if (!isPlainObject(m)) fail("mutation: must be an object");
  exactKeys(m, ["op", "args", "confirmed"], ["expectedState"], "mutation");
  const { op, args, confirmed } = m as { op: unknown; args: unknown; confirmed: unknown };
  if (typeof op !== "string") fail("mutation: op must be a string");
  if (!isPlainObject(args)) fail("mutation: args must be an object");
  if (typeof confirmed !== "boolean") fail("mutation: confirmed must be a boolean");
  const mutation: Omit<MutationRequest, "requestId"> = { op, args, confirmed };
  if (Object.hasOwn(m, "expectedState")) {
    const expectedState = m["expectedState"];
    if (typeof expectedState !== "string") fail("mutation: expectedState must be a string");
    mutation.expectedState = expectedState;
  }
  return { version: 1, requestId, mutation };
}

/** The outer request the envelope carries. Its id is the envelope's id. */
export function mutationRequestOf(envelope: MutationRequestEnvelope): MutationRequest {
  return { requestId: envelope.requestId, ...envelope.mutation };
}

export function mutationEnvelopeOf(request: MutationRequest): MutationRequestEnvelope {
  const { requestId, ...mutation } = request;
  return { version: 1, requestId, mutation };
}

/** Serialise a request. Throws rather than send an oversize envelope. */
export function encodeMutationRequestEnvelope(envelope: MutationRequestEnvelope): string {
  const text = JSON.stringify(parseMutationRequestEnvelope(envelope));
  if (utf8ByteLength(text) > MUTATION_MAX_REQUEST_BYTES) fail(`request: too large (over ${MUTATION_MAX_REQUEST_BYTES} bytes)`);
  return text;
}

/** Which complete envelope this is. Mixed, job or partial shapes are refused. */
export function controlEnvelopeKind(value: unknown): "read" | "mutation" {
  if (!isPlainObject(value)) fail("request: must be a JSON object");
  if (sameKeys(value, ["version", "requestId", "reads"])) return "read";
  if (sameKeys(value, ["version", "requestId", "mutation"])) return "mutation";
  return fail("request: not a read or mutation envelope");
}

/** Definite refusal only for the closed set. Everything else may have committed. */
export function classifyMutationFailure(error: ControlError): "refused" | "unknown" {
  return typeof error.code === "string" && CURATION_REFUSAL_CODES.has(error.code) ? "refused" : "unknown";
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeKey(value: unknown, where: string): LessonKey {
  if (!isPlainObject(value)) fail(`${where}: must be an object`);
  exactKeys(value, ["world", "kind", "id"], [], where);
  const key = { world: value["world"], kind: value["kind"], id: value["id"] } as LessonKey;
  if (lessonKeyProblems(key).length > 0) fail(`${where}: invalid key`);
  return key;
}

function decodeReceipt(value: unknown, requestId: string): CurationTransportReceipt {
  const where = "receipt";
  if (!isPlainObject(value)) fail(`${where}: must be an object`);
  exactKeys(value, ["requestId", "payloadHash", "state", "result", "error", "startedAt", "finishedAt"], [], where);
  if (value["requestId"] !== requestId) fail(`${where}: requestId does not match`);
  const { startedAt, finishedAt } = value;
  if (!isTimestamp(startedAt) || !isTimestamp(finishedAt)) fail(`${where}: invalid timestamps`);
  if (value["error"] !== null) fail(`${where}: error must be null`);
  if (value["state"] === "purged") {
    if (value["payloadHash"] !== null || value["result"] !== null) fail(`${where}: a purged receipt carries no data`);
    return { requestId, state: "purged", payloadHash: null, result: null, error: null, startedAt, finishedAt };
  }
  if (value["state"] !== "completed") fail(`${where}: unsupported curation state`);
  const payloadHash = value["payloadHash"];
  if (typeof payloadHash !== "string" || !SHA256_HEX_RE.test(payloadHash)) fail(`${where}: invalid payloadHash`);
  const result = value["result"];
  if (!isPlainObject(result)) fail(`${where}: result must be an object`);
  exactKeys(result, ["key", "revision", "changed"], [], `${where}.result`);
  const key = decodeKey(result["key"], `${where}.result.key`);
  const revision = result["revision"];
  const changed = result["changed"];
  if (!isRevision(revision)) fail(`${where}: invalid revision`);
  if (typeof changed !== "boolean") fail(`${where}: invalid changed`);
  return { requestId, payloadHash, state: "completed", result: { key, revision, changed }, error: null, startedAt, finishedAt };
}

function decodeError(value: unknown): ControlError {
  if (!isPlainObject(value)) fail("error: must be an object");
  exactKeys(value, ["code", "message", "retryable"], [], "error");
  const { code, message, retryable } = value as { code: unknown; message: unknown; retryable: unknown };
  if (typeof code !== "string" || code.length === 0 || code.length > 64) fail("error: invalid code");
  if (typeof message !== "string") fail("error: invalid message");
  if (typeof retryable !== "boolean") fail("error: invalid retryable");
  return { code, message, retryable };
}

/** Strict decode of one curation mutation response, bound to its request id. */
export function decodeCurationMutationResponse(text: string, requestId: string): CurationMutationResponse {
  if (utf8ByteLength(text) > CONTROL_MAX_RESPONSE_BYTES) fail(`response: too large (over ${CONTROL_MAX_RESPONSE_BYTES} bytes)`);
  if (!CONTROL_ID_RE.test(requestId)) fail("response: invalid request id");
  const value = parseJson(text, "response");
  if (!isPlainObject(value)) fail("response: must be a JSON object");
  const isSuccess = sameKeys(value, ["version", "requestId", "receipt", "store"]);
  const isFailure = sameKeys(value, ["version", "requestId", "error", "conflict"]);
  if (!isSuccess && !isFailure) fail("response: not a success or failure envelope");
  if (value["version"] !== 1) fail("response: unsupported version");
  if (value["requestId"] !== requestId) fail("response: requestId does not match the request");

  if (isSuccess) {
    // Only curation executes at this milestone, so only an lc_ request can succeed.
    if (!CURATION_REQUEST_ID_RE.test(requestId)) fail("response: success for a non-curation request");
    const receipt = decodeReceipt(value["receipt"], requestId);
    const raw = value["store"];
    if (!isPlainObject(raw)) fail("store: must be an object");
    exactKeys(raw, ["locationId", "installationId"], [], "store");
    const { locationId, installationId } = raw;
    if (typeof locationId !== "string" || !SHA256_HEX_RE.test(locationId)) fail("store: invalid locationId");
    if (typeof installationId !== "string" || !UUID_RE.test(installationId)) fail("store: invalid installationId");
    return { version: 1, requestId, receipt, store: { locationId, installationId } };
  }

  const error = decodeError(value["error"]);
  const conflictRaw = value["conflict"];
  let conflict: { revision: number } | null = null;
  if (conflictRaw !== null) {
    if (!CONFLICT_CODES.has(error.code)) fail("response: conflict only with a revision conflict");
    if (!isPlainObject(conflictRaw)) fail("conflict: must be an object");
    exactKeys(conflictRaw, ["revision"], [], "conflict");
    if (!isRevision(conflictRaw["revision"])) fail("conflict: invalid revision");
    conflict = { revision: conflictRaw["revision"] };
  }
  return { version: 1, requestId, error, conflict };
}

/** Serialise a curation response. Throws rather than emit an oversize envelope. */
export function encodeCurationMutationResponse(response: CurationMutationResponse): string {
  const text = JSON.stringify(response);
  if (utf8ByteLength(text) > CONTROL_MAX_RESPONSE_BYTES) fail(`response: too large (over ${CONTROL_MAX_RESPONSE_BYTES} bytes)`);
  return text;
}

/** Receipt-only view of a curation response. Purge, refusal and unknown each throw their own type. */
export function projectMutationResponse(response: CurationMutationResponse): OperationReceipt {
  if ("error" in response) {
    if (classifyMutationFailure(response.error) === "refused") throw new MutationRefused(response.error, response.conflict);
    throw new MutationOutcomeUnknown(response.error);
  }
  if (response.receipt.state === "purged") throw new MutationPurged(response.receipt);
  return response.receipt;
}

/** Generic-compatible projection of the strict curation decoder. */
export function decodeMutationResponse(text: string, requestId: string): OperationReceipt {
  return projectMutationResponse(decodeCurationMutationResponse(text, requestId));
}
