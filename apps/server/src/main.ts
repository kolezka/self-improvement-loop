// HTTP API + static UI entry point. Bun.serve on loopback only, a route per
// op generated from the registry, static files unguarded underneath.

import { randomBytes } from "node:crypto";
import { guard } from "./guard.ts";
import { buildRoutes, handleOp, handleOps } from "./routes.ts";
import { serveStatic } from "./static.ts";

export interface CreateServerOptions {
  port: number;
  host?: string;
  token: string | null;
}

const REFUSED_HOSTS = new Set(["0.0.0.0", "::", "*"]);

export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

export function createServer(opts: CreateServerOptions): Bun.Server<undefined> {
  const host = opts.host ?? "127.0.0.1";
  if (REFUSED_HOSTS.has(host)) {
    throw new Error(`refusing to bind the web UI to ${JSON.stringify(host)}: loopback only`);
  }

  const routes = buildRoutes();

  const server = Bun.serve({
    hostname: host,
    port: opts.port,
    // Every op body here is a small JSON object. Left at Bun's default, one
    // oversized POST buffers in the worker's own process before any handler
    // sees it. Over the cap Bun answers 413 and never calls fetch.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    fetch(request) {
      const url = new URL(request.url);
      const pathname = url.pathname;

      if (pathname === "/api/ops" || routes.has(pathname)) {
        const denied = guard(request, { port: server.port ?? opts.port, token: opts.token });
        if (denied) return denied;
        if (pathname === "/api/ops") return handleOps();
        const route = routes.get(pathname)!;
        if (route.method !== request.method) {
          return new Response(JSON.stringify({ detail: `method not allowed: ${request.method}` }), {
            status: 405,
            headers: { "content-type": "application/json" },
          });
        }
        return handleOp(request, route, url);
      }

      if (pathname.startsWith("/api/")) {
        return new Response(JSON.stringify({ detail: "unknown op" }), { status: 404, headers: { "content-type": "application/json" } });
      }

      return serveStatic(pathname);
    },
  });

  return server;
}

export interface ServeOptions {
  port: number;
  host?: string;
  token?: boolean;
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Start the server, print the URL with the token in the fragment, and keep
 * running. `token: false` runs tokenless: X-SIL-Local is then the sole guard. */
export function serve(opts: ServeOptions): Bun.Server<undefined> {
  const host = opts.host ?? "127.0.0.1";
  const token = (opts.token ?? true) ? newToken() : null;
  const server = createServer({ port: opts.port, host, token });
  const url = `http://${host}:${server.port ?? opts.port}/` + (token ? `#${token}` : "");
  console.log(url);
  return server;
}

interface Cli {
  port: number;
  host: string;
  token: boolean;
}

function parseCliArgs(argv: string[]): Cli {
  let port = 8766;
  let host = "127.0.0.1";
  let token = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = argv[++i];
      if (value !== undefined) port = Number(value);
    } else if (arg === "--host") {
      const value = argv[++i];
      if (value !== undefined) host = value;
    } else if (arg === "--no-token") {
      token = false;
    }
  }
  return { port, host, token };
}

if (import.meta.main) {
  const cli = parseCliArgs(process.argv.slice(2));
  serve(cli);
}
