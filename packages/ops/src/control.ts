// Host side of the control bridge. Runs only the explicit read allowlist below,
// never "every op with tier read": health.report and llm.status are tier read
// but probe providers, so they stay out.
//
// Imports the registry, not index.ts. The caller loads index.ts for its
// registration side effects; importing it here would make a cycle.

import { ZodError, ZodObject } from "zod";
import {
  CONTROL_MAX_REQUEST_BYTES,
  CONTROL_MAX_RESPONSE_BYTES,
  ControlProtocolError,
  parseControlRequest,
  utf8ByteLength,
  type ControlError,
  type ControlRequest,
  type ControlResponse,
  type ControlResult,
} from "@sil/core/control-protocol";
import { CurationError } from "@sil/core/lesson-curation";
import { REGISTRY } from "./registry.ts";

export const CONTROL_READ_OPS: readonly string[] = Object.freeze([
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
  // lesson capture: curated lesson reads
  "lessons.projects",
  "lessons.context",
  "lessons.browse",
  "lessons.get",
  "lessons.history",
  "lessons.receipt",
  "lessons.store",
  "lessons.locate",
]);
const ALLOWED = new Set(CONTROL_READ_OPS);

// Domain errors whose message is meant for the operator. Anything else is a
// bug and gets a generic message; its detail goes to stderr only.
const DOMAIN_ERRORS = new Set(["ConfigError", "ValidationError", "ReviewError", "GitError", "LockHeld", "ProviderError", "ProposalChanged", "QueueReadError", "StateReadError"]);
const MAX_MESSAGE_CHARS = 500;

// A key that names a secret, bare or quoted (also with JSON-escaped quotes),
// then `=` or `:`. The value after it is found by scanValue, not by a regex,
// so escaped quotes inside it cannot end it early. A suffix after the keyword
// needs a separator, so "max_tokens" or "tokens" is left alone.
const SECRET_KEY =
  /(\\?["']?)([A-Za-z0-9_-]*?(?:api[_-]?key|token|secret|password|passwd|authorization|credential)(?:[_-][A-Za-z0-9_-]*)?)\1(\s*[=:]\s*)/gi;
const BEARER = /\bBearer\s+[^\s"'\\]+/gi;
const SK_TOKEN = /\bsk-[A-Za-z0-9_-]{8,}/g;
const UNQUOTED_END = /[\s"',;}]/;

/** Backslashes immediately before index `at`. */
function backslashesBefore(text: string, at: number, floor: number): number {
  let n = 0;
  while (at - 1 - n >= floor && text[at - 1 - n] === "\\") n += 1;
  return n;
}

/** End index (exclusive) of the value starting at `start`. A value without
 * its closing quote runs to the end of the text, so an ambiguous or cut
 * remainder is masked rather than shown. */
function scanValue(text: string, start: number): number {
  const first = text[start];
  if (first === "\\" && text[start + 1] === '"') {
    // JSON inside a string: the value closes at a `\"` with exactly one
    // backslash. An inner quote is `\\\"`, which keeps going.
    for (let i = start + 2; i < text.length; i += 1) {
      if (text[i] === '"' && backslashesBefore(text, i, start + 2) === 1) return i + 1;
    }
    return text.length;
  }
  if (first === '"' || first === "'") {
    // A quote preceded by an odd run of backslashes is escaped.
    for (let i = start + 1; i < text.length; i += 1) {
      if (text[i] === first && backslashesBefore(text, i, start + 1) % 2 === 0) return i + 1;
    }
    return text.length;
  }
  let i = start;
  while (i < text.length && !UNQUOTED_END.test(text[i]!)) i += 1;
  return i;
}

/** Mask secret-looking values, then cap the length. Masking runs before the
 * cut so a secret straddling it cannot leave a prefix behind. */
export function redactMessage(message: string): string {
  let text = message.slice(0, MAX_MESSAGE_CHARS * 2);
  text = text.replace(BEARER, "Bearer [redacted]");
  text = text.replace(SK_TOKEN, "[redacted]");
  let out = "";
  let from = 0;
  SECRET_KEY.lastIndex = 0;
  for (let m = SECRET_KEY.exec(text); m !== null; m = SECRET_KEY.exec(text)) {
    const valueStart = m.index + m[0].length;
    const valueEnd = scanValue(text, valueStart);
    if (valueEnd === valueStart) continue;
    out += text.slice(from, valueStart) + "[redacted]";
    from = valueEnd;
    SECRET_KEY.lastIndex = valueEnd;
  }
  out += text.slice(from);
  return out.length > MAX_MESSAGE_CHARS ? `${out.slice(0, MAX_MESSAGE_CHARS)}...` : out;
}

function error(code: string, message: string, retryable = false): { ok: false; error: ControlError } {
  return { ok: false, error: { code, message: redactMessage(message), retryable } };
}

function zodSummary(err: ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".") || "(args)"}: ${i.message}`)
    .join("; ");
}

function errorResult(err: unknown, op: string): { ok: false; error: ControlError } {
  const name = err instanceof Error ? err.name || err.constructor.name : "";
  const ctor = err instanceof Error ? err.constructor.name : "";
  const domain = DOMAIN_ERRORS.has(name) ? name : DOMAIN_ERRORS.has(ctor) ? ctor : null;
  // A curation error carries its own safe code and fixed message.
  if (err instanceof CurationError) return error(err.code, err.message, err.code === "STORAGE_BUSY");
  if (domain !== null) return error(domain, (err as Error).message, domain === "LockHeld");
  if (err instanceof ZodError) return error("ValidationError", zodSummary(err));
  console.error(`sil ops: ${op} failed: ${redactMessage(err instanceof Error ? `${err.name}: ${err.message}` : String(err))}`);
  return error("InternalError", `${op} failed unexpectedly`);
}

type Prepared = { id: string; op: string; args: unknown } | { id: string; rejected: { ok: false; error: ControlError } };

function prepare(id: string, opName: string, rawArgs: Record<string, unknown>): Prepared {
  // The op text is caller input: never echoed back.
  if (!ALLOWED.has(opName)) return { id, rejected: error("OpNotAllowed", "op is not an allowed read") };
  const op = REGISTRY.get(opName);
  if (!op) return { id, rejected: error("OpNotAllowed", "op is not registered") };
  // Unknown argument keys are refused, not silently stripped.
  const schema = op.args instanceof ZodObject ? op.args.strict() : null;
  if (schema === null) return { id, rejected: error("InvalidArgs", `op ${opName} has no object schema`) };
  const parsed = schema.safeParse(rawArgs);
  if (!parsed.success) return { id, rejected: error("InvalidArgs", zodSummary(parsed.error)) };
  return { id, op: opName, args: parsed.data };
}

function resultBytes(id: string, result: ControlResult): number {
  // `"id":{...},` inside the results object.
  return utf8ByteLength(JSON.stringify(id)) + 2 + utf8ByteLength(JSON.stringify(result));
}

/** Replace the largest successful results with ResponseTooLarge until the
 * envelope fits. Never clips a value. */
function bound(response: ControlResponse): ControlResponse {
  const ids = Object.keys(response.results);
  const sizes = new Map(ids.map((id) => [id, resultBytes(id, response.results[id]!)]));
  const shell = utf8ByteLength(JSON.stringify({ ...response, results: {} }));
  let total = shell + [...sizes.values()].reduce((a, b) => a + b, 0);
  while (total > CONTROL_MAX_RESPONSE_BYTES) {
    const candidates = ids.filter((id) => response.results[id]!.ok);
    if (candidates.length === 0) break;
    const largest = candidates.reduce((a, b) => (sizes.get(b)! > sizes.get(a)! ? b : a));
    const replacement = error("ResponseTooLarge", `result over the ${CONTROL_MAX_RESPONSE_BYTES} byte response limit`);
    response.results[largest] = replacement;
    total += resultBytes(largest, replacement) - sizes.get(largest)!;
    sizes.set(largest, resultBytes(largest, replacement));
  }
  return response;
}

/** Run one control request. A structurally invalid envelope throws
 * ControlProtocolError. A valid envelope always resolves to one result per
 * read: if any read names a forbidden op or bad args, none of them run. */
/** Decode raw stdin bytes: size first, then strict UTF-8, then JSON, then
 * shape. Host only: the sandbox's TextDecoder has no `fatal` option, so this
 * cannot live in the shared protocol module. */
export function decodeControlRequestBytes(bytes: Uint8Array): ControlRequest {
  if (bytes.length > CONTROL_MAX_REQUEST_BYTES) {
    throw new ControlProtocolError(`request: too large (over ${CONTROL_MAX_REQUEST_BYTES} bytes)`);
  }
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
  return parseControlRequest(value);
}

export async function executeControlRead(request: unknown): Promise<ControlResponse> {
  const req = parseControlRequest(request);
  const results: Record<string, ControlResult> = Object.create(null);
  const prepared = req.reads.map((r) => prepare(r.id, r.op, r.args));

  if (prepared.some((p) => "rejected" in p)) {
    for (const p of prepared) {
      results[p.id] = "rejected" in p ? p.rejected : error("BatchRejected", "not run: another read in this batch was refused");
    }
    return { version: 1, requestId: req.requestId, results };
  }

  for (const p of prepared) {
    if ("rejected" in p) continue;
    const op = REGISTRY.get(p.op)!;
    let value: unknown;
    try {
      value = await op.fn(p.args);
    } catch (err) {
      results[p.id] = errorResult(err, p.op);
      continue;
    }
    // Round-trip now so the envelope is exactly what gets sent, and an
    // unserialisable value fails this read instead of the whole response.
    try {
      const text = JSON.stringify(value === undefined ? null : value);
      results[p.id] = { ok: true, value: JSON.parse(text) };
    } catch {
      results[p.id] = error("UnserializableResult", `${p.op} returned a value that is not JSON`);
    }
  }
  return bound({ version: 1, requestId: req.requestId, results });
}
