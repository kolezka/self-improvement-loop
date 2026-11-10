// The DeepSeek Harness adapter in dsh/ imports the published claude-plugin-dsh
// package instead of a vendored runtime copy. These tests load it the way a
// standalone install does: a copy of the plugin tree with no root node_modules,
// dependencies installed by a frozen Bun install inside dsh/.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DSH = join(ROOT, "dsh");
const RUNTIME = "claude-plugin-dsh";
const RUNTIME_VERSION = "0.1.0";

// Files the adapter reads at load time. The rest of the repo is not needed.
const PLUGIN_PARTS = [".claude-plugin", "skills", "commands", "hooks", "scripts/hook"];

const CHILD = `
import { createRequire } from "node:module";
const entry = new URL("./dsh/index.js", import.meta.url);
const { apply, name } = await import(entry.href);
// Resolved from the adapter's own directory, as its import is.
const resolved = createRequire(entry).resolve("${RUNTIME}");
const providers = [], commands = [], events = [], warnings = [];
const ctx = {
  logger: { warn: (m) => warnings.push(m) },
  skills: { registerProvider: (create) => providers.push(create({ signal: new AbortController().signal, invalidate() {} })) },
  commands: { register: (c) => commands.push(c) },
  systemPrompt: { section() {} },
  workingDirectory: { get: () => process.cwd() },
  inject: (_services, callback) => callback(ctx),
  effect() {},
  on: (event) => events.push(event),
};
await apply(ctx, {});
const skills = {};
for (const p of providers) for (const c of await p.list({})) skills[c.name] = (await p.get(c, {}))?.content ?? "";
const bodies = {};
for (const c of commands) {
  let text = "";
  const result = c.handler({ rawInput: "", agent: { followup: (m) => { text = m.content[0].text; } } });
  bodies[c.name] = { text, result };
}
console.log(JSON.stringify({ name, resolved, skills, commands: bodies, events, warnings }));
`;

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sil-dsh-"));
  for (const part of PLUGIN_PARTS) cpSync(join(ROOT, part), join(dir, part), { recursive: true });
  for (const entry of readdirSync(DSH)) {
    if (entry !== "node_modules") cpSync(join(DSH, entry), join(dir, "dsh", entry), { recursive: true });
  }
  writeFileSync(join(dir, "child.mjs"), CHILD);
  return dir;
}

// --no-install: Bun otherwise auto-installs a missing package from its global
// cache, which would hide a broken or missing dsh/node_modules.
function runChild(dir: string) {
  const run = Bun.spawnSync([process.execPath, "--no-install", "child.mjs"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

describe("dsh/ dependency contract", () => {
  const pkg = JSON.parse(readFileSync(join(DSH, "package.json"), "utf8"));
  const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

  test("depends on the exact published runtime and ships no vendored copy", () => {
    expect(pkg.dependencies).toEqual({ [RUNTIME]: RUNTIME_VERSION });
    expect(pkg.version).toBe(root.version);
    expect(pkg.files).toContain("bun.lock");
    expect(pkg.files).not.toContain("claude-compat.js");
    expect(existsSync(join(DSH, "claude-compat.js"))).toBe(false);
    const lock = readFileSync(join(DSH, "bun.lock"), "utf8");
    expect(lock).toContain(`"${RUNTIME}@${RUNTIME_VERSION}"`);
  });

  test("index.js imports the package by name and resolves the root itself", () => {
    const src = readFileSync(join(DSH, "index.js"), "utf8");
    expect(src).toContain(`import { createPlugin, rootFrom } from '${RUNTIME}'`);
    expect(src).toContain("root: rootFrom(import.meta.url)");
    expect(src).not.toMatch(/claude-compat/);
  });
});

describe("dsh/ adapter in a standalone copy", () => {
  let fixture: string;
  let installCode: number | null;
  let installErr = "";

  beforeAll(() => {
    fixture = makeFixture();
    const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], {
      cwd: join(fixture, "dsh"),
      stdout: "pipe",
      stderr: "pipe",
    });
    installCode = install.exitCode;
    installErr = install.stderr.toString();
  });
  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  test("registers the skill, commands and hooks from the installed runtime", () => {
    expect(installErr).not.toContain("error");
    expect(installCode).toBe(0);
    expect(existsSync(join(fixture, "node_modules"))).toBe(false);

    const run = runChild(fixture);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout);

    const installed = realpathSync(join(fixture, "dsh", "node_modules", RUNTIME));
    expect(realpathSync(out.resolved).startsWith(installed + "/")).toBe(true);
    const meta = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    expect(meta.version).toBe(RUNTIME_VERSION);

    expect(out.name).toBe("claude-compat-self-improvement-loop");
    expect(out.warnings).toEqual([]);

    const skillBody = readFileSync(join(ROOT, "skills", "self-improvement-loop", "SKILL.md"), "utf8");
    const skillLine = skillBody.split("\n---\n")[1]!.trim().split("\n")[0]!;
    expect(Object.keys(out.skills)).toEqual(["self-improvement-loop"]);
    expect(out.skills["self-improvement-loop"]).toContain(skillLine);

    const stems = readdirSync(join(ROOT, "commands")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
    expect(Object.keys(out.commands).sort()).toEqual(stems.map((s) => `sil-${s}`));
    const reflect = out.commands["sil-reflect"];
    expect(reflect.result).toEqual({ kind: "success", text: "/sil-reflect queued" });
    expect(reflect.text).toStartWith("<command-name>/self-improvement-loop:reflect</command-name>");
    const reflectBody = readFileSync(join(ROOT, "commands", "reflect.md"), "utf8").split("\n---\n")[1]!.trim().split("\n")[0]!;
    expect(reflect.text).toContain(reflectBody);

    expect(out.events).toEqual(expect.arrayContaining([
      "agent/created", "agent/pre-step", "tools/pre-execute", "tools/post-execute", "agent/turn-stopping", "agent/disposed",
    ]));
  }, 60_000);

  test("fails loudly when dsh/ dependencies are not installed", () => {
    const bare = makeFixture();
    try {
      const run = runChild(bare);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(`Cannot find package '${RUNTIME}'`);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
