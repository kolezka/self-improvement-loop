// The cross-reflection context handed to the drafter: the rolling per-pattern
// summary, the world's knowledge map, and what the drafting prompt does with
// them. The churn these exist to stop is covered at the end, through run().

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, ledgerPath, type PromotionEntry, type Reflection, ruleTag, type World } from "@sil/core";
import type { ChatFn } from "@sil/providers";
import {
  artifacts,
  branchName,
  clusterSummary,
  digestPath,
  draftMessages,
  git,
  KNOWLEDGE_HEADER,
  loadSummary,
  RECENT_LESSONS,
  renderKnowledge,
  run,
  type RunOptions,
  SUMMARY_HEADER,
  SUMMARY_MIN_LESSONS,
  worldKnowledge,
} from "@sil/curriculum";
import { listReflections, saveLedger } from "@sil/store";
import {
  addReflections,
  cleanupEnv,
  commitFile,
  fakeGateRunner,
  initTarget,
  installFakeNudge,
  makeCfg,
  makeWorld,
  ruleBody,
  silEnv,
  type TestEnv,
  uninstallFakeNudge,
} from "./fixtures.ts";

const PATTERN = "verify-callsites";

let env: TestEnv;

beforeEach(() => {
  env = silEnv();
  installFakeNudge();
});
afterEach(() => {
  uninstallFakeNudge();
  cleanupEnv(env);
});

function opts(over: Partial<RunOptions> & { apply: boolean }): RunOptions {
  return { gateRunner: fakeGateRunner, ...over };
}

function items(world: World, pattern = PATTERN): Reflection[] {
  return listReflections(world.name).filter((r) => r.pattern === pattern);
}

/** A chat that answers every drafter call with one summary and records prompts. */
function summariser(text: string): { fn: ChatFn; prompts: string[] } {
  const prompts: string[] = [];
  const fn: ChatFn = async (_role, messages) => {
    prompts.push(messages[messages.length - 1]!.content);
    return JSON.stringify({ summary: text });
  };
  return { fn, prompts };
}

function writeLedger(world: World, entries: PromotionEntry[]): void {
  const ledger: Ledger = { version: 1, entries: Object.fromEntries(entries.map((e) => [e.pattern, e])) };
  const path = ledgerPath(world);
  mkdirSync(join(path, ".."), { recursive: true });
  saveLedger(path, ledger);
}

function entry(fields: Partial<PromotionEntry> & { pattern: string }): PromotionEntry {
  return {
    promoted_at_count: 0,
    rejected_at_count: 0,
    status: "staged",
    artifact_type: "none",
    served_by: null,
    last_updated: "2026-09-01",
    commit: null,
    feedback: null,
    ...fields,
  };
}

// --- the rolling summary -----------------------------------------------------

describe("the cluster summary", () => {
  test("a small cluster is drafted from in full, with no model call", async () => {
    const world = makeWorld();
    addReflections(world, PATTERN, SUMMARY_MIN_LESSONS - 1);
    const chat = summariser("never asked for");

    expect(await clusterSummary(world, PATTERN, items(world), chat.fn)).toBeNull();
    expect(chat.prompts).toEqual([]);
  });

  test("it is written once and reused while no reflection is new", async () => {
    const world = makeWorld();
    addReflections(world, PATTERN, SUMMARY_MIN_LESSONS);
    const chat = summariser("The agent calls a change safe from one call site.");

    const first = await clusterSummary(world, PATTERN, items(world), chat.fn);
    const second = await clusterSummary(world, PATTERN, items(world), chat.fn);

    expect(first).toBe("The agent calls a change safe from one call site.");
    expect(second).toBe(first);
    expect(chat.prompts.length).toBe(1);

    const cached = loadSummary(world.name, PATTERN)!;
    expect(cached.covered.length).toBe(SUMMARY_MIN_LESSONS);
    expect(readFileSync(digestPath(world.name, PATTERN), "utf8")).toContain("one call site");
  });

  test("a new reflection folds in, carrying the previous summary and only the new lesson", async () => {
    const world = makeWorld();
    addReflections(world, PATTERN, SUMMARY_MIN_LESSONS);
    const chat = summariser("first summary");
    await clusterSummary(world, PATTERN, items(world), chat.fn);

    addReflections(world, PATTERN, 1, { startDay: 20, lesson: "Check the deploy log before claiming a rollout landed." });
    const second = summariser("second summary");
    const out = await clusterSummary(world, PATTERN, items(world), second.fn);

    expect(out).toBe("second summary");
    expect(second.prompts.length).toBe(1);
    const prompt = second.prompts[0]!;
    expect(prompt).toContain("first summary");
    expect(prompt).toContain("Check the deploy log");
    expect(prompt).toContain("New lesson(s) to fold in (1)");
    expect(loadSummary(world.name, PATTERN)!.covered.length).toBe(SUMMARY_MIN_LESSONS + 1);
  });

  test("a provider failure keeps the cached summary and never throws", async () => {
    const world = makeWorld();
    addReflections(world, PATTERN, SUMMARY_MIN_LESSONS);
    await clusterSummary(world, PATTERN, items(world), summariser("cached summary").fn);

    addReflections(world, PATTERN, 1, { startDay: 20 });
    const dead: ChatFn = async () => {
      throw new Error("the endpoint never answered");
    };

    expect(await clusterSummary(world, PATTERN, items(world), dead)).toBe("cached summary");
    // The cache still describes the reflections it was actually built from.
    expect(loadSummary(world.name, PATTERN)!.covered.length).toBe(SUMMARY_MIN_LESSONS);
  });

  test("an unreadable reply leaves no summary rather than a fragment", async () => {
    const world = makeWorld();
    addReflections(world, PATTERN, SUMMARY_MIN_LESSONS);
    const garbage: ChatFn = async () => "I am afraid I cannot do that";

    expect(await clusterSummary(world, PATTERN, items(world), garbage)).toBeNull();
    expect(loadSummary(world.name, PATTERN)).toBeNull();
  });
});

// --- the knowledge map -------------------------------------------------------

describe("the world knowledge map", () => {
  test("it reports each pattern's weight and the artifact serving it", () => {
    const world = makeWorld();
    addReflections(world, PATTERN, 2);
    addReflections(world, "stale-cached-env", 5, { startDay: 20 });
    const repo = initTarget(world);
    artifacts.ensureRulesFile(world, repo);
    artifacts.writeArtifact(world, "rule", "stale-cached-env", ruleBody(), repo);
    writeLedger(world, [
      entry({
        pattern: "stale-cached-env",
        status: "promoted",
        artifact_type: "rule",
        served_by: { type: "rule", path: "RULES.md" },
      }),
    ]);

    const rows = worldKnowledge(world, listReflections(world.name));
    expect(rows.map((r) => r.pattern)).toEqual(["stale-cached-env", PATTERN]);
    expect(rows[0]!.count).toBe(5);
    expect(rows[0]!.type).toBe("rule");
    // The gist is the bullet without the marker the writer appends: a prompt
    // carrying the tag teaches the drafter to emit one, and lint refuses those.
    expect(rows[0]!.gist).toContain("graphify inventory");
    expect(rows[0]!.gist).not.toContain(ruleTag("stale-cached-env"));
    expect(rows[1]!.type).toBe("none");

    const rendered = renderKnowledge(rows, "stale-cached-env")!;
    expect(rendered).toContain(`- ${PATTERN} (2 reflection(s), no artifact yet)`);
    expect(rendered).not.toContain("- stale-cached-env");
  });

  test("a world with nothing else to say renders no map", () => {
    const world = makeWorld();
    addReflections(world, PATTERN, 2);
    expect(renderKnowledge(worldKnowledge(world, listReflections(world.name)), PATTERN)).toBeNull();
  });
});

// --- what the prompt does with them -----------------------------------------

describe("the drafting prompt", () => {
  const lessons = Array.from({ length: RECENT_LESSONS + 4 }, (_, i) => `Lesson number ${i} about call sites.`);

  test("without a summary every lesson is quoted", () => {
    const prompt = draftMessages(PATTERN, lessons)[1]!.content;
    expect(prompt).toContain("Lesson number 0 ");
    expect(prompt).not.toContain(SUMMARY_HEADER);
  });

  test("with a summary the older lessons reach the drafter only through it", () => {
    const prompt = draftMessages(PATTERN, lessons, null, "rule", { summary: "the standing summary" })[1]!.content;
    expect(prompt).toContain(`${SUMMARY_HEADER} (${lessons.length} in total`);
    expect(prompt).toContain("the standing summary");
    expect(prompt).toContain(`The ${RECENT_LESSONS} most recent lesson(s) follow in full. The other 4`);
    expect(prompt).not.toContain("Lesson number 0 ");
    expect(prompt).toContain(`Lesson number ${lessons.length - 1} `);
  });

  test("the knowledge map is carried with an instruction not to restate it", () => {
    const prompt = draftMessages(PATTERN, lessons, null, null, { knowledge: "- stale-cached-env (rule, 5 reflection(s))" })[1]!
      .content;
    expect(prompt).toContain(KNOWLEDGE_HEADER);
    expect(prompt).toContain("- stale-cached-env (rule, 5 reflection(s))");
    expect(prompt).toContain("no_artifact");
  });

  test("an existing artifact is offered with an instruction to keep its wording", () => {
    const prompt = draftMessages(PATTERN, lessons, ruleBody(), "rule")[1]!.content;
    expect(prompt).toContain("Keep its wording wherever the lessons still support it");
  });
});

// --- the churn this exists to stop ------------------------------------------

describe("a refine that says nothing new", () => {
  /** A world with `pattern` already promoted as a rule, and new evidence. */
  function servedWorld(): { world: World; repo: string } {
    const world = makeWorld();
    addReflections(world, PATTERN, 3);
    const repo = initTarget(world);
    artifacts.ensureRulesFile(world, repo);
    artifacts.writeArtifact(world, "rule", PATTERN, ruleBody(), repo);
    commitFile(repo, "RULES.md", readFileSync(join(repo, "RULES.md"), "utf8"), "chore: rules");
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        status: "promoted",
        artifact_type: "rule",
        served_by: { type: "rule", path: "RULES.md" },
      }),
    ]);
    commitFile(repo, "promotions.json", readFileSync(ledgerPath(world), "utf8"), "chore: ledger");
    return { world, repo };
  }

  test("the stored rule reaches the drafter without its tag", async () => {
    const { world } = servedWorld();
    const prompts: string[] = [];
    const chat: ChatFn = async (role, messages) => {
      prompts.push(messages[messages.length - 1]!.content);
      if (role === "judge") return JSON.stringify({ verdict: "yes", reason: "quoted" });
      return JSON.stringify({ artifact: `${ruleBody()} Re-run the check after a rebase.` });
    };

    const report = await run(world, makeCfg(), opts({ apply: true, chat }));

    expect(report.staged).toEqual([PATTERN]);
    expect(prompts[0]).toContain("Existing artifact to refine");
    expect(prompts[0]).not.toContain(ruleTag(PATTERN));
  });

  test("a redraft identical to the artifact in place stages nothing and costs no judge call", async () => {
    const { world, repo } = servedWorld();
    const roles: string[] = [];
    const chat: ChatFn = async (role, _messages) => {
      roles.push(role);
      if (role === "judge") return JSON.stringify({ verdict: "yes", reason: "quoted" });
      // Byte for byte what RULES.md already carries, once the tag is stripped.
      return JSON.stringify({ artifact: ruleBody() });
    };

    const report = await run(world, makeCfg(), opts({ apply: true, chat }));

    expect(report.staged).toEqual([]);
    expect(report.gated_out[PATTERN]).toContain("no change");
    expect(roles).toEqual(["drafter"]);
    expect(git.refExists(repo, `refs/heads/${branchName(world.name, PATTERN)}`)).toBe(false);
  });
});
