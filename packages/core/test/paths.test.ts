// pluginRoot() resolution when CLAUDE_PLUGIN_ROOT is not set, which is every
// invocation that did not come from Claude Code: a scheduled worker, a shell,
// a systemd unit.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const PATHS_TS = join(REPO_ROOT, "packages", "core", "src", "paths.ts");
const SIL_SH = join(REPO_ROOT, "scripts", "sil");

let tmp: string;

beforeEach(() => {
  // realpath, because on macOS tmpdir() is /var/... and that is a symlink to
  // /private/var/.... pluginRoot() walks up from import.meta.dir, which the
  // module loader reports already resolved, so it returns the /private form
  // and a plain tmpdir() expectation never matches it.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "sil-paths-")));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Environment with CLAUDE_PLUGIN_ROOT genuinely absent, not blank: a blank
 * one takes a different branch in pluginRoot(). */
function envWithoutPluginRoot(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDE_PLUGIN_ROOT" || v === undefined) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function runBun(code: string, env: Record<string, string>, cwd: string): string {
  const proc = Bun.spawnSync(["bun", "-e", code], { stdout: "pipe", stderr: "pipe", env, cwd });
  const out = (proc.stdout ?? Buffer.alloc(0)).toString("utf8").trim();
  if (proc.exitCode !== 0) {
    throw new Error(`bun -e failed (${proc.exitCode}): ${(proc.stderr ?? Buffer.alloc(0)).toString("utf8")}`);
  }
  return out;
}

describe("pluginRoot without CLAUDE_PLUGIN_ROOT", () => {
  test("from the source tree, the builtin nudges dir is <repo>/nudges", () => {
    const out = runBun(
      `const p = await import(${JSON.stringify(PATHS_TS)}); console.log(p.builtinNudgesDir());`,
      envWithoutPluginRoot(),
      tmp,
    );
    expect(out).toBe(join(REPO_ROOT, "nudges"));
  });

  test("from a bundle next to the manifest, the builtin nudges dir is still <root>/nudges", () => {
    // What `bun run build` produces: paths.ts inlined into dist/*.js, one
    // level under the plugin root instead of three. Counting fixed levels up
    // from import.meta.dir lands two directories above the plugin; walking up
    // to .claude-plugin/plugin.json lands on it.
    const plugin = join(tmp, "plugin");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    mkdirSync(join(plugin, "dist"), { recursive: true });
    mkdirSync(join(plugin, "nudges"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "self-improvement-loop" }));
    copyFileSync(PATHS_TS, join(plugin, "dist", "paths.ts"));

    const out = runBun(
      `const p = await import(${JSON.stringify(join(plugin, "dist", "paths.ts"))}); console.log(p.builtinNudgesDir());`,
      envWithoutPluginRoot(),
      tmp,
    );
    expect(out).toBe(join(plugin, "nudges"));
  });

  test("CLAUDE_PLUGIN_ROOT still wins when it is set", () => {
    const out = runBun(
      `const p = await import(${JSON.stringify(PATHS_TS)}); console.log(p.builtinNudgesDir());`,
      envWithoutPluginRoot({ CLAUDE_PLUGIN_ROOT: join(tmp, "elsewhere") }),
      tmp,
    );
    expect(out).toBe(join(tmp, "elsewhere", "nudges"));
  });
});

describe("scripts/sil", () => {
  test("exports CLAUDE_PLUGIN_ROOT to the CLI it execs", () => {
    // Nothing sets it for a systemd or launchd unit, so the scheduled worker
    // and resolveRunner() were left guessing the root.
    const root = join(tmp, "plugin");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "cli.js"), 'console.log(process.env.CLAUDE_PLUGIN_ROOT ?? "<unset>");\n');

    // Run through `sh` rather than the shebang so the test never depends on,
    // or changes, the mode bit of a tracked file.
    const proc = Bun.spawnSync(["sh", SIL_SH], {
      stdout: "pipe",
      stderr: "pipe",
      env: envWithoutPluginRoot({ SIL_PLUGIN_ROOT: root }),
      cwd: tmp,
    });
    expect(proc.exitCode).toBe(0);
    expect((proc.stdout ?? Buffer.alloc(0)).toString("utf8").trim()).toBe(root);
  });
});
