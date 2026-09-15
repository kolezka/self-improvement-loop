// Host guard for every /api route: a wrong Host header, a missing
// X-SIL-Local header or a wrong token all fail closed with no op ever
// invoked.
//
// The Host check is what stops DNS rebinding: a browser always sends the
// name from the address bar, so an attacker domain never matches. That is
// why IP literals on private networks (LAN, tailscale) are accepted while
// names must be listed in config or SIL_WEB_ALLOWED_HOSTS.

import { timingSafeEqual } from "node:crypto";

export const LOCAL_HEADER = "X-SIL-Local";
export const TOKEN_HEADER = "X-SIL-Token";

export function allowedHosts(port: number, extra: readonly string[] = []): Set<string> {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const env = process.env["SIL_WEB_ALLOWED_HOSTS"] ?? "";
  for (const raw of [...env.split(","), ...extra]) {
    const host = raw.trim();
    if (host) hosts.add(host);
  }
  return hosts;
}

/** Splits a Host header into hostname and port, brackets removed from an
 * IPv6 literal. Returns null for a value that is not a valid Host header. */
export function splitHostPort(value: string): { hostname: string; port: string } | null {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return null;
    const rest = value.slice(end + 1);
    if (rest !== "" && !rest.startsWith(":")) return null;
    return { hostname: value.slice(1, end), port: rest.slice(1) };
  }
  const colon = value.indexOf(":");
  if (colon === -1) return { hostname: value, port: "" };
  // A bare IPv6 literal has more than one colon and needs brackets here.
  if (value.indexOf(":", colon + 1) !== -1) return null;
  return { hostname: value.slice(0, colon), port: value.slice(colon + 1) };
}

function ipv4Private(hostname: string): boolean | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  // 100.64.0.0/10 is carrier grade NAT, which is where tailscale lives.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** True for an IP literal on a loopback, LAN or VPN network: RFC1918,
 * link local, CGNAT (tailscale), IPv6 loopback, ULA and link local. A DNS
 * name is never private, which is what keeps rebinding blocked. */
export function isPrivateAddress(hostname: string): boolean {
  const v4 = ipv4Private(hostname);
  if (v4 !== null) return v4;

  const v6 = hostname.toLowerCase().split("%")[0]!;
  if (!v6.includes(":")) return false;
  if (!/^[0-9a-f:.]+$/.test(v6)) return false;
  if (v6 === "::1") return true;
  if (v6.startsWith("::ffff:")) return ipv4Private(v6.slice(7)) === true;
  const head = Number.parseInt(v6.split(":")[0] || "0", 16);
  if (Number.isNaN(head)) return false;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7, unique local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10, link local
  return false;
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
  /** Extra Host header values, for names an IP check cannot cover (a
   * tailscale MagicDNS host, a reverse proxy). */
  allowedHosts?: readonly string[];
}

export function hostAllowed(host: string, opts: GuardOptions): boolean {
  if (allowedHosts(opts.port, opts.allowedHosts ?? []).has(host)) return true;
  const parts = splitHostPort(host);
  if (!parts || parts.port !== String(opts.port)) return false;
  return isPrivateAddress(parts.hostname);
}

function jsonError(status: number, detail: string): Response {
  return new Response(JSON.stringify({ detail }), { status, headers: { "content-type": "application/json" } });
}

/** Returns the Response to send back when the request fails the guard, or
 * null when the request may proceed. */
export function guard(request: Request, opts: GuardOptions): Response | null {
  const host = request.headers.get("host") ?? "";
  if (!hostAllowed(host, opts)) {
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
