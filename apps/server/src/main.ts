// HTTP API + static UI entry point. Bun.serve on loopback by default, a route
// per op generated from the registry, static files unguarded underneath.

import { networkInterfaces } from "node:os";
import { guard, isPrivateAddress } from "./guard.ts";
import { buildRoutes, handleOp, handleOps } from "./routes.ts";
import { serveStatic } from "./static.ts";
import { loadOrCreateToken } from "./token.ts";

export interface CreateServerOptions {
  port: number;
  host?: string;
  token: string | null;
  allowedHosts?: readonly string[];
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*"]);

export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

export function createServer(opts: CreateServerOptions): Bun.Server<undefined> {
  const host = opts.host ?? "127.0.0.1";
  // Off loopback the token is the only thing between the LAN and every op,
  // so a tokenless bind there fails loud instead of quietly exposing them.
  if (opts.token === null && !isLoopbackHost(host)) {
    throw new Error(`refusing to bind the web UI to ${JSON.stringify(host)} without a token: drop --no-token or bind 127.0.0.1`);
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
        const denied = guard(request, { port: server.port ?? opts.port, token: opts.token, allowedHosts: opts.allowedHosts });
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
  allowedHosts?: readonly string[];
}

/** The host to put in a URL for a given bind host: a wildcard bind has no
 * address of its own, and an IPv6 literal needs brackets. */
export function urlHost(host: string): string {
  if (WILDCARD_HOSTS.has(host)) return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

/** Every private address this machine answers on, so a wildcard bind prints
 * a URL that works from the LAN or from tailscale, not just from here. */
function privateAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal || !isPrivateAddress(addr.address)) continue;
      out.push(addr.address.includes(":") ? `[${addr.address}]` : addr.address);
    }
  }
  return out;
}

/** Start the server, print the URL, and keep running. Token default is auto:
 * off on loopback (X-SIL-Local plus the Host guard are enough there, so no
 * token in the URL), on for any non-loopback bind. `token` overrides: false
 * forces tokenless, true forces a token. A tokenless non-loopback bind is
 * refused by createServer.
 *
 * A token is the stored one, not a fresh one: `sil web` restarts itself after
 * a plugin update, and a new token there would 401 every open tab. */
export function serve(opts: ServeOptions): Bun.Server<undefined> {
  const host = opts.host ?? "127.0.0.1";
  const token = (opts.token ?? !isLoopbackHost(host)) ? loadOrCreateToken() : null;
  const server = createServer({ port: opts.port, host, token, allowedHosts: opts.allowedHosts });
  const port = server.port ?? opts.port;
  const fragment = token ? `#${token}` : "";
  const hosts = WILDCARD_HOSTS.has(host) ? [urlHost(host), ...privateAddresses()] : [urlHost(host)];
  for (const h of hosts) console.log(`http://${h}:${port}/${fragment}`);
  return server;
}

interface Cli {
  port: number;
  host: string;
  // undefined = auto: tokenless on loopback, token on elsewhere.
  token: boolean | undefined;
  allowedHosts: string[];
}

function parseCliArgs(argv: string[]): Cli {
  let port = 8766;
  let host = "127.0.0.1";
  let token: boolean | undefined;
  const allowedHosts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = argv[++i];
      if (value !== undefined) port = Number(value);
    } else if (arg === "--host") {
      const value = argv[++i];
      if (value !== undefined) host = value;
    } else if (arg === "--allowed-host") {
      const value = argv[++i];
      if (value !== undefined) allowedHosts.push(value);
    } else if (arg === "--token") {
      token = true;
    } else if (arg === "--no-token") {
      token = false;
    }
  }
  return { port, host, token, allowedHosts };
}

if (import.meta.main) {
  const cli = parseCliArgs(process.argv.slice(2));
  serve(cli);
}
