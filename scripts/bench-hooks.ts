#!/usr/bin/env bun
// Measures what the installed Claude Code hooks cost in wall-clock time.
//
// Unlike scripts/bench.ts (which benchmarks this plugin's own engine), this
// walks the settings chain plus every installed plugin's hooks.json, runs each
// hook command with a synthetic payload, and reports p50/p95/max per hook.
//
// Run: bun run scripts/bench-hooks.ts            (n=10 per hook)
//      bun run scripts/bench-hooks.ts --n 25
//      bun run scripts/bench-hooks.ts --json
//      bun run scripts/bench-hooks.ts --only claude-mem   (substring, not regex)
//      bun run scripts/bench-hooks.ts --tool-calls 300
//
// The hooks run for real, so they can write their own state. Every payload
// carries a throwaway session_id and a temp transcript, never a real one, so a
// memory or logging hook ingests the fixture instead of your session.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface HookEntry {
  source: string;
  event: string;
  matcher: string;
  command: string;
  shell: string;
  pluginRoot: string | null;
}

interface HookRow {
  hook: string;
  event: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
  exit: string;
}

const CONFIG_DIR = process.env["CLAUDE_CONFIG_DIR"] || join(process.env["HOME"] || "", ".claude");
const SESSION_ID = `bench-hooks-${Date.now()}`;

// --- args --------------------------------------------------------------------

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const N = Number(argValue("n", "10"));
const TOOL_CALLS = Number(argValue("tool-calls", "200"));
const JSON_OUT = process.argv.includes("--json");
const ONLY = argValue("only", "");
const SKIP = argValue("skip", "");

// --- discovery ---------------------------------------------------------------

function readJson(path: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// `Setup` is deliberately absent: it runs installers and version checks, which
// is neither per-session cost nor safe to run in a loop.
const EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "PreCompact",
]);

/** Flattens one settings/hooks.json `hooks` block into individual commands. */
function collect(hooks: unknown, source: string, pluginRoot: string | null): HookEntry[] {
  const out: HookEntry[] = [];
  if (!hooks || typeof hooks !== "object") return out;
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups) || !EVENTS.has(event)) continue;
    for (const group of groups) {
      const matcher = (group?.matcher as string) || "*";
      for (const hook of (group?.hooks as Record<string, unknown>[]) || []) {
        if (hook?.["type"] !== "command" || typeof hook["command"] !== "string") continue;
        out.push({
          source,
          event,
          matcher,
          command: hook["command"],
          shell: (hook["shell"] as string) || "sh",
          pluginRoot,
        });
      }
    }
  }
  return out;
}

function discover(): HookEntry[] {
  const entries: HookEntry[] = [];

  const settingsFiles = [
    [join(CONFIG_DIR, "settings.json"), "user settings"],
    [join(CONFIG_DIR, "settings.local.json"), "user settings.local"],
    [join(process.cwd(), ".claude/settings.json"), "project settings"],
    [join(process.cwd(), ".claude/settings.local.json"), "project settings.local"],
  ];
  for (const [path, label] of settingsFiles) {
    const cfg = readJson(path!);
    if (cfg) entries.push(...collect(cfg["hooks"], label!, null));
  }

  const installed = readJson(join(CONFIG_DIR, "plugins/installed_plugins.json"));
  const plugins = (installed?.["plugins"] as Record<string, { installPath?: string }[]>) || {};
  for (const [name, installs] of Object.entries(plugins)) {
    for (const install of installs) {
      const root = install.installPath;
      if (!root) continue;
      const cfg = readJson(join(root, "hooks/hooks.json"));
      if (cfg) entries.push(...collect(cfg["hooks"], name, root));
    }
  }
  return entries;
}

// --- payloads ----------------------------------------------------------------

function payloadFor(event: string, dirs: { transcript: string; file: string }): string {
  const base = {
    session_id: SESSION_ID,
    transcript_path: dirs.transcript,
    cwd: process.cwd(),
    permission_mode: "acceptEdits",
    hook_event_name: event,
  };
  const perEvent: Record<string, Record<string, unknown>> = {
    PreToolUse: { tool_name: "Read", tool_input: { file_path: dirs.file } },
    PostToolUse: {
      tool_name: "Read",
      tool_input: { file_path: dirs.file },
      tool_response: { type: "text", file: { filePath: dirs.file, content: "bench fixture\n", numLines: 1 } },
    },
    UserPromptSubmit: { prompt: "bench fixture prompt, measure hook cost" },
    Stop: { stop_hook_active: false },
    SubagentStop: { stop_hook_active: false },
    SessionStart: { source: "startup" },
    SessionEnd: { reason: "other" },
    Notification: { message: "bench fixture notification" },
    PreCompact: { trigger: "manual", custom_instructions: "" },
  };
  return JSON.stringify({ ...base, ...(perEvent[event] || {}) });
}

// --- timing ------------------------------------------------------------------

function stats(durations: number[]): { p50: number; p95: number; max: number } {
  const sorted = [...durations].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  return { p50: at(50), p95: at(95), max: sorted[sorted.length - 1]! };
}

const round = (ms: number): number => Math.round(ms * 100) / 100;

function label(entry: HookEntry): string {
  const cmd = entry.command.replace(/\s+/g, " ").trim();
  const script = cmd.match(/([\w.-]+\.(?:sh|js|ts|py|mjs|cjs))/);
  const short = script ? script[1]! : cmd.slice(0, 40);
  return `${entry.source}: ${short}${entry.matcher !== "*" ? ` [${entry.matcher}]` : ""}`;
}

function measure(entry: HookEntry, dirs: { transcript: string; file: string }): HookRow {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  if (entry.pluginRoot) env["CLAUDE_PLUGIN_ROOT"] = entry.pluginRoot;
  const command = entry.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", entry.pluginRoot || "");
  const payload = Buffer.from(payloadFor(entry.event, dirs));

  const durations: number[] = [];
  const exits = new Set<number>();
  for (let i = -1; i < N; i++) {
    const started = performance.now();
    const proc = Bun.spawnSync([entry.shell, "-c", command], {
      stdin: payload,
      env,
      cwd: process.cwd(),
      stdout: "ignore",
      stderr: "ignore",
      timeout: 60_000,
    });
    const elapsed = performance.now() - started;
    if (i < 0) continue; // warm-up
    durations.push(elapsed);
    exits.add(proc.exitCode ?? -1);
  }
  const s = stats(durations);
  return {
    hook: label(entry),
    event: entry.event,
    n: durations.length,
    p50: round(s.p50),
    p95: round(s.p95),
    max: round(s.max),
    exit: [...exits].sort((a, b) => a - b).join(","),
  };
}

// --- report ------------------------------------------------------------------

function table(rows: HookRow[]): string {
  const head = ["hook", "event", "n", "p50 ms", "p95 ms", "max ms", "exit"];
  const body = rows.map((r) => [r.hook, r.event, String(r.n), String(r.p50), String(r.p95), String(r.max), r.exit]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

function main(): void {
  // Plain substring match, not a regex: --only/--skip come from the command
  // line, and building a RegExp from an argument is a regex-injection sink
  // (CodeQL js/regex-injection). A filter for a hook name never needed more.
  const matches = (entry: HookEntry, needle: string): boolean =>
    `${entry.source} ${entry.command}`.toLowerCase().includes(needle.toLowerCase());

  const entries = discover()
    .filter((e) => (ONLY ? matches(e, ONLY) : true))
    .filter((e) => (SKIP ? !matches(e, SKIP) : true));

  const tmp = mkdtempSync(join(tmpdir(), "bench-hooks-"));
  const dirs = { transcript: join(tmp, "transcript.jsonl"), file: join(tmp, "fixture.txt") };
  writeFileSync(dirs.file, "bench fixture\n");
  writeFileSync(
    dirs.transcript,
    JSON.stringify({ type: "user", message: { role: "user", content: "bench fixture prompt" } }) + "\n",
  );

  try {
    const rows = entries.map((e) => measure(e, dirs)).sort((a, b) => b.p50 - a.p50);

    // Claude Code runs all matching hooks of one event in parallel, so the
    // added wall time per event is the slowest hook, not their sum. The sum is
    // still worth printing: it is the CPU the machine spends.
    const byEvent = new Map<string, HookRow[]>();
    for (const r of rows) byEvent.set(r.event, [...(byEvent.get(r.event) || []), r]);
    const summary = [...byEvent.entries()]
      .map(([event, rs]) => ({
        event,
        hooks: rs.length,
        parallelP50: round(Math.max(...rs.map((r) => r.p50))),
        serialP50: round(rs.reduce((acc, r) => acc + r.p50, 0)),
      }))
      .sort((a, b) => b.parallelP50 - a.parallelP50);

    const perToolCall =
      (summary.find((s) => s.event === "PreToolUse")?.parallelP50 || 0) +
      (summary.find((s) => s.event === "PostToolUse")?.parallelP50 || 0);
    const projection = {
      toolCalls: TOOL_CALLS,
      perToolCallMs: round(perToolCall),
      sessionSeconds: round((perToolCall * TOOL_CALLS) / 1000),
    };

    if (JSON_OUT) {
      console.log(JSON.stringify({ rows, summary, projection }, null, 2));
      return;
    }
    console.log(table(rows));
    console.log("\nper event (parallel = slowest hook, what the session waits for);");
    console.log("matchers are ignored, so every number is the worst case where all matchers fire:");
    for (const s of summary) {
      console.log(`  ${s.event.padEnd(17)} ${s.hooks} hooks  parallel ${s.parallelP50} ms  serial ${s.serialP50} ms`);
    }
    console.log(
      `\nprojection: ${projection.perToolCallMs} ms per tool call (PreToolUse + PostToolUse)` +
        ` -> ${projection.sessionSeconds} s over ${projection.toolCalls} tool calls`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
