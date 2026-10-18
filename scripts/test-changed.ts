// Run `bun test` only for workspaces touched since a base ref, plus every
// workspace that depends on a touched package. Anything outside apps/ and
// packages/ that is not pure docs runs the full suite.
//
//   bun run test:changed [--base <ref>] [--dry-run]

import { readdirSync } from "node:fs";
import { join } from "node:path";

export type Workspace = { dir: string; name: string; deps: string[] };
export type Plan =
  | { mode: "full"; reason: string }
  | { mode: "none" }
  | { mode: "workspaces"; workspaces: { dir: string; reason: string }[] };

// Paths with no tests behind them. README.md is not here: tests/plugin-manifest.test.ts scans it.
const DOCS_ONLY = /^(docs\/|\.claude\/|LICENSE$|(?!README\.md$)[^/]+\.md$)/;

export function planTests(changed: string[], workspaces: Workspace[]): Plan {
  const touched = new Set<string>();
  const outside: string[] = [];
  for (const path of changed) {
    const ws = workspaces.find((w) => path.startsWith(w.dir + "/"));
    if (ws) touched.add(ws.name);
    else if (!DOCS_ONLY.test(path)) outside.push(path);
  }
  if (outside.length > 0) {
    const shown = outside.slice(0, 5).join(", ") + (outside.length > 5 ? `, +${outside.length - 5} more` : "");
    return { mode: "full", reason: `changes outside a workspace: ${shown}` };
  }
  if (touched.size === 0) return { mode: "none" };

  // Walk dependents breadth first so each reason names the package that pulled it in.
  const reasons = new Map<string, string>();
  for (const name of touched) reasons.set(name, "changed");
  const queue = [...touched];
  while (queue.length > 0) {
    const dep = queue.shift()!;
    for (const w of workspaces) {
      if (reasons.has(w.name) || !w.deps.includes(dep)) continue;
      reasons.set(w.name, `depends on ${dep}`);
      queue.push(w.name);
    }
  }
  const selected = workspaces
    .filter((w) => reasons.has(w.name))
    .map((w) => ({ dir: w.dir, reason: reasons.get(w.name)! }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
  return { mode: "workspaces", workspaces: selected };
}

function git(root: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString();
}

async function readWorkspaces(root: string): Promise<Workspace[]> {
  const out: Workspace[] = [];
  for (const parent of ["apps", "packages"]) {
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = Bun.file(join(root, parent, entry.name, "package.json"));
      if (!(await file.exists())) continue;
      const pkg = await file.json();
      const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
      out.push({ dir: `${parent}/${entry.name}`, name: pkg.name, deps: Object.keys(all).filter((d) => d.startsWith("@sil/")) });
    }
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const baseIdx = args.indexOf("--base");
  const base = baseIdx >= 0 ? args[baseIdx + 1] : "origin/main";
  if (!base || base.startsWith("--")) {
    console.error("--base needs a ref");
    process.exit(2);
  }
  const root = join(import.meta.dir, "..");
  const mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  // Committed, staged, unstaged and untracked changes since the merge base.
  const changed = [
    ...new Set(
      [
        ...git(root, ["diff", "--name-only", mergeBase]).split("\n"),
        ...git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n"),
      ].filter(Boolean),
    ),
  ];
  const plan = planTests(changed, await readWorkspaces(root));

  console.log(`test:changed: ${changed.length} changed file(s) since ${base} (${mergeBase.slice(0, 9)})`);
  let cmd: string[];
  if (plan.mode === "none") {
    console.log("no workspace or code changes, nothing to test");
    process.exit(0);
  } else if (plan.mode === "full") {
    console.log(`full suite: ${plan.reason}`);
    cmd = ["bun", "test"];
  } else {
    for (const w of plan.workspaces) console.log(`  ${w.dir}  (${w.reason})`);
    // A leading ./ and trailing / make bun treat each as a path, so apps/hook does not match apps/hook-module.
    cmd = ["bun", "test", ...plan.workspaces.map((w) => `./${w.dir}/`)];
  }
  console.log(`$ ${cmd.join(" ")}`);
  if (dryRun) process.exit(0);
  const proc = Bun.spawnSync(cmd, { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
  process.exit(proc.exitCode ?? 1);
}
