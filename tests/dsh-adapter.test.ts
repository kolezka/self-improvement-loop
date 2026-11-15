// The DeepSeek Harness adapter in dsh/ imports the published claude-plugin-dsh
// package instead of a vendored runtime copy. These tests load it the way a
// standalone install does: a copy of the plugin tree with no root node_modules,
// dependencies installed by a frozen Bun install inside dsh/.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DSH = join(ROOT, "dsh");
const RUNTIME = "claude-plugin-dsh";
const RUNTIME_VERSION = "0.2.0";

// Files the adapter reads at load time. The rest of the repo is not needed.
const PLUGIN_PARTS = [".claude-plugin", "skills", "commands", "hooks", "scripts/hook", "scripts/sil"];

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

// Drives only the learned-artifact provider: lists for each cwd, loads every
// body, then retires one skill and waits for the watcher to invalidate.
const LEARNED_CHILD = `
const { apply } = await import(new URL("./dsh/index.js", import.meta.url).href);
const { rmSync } = await import("node:fs");
const [cwdA, cwdB, retire] = JSON.parse(process.argv[2]);
const providers = [];
let invalidated = 0;
const ac = new AbortController();
const ctx = {
  logger: { warn() {} },
  skills: { registerProvider: (create) => providers.push(create({ signal: ac.signal, invalidate: () => { invalidated++; } })) },
  commands: { register() {} },
  systemPrompt: { section() {} },
  webServer: { register() {} },
  inject: (_services, callback) => callback(ctx),
  effect() {},
  on() {},
};
await apply(ctx, { disable: ["skills", "agents", "commands", "instructions", "hooks"] });
const learned = providers.find((p) => p.name === "self-improvement-loop-learned");
const view = async (cwd) => {
  const out = {};
  for (const c of await learned.list({ cwd })) out[c.name] = (await learned.get(c, { cwd }))?.content ?? "";
  return out;
};
const a = await view(cwdA), b = await view(cwdB);
rmSync(retire);
for (let i = 0; i < 40 && invalidated === 0; i++) await new Promise((r) => setTimeout(r, 50));
const after = Object.keys(await view(cwdA));
ac.abort();
console.log(JSON.stringify({ providers: providers.map((p) => p.name), a, b, after, invalidated }));
process.exit(0);
`;

// --no-install: Bun otherwise auto-installs a missing package from its global
// cache, which would hide a broken or missing dsh/node_modules. The state dir
// is pinned so the user's real loop never leaks into a run.
function runChild(dir: string, script = "child.mjs", args: string[] = [], env: Record<string, string> = {}) {
  const run = Bun.spawnSync([process.execPath, "--no-install", script, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SIL_STATE_DIR: join(dir, "empty-state"), ...env },
  });
  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function writeWorld(root: string, name: string, skills: string[], agents: string[]) {
  const learned = join(root, "worlds", name, "learned");
  for (const s of skills) {
    mkdirSync(join(learned, "skills", s), { recursive: true });
    writeFileSync(join(learned, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: Use when ${s} applies.\n---\n\nBody of ${s}.\n`);
  }
  mkdirSync(join(learned, "agents"), { recursive: true });
  for (const a of agents) {
    writeFileSync(join(learned, "agents", `${a}.md`), `---\nname: ${a}\ndescription: Use for ${a}.\ntools: Read, Grep\n---\n\nRole of ${a}.\n`);
  }
  return learned;
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
    expect(src).toContain("const root = rootFrom(import.meta.url)");
    expect(src).toContain("createPlugin({ root, commands: { prefix: 'sil' } })");
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

  // DSH does not read ~/.claude/skills or ~/.claude/agents, where review links
  // accepted artifacts. The adapter must serve them from the world itself,
  // pick the world the way the hook does, and drop a retired one live.
  test("serves the loop's accepted skills and agents for the cwd's world", () => {
    const state = join(fixture, "learned-state");
    const repo = join(fixture, "work-repo");
    mkdirSync(repo, { recursive: true });
    const def = writeWorld(fixture, "default", ["alpha-skill", "beta-skill"], ["checker"]);
    const work = writeWorld(fixture, "work", ["work-skill"], []);
    // A retired skill keeps its directory but loses SKILL.md: not live.
    mkdirSync(join(def, "skills", "retired-skill"), { recursive: true });
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "hook-config.json"), JSON.stringify({
      version: 1,
      worlds: [
        { name: "default", repos: [], nudges_dir: join(def, "nudges"), rules_file: join(def, "RULES.md"), rules_inject: true },
        { name: "work", repos: [repo], nudges_dir: join(work, "nudges"), rules_file: join(work, "RULES.md"), rules_inject: true,
          skills_dir: join(work, "skills"), agents_dir: join(work, "agents") },
      ],
    }));
    writeFileSync(join(fixture, "learned-child.mjs"), LEARNED_CHILD);

    const args = [JSON.stringify([tmpdir(), repo, join(def, "skills", "beta-skill", "SKILL.md")])];
    const run = runChild(fixture, "learned-child.mjs", args, { SIL_STATE_DIR: state });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout);

    expect(out.providers).toEqual(["self-improvement-loop-learned"]);
    // Older snapshots carry no skills_dir: the directories next to RULES.md.
    expect(Object.keys(out.a)).toEqual(["alpha-skill", "beta-skill", "self-improvement-loop-agent-checker"]);
    expect(out.a["alpha-skill"]).toContain("Body of alpha-skill.");
    expect(out.a["self-improvement-loop-agent-checker"]).toContain("Role of checker.");
    expect(out.a["self-improvement-loop-agent-checker"]).toContain("Original tool allowlist: Read, Grep.");
    expect(Object.keys(out.b)).toEqual(["work-skill"]);
    expect(out.invalidated).toBeGreaterThan(0);
    expect(out.after).toEqual(["alpha-skill", "self-improvement-loop-agent-checker"]);
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
