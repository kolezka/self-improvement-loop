import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ledgerPath, loadConfig, targetRoot, worldNamed } from "@sil/core";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-artifacts-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** Seeds a promoted ledger row with no reflected sessions at all: the
 * simplest case for the rate columns, all three windows read as `n/a`. */
function seedPromotedRow(pattern: string): void {
  const cfg = loadConfig();
  const world = worldNamed(cfg, "default");
  const path = ledgerPath(world);
  mkdirSync(dirname(path), { recursive: true });
  const ledger = {
    version: 1,
    entries: {
      [pattern]: {
        pattern,
        status: "promoted",
        artifact_type: "skill",
        served_by: { type: "skill", path: `skills/${pattern}/SKILL.md` },
        promoted_at: "2026-09-01T00:00:00Z",
      },
    },
  };
  writeFileSync(path, JSON.stringify(ledger), "utf8");
}

async function artifactsText(): Promise<{ code: number; text: string }> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  let code: number;
  try {
    code = await run(["artifacts", "--world", "default"]);
  } finally {
    console.log = orig;
  }
  return { code, text: logs.join("\n") };
}

describe("sil artifacts", () => {
  test("shows the three rate windows for a promoted pattern, n/a with no reflected sessions", async () => {
    expect(await run(["init"])).toBe(0);
    seedPromotedRow("verify-callsites");

    const { code, text } = await artifactsText();

    expect(code).toBe(0);
    expect(text).toContain("verify-callsites");
    expect(text).toContain("rate baseline=n/a (0 sessions) since_promotion=n/a (0 sessions) since_revision=n/a (0 sessions)");
  });

  test("--json carries the scorecard rate fields", async () => {
    expect(await run(["init"])).toBe(0);
    seedPromotedRow("verify-callsites");

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await run(["artifacts", "--world", "default", "--json"]);
    } finally {
      console.log = orig;
    }

    expect(code).toBe(0);
    const payload = JSON.parse(logs.join("\n"));
    const row = payload.inventory.find((r: { pattern: string }) => r.pattern === "verify-callsites");
    expect(row.scorecard).toMatchObject({
      rate_baseline: { sessions: 0, hits: 0, rate: null },
      rate_since_promotion: { sessions: 0, hits: 0, rate: null },
      rate_since_revision: { sessions: 0, hits: 0, rate: null },
    });
  });
});

/** A promoted inline row whose artifact lives outside the target repo. Returns
 * that path, which the listing must print as served_by. */
function seedInlineRow(pattern: string): string {
  const world = worldNamed(loadConfig(), "default");
  const path = ledgerPath(world);
  const external = join(tmp, "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  const ledger = {
    version: 1,
    entries: {
      [pattern]: {
        pattern,
        status: "promoted",
        artifact_type: "skill",
        served_by: { type: "skill", path: null },
        promoted_at: "2026-09-01T00:00:00Z",
        origin: "inline",
        external_path: external,
        note: "grep every caller before answering no",
      },
    },
  };
  writeFileSync(path, JSON.stringify(ledger), "utf8");
  return external;
}

describe("sil artifacts listing of an inline row", () => {
  test("shows origin=inline and the external path", async () => {
    expect(await run(["init"])).toBe(0);
    const external = seedInlineRow("deny-without-grep");
    const { code, text } = await artifactsText();
    expect(code).toBe(0);
    expect(text).toContain("origin=inline");
    expect(text).toContain(`served_by=${external}`);
  });
});

// A real child process with a starting env built from tmp. Bun.spawnSync
// without an explicit env ignores later process.env edits, so git run inside
// this test process would read the operator's git config; the child's git
// starts from this env instead.
describe("sil artifacts register (child process)", () => {
  const CLI = join(import.meta.dir, "..", "src", "main.ts");
  const P = "deny-without-grep";
  let childEnv: Record<string, string>;

  beforeEach(() => {
    const home = join(tmp, "home");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(tmp, "claude"), { recursive: true });
    writeFileSync(join(tmp, "gitconfig"), "");
    childEnv = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: home,
      CLAUDE_CONFIG_DIR: join(tmp, "claude"),
      SIL_CONFIG_DIR: process.env["SIL_CONFIG_DIR"]!,
      SIL_STATE_DIR: process.env["SIL_STATE_DIR"]!,
      SIL_DATA_DIR: process.env["SIL_DATA_DIR"]!,
      GIT_CONFIG_GLOBAL: join(tmp, "gitconfig"),
      GIT_CONFIG_SYSTEM: join(tmp, "gitconfig"),
    };
  });

  function sil(...args: string[]): { code: number; out: string; err: string } {
    const proc = Bun.spawnSync([process.execPath, CLI, ...args], { env: childEnv, cwd: tmp });
    return { code: proc.exitCode ?? -1, out: proc.stdout.toString(), err: proc.stderr.toString() };
  }

  function gitIn(repo: string, ...args: string[]): string {
    const proc = Bun.spawnSync(["git", "-C", repo, ...args], { env: childEnv });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    return proc.stdout.toString().trim();
  }

  /** `sil init`, then the target repo and the skill file the operator wrote. */
  function ready(): { repo: string; file: string } {
    const init = sil("init");
    expect(init.code).toBe(0);
    const repo = targetRoot(worldNamed(loadConfig(), "default"));
    const file = join(tmp, "work", "skills", P, "SKILL.md");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `---\nname: ${P}\ndescription: Use when answering no\n---\nGrep every caller first.\n`);
    return { repo, file };
  }

  function snapshot(repo: string): { head: string; status: string; ledger: string | null } {
    const ledger = ledgerPath(worldNamed(loadConfig(), "default"));
    return {
      head: gitIn(repo, "rev-parse", "HEAD"),
      status: gitIn(repo, "status", "--porcelain", "--untracked-files=all"),
      ledger: existsSync(ledger) ? readFileSync(ledger, "utf8") : null,
    };
  }

  test("registers a skill: exit 0, one commit, an inline row", () => {
    const { repo, file } = ready();
    const before = gitIn(repo, "rev-parse", "HEAD");
    const r = sil("artifacts", "register", "--world", "default", "--type", "skill", "--pattern", P, "--path", file, "--note", "grep every caller");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`registered skill:${P} in world default, commit `);
    expect(gitIn(repo, "rev-list", "--count", `${before}..HEAD`)).toBe("1");
    expect(gitIn(repo, "status", "--porcelain")).toBe("");
    const row = JSON.parse(readFileSync(ledgerPath(worldNamed(loadConfig(), "default")), "utf8")).entries[P];
    expect(row).toMatchObject({ origin: "inline", status: "promoted", external_path: realpathSync(file), note: "grep every caller" });
  });

  test("a dry run prints the row as JSON and changes nothing", () => {
    const { repo, file } = ready();
    const state = snapshot(repo);
    const r = sil("artifacts", "register", "--world", "default", "--type", "skill", "--pattern", P, "--path", file, "--note", "n", "--dry-run", "--json");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.commit).toBeNull();
    expect(out.row).toMatchObject({ origin: "inline", external_path: realpathSync(file) });
    expect(snapshot(repo)).toEqual(state);
  });

  test("a refusal from register exits 1 with its message and changes nothing", () => {
    const { repo } = ready();
    const state = snapshot(repo);
    const missing = join(tmp, "work", "nope.md");
    const r = sil("artifacts", "register", "--world", "default", "--type", "skill", "--pattern", P, "--path", missing, "--note", "n");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`error: ${missing} does not exist`);
    expect(snapshot(repo)).toEqual(state);
  });

  test("an unknown --type exits 2 and names the flag", () => {
    const r = sil("artifacts", "register", "--world", "default", "--type", "macro", "--pattern", P, "--path", "/x", "--note", "n");
    expect(r.code).toBe(2);
    expect(r.err).toContain("--type must be one of rule, skill, agent, hook");
  });

  test("a missing --path or --note exits 2", () => {
    const r = sil("artifacts", "register", "--world", "default", "--type", "skill", "--pattern", P);
    expect(r.code).toBe(2);
    expect(r.err).toContain("needs --pattern, --path and --note");
  });

  test("an unknown action exits 2", () => {
    const r = sil("artifacts", "frobnicate", "--world", "default");
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown action "frobnicate"');
  });

  test.each([
    [["artifacts", "--world", "default", "--type", "skill"], "--type"],
    [["artifacts", "rebuild", "--world", "default", "--dry-run"], "--dry-run"],
  ])("a register-only flag without register exits 2 and names it (%p)", (argv, flag) => {
    const r = sil(...argv);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`${flag} is only valid with sil artifacts register`);
  });
});

describe("sil artifacts relink", () => {
  async function capture(argv: string[]): Promise<{ code: number; text: string }> {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await run(argv);
    } finally {
      console.log = orig;
    }
    return { code, text: logs.join("\n") };
  }

  function seedLiveSkill(pattern: string, claudeDir: string): void {
    seedPromotedRow(pattern);
    const cfgPath = join(process.env["SIL_CONFIG_DIR"]!, "config.yaml");
    const text = readFileSync(cfgPath, "utf8").replace("claude_config_dir: null", `claude_config_dir: ${claudeDir}`);
    writeFileSync(cfgPath, text, "utf8");
    const world = worldNamed(loadConfig(), "default");
    const skill = join(targetRoot(world), "skills", pattern, "SKILL.md");
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, "---\nname: x\n---\n", "utf8");
  }

  test("links live skills into the world's claude_config_dir, not CLAUDE_CONFIG_DIR", async () => {
    expect(await run(["init"])).toBe(0);
    const worldDir = join(tmp, "world-claude");
    const envDir = join(tmp, "env-claude");
    seedLiveSkill("demo-skill", worldDir);
    const prev = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = envDir;
    try {
      const dry = await capture(["artifacts", "relink", "--world", "default", "--dry-run"]);
      expect(dry.code).toBe(0);
      expect(dry.text).toContain("demo-skill");
      expect(existsSync(join(worldDir, "skills", "demo-skill"))).toBe(false);

      const real = await capture(["artifacts", "relink", "--world", "default"]);
      expect(real.code).toBe(0);
      expect(realpathSync(join(worldDir, "skills", "demo-skill"))).toBe(realpathSync(join(targetRoot(worldNamed(loadConfig(), "default")), "skills", "demo-skill")));
      expect(existsSync(join(envDir, "skills", "demo-skill"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = prev;
    }
  });

  test("needs --world", async () => {
    expect(await run(["init"])).toBe(0);
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
    try {
      expect(await run(["artifacts", "relink"])).toBe(2);
    } finally {
      console.error = orig;
    }
  });
});
