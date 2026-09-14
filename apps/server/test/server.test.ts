// End to end HTTP tests: a real Bun.serve instance on an ephemeral port
// (port 0), hit with real fetch() calls. Covers the guard, every op route,
// error mapping and static file serving together, the way a browser would.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOps } from "@sil/ops";
import { LOCAL_HEADER, TOKEN_HEADER } from "../src/guard.ts";
import { createServer } from "../src/main.ts";

const TOKEN = "test-token-xyz";
let tmp: string;
let server: ReturnType<typeof createServer>;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-server-int-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_PLUGIN_ROOT"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
  const pluginRoot = process.env["CLAUDE_PLUGIN_ROOT"]!;
  const webRoot = join(pluginRoot, "dist", "web");
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>SIL_WEB_INDEX_MARKER");
  writeFileSync(join(pluginRoot, "package.json"), '{"name":"should-not-be-served"}');

  server = createServer({ port: 0, host: "127.0.0.1", token: TOKEN });
});

afterEach(() => {
  server.stop(true);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function base(): string {
  return `http://127.0.0.1:${server.port}`;
}

function goodHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { [LOCAL_HEADER]: "1", [TOKEN_HEADER]: TOKEN, ...extra };
}

describe("createServer host guard", () => {
  test("refuses 0.0.0.0, :: and *", () => {
    expect(() => createServer({ port: 0, host: "0.0.0.0", token: null })).toThrow();
    expect(() => createServer({ port: 0, host: "::", token: null })).toThrow();
    expect(() => createServer({ port: 0, host: "*", token: null })).toThrow();
  });
});

describe("GET /api/ops", () => {
  test("lists the same ops as the registry", async () => {
    const res = await fetch(`${base()}/api/ops`, { headers: goodHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string }[];
    expect(body.map((o) => o.name).sort()).toEqual(listOps().map((o) => o.name).sort());
  });

  test("is itself guarded", async () => {
    const res = await fetch(`${base()}/api/ops`);
    expect(res.status).toBe(401);
  });
});

describe("every op route", () => {
  test.each(listOps().map((op) => [op.name, op.tier] as const))("%s responds on its own path, never 404 or 405", async (name, tier) => {
    const path = "/api/" + name.replace(/\./g, "/");
    const method = tier === "read" ? "GET" : "POST";
    const init: RequestInit = { method, headers: goodHeaders() };
    if (method === "POST") {
      init.headers = { ...init.headers, "content-type": "application/json" };
      init.body = "{}";
    }
    const res = await fetch(`${base()}${path}`, init);
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(405);
  });
});

describe("request body cap", () => {
  test("an oversized POST to an authenticated op is refused with 413", async () => {
    // Uncapped, a body this size is buffered in the process that also runs the
    // worker. The cap is enforced before any handler sees the request.
    const res = await fetch(`${base()}/api/feedback/add`, {
      method: "POST",
      headers: goodHeaders({ "content-type": "application/json" }),
      body: "x".repeat(5 * 1024 * 1024),
    });

    expect(res.status).toBe(413);
  });

  test("a normal op body is still accepted", async () => {
    const res = await fetch(`${base()}/api/feedback/add`, {
      method: "POST",
      headers: goodHeaders({ "content-type": "application/json" }),
      body: "{}",
    });

    expect(res.status).not.toBe(413);
  });
});

describe("guard", () => {
  test("missing X-SIL-Local is rejected with 401", async () => {
    const res = await fetch(`${base()}/api/health/report`, { headers: { [TOKEN_HEADER]: TOKEN } });
    expect(res.status).toBe(401);
  });

  test("a wrong Host header is rejected with 403", async () => {
    const res = await fetch(`${base()}/api/health/report`, { headers: { ...goodHeaders(), host: "evil.test:1" } });
    expect(res.status).toBe(403);
  });

  test("a wrong token is rejected with 401", async () => {
    const res = await fetch(`${base()}/api/health/report`, { headers: { [LOCAL_HEADER]: "1", [TOKEN_HEADER]: "nope" } });
    expect(res.status).toBe(401);
  });

  test("good headers pass the guard", async () => {
    const res = await fetch(`${base()}/api/health/report`, { headers: goodHeaders() });
    expect(res.status).toBe(200);
  });
});

describe("error mapping", () => {
  test("a POST validation error maps to 400 with a detail message", async () => {
    const res = await fetch(`${base()}/api/config/set`, {
      method: "POST",
      headers: { ...goodHeaders(), "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    expect(typeof body.detail).toBe("string");
    expect(body.detail.length).toBeGreaterThan(0);
  });

  test("an unconfigured world maps ConfigError to 503", async () => {
    const res = await fetch(`${base()}/api/llm/status?world=no-such-world`, { headers: goodHeaders() });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { detail: string };
    expect(typeof body.detail).toBe("string");
  });

  test("a GET route ignores extra query params it does not need", async () => {
    const res = await fetch(`${base()}/api/health/report?bogus=1`, { headers: goodHeaders() });
    expect(res.status).toBe(200);
  });
});

describe("static", () => {
  test("serves the index at /, unguarded", async () => {
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("SIL_WEB_INDEX_MARKER");
  });

  test("does not serve the plugin's package.json through a traversal path", async () => {
    const res = await fetch(`${base()}/dist/web/../../package.json`);
    expect(res.status).toBe(404);
  });
});
