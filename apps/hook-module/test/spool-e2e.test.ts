// End to end through the real modules on both sides of the handshake: the
// hooks module buffers into sessions/<id>/module-spool.json, then apps/hook's
// ingestSpool (the code the Stop command hook runs) applies it in this same
// process. Nothing here is a stub except the engine object itself.
//
// This is the test the two halves can only pass together: a target kind the
// module invents but ingestSpool does not route, or a session file name it
// refuses, shows up here and nowhere in the unit tests.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as paths from "@sil/core/paths";
import { RULE_END, RULE_START } from "@sil/core/consts";
import { SPOOL_FILE_NAME } from "@sil/core/spool";
import { ingestSpool } from "../../hook/src/spool-ingest.ts";
import { cleanupHookEnv, makeHookEnv } from "../../hook/test/helpers.ts";
import type { HookEnv } from "../../hook/test/helpers.ts";
import { register, resetForTests } from "../src/register.ts";
import { FakeEngine } from "./fake-engine.ts";

const SESSION = "e2e-session";
const ENV_KEYS = ["HOME", "SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_PLUGIN_ROOT"];

type RegisterFn = (on: unknown, options: Record<string, never>) => unknown;

let hookEnv: HookEnv;
let pluginRoot: string;
let repoCwd: string;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  // A synthetic plugin root, so the builtin nudge directory is the one this
  // test writes and not the repo's own shipped nudges.
  const staging = makeHookEnv();
  pluginRoot = join(staging.root, "plugin");
  mkdirSync(join(pluginRoot, "nudges"), { recursive: true });
  repoCwd = join(staging.root, "repo");
  mkdirSync(repoCwd, { recursive: true });
  hookEnv = { ...staging, pluginRoot, env: { ...staging.env, CLAUDE_PLUGIN_ROOT: pluginRoot } };

  for (const key of ENV_KEYS) {
    ORIGINAL_ENV[key] = process.env[key];
    const value = hookEnv.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cleanupHookEnv(hookEnv);
});

function lines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("the module's buffered writes land through the real ingestSpool", async () => {
  const rules = join(hookEnv.data, "worlds", "default", "learned", "RULES.md");
  mkdirSync(join(hookEnv.data, "worlds", "default", "learned"), { recursive: true });
  writeFileSync(rules, `# notes\n\n${RULE_START}\n- check twice <!--rule:check-twice-->\n${RULE_END}\n`, "utf8");

  const inbox = join(hookEnv.state, "inbox", "default");
  mkdirSync(inbox, { recursive: true });
  writeFileSync(
    join(inbox, "lesson-one.json"),
    `${JSON.stringify({ id: "lesson-one", pattern: "lesson-one", text: "read the primary source", created: "2026-01-01" }, null, 2)}\n`,
    "utf8",
  );

  writeFileSync(
    join(pluginRoot, "nudges", "probe.json"),
    JSON.stringify({
      pattern: "probe-nudge",
      event: "PreToolUse",
      matcher: "Bash",
      gate: { command_matches: "rm -rf" },
      once_per: "session",
      text: "check the path before rm -rf",
    }),
    "utf8",
  );

  const engine = new FakeEngine({
    sessionId: SESSION,
    cwd: repoCwd,
    pluginRoot,
    env: {
      HOME: hookEnv.root,
      SIL_CONFIG_DIR: hookEnv.config,
      SIL_STATE_DIR: hookEnv.state,
      SIL_DATA_DIR: hookEnv.data,
    },
  });
  resetForTests();
  (register as unknown as RegisterFn)(engine.on, {});

  const base = { session_id: SESSION, transcript_path: join(hookEnv.root, "t.jsonl"), cwd: repoCwd };
  const core: { additionalContext?: string[] } = {};
  const start = await engine.fire(
    "classic.SessionStart",
    { ...base, hook_event_name: "SessionStart", source: "startup" },
    core,
  );
  expect((start.additionalContext ?? []).join("\n")).toContain("Lesson (lesson-one)");

  const pre = await engine.fire(
    "classic.PreToolUse",
    { tool: "Bash", tool_use_id: "tu-1", command: "rm -rf /tmp/scratch", description: "clean up" },
    core,
  );
  expect(pre.additionalContext).toEqual(["check the path before rm -rf"]);

  await engine.fire(
    "classic.PostToolUse",
    { ...base, hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "outline" }, tool_response: {}, tool_use_id: "tu-2" },
    {},
  );

  await engine.fire("classic.Stop", { ...base, hook_event_name: "Stop", stop_hook_active: false }, {});

  const spoolFile = `${paths.sessionDir(SESSION)}/${SPOOL_FILE_NAME}`;
  expect(existsSync(spoolFile)).toBe(true);

  const applied = ingestSpool(SESSION);
  expect(applied.skipped).toBe(0);
  expect(applied.appends).toBeGreaterThan(0);
  expect(existsSync(spoolFile)).toBe(false);

  const events = lines(paths.usageEventsFile());
  expect(events.map((e) => e["ref"])).toEqual(["rule:check-twice", "skill:outline"]);
  expect(events.every((e) => e["session_id"] === SESSION && e["world"] === "default")).toBe(true);

  const samples = lines(paths.payloadSamplesFile("default"));
  expect(samples.length).toBe(1);
  expect(samples[0]?.["tool_name"]).toBe("Bash");
  expect((samples[0]?.["tool_input"] as Record<string, unknown>)["command"]).toBe("rm -rf /tmp/scratch");
  expect(readFileSync(paths.payloadSamplesFile("default"), "utf8")).not.toContain("clean up");

  const fires = lines(paths.nudgeFiresFile());
  expect(fires.map((f) => f["pattern"])).toEqual(["probe-nudge"]);
  expect(fires[0]?.["event"]).toBe("PreToolUse");

  const runs = lines(paths.hookRunsFile());
  expect(runs.map((r) => r["ref"])).toEqual([
    "hook:module:SessionStart",
    "hook:module:PreToolUse",
    "hook:module:PostToolUse",
  ]);

  const delivered = readFileSync(`${paths.sessionDir(SESSION)}/delivered`, "utf8");
  expect(delivered).toBe("lesson-one\n");

  // The inbox lesson's own delivery counter was bumped in place, not spooled.
  expect(JSON.parse(readFileSync(join(inbox, "lesson-one.json"), "utf8")).deliveries).toBe(1);

  // A second ingest is a no-op: the file is gone, so nothing is applied twice.
  expect(ingestSpool(SESSION)).toEqual({ appends: 0, moves: 0, skipped: 0 });
  expect(lines(paths.usageEventsFile()).length).toBe(2);
});
