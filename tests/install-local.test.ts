import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installLocal } from "../scripts/install-local";

const ROOT = join(import.meta.dir, "..");
let tmp: string;
let repo: string;
let home: string;
let config: string;
let env: Record<string, string>;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "sil-local-")));
  repo = join(tmp, "repo with 'quotes' $dollar `ticks`");
  home = join(tmp, "home");
  config = join(tmp, "new config 'quoted' $dollar `ticks`");
  mkdirSync(home);
  mkdirSync(repo);
  for (const dir of ["commands", "skills", "hooks"]) cpSync(join(ROOT, dir), join(repo, dir), { recursive: true });
  mkdirSync(join(repo, "scripts"));
  for (const name of ["hook", "sil"]) cpSync(join(ROOT, "scripts", name), join(repo, "scripts", name));
  mkdirSync(join(repo, "dist"));
  const output = 'console.log(JSON.stringify({ root: process.env.CLAUDE_PLUGIN_ROOT, args: process.argv.slice(2) }));\n';
  writeFileSync(join(repo, "dist/hook.js"), output);
  writeFileSync(join(repo, "dist/cli.js"), output);
  env = { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function settings(): Record<string, any> {
  return JSON.parse(readFileSync(join(config, "settings.json"), "utf8"));
}

function seedSettings(value: unknown): string {
  mkdirSync(config, { recursive: true });
  const text = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(join(config, "settings.json"), text);
  return text;
}

function shell(command: string, extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync(["/bin/sh", "-c", command], {
    cwd: home,
    env: { ...env, ...extraEnv },
    stdin: new TextEncoder().encode("{}"),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

describe("standalone symlink installation", () => {
  test("creates repo, commands and skills links in a new custom config dir", () => {
    installLocal(repo, env);
    expect(lstatSync(join(config, "self-improvement-loop")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(config, "self-improvement-loop"))).toBe(repo);
    expect(realpathSync(join(config, "commands/loop.md"))).toBe(join(repo, "commands/loop.md"));
    expect(realpathSync(join(config, "skills/self-improvement-loop"))).toBe(join(repo, "skills/self-improvement-loop"));
    expect(existsSync(join(config, "plugins"))).toBe(false);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(Object.keys(settings().hooks).sort()).toEqual([
      "PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "SubagentStop", "UserPromptSubmit",
    ]);
  });

  test.each([undefined, ""])("falls back to HOME/.claude for CLAUDE_CONFIG_DIR=%p", (value) => {
    const environment = { ...env, CLAUDE_CONFIG_DIR: value };
    installLocal(repo, environment);
    expect(realpathSync(join(home, ".claude/self-improvement-loop"))).toBe(repo);
    expect(existsSync(config)).toBe(false);
  });

  test("preserves unrelated settings and hooks, and a second install is a no-op", () => {
    const original = { model: "custom", env: { KEEP: "yes" }, permissions: { allow: ["Read"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "user-hook" }] }] } };
    seedSettings(original);
    installLocal(repo, env);
    const first = readFileSync(join(config, "settings.json"), "utf8");
    installLocal(repo, env);
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe(first);
    expect(settings()).toMatchObject({ model: original.model, env: original.env, permissions: original.permissions });
    expect(settings().hooks.Stop[0]).toEqual(original.hooks.Stop[0]);
    expect(settings().hooks.Stop).toHaveLength(2);
  });

  test("upgrades owned hooks without duplication and preserves user hooks in the same group", () => {
    installLocal(repo, env);
    const before = settings();
    const userHook = { type: "command", command: "user-added-hook" };
    before.hooks.Stop[0].hooks.push(userHook);
    writeFileSync(join(config, "settings.json"), JSON.stringify(before));
    const manifestPath = join(repo, "hooks/hooks.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.hooks.Stop[0].hooks[0].timeout = 10;
    delete manifest.hooks.SubagentStop;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    installLocal(repo, env);
    const after = settings();
    expect(after.hooks.Stop.flatMap((group: any) => group.hooks)).toEqual([
      userHook, { ...before.hooks.Stop[0].hooks[0], timeout: 10 },
    ]);
    expect(after.hooks.SubagentStop).toBeUndefined();
    const once = readFileSync(join(config, "settings.json"), "utf8");
    installLocal(repo, env);
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe(once);
  });

  test("registered hooks run the linked checkout without plugin environment, even with shell metacharacters in paths", () => {
    installLocal(repo, env);
    for (const groups of Object.values(settings().hooks) as any[][]) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(JSON.parse(shell(hook.command))).toEqual({ root: join(config, "self-improvement-loop"), args: [] });
        }
      }
    }
  });

  test("slash command shell snippets find the linked checkout without CLAUDE_PLUGIN_ROOT", () => {
    installLocal(repo, env);
    const loop = readFileSync(join(config, "commands/loop.md"), "utf8");
    const status = loop.match(/```sh\n([^`]*?status --json)\n```/)?.[1];
    expect(status).toBeDefined();
    expect(JSON.parse(shell(status!))).toEqual({ root: join(config, "self-improvement-loop"), args: ["status", "--json"] });
    for (const name of ["learn", "toolify"]) {
      const text = readFileSync(join(config, `commands/${name}.md`), "utf8");
      const snippet = text.match(/```sh\n([^`]+)\n```/)?.[1];
      expect(snippet).toBeDefined();
      expect(shell(snippet!)).toBe(readFileSync(join(repo, `skills/self-improvement-loop/${name}.md`), "utf8"));
    }
  });

  test("plugin command rendering still resolves the literal plugin-root placeholder", () => {
    const plugin = join(tmp, "plugin");
    symlinkSync(repo, plugin);
    const loop = readFileSync(join(repo, "commands/loop.md"), "utf8");
    const snippet = loop.match(/```sh\n([^`]*?status --json)\n```/)?.[1];
    expect(snippet).toBeDefined();
    const rendered = snippet!.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin);
    expect(JSON.parse(shell(rendered))).toEqual({ root: plugin, args: ["status", "--json"] });
  });

  test("a copied CLI shim prefers the standalone link over an old marketplace install", () => {
    installLocal(repo, env);
    const shim = join(home, "sil");
    cpSync(join(repo, "scripts/sil"), shim);
    mkdirSync(join(config, "plugins"));
    writeFileSync(join(config, "plugins/installed_plugins.json"), JSON.stringify({ plugins: { "self-improvement-loop@old": [{ installPath: "/missing-cache", lastUpdated: "2099" }] } }));
    expect(JSON.parse(shell('sh "$HOME/sil" status --json'))).toEqual({ root: join(config, "self-improvement-loop"), args: ["status", "--json"] });
  });

  test.each(["self-improvement-loop", "commands/loop.md", "skills/self-improvement-loop"])("refuses an existing file at %s without partial installation", (path) => {
    const original = seedSettings({ model: "keep" });
    mkdirSync(dirname(join(config, path)), { recursive: true });
    writeFileSync(join(config, path), "keep me");
    expect(() => installLocal(repo, env)).toThrow("Refusing to replace");
    expect(readFileSync(join(config, path), "utf8")).toBe("keep me");
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe(original);
    expect(existsSync(join(config, "commands/curriculum.md"))).toBe(false);
  });

  test("refuses a foreign dangling symlink instead of treating it as absent", () => {
    mkdirSync(config);
    const target = join(tmp, "missing");
    symlinkSync(target, join(config, "self-improvement-loop"));
    expect(() => installLocal(repo, env)).toThrow("Refusing to replace");
    expect(readlinkSync(join(config, "self-improvement-loop"))).toBe(target);
    expect(existsSync(join(config, "settings.json"))).toBe(false);
  });

  test.each([null, [], { hooks: null }, { hooks: [] }, { hooks: { Stop: {} } }, { hooks: { Stop: [null] } }, { hooks: { Stop: [{ hooks: "bad" }] } }].map((value) => [value]))("rejects malformed settings %p without writing", (value) => {
    const original = seedSettings(value);
    expect(() => installLocal(repo, env)).toThrow("Invalid settings");
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe(original);
    expect(existsSync(join(config, "self-improvement-loop"))).toBe(false);
  });

  test("rejects invalid JSON rather than replacing it with defaults", () => {
    seedSettings({});
    writeFileSync(join(config, "settings.json"), "{broken");
    expect(() => installLocal(repo, env)).toThrow("Invalid settings");
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe("{broken");
    expect(existsSync(join(config, "self-improvement-loop"))).toBe(false);
  });

  test("refuses a settings symlink without changing its target", () => {
    mkdirSync(config);
    const target = join(tmp, "shared-settings.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(config, "settings.json"));
    expect(() => installLocal(repo, env)).toThrow("settings.json is a symlink");
    expect(readFileSync(target, "utf8")).toBe("{}");
    expect(readlinkSync(join(config, "settings.json"))).toBe(target);
  });

  test("requires disabling an enabled marketplace plugin before registering duplicate hooks", () => {
    const original = seedSettings({ enabledPlugins: { "self-improvement-loop@custom": true, "other@custom": true } });
    expect(() => installLocal(repo, env)).toThrow("Disable");
    expect(readFileSync(join(config, "settings.json"), "utf8")).toBe(original);
    expect(existsSync(join(config, "self-improvement-loop"))).toBe(false);
  });

  test("a disabled marketplace plugin does not block standalone installation", () => {
    seedSettings({ enabledPlugins: { "self-improvement-loop@custom": false, "other@custom": true } });
    installLocal(repo, env);
    expect(settings().enabledPlugins).toEqual({ "self-improvement-loop@custom": false, "other@custom": true });
    expect(realpathSync(join(config, "self-improvement-loop"))).toBe(repo);
  });

  test("a broken standalone link fails loudly instead of selecting another install", () => {
    mkdirSync(config);
    symlinkSync(join(tmp, "missing-checkout"), join(config, "self-improvement-loop"));
    const result = Bun.spawnSync(["/bin/sh", join(ROOT, "scripts/sil"), "status"], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("broken standalone installation");
    expect(result.stdout.toString()).toBe("");
  });

  test.skipIf(!existsSync(join(ROOT, "dist/hook.js")))("the CLI installer wires the real built CLI and SessionStart hook without a plugin", () => {
    const environment = {
      ...env,
      SIL_CONFIG_DIR: join(tmp, "config"),
      SIL_STATE_DIR: join(tmp, "state"),
      SIL_DATA_DIR: join(tmp, "data"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_CACHE_HOME: join(home, ".cache"),
    };
    const installed = Bun.spawnSync([process.execPath, join(ROOT, "scripts/install-local.ts")], { cwd: home, env: environment, stdout: "pipe", stderr: "pipe" });
    expect(installed.stderr.toString()).toBe("");
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout.toString()).toContain(`Installed standalone symlinks in ${config}`);
    const cli = Bun.spawnSync(["/bin/sh", join(config, "self-improvement-loop/scripts/sil"), "status", "--json"], { cwd: home, env: environment, stdout: "pipe", stderr: "pipe" });
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout.toString()).initialized).toBe(false);
    const command = settings().hooks.SessionStart[0].hooks[0].command;
    const hook = Bun.spawnSync(["/bin/sh", "-c", command], {
      cwd: home, env: environment, stdout: "pipe", stderr: "pipe",
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "SessionStart", session_id: "standalone-installer-e2e", source: "startup", cwd: home })),
    });
    expect(hook.exitCode).toBe(0);
    const context = JSON.parse(hook.stdout.toString()).hookSpecificOutput.additionalContext;
    expect(context).toContain(`"${join(config, "self-improvement-loop/scripts/sil")}" init`);
    expect(existsSync(join(config, "plugins"))).toBe(false);
  });

  test("missing build is an error before modifying the destination", () => {
    rmSync(join(repo, "dist/hook.js"));
    expect(() => installLocal(repo, env)).toThrow("bun run build");
    expect(existsSync(config)).toBe(false);
  });
});
