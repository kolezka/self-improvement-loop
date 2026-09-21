// The opt-in semantic second opinion on alias suggestions.
//
// Every test here uses a fake decision provider. They establish that the
// integration is correct: which evidence is sent, which candidate an answer
// attaches to, what a failure looks like, and that nothing is ever written.
// They say nothing about how well a real model separates two mechanisms; see
// `scripts/eval-alias-semantic.ts` for that.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AliasSemanticConfig,
  Config as ConfigSchema,
  type Config,
  type Endpoint,
  fsx,
  ledgerPath,
  type LlmConfig,
  LlmConfig as LlmConfigSchema,
  ProviderError,
  ProviderTimeout,
  type World,
} from "@sil/core";
import { assessAliasSuggestions, QUESTION_ID, type SemanticAssessment } from "@sil/curriculum";
import type { ChoiceAnswer, ChoiceQuestion, DecideChoiceFn } from "@sil/providers";
import { loadAliases, patternCounts, saveAliases, suggestAliases } from "@sil/store";
import { addReflections, cleanupEnv, LESSON, makeWorld, silEnv, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  env = silEnv();
  // Nothing in this file may reach the network. A test that does is a bug in
  // the test, not a slow test.
  globalThis.fetch = (async () => {
    throw new Error("must not reach the network");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanupEnv(env);
});

// --- helpers -----------------------------------------------------------------

function cfg(world: World, semantic: Partial<AliasSemanticConfig> = {}): Config {
  return ConfigSchema.parse({ worlds: [world], alias_semantic: semantic });
}

function systemOneLlm(overrides: Partial<Endpoint> = {}): LlmConfig {
  return LlmConfigSchema.parse({
    endpoints: [{ name: "jev", kind: "system-one", base_url: "http://localhost:5000", models: { judge: "jev-1" }, ...overrides }],
    active: "jev",
  });
}

interface DecideCall {
  role: string;
  state: { pattern_a: { name: string; reflections: { id: string; excerpt: string }[] }; pattern_b: { name: string; reflections: { id: string; excerpt: string }[] } };
  questions: Record<string, ChoiceQuestion>;
  timeoutMs: number | undefined;
}

/** Records every call and answers from a per-pair script keyed `alias~canonical`. */
class FakeDecider {
  readonly calls: DecideCall[] = [];
  constructor(private readonly answers: Record<string, ChoiceAnswer | Error>) {}

  readonly fn: DecideChoiceFn = async (role, state, questions, opts) => {
    const typed = state as DecideCall["state"];
    this.calls.push({ role, state: typed, questions, timeoutMs: opts.timeoutMs });
    const key = `${typed.pattern_a.name}~${typed.pattern_b.name}`;
    const answer = this.answers[key];
    if (answer === undefined) throw new ProviderError(`fake has no answer for ${key}`);
    if (answer instanceof Error) throw answer;
    return { [QUESTION_ID]: answer };
  };
}

function answer(choice: string, confidence: number | null, probabilities?: Record<string, number>): ChoiceAnswer {
  return {
    choice,
    probabilities: probabilities ?? { same_mechanism: choice === "same_mechanism" ? 0.9 : 0.1, distinct: choice === "distinct" ? 0.9 : 0.1 },
    confidence,
    model: "jev-1.13.0",
  };
}

const neverCalled: DecideChoiceFn = async () => {
  throw new Error("the provider must not be called");
};

/** Two near-duplicate pairs: `stale-env` under `stale-cached-env` (score 0.67)
 * and `verify-callsites` under `verify-callsites-before-fix` (score 0.50). */
function seedTwoPairs(world: World): void {
  addReflections(world, "stale-env", 2, { startDay: 1, lesson: "Read the env var again after the refresh; the cached copy is stale." });
  addReflections(world, "stale-cached-env", 3, { startDay: 3, lesson: "The cached env copy is read before the refresh lands." });
  addReflections(world, "verify-callsites", 1, { startDay: 6, lesson: "Check every call site before calling a change safe." });
  addReflections(world, "verify-callsites-before-fix", 2, { startDay: 7, lesson: "Enumerate call sites before writing the fix." });
}

const byAlias = (report: { suggestions: { alias: string; semantic: SemanticAssessment | null }[] }, alias: string): SemanticAssessment | null =>
  report.suggestions.find((s) => s.alias === alias)?.semantic ?? null;

// --- disabled ----------------------------------------------------------------

describe("disabled by default", () => {
  test("a default config leaves the feature off", () => {
    expect(ConfigSchema.parse({}).alias_semantic.enabled).toBe(false);
  });

  test("returns the deterministic suggestions untouched and calls no provider", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    const deterministic = suggestAliases(world.name);
    expect(deterministic.length).toBe(2);

    const report = await assessAliasSuggestions(cfg(world), world, { llm: systemOneLlm(), decideChoice: neverCalled });

    expect(report.status).toBe("disabled");
    expect(report.assessed).toBe(0);
    expect(report.model).toBeNull();
    expect(report.suggestions.map(({ semantic, ...rest }) => rest)).toEqual(deterministic);
    expect(report.suggestions.every((s) => s.semantic === null)).toBe(true);
  });
});

// --- evidence ----------------------------------------------------------------

describe("evidence", () => {
  test("comes from the named world only, newest first, capped per pattern", async () => {
    const world = makeWorld();
    const other = makeWorld({ name: "other" });
    seedTwoPairs(world);
    // Same pattern names in another world. None of it may leave that world.
    addReflections(other, "stale-env", 2, { startDay: 20, lesson: "OTHER WORLD SECRET" });
    addReflections(other, "stale-cached-env", 3, { startDay: 22, lesson: "OTHER WORLD SECRET" });

    const fake = new FakeDecider({ "stale-env~stale-cached-env": answer("same_mechanism", 0.9), "verify-callsites~verify-callsites-before-fix": answer("distinct", 0.8) });
    await assessAliasSuggestions(cfg(world, { enabled: true, max_reflections_per_pattern: 2 }), world, { llm: systemOneLlm(), decideChoice: fake.fn });

    const first = fake.calls.find((c) => c.state.pattern_a.name === "stale-env")!;
    expect(first.state.pattern_a.reflections.length).toBe(2);
    // 3 reflections exist for the canonical slug; the cap keeps 2.
    expect(first.state.pattern_b.reflections.length).toBe(2);
    const sent = JSON.stringify(fake.calls.map((c) => c.state));
    expect(sent).not.toContain("OTHER WORLD SECRET");
    // Newest first: day 05 and 04 of the canonical slug, not day 03.
    expect(first.state.pattern_b.reflections.map((r) => r.id)).toEqual(["2026-09-05-stale-cached-env-02", "2026-09-04-stale-cached-env-01"]);
  });

  test("every excerpt is cut to max_excerpt_chars", async () => {
    const world = makeWorld();
    // The fixture LESSON is longer than the 80-character floor, so the cut is real.
    addReflections(world, "stale-env", 2, { startDay: 1 });
    addReflections(world, "stale-cached-env", 3, { startDay: 3 });
    expect(LESSON.length).toBeGreaterThan(80);
    const fake = new FakeDecider({ "stale-env~stale-cached-env": answer("same_mechanism", 0.9) });

    await assessAliasSuggestions(cfg(world, { enabled: true, max_excerpt_chars: 80 }), world, { llm: systemOneLlm(), decideChoice: fake.fn });

    const excerpts = fake.calls.flatMap((c) => [...c.state.pattern_a.reflections, ...c.state.pattern_b.reflections]);
    expect(excerpts.length).toBeGreaterThan(0);
    for (const e of excerpts) expect(e.excerpt).toBe(LESSON.slice(0, 80));
  });

  test("an alias-resolved slug carries the reflections filed under the folded name", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    // `old-env` folds into `stale-cached-env`, so its reflections are that
    // pattern's evidence even though no file says so.
    saveAliases(world.name, { "old-env": "stale-cached-env" });
    addReflections(world, "old-env", 1, { startDay: 15, lesson: "Filed under the retired name." });

    const fake = new FakeDecider({ "stale-env~stale-cached-env": answer("same_mechanism", 0.9), "verify-callsites~verify-callsites-before-fix": answer("distinct", 0.9) });
    await assessAliasSuggestions(cfg(world, { enabled: true, max_reflections_per_pattern: 1 }), world, { llm: systemOneLlm(), decideChoice: fake.fn });

    const first = fake.calls.find((c) => c.state.pattern_a.name === "stale-env")!;
    expect(first.state.pattern_b.reflections[0]!.id).toBe("2026-09-15-old-env-00");
  });
});

// --- attaching results -------------------------------------------------------

describe("results", () => {
  test("each answer lands on its own candidate, in the deterministic order", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    const deterministic = suggestAliases(world.name);
    const fake = new FakeDecider({
      "stale-env~stale-cached-env": answer("same_mechanism", 0.91),
      "verify-callsites~verify-callsites-before-fix": answer("distinct", 0.84),
    });

    const report = await assessAliasSuggestions(cfg(world, { enabled: true, concurrency: 2 }), world, { llm: systemOneLlm(), decideChoice: fake.fn });

    expect(report.status).toBe("ok");
    expect(report.assessed).toBe(2);
    expect(report.model).toBe("jev-1");
    expect(report.suggestions.map(({ semantic, ...rest }) => rest)).toEqual(deterministic);

    const same = byAlias(report, "stale-env")!;
    expect(same).toMatchObject({ alias: "stale-env", canonical: "stale-cached-env", status: "assessed", verdict: "same_mechanism", confidence: 0.91, model: "jev-1.13.0", error: null });
    expect(same.alias_reflection_ids.length).toBe(2);
    expect(same.canonical_reflection_ids.length).toBe(2);
    expect(same.probabilities["same_mechanism"]).toBe(0.9);

    // A `distinct` verdict stays in the list rather than hiding the candidate.
    const distinct = byAlias(report, "verify-callsites")!;
    expect(distinct.verdict).toBe("distinct");
    expect(report.suggestions.some((s) => s.alias === "verify-callsites")).toBe(true);
  });

  test("the per-call timeout comes from the config, not the endpoint", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    const fake = new FakeDecider({ "stale-env~stale-cached-env": answer("same_mechanism", 0.9), "verify-callsites~verify-callsites-before-fix": answer("distinct", 0.9) });

    await assessAliasSuggestions(cfg(world, { enabled: true, timeout_s: 7 }), world, { llm: systemOneLlm({ timeout_s: 240 }), decideChoice: fake.fn });

    expect(fake.calls.every((c) => c.timeoutMs === 7000)).toBe(true);
  });

  test("candidates past max_candidates stay listed and unassessed", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    const fake = new FakeDecider({ "stale-env~stale-cached-env": answer("same_mechanism", 0.9) });

    const report = await assessAliasSuggestions(cfg(world, { enabled: true, max_candidates: 1 }), world, { llm: systemOneLlm(), decideChoice: fake.fn });

    expect(report.suggestions.length).toBe(2);
    expect(fake.calls.length).toBe(1);
    expect(byAlias(report, "stale-env")!.status).toBe("assessed");
    expect(byAlias(report, "verify-callsites")).toBeNull();
  });

  test("the question offers exactly the two options the verdict is read from", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    const fake = new FakeDecider({ "stale-env~stale-cached-env": answer("same_mechanism", 0.9), "verify-callsites~verify-callsites-before-fix": answer("distinct", 0.9) });

    await assessAliasSuggestions(cfg(world, { enabled: true }), world, { llm: systemOneLlm(), decideChoice: fake.fn });

    const question = fake.calls[0]!.questions[QUESTION_ID]!;
    expect(Object.keys(question.criteria).sort()).toEqual(["distinct", "same_mechanism"]);
    expect(question.instructions).toContain("same underlying failure mechanism");
  });
});

// --- confidence --------------------------------------------------------------

describe("confidence", () => {
  test("a pick below min_confidence becomes unsure, keeping the raw numbers", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    const fake = new FakeDecider({
      "stale-env~stale-cached-env": answer("same_mechanism", 0.41),
      "verify-callsites~verify-callsites-before-fix": answer("distinct", 0.95),
    });

    const report = await assessAliasSuggestions(cfg(world, { enabled: true, min_confidence: 0.6 }), world, { llm: systemOneLlm(), decideChoice: fake.fn });

    const low = byAlias(report, "stale-env")!;
    expect(low.verdict).toBe("unsure");
    expect(low.confidence).toBe(0.41);
    expect(low.probabilities["same_mechanism"]).toBe(0.9);
    expect(byAlias(report, "verify-callsites")!.verdict).toBe("distinct");
  });

  test("with no confidence reported the winning probability is the bar", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    const fake = new FakeDecider({
      "stale-env~stale-cached-env": answer("same_mechanism", null, { same_mechanism: 0.55, distinct: 0.45 }),
      "verify-callsites~verify-callsites-before-fix": answer("distinct", null, { same_mechanism: 0.1, distinct: 0.9 }),
    });

    const report = await assessAliasSuggestions(cfg(world, { enabled: true, min_confidence: 0.6 }), world, { llm: systemOneLlm(), decideChoice: fake.fn });

    expect(byAlias(report, "stale-env")!.verdict).toBe("unsure");
    expect(byAlias(report, "verify-callsites")!.verdict).toBe("distinct");
  });

  test("neither confidence nor probabilities is unsure, not a verdict", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    const fake = new FakeDecider({
      "stale-env~stale-cached-env": answer("same_mechanism", null, {}),
      "verify-callsites~verify-callsites-before-fix": answer("distinct", null, {}),
    });

    const report = await assessAliasSuggestions(cfg(world, { enabled: true }), world, { llm: systemOneLlm(), decideChoice: fake.fn });

    const row = byAlias(report, "stale-env")!;
    expect(row.verdict).toBe("unsure");
    expect(row.confidence).toBeNull();
  });
});

// --- failures are visible ----------------------------------------------------

describe("failures", () => {
  async function reportWith(world: World, answers: Record<string, ChoiceAnswer | Error>) {
    seedTwoPairs(world);
    const fake = new FakeDecider(answers);
    const report = await assessAliasSuggestions(cfg(world, { enabled: true }), world, { llm: systemOneLlm(), decideChoice: fake.fn });
    return { report, fake };
  }

  test("a timeout on one pair leaves the other assessed and names the timeout", async () => {
    const world = makeWorld();
    const { report } = await reportWith(world, {
      "stale-env~stale-cached-env": new ProviderTimeout('provider "jev" at http://localhost:5000/v1/systemone timed out after 20s'),
      "verify-callsites~verify-callsites-before-fix": answer("distinct", 0.9),
    });

    const failed = byAlias(report, "stale-env")!;
    expect(failed.status).toBe("unavailable");
    expect(failed.verdict).toBeNull();
    expect(failed.error).toContain("timed out");
    // The candidate itself survives, counts and all.
    expect(report.suggestions.find((s) => s.alias === "stale-env")!.alias_count).toBe(2);
    expect(report.status).toBe("ok");
    expect(report.assessed).toBe(1);
  });

  test("a provider failure on every pair makes the whole report unavailable", async () => {
    const world = makeWorld();
    const { report } = await reportWith(world, {
      "stale-env~stale-cached-env": new ProviderError("HTTP 500: boom"),
      "verify-callsites~verify-callsites-before-fix": new ProviderError("HTTP 500: boom"),
    });

    expect(report.status).toBe("unavailable");
    expect(report.reason).toContain("HTTP 500");
    expect(report.suggestions.length).toBe(2);
    expect(report.suggestions.every((s) => s.semantic!.status === "unavailable")).toBe(true);
  });

  test("an answer outside the question's options is unavailable, never a verdict", async () => {
    const world = makeWorld();
    const { report } = await reportWith(world, {
      "stale-env~stale-cached-env": answer("maybe_same", 0.99, { maybe_same: 0.99 }),
      "verify-callsites~verify-callsites-before-fix": answer("distinct", 0.9),
    });

    const bad = byAlias(report, "stale-env")!;
    expect(bad.status).toBe("unavailable");
    expect(bad.verdict).toBeNull();
    expect(bad.error).toContain("maybe_same");
  });

  test("a transport that breaks its own contract loses one row, not the report", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    let call = 0;
    // First pair: no answers object at all, so reading the answer throws
    // inside the job. Second pair: a normal answer.
    const decideChoice = (async () => (call++ === 0 ? null : { [QUESTION_ID]: answer("distinct", 0.9) })) as unknown as DecideChoiceFn;

    const report = await assessAliasSuggestions(cfg(world, { enabled: true, concurrency: 1 }), world, { llm: systemOneLlm(), decideChoice });

    expect(report.status).toBe("ok");
    expect(report.assessed).toBe(1);
    expect(byAlias(report, "stale-env")!.status).toBe("unavailable");
    expect(byAlias(report, "verify-callsites")!.verdict).toBe("distinct");
  });

  test("a provider error message is one bounded line, not a whole error page", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    const page = `<html>\n<body>\n${"x".repeat(400)}\n</body>\n</html>`;
    const fake = new FakeDecider({
      "stale-env~stale-cached-env": new ProviderError(page),
      "verify-callsites~verify-callsites-before-fix": new ProviderError(page),
    });

    const report = await assessAliasSuggestions(cfg(world, { enabled: true }), world, { llm: systemOneLlm(), decideChoice: fake.fn });

    const error = byAlias(report, "stale-env")!.error!;
    expect(error).not.toContain("\n");
    expect(error.length).toBeLessThanOrEqual(220);
  });

  test("an answer for another question id is unavailable", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    const decideChoice: DecideChoiceFn = async () => ({ some_other_id: answer("same_mechanism", 0.99) });

    const report = await assessAliasSuggestions(cfg(world, { enabled: true }), world, { llm: systemOneLlm(), decideChoice });

    expect(report.status).toBe("unavailable");
    expect(report.suggestions.every((s) => s.semantic!.status === "unavailable")).toBe(true);
  });
});

// --- configuration refusals --------------------------------------------------

describe("endpoint and locality", () => {
  test("a judge on a text endpoint reports unavailable and calls nothing", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    const llm = LlmConfigSchema.parse({
      endpoints: [{ name: "litellm", kind: "openai", base_url: "http://localhost:4000", models: { judge: "glm" } }],
      active: "litellm",
    });

    const report = await assessAliasSuggestions(cfg(world, { enabled: true }), world, { llm, decideChoice: neverCalled });

    expect(report.status).toBe("unavailable");
    expect(report.reason).toContain("system-one");
    expect(report.suggestions.length).toBe(2);
  });

  test("a local world refuses a model that is not in local_models", async () => {
    const world = makeWorld({ llm: "local" });
    seedTwoPairs(world);

    const report = await assessAliasSuggestions(cfg(world, { enabled: true }), world, { llm: systemOneLlm(), decideChoice: neverCalled });

    expect(report.status).toBe("unavailable");
    // Not "local": that substring also hides inside "localhost" in any URL.
    expect(report.reason).toContain("LocalityViolation");
    expect(report.reason).toContain("local_models");
    expect(report.suggestions.length).toBe(2);
  });

  test("a local world allows a model listed in local_models", async () => {
    const world = makeWorld({ llm: "local" });
    seedTwoPairs(world);
    const llm = { ...systemOneLlm(), local_models: ["jev-1"] };
    const fake = new FakeDecider({ "stale-env~stale-cached-env": answer("same_mechanism", 0.9), "verify-callsites~verify-callsites-before-fix": answer("distinct", 0.9) });

    const report = await assessAliasSuggestions(cfg(world, { enabled: true }), world, { llm, decideChoice: fake.fn });

    expect(report.status).toBe("ok");
    expect(report.assessed).toBe(2);
  });

  test("no model for the judge role reports unavailable", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    const llm = systemOneLlm({ models: {} });

    const report = await assessAliasSuggestions(cfg(world, { enabled: true }), world, { llm, decideChoice: neverCalled });

    expect(report.status).toBe("unavailable");
    expect(report.reason).toContain("judge");
  });
});

// --- it never writes ---------------------------------------------------------

describe("read only", () => {
  test("no alias is written, no count moves, no ledger appears", async () => {
    const world = makeWorld();
    seedTwoPairs(world);
    saveAliases(world.name, { "old-env": "stale-cached-env" });
    const aliasesBefore = loadAliases(world.name);
    const countsBefore = patternCounts(world.name);
    expect(fsx.exists(ledgerPath(world))).toBe(false);

    const fake = new FakeDecider({
      "stale-env~stale-cached-env": answer("same_mechanism", 0.99),
      "verify-callsites~verify-callsites-before-fix": answer("same_mechanism", 0.99),
    });
    const report = await assessAliasSuggestions(cfg(world, { enabled: true }), world, { llm: systemOneLlm(), decideChoice: fake.fn });

    expect(report.assessed).toBe(2);
    expect(report.suggestions.every((s) => s.semantic!.verdict === "same_mechanism")).toBe(true);
    // A confident `same_mechanism` on every pair changes nothing on disk.
    expect(loadAliases(world.name)).toEqual(aliasesBefore);
    expect(patternCounts(world.name)).toEqual(countsBefore);
    expect(fsx.exists(ledgerPath(world))).toBe(false);
    // The counts the human reads are still the deterministic ones.
    expect(report.suggestions.map((s) => [s.alias_count, s.canonical_count])).toEqual(suggestAliases(world.name).map((s) => [s.alias_count, s.canonical_count]));
  });
});
