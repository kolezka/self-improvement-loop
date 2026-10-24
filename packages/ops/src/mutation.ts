// The one mutation dispatcher behind `sil ops` and the HTTP API. Every common
// gate (shape, op, namespace, effects, args, op/change agreement,
// confirmation, request id, world) runs before an owner is chosen. Only the
// curation family has an owner at this milestone; generic mutations and jobs
// are refused, and nothing here persists a generic receipt.
//
// Imports the registry, not index.ts; the caller loads index.ts for its
// registration side effects.

import { loadConfig } from "@sil/core";
import { ControlProtocolError, utf8ByteLength, type ControlError } from "@sil/core/control-protocol";
import {
  CURATION_REFUSAL_CODES,
  MUTATION_MAX_REQUEST_BYTES,
  OUTCOME_UNKNOWN_ERROR,
  mutationEnvelopeOf,
  parseMutationRequestEnvelope,
  projectMutationResponse,
  type CurationMutationFailure,
  type CurationMutationResponse,
  type MutationRequest,
  type MutationRequestEnvelope,
  type OperationReceipt,
} from "@sil/core/control-mutation";
import { CURATION_REQUEST_ID_RE, CurationError } from "@sil/core/lesson-curation";
import { CURATION_MUTATION_OPS, type CurationMutationArgs, type CurationMutationOp } from "@sil/core/lesson-curation-wire";
import { parseCurationMutationArgs } from "@sil/core/lesson-curation-schema";
import { CurationConflictError } from "@sil/store";
import { redactMessage } from "./control.ts";
import { OPERATION_EFFECTS } from "./effects.ts";
import { executeCurationMutation, type CurationOwnerResult } from "./handlers/lessons.ts";
import { REGISTRY } from "./registry.ts";

export type { CurationOwnerResult } from "./handlers/lessons.ts";

export interface MutationOwner {
  execute(requestId: string, args: CurationMutationArgs): Promise<CurationOwnerResult>;
}
/** `generic` exists only so a test can prove it is never selected. */
export interface MutationOwners {
  curation: MutationOwner;
  generic?: MutationOwner;
}

export const MUTATION_OWNERS: MutationOwners = Object.freeze({ curation: Object.freeze({ execute: executeCurationMutation }) });

/** Decode raw request bytes: size first, then strict UTF-8, JSON, shape. Host only. */
export function decodeMutationRequestBytes(bytes: Uint8Array): MutationRequestEnvelope {
  if (bytes.length > MUTATION_MAX_REQUEST_BYTES) throw new ControlProtocolError(`request: too large (over ${MUTATION_MAX_REQUEST_BYTES} bytes)`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ControlProtocolError("request: not valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ControlProtocolError("request: invalid JSON");
  }
  return parseMutationRequestEnvelope(value);
}

type Refusal = { error: ControlError; conflict: { revision: number } | null };

function refusal(code: string, message: string, conflict: { revision: number } | null = null): Refusal {
  return { error: { code, message: redactMessage(message), retryable: code === "STORAGE_BUSY" }, conflict };
}

function fromCurationError(error: CurationError): Refusal {
  const conflict = error instanceof CurationConflictError ? { revision: error.current.revision } : null;
  return refusal(error.code, error.message, conflict);
}

/** Every common gate. Returns the validated args, or a refusal proven to precede any dispatch. */
function gate(envelope: MutationRequestEnvelope): { args: CurationMutationArgs } | Refusal {
  const { requestId, mutation } = envelope;
  const op = REGISTRY.get(mutation.op);
  // The op text is caller input: never echoed back.
  if (op === undefined || op.tier === "read") return refusal("OpNotAllowed", "op is not an allowed mutation");
  const effects = OPERATION_EFFECTS.get(mutation.op);
  const isCuration = effects?.kind === "mutation" && effects.family === "curation";
  if (!isCuration) {
    if (CURATION_REQUEST_ID_RE.test(requestId)) return refusal("INVALID_INPUT", "invalid curation input: requestId");
    return refusal("UNSUPPORTED_OPERATION", "only curation mutations run through this dispatcher");
  }
  if (!CURATION_REQUEST_ID_RE.test(requestId)) return refusal("INVALID_INPUT", "invalid curation input: requestId");
  if (effects.model || effects.remote) return refusal("OpNotAllowed", "op is not an allowed mutation");
  if (mutation.expectedState !== undefined) return refusal("InvalidArgs", "expectedState is not accepted by this op");

  let args: CurationMutationArgs;
  try {
    args = parseCurationMutationArgs(mutation.args);
  } catch (error) {
    if (error instanceof CurationError) return fromCurationError(error);
    throw error;
  }
  if (CURATION_MUTATION_OPS[mutation.op as CurationMutationOp] !== args.mutation.change.kind) {
    return refusal("INVALID_INPUT", "invalid curation input: change.kind");
  }
  // The schema already holds change.confirmed to true for a purge.
  if (mutation.confirmed !== (effects.confirmation === "explicit")) return refusal("INVALID_INPUT", "invalid curation input: confirmed");
  if (args.mutation.requestId !== requestId) return refusal("INVALID_INPUT", "invalid curation input: requestId");
  if (!loadConfig().worlds.some((w) => w.name === args.mutation.key.world)) return refusal("INVALID_INPUT", "invalid curation input: world");
  return { args };
}

const unknownOutcome = (requestId: string): CurationMutationFailure => ({ version: 1, requestId, error: { ...OUTCOME_UNKNOWN_ERROR }, conflict: null });

/**
 * The whole-envelope bound for every host entry, raw bytes or not. Measured
 * on the serialized value, before any gate, owner or store. A value that
 * cannot serialize is refused with a fixed message.
 */
function checkEnvelopeSize(input: unknown): void {
  let text: string | undefined;
  try {
    text = JSON.stringify(input);
  } catch {
    throw new ControlProtocolError("request: not serializable");
  }
  if (text === undefined) throw new ControlProtocolError("request: not serializable");
  if (utf8ByteLength(text) > MUTATION_MAX_REQUEST_BYTES) throw new ControlProtocolError(`request: too large (over ${MUTATION_MAX_REQUEST_BYTES} bytes)`);
}

/** The dispatcher, with owners injectable for tests. */
export async function dispatchMutationWith(input: unknown, owners: MutationOwners): Promise<CurationMutationResponse> {
  checkEnvelopeSize(input);
  const envelope = parseMutationRequestEnvelope(input);
  const { requestId } = envelope;
  let gated: { args: CurationMutationArgs } | Refusal;
  try {
    gated = gate(envelope);
  } catch (error) {
    console.error(`sil ops: mutation gate failed: ${redactMessage(error instanceof Error ? error.name : String(error))}`);
    return unknownOutcome(requestId);
  }
  if (!("args" in gated)) return { version: 1, requestId, ...gated };

  let result: CurationOwnerResult;
  try {
    result = await owners.curation.execute(requestId, gated.args);
  } catch (error) {
    // After dispatch, a throw is never proof that nothing committed.
    console.error(`sil ops: curation mutation outcome unknown: ${redactMessage(error instanceof Error ? error.name : String(error))}`);
    return unknownOutcome(requestId);
  }
  if (result.state === "refused") {
    if (!(result.error instanceof CurationError) || !CURATION_REFUSAL_CODES.has(result.error.code)) return unknownOutcome(requestId);
    return { version: 1, requestId, ...fromCurationError(result.error) };
  }
  if (result.receipt.requestId !== requestId) return unknownOutcome(requestId);
  return { version: 1, requestId, receipt: result.receipt, store: { locationId: result.store.locationId, installationId: result.store.installationId } };
}

/** The one implemented dispatch path. Structurally invalid input throws ControlProtocolError. */
export function dispatchMutation(input: unknown): Promise<CurationMutationResponse> {
  return dispatchMutationWith(input, MUTATION_OWNERS);
}

/**
 * Generic receipt-only projection of dispatchMutation. Returns a completed
 * receipt; throws MutationPurged, MutationRefused or MutationOutcomeUnknown.
 */
export async function executeMutation(request: MutationRequest): Promise<OperationReceipt> {
  return projectMutationResponse(await dispatchMutation(mutationEnvelopeOf(request)));
}
