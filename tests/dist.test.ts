// dist/ is what the plugin actually runs (a plugin install has no install
// step). It is built, never committed on main: the release workflow builds it
// and commits it on the release tag. So these tests only run when a build is
// present, and then they check it has not drifted from source: every build
// input is hashed, and the hash must match dist/.srchash exactly.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkBundleSize, checkForbiddenModuleImports, DIST, MAX_HOOK_MODULE_BYTES, sourceHash } from "../scripts/build.ts";

const built = existsSync(join(DIST, ".srchash"));
if (!built) console.warn("dist/ not built: drift checks skipped, run `bun run build`");

describe.skipIf(!built)("dist/", () => {
  test("dist/.srchash matches the current source tree", () => {
    const recorded = readFileSync(join(DIST, ".srchash"), "utf8").trim();
    expect(recorded).toBe(sourceHash());
  });

  test.each(["hook.js", "cli.js", "server.js", "gate-runner.js", "hook-module.js"])("dist/%s exists", (name) => {
    expect(existsSync(join(DIST, name))).toBe(true);
  });

  test("dist/web/index.html exists", () => {
    expect(existsSync(join(DIST, "web", "index.html"))).toBe(true);
  });

  // dist/hook-module.js runs in the hooks-module sandbox, which has no Node and
  // no Bun globals. Bun's "browser" target does not refuse a node: import; it
  // inlines a full polyfill for it (confirmed empirically: a node:crypto
  // import bundles to ~900KB with a "// node:crypto" header), so a `from
  // "node:..."` specifier never reaches the built file whether or not the
  // source used it. checkForbiddenModuleImports catches that case by the
  // polyfill's header comment instead; the test below proves that check is
  // not vacuous.
  test("dist/hook-module.js has none of the forbidden strings", () => {
    const code = readFileSync(join(DIST, "hook-module.js"), "utf8");
    expect(() => checkForbiddenModuleImports(code, "dist/hook-module.js")).not.toThrow();
  });

  test("dist/hook-module.js is under the size cap", () => {
    const bytes = statSync(join(DIST, "hook-module.js")).size;
    expect(() => checkBundleSize(bytes, "dist/hook-module.js")).not.toThrow();
    expect(bytes).toBeLessThan(MAX_HOOK_MODULE_BYTES);
  });
});

describe("checkForbiddenModuleImports", () => {
  test.each(["process.env.FOO", "Bun.env.FOO", "import.meta.dir"])("throws on %s", (snippet) => {
    expect(() => checkForbiddenModuleImports(snippet, "test")).toThrow();
  });

  // A node: import specifier does not survive bundling (see the dist/ describe
  // block above), so it is not a useful positive control; a polyfill header,
  // which is what the built file actually contains, is.
  test("throws on a node: builtin polyfill header", () => {
    expect(() => checkForbiddenModuleImports('const x = 1;\n// node:crypto\nexport { x };', "test")).toThrow();
  });

  // Documents the finding driving this check's design: the bare specifier
  // text alone is not something checkForbiddenModuleImports can catch, since
  // it never appears in a real bundle.
  test("does not throw on a bare node: specifier (never survives bundling)", () => {
    expect(() => checkForbiddenModuleImports('from "node:fs";', "test")).not.toThrow();
  });

  test("does not throw on clean code", () => {
    expect(() => checkForbiddenModuleImports("export function register() {}", "test")).not.toThrow();
  });
});

describe("checkBundleSize", () => {
  test("throws when over the cap", () => {
    expect(() => checkBundleSize(MAX_HOOK_MODULE_BYTES + 1, "test")).toThrow();
  });

  test("does not throw at or under the cap", () => {
    expect(() => checkBundleSize(MAX_HOOK_MODULE_BYTES, "test")).not.toThrow();
  });
});
