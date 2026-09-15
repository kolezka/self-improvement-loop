// End to end through the real modules with a fake model transport and the real
// hook bundle run as a subprocess (the way Claude Code runs it):
// hooks -> queue -> worker/critic -> reflection -> inbox -> next session, then
// reflections -> curriculum -> staged branch -> review -> accept -> relink,
// and the HTTP API on top of the same state.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, paths, saveConfig, SECTIONS, targetRoot, worldNamed, writeHookSnapshot } from "@sil/core";
import * as curriculum from "@sil/curriculum";
import * as feedback from "@sil/feedback";
import type { ChatFn } from "@sil/providers";
import * as review from "@sil/review";
import * as store from "@sil/store";
import * as worker from "@sil/worker";

const REPO = join(import.meta.dir, "..");
const HOOK = existsSync(join(REPO, "dist/hook.js")) ? join(REPO, "dist/hook.js") : join(REPO, "apps/hook/src/main.ts");
const CLI = join(REPO, "apps/cli/src/main.ts");
const PATTERN = "verify-callsites";

let tmp: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_ROOT", "LITELLM_API_KEY"];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-e2e-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["SIL_CONFIG_DIR"] = join(tmp, "config");
  process.env["SIL_STATE_DIR"] = join(tmp, "state");
  process.env["SIL_DATA_DIR"] = join(tmp, "data");
  process.env["CLAUDE_CONFIG_DIR"] = join(tmp, "claude");
  process.env["CLAUDE_PLUGIN_ROOT"] = REPO;
  process.env["LITELLM_API_KEY"] = "sentinel-key-never-sent";
  const init = Bun.spawnSync(["bun", CLI, "init", "--model", "fake/model"], { env: process.env });
  expect(init.exitCode).toBe(0);
  // The SessionStart hook would spawn a real detached worker (no fake chat)
  // and race the in-process one; tests drive the worker explicitly.
  const cfg = loadConfig();
  cfg.worker.auto_kick = false;
  saveConfig(cfg);
  writeHookSnapshot(cfg);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

function runHook(payload: Record<string, unknown>): Record<string, unknown> | null {
  const proc = Bun.spawnSync(["bun", HOOK], { stdin: Buffer.from(JSON.stringify(payload)), env: process.env });
  expect(proc.exitCode).toBe(0);
  expect(proc.stderr.toString()).toBe("");
  const out = proc.stdout.toString().trim();
  return out ? (JSON.parse(out) as Record<string, unknown>) : null;
}

function contextOf(out: Record<string, unknown> | null): string {
  const hso = (out?.["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
  return String(hso["additionalContext"] ?? "");
}

function writeTranscript(path: string, sessionId: string, cwd: string): void {
  const rec = (kind: string, content: unknown) => ({
    type: kind,
    sessionId,
    cwd,
    timestamp: "2026-09-14T10:00:00.000Z",
    message: { role: kind, content },
  });
  const lines: unknown[] = [rec("user", "Please make the change safe: check every consumer of the symbol")];
  for (let i = 0; i < 7; i++) {
    lines.push(rec("assistant", [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `rg -n symbol_${i} src/` } }]));
    lines.push(rec("user", [{ type: "tool_result", tool_use_id: `t${i}`, content: "src/a.ts:1" }]));
  }
  lines.push(rec("assistant", [{ type: "tool_use", id: "s1", name: "Skill", input: { skill: PATTERN, args: "" } }]));
  lines.push(rec("assistant", [{ type: "tool_use", id: "a1", name: "Agent", input: { subagent_type: "explorer", model: "haiku", description: "find" } }]));
  lines.push(rec("assistant", [{ type: "text", text: "Done. Every call site now has the guard." }]));
  for (const name of ["PreToolUse:Bash", "PostToolUse:Bash", "SessionStart:startup"]) {
    lines.push({ type: "attachment", sessionId, attachment: { type: "hook_success", hookName: name, hookEvent: name.split(":")[0], exitCode: "0", durationMs: "12" } });
  }
  lines.push({ type: "ai-title", title: "noise" });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const reflectionBody = (n: number): string =>
  `Last updated: 2026-09-14\n\nPattern: ${PATTERN}\n\n` +
  `## What worked\nEnumerating every consumer of the symbol with ripgrep before editing (occurrence ${n}).\n` +
  `## What failed & why\nOne consumer lacked the guard and the obvious callsite hid it.\n` +
  `## Reusable lesson\nBefore calling a change safe, enumerate every callsite of the changed symbol with ripgrep and confirm each consumer carries the guard.\n` +
  `## Verification\nRan: rg -n symbol src/ -> exit 0, 7 callsites listed\n` +
  `## Not verified\nnone, checked scope: src/\n`;

const SKILL_TEXT = `---
name: ${PATTERN}
description: Use when a symbol changes and the change must be called safe. Enumerate every callsite and consumer before concluding.
---

Before calling a change safe, enumerate every callsite of the changed symbol with
ripgrep and confirm each consumer carries the guard. One consumer without the
guard is the whole bug, so do not generalise from the obvious callsite.
`;

const fakeChat: ChatFn = async (role) => {
  if (role === "critic") {
    return JSON.stringify({
      record: true,
      pattern: PATTERN,
      what_worked: "Enumerated every consumer of the symbol with ripgrep.",
      what_failed: "One consumer lacked the guard.",
      lesson: "Before calling a change safe, enumerate every callsite of the changed symbol.",
      verification: "rg -n symbol src/ -> exit 0",
      not_verified: ["the test suite was not run"],
      lesson_short: "Enumerate every callsite of a changed symbol before calling it safe.",
      confidence: 0.8,
      artifacts_used: [`skill:${PATTERN}`, "agent:explorer"],
      artifacts_helpful: [`skill:${PATTERN}`],
      artifacts_misfired: [],
      rules_relevant: [],
    });
  }
  if (role === "drafter") {
    return JSON.stringify({
      artifact: SKILL_TEXT,
      trigger_event: "none",
      gate: null,
      needs_own_context: false,
      context_evidence: null,
      capability_evidence: "enumerate every callsite of the changed symbol with ripgrep and confirm each consumer carries the guard",
    });
  }
  if (role === "judge") return JSON.stringify({ verdict: "yes", reason: "grounded and operational" });
  throw new Error(`unexpected role ${role}`);
};

describe("session to lesson to next session", () => {
  test("hooks queue the session, the worker reflects, the next session gets the lesson", async () => {
    const cwd = join(tmp, "proj");
    mkdirSync(cwd);
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd });
    const sid = "e2e-session-1";
    const transcript = join(tmp, `${sid}.jsonl`);
    writeTranscript(transcript, sid, cwd);
    const base = { session_id: sid, cwd, transcript_path: transcript };

    const start = runHook({ ...base, hook_event_name: "SessionStart", source: "startup" });
    expect(contextOf(start)).toContain("self-improvement-loop is active");

    runHook({ ...base, hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: PATTERN }, tool_response: {} });
    runHook({ ...base, hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: "explorer", model: "haiku" }, tool_response: {} });
    runHook({ ...base, hook_event_name: "Stop", stop_hook_active: false });
    runHook({ ...base, hook_event_name: "SessionEnd" });

    const pending = store.listQueue("pending");
    expect(pending.map((e) => e.session_id)).toEqual([sid]);
    expect(pending[0]!.ended).toBe(true);
    expect(pending[0]!.tool_uses).toBeGreaterThanOrEqual(6);

    const events = readFileSync(paths.usageEventsFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { ref: string });
    const refs = new Set(events.map((e) => e.ref));
    expect(refs.has(`skill:${PATTERN}`)).toBe(true);
    expect(refs.has("agent:explorer")).toBe(true);
    expect(refs.has("hook:PreToolUse:Bash")).toBe(true);

    const summary = await worker.runOnce(loadConfig(), { curriculum: false, chat: fakeChat });
    expect(summary.reflected).toEqual([sid]);
    expect(summary.failed).toEqual([]);

    const refl = store.listReflections("default");
    expect(refl).toHaveLength(1);
    expect(refl[0]!.pattern).toBe(PATTERN);
    expect(refl[0]!.artifacts_helpful).toEqual([`skill:${PATTERN}`]);
    const text = readFileSync(refl[0]!.path, "utf8");
    expect(text).not.toContain("sentinel-key-never-sent");
    for (const heading of SECTIONS) expect(text).toContain(heading);

    const lessons = store.listLessons("default");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.text).toContain("Enumerate every callsite");

    const next = runHook({ session_id: "e2e-session-2", cwd, transcript_path: join(tmp, "x.jsonl"), hook_event_name: "SessionStart", source: "startup" });
    expect(contextOf(next)).toContain("Enumerate every callsite");
    expect(JSON.stringify(next)).not.toContain("permissionDecision");
    expect(next).not.toHaveProperty("decision");
  });
});

describe("reflections to staged branch to accept and relink", () => {
  test("three reflections promote a skill that the human accepts", async () => {
    for (let n = 0; n < 3; n++) {
      store.writeReflection("default", { id: `2026-09-1${n}-${PATTERN}-000${n}`, session_id: `s${n}` }, reflectionBody(n));
    }
    const cfg = loadConfig();
    const world = worldNamed(cfg, "default");
    const target = targetRoot(world);
    const head = () => Bun.spawnSync(["git", "-C", target, "rev-parse", "HEAD"]).stdout.toString().trim();

    const dry = await curriculum.run(world, cfg, { apply: false, chat: fakeChat });
    expect(dry.dry_run).toBe(true);
    expect(dry.staged).toContain(PATTERN);
    expect(existsSync(join(target, "skills", PATTERN))).toBe(false);

    const report = await curriculum.run(world, cfg, { apply: true, chat: fakeChat });
    expect(report.staged).toEqual([PATTERN]);
    const headBefore = head();
    expect(existsSync(join(target, "skills", PATTERN))).toBe(false);

    const queue = review.queue(world, cfg);
    expect(queue.map((q) => q.pattern)).toEqual([PATTERN]);
    const detail = review.detail(world, cfg, PATTERN);
    const diff = review.diff(world, cfg, PATTERN);
    expect(detail.reviewed_state).toBe(diff.reviewed_state);
    expect(detail.reviewed_state).toHaveLength(64);
    expect(detail.accept_blocked).toBeNull();
    expect(detail.body).toContain(`name: ${PATTERN}`);

    expect(() => review.accept(world, cfg, PATTERN, "0".repeat(64))).toThrow();

    const result = review.accept(world, cfg, PATTERN, detail.reviewed_state);
    expect(result.merged).toBe(true);
    expect(head()).not.toBe(headBefore);
    expect(existsSync(join(target, "skills", PATTERN, "SKILL.md"))).toBe(true);
    const ledger = store.loadLedger(join(target, "promotions.json"));
    expect(ledger.entries[PATTERN]!.status).toBe("promoted");
    const link = join(paths.claudeConfigDir(), "skills", PATTERN);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(link, "SKILL.md"))).toBe(true);
    expect(review.queue(world, cfg)).toEqual([]);

    const rows = review.inventory(world, cfg);
    expect(rows.map((r) => r.pattern)).toEqual([PATTERN]);
    expect(rows[0]!.status).toBe("promoted");

    feedback.rebuild(world, cfg);
    const cards = Object.fromEntries(feedback.load(world).map((c) => [c.ref, c]));
    expect(cards[`skill:${PATTERN}`]?.proposal).toBe("new");

    const again = await curriculum.run(world, cfg, { apply: true, chat: fakeChat });
    expect(again.staged).toEqual([]);
    expect(again.gated_out[PATTERN]).toBeUndefined();
  });
});

describe("http api over the real backend", () => {
  test("routes answer with real state and the guard holds", async () => {
    const { createServer } = await import("../apps/server/src/main.ts");
    store.writeReflection("default", { id: `2026-09-14-${PATTERN}-beef` }, reflectionBody(0));
    const server = createServer({ port: 0, token: "t0k3n" });
    try {
      const port = server.port;
      const base = `http://127.0.0.1:${port}`;
      const headers = { "X-SIL-Local": "1", "X-SIL-Token": "t0k3n" };
      const get = (p: string) => fetch(base + p, { headers });

      expect((await get("/api/health/report")).status).toBe(200);
      const list = await get("/api/reflections/list?world=default");
      expect(list.status).toBe(200);
      expect(((await list.json()) as Array<{ pattern: string }>)[0]!.pattern).toBe(PATTERN);
      const plan = await get("/api/curriculum/plan?world=default");
      expect(plan.status).toBe(200);
      expect(((await plan.json()) as { threshold: number }).threshold).toBe(3);
      const q = await get("/api/review/queue?world=default");
      expect(q.status).toBe(200);
      expect(await q.json()).toEqual([]);
      expect((await get("/api/router/inventory?world=default")).status).toBe(200);
      expect([401, 403]).toContain((await fetch(base + "/api/reflections/list?world=default")).status);
      expect((await fetch(base + "/")).status).toBe(200);
    } finally {
      server.stop(true);
    }
  });
});
