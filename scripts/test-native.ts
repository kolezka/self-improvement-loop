// Runs the hooks module's native engine tests: `claude plugin validate`, then
// `claude plugin test`, against a throwaway plugin folder.
//
// The folder holds only what the engine needs to load the module: the
// manifest, the state contract, the hook config, the freshly built module and
// the native tests. Never point `claude plugin test` at the repo root: it would
// pick up every Bun test in the monorepo.
//
// Native tests are named *.native.tsx so `bun test` skips them; they are copied
// here as *.test.tsx, the name `claude plugin test` looks for.
//
// A second throwaway plugin carries the transport probe: a test-only entry,
// apps/hook-module/native-test/transport/probe.ts, that imports the real
// control transport and answers one literal command, bundled with only the
// native tests beside it. Its root holds spaces and quotes. Nothing of it
// enters the shipped module.
//
// Usage: bun run scripts/test-native.ts [--validate-only] [--keep] [--types <file>]
//
// --types names the claude-code.d.ts the running engine wrote (the
// plugin-authoring skill prints its path). With it, the module source and the
// native tests are also typechecked against that file through
// apps/hook-module/tsconfig.native.json instead of the hand-kept subset in
// apps/hook-module/types. Without it that step is reported as skipped. The
// generated file is never copied into the repo.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLES, checkBundleSize, checkForbiddenModuleImports, ROOT } from "./build.ts";

const NATIVE_TEST_DIR = join(ROOT, "apps/hook-module/native-test");
const NATIVE_TSCONFIG = join(ROOT, "apps/hook-module/tsconfig.native.json");
const NATIVE_SUFFIX = ".native.tsx";
const MODULE_OUT = "hook-module.js";
const PROBE_TEST_DIR = join(NATIVE_TEST_DIR, "transport");
const PROBE_ENTRY = join(PROBE_TEST_DIR, "probe.ts");
const PROBE_OUT = "transport-probe.js";
/** The probe plugin's folder name: a launch that split or expanded its root
 * would fail on it. */
export const PROBE_PLUGIN_DIR = `transport probe "dq" 'sq'`;
const PROBE_MANIFEST = {
  name: "sil-transport-probe",
  version: "0.0.0",
  description: "Test-only probe of the self-improvement-loop control transport.",
};

const FIXTURE_README = `# self-improvement-loop native test fixture

A throwaway copy of the self-improvement-loop plugin, written by
scripts/test-native.ts so that claude plugin validate and claude plugin test can
load the hooks module in isolation. It holds the manifest, the state contract,
the hook config, the freshly built module and the native tests, and is deleted
when the run ends.
`;

// Passed through from the caller; everything else is replaced by paths under
// the fixture so the run cannot read or write the real home, Claude config or
// loop state.
const PASSTHROUGH_ENV = ["PATH", "TERM", "LANG", "LC_ALL"] as const;

export interface StepResult {
  step: string;
  argv: string[];
  exitCode: number;
}

export function nativeTestFiles(dir: string = NATIVE_TEST_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(NATIVE_SUFFIX))
    .sort();
}

/** The test file name `claude plugin test` discovers for a native source. */
export function copiedTestName(name: string): string {
  return `${name.slice(0, -NATIVE_SUFFIX.length)}.test.tsx`;
}

/** Bundles one sandbox entry and holds it to the hooks-module checks. */
async function bundleSandboxEntry(entry: string, outDir: string, out: string, target: "bun" | "browser"): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: outDir,
    naming: out,
    target,
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(String(log));
    throw new Error(`bundle failed: ${entry}`);
  }
  const outPath = join(outDir, out);
  checkForbiddenModuleImports(readFileSync(outPath, "utf8"), out);
  checkBundleSize(statSync(outPath).size, out);
  return outPath;
}

async function buildModule(outDir: string): Promise<string> {
  const spec = BUNDLES.find((b) => b.out === MODULE_OUT);
  if (!spec) throw new Error(`no bundle named ${MODULE_OUT} in scripts/build.ts`);
  return bundleSandboxEntry(join(ROOT, spec.entry), outDir, spec.out, spec.target ?? "bun");
}

/** Lays out the throwaway plugin and returns its root. */
export async function buildFixture(root: string): Promise<string> {
  const plugin = join(root, "plugin");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  mkdirSync(join(plugin, "tests"), { recursive: true });

  cpSync(join(ROOT, ".claude-plugin/plugin.json"), join(plugin, ".claude-plugin/plugin.json"));
  cpSync(join(ROOT, "hooks/hooks.json"), join(plugin, "hooks/hooks.json"));
  if (existsSync(join(ROOT, "types"))) cpSync(join(ROOT, "types"), join(plugin, "types"), { recursive: true });

  // hooks.json names ../dist/hook-module.js, so the module lands at the same
  // relative path inside the fixture.
  await buildModule(join(plugin, "dist"));

  const tests = nativeTestFiles();
  if (tests.length === 0) throw new Error(`no ${NATIVE_SUFFIX} files in ${NATIVE_TEST_DIR}`);
  for (const name of tests) cpSync(join(NATIVE_TEST_DIR, name), join(plugin, "tests", copiedTestName(name)));
  // The validator's catalog check refuses a plugin folder with no README, and
  // that line would sit among the diagnostics that matter. Not a product file.
  writeFileSync(join(plugin, "README.md"), FIXTURE_README);
  return plugin;
}

/** Lays out the transport probe plugin and returns its root: manifest, hook
 * config, the bundled probe and only the transport native tests. */
export async function buildProbeFixture(root: string): Promise<string> {
  const plugin = join(root, PROBE_PLUGIN_DIR);
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  mkdirSync(join(plugin, "tests"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin/plugin.json"), `${JSON.stringify(PROBE_MANIFEST, null, 2)}\n`);
  writeFileSync(join(plugin, "hooks/hooks.json"), `${JSON.stringify({ modules: [`../dist/${PROBE_OUT}`] }, null, 2)}\n`);
  await bundleSandboxEntry(PROBE_ENTRY, join(plugin, "dist"), PROBE_OUT, "browser");

  const tests = nativeTestFiles(PROBE_TEST_DIR);
  if (tests.length === 0) throw new Error(`no ${NATIVE_SUFFIX} files in ${PROBE_TEST_DIR}`);
  for (const name of tests) cpSync(join(PROBE_TEST_DIR, name), join(plugin, "tests", copiedTestName(name)));
  writeFileSync(join(plugin, "README.md"), FIXTURE_README);
  return plugin;
}

/** An environment built from the allowlist plus inert roots under `root`. */
export function isolatedEnv(root: string, source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH_ENV) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  const dirs = {
    HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    SIL_STATE_DIR: join(root, "sil/state"),
    SIL_DATA_DIR: join(root, "sil/data"),
    SIL_CONFIG_DIR: join(root, "sil/config"),
    TMPDIR: join(root, "tmp"),
  };
  for (const [name, dir] of Object.entries(dirs)) {
    mkdirSync(dir, { recursive: true });
    env[name] = dir;
  }
  return env;
}

/** The value after `--types`, or null. Throws when the flag has no file. */
export function typesArg(args: string[]): string | null {
  const at = args.indexOf("--types");
  if (at === -1) return null;
  const file = args[at + 1];
  if (!file || file.startsWith("--")) throw new Error("--types needs the path of a generated claude-code.d.ts");
  if (!existsSync(file)) throw new Error(`--types: no such file: ${file}`);
  return file;
}

/** A tsconfig under `root` that adds the generated declarations to the
 * native one. `include` in the base stays relative to the base. */
function writeTypecheckConfig(root: string, typesFile: string): string {
  const path = join(root, "tsconfig.native-check.json");
  writeFileSync(path, `${JSON.stringify({ extends: NATIVE_TSCONFIG, files: [typesFile] }, null, 2)}\n`);
  return path;
}

function run(step: string, argv: string[], env: Record<string, string>, cwd: string): StepResult {
  console.log(`$ ${argv.join(" ")}`);
  const proc = Bun.spawnSync(argv, { cwd, env, stdout: "inherit", stderr: "inherit" });
  const exitCode = proc.exitCode ?? 1;
  console.log(`[${step}] exit ${exitCode}`);
  return { step, argv, exitCode };
}

export async function main(args: string[]): Promise<number> {
  const validateOnly = args.includes("--validate-only");
  const keep = args.includes("--keep");
  const typesFile = typesArg(args);
  const root = mkdtempSync(join(tmpdir(), "sil-native-"));
  const results: StepResult[] = [];
  try {
    const plugin = await buildFixture(root);
    const env = isolatedEnv(root);

    if (typesFile) {
      const config = writeTypecheckConfig(root, typesFile);
      results.push(run("typecheck", ["bun", "x", "tsc", "-p", config], env, ROOT));
    } else {
      console.log("[typecheck] skipped: pass --types <generated claude-code.d.ts> to check against the real contract");
    }
    const validated = run("validate", ["claude", "plugin", "validate", plugin], env, root);
    results.push(validated);
    if (!validateOnly && validated.exitCode === 0) {
      results.push(run("test", ["claude", "plugin", "test", plugin], env, root));
    }

    const probe = await buildProbeFixture(root);
    const probeValidated = run("probe-validate", ["claude", "plugin", "validate", probe], env, root);
    results.push(probeValidated);
    if (!validateOnly && probeValidated.exitCode === 0) {
      results.push(run("probe-test", ["claude", "plugin", "test", probe], env, root));
    }
  } finally {
    if (keep) console.log(`fixture kept at ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
  for (const r of results) console.log(`${r.step}: exit ${r.exitCode}`);
  const failed = results.find((r) => r.exitCode !== 0);
  if (failed) return failed.exitCode;
  if (!validateOnly && !(results.some((r) => r.step === "test") && results.some((r) => r.step === "probe-test"))) return 1;
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
