// The native console's bridge to `sil ops`, the reviewed read-only control
// host. One fixed argv launch of the loaded plugin's own launcher, one request
// on stdin, one bounded envelope back.
//
// Unlike runCommand in ../io.ts, nothing here turns a failure into null: every
// way the bridge can fail rejects with a ControlTransportError the console
// shows. Its messages are fixed text plus at most an exit code, so no stdout,
// stderr, stack or engine message reaches native state.
//
// Runs in the hooks-module sandbox: only the pure protocol subpath is imported,
// and the engine is reached as `$.noun.method` on the parameter, never kept.

import {
  CONTROL_MAX_REQUEST_BYTES,
  CONTROL_MAX_RESPONSE_BYTES,
  decodeControlResponse,
  parseControlRequest,
  utf8ByteLength,
  type ControlRequest,
  type ControlResponse,
} from "@sil/core/control-protocol";
import type { EngineInterface } from "claude-code";

export const CONTROL_TIMEOUT_MS = 10000;

export type ControlTransportCode =
  | "invalid_request"
  | "request_too_large"
  | "launch_failed"
  | "exit_nonzero"
  | "truncated"
  | "incomplete"
  | "response_too_large"
  | "malformed_response"
  | "request_mismatch"
  | "result_mismatch";

export class ControlTransportError extends Error {
  override name = "ControlTransportError";
  readonly code: ControlTransportCode;

  constructor(code: ControlTransportCode, message: string) {
    super(message);
    this.code = code;
  }
}

function transportError(code: ControlTransportCode, message: string): never {
  throw new ControlTransportError(code, message);
}

/** Runs `sil ops` once for `requestJson` and returns its envelope text, the
 * trailing newline removed. Owns the launch, the byte bounds and the exit and
 * completeness checks; what the envelope means is the caller's. */
export async function runControlProcess($: EngineInterface, requestJson: string): Promise<string> {
  if (utf8ByteLength(requestJson) > CONTROL_MAX_REQUEST_BYTES) {
    transportError("request_too_large", `The control request is over ${CONTROL_MAX_REQUEST_BYTES} bytes.`);
  }
  // This loaded copy, pinned: scripts/sil honours SIL_PLUGIN_ROOT before any
  // installed_plugins.json lookup, and finds bun on a minimal PATH itself.
  const root = $.plugin.root;
  let result: Awaited<ReturnType<EngineInterface["process"]["run"]>>;
  try {
    result = await $.process.run(["/bin/sh", `${root}/scripts/sil`, "ops"], {
      env: { SIL_PLUGIN_ROOT: root },
      stdin: requestJson,
      timeoutMs: CONTROL_TIMEOUT_MS,
    });
  } catch {
    // The engine rejects both a child that cannot start and one still running
    // at the timeout. Its message may carry paths, so it is not passed on.
    return transportError(
      "launch_failed",
      `The control bridge did not start, or did not finish within ${CONTROL_TIMEOUT_MS / 1000} s.`,
    );
  }
  if (result.isStdoutTruncated || result.isStderrTruncated) {
    transportError("truncated", "The control bridge wrote more output than the engine keeps; nothing was decoded.");
  }
  if (result.exitCode !== 0) {
    const code = Number.isInteger(result.exitCode) ? String(result.exitCode) : "an unknown code";
    transportError("exit_nonzero", `The control bridge exited with ${code}.`);
  }
  const stdout = result.stdout;
  // `sil ops` ends its one envelope with a newline; without it the write was cut.
  if (!stdout.endsWith("\n")) transportError("incomplete", "The control bridge ended without a complete response.");
  const text = stdout.slice(0, -1);
  if (utf8ByteLength(text) > CONTROL_MAX_RESPONSE_BYTES) {
    transportError("response_too_large", `The control response is over ${CONTROL_MAX_RESPONSE_BYTES} bytes.`);
  }
  return text;
}

/** Sends one read request and returns its response, bound to that request:
 * same request id, exactly one result per read. A per-read failure stays an
 * `{ ok: false }` result; anything wrong with the exchange itself rejects. */
export async function readControl($: EngineInterface, request: ControlRequest): Promise<ControlResponse> {
  // Validated twice: the value, then the JSON it encodes to. A shape-valid args
  // object can still throw while encoding (toJSON, a getter, a cycle, a
  // BigInt) or encode to something else, so the wire text is what gets bound.
  let checked: ControlRequest;
  let requestJson: string;
  try {
    const encoded = JSON.stringify(parseControlRequest(request));
    checked = parseControlRequest(JSON.parse(encoded));
    requestJson = JSON.stringify(checked);
  } catch {
    return transportError("invalid_request", "The control request is malformed and was not sent.");
  }
  const text = await runControlProcess($, requestJson);

  let response: ControlResponse;
  try {
    response = decodeControlResponse(text, checked.requestId);
  } catch (err) {
    // The decoder's messages can quote response keys, so only the kind of
    // failure is kept. The id check is the decoder's own, by its fixed text.
    if (err instanceof Error && err.message === "response: requestId does not match the request") {
      return transportError("request_mismatch", "The control response answers a different request.");
    }
    return transportError("malformed_response", "The control bridge returned a response that is not a valid envelope.");
  }

  const ids = Object.keys(response.results);
  const complete = ids.length === checked.reads.length && checked.reads.every((read) => Object.hasOwn(response.results, read.id));
  if (!complete) transportError("result_mismatch", "The control response does not answer exactly the reads that were asked.");
  return response;
}
