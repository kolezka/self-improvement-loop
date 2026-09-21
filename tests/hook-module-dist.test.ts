// dist/hook-module.js is what Claude Code loads into the function-hooks
// sandbox: no Node, no Bun, no `process`, and no module resolution beyond what
// the bundle already contains. These checks are about that bundle, so they only
// run once `bun run build` has produced one.
//
// Bun's "browser" target does not refuse a node: import, it rewrites the
// specifier, so the built text is no evidence either way about node: and a
// check on it would be vacuous. Two checks stand in for it: the module's own
// sources name no node: specifier (positive control: paths.ts does), and the
// bundle carries no import statement at all, so nothing is left for the sandbox
// to resolve (positive control: dist/hook.js and dist/cli.js carry plenty).

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DIST, ROOT } from "../scripts/build.ts";

const MODULE_BUNDLE = join(DIST, "hook-module.js");
const built = existsSync(MODULE_BUNDLE) && existsSync(join(DIST, ".srchash"));
if (!built) console.warn("dist/ not built: hooks-module bundle checks skipped, run `bun run build`");

// A top-level ESM import as the bundler emits it: `import { x } from "fs"`.
const IMPORT_STATEMENT = /^import[\s{*"']/m;

function moduleSources(): string[] {
  const dir = join(ROOT, "apps/hook-module/src");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => join(dir, name));
}

describe("dist/hook-module.js", () => {
  test.skipIf(!built)("exports register as a function", async () => {
    const loaded = (await import(MODULE_BUNDLE)) as { register?: unknown };
    expect(typeof loaded.register).toBe("function");
  });

  test.skipIf(!built)("declares register as a top level function", () => {
    // `claude plugin validate .` refuses the bundle when register is exported
    // as anything else: "register is exported as "register", which is not a
    // function declared at the top of this file". Measured 2026-09-21 against
    // `export const register: Register = (on) => {...}`, which the bundler
    // emits as `var register = ...`.
    const bundle = readFileSync(MODULE_BUNDLE, "utf8");
    expect(bundle).toMatch(/^function register\(/m);
    expect(bundle).not.toMatch(/^var register =/m);
  });

  test.skipIf(!built)("carries none of the strings that survive bundling", () => {
    const bundle = readFileSync(MODULE_BUNDLE, "utf8");
    const control = readFileSync(join(DIST, "cli.js"), "utf8");
    for (const needle of ["process.env", "Bun.", "import.meta.dir"]) {
      // Positive control: the same needle in a bundle that is allowed to have
      // it, so an empty match here cannot be what makes the assertion pass.
      expect(control).toContain(needle);
      expect(bundle).not.toContain(needle);
    }
  });

  test.skipIf(!built)("carries no import statement for the sandbox to resolve", () => {
    expect(readFileSync(join(DIST, "hook.js"), "utf8")).toMatch(IMPORT_STATEMENT);
    expect(readFileSync(join(DIST, "cli.js"), "utf8")).toMatch(IMPORT_STATEMENT);
    expect(readFileSync(MODULE_BUNDLE, "utf8")).not.toMatch(IMPORT_STATEMENT);
  });
});

const SIL_SUBPATH = /^@sil\/(core|nudges)\/([A-Za-z0-9-]+)$/;

/** Every source file the module bundle pulls in, followed through relative and
 * @sil imports. The closure is what matters, not the module's own six files: a
 * node: import two hops down is just as fatal at load. */
function importClosure(): { files: string[]; specifiers: Set<string> } {
  const seen = new Set<string>();
  const specifiers = new Set<string>();
  const queue = moduleSources();
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/from ["']([^"']+)["']/g)) {
      const specifier = match[1] ?? "";
      if (specifier.startsWith(".")) {
        queue.push(join(file, "..", specifier));
        continue;
      }
      if (!specifier.startsWith("@sil/")) continue;
      specifiers.add(specifier);
      const parts = SIL_SUBPATH.exec(specifier);
      if (parts) queue.push(join(ROOT, "packages", parts[1] ?? "", "src", `${parts[2] ?? ""}.ts`));
    }
  }
  return { files: [...seen].sort(), specifiers };
}

describe("apps/hook-module sources", () => {
  test("nothing in the import closure names a node: builtin", () => {
    // Positive control: the check sees real content, and paths.ts (the Node
    // binding the module must never reach) does name node:.
    expect(readFileSync(join(ROOT, "packages/core/src/paths.ts"), "utf8")).toContain('from "node:');

    const { files } = importClosure();
    expect(files.length).toBeGreaterThan(moduleSources().length);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const needle of ['from "node:', "from 'node:", "require(", "process.env", "Bun."]) {
        if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the module imports only the @sil subpaths kept free of Node code", () => {
    const allowed = [
      "@sil/core/consts",
      "@sil/core/hook-snapshot",
      "@sil/core/layout",
      "@sil/core/lessons",
      "@sil/core/samples",
      "@sil/core/spool",
      "@sil/nudges/dispatch-core",
    ];
    const { specifiers } = importClosure();
    expect([...specifiers].sort()).toEqual(allowed);
  });
});
