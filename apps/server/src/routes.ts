// One HTTP route per op, generated from the registry: read tier is GET with
// the query string as the payload, local and remote tiers are POST with a
// JSON body. Error mapping matches sil/web/server.py's _invoke_op, plus the
// TS-only error classes (GitError, ReviewError) @sil/core adds.

import { ConfigError, fsx, GitError, paths, ProviderError, ProviderTimeout, ReviewError, ValidationError } from "@sil/core";
import { invoke, listOps, opPath, REGISTRY } from "@sil/ops";
import { ControlProtocolError } from "@sil/core/control-protocol";
import {
  MUTATION_MAX_REQUEST_BYTES,
  OUTCOME_UNKNOWN_ERROR,
  encodeCurationMutationResponse,
  type CurationMutationResponse,
} from "@sil/core/control-mutation";
import { CurationError } from "@sil/core/lesson-curation";
import { decodeMutationRequestBytes, dispatchMutation } from "@sil/ops/mutation";
import { OPERATION_EFFECTS } from "@sil/ops/effects";
import { ZodError } from "zod";

export interface RouteEntry {
  name: string;
  method: "GET" | "POST";
  /** "mutation" routes go only through the mutation dispatcher, never invoke. */
  kind?: "op" | "mutation";
}

/** path -> route, built once per server so a hot-reloaded registry (tests
 * that register throwaway ops) is picked up by calling this again. */
export function buildRoutes(): Map<string, RouteEntry> {
  const routes = new Map<string, RouteEntry>();
  for (const [name, op] of REGISTRY) {
    const mutation = OPERATION_EFFECTS.get(name)?.kind === "mutation";
    routes.set(opPath(name), { name, method: op.tier === "read" ? "GET" : "POST", kind: mutation ? "mutation" : "op" });
  }
  return routes;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function zodDetail(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

// lesson capture: one status table for curation codes, reads and mutations.
const CURATION_STATUS: Readonly<Record<string, number>> = Object.freeze({
  OpNotAllowed: 400,
  InvalidArgs: 400,
  UNSUPPORTED_OPERATION: 400,
  INVALID_INPUT: 400,
  SENSITIVE_CONTENT: 422,
  CURATION_CONFLICT: 409,
  CAPTURE_EXISTS: 409,
  SCOPE_CONFLICT: 409,
  SOURCE_CONFLICT: 409,
  INSTALLATION_MISMATCH: 409,
  UNSUPPORTED_SCHEMA: 409,
  PURGED: 410,
  STORAGE_BUSY: 503,
  STORAGE_UNAVAILABLE: 503,
  OUTCOME_UNKNOWN: 500,
});

function curationStatus(code: string): number {
  return Object.hasOwn(CURATION_STATUS, code) ? CURATION_STATUS[code]! : 500;
}

/** Every unhandled op error mapped to a status code. A 500 logs the full
 * trace to the web log; the response body only ever gets the class name. */
export function mapError(err: unknown): Response {
  if (err instanceof ZodError) return jsonResponse(400, { detail: zodDetail(err) });
  if (err instanceof ValidationError) return jsonResponse(400, { detail: err.message });
  if (err instanceof ConfigError) return jsonResponse(503, { detail: err.message });
  if (err instanceof ProviderTimeout) return jsonResponse(504, { detail: err.message });
  if (err instanceof ProviderError) return jsonResponse(502, { detail: err.message });
  if (err instanceof GitError) return jsonResponse(502, { detail: (err.stderr || err.message).slice(-2000) });
  if (err instanceof ReviewError) return jsonResponse(409, { detail: err.message });
  // Fixed message plus field names only, never input text or SQL values.
  if (err instanceof CurationError) {
    const current = (err as { current?: { revision?: unknown } }).current;
    const revision = typeof current?.revision === "number" ? { revision: current.revision } : {};
    return jsonResponse(curationStatus(err.code), { detail: err.message, code: err.code, ...revision });
  }

  const e = err instanceof Error ? err : new Error(String(err));
  const trace = e.stack ?? `${e.name}: ${e.message}`;
  fsx.appendLine(paths.logFile("web"), `${fsx.nowIso()} ERROR ${trace}`);
  return jsonResponse(500, { detail: e.name });
}

export async function handleOps(): Promise<Response> {
  return jsonResponse(200, listOps());
}

/**
 * A curated read's argument error: typed, field names only. Unknown keys and
 * every input value stay out, so a query string is never echoed back.
 */
function curatedArgsError(err: ZodError): Response {
  const parts = err.issues.slice(0, 5).map((issue) => {
    if (issue.code === "unrecognized_keys") return "(args): unexpected key";
    const field = issue.path.length === 0 ? "(args)" : issue.path.map(String).join(".");
    return `${field}: invalid`;
  });
  return jsonResponse(400, { detail: `invalid arguments: ${parts.join("; ")}`.slice(0, 500), code: "InvalidArgs" });
}

/** Read at most `limit + 1` bytes of a body. null when it is over the limit. */
async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function mutationResponse(response: CurationMutationResponse): Response {
  let text: string;
  try {
    text = encodeCurationMutationResponse(response);
  } catch {
    // After dispatch an encoding failure is an unknown outcome, never a refusal.
    response = { version: 1, requestId: response.requestId, error: { ...OUTCOME_UNKNOWN_ERROR }, conflict: null };
    text = encodeCurationMutationResponse(response);
  }
  const status = "error" in response ? curationStatus(response.error.code) : 200;
  return new Response(text, { status, headers: { "content-type": "application/json" } });
}

/** POST body is the same mutation envelope `sil ops` reads on stdin. */
async function handleMutation(request: Request, route: RouteEntry): Promise<Response> {
  const bytes = await readBoundedBody(request, MUTATION_MAX_REQUEST_BYTES);
  if (bytes === null) return jsonResponse(413, { detail: `mutation request over ${MUTATION_MAX_REQUEST_BYTES} bytes` });
  let envelope;
  try {
    envelope = decodeMutationRequestBytes(bytes);
  } catch (err) {
    if (err instanceof ControlProtocolError) return jsonResponse(400, { detail: "invalid mutation request" });
    throw err;
  }
  if (envelope.mutation.op !== route.name) return jsonResponse(400, { detail: "mutation op does not match this route" });
  return mutationResponse(await dispatchMutation(envelope));
}

/** GET: query string becomes the payload, letting each op's own zod schema
 * coerce numeric fields. POST: a JSON body, or {} when the body is empty. */
export async function handleOp(request: Request, route: RouteEntry, url: URL): Promise<Response> {
  try {
    if (route.kind === "mutation") return await handleMutation(request, route);
    let payload: unknown;
    if (route.method === "GET") {
      payload = Object.fromEntries(url.searchParams.entries());
    } else {
      const raw = await request.text();
      if (!raw) {
        payload = {};
      } else {
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          return jsonResponse(400, { detail: `invalid JSON body: ${(e as Error).message}` });
        }
      }
    }
    const result = await invoke(route.name, payload);
    return jsonResponse(200, result);
  } catch (err) {
    // Only the curated lesson reads; every other route keeps its old ZodError body.
    if (err instanceof ZodError && OPERATION_EFFECTS.get(route.name)?.kind === "read") return curatedArgsError(err);
    return mapError(err);
  }
}
