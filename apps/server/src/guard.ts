// Loopback guard for every /api route: a wrong Host header, a missing
// X-SIL-Local header or a wrong token all fail closed with no op ever
// invoked. Same three checks as sil/web/server.py's guard().

import { timingSafeEqual } from "node:crypto";

export const LOCAL_HEADER = "X-SIL-Local";
export const TOKEN_HEADER = "X-SIL-Token";

export function allowedHosts(port: number): Set<string> {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const extra = process.env["SIL_WEB_ALLOWED_HOSTS"] ?? "";
  for (const raw of extra.split(",")) {
    const host = raw.trim();
    if (host) hosts.add(host);
  }
  return hosts;
}

/** Constant time string compare that tolerates unequal lengths instead of
 * throwing, the way Python's secrets.compare_digest does. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export interface GuardOptions {
  port: number;
  token: string | null;
}

function jsonError(status: number, detail: string): Response {
  return new Response(JSON.stringify({ detail }), { status, headers: { "content-type": "application/json" } });
}

/** Returns the Response to send back when the request fails the guard, or
 * null when the request may proceed. */
export function guard(request: Request, opts: GuardOptions): Response | null {
  const host = request.headers.get("host") ?? "";
  if (!allowedHosts(opts.port).has(host)) {
    return jsonError(403, "bad Host header");
  }
  if (request.headers.get(LOCAL_HEADER) !== "1") {
    return jsonError(401, `missing ${LOCAL_HEADER}: 1`);
  }
  if (opts.token !== null) {
    const supplied = request.headers.get(TOKEN_HEADER) ?? "";
    if (!safeEqual(supplied, opts.token)) {
      return jsonError(401, `bad or missing ${TOKEN_HEADER}`);
    }
  }
  return null;
}
