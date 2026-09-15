// Static file serving: confined to dist/web, no dotfiles, no directory
// listing, index.html fallback for /, and a direct unit test of the
// traversal guard using a raw unnormalized path (a browser's URL parser
// would already collapse "..", this proves the server's own defense too).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStaticPath, serveStatic, staticRoot } from "../src/static.ts";

let tmp: string;
let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-server-static-"));
  saved["CLAUDE_PLUGIN_ROOT"] = process.env["CLAUDE_PLUGIN_ROOT"];
  process.env["CLAUDE_PLUGIN_ROOT"] = tmp;
  root = staticRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>t</title>SIL_WEB_INDEX_MARKER");
  writeFileSync(join(root, "app.js"), "console.log('hi')");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "sub", "file.txt"), "nested");
  writeFileSync(join(tmp, "package.json"), '{"name":"should-not-be-served"}');
});

afterEach(() => {
  if (saved["CLAUDE_PLUGIN_ROOT"] === undefined) delete process.env["CLAUDE_PLUGIN_ROOT"];
  else process.env["CLAUDE_PLUGIN_ROOT"] = saved["CLAUDE_PLUGIN_ROOT"];
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveStaticPath", () => {
  test("resolves a plain file under root", () => {
    expect(resolveStaticPath(root, "/app.js")).toBe(join(root, "app.js"));
  });

  test("resolves a nested file under root", () => {
    expect(resolveStaticPath(root, "/sub/file.txt")).toBe(join(root, "sub", "file.txt"));
  });

  test("refuses a raw traversal path even without URL level normalization", () => {
    expect(resolveStaticPath(root, "/../package.json")).toBeNull();
    expect(resolveStaticPath(root, "/sub/../../package.json")).toBeNull();
  });

  test("refuses a percent-encoded traversal path", () => {
    expect(resolveStaticPath(root, "/%2e%2e/package.json")).toBeNull();
  });

  test("refuses a dotfile", () => {
    expect(resolveStaticPath(root, "/.env")).toBeNull();
    expect(resolveStaticPath(root, "/sub/.secret")).toBeNull();
  });
});

describe("serveStatic", () => {
  test("serves index.html at /", async () => {
    const res = await serveStatic("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("SIL_WEB_INDEX_MARKER");
  });

  test("serves a real asset", async () => {
    const res = await serveStatic("/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("console.log");
  });

  test("404s a traversal attempt instead of leaking the plugin's package.json", async () => {
    const res = await serveStatic("/../package.json");
    expect(res.status).toBe(404);
  });

  test("404s a directory instead of listing it", async () => {
    const res = await serveStatic("/sub");
    expect(res.status).toBe(404);
  });

  test("404s a missing file", async () => {
    const res = await serveStatic("/nope.js");
    expect(res.status).toBe(404);
  });
});
