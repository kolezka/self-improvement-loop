import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Config, fsx, paths, RULE_END, RULE_START, World } from "@sil/core";
import { listLessons, loadEntry, putLesson, writeEntry } from "@sil/store";
import {
  applyBlock,
  BLOCK_END,
  BLOCK_START,
  enablePlugin,
  enqueueSession,
  findSession,
  installIntegration,
  listSessions,
  paths as ocPaths,
  pluginEnabled,
  renderBlock,
  scanSessions,
  sessionCwd,
  syncWorkspace,
} from "../src/index.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

let tmp: string;
let ocDir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "OPENCLAW_CONFIG_DIR", "OPENCLAW_WORKSPACE_DIR", "CLAUDE_PLUGIN_ROOT"];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-openclaw-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["SIL_CONFIG_DIR"] = join(tmp, "config");
  process.env["SIL_STATE_DIR"] = join(tmp, "state");
  process.env["SIL_DATA_DIR"] = join(tmp, "data");
  process.env["CLAUDE_PLUGIN_ROOT"] = REPO_ROOT;
  delete process.env["OPENCLAW_WORKSPACE_DIR"];
  ocDir = join(tmp, "openclaw");
  process.env["OPENCLAW_CONFIG_DIR"] = ocDir;
  mkdirSync(ocDir, { recursive: true });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function writeOpenclawConfig(value: Record<string, unknown>): void {
  fsx.writeJson(join(ocDir, "openclaw.json"), value);
}

/** One OpenClaw session transcript on disk. */
function writeSession(agentId: string, sessionId: string, cwd: string | null): string {
  const dir = join(ocDir, "agents", agentId, "sessions");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const lines: string[] = [];
  if (cwd) lines.push(JSON.stringify({ type: "session", id: sessionId, cwd, version: "2026.2.26" }));
  lines.push(JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }));
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

describe("paths", () => {
  test("OPENCLAW_CONFIG_DIR wins", () => {
    expect(ocPaths.openclawDir()).toBe(ocDir);
    expect(ocPaths.pluginDir()).toBe(join(ocDir, "extensions", "self-improvement-loop"));
  });

  test("workspace comes from openclaw.json, else the default dir", () => {
    expect(ocPaths.workspaceDir()).toBe(join(ocDir, "workspace"));
    writeOpenclawConfig({ agents: { defaults: { workspace: join(tmp, "ws") } } });
    expect(ocPaths.workspaceDir()).toBe(join(tmp, "ws"));
  });

  test("a relative workspace resolves against the openclaw dir", () => {
    writeOpenclawConfig({ agents: { defaults: { workspace: "shared" } } });
    expect(ocPaths.workspaceDir()).toBe(join(ocDir, "shared"));
  });
});

describe("sessions", () => {
  test("lists transcripts with the cwd from the header", () => {
    writeSession("main", "s1", join(tmp, "repo-a"));
    writeSession("side", "s2", join(tmp, "repo-b"));
    const sessions = listSessions();
    expect(sessions.map((s) => s.session_id).sort()).toEqual(["s1", "s2"]);
    expect(findSession("s1")?.cwd).toBe(join(tmp, "repo-a"));
    expect(findSession("s2")?.agent_id).toBe("side");
  });

  test("a headerless transcript falls back to the workspace", () => {
    writeSession("main", "s3", null);
    expect(findSession("s3")?.cwd).toBe(ocPaths.workspaceDir());
  });

  test("an agent filter that does not match finds nothing", () => {
    writeSession("main", "s1", tmp);
    expect(findSession("s1", "other")).toBeNull();
  });

  test("sessionCwd tolerates a torn first line", () => {
    const path = join(tmp, "torn.jsonl");
    writeFileSync(path, '{"type":"session","id":"x","cw', "utf8");
    expect(sessionCwd(path)).toBeNull();
  });
});

describe("enqueueSession", () => {
  const cfg = () => Config.parse({});

  test("queues a session and marks it ended", () => {
    const file = writeSession("main", "s1", tmp);
    const result = enqueueSession(cfg(), findSession("s1")!, { ended: true });

    expect(result.status).toBe("queued");
    expect(result.world).toBe("default");
    const entry = loadEntry("pending", "s1");
    expect(entry?.ended).toBe(true);
    expect(entry?.transcript_path).toBe(file);
    expect(entry?.stops).toBe(1);
  });

  test("a second call updates the same entry", () => {
    writeSession("main", "s1", tmp);
    enqueueSession(cfg(), findSession("s1")!);
    const second = enqueueSession(cfg(), findSession("s1")!, { ended: true });

    expect(second.status).toBe("updated");
    const entry = loadEntry("pending", "s1");
    expect(entry?.stops).toBe(2);
    expect(entry?.ended).toBe(true);
  });

  test("an already reflected session is not queued again", () => {
    writeSession("main", "s1", tmp);
    const first = enqueueSession(cfg(), findSession("s1")!);
    const entry = loadEntry("pending", "s1")!;
    writeEntry("done", entry);
    rmSync(join(paths.queueDir("pending"), "s1.json"), { force: true });

    const again = enqueueSession(cfg(), findSession("s1")!);
    expect(first.status).toBe("queued");
    expect(again.status).toBe("skipped");
    expect(again.reason).toBe("already done");
    expect(loadEntry("pending", "s1")).toBeNull();
  });

  test("scan skips transcripts older than --max-age-hours", () => {
    const old = writeSession("main", "s1", tmp);
    writeSession("main", "s2", tmp);
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
    utimesSync(old, twoDaysAgo, twoDaysAgo);

    expect(scanSessions(cfg(), { maxAgeHours: 24 }).map((r) => r.session_id)).toEqual(["s2"]);
    // 0 means no age limit, so the old one comes back.
    expect(scanSessions(cfg(), { maxAgeHours: 0 }).map((r) => r.session_id).sort()).toEqual(["s1", "s2"]);
  });
});

describe("workspace sync", () => {
  const lesson = (id: string, text: string) => ({
    id,
    world: "default",
    pattern: "verify-callsites",
    text,
    created: `2026-09-1${id.slice(-1)}T00:00:00Z`,
    reflection_id: `r-${id}`,
    repo: null,
    deliveries: 0,
  });

  function worldWithRules(rules: string): World {
    const target = join(tmp, "target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "RULES.md"), `head\n${RULE_START}\n${rules}\n${RULE_END}\ntail\n`, "utf8");
    return World.parse({ name: "default", target });
  }

  test("writes rules and lessons, and counts the delivery", () => {
    const world = worldWithRules("- always verify call sites");
    putLesson(lesson("l1", "Check every call site before calling a change safe."));
    const workspace = join(tmp, "ws");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "AGENTS.md"), "# workspace\n\nhand written\n", "utf8");

    const result = syncWorkspace(world, { workspace });
    const text = readFileSync(result.path, "utf8");

    expect(result.lessons).toEqual(["l1"]);
    expect(text).toContain("hand written");
    expect(text).toContain("always verify call sites");
    expect(text).toContain("Check every call site");
    expect(listLessons("default")[0]?.deliveries).toBe(1);
  });

  test("a second sync replaces the block instead of appending", () => {
    const world = worldWithRules("- rule one");
    const workspace = join(tmp, "ws");
    mkdirSync(workspace, { recursive: true });

    syncWorkspace(world, { workspace });
    syncWorkspace(world, { workspace });
    const text = readFileSync(join(workspace, "AGENTS.md"), "utf8");

    expect(text.split(BLOCK_START).length - 1).toBe(1);
    expect(text.split(BLOCK_END).length - 1).toBe(1);
  });

  test("dry run writes nothing and spends no delivery", () => {
    const world = worldWithRules("- rule one");
    putLesson(lesson("l1", "Lesson text."));
    const workspace = join(tmp, "ws");
    mkdirSync(workspace, { recursive: true });

    const result = syncWorkspace(world, { workspace, dryRun: true });
    expect(result.written).toBe(false);
    expect(existsSync(join(workspace, "AGENTS.md"))).toBe(false);
    expect(listLessons("default")[0]?.deliveries).toBe(0);
  });

  test("the char budget drops lessons that do not fit", () => {
    const world = worldWithRules("- rule one");
    putLesson(lesson("l1", "x".repeat(300)));
    putLesson(lesson("l2", "y".repeat(300)));
    const workspace = join(tmp, "ws");
    mkdirSync(workspace, { recursive: true });

    const result = syncWorkspace(world, { workspace, maxChars: 600 });
    expect(result.lessons.length).toBe(1);
    expect(result.block.length).toBeLessThanOrEqual(600);
  });

  test("oversized rules are trimmed, never dropped silently", () => {
    const world = worldWithRules("- " + "r".repeat(2000));
    const workspace = join(tmp, "ws");
    mkdirSync(workspace, { recursive: true });

    const result = syncWorkspace(world, { workspace, maxChars: 500 });
    expect(result.block.length).toBeLessThanOrEqual(500);
    expect(result.block).toContain("(rules trimmed by sil)");
  });

  test("rules_inject off means no rules in the block", () => {
    const target = join(tmp, "target-off");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "RULES.md"), `${RULE_START}\n- hidden\n${RULE_END}\n`, "utf8");
    const world = World.parse({ name: "default", target, rules_inject: false });
    const workspace = join(tmp, "ws");
    mkdirSync(workspace, { recursive: true });

    const result = syncWorkspace(world, { workspace });
    expect(result.rules).toBe(false);
    expect(result.block).not.toContain("hidden");
  });

  test("applyBlock appends when there is no block yet", () => {
    const block = renderBlock("default", "", []);
    expect(applyBlock("", block)).toContain(BLOCK_START);
    expect(applyBlock("keep me\n", block)).toContain("keep me");
  });
});

describe("install", () => {
  test("copies the plugin, the skill and the install config", () => {
    const workspace = join(tmp, "ws");
    const result = installIntegration({ world: "default", workspace });

    expect(existsSync(join(result.plugin_dir, "openclaw.plugin.json"))).toBe(true);
    expect(existsSync(join(result.plugin_dir, "index.mjs"))).toBe(true);
    expect(existsSync(result.skill_file)).toBe(true);

    const cfg = JSON.parse(readFileSync(join(result.plugin_dir, "sil-config.json"), "utf8")) as Record<string, string>;
    expect(cfg["world"]).toBe("default");
    expect(cfg["state_dir"]).toBe(paths.stateDir());
    expect(cfg["sil"]).toBe(join(REPO_ROOT, "scripts", "sil"));
    expect(result.enabled).toBe(false);
  });

  test("--enable patches openclaw.json and keeps a backup", () => {
    writeOpenclawConfig({ plugins: { entries: { other: { enabled: true } } } });
    const result = installIntegration({ world: "default", workspace: join(tmp, "ws"), enable: true });

    expect(result.enabled).toBe(true);
    expect(pluginEnabled()).toBe(true);
    const cfg = JSON.parse(readFileSync(ocPaths.configFile(), "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
    expect(cfg["plugins"]!["entries"]!["other"]).toEqual({ enabled: true });
    expect(existsSync(`${ocPaths.configFile()}.sil-bak`)).toBe(true);
  });

  test("enabling twice is a no-op", () => {
    writeOpenclawConfig({});
    expect(enablePlugin()).toBe(true);
    expect(enablePlugin()).toBe(false);
  });

  test("enabling without an openclaw.json fails loud", () => {
    expect(() => enablePlugin()).toThrow(/openclaw config missing/);
  });
});
