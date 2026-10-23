// Wire contract between the native console and `sil ops`: one bounded JSON
// request in, one bounded JSON response out. Pure on purpose (no imports, no
// Node, no Bun) so the hooks-module sandbox can load it too.

export type ControlRead = { id: string; op: string; args: Record<string, unknown> };
export type ControlRequest = { version: 1; requestId: string; reads: ControlRead[] };
export type ControlError = { code: string; message: string; retryable: boolean };
export type ControlResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: ControlError };
export type ControlResponse = {
  version: 1; requestId: string; results: Record<string, ControlResult>;
};

export const CONTROL_MAX_REQUEST_BYTES = 131072;
export const CONTROL_MAX_RESPONSE_BYTES = 1048576;
export const CONTROL_MAX_READS = 8;
export const CONTROL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** The envelope itself is malformed. The caller should refuse the whole thing. */
export class ControlProtocolError extends Error {
  override name = "ControlProtocolError";
}

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

function fail(message: string): never {
  throw new ControlProtocolError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Own keys must be exactly `required`, plus any of `optional`. */
function exactKeys(value: Record<string, unknown>, required: string[], where: string): void {
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!required.includes(key)) fail(`${where}: unexpected key ${JSON.stringify(key).slice(0, 80)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${where}: missing ${key}`);
  }
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${where}: invalid JSON`);
  }
}

/** Validate an already parsed request value. Throws ControlProtocolError. */
export function parseControlRequest(value: unknown): ControlRequest {
  if (!isPlainObject(value)) fail("request: must be a JSON object");
  exactKeys(value, ["version", "requestId", "reads"], "request");
  if (value["version"] !== 1) fail("request: unsupported version");
  const requestId = value["requestId"];
  if (typeof requestId !== "string" || !CONTROL_ID_RE.test(requestId)) fail("request: invalid requestId");
  const reads = value["reads"];
  if (!Array.isArray(reads)) fail("request: reads must be an array");
  if (reads.length < 1 || reads.length > CONTROL_MAX_READS) fail(`request: reads must hold 1 to ${CONTROL_MAX_READS} entries`);

  const seen = new Set<string>();
  const out: ControlRead[] = [];
  reads.forEach((read: unknown, i: number) => {
    const where = `reads[${i}]`;
    if (!isPlainObject(read)) fail(`${where}: must be an object`);
    exactKeys(read, ["id", "op", "args"], where);
    const { id, op, args } = read as { id: unknown; op: unknown; args: unknown };
    if (typeof id !== "string" || !CONTROL_ID_RE.test(id)) fail(`${where}: invalid id`);
    if (seen.has(id)) fail(`${where}: duplicate id ${JSON.stringify(id)}`);
    seen.add(id);
    // An op is an opaque string. Whether it may run is the host allowlist's
    // call, answered per read, not a reason to refuse the whole envelope.
    if (typeof op !== "string") fail(`${where}: op must be a string`);
    if (!isPlainObject(args)) fail(`${where}: args must be an object`);
    out.push({ id, op, args });
  });
  return { version: 1, requestId, reads: out };
}

function decodeError(value: unknown, where: string): ControlError {
  if (!isPlainObject(value)) fail(`${where}: error must be an object`);
  exactKeys(value, ["code", "message", "retryable"], where);
  const { code, message, retryable } = value as { code: unknown; message: unknown; retryable: unknown };
  if (typeof code !== "string" || code.length === 0 || code.length > 64) fail(`${where}: invalid code`);
  if (typeof message !== "string") fail(`${where}: invalid message`);
  if (typeof retryable !== "boolean") fail(`${where}: invalid retryable`);
  return { code, message, retryable };
}

function decodeResult(value: unknown, where: string): ControlResult {
  if (!isPlainObject(value)) fail(`${where}: must be an object`);
  if (value["ok"] === true) {
    exactKeys(value, ["ok", "value"], where);
    return { ok: true, value: value["value"] };
  }
  if (value["ok"] === false) {
    exactKeys(value, ["ok", "error"], where);
    return { ok: false, error: decodeError(value["error"], `${where}.error`) };
  }
  return fail(`${where}: ok must be a boolean`);
}

/** Decode one response and bind it to the request that asked for it. Anything
 * else (wrong request, wrong version, oversize, extra text) throws. */
export function decodeControlResponse(text: string, requestId: string): ControlResponse {
  if (utf8ByteLength(text) > CONTROL_MAX_RESPONSE_BYTES) fail(`response: too large (over ${CONTROL_MAX_RESPONSE_BYTES} bytes)`);
  const value = parseJson(text, "response");
  if (!isPlainObject(value)) fail("response: must be a JSON object");
  exactKeys(value, ["version", "requestId", "results"], "response");
  if (value["version"] !== 1) fail("response: unsupported version");
  if (value["requestId"] !== requestId) fail("response: requestId does not match the request");
  const raw = value["results"];
  if (!isPlainObject(raw)) fail("response: results must be an object");
  const ids = Object.keys(raw);
  if (ids.length > CONTROL_MAX_READS) fail("response: too many results");
  // Null prototype, so an id such as "__proto__" stays an own key.
  const results: Record<string, ControlResult> = Object.create(null);
  for (const id of ids) {
    if (!CONTROL_ID_RE.test(id)) fail("response: invalid result id");
    results[id] = decodeResult(raw[id], `results[${JSON.stringify(id)}]`);
  }
  return { version: 1, requestId, results };
}

/** Serialise a response. Throws rather than emit an oversize envelope; the
 * host bounds individual results before it gets here. */
export function encodeControlResponse(response: ControlResponse): string {
  const text = JSON.stringify(response);
  if (utf8ByteLength(text) > CONTROL_MAX_RESPONSE_BYTES) fail(`response: too large (over ${CONTROL_MAX_RESPONSE_BYTES} bytes)`);
  return text;
}
