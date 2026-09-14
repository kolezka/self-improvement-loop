// One HTTP route per op, generated from the registry: read tier is GET with
// the query string as the payload, local and remote tiers are POST with a
// JSON body. Error mapping matches sil/web/server.py's _invoke_op, plus the
// TS-only error classes (GitError, ReviewError) @sil/core adds.

import { ConfigError, fsx, GitError, paths, ProviderError, ProviderTimeout, ReviewError, ValidationError } from "@sil/core";
import { invoke, listOps, opPath, REGISTRY } from "@sil/ops";
import { ZodError } from "zod";

export interface RouteEntry {
  name: string;
  method: "GET" | "POST";
}

/** path -> route, built once per server so a hot-reloaded registry (tests
 * that register throwaway ops) is picked up by calling this again. */
export function buildRoutes(): Map<string, RouteEntry> {
  const routes = new Map<string, RouteEntry>();
  for (const [name, op] of REGISTRY) {
    routes.set(opPath(name), { name, method: op.tier === "read" ? "GET" : "POST" });
  }
  return routes;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function zodDetail(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
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

  const e = err instanceof Error ? err : new Error(String(err));
  const trace = e.stack ?? `${e.name}: ${e.message}`;
  fsx.appendLine(paths.logFile("web"), `${fsx.nowIso()} ERROR ${trace}`);
  return jsonResponse(500, { detail: e.name });
}

export async function handleOps(): Promise<Response> {
  return jsonResponse(200, listOps());
}

/** GET: query string becomes the payload, letting each op's own zod schema
 * coerce numeric fields. POST: a JSON body, or {} when the body is empty. */
export async function handleOp(request: Request, route: RouteEntry, url: URL): Promise<Response> {
  try {
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
    return mapError(err);
  }
}
