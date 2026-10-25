// console.page and console.proposalPage: bounded pages for the native console.
// A list page counts the whole filtered list before it slices. A proposal
// page is bound to one reviewed_state, holds whole lines only and stays under
// 65536 UTF-8 bytes, so ordinary pages put back together are the exact text
// and one line too big to show is reported, never clipped.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "@sil/core";
import "../src/index.ts";
import { CONTROL_READ_OPS, executeControlRead } from "../src/control.ts";
import { deps, setDeps, type Deps } from "../src/deps.ts";
import { PROPOSAL_PAGE_MAX_BYTES, PROPOSAL_PAGE_MAX_LINES, proposalPageOf } from "../src/handlers/console.ts";
import { invoke, REGISTRY } from "../src/registry.ts";

const STATE = "a".repeat(64);
const OTHER_STATE = "b".repeat(64);
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

let root: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["HOME", "SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"] as const;
let restoreDeps: (() => void) | null = null;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sil-console-pages-")));
  for (const name of ENV) saved[name] = process.env[name];
  process.env.HOME = join(root, "home");
  process.env.SIL_CONFIG_DIR = join(root, "config");
  process.env.SIL_STATE_DIR = join(root, "state");
  process.env.SIL_DATA_DIR = join(root, "data");
  mkdirSync(join(root, "config"), { recursive: true });
  mkdirSync(join(root, "repo"), { recursive: true });
  writeFileSync(join(root, "config/config.yaml"), `worlds:\n  - name: alpha\n    repos: ["${root}/repo"]\n`);
});

afterEach(() => {
  restoreDeps?.();
  restoreDeps = null;
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(root, { recursive: true, force: true });
});

function reviewItem(pattern: string) {
  return { world: "alpha", pattern, branch: `curriculum/alpha/${pattern}`, artifact_type: "skill", status: "staged", artifact_path: null, count: 3, staged_at: null, commit: "abc1234" };
}

/** Swaps the review module for one that serves `body` and `diff` at `state`. */
function fakeReview(over: { body?: string; diff?: string; state?: () => string; queue?: unknown[]; inventory?: unknown[] } = {}) {
  const calls: string[] = [];
  restoreDeps = setDeps({
    review: {
      ...deps.review,
      queue: () => {
        calls.push("queue");
        return over.queue ?? [];
      },
      inventory: () => {
        calls.push("inventory");
        return over.inventory ?? [];
      },
      detail: (_w: unknown, _c: unknown, pattern: string) => {
        calls.push(`detail ${pattern}`);
        return { ...reviewItem(pattern), body: over.body ?? "", sources: [], reviewed_state: over.state?.() ?? STATE, accept_blocked: null, live: false };
      },
      diff: (_w: unknown, _c: unknown, pattern: string) => {
        calls.push(`diff ${pattern}`);
        return { world: "alpha", pattern, diff: over.diff ?? "", reviewed_state: over.state?.() ?? STATE };
      },
    } as unknown as Deps["review"],
  });
  return calls;
}

async function read(op: string, args: Record<string, unknown>) {
  const response = await executeControlRead({ version: 1, requestId: "r", reads: [{ id: "x", op, args }] });
  return response.results.x!;
}

type Page = {
  world: string;
  pattern: string;
  part: string;
  text: string;
  offset: number;
  lineCount: number;
  nextOffset: number | null;
  totalLines: number;
  totalBytes: number;
  reviewedState: string;
  complete: boolean;
  oversizedLine: { line: number; bytes: number } | null;
};

/** Reads every page of `part` the way the console does: the first page
 * unbound, every later one bound to the digest the first returned. */
async function readAll(part: "body" | "diff"): Promise<Page[]> {
  const pages: Page[] = [];
  let offset: number | null = 0;
  let expected: string | undefined;
  while (offset !== null) {
    const args: Record<string, unknown> = { world: "alpha", pattern: "p-one", part, offset, limit: 200 };
    if (expected !== undefined) args.expectedState = expected;
    const result = await read("console.proposalPage", args);
    if (!result.ok) throw new Error(`page at ${offset}: ${result.error.code} ${result.error.message}`);
    const page = result.value as Page;
    expected = page.reviewedState;
    pages.push(page);
    offset = page.nextOffset;
    if (pages.length > 10000) throw new Error("runaway paging");
  }
  return pages;
}

describe("registration", () => {
  test("both page ops are registered read-only and on the bridge allowlist", () => {
    for (const name of ["console.page", "console.proposalPage"]) {
      expect(REGISTRY.get(name)?.tier).toBe("read");
      expect(REGISTRY.get(name)?.gate).toBe("none");
      expect(CONTROL_READ_OPS).toContain(name);
    }
  });

  test("bounds on the page size", () => {
    expect(PROPOSAL_PAGE_MAX_LINES).toBe(200);
    expect(PROPOSAL_PAGE_MAX_BYTES).toBe(65536);
  });
});

describe("console.page", () => {
  test("counts the whole list before slicing, defaults to 25 a page", async () => {
    const queue = Array.from({ length: 30 }, (_, i) => reviewItem(`p-${String(i).padStart(2, "0")}`));
    fakeReview({ queue });
    const first = (await invoke("console.page", { world: "alpha", kind: "review" })) as { total: number; offset: number; limit: number; items: { pattern: string }[]; world: string };
    expect(first).toMatchObject({ world: "alpha", total: 30, offset: 0, limit: 25 });
    expect(first.items).toHaveLength(25);
    const last = (await invoke("console.page", { world: "alpha", kind: "review", offset: 25, limit: 25 })) as typeof first;
    expect(last.total).toBe(30);
    expect(last.items.map((i) => i.pattern)).toEqual(["p-25", "p-26", "p-27", "p-28", "p-29"]);
  });

  test("a page at or past the end is empty and still carries the total", async () => {
    fakeReview({ queue: [reviewItem("only")] });
    for (const offset of [1, 50]) {
      const page = await invoke("console.page", { world: "alpha", kind: "review", offset, limit: 10 });
      expect(page).toEqual({ world: "alpha", total: 1, offset, limit: 10, items: [] });
    }
  });

  test("an empty list is total 0, not an error", async () => {
    fakeReview({ queue: [] });
    expect(await invoke("console.page", { world: "alpha", kind: "review" })).toEqual({ world: "alpha", total: 0, offset: 0, limit: 25, items: [] });
  });

  test("artifacts page the router inventory", async () => {
    const rows = ["a", "b", "c"].map((pattern) => ({ pattern, artifact_type: "skill", served_by: null, status: "active", reflections: 2, scorecard: null }));
    const calls = fakeReview({ inventory: rows });
    const page = (await invoke("console.page", { world: "alpha", kind: "artifacts", offset: 1, limit: 1 })) as { total: number; items: { pattern: string }[] };
    expect(page.total).toBe(3);
    expect(page.items.map((i) => i.pattern)).toEqual(["b"]);
    expect(calls).toEqual(["inventory"]);
  });

  test("lessons filter by pattern, then count, then slice", async () => {
    const dir = paths.inboxDir("alpha");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      const pattern = i < 3 ? "keep-me" : "other";
      writeFileSync(join(dir, `l${i}.json`), JSON.stringify({ id: `l${i}`, world: "alpha", pattern, text: `lesson ${i}`, created: "2026-10-22T10:00:00Z" }));
    }
    const all = (await invoke("console.page", { world: "alpha", kind: "lessons" })) as { total: number };
    expect(all.total).toBe(5);
    const whole = (await invoke("console.page", { world: "alpha", kind: "lessons", pattern: "keep-me", limit: 100 })) as { total: number; items: { id: string }[] };
    expect(whole.items.map((i) => i.id).sort()).toEqual(["l0", "l1", "l2"]);
    const page = (await invoke("console.page", { world: "alpha", kind: "lessons", pattern: "keep-me", offset: 2, limit: 5 })) as typeof whole;
    expect(page.total).toBe(3);
    expect(page.items).toEqual(whole.items.slice(2));
  });

  test("bad arguments are refused before anything runs", async () => {
    const calls = fakeReview({ queue: [reviewItem("x")] });
    for (const args of [
      { world: "alpha", kind: "review", limit: 0 },
      { world: "alpha", kind: "review", limit: 101 },
      { world: "alpha", kind: "review", offset: -1 },
      { world: "alpha", kind: "review", offset: 1.5 },
      { world: "alpha", kind: "config" },
      { world: "alpha", kind: "review", extra: true },
      { world: "alpha", kind: "review", pattern: "../x" },
    ]) {
      const result = await read("console.page", args);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("InvalidArgs");
    }
    expect(calls).toEqual([]);
  });
});

describe("offsets", () => {
  test("any safe nonnegative integer offset is accepted; past the end is an empty page or a refusal, not a schema error", async () => {
    fakeReview({ queue: [reviewItem("only")], body: "x\n" });
    const list = await read("console.page", { world: "alpha", kind: "review", offset: 1000001, limit: 10 });
    expect(list).toEqual({ ok: true, value: { world: "alpha", total: 1, offset: 1000001, limit: 10, items: [] } });
    const past = await read("console.proposalPage", { world: "alpha", pattern: "p-one", part: "body", offset: 10000001, limit: 10 });
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.error.code).toBe("ValidationError");
    for (const op of ["console.page", "console.proposalPage"]) {
      const unsafe = await read(op, { world: "alpha", kind: "review", pattern: "p-one", part: "body", offset: 2 ** 53, limit: 10 });
      expect(unsafe.ok).toBe(false);
      if (!unsafe.ok) expect(unsafe.error.code).toBe("InvalidArgs");
    }
  });
});

describe("proposalPageOf", () => {
  test("pages of a long multibyte diff put back together are the exact text", () => {
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const filler = i % 37 === 0 ? "Zażółć gęślą jaźń 😀 ".repeat(600) : `+ line ${i} ąę 漢字 😀`;
      lines.push(`${filler}${i % 13 === 0 ? "\r\n" : "\n"}`);
    }
    const text = `${lines.join("")}tail with no newline 😀`;
    let offset = 0;
    let joined = "";
    let pages = 0;
    for (;;) {
      const page = proposalPageOf(text, offset, 200);
      pages += 1;
      expect(page.oversizedLine).toBeNull();
      expect(bytes(page.text)).toBeLessThan(PROPOSAL_PAGE_MAX_BYTES);
      expect(page.lineCount).toBeLessThanOrEqual(200);
      expect(page.lineCount).toBeGreaterThan(0);
      expect(page.totalLines).toBe(3001);
      joined += page.text;
      if (page.nextOffset === null) {
        expect(page.complete).toBe(true);
        break;
      }
      expect(page.complete).toBe(false);
      expect(page.nextOffset).toBe(offset + page.lineCount);
      offset = page.nextOffset;
    }
    expect(joined).toBe(text);
    // The byte cap, not only the line cap, cut some pages short.
    expect(pages).toBeGreaterThan(Math.ceil(3001 / 200));
  });

  test("one line too big for a page is reported alone and never clipped", () => {
    const huge = `+${"x".repeat(70000)}\n`;
    const text = `a\nb\n${huge}c\n`;
    const first = proposalPageOf(text, 0, 200);
    expect(first.text).toBe("a\nb\n");
    expect(first.complete).toBe(false);
    expect(first.nextOffset).toBe(2);
    const big = proposalPageOf(text, 2, 200);
    expect(big.text).toBe("");
    expect(big.lineCount).toBe(0);
    expect(big.oversizedLine).toEqual({ line: 3, bytes: bytes(huge) });
    expect(big.complete).toBe(false);
    expect(big.nextOffset).toBe(3);
    const rest = proposalPageOf(text, 3, 200);
    expect(rest).toMatchObject({ text: "c\n", complete: true, nextOffset: null, oversizedLine: null });
  });

  test("a huge last line is never complete", () => {
    const page = proposalPageOf(`${"é".repeat(40000)}`, 0, 200);
    expect(page.text).toBe("");
    expect(page.complete).toBe(false);
    expect(page.nextOffset).toBeNull();
    expect(page.oversizedLine).toEqual({ line: 1, bytes: 80000 });
  });

  test("the byte cap is exact: 65535 bytes fit, 65536 do not", () => {
    const fits = `${"x".repeat(65534)}\n`;
    expect(proposalPageOf(fits, 0, 200)).toMatchObject({ text: fits, complete: true, oversizedLine: null });
    const over = `${"x".repeat(65535)}\n`;
    expect(proposalPageOf(over, 0, 200)).toMatchObject({ text: "", complete: false, oversizedLine: { line: 1, bytes: 65536 } });
    // Several lines that together reach the cap: the last one waits for the next page.
    const half = `${"y".repeat(32767)}\n`;
    const two = proposalPageOf(half + half, 0, 200);
    expect(two).toMatchObject({ text: half, lineCount: 1, nextOffset: 1, complete: false });
    const almost = `${"z".repeat(32766)}\n`;
    expect(proposalPageOf(half + almost, 0, 200)).toMatchObject({ text: half + almost, lineCount: 2, complete: true });
  });

  test("empty text is one complete empty page; past the end is refused", () => {
    expect(proposalPageOf("", 0, 200)).toEqual({ text: "", offset: 0, lineCount: 0, nextOffset: null, totalLines: 0, totalBytes: 0, complete: true, oversizedLine: null });
    expect(proposalPageOf("a\n", 1, 200)).toMatchObject({ text: "", complete: true, nextOffset: null });
    expect(() => proposalPageOf("a\n", 2, 200)).toThrow(/past the end/);
  });
});

describe("console.proposalPage", () => {
  test("body and diff pages carry the digest and reassemble the exact source", async () => {
    const diff = Array.from({ length: 900 }, (_, i) => `${i % 50 === 0 ? `@@ -${i},3 +${i},4 @@\n` : ""}+ zmiana ${i} ✓ ${"ł".repeat(i % 300)}\n`).join("");
    const body = "# Skill\n\nUżyj tego, gdy… 😀\n";
    fakeReview({ diff, body });
    const diffPages = await readAll("diff");
    expect(diffPages.map((p) => p.text).join("")).toBe(diff);
    expect(diffPages.every((p) => p.reviewedState === STATE && p.part === "diff" && p.pattern === "p-one" && p.world === "alpha")).toBe(true);
    expect(diffPages.at(-1)!.complete).toBe(true);
    expect(diffPages.slice(0, -1).every((p) => !p.complete)).toBe(true);
    const bodyPages = await readAll("body");
    expect(bodyPages).toHaveLength(1);
    expect(bodyPages[0]).toMatchObject({ text: body, complete: true, totalLines: 3, totalBytes: bytes(body) });
  });

  test("a changed digest is refused, never joined to the old pages", async () => {
    let state = STATE;
    const calls = fakeReview({ diff: "a\nb\n", state: () => state });
    const first = await read("console.proposalPage", { world: "alpha", pattern: "p-one", part: "diff", offset: 0, limit: 1 });
    expect(first.ok).toBe(true);
    state = OTHER_STATE;
    const second = await read("console.proposalPage", { world: "alpha", pattern: "p-one", part: "diff", offset: 1, limit: 1, expectedState: STATE });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("ProposalChanged");
      expect(second.error.message).toContain("changed");
    }
    expect(calls).toEqual(["diff p-one", "diff p-one"]);
  });

  test("a matching digest reads on; bad arguments are refused", async () => {
    fakeReview({ body: "x\n" });
    expect((await read("console.proposalPage", { world: "alpha", pattern: "p-one", part: "body", offset: 0, limit: 200, expectedState: STATE })).ok).toBe(true);
    for (const args of [
      { world: "alpha", pattern: "p-one", part: "body", offset: 0, limit: 201 },
      { world: "alpha", pattern: "p-one", part: "body", offset: 0, limit: 0 },
      { world: "alpha", pattern: "p-one", part: "patch", offset: 0, limit: 10 },
      { world: "alpha", pattern: "p-one", part: "body", offset: 0, limit: 10, expectedState: "nope" },
      { world: "alpha", pattern: "../p", part: "body", offset: 0, limit: 10 },
    ]) {
      const result = await read("console.proposalPage", args);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("InvalidArgs");
    }
    const past = await read("console.proposalPage", { world: "alpha", pattern: "p-one", part: "body", offset: 5, limit: 10 });
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.error.code).toBe("ValidationError");
  });

  test("defaults: offset 0, 200 lines", async () => {
    fakeReview({ body: "x\n" });
    const page = (await invoke("console.proposalPage", { world: "alpha", pattern: "p-one", part: "body" })) as Page;
    expect(page).toMatchObject({ offset: 0, lineCount: 1, complete: true });
  });
});
