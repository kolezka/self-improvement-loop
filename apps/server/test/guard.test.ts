// Unit tests for the loopback guard: Host allowlist, the X-SIL-Local
// requirement, and a constant time token compare that tolerates unequal
// lengths instead of throwing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { allowedHosts, guard, LOCAL_HEADER, safeEqual, TOKEN_HEADER } from "../src/guard.ts";

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

  test("adds SIL_WEB_ALLOWED_HOSTS entries", () => {
    process.env["SIL_WEB_ALLOWED_HOSTS"] = "example.test:9999, other.test:9999 ,";
    const hosts = allowedHosts(9999);
    expect(hosts.has("example.test:9999")).toBe(true);
    expect(hosts.has("other.test:9999")).toBe(true);
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

  test("accepts the localhost host alias", async () => {
    const res = guard(req({ host: "localhost:9999", [LOCAL_HEADER]: "1", [TOKEN_HEADER]: "the-token" }), opts);
    expect(res).toBeNull();
  });
});
