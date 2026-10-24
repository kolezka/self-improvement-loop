// Acceptance fixture for the native console: synthetic loop state with two
// worlds, each with one staged curriculum proposal in its own git target.
//
// Usage: bun run scripts/native-console-fixture.ts <empty-root>
//
// <empty-root> must exist, be empty, and be named by its canonical path (on
// macOS, pass `realpath` of a mkdtemp dir: /var and /tmp are symlinks). Prints
// one JSON line, { root, pluginRoot, configDir }, and nothing else. pluginRoot
// is this checkout, for `claude --plugin-dir`. The rest of the layout is fixed
// under root; see docs/INSTALL.md.
//
// Nothing here calls a model or `sil init`, and every write lands under root:
// git and `sil hook-snapshot` run with the fixture's HOME and an empty global
// config, and the config keeps worker.auto_kick off. The bin/claude on the
// fixture PATH only records that it was called.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createControlFixture, FIXTURE_WORLD } from "../tests/control-fixture.ts";
import { ROOT } from "./build.ts";

export const NATIVE_FIXTURE_WORLD_TWO = "fixture-two";
export const NATIVE_FIXTURE_PATTERN = "probe-skill";
export const NATIVE_FIXTURE_PATTERN_TWO = "second-skill";

export interface NativeConsoleFixture {
  root: string;
  /** The plugin checkout the console runs from: this repo. */
  pluginRoot: string;
  /** SIL_CONFIG_DIR. */
  configDir: string;
  /** The allowlisted env the fixture's processes run with. */
  env: Record<string, string>;
  /** The first world's git target and its staged branch. */
  target: string;
  branch: string;
  /** SKILL.md as staged on `branch`. */
  skillBody: string;
  git(cwd: string, ...args: string[]): string;
  /** Commits a new revision of the first world's staged proposal. */
  reviseProposal(): void;
}

function skillText(name: string, description: string, lines: string[]): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${lines.join("\n")}\n`;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export function prepareNativeConsoleFixture(root: string): NativeConsoleFixture {
  const fx = createControlFixture({ root });
  const env = fx.env;
  const configDir = env["SIL_CONFIG_DIR"]!;
  const claudeDir = env["CLAUDE_CONFIG_DIR"]!;
  const target = join(root, "target");
  const targetTwo = join(root, "target-two");

  // Each world owns its own workspace, so a session started in one resolves
  // to that world, whichever is listed first. JSON is valid YAML.
  const worlds = [
    { name: FIXTURE_WORLD, target, repos: [join(root, "workspace")], claude_config_dir: claudeDir },
    { name: NATIVE_FIXTURE_WORLD_TWO, target: targetTwo, repos: [join(root, "workspace-two")], claude_config_dir: claudeDir },
  ];
  write(join(configDir, "config.yaml"), `${JSON.stringify({ version: 1, worlds, worker: { auto_kick: false } }, null, 2)}\n`);
  for (const w of worlds) mkdirSync(w.repos[0]!, { recursive: true });

  const git = (cwd: string, ...args: string[]): string => {
    const r = Bun.spawnSync(
      ["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd, env, stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
    return r.stdout.toString();
  };

  const stage = (dir: string, world: string, pattern: string, body: string): string => {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    write(join(dir, "README.md"), `fixture target for ${world}\n`);
    git(dir, "add", "README.md");
    git(dir, "commit", "-q", "-m", "base");
    const branch = `curriculum/${world}/${pattern}`;
    git(dir, "checkout", "-q", "-b", branch);
    write(join(dir, "skills", pattern, "SKILL.md"), body);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `stage ${pattern}`);
    git(dir, "checkout", "-q", "main");
    return branch;
  };

  // Long enough to need several diff and body pages, with non-ASCII text so a
  // byte/char mixup in paging shows.
  const lines = Array.from({ length: 700 }, (_, i) => `Krok ${i}: zażółć gęślą jaźń 😀 ${"✓".repeat(i % 40)}`);
  const skillBody = skillText(NATIVE_FIXTURE_PATTERN, "fixture", lines);
  const branch = stage(target, FIXTURE_WORLD, NATIVE_FIXTURE_PATTERN, skillBody);
  stage(targetTwo, NATIVE_FIXTURE_WORLD_TWO, NATIVE_FIXTURE_PATTERN_TWO, skillText(NATIVE_FIXTURE_PATTERN_TWO, "second world", ["Only in fixture-two."]));

  // The hook snapshot (state/hook-config.json) the session's hooks read to
  // pick a world. Written by its owning command through the plugin's own
  // pinned launcher, as the console's bridge runs it: built or source, the
  // same code. Its output is kept off this script's stdout; it starts no
  // worker and calls no model.
  const snap = Bun.spawnSync(["/bin/sh", join(ROOT, "scripts", "sil"), "hook-snapshot"], {
    cwd: join(root, "workspace"),
    env: { ...env, SIL_PLUGIN_ROOT: ROOT },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (snap.exitCode !== 0) throw new Error(`sil hook-snapshot failed (exit ${snap.exitCode})`);

  return {
    root,
    pluginRoot: ROOT,
    configDir,
    env,
    target,
    branch,
    skillBody,
    git,
    reviseProposal: () => {
      git(target, "checkout", "-q", branch);
      write(join(target, "skills", NATIVE_FIXTURE_PATTERN, "SKILL.md"), skillText(NATIVE_FIXTURE_PATTERN, "revised", ["new"]));
      git(target, "commit", "-q", "-am", `revise ${NATIVE_FIXTURE_PATTERN}`);
      git(target, "checkout", "-q", "main");
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    process.stderr.write("usage: bun run scripts/native-console-fixture.ts <empty-root>\n");
    process.exit(2);
  }
  try {
    const fx = prepareNativeConsoleFixture(args[0]!);
    process.stdout.write(`${JSON.stringify({ root: fx.root, pluginRoot: fx.pluginRoot, configDir: fx.configDir })}\n`);
  } catch (err) {
    process.stderr.write(`native-console-fixture: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
