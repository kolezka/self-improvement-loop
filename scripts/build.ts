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

export const BUNDLES: Array<{ entry: string; out: string }> = [
  { entry: "apps/hook/src/main.ts", out: "hook.js" },
  { entry: "apps/cli/src/main.ts", out: "cli.js" },
  { entry: "apps/server/src/main.ts", out: "server.js" },
  // Gate evaluation runs out of process under a timeout; see @sil/nudges gate-runner.
  { entry: "packages/nudges/src/gate-runner.ts", out: "gate-runner.js" },
];

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
      target: "bun",
      format: "esm",
      minify: false,
      sourcemap: "none",
    });
    if (!result.success) {
      for (const log of result.logs) console.error(String(log));
      throw new Error(`bundle failed: ${b.entry}`);
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
