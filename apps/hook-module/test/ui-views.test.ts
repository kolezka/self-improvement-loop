// The native console's sections: paging and selection state (pure), the
// view model each section draws from (pure), and the controller's scope
// changes through the fake engine. The real engine runs the drawing in
// native-test/views.native.tsx.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTROL_ID_RE, CONTROL_MAX_READS, type ControlRequest, type ControlResponse, type ControlResult } from "@sil/core/control-protocol";
import { registerUi, resetUiForTests } from "../src/ui/register.ts";
import {
  applyConsoleRead,
  chooseConsoleWorld,
  initialConsoleState,
  parseConsoleState,
  reloadProposal,
  selectConsolePattern,
  selectConsoleSection,
  setConsoleListOffset,
  setLessonsOffset,
  setWorldOffset,
  setProposalPart,
  switchConsoleWorld,
  turnProposalPage,
  type ConsoleUiState,
} from "../src/ui/state.ts";
import {
  blockChars,
  card,
  consoleControls,
  consoleReads,
  consoleView,
  DISPLAY_BUDGET,
  enforceDisplayBudget,
  finishView,
  flattenBlocks,
  isWholeHunks,
  NARROW_COLUMNS,
  WORLD_WINDOW,
  type ConsoleBlock,
} from "../src/ui/views.ts";
import { FakeEngine, type FakeElement, type FakeRunResult } from "./fake-engine.ts";

const T1 = "2026-10-22T12:00:00.000Z";
const DIGEST = "0123456789abcdef".repeat(4);
const OTHER = "f".repeat(64);
const BOOT = { worlds: ["world-a", "world-b"], selectedWorld: "world-a", resolutionError: null, initialized: true };
const WORKER = { pending: 4, done: 9, failed: 0, lock_held: false, last_run: T1 };

function reply(results: ControlResponse["results"]): ControlResponse {
  return { version: 1, requestId: "r", results };
}

function ok(value: unknown): ControlResult {
  return { ok: true, value };
}

function base(): ConsoleUiState {
  const s = switchConsoleWorld(initialConsoleState(), "world-a");
  return applyConsoleRead(s, s.generation, reply({ bootstrap: ok(BOOT), worker: ok(WORKER), review: ok(listPage({ total: 1, limit: 1, items: [reviewItem("p-one")] })) }), T1);
}

function listPage(over: Partial<{ total: number; offset: number; limit: number; items: unknown[]; world: string }> = {}) {
  return { world: "world-a", total: 2, offset: 0, limit: 10, items: [reviewItem("p-one"), reviewItem("p-two")], ...over };
}

function reviewItem(pattern: string) {
  return { world: "world-a", pattern, branch: `curriculum/world-a/${pattern}`, artifact_type: "skill", status: "staged", artifact_path: null, count: 3, staged_at: null, commit: "abc1234" };
}

function page(over: Record<string, unknown> = {}) {
  const text = (over.text as string | undefined) ?? "@@ -1,1 +1,2 @@\n line\n+added\n";
  return {
    world: "world-a",
    pattern: "p-one",
    part: "diff",
    text,
    offset: 0,
    lineCount: text === "" ? 0 : text.split("\n").length - 1,
    nextOffset: null,
    totalLines: 3,
    totalBytes: 30,
    reviewedState: DIGEST,
    complete: true,
    oversizedLine: null,
    ...over,
  };
}

/** The review section with p-one open on its diff, `value` its page. */
function reviewing(value: unknown, state = base()): ConsoleUiState {
  let s = selectConsoleSection(state, "review");
  s = selectConsolePattern(s, "p-one");
  s = setProposalPart(s, "diff");
  return applyConsoleRead(s, s.generation, reply({ bootstrap: ok(BOOT), worker: ok(WORKER), list: ok(listPage()), proposal: ok(value) }), T1);
}

function texts(blocks: ConsoleBlock[]): string {
  return flattenBlocks(blocks)
    .map((b) => {
      if (b.kind === "line") return b.line.text;
      if (b.kind === "code") return b.source;
      if (b.kind === "select") return `${b.label} ${b.options.map((o) => o.label).join(" ")}`;
      if (b.kind === "card") return [b.title, ...(b.meta === undefined ? [] : [b.meta])].join(" ");
      return [...(b.label === undefined ? [] : [b.label]), ...b.controls.map((c) => c.label)].join(" ");
    })
    .join("\n");
}

function keys(blocks: ConsoleBlock[]): string[] {
  return flattenBlocks(blocks).flatMap((b) => (b.kind === "controls" ? b.controls.map((c) => c.key) : b.kind === "select" ? [b.key] : []));
}

const WIDE = { columns: 60, canSelect: true };
const NARROW = { columns: 30, canSelect: true };

describe("paging and selection state", () => {
  test("the initial state has no page and no proposal open", () => {
    expect(initialConsoleState()).toMatchObject({ listOffset: 0, proposal: null, selectedPattern: null });
  });

  test("a section change is a new read scope: generation moves, only global reads stay", () => {
    const a = selectConsoleSection(selectConsolePattern(selectConsoleSection(base(), "review"), "p-one"), "review");
    const withList = applyConsoleRead(a, a.generation, reply({ list: ok(listPage()), proposal: ok(page()) }), T1);
    const b = selectConsoleSection(withList, "artifacts");
    expect(b.generation).toBe(withList.generation + 1);
    expect(b).toMatchObject({ section: "artifacts", listOffset: 0, selectedPattern: null, proposal: null, loading: false });
    expect(Object.keys(b.results).sort()).toEqual(["bootstrap", "worker"]);
    // A late reply for the review section never lands under Artifacts.
    expect(applyConsoleRead(b, withList.generation, reply({ list: ok(listPage()) }), T1)).toEqual(b);
    expect(selectConsoleSection(b, "artifacts")).toBe(b);
  });

  test("opening a proposal drops only the old proposal page and starts unbound at line 0", () => {
    const s = reviewing(page());
    const t = selectConsolePattern(s, "p-two");
    expect(t.generation).toBe(s.generation + 1);
    expect(t.selectedPattern).toBe("p-two");
    expect(t.proposal).toEqual({ part: "body", offset: 0, back: [], reviewedState: null });
    expect(t.results.proposal).toBeUndefined();
    expect(t.results.list).toEqual(s.results.list!);
    expect(applyConsoleRead(t, s.generation, reply({ proposal: ok(page({ pattern: "p-one" })) }), T1)).toEqual(t);
    const closed = selectConsolePattern(t, null);
    expect(closed).toMatchObject({ selectedPattern: null, proposal: null });
  });

  test("the first page pins the digest; later pages ask for exactly it", () => {
    const s = reviewing(page({ nextOffset: 2, complete: false, lineCount: 2 }));
    expect(s.proposal?.reviewedState).toBe(DIGEST);
    const next = turnProposalPage(s, "next");
    expect(next.proposal).toEqual({ part: "diff", offset: 2, back: [0], reviewedState: DIGEST });
    expect(next.results.proposal).toBeUndefined();
    const read = consoleReads(next, "/repo").find((r) => r.id === "proposal");
    expect(read).toEqual({ id: "proposal", op: "console.proposalPage", args: { world: "world-a", pattern: "p-one", part: "diff", offset: 2, limit: 200, expectedState: DIGEST } });
    // A page from another revision does not move the pin.
    const other = applyConsoleRead(next, next.generation, reply({ proposal: ok(page({ offset: 2, reviewedState: OTHER })) }), T1);
    expect(other.proposal?.reviewedState).toBe(DIGEST);
  });

  test("previous and first walk back; next at the end and previous at the start change nothing", () => {
    const s = reviewing(page({ nextOffset: 2, complete: false, lineCount: 2 }));
    expect(turnProposalPage(s, "prev")).toBe(s);
    expect(turnProposalPage(s, "first")).toBe(s);
    const p2 = turnProposalPage(s, "next");
    const back = turnProposalPage(p2, "prev");
    expect(back.proposal).toEqual({ part: "diff", offset: 0, back: [], reviewedState: DIGEST });
    expect(turnProposalPage(p2, "first").proposal).toEqual({ part: "diff", offset: 0, back: [], reviewedState: DIGEST });
    // The read for this page has not come back: no next yet.
    expect(turnProposalPage(p2, "next")).toBe(p2);
    const end = reviewing(page());
    expect(turnProposalPage(end, "next")).toBe(end);
  });

  test("switching body and diff keeps the pin and starts at line 0; reload drops the pin", () => {
    const s = turnProposalPage(reviewing(page({ nextOffset: 2, complete: false, lineCount: 2 })), "next");
    const body = setProposalPart(s, "body");
    expect(body.proposal).toEqual({ part: "body", offset: 0, back: [], reviewedState: DIGEST });
    expect(body.generation).toBe(s.generation + 1);
    expect(setProposalPart(body, "body")).toBe(body);
    const fresh = reloadProposal(body);
    expect(fresh.proposal).toEqual({ part: "body", offset: 0, back: [], reviewedState: null });
    expect(fresh.generation).toBe(body.generation + 1);
  });

  test("a list page change is a new scope for the list only", () => {
    const s = selectConsoleSection(base(), "review");
    const r = applyConsoleRead(s, s.generation, reply({ list: ok(listPage({ total: 30 })) }), T1);
    const t = setConsoleListOffset(r, 10);
    expect(t).toMatchObject({ listOffset: 10, generation: r.generation + 1 });
    expect(t.results.list).toBeUndefined();
    expect(setConsoleListOffset(t, 10)).toBe(t);
    expect(() => setConsoleListOffset(t, -1)).toThrow();
  });

  test("a world switch drops the page and the open proposal", () => {
    const s = setConsoleListOffset(reviewing(page()), 10);
    const b = chooseConsoleWorld(s, "world-b");
    expect(b).toMatchObject({ world: "world-b", listOffset: 0, selectedPattern: null, proposal: null, section: "review" });
  });

  test("the Task 4 saved shape migrates: world, section and selection kept, cached reads dropped", () => {
    const task4 = {
      world: "world-a",
      section: "review",
      generation: 7,
      selectedPattern: "p-one",
      loading: true,
      lastSuccessAt: T1,
      results: { bootstrap: ok(BOOT), worker: ok(WORKER), review: ok([]) },
      error: null,
    };
    const parsed = parseConsoleState(task4);
    expect(parsed.reset).toBe("migrated");
    expect(parsed.state).toMatchObject({
      world: "world-a",
      section: "review",
      selectedPattern: "p-one",
      generation: 8,
      loading: false,
      listOffset: 0,
      proposal: { part: "body", offset: 0, back: [], reviewedState: null },
    });
    expect(Object.keys(parsed.state.results).sort()).toEqual(["bootstrap", "worker"]);
  });

  test.each([
    ["a selection with no proposal view", { selectedPattern: "p-one", proposal: null }],
    ["a proposal view with no selection", { selectedPattern: null, proposal: { part: "body", offset: 0, back: [], reviewedState: null } }],
    ["a negative list offset", { listOffset: -1 }],
    ["a bad digest", { selectedPattern: "p", proposal: { part: "body", offset: 0, back: [], reviewedState: "xyz" } }],
    ["an unknown part", { selectedPattern: "p", proposal: { part: "patch", offset: 0, back: [], reviewedState: null } }],
    ["an endless back stack", { selectedPattern: "p", proposal: { part: "body", offset: 0, back: Array.from({ length: 201 }, (_, i) => i), reviewedState: null } }],
  ])("a saved state with %s is reset visibly", (_label, over) => {
    const parsed = parseConsoleState({ ...initialConsoleState(), ...over });
    expect(parsed.reset).toBe("corrupt");
    expect(parsed.state.error).toMatch(/reset/i);
  });

  test("a valid paged state reads back as itself", () => {
    const s = turnProposalPage(reviewing(page({ nextOffset: 2, complete: false, lineCount: 2 })), "next");
    expect(parseConsoleState(JSON.parse(JSON.stringify(s)))).toEqual({ state: s, reset: "none" });
  });
});

describe("reads per section", () => {
  test("each section reads only what it draws, within the batch limits", () => {
    const at = (section: Parameters<typeof selectConsoleSection>[1]) => consoleReads(selectConsoleSection(base(), section), "/repo");
    const ops = (section: Parameters<typeof selectConsoleSection>[1]) => at(section).map((r) => `${r.id}:${r.op}`);
    expect(ops("overview")).toEqual(["bootstrap:console.bootstrap", "worker:worker.status", "review:console.page"]);
    expect(at("overview").find((r) => r.id === "review")!.args).toEqual({ world: "world-a", kind: "review", offset: 0, limit: 1 });
    expect(ops("review")).toEqual(["bootstrap:console.bootstrap", "worker:worker.status", "list:console.page"]);
    expect(at("review").find((r) => r.id === "list")!.args).toEqual({ world: "world-a", kind: "review", offset: 0, limit: 10 });
    expect(ops("artifacts")).toEqual(["bootstrap:console.bootstrap", "worker:worker.status", "list:console.page"]);
    expect(at("artifacts").find((r) => r.id === "list")!.args).toMatchObject({ kind: "artifacts" });
    expect(ops("activity")).toEqual([
      "bootstrap:console.bootstrap",
      "worker:worker.status",
      "queue:queue.list",
      "logs:logs.tail",
      "list:console.page",
      "lessons:console.page",
    ]);
    expect(at("activity").find((r) => r.id === "lessons")!.args).toEqual({ world: "world-a", kind: "lessons", offset: 0, limit: 5 });
    expect(at("activity").find((r) => r.id === "logs")!.args).toEqual({ name: "worker", lines: 20 });
    expect(ops("settings")).toEqual(["bootstrap:console.bootstrap", "worker:worker.status"]);
    for (const section of ["overview", "review", "artifacts", "activity", "settings"] as const) {
      const reads = at(section);
      expect(reads.length).toBeLessThanOrEqual(CONTROL_MAX_READS);
      for (const r of reads) {
        expect(r.id).toMatch(CONTROL_ID_RE);
        expect(["health.report", "llm.status", "curriculum.plan", "loop.run", "skill.accept"]).not.toContain(r.op);
      }
    }
  });

  test("the open proposal's first page is read unbound", () => {
    const s = selectConsolePattern(selectConsoleSection(base(), "review"), "p-one");
    expect(consoleReads(s, "/repo").find((r) => r.id === "proposal")).toEqual({
      id: "proposal",
      op: "console.proposalPage",
      args: { world: "world-a", pattern: "p-one", part: "body", offset: 0, limit: 200 },
    });
  });

  test("global activity reads run with no world; world reads wait for one", () => {
    const s = selectConsoleSection(initialConsoleState(), "activity");
    expect(consoleReads(s, "/repo").map((r) => r.id)).toEqual(["bootstrap", "worker", "queue", "logs"]);
  });
});

describe("the view model", () => {
  test("wide: section buttons; narrow: one section Select; narrow without Select: buttons", () => {
    expect(NARROW_COLUMNS).toBe(44);
    const s = base();
    const wide = consoleView(s, WIDE);
    expect(keys(wide)).toEqual(expect.arrayContaining(["section-overview", "section-review", "section-artifacts", "section-activity", "section-settings", "world-world-a", "refresh", "close"]));
    expect(keys(wide)).not.toContain("section-select");
    expect(keys(consoleView(s, { columns: 44, canSelect: true }))).toContain("section-review");
    const narrow = consoleView(s, { columns: 43, canSelect: true });
    expect(keys(narrow)).toContain("section-select");
    expect(keys(narrow)).toContain("world-select");
    expect(keys(narrow)).not.toContain("section-review");
    const select = narrow.find((b) => b.kind === "select" && b.key === "section-select");
    expect(select).toMatchObject({ value: "overview", options: expect.arrayContaining([{ value: "review", label: "Review" }]) });
    const mobile = consoleView(s, { columns: 30, canSelect: false });
    expect(keys(mobile)).toContain("section-review");
    expect(keys(mobile)).not.toContain("section-select");
  });

  test("narrow review: the list, or the open proposal with a way back, never both", () => {
    const s = reviewing(page());
    const narrow = keys(consoleView(s, NARROW));
    expect(narrow).toContain("proposal-back");
    expect(narrow).not.toContain("proposal-p-two");
    const list = keys(consoleView(selectConsolePattern(s, null), NARROW));
    expect(list).toEqual(expect.arrayContaining(["proposal-p-one", "proposal-p-two"]));
    expect(list).not.toContain("proposal-back");
    const wide = keys(consoleView(s, WIDE));
    expect(wide).toEqual(expect.arrayContaining(["proposal-p-one", "proposal-p-two", "part-body", "part-diff"]));
  });

  test("a whole proposal page: the full digest, the text, and the end said in words", () => {
    const view = consoleView(reviewing(page()), WIDE);
    const shown = texts(view);
    expect(shown).toContain(DIGEST);
    expect(shown).toContain("End of the diff");
    expect(shown).toMatch(/read only/i);
    const code = view.filter((b) => b.kind === "code");
    expect(code).toEqual([{ kind: "code", source: "@@ -1,1 +1,2 @@\n line\n+added\n", diff: true }]);
    expect(keys(view).filter((k) => /accept|reject|revise/.test(k))).toEqual([]);
  });

  test("a partial page says more follows and offers the next page", () => {
    const view = consoleView(reviewing(page({ text: "+a\n+b\n", lineCount: 2, totalLines: 9, nextOffset: 2, complete: false })), WIDE);
    expect(texts(view)).toMatch(/not the whole diff/);
    expect(texts(view)).not.toContain("End of the diff");
    expect(texts(view)).toContain("lines 1-2 of 9");
    expect(keys(view)).toContain("page-next");
    // A page cut mid-hunk is plain text, not a diff the engine would refuse.
    expect(view.filter((b) => b.kind === "code")).toEqual([{ kind: "code", source: "+a\n+b\n", diff: false }]);
  });

  test("an oversized line is reported, not drawn, and never called the end", () => {
    const view = consoleView(reviewing(page({ text: "", lineCount: 0, totalLines: 5, nextOffset: 3, complete: false, offset: 0, oversizedLine: { line: 1, bytes: 90000 } })), WIDE);
    const shown = texts(view);
    expect(shown).toContain("Line 1 of 5 is 90000 bytes");
    expect(shown).not.toContain("End of the diff");
    expect(view.filter((b) => b.kind === "code")).toEqual([]);
    expect(keys(view)).toContain("page-next");
  });

  test("a changed proposal is an error with a way to start again, not a joined text", () => {
    const s = reviewing(page());
    const next = applyConsoleRead(s, s.generation, reply({ proposal: { ok: false, error: { code: "ProposalChanged", message: "changed since its first page", retryable: false } } }), T1);
    const view = consoleView(next, WIDE);
    expect(texts(view)).toMatch(/changed while you were reading/);
    expect(keys(view)).toContain("proposal-reload");
    expect(view.filter((b) => b.kind === "code")).toEqual([]);
    // A page of another revision is refused the same way, even with no error.
    const other = applyConsoleRead(s, s.generation, reply({ proposal: ok(page({ reviewedState: OTHER })) }), T1);
    expect(texts(consoleView(other, WIDE))).toMatch(/changed while you were reading/);
    expect(consoleView(other, WIDE).filter((b) => b.kind === "code")).toEqual([]);
  });

  test("a page over the byte cap or for another scope is refused visibly", () => {
    const big = consoleView(reviewing(page({ text: `${"x".repeat(65536)}\n`, lineCount: 1, totalLines: 1 })), WIDE);
    expect(big.filter((b) => b.kind === "code")).toEqual([]);
    expect(texts(big)).toMatch(/unexpected shape|not shown/i);
    const elsewhere = consoleView(reviewing(page({ pattern: "p-two" })), WIDE);
    expect(elsewhere.filter((b) => b.kind === "code")).toEqual([]);
  });

  test("control characters are shown as symbols, never passed to the engine", () => {
    const view = consoleView(reviewing(page({ text: "+\u001b[31mred\u0007\r\n", totalLines: 1 })), WIDE);
    const code = view.find((b) => b.kind === "code");
    expect(code?.kind === "code" && code.source).toBe("+␛[31mred␇␍\n");
    expect(texts(view)).toMatch(/control characters/);
  });

  test("isWholeHunks accepts complete hunks only", () => {
    expect(isWholeHunks("@@ -1,2 +1,2 @@\n a\n-b\n+c\n")).toBe(true);
    expect(isWholeHunks("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-b\n+c\n\\ No newline at end of file\n")).toBe(true);
    expect(isWholeHunks("diff --git a/x b/x\n@@ -1 +1 @@\n-b\n+c\n")).toBe(false);
    expect(isWholeHunks("@@ -1,3 +1,3 @@\n a\n-b\n")).toBe(false);
    expect(isWholeHunks(" a\n-b\n")).toBe(false);
    expect(isWholeHunks("")).toBe(false);
  });

  test("lists say where they are; a page past the end offers the first page", () => {
    const s = selectConsoleSection(base(), "review");
    const r = applyConsoleRead(s, s.generation, reply({ list: ok(listPage({ total: 25, offset: 10, items: Array.from({ length: 10 }, (_, i) => reviewItem(`p-${11 + i}`)) })) }), T1);
    const shown = texts(consoleView(r, WIDE));
    expect(shown).toContain("Proposals 11-20 of 25 in world-a");
    expect(keys(consoleView(r, WIDE))).toEqual(expect.arrayContaining(["list-prev", "list-next", "proposal-p-11"]));
    const past = applyConsoleRead(s, s.generation, reply({ list: ok(listPage({ total: 3, offset: 10, items: [] })) }), T1);
    expect(texts(consoleView(past, WIDE))).toMatch(/no proposals on this page/i);
    expect(keys(consoleView(past, WIDE))).toContain("list-first");
    const empty = applyConsoleRead(s, s.generation, reply({ list: ok(listPage({ total: 0, items: [] })) }), T1);
    expect(texts(consoleView(empty, WIDE))).toContain("No staged proposals in world-a");
    const failed = applyConsoleRead(s, s.generation, reply({ list: { ok: false, error: { code: "ConfigError", message: "bad config", retryable: false } } }), T1);
    expect(texts(consoleView(failed, WIDE))).toContain("bad config");
    expect(texts(consoleView(failed, WIDE))).not.toMatch(/\b0\b/);
  });

  test("activity labels global scope in words and bounds the log", () => {
    const s = selectConsoleSection(base(), "activity");
    const longLine = `worker ${"y".repeat(5000)}`;
    const r = applyConsoleRead(
      s,
      s.generation,
      reply({
        worker: ok(WORKER),
        queue: ok({ pending: [{ session_id: "s-1", world: "world-b", last_stop: T1, result: null }], done: [], failed: [], hidden: { done: 0, failed: 0 }, cleared: {} }),
        logs: ok({ name: "worker", path: "/x/worker.log", exists: true, size: 10, lines: ["started", longLine] }),
        list: ok({ world: "world-a", total: 1, offset: 0, limit: 10, items: [{ id: "r1", pattern: "p-one", created: "2026-10-22", lesson: "keep tests honest" }] }),
        lessons: ok({ world: "world-a", total: 0, offset: 0, limit: 5, items: [] }),
      }),
      T1,
    );
    const shown = texts(consoleView(r, WIDE));
    expect(shown).toMatch(/Worker \(global/);
    expect(shown).toMatch(/Queue \(global, all worlds\)/);
    expect(shown).toMatch(/log \(global/i);
    expect(shown).toContain("s-1");
    expect(shown).toContain("keep tests honest");
    expect(shown).not.toContain("y".repeat(1000));
    expect(shown).toMatch(/shortened/);
  });

  test("settings is a read-only placeholder with no form", () => {
    const view = consoleView(selectConsoleSection(base(), "settings"), WIDE);
    expect(texts(view)).toMatch(/read only/i);
    expect(texts(view)).toMatch(/sil web/);
    expect(keys(view).filter((k) => !k.startsWith("section-") && /save|input|setting/.test(k))).toEqual([]);
    expect(view.filter((b) => b.kind === "select" || b.kind === "code")).toEqual([]);
  });

  test("everything drawn with a full page stays under the engine's 100000 characters", () => {
    const text = `+${"ż".repeat(32000)}\n`;
    const s = reviewing(page({ text, lineCount: 1, totalLines: 1 }));
    const total = texts(consoleView(s, WIDE)).length;
    expect(total).toBeLessThan(100000);
  });
});

// --- fix round 1: bounds, paging, truthful counts, safe text ----------------------

function withBoot(state: ConsoleUiState, worlds: string[], world = worlds[0]!): ConsoleUiState {
  const boot = { worlds, selectedWorld: world, resolutionError: null, initialized: true };
  const s = switchConsoleWorld(state, world);
  return applyConsoleRead(s, s.generation, reply({ bootstrap: ok(boot), worker: ok(WORKER) }), T1);
}

function total(blocks: ConsoleBlock[]): number {
  return blocks.reduce((n, b) => n + blockChars(b), 0);
}

describe("cards", () => {
  const plain = (text: string): ConsoleBlock => ({ kind: "line", line: { text, tone: "plain" } });
  const bigCard = (): ConsoleBlock => card("big", "List", Array.from({ length: 50 }, (_, i) => plain(String(i % 10).repeat(2000))));

  test("a card counts its title, meta and children toward the budget", () => {
    expect(blockChars(card("k", "Worker", [plain("abc")], "global"))).toBe(6 + 6 + 3);
  });

  test("finishView makes card titles and children printable", () => {
    const out = finishView([card("k", "a\u001bb", [plain("x\u0007")])]);
    const first = out[0];
    expect(first?.kind === "card" && first.title).toBe("a\u241bb");
    const lines = flattenBlocks(out).flatMap((b) => (b.kind === "line" ? [b.line.text] : []));
    expect(lines).toContain("x\u2407");
    expect(lines).toContain("2 control characters are shown as symbols.");
  });

  test("a budget cut inside a card keeps the notice", () => {
    const out = enforceDisplayBudget([bigCard()], 30000);
    const last = flattenBlocks(out).at(-1);
    expect(last?.kind === "line" && last.line.text).toMatch(/more items are not shown: the pane's display budget is full\.$/);
    expect(total(out)).toBeLessThanOrEqual(30000);
  });

  test("a cut card keeps its title", () => {
    const first = enforceDisplayBudget([bigCard()], 30000)[0];
    expect(first?.kind === "card" && first.title).toBe("List");
  });
});

describe("fix round 1", () => {
  test("Overview counts staged proposals from the bounded page total", () => {
    const s = base();
    const r = applyConsoleRead(s, s.generation, reply({ review: ok(listPage({ total: 250, limit: 1, items: [reviewItem("p-one")] })) }), T1);
    expect(texts(consoleView(r, WIDE))).toContain("250 staged proposals waiting for review in world-a.");
    const bad = applyConsoleRead(s, s.generation, reply({ review: ok([reviewItem("p-one")]) }), T1);
    expect(texts(consoleView(bad, WIDE))).toMatch(/unexpected shape/);
  });

  test("800 long worlds and a near-cap page stay under the display budget, every world reachable", () => {
    expect(DISPLAY_BUDGET).toBe(90000);
    expect(WORLD_WINDOW).toBe(25);
    const worlds = Array.from({ length: 800 }, (_, i) => `w${String(i).padStart(3, "0")}${"x".repeat(60)}`);
    for (const w of worlds) expect(w).toHaveLength(64);
    const chosen = worlds[517]!;
    let s = withBoot(initialConsoleState(), worlds, chosen);
    const text = `${"b".repeat(65534)}\n`;
    s = selectConsolePattern(selectConsoleSection(s, "review"), "p-one");
    s = applyConsoleRead(s, s.generation, reply({ list: ok(listPage({ world: chosen })), proposal: ok(page({ world: chosen, part: "body", text, lineCount: 1, totalLines: 1 })) }), T1);
    s = setProposalPart(s, "body");
    for (const layout of [WIDE, NARROW]) {
      const view = consoleView(s, layout);
      expect(total(view)).toBeLessThanOrEqual(DISPLAY_BUDGET);
      // The page is drawn whole, not cut, and the end is claimed.
      expect(view.filter((b) => b.kind === "code")).toEqual([{ kind: "code", source: text, diff: false }]);
      expect(texts(view)).toContain("End of the body");
    }
    // Window: 25 worlds plus the current one, and paging reaches all 800
    // without changing the selected world or the generation.
    const seen = new Set<string>();
    let at = s;
    for (let i = 0; i < 40; i++) {
      const view = consoleView(at, WIDE);
      const worldKeys = keys(view).filter((k) => k.startsWith("world-"));
      expect(worldKeys.length).toBeLessThanOrEqual(WORLD_WINDOW + 1);
      for (const b of view) if (b.kind === "controls") for (const c of b.controls) if (c.action.kind === "world") seen.add(c.action.world);
      const narrowSelect = consoleView(at, NARROW).find((b) => b.kind === "select" && b.key === "world-select");
      expect(narrowSelect?.kind === "select" && narrowSelect.options.length).toBeLessThanOrEqual(WORLD_WINDOW + 1);
      const next = setWorldOffset(at, at.worldOffset + WORLD_WINDOW);
      expect(next.world).toBe(chosen);
      expect(next.generation).toBe(s.generation);
      expect(next.results).toBe(at.results);
      if (!keys(view).includes("worlds-next")) break;
      at = next;
    }
    expect(seen.size).toBe(800);
    expect(texts(consoleView(s, WIDE))).toContain(`Worlds 1-25 of 800`);
  });

  test("past the budget the page is refused in words, never cut and never called complete", () => {
    const text = `${"c".repeat(60000)}\n`;
    const s = reviewing(page({ part: "diff", text, lineCount: 1, totalLines: 1 }));
    const view = enforceDisplayBudget(consoleView(s, WIDE), 20000);
    expect(view.filter((b) => b.kind === "code")).toEqual([]);
    expect(texts(view)).toMatch(/too large to show/);
    expect(texts(view)).not.toContain("End of the diff");
    expect(total(view)).toBeLessThanOrEqual(20000);
    // A budget too small for even the rest says what it left out.
    const tiny = enforceDisplayBudget(consoleView(s, WIDE), 600);
    expect(total(tiny)).toBeLessThanOrEqual(600);
    expect(texts(tiny)).toMatch(/not shown: the pane's display budget is full/);
    expect(tiny.filter((b) => b.kind === "code")).toEqual([]);
  });

  test("every label, option and line counts toward the budget", () => {
    expect(blockChars({ kind: "line", line: { text: "abc", tone: "plain" } })).toBe(3);
    expect(blockChars({ kind: "controls", key: "k", label: "L:", direction: "row", controls: [{ key: "a", label: "xy", action: { kind: "refresh" }, isCurrent: true }] })).toBe(2 + "xy (current)".length);
    expect(blockChars({ kind: "select", key: "s", label: "S", value: "v", options: [{ value: "vv", label: "lll" }] })).toBe(1 + 2 + 3);
    expect(blockChars({ kind: "code", source: "12345", diff: false })).toBe(5);
  });

  test("lessons page on their own, independent of the reflections list", () => {
    let s = selectConsoleSection(base(), "activity");
    s = applyConsoleRead(s, s.generation, reply({ list: ok({ world: "world-a", total: 3, offset: 0, limit: 10, items: [{ pattern: "a" }, { pattern: "b" }, { pattern: "c" }] }), lessons: ok({ world: "world-a", total: 12, offset: 0, limit: 5, items: [1, 2, 3, 4, 5].map((i) => ({ pattern: "p", text: `lesson ${i}` })) }) }), T1);
    const view = consoleView(s, WIDE);
    expect(texts(view)).toContain("Lessons 1-5 of 12 in world-a");
    expect(keys(view)).toContain("lessons-next");
    expect(keys(view)).not.toContain("list-next");
    const t = setLessonsOffset(s, 5);
    expect(t).toMatchObject({ lessonsOffset: 5, listOffset: 0, generation: s.generation + 1 });
    expect(t.results.lessons).toBeUndefined();
    expect(t.results.list).toEqual(s.results.list!);
    expect(consoleReads(t, "/r").find((r) => r.id === "lessons")!.args).toEqual({ world: "world-a", kind: "lessons", offset: 5, limit: 5 });
    expect(consoleReads(t, "/r").find((r) => r.id === "list")!.args).toMatchObject({ offset: 0 });
    // The last page reaches the 12th lesson; a section or world change starts over.
    const last = setLessonsOffset(t, 10);
    expect(consoleReads(last, "/r").find((r) => r.id === "lessons")!.args).toMatchObject({ offset: 10 });
    expect(selectConsoleSection(last, "review").lessonsOffset).toBe(0);
    expect(chooseConsoleWorld(last, "world-b").lessonsOffset).toBe(0);
    expect(setLessonsOffset(last, 10)).toBe(last);
  });

  test("valid Task 5 saved state migrates: paging fields added, old overview result dropped", () => {
    const task5 = {
      ...initialConsoleState(),
      world: "world-a",
      section: "activity",
      generation: 4,
      listOffset: 10,
      results: { bootstrap: ok(BOOT), worker: ok(WORKER), review: ok([]), list: ok(listPage()) },
    } as Record<string, unknown>;
    delete task5.lessonsOffset;
    delete task5.worldOffset;
    const parsed = parseConsoleState(task5);
    expect(parsed.reset).toBe("migrated");
    expect(parsed.state).toMatchObject({ world: "world-a", section: "activity", listOffset: 10, lessonsOffset: 0, worldOffset: 0, generation: 5 });
    expect(Object.keys(parsed.state.results).sort()).toEqual(["bootstrap", "list", "worker"]);
    const task4 = parseConsoleState({ world: "world-a", section: "overview", generation: 1, selectedPattern: null, loading: false, lastSuccessAt: null, results: {}, error: null });
    expect(task4.state).toMatchObject({ lessonsOffset: 0, worldOffset: 0, listOffset: 0 });
    for (const bad of [{ lessonsOffset: -1 }, { worldOffset: 1.5 }]) {
      expect(parseConsoleState({ ...initialConsoleState(), ...bad }).reset).toBe("corrupt");
    }
  });

  test("queue text separates rows returned, rows drawn and the full totals", () => {
    const entry = (i: number) => ({ session_id: `s-${i}`, world: "world-a", last_stop: T1, result: null });
    const queueState = (pending: number, done: number, failed: number, hidden = { done: 0, failed: 0 }) => {
      const s = selectConsoleSection(base(), "activity");
      return applyConsoleRead(
        s,
        s.generation,
        reply({ queue: ok({ pending: Array.from({ length: pending }, (_, i) => entry(i)), done: Array.from({ length: done }, (_, i) => entry(100 + i)), failed: Array.from({ length: failed }, (_, i) => entry(200 + i)), hidden, cleared: {} }) }),
        T1,
      );
    };
    const mid = texts(consoleView(queueState(12, 4, 8), WIDE));
    expect(mid).toContain("Pending: 5 newest drawn of 12 returned.");
    expect(mid).toContain("Failed: 5 newest drawn of 8 returned.");
    expect(mid).toContain("Done: 4 returned, none drawn here.");
    expect(mid).not.toMatch(/shown/);
    expect(mid).toContain("s-4");
    expect(mid).not.toContain("s-5 ");
    const few = texts(consoleView(queueState(3, 0, 0), WIDE));
    expect(few).toContain("Pending: 3 newest drawn of 3 returned.");
    expect(few).toContain("Failed: 0 returned.");
    const capped = texts(consoleView(queueState(200, 200, 0, { done: 7, failed: 0 }), WIDE));
    expect(capped).toMatch(/at most 200 entries per list/);
    expect(capped).toMatch(/full counts may be higher/);
    expect(capped).toContain("7 done entries are hidden by a clear.");
    expect(few).not.toMatch(/at most 200/);
  });

  test("every drawn string is made safe at one boundary, opaque values kept, a note shown", () => {
    const s = switchConsoleWorld(initialConsoleState(), "w\u001bx");
    const r = applyConsoleRead(
      s,
      s.generation,
      reply({
        bootstrap: ok({ worlds: ["w\u001bx", "plain"], selectedWorld: "w\u001bx", resolutionError: null, initialized: true }),
        worker: ok({ ...WORKER, last_run: "\u001b[31mred\u0085" }),
        review: { ok: false, error: { code: "ConfigError", message: "bad\u0007bell", retryable: false } },
      }),
      T1,
    );
    const failed = { ...r, error: "Refresh failed: \u009b2J" };
    const view = consoleView(failed, WIDE);
    const all = texts(view);
    expect(all).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(all).toContain("\u241b[31mred\ufffd");
    expect(all).toContain("bad\u2407bell");
    expect(all).toContain("World: w\u241bx");
    expect(all).toMatch(/control characters are shown as symbols/);
    const control = view.flatMap((b) => (b.kind === "controls" ? b.controls : [])).find((c) => c.action.kind === "world" && c.label.startsWith("w"));
    expect(control?.label).toBe("w\u241bx (current)".replace(" (current)", ""));
    expect(control?.action).toEqual({ kind: "world", world: "w\u001bx" });
    expect(control?.key).toMatch(/^[A-Za-z0-9_.-]+$/);
    // Nothing unsafe: no note.
    expect(texts(consoleView(base(), WIDE))).not.toMatch(/control characters/);
  });

  test("an oversized last line says nothing follows and offers no next page", () => {
    const s = reviewing(page({ text: "", lineCount: 0, totalLines: 1, nextOffset: null, complete: false, oversizedLine: { line: 1, bytes: 70000 } }));
    const view = consoleView(s, WIDE);
    expect(texts(view)).not.toMatch(/follows/);
    expect(texts(view)).toMatch(/last line of the diff/);
    expect(texts(view)).not.toContain("End of the diff");
    expect(keys(view)).not.toContain("page-next");
  });
});

describe("fix round 2", () => {
  test("valid world keys stay unique, stable after reorder, and control-free", () => {
    const worlds = ["first", "é", "at-1"];
    const keysFor = (order: string[]) => {
      const state = withBoot(initialConsoleState(), order);
      return consoleControls(state).worlds.map((item) => {
        if (item.action.kind !== "world") throw new Error("world control expected");
        return [item.action.world, item.key] as const;
      });
    };
    const original = new Map(keysFor(worlds));
    const reordered = new Map(keysFor([...worlds].reverse()));
    expect(original.size).toBe(worlds.length);
    expect(new Set(original.values()).size).toBe(worlds.length);
    for (const world of worlds) expect(reordered.get(world)).toBe(original.get(world));
    expect([...original.values(), ...reordered.values()].join("")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

// --- the controller ------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const STATE_ID = "self-improvement-loop/console";

function answer(request: ControlRequest): ControlResponse["results"] {
  const results: ControlResponse["results"] = {};
  for (const read of request.reads) {
    const args = read.args as Record<string, unknown>;
    if (read.op === "console.bootstrap") results[read.id] = ok(BOOT);
    else if (read.op === "worker.status") results[read.id] = ok(WORKER);
    else if (read.op === "console.page" && args.kind === "lessons") results[read.id] = ok({ world: args.world, total: 12, offset: args.offset, limit: 5, items: Array.from({ length: Math.min(5, 12 - (args.offset as number)) }, (_, i) => ({ pattern: "p-one", text: `lesson ${(args.offset as number) + i}` })) });
    else if (read.op === "console.page" && args.limit === 1) results[read.id] = ok(listPage({ limit: 1, items: [reviewItem("p-one")] }));
    else if (read.op === "console.page") results[read.id] = ok(listPage({ offset: args.offset as number }));
    else if (read.op === "console.proposalPage") {
      const offset = args.offset as number;
      results[read.id] = ok(
        page({
          pattern: args.pattern,
          part: args.part,
          offset,
          text: `+${String(args.pattern)} line ${offset}\n`,
          lineCount: 1,
          totalLines: 3,
          nextOffset: offset + 1 < 3 ? offset + 1 : null,
          complete: offset + 1 === 3,
        }),
      );
    } else results[read.id] = { ok: false, error: { code: "OpNotAllowed", message: "not in this test", retryable: false } };
  }
  return results;
}

function controller() {
  const root = mkdtempSync(join(tmpdir(), "sil-ui-views-"));
  roots.push(root);
  const requests: ControlRequest[] = [];
  const pending: Array<{ request: ControlRequest; release: () => void }> = [];
  let hold = false;
  const respond = (init: { stdin?: string } | undefined): Promise<FakeRunResult> => {
    const request = JSON.parse(init?.stdin ?? "null") as ControlRequest;
    requests.push(request);
    const result = (): FakeRunResult => ({ exitCode: 0, stdout: `${JSON.stringify({ version: 1, requestId: request.requestId, results: answer(request) })}\n`, stderr: "" });
    if (!hold) return Promise.resolve(result());
    return new Promise((resolve) => pending.push({ request, release: () => resolve(result()) }));
  };
  const engine = new FakeEngine({
    sessionId: "s1",
    cwd: join(root, "repo"),
    pluginRoot: join(root, "plugin root"),
    runs: [{ match: (argv) => argv[0] === "/bin/sh", respond }],
  });
  resetUiForTests();
  registerUi(engine.on as never);
  const state = (): ConsoleUiState => engine.state.get(STATE_ID)?.value as ConsoleUiState;
  const render = (bodyColumns = 80) =>
    engine.answer<FakeElement>("ui.render", { surface: "terminal", component: "Pane", requestId: "sil-console", props: { bodyColumns } });
  return {
    engine,
    requests,
    pending,
    state,
    render,
    setHold: (v: boolean) => {
      hold = v;
    },
  };
}

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

async function press(c: ReturnType<typeof controller>, key: string, bodyColumns = 80): Promise<void> {
  const button = findKey(await c.render(bodyColumns), key);
  if (!button) throw new Error(`no control ${key}`);
  (button.props.onPress as (e: unknown) => void)({ surface: "terminal" });
  await settle();
}

async function open(c: ReturnType<typeof controller>): Promise<void> {
  await c.engine.answer("command.run", { command: "sil", args: "" });
  await settle();
}

// When the stored state cannot be read, render shows one error line made
// outside the view model. It must stay as bounded and printable as the rest.
describe("the state-read error line", () => {
  async function renderWith(message: string): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), "sil-ui-err-"));
    roots.push(root);
    const engine = new FakeEngine({ sessionId: "s1", cwd: join(root, "repo"), pluginRoot: join(root, "plugin root"), fail: { stateGetMessage: message } });
    resetUiForTests();
    registerUi(engine.on as never);
    const tree = await engine.answer<FakeElement>("ui.render", { surface: "terminal", component: "Pane", requestId: "sil-console", props: { bodyColumns: 80 } });
    return allText(tree);
  }

  test("a short error is shown whole, control characters made visible", async () => {
    const text = await renderWith("store offline\u001b[2J");
    expect(text).toContain("Error: the console state could not be read: store offline␛[2J");
    expect(text).not.toContain("\u001b");
  });

  test("a huge error is cut to a bounded line that says so", async () => {
    const huge = `${"\u0007x".repeat(60000)}tail-marker`;
    const text = await renderWith(huge);
    expect(text).toContain("Error: the console state could not be read: ");
    expect(text).toContain("(shortened)");
    expect(text).not.toContain("tail-marker");
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(text.length).toBeLessThan(500);
  });
});

describe("console controller: scope changes", () => {
  test("a section press reads that section at once", async () => {
    const c = controller();
    await open(c);
    const before = c.requests.length;
    await press(c, "section-review");
    expect(c.state().section).toBe("review");
    expect(c.requests.length).toBe(before + 1);
    expect(c.requests.at(-1)!.reads.map((r) => r.op)).toContain("console.page");
    expect(allText(await c.render())).toContain("p-two");
  });

  test("a slow overview reply does not land under Review", async () => {
    const c = controller();
    await open(c);
    c.setHold(true);
    await press(c, "refresh");
    expect(c.pending).toHaveLength(1);
    await press(c, "section-review");
    const generation = c.state().generation;
    c.setHold(false);
    c.pending.shift()!.release();
    await settle();
    expect(c.state().section).toBe("review");
    expect(c.state().generation).toBe(generation);
    expect(c.state().results.review).toBeUndefined();
    expect(c.requests.at(-1)!.reads.map((r) => r.id)).toContain("list");
    expect(c.state().results.list?.ok).toBe(true);
  });

  test("lessons-next reads the next lessons page; world paging reads nothing", async () => {
    const c = controller();
    await open(c);
    await press(c, "section-activity");
    const before = c.requests.length;
    await press(c, "lessons-next");
    expect(c.state().lessonsOffset).toBe(5);
    expect(c.requests.length).toBe(before + 1);
    expect(c.requests.at(-1)!.reads.find((r) => r.id === "lessons")!.args).toMatchObject({ offset: 5 });
  });

  test("rapid proposal switches: only the last one's page is shown", async () => {
    const c = controller();
    await open(c);
    await press(c, "section-review");
    c.setHold(true);
    await press(c, "proposal-p-one");
    expect(c.pending).toHaveLength(1);
    await press(c, "proposal-p-two");
    c.setHold(false);
    c.pending.shift()!.release();
    await settle();
    expect(c.state().selectedPattern).toBe("p-two");
    const shown = allText(await c.render());
    expect(shown).toContain("+p-two line 0");
    expect(shown).not.toContain("+p-one line 0");
    const last = c.requests.at(-1)!.reads.find((r) => r.id === "proposal")!;
    expect(last.args).toMatchObject({ pattern: "p-two", offset: 0 });
  });

  test("next page asks for the line after this page, bound to the pinned digest", async () => {
    const c = controller();
    await open(c);
    await press(c, "section-review");
    await press(c, "proposal-p-one");
    expect(c.state().proposal?.reviewedState).toBe(DIGEST);
    await press(c, "page-next");
    const read = c.requests.at(-1)!.reads.find((r) => r.id === "proposal")!;
    expect(read.args).toEqual({ world: "world-a", pattern: "p-one", part: "body", offset: 1, limit: 200, expectedState: DIGEST });
    expect(allText(await c.render())).toContain("+p-one line 1");
  });

  test("narrow: the section Select reads the picked section; Back returns to the list", async () => {
    const c = controller();
    await open(c);
    const select = findKey(await c.render(30), "section-select");
    expect(select?.type).toBe("Select");
    (select!.props.onSelect as (v: string, e: unknown) => void)("review", {});
    await settle();
    expect(c.state().section).toBe("review");
    await press(c, "proposal-p-one", 30);
    const tree = await c.render(30);
    expect(findKey(tree, "proposal-p-two")).toBeUndefined();
    expect(findKey(tree, "proposal-back")).toBeDefined();
    await press(c, "proposal-back", 30);
    expect(c.state().selectedPattern).toBeNull();
    expect(findKey(await c.render(30), "proposal-p-two")).toBeDefined();
  });

  test("a Select pick of an unknown value changes nothing", async () => {
    const c = controller();
    await open(c);
    const before = c.state();
    const select = findKey(await c.render(30), "section-select");
    (select!.props.onSelect as (v: string, e: unknown) => void)("bogus", {});
    await settle();
    expect(c.state()).toEqual(before);
  });
});
