// Unit tests for the loopback guard: Host allowlist, the X-SIL-Local
// requirement, and a constant time token compare that tolerates unequal
// lengths instead of throwing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { allowedHosts, guard, hostAllowed, isPrivateAddress, LOCAL_HEADER, safeEqual, splitHostPort, TOKEN_HEADER } from "../src/guard.ts";

const savedAllowedHosts = process.env["SIL_WEB_ALLOWED_HOSTS"];

beforeEach(() => {
  delete process.env["SIL_WEB_ALLOWED_HOSTS"];
});

afterEach(() => {
  if (savedAllowedHosts === undefined) delete process.env["SIL_WEB_ALLOWED_HOSTS"];
  else process.env["SIL_WEB_ALLOWED_HOSTS"] = savedAllowedHosts;
});

describe("allowedHosts", () => {
  test("always includes 127.0.0.1:<port> and localhost:<port>", () => {
    const hosts = allowedHosts(9999);
    expect(hosts.has("127.0.0.1:9999")).toBe(true);
    expect(hosts.has("localhost:9999")).toBe(true);
    expect(hosts.has("127.0.0.1:1234")).toBe(false);
  });

  test("adds explicit extra entries", () => {
    const hosts = allowedHosts(9999, ["box.tail1234.ts.net:9999"]);
    expect(hosts.has("box.tail1234.ts.net:9999")).toBe(true);
  });

  test("adds SIL_WEB_ALLOWED_HOSTS entries", () => {
    process.env["SIL_WEB_ALLOWED_HOSTS"] = "example.test:9999, other.test:9999 ,";
    const hosts = allowedHosts(9999);
    expect(hosts.has("example.test:9999")).toBe(true);
    expect(hosts.has("other.test:9999")).toBe(true);
  });
});

describe("splitHostPort", () => {
  test("splits a name and an IPv4 literal", () => {
    expect(splitHostPort("localhost:8766")).toEqual({ hostname: "localhost", port: "8766" });
    expect(splitHostPort("100.64.0.5:8766")).toEqual({ hostname: "100.64.0.5", port: "8766" });
    expect(splitHostPort("localhost")).toEqual({ hostname: "localhost", port: "" });
  });

  test("unwraps a bracketed IPv6 literal", () => {
    expect(splitHostPort("[fd7a:115c:a1e0::1]:8766")).toEqual({ hostname: "fd7a:115c:a1e0::1", port: "8766" });
  });

  test("rejects a bare IPv6 literal and an unterminated bracket", () => {
    expect(splitHostPort("fd7a:115c:a1e0::1:8766")).toBeNull();
    expect(splitHostPort("[fd7a::1")).toBeNull();
  });
});

describe("isPrivateAddress", () => {
  test.each(["127.0.0.1", "10.1.2.3", "172.16.0.9", "172.31.255.254", "192.168.1.10", "169.254.3.4", "100.64.0.5", "100.100.100.100", "::1", "fd7a:115c:a1e0::f832:1040", "fe80::1", "::ffff:192.168.1.10"])(
    "%s is private",
    (addr) => {
      expect(isPrivateAddress(addr)).toBe(true);
    },
  );

  test.each(["8.8.8.8", "172.32.0.1", "100.128.0.1", "1.2.3.4", "999.1.1.1", "2001:4860:4860::8888", "evil.test", "localhost", "notanip"])("%s is not private", (addr) => {
    expect(isPrivateAddress(addr)).toBe(false);
  });
});

describe("hostAllowed", () => {
  const opts = { port: 9999, token: null };

  test("accepts a LAN or tailscale IP literal on the served port", () => {
    expect(hostAllowed("192.168.1.10:9999", opts)).toBe(true);
    expect(hostAllowed("100.64.0.5:9999", opts)).toBe(true);
    expect(hostAllowed("[fd7a:115c:a1e0::1]:9999", opts)).toBe(true);
  });

  test("rejects a private IP on a different port", () => {
    expect(hostAllowed("192.168.1.10:1234", opts)).toBe(false);
  });

  test("rejects a public IP and any name that is not listed", () => {
    expect(hostAllowed("8.8.8.8:9999", opts)).toBe(false);
    expect(hostAllowed("evil.test:9999", opts)).toBe(false);
  });

  test("accepts a listed name, which is how MagicDNS works", () => {
    expect(hostAllowed("box.tail1234.ts.net:9999", { ...opts, allowedHosts: ["box.tail1234.ts.net:9999"] })).toBe(true);
  });
});

describe("safeEqual", () => {
  test("true for equal strings", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true);
  });
  test("false for different strings of the same length", () => {
    expect(safeEqual("abc123", "abc124")).toBe(false);
  });
  test("false, not throwing, for different length strings", () => {
    expect(safeEqual("short", "a-lot-longer-token")).toBe(false);
  });
});

function req(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:9999/api/health/report", { headers });
}

describe("guard()", () => {
  const opts = { port: 9999, token: "the-token" };

  test("rejects a wrong Host header with 403", async () => {
    const res = guard(req({ host: "evil.test:9999", [LOCAL_HEADER]: "1", [TOKEN_HEADER]: "the-token" }), opts);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  test("rejects a missing X-SIL-Local header with 401", async () => {
    const res = guard(req({ host: "127.0.0.1:9999", [TOKEN_HEADER]: "the-token" }), opts);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  test("rejects a wrong token with 401", async () => {
    const res = guard(req({ host: "127.0.0.1:9999", [LOCAL_HEADER]: "1", [TOKEN_HEADER]: "wrong" }), opts);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  test("accepts a request with all three checks satisfied", async () => {
    const res = guard(req({ host: "127.0.0.1:9999", [LOCAL_HEADER]: "1", [TOKEN_HEADER]: "the-token" }), opts);
    expect(res).toBeNull();
  });

  test("skips the token check entirely when token is null", async () => {
    const res = guard(req({ host: "127.0.0.1:9999", [LOCAL_HEADER]: "1" }), { port: 9999, token: null });
    expect(res).toBeNull();
  });

  test("accepts a tailscale address with the token, still rejects it without", async () => {
    const headers = { host: "100.64.0.5:9999", [LOCAL_HEADER]: "1" };
    expect(guard(req({ ...headers, [TOKEN_HEADER]: "the-token" }), opts)).toBeNull();
    expect(guard(req(headers), opts)!.status).toBe(401);
  });

  test("accepts the localhost host alias", async () => {
    const res = guard(req({ host: "localhost:9999", [LOCAL_HEADER]: "1", [TOKEN_HEADER]: "the-token" }), opts);
    expect(res).toBeNull();
  });
});
