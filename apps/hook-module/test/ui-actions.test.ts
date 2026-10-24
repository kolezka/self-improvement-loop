// The console's Actions card and artifact votes: each button queues one of the
// plugin's own slash commands through `$.command.run`, and the pane only says
// it was queued. Driven through the fake engine; the real engine presses one
// in native-test/pane.native.tsx.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlRequest, ControlResponse, ControlResult } from "@sil/core/control-protocol";
import { endConsoleSession, registerUi, resetUiForTests } from "../src/ui/register.ts";
import type { ConsoleUiState } from "../src/ui/state.ts";
import { isAllowedCommand, PANE_ACTIONS } from "../src/ui/views.ts";
import { FakeEngine, type FakeElement, type FakeEngineOptions, type FakeRunResult } from "./fake-engine.ts";

const STATE_ID = "self-improvement-loop/console";
const WORKER = { pending: 0, done: 1, failed: 0, lock_held: false, last_run: "2026-10-24T10:00:00.000Z" };
type Boot = { worlds: string[]; selectedWorld: string | null; resolutionError: string | null; initialized: boolean };
const SESSION_DEFAULT: Boot = { worlds: ["default", "inkitt"], selectedWorld: "default", resolutionError: null, initialized: true };

function ok(value: unknown): ControlResult {
  return { ok: true, value };
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function controller(over: { boot?: Boot; artifacts?: unknown[]; fail?: FakeEngineOptions["fail"]; hold?: FakeEngineOptions["hold"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sil-ui-actions-"));
  roots.push(root);
  let boot = over.boot ?? SESSION_DEFAULT;
  const artifacts = over.artifacts ?? [{ pattern: "verify-callsites", artifact_type: "skill", status: "active", reflections: 3, served_by: null }];
  const requests: ControlRequest[] = [];
  const answer = (request: ControlRequest): ControlResponse["results"] => {
    const results: ControlResponse["results"] = {};
    for (const read of request.reads) {
      const args = read.args as Record<string, unknown>;
      if (read.op === "console.bootstrap") results[read.id] = ok(boot);
      else if (read.op === "worker.status") results[read.id] = ok(WORKER);
      else if (read.op === "console.page" && args.kind === "artifacts") results[read.id] = ok({ world: args.world, total: artifacts.length, offset: 0, limit: 10, items: artifacts });
      else if (read.op === "console.page") results[read.id] = ok({ world: args.world, total: 0, offset: 0, limit: args.limit, items: [] });
      else results[read.id] = { ok: false, error: { code: "OpNotAllowed", message: "not in this test", retryable: false } };
    }
    return results;
  };
  const respond = (init: { stdin?: string } | undefined): FakeRunResult => {
    const request = JSON.parse(init?.stdin ?? "null") as ControlRequest;
    requests.push(request);
    return { exitCode: 0, stdout: `${JSON.stringify({ version: 1, requestId: request.requestId, results: answer(request) })}\n`, stderr: "" };
  };
  const engine = new FakeEngine({
    sessionId: "s1",
    cwd: join(root, "repo"),
    pluginRoot: join(root, "plugin root"),
    runs: [{ match: (argv) => argv[0] === "/bin/sh", respond }],
    ...(over.fail === undefined ? {} : { fail: over.fail }),
    ...(over.hold === undefined ? {} : { hold: over.hold }),
  });
  resetUiForTests();
  registerUi(engine.on as never);
  const state = (): ConsoleUiState => engine.state.get(STATE_ID)?.value as ConsoleUiState;
  const render = (bodyColumns = 80) =>
    engine.answer<FakeElement>("ui.render", { surface: "terminal", component: "Pane", requestId: "sil-console", props: { bodyColumns } });
  const runs = () => engine.calls.filter((c) => c.startsWith("command.run "));
  const setBoot = (b: Boot) => {
    boot = b;
  };
  return { engine, requests, state, render, runs, setBoot };
}

type Ctl = ReturnType<typeof controller>;

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

function findKey(node: unknown, key: string): FakeElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findKey(child, key);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof node === "object" && node !== null) {
    const el = node as FakeElement;
    if (el.props?.key === key) return el;
    return findKey(el.props?.children, key);
  }
  return undefined;
}

function allKeys(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(allKeys);
  if (typeof node === "object" && node !== null) {
    const el = node as FakeElement;
    const own = typeof el.props?.key === "string" ? [el.props.key as string] : [];
    return [...own, ...allKeys(el.props?.children)];
  }
  return [];
}

function allText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(allText).join("");
  if (typeof node === "object" && node !== null) {
    const el = node as FakeElement;
    const own = ["label", "source"].map((k) => (typeof el.props?.[k] === "string" ? (el.props[k] as string) : "")).join("");
    return `${own}${allText(el.props?.children)}\n`;
  }
  return "";
}

/** Every Text element with its color, for tone checks. */
function texts(node: unknown): Array<{ text: string; color: unknown; dim: unknown }> {
  if (Array.isArray(node)) return node.flatMap(texts);
  if (typeof node === "object" && node !== null) {
    const el = node as FakeElement;
    const own = el.type === "Text" ? [{ text: allText(el.props.children).trim(), color: el.props.color, dim: el.props.dimColor }] : [];
    return [...own, ...texts(el.props?.children)];
  }
  return [];
}

/** The card element whose first row's title is `title`. */
function cardOf(node: unknown, title: string): FakeElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = cardOf(child, title);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof node === "object" && node !== null) {
    const el = node as FakeElement;
    const kids = el.props?.children;
    const first = Array.isArray(kids) ? kids[0] : undefined;
    if (el.type === "Box" && el.props.borderStyle === "round" && first && texts(first)[0]?.text === title) return el;
    return cardOf(kids, title);
  }
  return undefined;
}

async function press(c: Ctl, key: string): Promise<void> {
  const button = findKey(await c.render(), key);
  if (!button) throw new Error(`no control ${key}`);
  (button.props.onPress as (e: unknown) => void)({ surface: "terminal" });
  await settle();
}

async function open(c: Ctl): Promise<void> {
  await c.engine.answer("command.run", { command: "sil", args: "" });
  await settle();
}

function queued(command: string, args: string): string {
  return `Queued /${command}${args === "" ? "" : ` ${args}`}. It runs in the chat once Claude is idle.`;
}

describe("console actions", () => {
  test("each Actions button queues its exact command", async () => {
    expect(PANE_ACTIONS.map((a) => [a.key, a.label, a.command, a.args, a.scope])).toEqual([
      ["learn", "Lesson from a mistake", "self-improvement-loop:learn", "", "session"],
      ["toolify", "Skill from last answer", "self-improvement-loop:toolify", "", "session"],
      ["reflect", "Reflect on this session", "self-improvement-loop:reflect", "", "session"],
      ["curriculum", "Preview promotion", "self-improvement-loop:curriculum", "", "world"],
      ["run", "Run worker now", "self-improvement-loop:loop", "run", "session"],
      ["web", "Open web console", "self-improvement-loop:loop", "web", "session"],
    ]);
    const c = controller();
    await open(c);
    for (const action of PANE_ACTIONS) {
      const before = c.runs().length;
      const reads = c.requests.length;
      const button = findKey(await c.render(), `action-${action.key}`);
      expect(button?.props.label).toBe(action.label);
      await press(c, `action-${action.key}`);
      const call = `command.run ${action.command} ${action.args}`;
      expect(c.runs().slice(before)).toEqual([call]);
      // No read follows a press.
      expect(c.requests.length).toBe(reads);
      const actionsCard = cardOf(await c.render(), "Actions");
      expect(actionsCard).toBeDefined();
      expect(allText(actionsCard)).toContain(queued(action.command, action.args));
    }
    expect(c.runs()).toHaveLength(PANE_ACTIONS.length);
  });

  test("a vote queues feedback for the session world's artifact", async () => {
    const c = controller();
    await open(c);
    await press(c, "section-artifacts");
    const tree = await c.render();
    expect(findKey(tree, "vote-verify-callsites")).toBeDefined();
    expect(findKey(tree, "vote-verify-callsites.good")?.props.label).toBe("good");
    expect(findKey(tree, "vote-verify-callsites.bad")?.props.label).toBe("bad");
    await press(c, "vote-verify-callsites.good");
    expect(c.runs()).toEqual(["command.run self-improvement-loop:feedback skill:verify-callsites good"]);
    const after = await c.render();
    expect(findKey(after, "vote-verify-callsites.good")).toBeUndefined();
    expect(findKey(after, "vote-verify-callsites.bad")).toBeUndefined();
    expect(allText(cardOf(after, "Artifacts"))).toContain("vote queued");
  });

  test("a malformed row gets no vote", async () => {
    const rows = [
      { pattern: "Bad Name", artifact_type: "skill", status: "active" },
      { pattern: "x\u001b", artifact_type: "skill", status: "active" },
      { pattern: "upper-type", artifact_type: "Skill", status: "active" },
      { pattern: "spaced-type", artifact_type: "a b", status: "active" },
      // Positive control: a well formed row beside them gets its vote.
      { pattern: "good-row", artifact_type: "rule", status: "active" },
    ];
    const c = controller({ artifacts: rows });
    await open(c);
    await press(c, "section-artifacts");
    const tree = await c.render();
    const votes = allKeys(tree).filter((k) => k.startsWith("vote-"));
    expect(votes.sort()).toEqual(["vote-good-row", "vote-good-row.bad", "vote-good-row.good"]);
    // Each malformed row is still listed, just without controls.
    const text = allText(tree);
    for (const p of ["Bad Name", "upper-type", "spaced-type"]) expect(text).toContain(p);
    expect(c.runs()).toEqual([]);
  });

  test("another world hides votes and Preview promotion", async () => {
    const c = controller();
    await open(c);
    await press(c, "world-inkitt");
    expect(c.state().world).toBe("inkitt");
    const line = "Votes and promotion apply to this session's world (default). Switch to it to use them.";
    const overview = await c.render();
    const keys = allKeys(overview);
    expect(keys).not.toContain("action-curriculum");
    for (const key of ["learn", "toolify", "reflect", "run", "web"]) expect(keys).toContain(`action-${key}`);
    expect(texts(cardOf(overview, "Actions")).find((t) => t.text === line)?.dim).toBe(true);
    await press(c, "section-artifacts");
    const artifacts = await c.render();
    expect(allText(artifacts)).toContain("verify-callsites");
    expect(allKeys(artifacts).filter((k) => k.startsWith("vote-"))).toEqual([]);
    expect(texts(cardOf(artifacts, "Artifacts")).find((t) => t.text === line)?.dim).toBe(true);
    // Back on the session's world, both come back.
    await press(c, "world-default");
    expect(allKeys(await c.render())).toContain("vote-verify-callsites.good");
    expect(c.runs()).toEqual([]);
  });

  test("an unresolved session world hides them with the reason", async () => {
    const c = controller({ boot: { worlds: ["default", "inkitt"], selectedWorld: null, resolutionError: "no world matches /tmp/x", initialized: true } });
    await open(c);
    await press(c, "world-default");
    expect(c.state().world).toBe("default");
    const overview = await c.render();
    expect(allKeys(overview)).not.toContain("action-curriculum");
    for (const key of ["learn", "toolify", "reflect", "run", "web"]) expect(allKeys(overview)).toContain(`action-${key}`);
    const reason = texts(cardOf(overview, "Actions")).find((t) => t.text.includes("no world matches /tmp/x"));
    expect(reason?.dim).toBe(true);
    await press(c, "section-artifacts");
    const artifacts = await c.render();
    expect(allKeys(artifacts).filter((k) => k.startsWith("vote-"))).toEqual([]);
    expect(texts(cardOf(artifacts, "Artifacts")).find((t) => t.text.includes("no world matches /tmp/x"))?.dim).toBe(true);
  });

  test("a refused run shows the error and keeps the pane usable", async () => {
    const c = controller({ fail: { commandRun: true } });
    await open(c);
    await press(c, "action-learn");
    expect(c.runs()).toEqual(["command.run self-improvement-loop:learn "]);
    const card = cardOf(await c.render(), "Actions");
    const err = texts(card).find((t) => t.text.includes("/self-improvement-loop:learn could not be queued: fake command.run refusal"));
    expect(err?.color).toBe("error");
    expect(allText(card)).not.toContain("Queued /self-improvement-loop:learn");
    const before = c.requests.length;
    await press(c, "section-review");
    expect(c.state().section).toBe("review");
    expect(c.requests.length).toBe(before + 1);
  });

  test("a run that never settles keeps queued", async () => {
    const c = controller({ hold: { commandRun: true } });
    await open(c);
    await press(c, "action-reflect");
    expect(c.runs()).toEqual(["command.run self-improvement-loop:reflect "]);
    expect(allText(cardOf(await c.render(), "Actions"))).toContain(queued("self-improvement-loop:reflect", ""));
    const before = c.requests.length;
    await press(c, "refresh");
    expect(c.requests.length).toBe(before + 1);
    expect(allText(cardOf(await c.render(), "Actions"))).toContain(queued("self-improvement-loop:reflect", ""));
  });

  test("the note clears on a section or world change", async () => {
    const c = controller();
    await open(c);
    await press(c, "action-run");
    expect(c.state().commandNote).toMatchObject({ command: "self-improvement-loop:loop", args: "run", target: null, error: null });
    await press(c, "section-review");
    expect(c.state().commandNote).toBeNull();
    await press(c, "section-overview");
    expect(allText(await c.render())).not.toContain("Queued /");
    await press(c, "action-web");
    expect(c.state().commandNote).not.toBeNull();
    await press(c, "world-inkitt");
    expect(c.state().commandNote).toBeNull();
    expect(allText(await c.render())).not.toContain("Queued /");
  });
});

describe("drawn keys", () => {
  test("no two drawn elements share a key, votes included", async () => {
    const rows = ["a", "a-good", "a-bad"].map((pattern) => ({ pattern, artifact_type: "skill", status: "active" }));
    const c = controller({ artifacts: rows });
    await open(c);
    const dupes = (keys: string[]) => keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes(allKeys(await c.render()))).toEqual([]);
    await press(c, "section-artifacts");
    const keys = allKeys(await c.render());
    // Positive control: all three rows got their votes.
    expect(keys.filter((k) => k.startsWith("vote-")).length).toBe(9);
    expect(dupes(keys)).toEqual([]);
  });
});

describe("the press-time command check", () => {
  test("only listed actions and well formed votes pass", () => {
    for (const a of PANE_ACTIONS) expect(isAllowedCommand({ command: a.command, args: a.args, target: null, world: a.scope === "world" ? "default" : null })).toBe(true);
    const feedback = "self-improvement-loop:feedback";
    expect(isAllowedCommand({ command: feedback, args: "skill:verify-callsites good", target: "verify-callsites", world: "default" })).toBe(true);
    expect(isAllowedCommand({ command: feedback, args: "rule:a-b bad", target: "a-b", world: "default" })).toBe(true);
    // A world-scoped command must name its world; a session one must not.
    expect(isAllowedCommand({ command: "self-improvement-loop:curriculum", args: "", target: null, world: null })).toBe(false);
    expect(isAllowedCommand({ command: feedback, args: "skill:verify-callsites good", target: "verify-callsites", world: null })).toBe(false);
    expect(isAllowedCommand({ command: "self-improvement-loop:learn", args: "", target: null, world: "default" })).toBe(false);
    for (const bad of [
      { command: "self-improvement-loop:loop", args: "run --force", target: null },
      { command: "self-improvement-loop:loop", args: "", target: null },
      { command: "compact", args: "", target: null },
      { command: feedback, args: "skill:verify-callsites good", target: null },
      { command: feedback, args: "skill:verify-callsites good\n/compact", target: "verify-callsites" },
      { command: feedback, args: "skill:verify-callsites  good", target: "verify-callsites" },
      { command: feedback, args: "skill:verify-callsites meh", target: "verify-callsites" },
      { command: feedback, args: "Skill:verify-callsites good", target: "verify-callsites" },
      { command: feedback, args: "skill:other good", target: "verify-callsites" },
      { command: feedback, args: "skill:Bad good", target: "Bad" },
      { command: "self-improvement-loop:learn", args: "skill:x good", target: "x" },
    ]) {
      expect(isAllowedCommand({ ...bad, world: bad.target === null ? null : "default" })).toBe(false);
    }
  });
});

/** A control's press handler as drawn now, to be called later. */
async function handler(c: Ctl, key: string): Promise<() => void> {
  const button = findKey(await c.render(), key);
  if (!button) throw new Error(`no control ${key}`);
  return () => (button.props.onPress as (e: unknown) => void)({ surface: "terminal" });
}

describe("fix round 1: checks made at the press", () => {
  test("a world-scoped press drawn for one world queues nothing once the pane shows another", async () => {
    const c = controller();
    await open(c);
    const curriculum = await handler(c, "action-curriculum");
    await press(c, "section-artifacts");
    const vote = await handler(c, "vote-verify-callsites.good");
    await press(c, "world-inkitt");
    expect(c.state().world).toBe("inkitt");
    vote();
    await settle();
    curriculum();
    await settle();
    expect(c.runs()).toEqual([]);
    // Refused visibly: the note says why, and a session action still works.
    expect(c.state().commandNote?.error).toMatch(/world/);
    await press(c, "section-overview");
    await press(c, "action-reflect");
    expect(c.runs()).toEqual(["command.run self-improvement-loop:reflect "]);
  });

  test("a world-scoped press queues nothing once the session world changed under it", async () => {
    const c = controller();
    await open(c);
    const curriculum = await handler(c, "action-curriculum");
    // The bootstrap now says the session belongs to inkitt; the pane still shows default.
    c.setBoot({ ...SESSION_DEFAULT, selectedWorld: "inkitt" });
    await press(c, "refresh");
    expect(c.state().world).toBe("default");
    curriculum();
    await settle();
    expect(c.runs()).toEqual([]);
    expect(c.state().commandNote?.error).toMatch(/inkitt/);
  });

  test("a press whose note cannot be written runs nothing and says so", async () => {
    const c = controller();
    await open(c);
    const learn = await handler(c, "action-learn");
    c.engine.stateSetOutcome = () => "throw";
    learn();
    await settle();
    expect(c.runs()).toEqual([]);
    expect(c.engine.calls.some((l) => l.startsWith("ui.log ") && l.includes("not queued"))).toBe(true);
    // Positive control: with the store back, the same press queues.
    c.engine.stateSetOutcome = null;
    learn();
    await settle();
    expect(c.runs()).toEqual(["command.run self-improvement-loop:learn "]);
  });

  test("a press whose note write lands after the session ended runs nothing", async () => {
    const c = controller();
    await open(c);
    const learn = await handler(c, "action-learn");
    let release = () => undefined as void;
    c.engine.stateGate = new Promise<void>((r) => {
      release = r;
    });
    learn();
    // The session ends (Stop, /clear) while the note write waits on the store.
    void endConsoleSession(c.engine.$ as never);
    await settle();
    c.engine.stateGate = null;
    release();
    await settle();
    expect(c.runs()).toEqual([]);
    expect(c.state().commandNote).toBeNull();
  });

  test("a late refusal of an earlier press never lands on a later identical one", async () => {
    const c = controller({ hold: { commandRun: true } });
    await open(c);
    await press(c, "action-learn");
    await press(c, "section-review");
    await press(c, "section-overview");
    await press(c, "action-learn");
    expect(c.engine.heldCommandRuns).toHaveLength(2);
    c.engine.heldCommandRuns[0]!.reject("refused late");
    await settle();
    expect(c.state().commandNote?.error).toBeNull();
    expect(allText(cardOf(await c.render(), "Actions"))).toContain(queued("self-improvement-loop:learn", ""));
    // Positive control: the refusal of the press shown does land.
    c.engine.heldCommandRuns[1]!.reject("refused now");
    await settle();
    expect(c.state().commandNote?.error).toBe("refused now");
  });
});

describe("press ids across a reload", () => {
  for (const invalidation of ["lands", "fails"] as const) {
    test(`reload whose invalidation write ${invalidation}: the old instance's late refusal never lands on the new note`, async () => {
      const c = controller({ hold: { commandRun: true } });
      await open(c);
      await press(c, "action-learn");
      expect(c.engine.heldCommandRuns).toHaveLength(1);
      const oldNote = c.state().commandNote!;
      const generation = c.state().generation;

      // Reload with the pane up: timers dropped, the module starts over.
      for (const t of c.engine.timers) t.cancelled = true;
      resetUiForTests();
      if (invalidation === "fails") c.engine.stateSetOutcome = (id) => (id === STATE_ID ? "throw" : null);
      await c.engine.fire("session.start", { cwd: "/", surface: "terminal", isInteractive: true }, { cwd: "/" });
      await settle();
      c.engine.stateSetOutcome = null;
      // The control: a failed invalidation really left the generation where it was.
      if (invalidation === "fails") expect(c.state().generation).toBe(generation);
      else expect(c.state().generation).toBeGreaterThan(generation);

      await press(c, "action-learn");
      expect(c.engine.heldCommandRuns).toHaveLength(2);
      c.engine.heldCommandRuns[0]!.reject("refused by the old instance");
      await settle();
      expect(c.state().commandNote?.error).toBeNull();
      expect(c.state().commandNote?.id).not.toBe(oldNote.id);
      // Positive control: the new press's own refusal lands.
      c.engine.heldCommandRuns[1]!.reject("refused now");
      await settle();
      expect(c.state().commandNote?.error).toBe("refused now");
    });
  }
});
