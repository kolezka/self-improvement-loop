// Build dist/: single-file bundles for the hook, the CLI and the server, the
// Svelte UI, and a source hash so a test can catch drift.
//
// A plugin install has no install step, so the runtime needs a prebuilt dist/.
// It is not committed on main: .github/workflows/release.yml builds it and
// commits it on the release tag and the release branch. Locally, `make build`.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const DIST = join(ROOT, "dist");

export const BUNDLES: Array<{ entry: string; out: string; target?: "bun" | "browser" }> = [
  { entry: "apps/hook/src/main.ts", out: "hook.js" },
  { entry: "apps/cli/src/main.ts", out: "cli.js" },
  { entry: "apps/server/src/main.ts", out: "server.js" },
  // Gate evaluation runs out of process under a timeout; see @sil/nudges gate-runner.
  { entry: "packages/nudges/src/gate-runner.ts", out: "gate-runner.js" },
  // Claude Code's function-hooks module sandbox has no Node and no Bun
  // globals. "browser" does not refuse a "node:" import at bundle time: it
  // inlines a full polyfill for it instead (confirmed empirically: a
  // "node:crypto" import bundles to ~900KB with a "// node:crypto" header,
  // not a build error). checkForbiddenModuleImports() below catches that
  // case by its polyfill header instead, and checkBundleSize() catches the
  // size a stack of polyfills adds.
  { entry: "apps/hook-module/src/register.ts", out: "hook-module.js", target: "browser" },
];

// The module sandbox refuses these at load, so a bundle containing one is a
// hook that never runs. A "from \"node:...\"" specifier never survives
// bundling in either target (Bun always resolves and inlines or polyfills
// it), so checking for the specifier text would never trigger; the
// NODE_POLYFILL_HEADER_RE check below is what actually catches a stray node:
// import in the browser-target bundle.
const FORBIDDEN_MODULE_STRINGS = ["process.env", "Bun.", "import.meta.dir"];

// Bun's browser-target polyfill for a node: builtin starts with a comment
// naming it, e.g. "// node:crypto". Multiline so it matches anywhere in the
// bundle, not just at the start of the string.
const NODE_POLYFILL_HEADER_RE = /^\/\/ node:/m;

/** Throws when `code` contains anything the hooks module sandbox refuses. */
export function checkForbiddenModuleImports(code: string, label: string): void {
  for (const needle of FORBIDDEN_MODULE_STRINGS) {
    if (code.includes(needle)) throw new Error(`${label} contains forbidden module code: ${needle}`);
  }
  if (NODE_POLYFILL_HEADER_RE.test(code)) throw new Error(`${label} contains a node: builtin polyfill`);
}

// dist/hook-module.js was 49KB with no node: builtins pulled in. A node:
// polyfill adds tens to hundreds of KB (node:crypto alone bundles to ~900KB
// on its own), so a jump past this is a proxy for one having snuck in past
// checkForbiddenModuleImports, or for the entrypoint's own code bloating.
export const MAX_HOOK_MODULE_BYTES = 200 * 1024;

/** Throws when `bytes` exceeds `MAX_HOOK_MODULE_BYTES`. */
export function checkBundleSize(bytes: number, label: string): void {
  if (bytes > MAX_HOOK_MODULE_BYTES) {
    throw new Error(`${label} is ${bytes} bytes, over the ${MAX_HOOK_MODULE_BYTES} byte cap for the hooks module sandbox`);
  }
}

/** Every source file that feeds dist/, in a stable order. */
export function sourceFiles(): string[] {
  const roots = ["packages", "apps", "scripts/build.ts", "package.json", "bun.lock"];
  const out: string[] = [];
  const walk = (p: string) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      const name = p.split("/").pop()!;
      if (name === "node_modules" || name === "test" || name === "dist" || name === ".svelte-kit") return;
      for (const child of readdirSync(p).sort()) walk(join(p, child));
    } else if (/\.(ts|js|svelte|json|css|html|lock)$/.test(p) && !p.endsWith(".test.ts")) {
      out.push(relative(ROOT, p));
    }
  };
  for (const r of roots) walk(join(ROOT, r));
  return out;
}

export function sourceHash(): string {
  const h = createHash("sha256");
  for (const f of sourceFiles()) {
    h.update(f);
    h.update("\0");
    h.update(readFileSync(join(ROOT, f)));
    h.update("\0");
  }
  return h.digest("hex");
}

async function bundle(): Promise<void> {
  for (const b of BUNDLES) {
    const result = await Bun.build({
      entrypoints: [join(ROOT, b.entry)],
      outdir: DIST,
      naming: b.out,
      target: b.target ?? "bun",
      format: "esm",
      minify: false,
      sourcemap: "none",
    });
    if (!result.success) {
      for (const log of result.logs) console.error(String(log));
      throw new Error(`bundle failed: ${b.entry}`);
    }
    if (b.target === "browser") {
      const outPath = join(DIST, b.out);
      checkForbiddenModuleImports(readFileSync(outPath, "utf8"), `dist/${b.out}`);
      checkBundleSize(statSync(outPath).size, `dist/${b.out}`);
    }
    console.log(`built dist/${b.out}`);
  }
}

function buildWeb(): void {
  const webDist = join(DIST, "web");
  rmSync(webDist, { recursive: true, force: true });
  const proc = Bun.spawnSync(["bun", "run", "build"], { cwd: join(ROOT, "apps/web"), stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error("web build failed");
  if (!existsSync(join(webDist, "index.html"))) throw new Error("web build produced no dist/web/index.html");
  console.log("built dist/web");
}

if (import.meta.main) {
  mkdirSync(DIST, { recursive: true });
  await bundle();
  if (!process.argv.includes("--no-web")) buildWeb();
  writeFileSync(join(DIST, ".srchash"), sourceHash() + "\n");
  console.log("wrote dist/.srchash");
}
