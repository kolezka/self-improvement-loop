// The DeepSeek Harness adapter serves the sil console under /self-improvement-loop/
// on the DSH origin. These tests run the real route handler against a real
// `sil web` started from this checkout, in an isolated fixture.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlFixture, type ControlFixture } from "./control-fixture.ts";

const ROOT = join(import.meta.dir, "..");
const { CONSOLE_PREFIX, ConsoleProcess, respond, startSilWeb } = await import(join(ROOT, "dsh", "console.js"));

interface Harness {
  origin: string;
  close(): Promise<void>;
}

/** A stand-in for the DSH web server: one prefix route, the adapter's own handler. */
async function harness(pluginRoot: string, consoles: InstanceType<typeof ConsoleProcess>, rejection?: number): Promise<Harness> {
  const ctx = { connection: { requestRejection: () => rejection } };
  const server: Server = createServer((req, res) => {
    const pathname = new URL(String(req.url), "http://x").pathname;
    if (pathname !== CONSOLE_PREFIX && !pathname.startsWith(CONSOLE_PREFIX + "/")) {
      res.writeHead(404).end("not the console");
      return;
    }
    void respond(ctx, consoles, pluginRoot, req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("console route without a build", () => {
  let dir: string;
  let site: Harness;
  let started = 0;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sil-dsh-console-"));
    const consoles = new ConsoleProcess(dir, () => {
      started += 1;
      throw new Error("must not start");
    });
    site = await harness(dir, consoles);
  });
  afterAll(async () => {
    await site.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("redirects the bare prefix so relative paths resolve below it", async () => {
    const res = await fetch(`${site.origin}${CONSOLE_PREFIX}?x=1`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`${CONSOLE_PREFIX}/?x=1`);
  });

  test("explains how to build instead of starting a console with nothing to serve", async () => {
    const res = await fetch(`${site.origin}${CONSOLE_PREFIX}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("bun run build");
    expect((await fetch(`${site.origin}${CONSOLE_PREFIX}/assets/x.js`)).status).toBe(404);
    expect(started).toBe(0);
  });
});

describe("console route behind the DSH login", () => {
  test("a request DSH rejects never reaches the console", async () => {
    let started = 0;
    const consoles = new ConsoleProcess(ROOT, () => {
      started += 1;
      throw new Error("must not start");
    });
    const site = await harness(ROOT, consoles, 401);
    try {
      const res = await fetch(`${site.origin}${CONSOLE_PREFIX}/api/ops`, { headers: { "X-SIL-Local": "1" } });
      expect(res.status).toBe(401);
      expect(started).toBe(0);
    } finally {
      await site.close();
    }
  });
});

describe("console route forwarding to a real sil web", () => {
  let fx: ControlFixture;
  let pluginRoot: string;
  let consoles: InstanceType<typeof ConsoleProcess>;
  let site: Harness;

  beforeAll(async () => {
    fx = createControlFixture();
    // A plugin root whose dist/web is a tiny stand-in page: the server half is
    // under test here, not the Svelte build.
    pluginRoot = join(fx.root, "plugin");
    mkdirSync(pluginRoot);
    for (const part of ["scripts", "apps", "packages", "node_modules", "package.json", ".claude-plugin"]) {
      symlinkSync(join(ROOT, part), join(pluginRoot, part));
    }
    mkdirSync(join(pluginRoot, "dist", "web"), { recursive: true });
    writeFileSync(join(pluginRoot, "dist", "web", "index.html"), "<!doctype html><title>sil console</title>console page 5d1c");
    consoles = new ConsoleProcess(pluginRoot, (root: string) => startSilWeb(root, { ...fx.env, CLAUDE_PLUGIN_ROOT: root }));
    site = await harness(pluginRoot, consoles);
  });
  afterAll(async () => {
    await site.close();
    consoles.stop();
    fx.cleanup();
  });

  test("serves the console page and its API under the prefix", async () => {
    const page = await fetch(`${site.origin}${CONSOLE_PREFIX}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("console page 5d1c");

    const ops = await fetch(`${site.origin}${CONSOLE_PREFIX}/api/ops`, { headers: { "X-SIL-Local": "1" } });
    expect(ops.status).toBe(200);
    const names = ((await ops.json()) as Array<{ name: string }>).map((op) => op.name);
    expect(names).toContain("health.build");

    const build = await fetch(`${site.origin}${CONSOLE_PREFIX}/api/health/build`, { headers: { "X-SIL-Local": "1" } });
    expect(build.status).toBe(200);
    expect(typeof ((await build.json()) as { version?: unknown }).version).toBe("string");
  }, 30_000);

  test("keeps the console guard: no X-SIL-Local, no op", async () => {
    const res = await fetch(`${site.origin}${CONSOLE_PREFIX}/api/ops`);
    expect(res.status).toBe(401);
  }, 30_000);
});
