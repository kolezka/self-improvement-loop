import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type JsonObject = Record<string, unknown>;
type HookGroup = { hooks: JsonObject[]; [key: string]: unknown };

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSettings(path: string): JsonObject {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return {};
  if (info.isSymbolicLink()) throw new Error("settings.json is a symlink; merge the standalone hooks into its target manually.");
  const invalid = () => new Error(`Invalid settings in ${path}; leaving it unchanged.`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(invalid().message, { cause: error });
  }
  if (!object(value)) throw invalid();
  if (Object.hasOwn(value, "enabledPlugins") && !object(value.enabledPlugins)) throw invalid();
  if (Object.hasOwn(value, "hooks")) {
    if (!object(value.hooks)) throw invalid();
    for (const groups of Object.values(value.hooks)) {
      if (!Array.isArray(groups)) throw invalid();
      for (const group of groups) {
        if (!object(group) || !Array.isArray(group.hooks) || !group.hooks.every(object)) throw invalid();
      }
    }
  }
  return value;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function installLocal(repo: string, env: Record<string, string | undefined> = process.env): string {
  const root = realpathSync(repo);
  const configDir = resolve(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"));
  const rootLink = join(configDir, "self-improvement-loop");
  for (const file of ["dist/hook.js", "dist/cli.js"]) {
    if (!existsSync(join(root, file))) throw new Error(`Missing ${file}; run bun install and bun run build first.`);
  }

  const settingsPath = join(configDir, "settings.json");
  const settings = readSettings(settingsPath);
  for (const [id, enabled] of Object.entries((settings.enabledPlugins ?? {}) as JsonObject)) {
    if (id.split("@")[0] === "self-improvement-loop" && enabled !== false) {
      throw new Error(`Disable ${id} before installing standalone hooks, then rerun install:local.`);
    }
  }

  const links = [{ source: root, target: rootLink }];
  for (const name of readdirSync(join(root, "commands")).sort()) {
    if (name.endsWith(".md")) links.push({ source: join(root, "commands", name), target: join(configDir, "commands", name) });
  }
  for (const entry of readdirSync(join(root, "skills"), { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(root, "skills", entry.name, "SKILL.md"))) {
      links.push({ source: join(root, "skills", entry.name), target: join(configDir, "skills", entry.name) });
    }
  }

  // Validate every destination before creating any links or changing settings.
  const missing = links.filter(({ source, target }) => {
    const info = lstatSync(target, { throwIfNoEntry: false });
    if (!info) return true;
    if (info.isSymbolicLink() && resolve(dirname(target), readlinkSync(target)) === source) return false;
    throw new Error(`Refusing to replace ${target}; move it aside before installing.`);
  });
  for (const dir of [configDir, join(configDir, "commands"), join(configDir, "skills")]) {
    const info = lstatSync(dir, { throwIfNoEntry: false });
    if (info && !statSync(dir).isDirectory()) throw new Error(`Refusing to replace ${dir}; expected a directory.`);
  }

  const manifest = JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8")) as { hooks: Record<string, HookGroup[]> };
  const prefix = `export CLAUDE_PLUGIN_ROOT=${quote(rootLink)} SIL_PLUGIN_ROOT=${quote(rootLink)}; `;
  const hooks = { ...((settings.hooks ?? {}) as Record<string, HookGroup[]>) };
  // Replace our old commands on upgrades, including events removed upstream.
  for (const [event, groups] of Object.entries(hooks)) {
    hooks[event] = groups.flatMap((group) => {
      const remaining = group.hooks.filter((hook) => !(hook.type === "command" && typeof hook.command === "string" && hook.command.startsWith(prefix)));
      if (remaining.length === group.hooks.length) return [group];
      return remaining.length ? [{ ...group, hooks: remaining }] : [];
    });
    if (groups.length && !hooks[event]!.length) delete hooks[event];
  }
  for (const [event, groups] of Object.entries(manifest.hooks)) {
    const existing = Object.hasOwn(hooks, event) ? [...hooks[event]!] : [];
    for (const group of groups) {
      const installed = {
        ...group,
        hooks: group.hooks.map((hook) => {
          if (hook.type !== "command" || typeof hook.command !== "string") throw new Error(`Unsupported hook in ${event}`);
          return { ...hook, command: prefix + hook.command };
        }),
      };
      if (!existing.some((entry) => JSON.stringify(entry) === JSON.stringify(installed))) existing.push(installed);
    }
    hooks[event] = existing;
  }
  const text = JSON.stringify({ ...settings, hooks }, null, 2) + "\n";

  mkdirSync(configDir, { recursive: true });
  for (const { source, target } of missing) {
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target);
  }
  if (!existsSync(settingsPath) || readFileSync(settingsPath, "utf8") !== text) {
    const temporary = join(configDir, `.sil-settings-${crypto.randomUUID()}.json`);
    try {
      writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
      renameSync(temporary, settingsPath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return configDir;
}

if (import.meta.main) {
  try {
    const configDir = installLocal(resolve(import.meta.dir, ".."));
    console.log(`Installed standalone symlinks in ${configDir}`);
    console.log("Restart Claude Code. Run scripts/sil status from this checkout, or scripts/sil init on a fresh setup.");
    console.log("Keep this checkout in place and rerun install:local after updating it.");
    console.log("Do not also enable the plugin. Native /sil and function hooks require the plugin; use /loop or sil web instead.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
