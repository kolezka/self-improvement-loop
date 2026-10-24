// The native console's view state: pure transitions first, then the
// controller in ui/register.ts driven through the fake engine with held
// bridge replies and hand-fired timers. The native engine runs the same
// lifecycle in native-test/pane.native.tsx.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_ID_RE, CONTROL_MAX_READS, type ControlRequest, type ControlResponse } from "@sil/core/control-protocol";
import type { ConsoleBootstrap as HostBootstrap } from "../../../packages/ops/src/handlers/console.ts";
import type { SilConsoleState } from "../../../types";
import { consoleAct, endConsoleSession, registerUi, resetUiForTests } from "../src/ui/register.ts";
import {
  applyConsoleRead,
  beginConsoleRefresh,
  chooseConsoleWorld,
  failConsoleRead,
  initialConsoleState,
  invalidateConsole,
  parseConsoleState,
  reconcileConsoleWorld,
  selectConsoleSection,
  setActivityTab,
  switchConsoleWorld,
  ACTIVITY_TABS,
  type ConsoleBootstrap,
  type ConsoleUiState,
} from "../src/ui/state.ts";
import { consoleLines, consoleReads, CONSOLE_REFRESH_MS, shortTime, type ConsoleAction } from "../src/ui/views.ts";
import { FakeEngine, type FakeElement, type FakeRunResult } from "./fake-engine.ts";

// The sandbox copy of the bootstrap shape and the host's must stay one shape,
// and so must the view state and the plugin's state contract.
const hostToSandbox: (b: HostBootstrap) => ConsoleBootstrap = (b) => b;
const sandboxToHost: (b: ConsoleBootstrap) => HostBootstrap = (b) => b;
const stateToContract: (s: ConsoleUiState) => SilConsoleState = (s) => s;
const contractToState: (s: SilConsoleState) => ConsoleUiState = (s) => s;
void [hostToSandbox, sandboxToHost, stateToContract, contractToState];

const T1 = "2026-10-22T12:00:00.000Z";
const T2 = "2026-10-22T12:00:10.000Z";

function reply(results: ControlResponse["results"], requestId = "r"): ControlResponse {
  return { version: 1, requestId, results };
}

/** What the Overview's bounded review read answers: one item, the full total. */
function reviewPage(world: string, patterns: string[]) {
  return { world, total: patterns.length, offset: 0, limit: 1, items: patterns.slice(0, 1).map((pattern) => ({ pattern })) };
}

function bootstrapValue(over: Partial<ConsoleBootstrap> = {}): ConsoleBootstrap {
  return { worlds: ["world-a", "world-b"], selectedWorld: "world-a", resolutionError: null, initialized: true, ...over };
}

function worldA(): ConsoleUiState {
  const s = switchConsoleWorld(initialConsoleState(), "world-a");
  return applyConsoleRead(
    { ...s, selectedPattern: "some-pattern", proposal: { part: "body", offset: 0, back: [], reviewedState: null } },
    s.generation,
    reply({
      bootstrap: { ok: true, value: bootstrapValue() },
      worker: { ok: true, value: { pending: 2, done: 5, failed: 1, lock_held: false, last_run: T1 } },
      review: { ok: true, value: reviewPage("world-a", ["a-only"]) },
    }),
    T1,
  );
}

function text(lines: { text: string }[]): string {
  return lines.map((l) => l.text).join("\n");
}

describe("pure console state", () => {
  test("starts with no world, nothing read and nothing claimed", () => {
    expect(initialConsoleState()).toEqual({
      world: null,
      section: "overview",
      generation: 0,
      selectedPattern: null,
      loading: false,
      lastSuccessAt: null,
      results: {},
      error: null,
      listOffset: 0,
      proposal: null,
      lessonsOffset: 0,
      worldOffset: 0,
      activityTab: "queue",
    });
  });

  test("a world switch clears the old world's data and drops its late reply", () => {
    const a = worldA();
    const oldReply = reply({ review: { ok: true, value: reviewPage("world-a", ["late-a"]) } });
    const b = switchConsoleWorld(a, "world-b");
    expect(b.world).toBe("world-b");
    expect(b.generation).toBe(a.generation + 1);
    expect(b.selectedPattern).toBeNull();
    expect(b.results).toEqual({});
    expect(b.lastSuccessAt).toBeNull();
    expect(b.error).toBeNull();
    expect(applyConsoleRead(b, a.generation, oldReply, "2026-10-22T12:00:00Z")).toEqual(b);
    expect(failConsoleRead(b, a.generation, "late failure")).toEqual(b);
    expect(beginConsoleRefresh(b, a.generation)).toEqual(b);
    // Choosing the world already shown changes nothing.
    expect(switchConsoleWorld(b, "world-b")).toBe(b);
  });

  test("a complete read records every result and its time", () => {
    const a = worldA();
    expect(a.loading).toBe(false);
    expect(a.error).toBeNull();
    expect(a.lastSuccessAt).toBe(T1);
    expect(Object.keys(a.results).sort()).toEqual(["bootstrap", "review", "worker"]);
  });

  test("beginConsoleRefresh marks loading for the current generation only", () => {
    const a = worldA();
    expect(beginConsoleRefresh(a, a.generation).loading).toBe(true);
    expect(beginConsoleRefresh(a, a.generation)).toMatchObject({ results: a.results, lastSuccessAt: T1 });
  });

  test("a partly failed read shows the failures and does not claim a complete refresh", () => {
    const a = worldA();
    const next = applyConsoleRead(
      beginConsoleRefresh(a, a.generation),
      a.generation,
      reply({
        bootstrap: { ok: true, value: bootstrapValue() },
        worker: { ok: false, error: { code: "LockHeld", message: "worker busy", retryable: true } },
        review: { ok: true, value: reviewPage("world-a", []) },
      }),
      T2,
    );
    expect(next.loading).toBe(false);
    expect(next.lastSuccessAt).toBe(T1);
    expect(next.error).toContain("1 of 3");
    expect(next.results.worker).toEqual({ ok: false, error: { code: "LockHeld", message: "worker busy", retryable: true } });
    expect(next.results.review).toEqual({ ok: true, value: reviewPage("world-a", []) });
    const shown = text(consoleLines(next));
    expect(shown).toContain("LockHeld");
    expect(shown).not.toMatch(/Pending: \d/);
  });

  test("an all-error read never advances lastSuccessAt and shows no fabricated zero", () => {
    const s = switchConsoleWorld(initialConsoleState(), "world-a");
    const failed = { ok: false as const, error: { code: "ConfigError", message: "invalid config.yaml", retryable: false } };
    const next = applyConsoleRead(s, s.generation, reply({ bootstrap: failed, worker: failed, review: failed }), T2);
    expect(next.lastSuccessAt).toBeNull();
    expect(next.error).toContain("3 of 3");
    const shown = text(consoleLines(next));
    expect(shown).toContain("invalid config.yaml");
    expect(shown).not.toMatch(/\b0\b/);
  });

  test("a failed refresh keeps the last data, labelled stale, and keeps its time", () => {
    const a = worldA();
    const failed = failConsoleRead(beginConsoleRefresh(a, a.generation), a.generation, "The control bridge exited with 1.");
    expect(failed.results).toEqual(a.results);
    expect(failed.lastSuccessAt).toBe(T1);
    expect(failed.loading).toBe(false);
    expect(failed.error).toContain("exited with 1");
    const now = new Date(2026, 9, 24, 17, 0);
    const shown = text(consoleLines(failed, now));
    expect(shown).toContain("exited with 1");
    expect(shown).toMatch(/stale/i);
    expect(shown).toContain(`last complete refresh ${shortTime(T1, now)}`);
    // The real values are still there, and labelled as old.
    expect(shown).toContain("Pending: 2");
  });

  test("a failed first refresh shows the failure, not zeros", () => {
    const s = switchConsoleWorld(initialConsoleState(), "world-a");
    const failed = failConsoleRead(s, s.generation, "The control bridge did not start.");
    const shown = text(consoleLines(failed));
    expect(shown).toContain("did not start");
    expect(shown).not.toMatch(/\b0\b/);
    expect(shown).not.toMatch(/Pending|staged/i);
  });

  test("a real zero from the bridge is shown as zero", () => {
    const s = switchConsoleWorld(initialConsoleState(), "world-a");
    const next = applyConsoleRead(
      s,
      s.generation,
      reply({
        bootstrap: { ok: true, value: bootstrapValue() },
        worker: { ok: true, value: { pending: 0, done: 0, failed: 0, lock_held: false, last_run: null } },
        review: { ok: true, value: reviewPage("world-a", []) },
      }),
      T1,
    );
    const shown = text(consoleLines(next));
    expect(shown).toContain("Pending: 0");
    expect(shown).toContain("0 staged");
  });

  test("invalidateConsole drops in-flight work and keeps what is shown", () => {
    const a = beginConsoleRefresh(worldA(), worldA().generation);
    const inv = invalidateConsole(a);
    expect(inv.generation).toBe(a.generation + 1);
    expect(inv.loading).toBe(false);
    expect(inv.world).toBe("world-a");
    expect(inv.results).toEqual(a.results);
    expect(applyConsoleRead(inv, a.generation, reply({}), T2)).toEqual(inv);
  });

  test("selectConsoleSection is a new read scope (Task 5): only the world list and worker stay", () => {
    const a = worldA();
    const s = selectConsoleSection(a, "review");
    expect(s).toEqual({
      ...a,
      section: "review",
      generation: a.generation + 1,
      selectedPattern: null,
      proposal: null,
      listOffset: 0,
      results: { bootstrap: a.results.bootstrap!, worker: a.results.worker! },
    });
  });
});

describe("world reconciliation from console.bootstrap", () => {
  function withBootstrap(state: ConsoleUiState, value: ConsoleBootstrap): ConsoleUiState {
    return applyConsoleRead(state, state.generation, reply({ bootstrap: { ok: true, value } }), T1);
  }

  test("no world yet: adopts the world that owns the cwd, keeping only the world list", () => {
    const s = reconcileConsoleWorld(withBootstrap(initialConsoleState(), bootstrapValue({ selectedWorld: "world-b" })));
    expect(s.world).toBe("world-b");
    expect(s.generation).toBe(1);
    expect(s.results).toEqual({ bootstrap: { ok: true, value: bootstrapValue({ selectedWorld: "world-b" }) } });
    expect(s.lastSuccessAt).toBeNull();
  });

  test("chooseConsoleWorld drops the old world's reads but keeps the world list", () => {
    const a = worldA();
    const b = chooseConsoleWorld(a, "world-b");
    expect(b).toEqual({ ...switchConsoleWorld(a, "world-b"), results: { bootstrap: a.results.bootstrap! } });
    expect(chooseConsoleWorld(b, "world-b")).toBe(b);
  });

  test("an explicitly chosen world that still exists is kept", () => {
    const chosen = switchConsoleWorld(initialConsoleState(), "world-b");
    const s = withBootstrap(chosen, bootstrapValue({ selectedWorld: "world-a" }));
    expect(reconcileConsoleWorld(s)).toBe(s);
  });

  test("a world that no longer exists falls back to the owner of the cwd", () => {
    const gone = switchConsoleWorld(initialConsoleState(), "removed");
    const s = reconcileConsoleWorld(withBootstrap(gone, bootstrapValue({ selectedWorld: "world-a" })));
    expect(s.world).toBe("world-a");
    expect(s.generation).toBe(gone.generation + 1);
  });

  test("a world that no longer exists, with no owner, is cleared and said so", () => {
    const gone = switchConsoleWorld(initialConsoleState(), "removed");
    const boot = bootstrapValue({ selectedWorld: null, resolutionError: "no world owns /x and no catch-all world exists" });
    const s = reconcileConsoleWorld(withBootstrap(gone, boot));
    expect(s.world).toBeNull();
    expect(s.generation).toBe(gone.generation + 1);
    expect(s.error).toContain("removed");
    expect(s.results.bootstrap).toEqual({ ok: true, value: boot });
    // Settled: a second pass changes nothing, so no read loop starts.
    expect(reconcileConsoleWorld(s)).toBe(s);
    expect(text(consoleLines(s))).toContain("no world owns");
  });

  test("no owner and no world: nothing is picked and the reason is shown", () => {
    const boot = bootstrapValue({ selectedWorld: null, resolutionError: "no world owns /x and no catch-all world exists" });
    const s = withBootstrap(initialConsoleState(), boot);
    expect(reconcileConsoleWorld(s)).toBe(s);
    expect(text(consoleLines(s))).toContain("no world owns");
  });

  test("missing config: not set up, nothing picked, setup shown", () => {
    const boot: ConsoleBootstrap = { worlds: [], selectedWorld: null, resolutionError: "The loop is not set up yet. Run `sil init`.", initialized: false };
    const s = withBootstrap(initialConsoleState(), boot);
    expect(reconcileConsoleWorld(s)).toBe(s);
    expect(text(consoleLines(s))).toContain("sil init");
  });

  test("a malformed bootstrap value is an error, not a world", () => {
    const s = applyConsoleRead(initialConsoleState(), 0, reply({ bootstrap: { ok: true, value: { worlds: "nope" } } }), T1);
    expect(reconcileConsoleWorld(s).world).toBeNull();
    expect(text(consoleLines(s))).toMatch(/unreadable|malformed/i);
  });
});

describe("parseConsoleState", () => {
  test("never written: the initial state", () => {
    expect(parseConsoleState(undefined)).toEqual({ state: initialConsoleState(), reset: "none" });
  });

  test("the Task 1 legacy shape is migrated to the initial state", () => {
    expect(parseConsoleState({ opens: 3 })).toEqual({ state: initialConsoleState(), reset: "legacy" });
  });

  test("a valid state reads back as itself", () => {
    const a = worldA();
    expect(parseConsoleState(JSON.parse(JSON.stringify(a)))).toEqual({ state: a, reset: "none" });
  });

  test.each([
    ["a number", 7],
    ["an unknown section", { ...initialConsoleState(), section: "nope" }],
    ["a negative generation", { ...initialConsoleState(), generation: -1 }],
    ["an extra key", { ...initialConsoleState(), opens: 1 }],
    ["a malformed result", { ...initialConsoleState(), results: { x: { ok: "yes" } } }],
    ["legacy plus junk", { opens: 1, junk: true }],
  ])("corrupt (%s) is reset visibly, never called healthy", (_label, value) => {
    const parsed = parseConsoleState(value);
    expect(parsed.reset).toBe("corrupt");
    expect(parsed.state.world).toBeNull();
    expect(parsed.state.results).toEqual({});
    expect(parsed.state.error).toMatch(/reset/i);
  });

  test("the v1.2.9 saved shape migrates with Queue chosen", () => {
    const a = { ...worldA(), section: "activity", listOffset: 10, lessonsOffset: 5, worldOffset: 25 } as Record<string, unknown>;
    delete a.activityTab;
    // Exactly the v1.2.9 keys, nothing more.
    expect(Object.keys(a).sort()).toEqual(
      ["world", "section", "generation", "selectedPattern", "loading", "lastSuccessAt", "results", "error", "listOffset", "proposal", "lessonsOffset", "worldOffset"].sort(),
    );
    const saved = JSON.parse(JSON.stringify(a));
    const parsed = parseConsoleState(saved);
    expect(parsed.reset).toBe("migrated");
    expect(parsed.state).toMatchObject({
      world: "world-a",
      section: "activity",
      selectedPattern: "some-pattern",
      proposal: saved.proposal,
      listOffset: 10,
      lessonsOffset: 5,
      worldOffset: 25,
      activityTab: "queue",
      loading: false,
    });
    expect(parsed.state.results).toEqual(saved.results);
    expect(parsed.state.generation).toBeGreaterThan(saved.generation);
    expect(parsed.state.error).toBeNull();
  });

  test("a saved activityTab outside ACTIVITY_TABS resets as corrupt", () => {
    expect(ACTIVITY_TABS).toEqual(["queue", "reflections", "lessons", "log"]);
    for (const tab of ["lesson", "Queue", "", null, 1, "toString"]) {
      const parsed = parseConsoleState({ ...JSON.parse(JSON.stringify(worldA())), activityTab: tab });
      expect(parsed.reset).toBe("corrupt");
      expect(parsed.state.error).toMatch(/reset/i);
    }
    // Positive control: each listed tab reads back as itself.
    for (const tab of ACTIVITY_TABS) {
      expect(parseConsoleState({ ...JSON.parse(JSON.stringify(worldA())), activityTab: tab }).reset).toBe("none");
    }
  });

  test("setActivityTab keeps generation and results", () => {
    const a = selectConsoleSection(worldA(), "activity");
    const b = setActivityTab(a, "lessons");
    expect(b.activityTab).toBe("lessons");
    expect(b.generation).toBe(a.generation);
    expect(b.results).toBe(a.results);
    expect(b.loading).toBe(a.loading);
    expect({ ...b, activityTab: a.activityTab }).toEqual(a);
    expect(setActivityTab(b, "lessons")).toBe(b);
    // The tab outlives a section or world change.
    expect(selectConsoleSection(selectConsoleSection(b, "overview"), "activity").activityTab).toBe("lessons");
    expect(chooseConsoleWorld(b, "world-b").activityTab).toBe("lessons");
  });

  test("a corrupt state with a readable generation resets past it", () => {
    const parsed = parseConsoleState({ ...initialConsoleState(), generation: 41, section: "nope" });
    expect(parsed.state.generation).toBe(42);
  });
});

describe("consoleReads", () => {
  test("bootstrap and worker always; the world's review queue once a world is chosen", () => {
    expect(consoleReads(initialConsoleState(), "/repo")).toEqual([
      { id: "bootstrap", op: "console.bootstrap", args: { cwd: "/repo" } },
      { id: "worker", op: "worker.status", args: {} },
    ]);
    const reads = consoleReads(switchConsoleWorld(initialConsoleState(), "world-a"), "/repo");
    expect(reads).toContainEqual({ id: "review", op: "console.page", args: { world: "world-a", kind: "review", offset: 0, limit: 1 } });
  });

  test("never a provider probe or a heavy plan read, and within the batch limits", () => {
    for (const section of ["overview", "review", "artifacts", "activity", "settings"] as const) {
      const s = selectConsoleSection(switchConsoleWorld(initialConsoleState(), "world-a"), section);
      const reads = consoleReads(s, "/repo");
      expect(reads.length).toBeLessThanOrEqual(CONTROL_MAX_READS);
      for (const read of reads) {
        expect(read.id).toMatch(CONTROL_ID_RE);
        expect(["health.report", "llm.status", "curriculum.plan", "loop.run"]).not.toContain(read.op);
      }
    }
  });

  test("the refresh period is ten seconds", () => {
    expect(CONSOLE_REFRESH_MS).toBe(10000);
  });
});

// --- the controller ---------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const STATE_ID = "self-improvement-loop/console";

/** A bridge whose replies the test releases one at a time. */
function heldBridge(answer: (request: ControlRequest) => ControlResponse["results"]) {
  const requests: ControlRequest[] = [];
  const pending: Array<{ request: ControlRequest; release: (result?: FakeRunResult) => void }> = [];
  const respond = (init: { stdin?: string } | undefined): Promise<FakeRunResult> => {
    const request = JSON.parse(init?.stdin ?? "null") as ControlRequest;
    requests.push(request);
    return new Promise((resolve) => {
      pending.push({
        request,
        release: (result) =>
          resolve(
            result ?? {
              exitCode: 0,
              stdout: `${JSON.stringify({ version: 1, requestId: request.requestId, results: answer(request) })}\n`,
              stderr: "",
            },
          ),
      });
    });
  };
  return { requests, pending, respond };
}

/** Releases the oldest held reply and lets the controller run on. */
async function releaseNext(bridge: ReturnType<typeof heldBridge>, result?: FakeRunResult): Promise<void> {
  const next = bridge.pending.shift();
  if (!next) throw new Error("no held bridge call");
  next.release(result);
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

function standardAnswer(request: ControlRequest): ControlResponse["results"] {
  const results: ControlResponse["results"] = {};
  for (const read of request.reads) {
    if (read.op === "console.bootstrap") results[read.id] = { ok: true, value: bootstrapValue() };
    else if (read.op === "worker.status") results[read.id] = { ok: true, value: { pending: 4, done: 9, failed: 0, lock_held: false, last_run: T1 } };
    else if (read.op === "console.page" && read.args.kind === "review") results[read.id] = { ok: true, value: reviewPage(String(read.args.world), [`queued-in-${String(read.args.world)}`]) };
    else results[read.id] = { ok: false, error: { code: "OpNotAllowed", message: "not in this test", retryable: false } };
  }
  return results;
}

function controller(options: { openPlaced?: boolean; fail?: { sessionCwd?: boolean } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sil-ui-state-"));
  roots.push(root);
  const bridge = heldBridge(standardAnswer);
  const cwd = join(root, "repo");
  const engine = new FakeEngine({
    sessionId: "s1",
    cwd,
    pluginRoot: join(root, "plugin root"),
    runs: [{ match: (argv) => argv[0] === "/bin/sh", respond: bridge.respond }],
    ...(options.openPlaced === undefined ? {} : { openPlaced: options.openPlaced }),
    ...(options.fail === undefined ? {} : { fail: options.fail }),
  });
  resetUiForTests();
  registerUi(engine.on as never);
  // ../src/register.ts wires the module's one session.end hook this way;
  // register.test.ts checks that wiring through the whole module.
  (engine.on as (event: string, hook: unknown) => void)("session.end", async ($: never, e: unknown, next: (e: unknown) => unknown) => {
    await endConsoleSession($);
    return next(e);
  });
  const state = (): ConsoleUiState => engine.state.get(STATE_ID)?.value as ConsoleUiState;
  const openSil = () => engine.answer<{ text?: string }>("command.run", { command: "sil", args: "" });
  const render = () =>
    engine.answer<FakeElement>("ui.render", { surface: "terminal", component: "Pane", requestId: "sil-console", props: { bodyColumns: 80 } });
  return { engine, bridge, state, openSil, render, cwd };
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

function allText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(allText).join("");
  if (typeof node === "object" && node !== null) {
    const el = node as FakeElement;
    const label = typeof el.props?.label === "string" ? el.props.label : "";
    return `${label}${allText(el.props?.children)}\n`;
  }
  return "";
}

async function press(c: ReturnType<typeof controller>, key: string): Promise<void> {
  const button = findKey(await c.render(), key);
  if (!button) throw new Error(`no button ${key}`);
  (button.props.onPress as (e: unknown) => void)({ surface: "terminal" });
  await settle();
}

describe("console controller", () => {
  test("session start with no pane open reads nothing and starts no timer", async () => {
    const c = controller();
    await c.engine.fire("session.start", { cwd: "/", surface: "terminal", isInteractive: true }, { cwd: "/" });
    await settle();
    expect(c.engine.calls).toContain("command.register sil");
    expect(c.engine.runCalls).toEqual([]);
    expect(c.engine.timers).toEqual([]);
    expect(c.engine.calls.filter((x) => x.startsWith("state."))).toEqual([]);
  });

  test("/sil starts one 10 s timer and reads the bootstrap, then the owning world", async () => {
    const c = controller();
    const ran = await c.openSil();
    expect(ran.text).toBe("Opened the self-improvement loop console.");
    await settle();
    expect(c.engine.liveTimers().map((t) => t.ms)).toEqual([10000]);
    expect(c.bridge.requests).toHaveLength(1);
    expect(c.bridge.requests[0]!.reads.map((r) => r.op)).toEqual(["console.bootstrap", "worker.status"]);
    expect(c.bridge.requests[0]!.reads[0]!.args).toEqual({ cwd: c.cwd });
    expect(c.state().loading).toBe(true);

    await releaseNext(c.bridge);
    // The bootstrap named world-a: switched, and world-a read at once.
    expect(c.state().world).toBe("world-a");
    expect(c.bridge.requests).toHaveLength(2);
    expect(c.bridge.requests[1]!.reads).toContainEqual({ id: "review", op: "console.page", args: { world: "world-a", kind: "review", offset: 0, limit: 1 } });
    await releaseNext(c.bridge);

    const s = c.state();
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
    expect(s.lastSuccessAt).not.toBeNull();
    expect(s.results.review).toEqual({ ok: true, value: reviewPage("world-a", ["queued-in-world-a"]) });
    expect(c.bridge.pending).toEqual([]);

    // Opening again while open adds no second timer.
    await c.openSil();
    await settle();
    expect(c.engine.liveTimers()).toHaveLength(1);
  });

  test("ticks while a read is in flight start no second read", async () => {
    const c = controller();
    await c.openSil();
    await settle();
    expect(c.bridge.pending).toHaveLength(1);
    c.engine.tick();
    c.engine.tick();
    await settle();
    expect(c.bridge.requests).toHaveLength(1);
    await releaseNext(c.bridge);
    // One follow-up read (the owning world), never one per tick.
    expect(c.bridge.requests).toHaveLength(2);
    await releaseNext(c.bridge);
    expect(c.bridge.pending).toEqual([]);
    c.engine.tick();
    await settle();
    expect(c.bridge.requests).toHaveLength(3);
    await releaseNext(c.bridge);
  });

  test("a world change during a slow read drops the old world's reply", async () => {
    const c = controller();
    await c.openSil();
    await settle();
    await releaseNext(c.bridge); // bootstrap -> world-a
    expect(c.bridge.pending).toHaveLength(1); // world-a read, held
    await press(c, "world-world-b");
    expect(c.state().world).toBe("world-b");
    expect(Object.keys(c.state().results)).toEqual(["bootstrap"]);
    // No overlap: world-b waits for the world-a read to finish.
    expect(c.bridge.requests).toHaveLength(2);

    await releaseNext(c.bridge); // the late world-a reply
    expect(c.state().world).toBe("world-b");
    expect(c.state().results.review).toBeUndefined();
    expect(c.bridge.requests).toHaveLength(3);
    expect(c.bridge.requests[2]!.reads).toContainEqual({ id: "review", op: "console.page", args: { world: "world-b", kind: "review", offset: 0, limit: 1 } });
    await releaseNext(c.bridge);
    expect(c.state().results.review).toEqual({ ok: true, value: reviewPage("world-b", ["queued-in-world-b"]) });
  });

  test("a failed bridge leaves the last data visible and labelled stale", async () => {
    const c = controller();
    await c.openSil();
    await settle();
    await releaseNext(c.bridge);
    await releaseNext(c.bridge);
    const good = c.state();
    c.engine.tick();
    await settle();
    await releaseNext(c.bridge, { exitCode: 1, stdout: "", stderr: "boom sk-secret-0123456789" });
    const s = c.state();
    expect(s.results).toEqual(good.results);
    expect(s.lastSuccessAt).toBe(good.lastSuccessAt);
    expect(s.error).toContain("exited with 1");
    expect(s.error).not.toContain("sk-secret");
    const drawn = allText(await c.render());
    expect(drawn).toContain("exited with 1");
    expect(drawn).toMatch(/stale/i);
    expect(drawn).toContain("Pending: 4");
  });

  test("render reads the state and never writes it", async () => {
    const c = controller();
    await c.openSil();
    await settle();
    await releaseNext(c.bridge);
    await releaseNext(c.bridge);
    const before = c.engine.calls.length;
    const drawn = allText(await c.render());
    const during = c.engine.calls.slice(before);
    expect(during).toContain(`state.get ${STATE_ID}`);
    expect(during.filter((x) => x.startsWith("state.set") || x.startsWith("process.run"))).toEqual([]);
    expect(drawn).toContain("world-a");
    expect(drawn).toContain("Overview");
  });

  test("a pane that is open but not placed is not read", async () => {
    const c = controller({ openPlaced: false });
    const ran = await c.openSil();
    expect(ran.text).toContain("cannot show it yet");
    await settle();
    c.engine.tick();
    await settle();
    expect(c.bridge.requests).toEqual([]);
    // Placed later: the running timer picks it up.
    c.engine.panes[0]!.isPlaced = true;
    c.engine.panes[0]!.isShown = true;
    c.engine.tick();
    await settle();
    expect(c.bridge.requests).toHaveLength(1);
    await releaseNext(c.bridge);
    await releaseNext(c.bridge);
  });

  test("close stops the timer and drops a read still in flight", async () => {
    const c = controller();
    await c.openSil();
    await settle();
    const gen = c.state().generation;
    await c.engine.fire("ui.close", { id: "sil-console", origin: { kind: "person" } }, { value: undefined });
    c.engine.panes = [];
    expect(c.engine.liveTimers()).toEqual([]);
    expect(c.state().generation).toBe(gen + 1);
    await releaseNext(c.bridge);
    expect(c.state().world).toBeNull();
    expect(c.state().loading).toBe(false);
    c.engine.tick();
    await settle();
    expect(c.bridge.requests).toHaveLength(1);
  });

  test("after /clear, /sil works again with no session.start", async () => {
    const c = controller();
    await c.openSil();
    await settle();
    await releaseNext(c.bridge);
    await releaseNext(c.bridge);
    await c.engine.fire("session.end", { reason: "clear", sessionId: "s1" }, { sessionId: "s1" });
    expect(c.engine.liveTimers()).toEqual([]);
    const reads = c.bridge.requests.length;

    await c.openSil();
    await settle();
    expect(c.engine.liveTimers()).toHaveLength(1);
    expect(c.bridge.requests.length).toBe(reads + 1);
    await releaseNext(c.bridge);
    expect(c.state().world).toBe("world-a");
  });

  test("a reload keeps the chosen world, invalidates old work and keeps one timer", async () => {
    const c = controller();
    await c.openSil();
    await settle();
    await releaseNext(c.bridge);
    await releaseNext(c.bridge);
    await press(c, "world-world-b");
    await releaseNext(c.bridge);
    c.engine.tick();
    await settle();
    expect(c.bridge.pending).toHaveLength(1); // a world-b read held across the reload
    const gen = c.state().generation;

    // Reload: the engine drops the old environment's timers, the module starts
    // over, and session.start runs again with the pane still up.
    for (const t of c.engine.timers) t.cancelled = true;
    resetUiForTests();
    await c.engine.fire("session.start", { cwd: "/", surface: "terminal", isInteractive: true }, { cwd: "/" });
    await settle();
    expect(c.state().world).toBe("world-b");
    expect(c.state().generation).toBeGreaterThan(gen);
    expect(c.engine.liveTimers()).toHaveLength(1);

    // The old instance's late reply lands nowhere.
    const before = c.state();
    await releaseNext(c.bridge, {
      exitCode: 0,
      stdout: `${JSON.stringify({ version: 1, requestId: c.bridge.requests[c.bridge.requests.length - 2]!.requestId, results: { bootstrap: { ok: true, value: bootstrapValue() }, worker: { ok: true, value: { pending: 99 } }, review: { ok: true, value: reviewPage("world-a", ["stale-reload"]) } } })}\n`,
      stderr: "",
    });
    expect(JSON.stringify(c.state().results)).not.toContain("stale-reload");
    expect(c.state().world).toBe(before.world);
    for (const p of c.bridge.pending.splice(0)) p.release();
    await settle();
  });

  test("two rapid controls both land", async () => {
    const c = controller();
    await c.openSil();
    await settle();
    await releaseNext(c.bridge);
    await releaseNext(c.bridge);
    const tree = await c.render();
    const section = findKey(tree, "section-review")!;
    const world = findKey(tree, "world-world-b")!;
    (section.props.onPress as (e: unknown) => void)({});
    (world.props.onPress as (e: unknown) => void)({});
    await settle();
    expect(c.state().section).toBe("review");
    expect(c.state().world).toBe("world-b");
    for (const p of c.bridge.pending.splice(0)) p.release();
    await settle();
  });

  test("a competing write between read and write is retried, not lost", async () => {
    const c = controller();
    await c.openSil();
    await settle();
    await releaseNext(c.bridge);
    await releaseNext(c.bridge);
    let slipped = false;
    c.engine.beforeStateSet = (id) => {
      if (slipped) return;
      slipped = true;
      const cur = c.engine.state.get(id)!;
      c.engine.state.set(id, { value: { ...(cur.value as ConsoleUiState), section: "activity" }, version: cur.version + 1 });
    };
    await press(c, "world-world-b");
    expect(slipped).toBe(true);
    expect(c.state().world).toBe("world-b");
    expect(c.state().section).toBe("activity");
    for (const p of c.bridge.pending.splice(0)) p.release();
    await settle();
  });

  test("a legacy saved state is migrated on open, a corrupt one is reset visibly", async () => {
    const c = controller();
    c.engine.state.set(STATE_ID, { value: { opens: 2 }, version: 3 });
    await c.openSil();
    await settle();
    expect(c.state().error).toBeNull();
    for (const p of c.bridge.pending.splice(0)) p.release();
    await settle();

    const d = controller();
    d.engine.state.set(STATE_ID, { value: { garbage: true }, version: 1 });
    expect(allText(await d.render())).toMatch(/reset/i);
    // Render did not repair it: only a handler writes.
    expect(d.engine.state.get(STATE_ID)!.value).toEqual({ garbage: true });
  });

  test("the classic tool hooks start no timer and no read", async () => {
    const c = controller();
    const events = c.engine.registrations.map((r) => r.event);
    expect(events).not.toContain("classic.PreToolUse");
    expect(events).not.toContain("classic.PostToolUse");
    // session.end here is the test's own stand-in for ../src/register.ts.
    expect(events.sort()).toEqual(["command.run", "session.end", "session.start", "ui.close", "ui.render"]);
  });
});

// --- fix round 1: lifecycle cancellation, refused close, pre-bridge failure ---

const CLOSE = { id: "sil-console", origin: { kind: "person" } };

async function endSession(c: ReturnType<typeof controller>): Promise<void> {
  await c.engine.fire("session.end", { reason: "clear", sessionId: "s1" }, { sessionId: "s1" });
  await settle();
}

async function openAndSettle(c: ReturnType<typeof controller>): Promise<void> {
  await c.openSil();
  await settle();
  await releaseNext(c.bridge); // bootstrap -> world-a
  await releaseNext(c.bridge); // world-a
}

describe("console lifecycle", () => {
  test("a tick queued behind a held read does not launch after session end", async () => {
    const c = controller();
    await c.openSil();
    await settle();
    expect(c.bridge.pending).toHaveLength(1);
    c.engine.tick();
    c.engine.tick();
    await settle();
    await endSession(c);
    expect(c.engine.liveTimers()).toEqual([]);
    await releaseNext(c.bridge);
    expect(c.bridge.requests).toHaveLength(1);
    expect(c.state().loading).toBe(false);
  });

  test("a world change queued behind a held read does not launch after session end", async () => {
    const c = controller();
    await openAndSettle(c);
    c.engine.tick();
    await settle();
    expect(c.bridge.pending).toHaveLength(1);
    await press(c, "world-world-b");
    await endSession(c);
    const before = c.bridge.requests.length;
    await releaseNext(c.bridge);
    expect(c.bridge.requests).toHaveLength(before);
    expect(c.bridge.pending).toEqual([]);
  });

  test("reopening before an old reply returns: the old reply is dropped, the new lifecycle reads once", async () => {
    const c = controller();
    await c.openSil();
    await settle();
    expect(c.bridge.pending).toHaveLength(1); // old lifecycle's bootstrap, held
    await endSession(c);
    await c.openSil();
    await settle();
    // No overlap: the new lifecycle waits for the old read to end.
    expect(c.bridge.requests).toHaveLength(1);
    expect(c.engine.liveTimers()).toHaveLength(1);
    await releaseNext(c.bridge, {
      exitCode: 0,
      stdout: `${JSON.stringify({ version: 1, requestId: c.bridge.requests[0]!.requestId, results: { bootstrap: { ok: true, value: bootstrapValue({ selectedWorld: "world-b" }) }, worker: { ok: true, value: { pending: 77, done: 0, failed: 0 } } } })}\n`,
      stderr: "",
    });
    expect(c.state().world).toBeNull();
    expect(JSON.stringify(c.state().results)).not.toContain("77");
    // Exactly one follow-up, for the new lifecycle.
    expect(c.bridge.requests).toHaveLength(2);
    await releaseNext(c.bridge);
    expect(c.state().world).toBe("world-a");
    await releaseNext(c.bridge);
    expect(c.bridge.pending).toEqual([]);
  });

  test("a confirmed close cancels the timer and the queued follow-up", async () => {
    const c = controller();
    await c.openSil();
    await settle();
    c.engine.tick();
    await settle();
    await c.engine.fire("ui.close", CLOSE, { value: undefined });
    // The pane is left in the fake's list on purpose: the cancellation itself,
    // not a later visibility check, must stop the queued follow-up.
    await releaseNext(c.bridge);
    expect(c.bridge.requests).toHaveLength(1);
    expect(c.engine.liveTimers()).toEqual([]);
  });

  test("a close refused beneath keeps the timer and the refresh", async () => {
    const c = controller();
    await openAndSettle(c);
    const gen = c.state().generation;
    const result = await c.engine.fire("ui.close", CLOSE, { deny: "refused beneath" });
    expect(result).toEqual({ deny: "refused beneath" });
    expect(c.engine.liveTimers()).toHaveLength(1);
    expect(c.state().generation).toBe(gen);
    c.engine.tick();
    await settle();
    expect(c.bridge.pending).toHaveLength(1);
    await releaseNext(c.bridge);
  });

  test("a close that throws beneath keeps the timer and the refresh", async () => {
    const c = controller();
    await openAndSettle(c);
    await expect(
      c.engine.fire("ui.close", CLOSE, { value: undefined }, () => {
        throw new Error("close threw beneath");
      }),
    ).rejects.toThrow("close threw beneath");
    expect(c.engine.liveTimers()).toHaveLength(1);
    c.engine.tick();
    await settle();
    expect(c.bridge.pending).toHaveLength(1);
    await releaseNext(c.bridge);
  });

  test("a failure before the bridge is shown, loading ends, nothing is launched", async () => {
    const c = controller({ fail: { sessionCwd: true } });
    await c.openSil();
    await settle();
    expect(c.engine.runCalls).toEqual([]);
    const s = c.state();
    expect(s.loading).toBe(false);
    expect(s.error).toContain("could not read the loop");
    expect(s.error).not.toContain("/private/fake/path");
    expect(allText(await c.render())).toContain("could not read the loop");
  });

  test("open but hidden: each tick only asks where the pane is", async () => {
    const c = controller({ openPlaced: false });
    await c.openSil();
    await settle();
    const before = c.engine.calls.length;
    c.engine.tick();
    c.engine.tick();
    await settle();
    expect(c.engine.calls.slice(before)).toEqual(["ui.panes", "ui.panes"]);
    expect(c.engine.liveTimers()).toHaveLength(1);
    // A confirmed close and a session end each stop it.
    await c.engine.fire("ui.close", CLOSE, { value: undefined });
    c.engine.panes = [];
    expect(c.engine.liveTimers()).toEqual([]);
    await c.openSil();
    await settle();
    expect(c.engine.liveTimers()).toHaveLength(1);
    await endSession(c);
    expect(c.engine.liveTimers()).toEqual([]);
    expect(c.bridge.requests).toEqual([]);
  });

  // A control pressed while the console is up belongs to that lifecycle. If an
  // end or a confirmed close lands while its state write is still queued, the
  // write and the read after it are dropped: an old press is not a new one.
  const QUEUED_CONTROLS: [string, ConsoleAction][] = [
    ["world", { kind: "world", world: "world-b" }],
    ["section", { kind: "section", section: "artifacts" }],
    ["list page", { kind: "list", offset: 25 }],
    ["lessons page", { kind: "lessons", offset: 5 }],
    ["world window", { kind: "worlds", offset: 0 }],
    ["proposal select", { kind: "select", pattern: "queued-in-world-a" }],
    ["refresh", { kind: "refresh" }],
  ];
  const STOPS: [string, (c: ReturnType<typeof controller>) => Promise<unknown>][] = [
    ["session end", (c) => c.engine.fire("session.end", { reason: "clear", sessionId: "s1" }, { sessionId: "s1" })],
    ["confirmed close", (c) => c.engine.fire("ui.close", CLOSE, { value: undefined })],
  ];
  for (const [stopName, stop] of STOPS) {
    test.each(QUEUED_CONTROLS)(`a %s control held in the state write queue is dropped by a ${stopName}`, async (_name, action) => {
      const c = controller();
      await openAndSettle(c);
      const before = { requests: c.bridge.requests.length, world: c.state().world, section: c.state().section };
      expect(c.engine.liveTimers()).toHaveLength(1);
      let release!: () => void;
      c.engine.stateGate = new Promise<void>((r) => (release = r));
      consoleAct(c.engine.$ as never, action);
      await settle();
      const stopped = stop(c);
      await settle();
      expect(c.engine.liveTimers()).toEqual([]);
      release();
      c.engine.stateGate = null;
      await stopped;
      await settle();
      c.engine.tick();
      await settle();
      expect(c.bridge.requests).toHaveLength(before.requests);
      expect(c.bridge.pending).toEqual([]);
      expect(c.engine.liveTimers()).toEqual([]);
      expect({ world: c.state().world, section: c.state().section }).toEqual({ world: before.world, section: before.section });
      expect(c.state().loading).toBe(false);
    });
  }

  test("a control pressed after the end starts a new lifecycle, even with its write held", async () => {
    const c = controller();
    await openAndSettle(c);
    await endSession(c);
    expect(c.engine.liveTimers()).toEqual([]);
    const before = c.bridge.requests.length;
    let release!: () => void;
    c.engine.stateGate = new Promise<void>((r) => (release = r));
    consoleAct(c.engine.$ as never, { kind: "world", world: "world-b" });
    await settle();
    // Decided at the press, not when the write lands.
    expect(c.engine.liveTimers()).toHaveLength(1);
    release();
    c.engine.stateGate = null;
    await settle();
    expect(c.bridge.requests).toHaveLength(before + 1);
    expect(c.bridge.requests.at(-1)!.reads.some((r) => r.args["world"] === "world-b")).toBe(true);
    await releaseNext(c.bridge);
    expect(c.state().world).toBe("world-b");
    expect(c.engine.liveTimers()).toHaveLength(1);
  });

  test("an explicit Refresh after the end reads again and restarts the timer", async () => {
    const c = controller();
    await openAndSettle(c);
    await endSession(c);
    const before = c.bridge.requests.length;
    consoleAct(c.engine.$ as never, { kind: "refresh" });
    await settle();
    expect(c.bridge.requests).toHaveLength(before + 1);
    expect(c.engine.liveTimers()).toHaveLength(1);
  });

  test("session end with the console never opened does no console state work", async () => {
    const c = controller();
    await endSession(c);
    expect(c.engine.calls.filter((x) => x.startsWith("state.") || x.startsWith("ui."))).toEqual([]);
  });
});
