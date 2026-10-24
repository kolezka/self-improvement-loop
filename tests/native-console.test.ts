// The native console's read-only slice, end to end: the acceptance fixture
// script, then the console's own bridge (readControl, the plugin's
// scripts/sil, the built dist/cli.js) reading a real staged proposal from it.
//
// Fixture checks run from source. The bridge checks need `bun run build` and
// skip with a warning without it, like tests/dist.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { ControlRead, ControlResponse } from "@sil/core/control-protocol";
import type { EngineInterface } from "claude-code";
import { FakeEngine } from "../apps/hook-module/test/fake-engine.ts";
import { readControl } from "../apps/hook-module/src/ui/transport.ts";
import { dropState, ensureState } from "../apps/hook-module/src/state.ts";
import { DIST, ROOT } from "../scripts/build.ts";
import {
  NATIVE_FIXTURE_PATTERN,
  NATIVE_FIXTURE_PATTERN_TWO,
  NATIVE_FIXTURE_WORLD_TWO,
  prepareNativeConsoleFixture,
  type NativeConsoleFixture,
} from "../scripts/native-console-fixture.ts";
import { createControlFixture, FIXTURE_CLAUDE_MARKER, FIXTURE_WORLD } from "./control-fixture.ts";

const SCRIPT = join(ROOT, "scripts/native-console-fixture.ts");
const built = existsSync(join(DIST, "cli.js")) && existsSync(join(DIST, ".srchash"));
if (!built) console.warn("dist/ not built: native console bridge checks skipped, run `bun run build`");

/** Every path under `dir`, not following links: files by content hash, size
 * and mtime, dirs by mtime (so an empty dir and a created-then-removed file
 * both count), links by target. */
function inventory(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const info = lstatSync(path);
      const rel = relative(dir, path);
      if (info.isSymbolicLink()) entries[rel] = `link:${readlinkSync(path)}`;
      else if (info.isDirectory()) {
        entries[rel] = `dir:${info.mtimeMs}`;
        visit(path);
      } else entries[rel] = `file:${createHash("sha256").update(readFileSync(path)).digest("hex")}:${info.size}:${info.mtimeMs}`;
    }
  };
  visit(dir);
  return entries;
}

/** A fresh tmp dir by its canonical path: on macOS tmpdir() sits under /var,
 * itself a symlink to /private/var, and the fixture refuses symlinked roots. */
function canonicalTmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// The script's own env: a throwaway HOME and no Bun transpiler cache, so a run
// leaves nothing outside the dirs a test owns.
function scriptEnv(home: string): Record<string, string> {
  return { HOME: home, PATH: ["/usr/bin", "/bin"].join(":"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", NO_COLOR: "1" };
}

function runScript(args: string[], cwd: string, home: string): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd, env: scriptEnv(home), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("createControlFixture with an explicit root", () => {
  let base: string;
  beforeEach(() => {
    base = canonicalTmp("sil-native-root-");
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("seeds a canonical empty root in place and cleans only its contents", () => {
    const root = join(base, "owned root");
    mkdirSync(root);
    const fx = createControlFixture({ root });
    expect(fx.root).toBe(root);
    expect(fx.env["SIL_CONFIG_DIR"]).toBe(join(root, "config"));
    expect(readFileSync(join(root, "config/config.yaml"), "utf8")).toContain("auto_kick: false");
    fx.cleanup();
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  test("refuses a nonempty root and leaves it as it was", () => {
    const root = join(base, "taken");
    mkdirSync(join(root, "keep"), { recursive: true });
    writeFileSync(join(root, "keep/file.txt"), "user data\n");
    const before = inventory(root);
    expect(() => createControlFixture({ root })).toThrow(/not empty/);
    expect(inventory(root)).toEqual(before);
    expect(readdirSync(root)).toEqual(["keep"]);
  });

  test("refuses a root that is a symlink, or sits under one", () => {
    const real = join(base, "real");
    mkdirSync(join(real, "inner"), { recursive: true });
    symlinkSync(real, join(base, "link"));
    symlinkSync(join(real, "inner"), join(base, "inner-link"));
    expect(() => createControlFixture({ root: join(base, "inner-link") })).toThrow(/canonical/);
    expect(() => createControlFixture({ root: join(base, "link", "inner") })).toThrow(/canonical/);
    // Nothing was written through either link.
    expect(readdirSync(join(real, "inner"))).toEqual([]);
    // Positive control: the same dir by its own canonical path is accepted.
    const fx = createControlFixture({ root: join(real, "inner") });
    expect(readdirSync(join(real, "inner")).length).toBeGreaterThan(0);
    fx.cleanup();
  });

  test("the provider sentinel records a call under a root holding quotes, spaces and $", () => {
    // Regression: the marker path was pasted into single quotes, so a root
    // with a ' made the sentinel write nowhere and "no model call" vacuous.
    const root = join(base, `odd "dq" 'sq' $HOME root`);
    mkdirSync(root);
    const fx = createControlFixture({ root });
    const r = Bun.spawnSync([join(root, "bin", "claude"), "-p", "sentinel check"], { env: fx.env, stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(root, FIXTURE_CLAUDE_MARKER), "utf8")).toBe("-p sentinel check\n");
    fx.cleanup();
  });

  test("refuses a missing root, a relative one and a file", () => {
    writeFileSync(join(base, "a-file"), "x");
    expect(() => createControlFixture({ root: join(base, "missing") })).toThrow();
    expect(existsSync(join(base, "missing"))).toBe(false);
    expect(() => createControlFixture({ root: "relative/root" })).toThrow(/absolute/);
    expect(() => createControlFixture({ root: join(base, "a-file") })).toThrow(/directory/);
  });
});

describe("scripts/native-console-fixture.ts", () => {
  let base: string;
  let home: string;
  let elsewhere: string;
  beforeEach(() => {
    base = canonicalTmp("sil-native-cli-");
    home = join(base, "script home");
    elsewhere = join(base, "elsewhere");
    mkdirSync(home);
    mkdirSync(elsewhere);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("prints exactly root, pluginRoot and configDir for an empty root with spaces", () => {
    const root = join(base, `native root "dq" 'sq'`);
    mkdirSync(root);
    const r = runScript([root], elsewhere, home);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.endsWith("\n")).toBe(true);
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
    const printed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(printed).sort()).toEqual(["configDir", "pluginRoot", "root"]);
    expect(printed).toEqual({ root, pluginRoot: ROOT, configDir: join(root, "config") });

    // Written as JSON, which is valid YAML, so a test can read it without a YAML parser.
    const cfg = JSON.parse(readFileSync(join(root, "config/config.yaml"), "utf8")) as {
      worlds: { name: string; repos: string[]; target: string }[];
      worker: { auto_kick: boolean };
    };
    expect(cfg.worker.auto_kick).toBe(false);
    expect(cfg.worlds.map((w) => w.name)).toEqual([FIXTURE_WORLD, NATIVE_FIXTURE_WORLD_TWO]);
    expect(cfg.worlds[0]!.repos).toEqual([join(root, "workspace")]);
    expect(cfg.worlds[1]!.repos).toEqual([join(root, "workspace-two")]);
    // Seeded, not called: no model or provider was reached.
    expect(existsSync(join(root, FIXTURE_CLAUDE_MARKER))).toBe(false);
    // The script's own HOME got nothing but what it started with.
    expect(readdirSync(home)).toEqual([]);
  });

  test("refuses a nonempty root without touching it, and prints nothing", () => {
    const root = join(base, "taken");
    mkdirSync(root);
    writeFileSync(join(root, "keep.txt"), "user data\n");
    const before = inventory(root);
    const r = runScript([root], elsewhere, home);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("not empty");
    expect(inventory(root)).toEqual(before);
  });

  test("refuses a root under a symlink", () => {
    mkdirSync(join(base, "real", "inner"), { recursive: true });
    symlinkSync(join(base, "real"), join(base, "link"));
    const r = runScript([join(base, "link", "inner")], elsewhere, home);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("canonical");
    expect(readdirSync(join(base, "real", "inner"))).toEqual([]);
  });

  test("wants exactly one argument", () => {
    for (const args of [[], [join(base, "a"), join(base, "b")]]) {
      const r = runScript(args, elsewhere, home);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("usage");
    }
  });
});

// The two shell blocks in docs/INSTALL.md's fixture section, as written.
function installRecipes(): { setup: string; attended: string } {
  const text = readFileSync(join(ROOT, "docs/INSTALL.md"), "utf8");
  const from = text.indexOf("### An isolated fixture for trying the console");
  expect(from).toBeGreaterThan(-1);
  const section = text.slice(from, text.indexOf("\n## ", from));
  const blocks = [...section.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]!);
  expect(blocks).toHaveLength(2);
  return { setup: blocks[0]!, attended: blocks[1]! };
}

const CHECKOUT_PLACEHOLDER = "checkout=/path/to/self-improvement-loop";

describe("docs/INSTALL.md fixture recipes", () => {
  let base: string;
  let readerHome: string;
  let readerTmp: string;
  beforeEach(() => {
    base = canonicalTmp("sil-native-docs-");
    readerHome = join(base, "reader home");
    readerTmp = join(base, "reader tmp");
    mkdirSync(readerHome);
    mkdirSync(readerTmp);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  // Runs a recipe as a reader would, with the reader's own HOME and TMPDIR
  // standing in for the real ones.
  // The checkout is the cwd, as for someone following the docs from it.
  function runAsReader(script: string): { code: number; stdout: string; stderr: string } {
    const r = Bun.spawnSync(["/bin/sh", "-c", script], {
      cwd: ROOT,
      env: { HOME: readerHome, TMPDIR: readerTmp, PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":") },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  }

  test("the setup recipe seeds an empty root and writes nothing to the reader's HOME", () => {
    const { setup } = installRecipes();
    const r = runAsReader(setup.replace(CHECKOUT_PLACEHOLDER, `checkout='${ROOT}'`));
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const printed = JSON.parse(r.stdout) as { root: string; pluginRoot: string; configDir: string };
    expect(inventory(readerHome)).toEqual({});
    expect(Object.keys(printed).sort()).toEqual(["configDir", "pluginRoot", "root"]);
    expect(printed.pluginRoot).toBe(ROOT);
    expect(printed.root.startsWith(`${readerTmp}/`)).toBe(true);
    expect(existsSync(join(printed.root, "target/.git"))).toBe(true);
    expect(setup).toContain(CHECKOUT_PLACEHOLDER);
    // Only the recipe's own two mktemp dirs, the setup scratch and the root.
    expect(readdirSync(readerTmp).map((n) => n.replace(/\..*$/, "")).sort()).toEqual(["sil-native", "sil-setup"]);
  });

  test("positive control: a plain `bun run` of the script does write to the reader's HOME", () => {
    // What the recipe guards against: Bun's transpiler cache lands under HOME.
    const r = runAsReader(`root="$(realpath "$(mktemp -d "$TMPDIR/sil-plain.XXXXXX")")" && bun run '${ROOT}/scripts/native-console-fixture.ts' "$root"`);
    expect(r.code).toBe(0);
    expect(Object.keys(inventory(readerHome)).length).toBeGreaterThan(0);
  });

  test("the attended launch sets every isolated path the fixture's own processes use", () => {
    // Read, never run: launching claude is the attended check, not this test.
    const { attended } = installRecipes();
    const assigned: Record<string, string> = {};
    for (const m of attended.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=(?:"([^"]*)"|(\S+))/g)) assigned[m[1]!] = m[2] ?? m[3]!;
    const root = "/fixture-root";
    const fx = createControlFixture();
    try {
      // PATH is built at launch and NO_COLOR is a test nicety; every other
      // variable must point at the same place under root.
      for (const [key, value] of Object.entries(fx.env)) {
        if (key === "PATH" || key === "NO_COLOR") continue;
        expect([key, assigned[key]?.replaceAll("$root", root)]).toEqual([key, value.replace(fx.root, root)]);
      }
    } finally {
      fx.cleanup();
    }
    expect(assigned["PATH"]).toStartWith("$root/bin:");
    expect(assigned["CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"]).toBe("1");
    expect(attended).toContain("env -i ");
    expect(attended).toContain('--plugin-dir "$checkout"');
  });
});

// The session's ingestion (the hooks module's ensureState, reading the hook
// snapshot) and the console's host bootstrap (config.yaml) must agree on the
// world for each workspace, with the worker's auto start off. Needs no build:
// the fixture seeds the snapshot through scripts/sil, which runs source when
// there is no dist/.
describe("the acceptance fixture's ingestion snapshot", () => {
  let base: string;
  let fx: NativeConsoleFixture;
  const sessions: string[] = [];
  beforeEach(() => {
    base = canonicalTmp("sil-native-snapshot-");
    const root = join(base, `snapshot root "dq" 'sq'`);
    mkdirSync(root);
    fx = prepareNativeConsoleFixture(root);
  });
  afterEach(() => {
    for (const id of sessions.splice(0)) dropState(id);
    rmSync(base, { recursive: true, force: true });
  });

  test("host bootstrap and module ensureState pick the same world from each workspace", async () => {
    for (const [workspace, world] of [["workspace", FIXTURE_WORLD], ["workspace-two", NATIVE_FIXTURE_WORLD_TWO]] as const) {
      const cwd = join(fx.root, workspace);
      const request = { version: 1, requestId: `boot-${workspace}`, reads: [{ id: "b", op: "console.bootstrap", args: { cwd } }] };
      const p = Bun.spawnSync([process.execPath, join(ROOT, "apps/cli/src/main.ts"), "ops"], { cwd, env: fx.env, stdin: new TextEncoder().encode(JSON.stringify(request)), stdout: "pipe", stderr: "pipe" });
      expect(p.exitCode).toBe(0);
      const boot = JSON.parse(p.stdout.toString()) as { results: { b: { ok: boolean; value: { selectedWorld: string } } } };
      expect(boot.results.b.value.selectedWorld).toBe(world);

      const sessionId = `snapshot-${workspace}`;
      sessions.push(sessionId);
      const engine = new FakeEngine({ sessionId, cwd, pluginRoot: fx.pluginRoot, env: fx.env });
      const state = await ensureState(engine.$ as EngineInterface, sessionId, cwd);
      expect({ present: state?.snapshotPresent, world: state?.worldName, autoKick: state?.snapshot.worker.auto_kick }).toEqual({ present: true, world, autoKick: false });
    }
    const snapshotFile = join(fx.env["SIL_STATE_DIR"]!, "hook-config.json");
    const snapshot = JSON.parse(readFileSync(snapshotFile, "utf8")) as { plugin_root: string; worker: { auto_kick: boolean }; worlds: { name: string }[] };
    expect(snapshot.plugin_root).toBe(ROOT);
    expect(snapshot.worker.auto_kick).toBe(false);
    expect(snapshot.worlds.map((w) => w.name)).toEqual([FIXTURE_WORLD, NATIVE_FIXTURE_WORLD_TWO]);
    // Seeded, not called: no model or provider was reached.
    expect(existsSync(join(fx.root, FIXTURE_CLAUDE_MARKER))).toBe(false);
  });
});

// The console's real bridge: readControl launches `/bin/sh <root>/scripts/sil
// ops` by argv. The fake engine runs it for real with only the fixture's
// allowlisted env under the bridge's own `env`, as ProcessRunInit documents
// (the host env with `env` over it); process.env is never passed.
describe.skipIf(!built)("native console bridge against the acceptance fixture", () => {
  let base: string;
  let fx: NativeConsoleFixture;
  let seq = 0;

  beforeEach(() => {
    base = canonicalTmp("sil-native-e2e-");
    const root = join(base, `fixture root "dq" 'sq'`);
    mkdirSync(root);
    fx = prepareNativeConsoleFixture(root);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  async function read(reads: ControlRead[], cwd = join(fx.root, "workspace")): Promise<{ response: ControlResponse; engine: FakeEngine }> {
    const engine = new FakeEngine({ sessionId: "native-e2e", cwd, pluginRoot: fx.pluginRoot, realRun: { env: fx.env } });
    const response = await readControl(engine.$ as EngineInterface, { version: 1, requestId: `native-${++seq}`, reads });
    return { response, engine };
  }

  function value<T = unknown>(response: ControlResponse, id: string): T {
    const result = response.results[id];
    expect(result?.ok).toBe(true);
    return (result as { ok: true; value: T }).value;
  }

  async function readAll(part: "body" | "diff", world: string, pattern: string): Promise<{ text: string; digest: string; pages: number }> {
    const texts: string[] = [];
    let offset: number | null = 0;
    let digest: string | null = null;
    let pages = 0;
    while (offset !== null) {
      const args: Record<string, unknown> = { world, pattern, part, offset, limit: 200 };
      if (digest !== null) args["expectedState"] = digest;
      const { response } = await read([{ id: "p", op: "console.proposalPage", args }]);
      const page = value<{ text: string; nextOffset: number | null; reviewedState: string; complete: boolean }>(response, "p");
      digest ??= page.reviewedState;
      expect(page.reviewedState).toBe(digest);
      expect(new TextEncoder().encode(page.text).length).toBeLessThan(65536);
      texts.push(page.text);
      if (page.nextOffset === null) expect(page.complete).toBe(true);
      offset = page.nextOffset;
      pages += 1;
    }
    return { text: texts.join(""), digest: digest!, pages };
  }

  test("bootstrap resolves each world from its own workspace", async () => {
    const { response, engine } = await read([
      { id: "one", op: "console.bootstrap", args: { cwd: join(fx.root, "workspace") } },
      { id: "two", op: "console.bootstrap", args: { cwd: join(fx.root, "workspace-two") } },
    ]);
    expect(engine.runCalls[0]!.argv).toEqual(["/bin/sh", `${ROOT}/scripts/sil`, "ops"]);
    expect(engine.runCalls[0]!.init?.env).toEqual({ SIL_PLUGIN_ROOT: ROOT });
    const worlds = [FIXTURE_WORLD, NATIVE_FIXTURE_WORLD_TWO];
    expect(value<unknown>(response, "one")).toEqual({ worlds, selectedWorld: FIXTURE_WORLD, resolutionError: null, initialized: true });
    expect(value<unknown>(response, "two")).toEqual({ worlds, selectedWorld: NATIVE_FIXTURE_WORLD_TWO, resolutionError: null, initialized: true });
  });

  test("each world lists only its own staged proposal", async () => {
    const { response } = await read([
      { id: "one", op: "console.page", args: { world: FIXTURE_WORLD, kind: "review", offset: 0, limit: 10 } },
      { id: "two", op: "console.page", args: { world: NATIVE_FIXTURE_WORLD_TWO, kind: "review", offset: 0, limit: 10 } },
    ]);
    const one = value<{ total: number; items: { pattern: string }[] }>(response, "one");
    const two = value<{ total: number; items: { pattern: string }[] }>(response, "two");
    expect([one.total, one.items.map((i) => i.pattern)]).toEqual([1, [NATIVE_FIXTURE_PATTERN]]);
    expect([two.total, two.items.map((i) => i.pattern)]).toEqual([1, [NATIVE_FIXTURE_PATTERN_TWO]]);
  });

  // What a target repo is, as git reports it: every ref, HEAD, and the index
  // and worktree status. --no-optional-locks keeps the capture from
  // refreshing the index itself.
  function gitState(repo: string): string {
    return [
      fx.git(repo, "--no-optional-locks", "for-each-ref", "--format=%(refname) %(objectname)"),
      fx.git(repo, "--no-optional-locks", "symbolic-ref", "HEAD"),
      fx.git(repo, "--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignored"),
    ].join("\n");
  }

  // Everything the fixture owns: the whole root (targets and their .git,
  // workspaces, tmp, gitconfig included) plus each target's git view.
  // Git first on the way in and last on the way out, so a capture can never
  // be what changed the inventory.
  function ownedState(): { files: Record<string, string>; git: Record<string, string> } {
    const git = { target: gitState(fx.target), "target-two": gitState(join(fx.root, "target-two")) };
    return { files: inventory(fx.root), git };
  }

  // The guard this test used before review: six dirs, no targets. Kept only
  // to show the positive control below gets past it.
  function sixDirGuard(): Record<string, Record<string, string>> {
    return Object.fromEntries(["config", "state", "data", "claude", "home", "bin"].map((d) => [d, inventory(join(fx.root, d))]));
  }

  test("reads the staged body and diff at one digest, changes nothing, calls no model", async () => {
    // Expected bytes come from git before any read, not after.
    const expectedDiff = fx.git(fx.target, "diff", `main...${fx.branch}`).trim();
    const expectedBody = fx.git(fx.target, "show", `${fx.branch}:skills/${NATIVE_FIXTURE_PATTERN}/SKILL.md`);
    expect(expectedBody).toBe(fx.skillBody);
    const before = ownedState();
    expect(Object.keys(before.files)).toContain("target/.git/HEAD");
    expect(Object.keys(before.files)).toContain("workspace-two");
    expect(Object.keys(before.files)).toContain("gitconfig");

    const diff = await readAll("diff", FIXTURE_WORLD, NATIVE_FIXTURE_PATTERN);
    const body = await readAll("body", FIXTURE_WORLD, NATIVE_FIXTURE_PATTERN);
    const two = await readAll("diff", NATIVE_FIXTURE_WORLD_TWO, NATIVE_FIXTURE_PATTERN_TWO);

    // Compared right after the reads, before any control below writes.
    const after = ownedState();
    expect(after.git).toEqual(before.git);
    expect(after.files).toEqual(before.files);
    expect(existsSync(join(fx.root, FIXTURE_CLAUDE_MARKER))).toBe(false);

    // review.diff serves trimmed `git diff base...branch`: the pages rebuild exactly that.
    expect(diff.text).toBe(expectedDiff);
    expect(diff.pages).toBeGreaterThan(1);
    expect(diff.text).toContain(`+++ b/skills/${NATIVE_FIXTURE_PATTERN}/SKILL.md`);
    expect(diff.text).toContain("+Krok 699: zażółć gęślą jaźń");
    expect(body.digest).toBe(diff.digest);
    expect(body.text.trimEnd()).toBe(expectedBody.trimEnd());
    expect(body.text).toContain(`name: ${NATIVE_FIXTURE_PATTERN}`);
    expect(body.text).toContain("Krok 0: zażółć gęślą jaźń 😀");
    expect(two.text).toContain("+Only in fixture-two.");
    expect(two.text).not.toContain("Krok");
    expect(two.digest).not.toBe(diff.digest);

    // Positive control 1: an empty commit on the target's main. The staged diff
    // and the six-dir guard stay the same, the reviewed state moves, and only
    // the owned-state guard notices.
    const six = sixDirGuard();
    fx.git(fx.target, "commit", "--allow-empty", "-q", "-m", "positive control");
    expect(sixDirGuard()).toEqual(six);
    expect(fx.git(fx.target, "diff", `main...${fx.branch}`).trim()).toBe(expectedDiff);
    const moved = await readAll("diff", FIXTURE_WORLD, NATIVE_FIXTURE_PATTERN);
    expect(moved.digest).not.toBe(diff.digest);
    const control = ownedState();
    expect(control.git.target).not.toBe(after.git.target);
    expect(control.files).not.toEqual(after.files);

    // Positive control 2: the provider sentinel records a call when one is made.
    const sentinel = Bun.spawnSync([join(fx.root, "bin", "claude"), "-p", "control"], { env: fx.env });
    expect(sentinel.exitCode).toBe(0);
    expect(readFileSync(join(fx.root, FIXTURE_CLAUDE_MARKER), "utf8")).toContain("-p control");
  });

  test("refuses the old digest once the staged branch changes", async () => {
    const first = await read([
      { id: "p", op: "console.proposalPage", args: { world: FIXTURE_WORLD, pattern: NATIVE_FIXTURE_PATTERN, part: "diff", offset: 0, limit: 200 } },
    ]);
    const digest = value<{ reviewedState: string }>(first.response, "p").reviewedState;
    fx.reviseProposal();
    for (const part of ["diff", "body"] as const) {
      const { response } = await read([
        { id: "p", op: "console.proposalPage", args: { world: FIXTURE_WORLD, pattern: NATIVE_FIXTURE_PATTERN, part, offset: 0, limit: 200, expectedState: digest } },
      ]);
      const result = response.results["p"]!;
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.error.code).toBe("ProposalChanged");
    }
    // Read afresh, the new revision has a new digest and the new text.
    const fresh = await readAll("body", FIXTURE_WORLD, NATIVE_FIXTURE_PATTERN);
    expect(fresh.digest).not.toBe(digest);
    expect(fresh.text).toContain("description: revised");
  });
});
