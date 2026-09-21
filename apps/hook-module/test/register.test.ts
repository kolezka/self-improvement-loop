// The hooks module driven through the fake engine: the same four events Claude
// Code raises, the same `e` shapes, and a `next` that stands in for the rest of
// the chain. What the module hands the model is the return value; what it hands
// the Stop command hook is the spool file, so most assertions read one of those
// two.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RULE_END, RULE_START } from "@sil/core/consts";
import { register, resetForTests } from "../src/register.ts";
import { peekState } from "../src/state.ts";
import { FakeEngine } from "./fake-engine.ts";
import type { CannedRun, FakeEngineOptions } from "./fake-engine.ts";

const SESSION = "sess-1";

type RegisterFn = (on: unknown, options: Record<string, never>) => unknown;

interface Fixture {
  root: string;
  state: string;
  data: string;
  config: string;
  pluginRoot: string;
  cwd: string;
  engine: FakeEngine;
}

type FixtureOptions = Partial<Pick<FakeEngineOptions, "env" | "fail" | "realCommands" | "runs" | "sessionId">>;

const fixtures: string[] = [];

function fixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "sil-hook-module-"));
  fixtures.push(root);
  const state = join(root, "state");
  const data = join(root, "data");
  const config = join(root, "config");
  const pluginRoot = join(root, "plugin");
  const cwd = join(root, "repo");
  for (const dir of [state, data, config, join(pluginRoot, "nudges"), cwd]) mkdirSync(dir, { recursive: true });

  const engine = new FakeEngine({
    sessionId: SESSION,
    cwd,
    pluginRoot,
    env: { HOME: root, SIL_STATE_DIR: state, SIL_DATA_DIR: data, SIL_CONFIG_DIR: config },
    ...options,
  });
  resetForTests();
  (register as unknown as RegisterFn)(engine.on, {});
  return { root, state, data, config, pluginRoot, cwd, engine };
}

function cleanup(): void {
  for (const root of fixtures.splice(0, fixtures.length)) rmSync(root, { recursive: true, force: true });
}

// --- fixture writers -------------------------------------------------------

function rulesPath(f: Fixture): string {
  return join(f.data, "worlds", "default", "learned", "RULES.md");
}

function writeRules(f: Fixture, body: string): void {
  const path = rulesPath(f);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `# notes\n\n${RULE_START}\n${body}\n${RULE_END}\n`, "utf8");
}

interface LessonOptions {
  created: string;
  text?: string;
  deliveries?: number;
  repo?: string;
  mtimeMs?: number;
}

function writeLesson(f: Fixture, id: string, options: LessonOptions): string {
  const dir = join(f.state, "inbox", "default");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  const body: Record<string, unknown> = {
    id,
    pattern: id,
    text: options.text ?? `remember ${id}`,
    created: options.created,
  };
  if (options.deliveries !== undefined) body["deliveries"] = options.deliveries;
  if (options.repo !== undefined) body["repo"] = options.repo;
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  if (options.mtimeMs !== undefined) utimesSync(path, options.mtimeMs / 1000, options.mtimeMs / 1000);
  return path;
}

/** The one shell the module runs to learn the claude pid, answered the way the
 * sandbox's own `sh` would. */
function pidProbe(stdout: string, exitCode = 0): CannedRun {
  return {
    match: (argv) => argv[0] === "sh" && argv[2] === "echo $PPID",
    result: { exitCode, stdout, stderr: "" },
  };
}

function writeNudge(f: Fixture, nudge: unknown, name = "probe.json"): void {
  writeFileSync(join(f.pluginRoot, "nudges", name), JSON.stringify(nudge), "utf8");
}

function writeSnapshot(f: Fixture, worker: Record<string, unknown> = {}): void {
  writeFileSync(
    join(f.state, "hook-config.json"),
    JSON.stringify({ version: 1, worlds: [], worker, plugin_root: f.pluginRoot }),
    "utf8",
  );
}

// --- event payloads --------------------------------------------------------

function sessionStart(f: Fixture): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: join(f.root, "transcript.jsonl"),
    cwd: f.cwd,
    hook_event_name: "SessionStart",
    source: "startup",
  };
}

function userPrompt(f: Fixture, prompt = "do the thing"): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: join(f.root, "transcript.jsonl"),
    cwd: f.cwd,
    hook_event_name: "UserPromptSubmit",
    prompt,
  };
}

function bashCall(command: string, toolUseId = "tu-1"): Record<string, unknown> {
  return { tool: "Bash", tool_use_id: toolUseId, command, description: "run a thing" };
}

function postToolUse(f: Fixture, toolName: string, toolInput: unknown): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: join(f.root, "transcript.jsonl"),
    cwd: f.cwd,
    hook_event_name: "PostToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: { ok: true },
    tool_use_id: "tu-9",
    duration_ms: 12,
  };
}

function stopEvent(f: Fixture): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: join(f.root, "transcript.jsonl"),
    cwd: f.cwd,
    hook_event_name: "Stop",
    stop_hook_active: false,
  };
}

function sessionEndEvent(f: Fixture, reason = "clear"): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: join(f.root, "transcript.jsonl"),
    cwd: f.cwd,
    hook_event_name: "SessionEnd",
    reason,
  };
}

// --- spool readers ---------------------------------------------------------

interface SpoolAppendLine {
  target: { kind: string; world?: string; name?: string };
  line: string;
}

interface SpoolFile {
  version: number;
  session_id: string;
  written_at: string;
  appends: SpoolAppendLine[];
  moves: Array<{ from: string; to: string }>;
}

function spoolPath(f: Fixture): string {
  return join(f.state, "sessions", SESSION, "module-spool.json");
}

function readSpool(f: Fixture): SpoolFile | null {
  const path = spoolPath(f);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as SpoolFile;
}

/** The spool the module hands over at Stop. Driving Stop is how a test sees the
 * buffer, which is the only place the module can write a JSONL line. */
async function drainSpool(f: Fixture): Promise<SpoolFile> {
  await f.engine.fire("classic.Stop", stopEvent(f), {});
  const spool = readSpool(f);
  if (!spool) throw new Error("no spool written");
  return spool;
}

function linesFor(spool: SpoolFile, kind: string): Array<Record<string, unknown>> {
  return spool.appends
    .filter((a) => a.target.kind === kind)
    .map((a) => JSON.parse(a.line) as Record<string, unknown>);
}

function rawLinesFor(spool: SpoolFile, kind: string): string[] {
  return spool.appends.filter((a) => a.target.kind === kind).map((a) => a.line);
}

function contextOf(result: { additionalContext?: string[] }): string[] {
  return result.additionalContext ?? [];
}

const CORE_CONTEXT = { additionalContext: ["from core"] };

const BASH_NUDGE = {
  pattern: "probe-nudge",
  event: "PreToolUse",
  matcher: "Bash",
  gate: { command_matches: "rm -rf" },
  once_per: "session",
  text: "check the path before rm -rf",
};

describe("classic.SessionStart", () => {
  test("sets SIL_HOOK_MODULE to the claude pid before handing the event on", async () => {
    // The command hooks compare it with their own shell's $PPID, which is that
    // same claude. A nested claude inherits the value but has another pid, so
    // its command hooks run instead of being silently skipped.
    const f = fixture({ runs: [pidProbe("4242\n")] });
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    const setAt = f.engine.indexOfCall("env.set SIL_HOOK_MODULE=4242");
    const nextAt = f.engine.indexOfCall("next classic.SessionStart");
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(nextAt).toBeGreaterThanOrEqual(0);
    expect(setAt).toBeLessThan(nextAt);
    expect(f.engine.env["SIL_HOOK_MODULE"]).toBe("4242");
    cleanup();
  });

  test("asks the shell for the pid once per process, not once per session", async () => {
    const f = fixture({ runs: [pidProbe("4242\n")] });
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    await f.engine.fire("classic.SessionStart", { ...sessionStart(f), source: "compact" }, {});
    expect(f.engine.countCalls("echo $PPID")).toBe(1);
    expect(f.engine.env["SIL_HOOK_MODULE"]).toBe("4242");
    cleanup();
  });

  test("leaves SIL_HOOK_MODULE unset when the pid cannot be resolved", async () => {
    // Unset is the safe answer: every guarded command hook falls through to
    // `bun dist/hook.js`, which is slower and correct. Setting anything else
    // would take the command hooks away without the module doing their work.
    for (const probe of [pidProbe("", 1), pidProbe("garbage\n")]) {
      const f = fixture({ runs: [probe] });
      const result = await f.engine.fire("classic.SessionStart", sessionStart(f), CORE_CONTEXT);
      expect(f.engine.indexOfCall("env.set SIL_HOOK_MODULE")).toBe(-1);
      expect(f.engine.env["SIL_HOOK_MODULE"]).toBeUndefined();
      // The event itself is untouched: core result first, module context after.
      expect(contextOf(result)[0]).toBe("from core");
      expect(contextOf(result)[1]).toContain("self-improvement-loop is active:");
      cleanup();
    }
  });

  test("appends the rules block, three lessons and the status line to the core context", async () => {
    const f = fixture();
    writeRules(f, "- always check twice <!--rule:check-twice-->\n- never guess <!--rule:no-guessing-->");
    writeLesson(f, "oldest", { created: "2026-01-01" });
    writeLesson(f, "second", { created: "2026-02-01" });
    writeLesson(f, "third", { created: "2026-03-01" });
    writeLesson(f, "newest", { created: "2026-04-01" });

    const result = await f.engine.fire("classic.SessionStart", sessionStart(f), CORE_CONTEXT);
    const context = contextOf(result);
    expect(context.length).toBe(2);
    expect(context[0]).toBe("from core");
    const text = context[1] ?? "";

    expect(text).toContain("Promoted rules for world default:");
    expect(text).toContain("always check twice");
    expect(text).toContain("Lesson (newest): remember newest");
    expect(text).toContain("Lesson (third): remember third");
    expect(text).toContain("Lesson (second): remember second");
    expect(text).not.toContain("remember oldest");
    expect(text).toContain("self-improvement-loop is active:");
    cleanup();
  });

  test("writes start.json and spools one rule-use event per tag", async () => {
    const f = fixture();
    writeRules(f, "- one <!--rule:alpha-->\n- two <!--rule:beta-->\n- untagged note");
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});

    const start = JSON.parse(readFileSync(join(f.state, "sessions", SESSION, "start.json"), "utf8"));
    expect(start.cwd).toBe(f.cwd);
    expect(start.world).toBe("default");
    expect(start.git_head).toBe(null);
    expect(typeof start.ts).toBe("string");

    const spool = await drainSpool(f);
    const rules = linesFor(spool, "usage-events").filter((line) => line["kind"] === "rule");
    expect(rules.map((line) => line["ref"]).sort()).toEqual(["rule:alpha", "rule:beta"]);
    expect(rules[0]?.["session_id"]).toBe(SESSION);
    expect(rules[0]?.["world"]).toBe("default");
    cleanup();
  });

  test("writes the rule-use markers to disk, so a resume does not count them twice", async () => {
    const f = fixture();
    writeRules(f, "- one <!--rule:alpha-->");
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});

    const markersDir = join(f.state, "sessions", SESSION, "nudge-markers");
    const markers = existsSync(markersDir) ? readdirSync(markersDir) : [];
    expect(markers.filter((name) => name.startsWith("rule-use-alpha-")).length).toBe(1);

    // A resume is a new process on the same session id. Only the marker file
    // stands between it and a second usage event for the same rule.
    resetForTests();
    const resumed = new FakeEngine({
      sessionId: SESSION,
      cwd: f.cwd,
      pluginRoot: f.pluginRoot,
      env: { HOME: f.root, SIL_STATE_DIR: f.state, SIL_DATA_DIR: f.data, SIL_CONFIG_DIR: f.config },
    });
    (register as unknown as RegisterFn)(resumed.on, {});
    await resumed.fire("classic.SessionStart", sessionStart(f), {});
    await resumed.fire("classic.Stop", stopEvent(f), {});

    const spool = readSpool(f);
    // Positive control: the resumed module did spool something, so an empty
    // rule list is a rule that was not counted again, not an empty file.
    expect(spool?.appends.length ?? 0).toBeGreaterThan(0);
    expect(linesFor(spool!, "usage-events").filter((line) => line["kind"] === "rule")).toEqual([]);
    cleanup();
  });

  test("spools one hook_run line naming the module", async () => {
    const f = fixture();
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    const spool = await drainSpool(f);
    const runs = linesFor(spool, "hook-runs");
    expect(runs.length).toBe(1);
    expect(runs[0]?.["ref"]).toBe("hook:module:SessionStart");
    expect(runs[0]?.["kind"]).toBe("hook_run");
    const detail = runs[0]?.["detail"] as Record<string, unknown>;
    expect(detail["exitCode"]).toBe(0);
    expect(detail["hookEvent"]).toBe("SessionStart");
    expect(typeof detail["durationMs"]).toBe("number");
    expect(detail["error"]).toBeUndefined();
    cleanup();
  });

  test("a second SessionStart in the same process redelivers nothing", async () => {
    const f = fixture();
    writeLesson(f, "only", { created: "2026-01-01" });

    const first = await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    expect(contextOf(first)[0]).toContain("Lesson (only)");

    const second = await f.engine.fire("classic.SessionStart", { ...sessionStart(f), source: "compact" }, {});
    expect(contextOf(second)[0]).not.toContain("Lesson (only)");
    cleanup();
  });

  test("a freshly loaded module honours the delivered file on disk", async () => {
    const f = fixture();
    writeLesson(f, "only", { created: "2026-01-01" });
    mkdirSync(join(f.state, "sessions", SESSION), { recursive: true });
    writeFileSync(join(f.state, "sessions", SESSION, "delivered"), "only\n", "utf8");

    // resetForTests inside fixture() already ran; re-register on a new engine to
    // stand for the module a resume loads in a new process.
    resetForTests();
    const engine = new FakeEngine({
      sessionId: SESSION,
      cwd: f.cwd,
      pluginRoot: f.pluginRoot,
      env: { HOME: f.root, SIL_STATE_DIR: f.state, SIL_DATA_DIR: f.data, SIL_CONFIG_DIR: f.config },
    });
    (register as unknown as RegisterFn)(engine.on, {});
    const result = await engine.fire("classic.SessionStart", sessionStart(f), {});
    expect(contextOf(result)[0]).not.toContain("Lesson (only)");
    cleanup();
  });

  test("a lesson that reached its delivery cap is spooled as a move to archive", async () => {
    const f = fixture();
    const path = writeLesson(f, "worn", { created: "2026-01-01", deliveries: 4 });
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});

    expect(JSON.parse(readFileSync(path, "utf8")).deliveries).toBe(5);
    const spool = await drainSpool(f);
    expect(spool.moves).toEqual([{ from: path, to: join(f.state, "inbox", "default", "archive", "worn.json") }]);
    cleanup();
  });

  test("a lesson naming another repo is not delivered here", async () => {
    const f = fixture();
    writeLesson(f, "elsewhere", { created: "2026-01-01", repo: join(f.root, "other-repo") });
    const result = await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    expect(contextOf(result)[0]).not.toContain("Lesson (elsewhere)");
    cleanup();
  });
});

describe("classic.UserPromptSubmit", () => {
  test("delivers only lessons that arrived after start.json", async () => {
    const f = fixture();
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});

    const startMtime = Date.now();
    writeLesson(f, "stale", { created: "2026-01-01", mtimeMs: startMtime - 60_000 });
    writeLesson(f, "arrived", { created: "2026-01-02", mtimeMs: startMtime + 60_000 });

    const result = await f.engine.fire("classic.UserPromptSubmit", userPrompt(f), CORE_CONTEXT);
    const context = contextOf(result);
    expect(context[0]).toBe("from core");
    expect(context[1]).toContain("Lesson (arrived)");
    expect(context[1]).not.toContain("Lesson (stale)");
    cleanup();
  });

  test("delivers nothing when there is no session dir to date from", async () => {
    const f = fixture();
    writeLesson(f, "orphan", { created: "2026-01-01" });
    const result = await f.engine.fire("classic.UserPromptSubmit", userPrompt(f), CORE_CONTEXT);
    expect(contextOf(result)).toEqual(["from core"]);
    cleanup();
  });
});

describe("classic.PreToolUse", () => {
  test("spools a redacted sample and fires a matching nudge once per session", async () => {
    const f = fixture();
    writeNudge(f, BASH_NUDGE);
    const command = 'curl -H "Authorization: Bearer topsecret" https://x && rm -rf /tmp/thing';

    const first = await f.engine.fire("classic.PreToolUse", bashCall(command), {});
    expect(contextOf(first)).toEqual(["check the path before rm -rf"]);

    const second = await f.engine.fire("classic.PreToolUse", bashCall(command, "tu-2"), {});
    expect(contextOf(second)).toEqual([]);

    const spool = await drainSpool(f);
    const samples = spool.appends.filter((a) => a.target.kind === "payload-samples");
    expect(samples.length).toBe(2);
    expect(samples[0]?.target.world).toBe("default");
    const sample = JSON.parse(samples[0]?.line ?? "{}");
    expect(sample.tool_name).toBe("Bash");
    expect(sample.hook_event_name).toBe("PreToolUse");
    expect(sample.session_id).toBe(SESSION);
    expect(sample.tool_input.command).toContain("<redacted>");
    expect(samples[0]?.line).not.toContain("topsecret");
    // Only the two keys a gate can read; never the model's description.
    expect(Object.keys(sample.tool_input)).toEqual(["command"]);
    expect(samples[0]?.line).not.toContain("run a thing");

    const fires = linesFor(spool, "nudge-fires").filter((line) => line["pattern"] === "probe-nudge");
    expect(fires.length).toBe(1);
    expect(fires[0]?.["event"]).toBe("PreToolUse");
    cleanup();
  });

  test("reads the nudge directory once per session, not once per tool call", async () => {
    const f = fixture();
    writeNudge(f, BASH_NUDGE);
    const nudgeDir = join(f.pluginRoot, "nudges");
    for (let i = 0; i < 3; i++) await f.engine.fire("classic.PreToolUse", bashCall("ls", `tu-${i}`), {});
    expect(f.engine.countCalls(`fs.list ${nudgeDir}`)).toBe(1);
    cleanup();
  });

  test("takes the session id and cwd from the engine, since the envelope has neither", async () => {
    const f = fixture();
    await f.engine.fire("classic.PreToolUse", bashCall("ls"), {});
    expect(f.engine.countCalls("session.id")).toBe(1);
    expect(f.engine.countCalls("session.cwd")).toBe(1);
    const spool = await drainSpool(f);
    expect(spool.session_id).toBe(SESSION);
    cleanup();
  });
});

describe("classic.PostToolUse", () => {
  test("spools a skill usage event without the free-text args", async () => {
    const f = fixture();
    await f.engine.fire("classic.PostToolUse", postToolUse(f, "Skill", { skill: "outline", args: "secret prose" }), {});
    const spool = await drainSpool(f);
    const events = linesFor(spool, "usage-events");
    expect(events.length).toBe(1);
    expect(events[0]?.["kind"]).toBe("skill");
    expect(events[0]?.["ref"]).toBe("skill:outline");
    expect(events[0]?.["detail"]).toEqual({});
    expect(rawLinesFor(spool, "usage-events").join("")).not.toContain("secret prose");
    cleanup();
  });

  test("spools an agent usage event naming the model but not the description", async () => {
    const f = fixture();
    const input = { subagent_type: "critic", model: "opus", description: "private reasoning" };
    await f.engine.fire("classic.PostToolUse", postToolUse(f, "Agent", input), {});
    const spool = await drainSpool(f);
    const events = linesFor(spool, "usage-events");
    expect(events[0]?.["kind"]).toBe("agent");
    expect(events[0]?.["ref"]).toBe("agent:critic");
    expect(events[0]?.["detail"]).toEqual({ model: "opus" });
    expect(rawLinesFor(spool, "usage-events").join("")).not.toContain("private reasoning");
    cleanup();
  });

  test("records nothing for any other tool", async () => {
    const f = fixture();
    await f.engine.fire("classic.PostToolUse", postToolUse(f, "Read", { file_path: "/tmp/x" }), {});
    const spool = await drainSpool(f);
    expect(linesFor(spool, "usage-events")).toEqual([]);
    cleanup();
  });
});

describe("classic.Stop", () => {
  test("writes the spool before handing the event on", async () => {
    const f = fixture();
    await f.engine.fire("classic.PostToolUse", postToolUse(f, "Skill", { skill: "outline" }), {});

    let presentAtNext = false;
    await f.engine.fire("classic.Stop", stopEvent(f), {}, () => {
      presentAtNext = existsSync(spoolPath(f));
    });
    expect(presentAtNext).toBe(true);
    cleanup();
  });

  test("clears the buffer when the command hook ingested the file", async () => {
    const f = fixture();
    await f.engine.fire("classic.PostToolUse", postToolUse(f, "Skill", { skill: "outline" }), {});

    await f.engine.fire("classic.Stop", stopEvent(f), {}, () => {
      rmSync(spoolPath(f), { force: true }); // what ingestSpool does
    });
    expect(readSpool(f)).toBe(null);

    // Nothing buffered any more, so a second Stop writes no file at all.
    await f.engine.fire("classic.Stop", stopEvent(f), {});
    expect(readSpool(f)).toBe(null);
    cleanup();
  });

  test("keeps the buffer when the file is still there after the chain ran", async () => {
    const f = fixture();
    await f.engine.fire("classic.PostToolUse", postToolUse(f, "Skill", { skill: "outline" }), {});

    await f.engine.fire("classic.Stop", stopEvent(f), {});
    const first = readSpool(f);
    expect(first?.appends.length).toBeGreaterThan(0);

    // A Stop that returned early on stop_hook_active leaves the file. Deleting
    // it here proves the next Stop wrote the same lines again from the buffer.
    rmSync(spoolPath(f), { force: true });
    await f.engine.fire("classic.Stop", stopEvent(f), {});
    const second = readSpool(f);
    expect(second?.appends.map((a) => a.line)).toEqual(first?.appends.map((a) => a.line));
    cleanup();
  });

  test("writes nothing for a session it never handled", async () => {
    const f = fixture();
    await f.engine.fire("classic.Stop", stopEvent(f), {});
    expect(readSpool(f)).toBe(null);
    cleanup();
  });

  test("flushes the state the engine's id names, whatever the payload says", async () => {
    const f = fixture();
    // Every event keys on $.session.id(); a Stop payload naming a different id
    // must not strand the buffer those events filled.
    await f.engine.fire("classic.PreToolUse", bashCall("ls"), {});
    await f.engine.fire("classic.Stop", { ...stopEvent(f), session_id: "some-other-id" }, {});
    expect(readSpool(f)?.session_id).toBe(SESSION);
    cleanup();
  });

  test("falls back to the payload's session id when the engine has none", async () => {
    // An engine that answers "" is the one case where the payload's id keys the
    // state, and the Stop that flushes it has to look there too.
    const f = fixture({ sessionId: "" });
    await f.engine.fire("classic.PostToolUse", postToolUse(f, "Skill", { skill: "outline" }), {});
    await f.engine.fire("classic.Stop", stopEvent(f), {});
    expect(readSpool(f)?.session_id).toBe(SESSION);
    expect(linesFor(readSpool(f)!, "usage-events").length).toBe(1);
    cleanup();
  });
});

describe("one session id for every event", () => {
  test("keys on the engine's id, so a stale payload id opens no second state", async () => {
    const f = fixture();
    // classic.PreToolUse has no payload id at all, so a payload id keyed
    // anywhere else splits the session in two and one buffer is never flushed.
    await f.engine.fire("classic.SessionStart", { ...sessionStart(f), session_id: "stale-id" }, {});
    await f.engine.fire("classic.PreToolUse", bashCall("ls"), {});
    expect(peekState("stale-id")).toBeUndefined();

    const spool = await drainSpool(f);
    expect(spool.session_id).toBe(SESSION);
    expect(linesFor(spool, "hook-runs").map((line) => line["ref"])).toEqual([
      "hook:module:SessionStart",
      "hook:module:PreToolUse",
    ]);
    cleanup();
  });
});

describe("Stop and SessionEnd overlapping", () => {
  test("hands every buffered line to exactly one command hook", async () => {
    const f = fixture();
    await f.engine.fire("classic.PostToolUse", postToolUse(f, "Skill", { skill: "outline" }), {});

    // What the command hook does under the session lock: apply every line the
    // spool holds, then delete the file.
    const applied: SpoolAppendLine[] = [];
    const ingest = (): void => {
      const spool = readSpool(f);
      if (!spool) return;
      applied.push(...spool.appends);
      rmSync(spoolPath(f), { force: true });
    };

    let releaseStop = (): void => {};
    const stopHeld = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let stopReachedNext = (): void => {};
    const stopAtNext = new Promise<void>((resolve) => {
      stopReachedNext = resolve;
    });

    const stopDone = f.engine.fire("classic.Stop", stopEvent(f), {}, () => {
      ingest();
      stopReachedNext();
      return stopHeld;
    });
    await stopAtNext;

    // SessionEnd fires while Stop's chain is still running, which is the window
    // the session lock in the command hook exists for.
    await f.engine.fire("classic.SessionEnd", sessionEndEvent(f), {}, () => {
      ingest();
    });
    releaseStop();
    await stopDone;

    expect(applied.length).toBe(2); // the skill usage event and one hook_run
    expect(new Set(applied.map((a) => a.line)).size).toBe(applied.length);
    expect(applied.filter((a) => a.target.kind === "usage-events").length).toBe(1);

    // The buffer is empty afterwards: nothing was kept for a third offer.
    await f.engine.fire("classic.Stop", stopEvent(f), {});
    expect(readSpool(f)).toBe(null);
    cleanup();
  });
});

describe("worker kick", () => {
  // The pid probe is an `sh` call too, so the spawn is the one that detaches.
  const isKick = (argv: string[]): boolean => argv[0] === "sh" && (argv[2] ?? "").startsWith("nohup");
  const kickCalls = (f: Fixture): string[] =>
    f.engine.runCalls.filter((call) => isKick(call.argv)).map((call) => call.argv[2] ?? "");

  test("spawns the source entry point when there is pending work and no live worker", async () => {
    const f = fixture();
    writeSnapshot(f);
    mkdirSync(join(f.state, "queue", "pending"), { recursive: true });
    writeFileSync(join(f.state, "queue", "pending", "one.json"), "{}", "utf8");

    await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    expect(kickCalls(f)).toEqual([
      `nohup bun run '${f.pluginRoot}/apps/cli/src/main.ts' worker --once >> '${f.state}/logs/worker.log' 2>&1 </dev/null &`,
    ]);
    const spawn = f.engine.runCalls.find((call) => isKick(call.argv));
    expect(spawn?.argv[1]).toBe("-c");
    expect(spawn?.init?.cwd).toBe(f.pluginRoot);
    expect(existsSync(join(f.state, "last-kick"))).toBe(true);
    cleanup();
  });

  test("prefers the built CLI when dist/cli.js is there", async () => {
    const f = fixture();
    writeSnapshot(f);
    mkdirSync(join(f.pluginRoot, "dist"), { recursive: true });
    writeFileSync(join(f.pluginRoot, "dist", "cli.js"), "// built", "utf8");

    await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    expect(kickCalls(f)).toEqual([
      `nohup bun '${f.pluginRoot}/dist/cli.js' worker --once >> '${f.state}/logs/worker.log' 2>&1 </dev/null &`,
    ]);
    cleanup();
  });

  test("does not spawn while the throttle is fresh", async () => {
    const f = fixture();
    writeSnapshot(f);
    writeFileSync(join(f.state, "last-kick"), "", "utf8");
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    expect(kickCalls(f)).toEqual([]);
    cleanup();
  });

  test("does not spawn with no queued work and a fresh curriculum marker", async () => {
    const f = fixture();
    writeSnapshot(f);
    mkdirSync(join(f.state, "queue", "pending"), { recursive: true });
    writeFileSync(join(f.state, "last-curriculum-default"), "", "utf8");
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    expect(kickCalls(f)).toEqual([]);
    cleanup();
  });

  test("does not spawn while the lock names a live pid", async () => {
    // Matching on the pid is what proves the lock file was read: a canned
    // result for any `kill` would pass even if the pid never left the file.
    const f = fixture({
      runs: [
        {
          match: (argv) => argv[0] === "kill" && argv[1] === "-0" && argv[2] === "4242",
          result: { exitCode: 0, stdout: "", stderr: "" },
        },
      ],
    });
    writeSnapshot(f);
    writeFileSync(join(f.state, "worker.lock"), "4242\n", "utf8");
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    expect(kickCalls(f)).toEqual([]);
    cleanup();
  });

  test("treats a pid owned by someone else as a live worker", async () => {
    const f = fixture({
      runs: [
        {
          match: (argv) => argv[0] === "kill",
          result: { exitCode: 1, stdout: "", stderr: "kill: (1): Operation not permitted\n" },
        },
      ],
    });
    writeSnapshot(f);
    writeFileSync(join(f.state, "worker.lock"), "1\n", "utf8");
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    expect(kickCalls(f)).toEqual([]);
    cleanup();
  });

  test("a lock naming a dead pid does not hold the kick back", async () => {
    const f = fixture({
      runs: [
        {
          match: (argv) => argv[0] === "kill",
          result: { exitCode: 1, stdout: "", stderr: "kill: (4242): No such process\n" },
        },
      ],
    });
    writeSnapshot(f);
    writeFileSync(join(f.state, "worker.lock"), "4242\n", "utf8");
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    expect(kickCalls(f).length).toBe(1);
    cleanup();
  });

  test("does not spawn when auto_kick is off", async () => {
    const f = fixture();
    writeSnapshot(f, { auto_kick: false });
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    expect(kickCalls(f)).toEqual([]);
    cleanup();
  });

  test("does not spawn before sil init has written the snapshot", async () => {
    const f = fixture();
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    expect(kickCalls(f)).toEqual([]);
    cleanup();
  });
});

describe("a failing engine call never costs the chain", () => {
  test("every handler still returns the core result when fs.read throws", async () => {
    const f = fixture({ fail: { read: true } });
    writeRules(f, "- rule <!--rule:alpha-->");
    writeLesson(f, "some", { created: "2026-01-01" });
    writeNudge(f, BASH_NUDGE);

    // SessionStart keeps the status line: a failed step may not take down the
    // ones beside it.
    const start = await f.engine.fire("classic.SessionStart", sessionStart(f), CORE_CONTEXT);
    expect(contextOf(start)[0]).toBe("from core");
    expect(contextOf(start)[1]).toBe(
      "self-improvement-loop is active: /reflect queues this session for " +
        "background reflection, /loop shows status, /feedback <type>:<name> " +
        "good|bad rates an artifact.",
    );

    for (const [event, e] of [
      ["classic.UserPromptSubmit", userPrompt(f)],
      ["classic.PreToolUse", bashCall("rm -rf /")],
      ["classic.PostToolUse", postToolUse(f, "Skill", { skill: "outline" })],
    ] as const) {
      const result = await f.engine.fire(event, e, CORE_CONTEXT);
      expect(contextOf(result)).toEqual(["from core"]);
    }

    const stopResult = await f.engine.fire("classic.Stop", stopEvent(f), CORE_CONTEXT);
    expect(contextOf(stopResult)).toEqual(["from core"]);
    cleanup();
  });

  test("a session that cannot be initialised adds no context and notes nothing", async () => {
    const f = fixture({ fail: { env: true } });
    const start = await f.engine.fire("classic.SessionStart", sessionStart(f), CORE_CONTEXT);
    expect(contextOf(start)).toEqual(["from core"]);

    const pre = await f.engine.fire("classic.PreToolUse", bashCall("ls"), CORE_CONTEXT);
    expect(contextOf(pre)).toEqual(["from core"]);
    expect(readSpool(f)).toBe(null);
    cleanup();
  });

  test("an unwritable session dir still returns the core result", async () => {
    const f = fixture({ fail: { write: true } });
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    const result = await f.engine.fire("classic.PostToolUse", postToolUse(f, "Skill", { skill: "outline" }), CORE_CONTEXT);
    expect(contextOf(result)).toEqual(["from core"]);
    const stop = await f.engine.fire("classic.Stop", stopEvent(f), CORE_CONTEXT);
    expect(contextOf(stop)).toEqual(["from core"]);
    expect(readSpool(f)).toBe(null);
    cleanup();
  });
});

describe("classic.SessionEnd and session.end", () => {
  test("both hand the buffer over, and neither is a second chance to lose it", async () => {
    const f = fixture();
    await f.engine.fire("classic.PostToolUse", postToolUse(f, "Skill", { skill: "outline" }), {});

    await f.engine.fire("classic.SessionEnd", sessionEndEvent(f), {});
    const spool = readSpool(f);
    expect(linesFor(spool!, "usage-events").length).toBe(1);

    rmSync(spoolPath(f), { force: true });
    await f.engine.fire("session.end", { reason: "clear", sessionId: SESSION }, { sessionId: SESSION });
    expect(linesFor(readSpool(f)!, "usage-events").length).toBe(1);
    cleanup();
  });

  test("session.end drops the session's state, after the buffer went out", async () => {
    const f = fixture();
    await f.engine.fire("classic.PostToolUse", postToolUse(f, "Skill", { skill: "outline" }), {});
    expect(peekState(SESSION)).toBeDefined();

    await f.engine.fire("session.end", { reason: "clear", sessionId: SESSION }, { sessionId: SESSION });
    // Written first, dropped second: a /clear in a long-lived process must not
    // keep paying for every session it has seen.
    expect(linesFor(readSpool(f)!, "usage-events").length).toBe(1);
    expect(peekState(SESSION)).toBeUndefined();
    cleanup();
  });
});

describe("engine calls that would log an ERROR", () => {
  // Every rejected $.fs call shows up in `claude --debug` as
  // "[ERROR] $.fs.read (self-improvement-loop): ... failed: ENOENT". A file the
  // module knows might be absent gets an $.fs.exists first, so a normal session
  // leaves no ERROR line behind.
  const driveSession = async (f: Fixture): Promise<void> => {
    await f.engine.fire("classic.SessionStart", sessionStart(f), {});
    await f.engine.fire("classic.UserPromptSubmit", userPrompt(f), {});
    await f.engine.fire("classic.PreToolUse", bashCall("ls"), {});
    await f.engine.fire("classic.PostToolUse", postToolUse(f, "Skill", { skill: "outline" }), {});
    await f.engine.fire("classic.Stop", stopEvent(f), {});
  };

  test("a session with nothing on disk makes no call the engine has to refuse", async () => {
    const f = fixture({ runs: [pidProbe("4242\n")] });
    await driveSession(f);
    expect(f.engine.rejectedCalls).toEqual([]);

    // Positive control: the recorder does catch a refused call, so an empty
    // list above is the module behaving and not a recorder that never fires.
    const engine = f.engine.$ as { fs: { read: (path: string) => Promise<string> } };
    const missing = join(f.state, "not-here");
    await expect(engine.fs.read(missing)).rejects.toThrow();
    expect(f.engine.rejectedCalls).toEqual([`fs.read ${missing}`]);
    cleanup();
  });

  test("the worker kick makes no call the engine has to refuse either", async () => {
    // With the snapshot present the kick runs its five gates, and every one of
    // them reads a file that is missing on a fresh install.
    const f = fixture({ runs: [pidProbe("4242\n")] });
    writeSnapshot(f);
    await driveSession(f);
    expect(f.engine.rejectedCalls).toEqual([]);
    cleanup();
  });
});

describe("layout roots", () => {
  test("refuses a session whose roots are relative, and writes nothing at all", async () => {
    // HOME empty with no SIL_*/XDG_* override makes every root relative
    // (".local/state/self-improvement-loop"), and a relative path resolves
    // against the session cwd: the loop's state would land in the user's repo.
    // The "empty path is ." trap from .ai/lessons.md.
    const f = fixture({ env: {}, runs: [pidProbe("4242\n")] });
    const result = await f.engine.fire("classic.SessionStart", sessionStart(f), CORE_CONTEXT);
    expect(contextOf(result)).toEqual(["from core"]);
    expect(f.engine.calls.filter((call) => call.startsWith("fs."))).toEqual([]);
    // The guard stays unset too: the command hooks resolve the home dir through
    // os.homedir(), so they still work where the module gave up, and skipping
    // them here would leave the session with no loop at all.
    expect(f.engine.env["SIL_HOOK_MODULE"]).toBeUndefined();

    // Positive control: absolute roots, still no HOME, and the same event works.
    resetForTests();
    const configured = new FakeEngine({
      sessionId: SESSION,
      cwd: f.cwd,
      pluginRoot: f.pluginRoot,
      env: { SIL_STATE_DIR: f.state, SIL_DATA_DIR: f.data, SIL_CONFIG_DIR: f.config },
    });
    (register as unknown as RegisterFn)(configured.on, {});
    const ok = await configured.fire("classic.SessionStart", sessionStart(f), CORE_CONTEXT);
    expect(contextOf(ok)[1]).toContain("self-improvement-loop is active:");
    expect(existsSync(join(f.state, "sessions", SESSION, "start.json"))).toBe(true);
    cleanup();
  });
});
