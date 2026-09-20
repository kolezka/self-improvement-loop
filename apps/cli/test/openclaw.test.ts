import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../src/main.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const ENV_KEYS = ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "OPENCLAW_CONFIG_DIR", "OPENCLAW_WORKSPACE_DIR", "CLAUDE_PLUGIN_ROOT"];

let tmp: string;
let ocDir: string;
let out: string[];
const saved: Record<string, string | undefined> = {};
const realLog = console.log;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-cli-openclaw-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) process.env[k] = join(tmp, k.toLowerCase());
  process.env["CLAUDE_PLUGIN_ROOT"] = REPO_ROOT;
  delete process.env["OPENCLAW_WORKSPACE_DIR"];
  ocDir = join(tmp, "openclaw");
  process.env["OPENCLAW_CONFIG_DIR"] = ocDir;

  out = [];
  console.log = (...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function installOpenclaw(): void {
  mkdirSync(join(ocDir, "agents", "main", "sessions"), { recursive: true });
  writeFileSync(join(ocDir, "openclaw.json"), JSON.stringify({ agents: { defaults: { workspace: join(tmp, "ws") } } }), "utf8");
}

function writeSession(sessionId: string): void {
  const dir = join(ocDir, "agents", "main", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "session", id: sessionId, cwd: tmp })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })}\n`,
    "utf8",
  );
}

describe("sil openclaw status", () => {
  test("reports a missing install instead of failing", async () => {
    const code = await run(["openclaw", "status", "--json"]);
    expect(code).toBe(0);
    const status = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(status["installed"]).toBe(false);
    expect(status["sessions"]).toBe(0);
  });

  test("counts sessions once OpenClaw is there", async () => {
    installOpenclaw();
    writeSession("s1");
    expect(await run(["openclaw", "status", "--json"])).toBe(0);
    const status = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(status["installed"]).toBe(true);
    expect(status["sessions"]).toBe(1);
    expect(status["plugin_installed"]).toBe(false);
  });
});

describe("sil openclaw install", () => {
  test("installs the plugin and the skill, and status then sees them", async () => {
    installOpenclaw();
    expect(await run(["init"])).toBe(0);

    out = [];
    expect(await run(["openclaw", "install"])).toBe(0);
    expect(existsSync(join(ocDir, "extensions", "self-improvement-loop", "index.mjs"))).toBe(true);
    expect(existsSync(join(tmp, "ws", "skills", "self-improvement-loop", "SKILL.md"))).toBe(true);

    out = [];
    expect(await run(["openclaw", "status", "--json"])).toBe(0);
    const status = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(status["plugin_installed"]).toBe(true);
    expect(status["skill_installed"]).toBe(true);
    expect(status["plugin_enabled"]).toBe(false);
  });

  test("--enable flips the flag in openclaw.json", async () => {
    installOpenclaw();
    expect(await run(["init"])).toBe(0);
    expect(await run(["openclaw", "install", "--enable"])).toBe(0);

    const cfg = JSON.parse(readFileSync(join(ocDir, "openclaw.json"), "utf8")) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    expect(cfg["plugins"]!["entries"]!["self-improvement-loop"]!["enabled"]).toBe(true);
  });

  test("no OpenClaw install is a ConfigError, exit 2", async () => {
    expect(await run(["init"])).toBe(0);
    expect(await run(["openclaw", "install"])).toBe(2);
  });
});

describe("sil openclaw scan and enqueue", () => {
  test("scan queues a session, enqueue marks it ended", async () => {
    installOpenclaw();
    writeSession("s1");
    expect(await run(["init"])).toBe(0);

    out = [];
    expect(await run(["openclaw", "scan", "--json"])).toBe(0);
    expect((JSON.parse(out.join("\n")) as Array<Record<string, unknown>>)[0]!["status"]).toBe("queued");

    out = [];
    expect(await run(["openclaw", "enqueue", "--session", "s1", "--ended", "--json"])).toBe(0);
    const result = (JSON.parse(out.join("\n")) as Array<Record<string, unknown>>)[0]!;
    expect(result["status"]).toBe("updated");
    expect(result["reason"]).toBe("ended");
  });

  test("an unknown session id exits 1", async () => {
    installOpenclaw();
    expect(await run(["init"])).toBe(0);
    expect(await run(["openclaw", "enqueue", "--session", "nope"])).toBe(1);
  });
});

describe("sil openclaw sync", () => {
  test("--dry-run prints the block and writes nothing", async () => {
    installOpenclaw();
    expect(await run(["init"])).toBe(0);

    out = [];
    expect(await run(["openclaw", "sync", "--dry-run"])).toBe(0);
    expect(out.join("\n")).toContain("<!--sil:start-->");
    expect(existsSync(join(tmp, "ws", "AGENTS.md"))).toBe(false);
  });

  test("writes the block into the workspace file", async () => {
    installOpenclaw();
    expect(await run(["init"])).toBe(0);
    expect(await run(["openclaw", "sync"])).toBe(0);
    expect(readFileSync(join(tmp, "ws", "AGENTS.md"), "utf8")).toContain("<!--sil:end-->");
  });
});
