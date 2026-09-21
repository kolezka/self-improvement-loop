#!/usr/bin/env bun
// Live evaluation of the semantic alias pass. This is the only place where a
// real model is asked anything: the unit tests use a fake provider and prove
// the integration, not the quality of the judgment.
//
// Run: bun run scripts/eval-alias-semantic.ts [--world default] [--json]
//
// It reads scripts/fixtures/alias-semantic-pairs.json, asks the configured
// judge endpoint one question per pair, and prints the human label next to the
// model verdict. Pairs labelled `ambiguous` are reported, never scored. It
// writes nothing: no alias, no reflection, no ledger entry.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadLlm, worldNamed } from "@sil/core";
import { pairQuestion, QUESTION_ID, type PatternEvidence, type SemanticVerdict, verdictFor } from "@sil/curriculum";
import { decideChoice } from "@sil/providers";

interface FixturePair {
  id: string;
  expected: "same_mechanism" | "distinct" | "ambiguous";
  why: string;
  a: PatternEvidence;
  b: PatternEvidence;
}

interface Row {
  id: string;
  expected: string;
  /** `error`: the request failed. `unmeasured`: the request returned, but the
   * answer carried no confidence signal, so there is nothing to score. */
  verdict: SemanticVerdict | "error" | "unmeasured";
  confidence: number | null;
  agrees: boolean | null;
  detail: string;
}

/** The fixture is a file on disk, so it is checked before use. zod lives in
 * the packages, not at the repo root, so this is by hand and deliberately
 * shallow: it proves the fields the evaluation reads. */
function readFixture(path: string): FixturePair[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const pairs = (raw as { pairs?: unknown })?.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) throw new Error(`${path}: expected a non-empty "pairs" array`);
  const evidenceOk = (v: unknown): v is PatternEvidence => {
    const e = v as PatternEvidence;
    return (
      typeof e?.name === "string" &&
      e.name.length > 0 &&
      Array.isArray(e.reflections) &&
      e.reflections.every((r) => typeof r?.id === "string" && typeof r?.excerpt === "string")
    );
  };
  return pairs.map((p, i) => {
    const pair = p as FixturePair;
    const where = `${path}: pairs[${i}]`;
    if (typeof pair?.id !== "string" || pair.id === "") throw new Error(`${where}: missing "id"`);
    if (pair.expected !== "same_mechanism" && pair.expected !== "distinct" && pair.expected !== "ambiguous") {
      throw new Error(`${where}: "expected" must be same_mechanism, distinct or ambiguous`);
    }
    if (typeof pair.why !== "string") throw new Error(`${where}: missing "why"`);
    if (!evidenceOk(pair.a) || !evidenceOk(pair.b)) throw new Error(`${where}: "a" and "b" need a name and {id, excerpt} reflections`);
    return pair;
  });
}

/** One line, bounded. A provider error can carry a whole HTML error page. */
function describe(e: unknown): string {
  const message = String((e as Error)?.message ?? e).replace(/\s+/g, " ").trim();
  return message.slice(0, 160);
}

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};

const worldName = flag("--world") ?? "default";
const asJson = args.includes("--json");

const pairs = readFixture(join(import.meta.dir, "fixtures", "alias-semantic-pairs.json"));

const cfg = loadConfig();
const world = worldNamed(cfg, worldName);
const llm = loadLlm(world);
const semantic = cfg.alias_semantic;

const rows: Row[] = [];
for (const pair of pairs) {
  const { state, questions } = pairQuestion(pair.a, pair.b);
  try {
    const answers = await decideChoice("judge", state, questions, { world, llm, timeoutMs: semantic.timeout_s * 1000 });
    const answer = answers[QUESTION_ID]!;
    // Same gate as the live path, from the same function, so the evaluation
    // cannot drift away from what `sil aliases suggest` prints.
    const gated = verdictFor(answer, semantic.min_confidence);
    if (gated === null) {
      rows.push({
        id: pair.id,
        expected: pair.expected,
        verdict: "unmeasured",
        confidence: null,
        agrees: null,
        detail: `model ${answer.model ?? "unknown"} reported no confidence for its pick`,
      });
      continue;
    }
    rows.push({
      id: pair.id,
      expected: pair.expected,
      verdict: gated.verdict,
      confidence: gated.confidence,
      agrees: pair.expected === "ambiguous" ? null : gated.verdict === pair.expected,
      detail: `model ${answer.model ?? "unknown"}`,
    });
  } catch (e) {
    rows.push({ id: pair.id, expected: pair.expected, verdict: "error", confidence: null, agrees: null, detail: describe(e) });
  }
}

const scored = rows.filter((r) => r.agrees !== null);
const disagreements = scored.filter((r) => !r.agrees);
const errors = rows.filter((r) => r.verdict === "error");
const unmeasured = rows.filter((r) => r.verdict === "unmeasured");
const ambiguous = rows.length - scored.length - errors.length - unmeasured.length;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        world: worldName,
        min_confidence: semantic.min_confidence,
        rows,
        scored: scored.length,
        disagreements: disagreements.length,
        errors: errors.length,
        unmeasured: unmeasured.length,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`live evaluation, world ${worldName}, min_confidence ${semantic.min_confidence}`);
  for (const r of rows) {
    const mark = r.agrees === null ? "  " : r.agrees ? "ok" : "XX";
    const conf = r.confidence === null ? "   -" : r.confidence.toFixed(2);
    console.log(`${mark} ${r.id.padEnd(32)} expected ${r.expected.padEnd(14)} verdict ${r.verdict.padEnd(14)} ${conf}  ${r.detail}`);
  }
  console.log(
    `\nscored pairs: ${scored.length}, disagreements: ${disagreements.length}, ` +
      `ambiguous (reported, not scored): ${ambiguous}, errors: ${errors.length}, unmeasured: ${unmeasured.length}`,
  );
  for (const r of disagreements) console.log(`disagreement: ${r.id} expected ${r.expected}, model said ${r.verdict}. ${pairs.find((p) => p.id === r.id)!.why}`);
}

// A disagreement is a finding, not a build failure: the model answered, and a
// human reads the answer. A failed request, an answer with no confidence, and
// a run that scored nothing all exit non-zero, because then the evaluation
// measured nothing and a green exit code would say otherwise.
const measuredNothing = scored.length === 0;
if (measuredNothing) console.error(`no pair was scored: ${rows.length} pairs, ${errors.length} errors, ${unmeasured.length} unmeasured`);
process.exit(errors.length > 0 || unmeasured.length > 0 || measuredNothing ? 1 : 0);
