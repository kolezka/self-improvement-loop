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
import { pairQuestion, QUESTION_ID, type PatternEvidence, type SemanticVerdict } from "@sil/curriculum";
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
  verdict: SemanticVerdict | "error";
  confidence: number | null;
  agrees: boolean | null;
  detail: string;
}

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};

const worldName = flag("--world") ?? "default";
const asJson = args.includes("--json");

const fixturePath = join(import.meta.dir, "fixtures", "alias-semantic-pairs.json");
const pairs = (JSON.parse(readFileSync(fixturePath, "utf8")) as { pairs: FixturePair[] }).pairs;

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
    const gate = answer.confidence ?? answer.probabilities[answer.choice] ?? null;
    const verdict: SemanticVerdict = gate === null || gate < semantic.min_confidence ? "unsure" : (answer.choice as SemanticVerdict);
    rows.push({
      id: pair.id,
      expected: pair.expected,
      verdict,
      confidence: gate,
      agrees: pair.expected === "ambiguous" ? null : verdict === pair.expected,
      detail: `model ${answer.model}`,
    });
  } catch (e) {
    rows.push({ id: pair.id, expected: pair.expected, verdict: "error", confidence: null, agrees: null, detail: (e as Error).message.slice(0, 160) });
  }
}

const scored = rows.filter((r) => r.agrees !== null);
const disagreements = scored.filter((r) => !r.agrees);
const errors = rows.filter((r) => r.verdict === "error");

if (asJson) {
  console.log(JSON.stringify({ world: worldName, min_confidence: semantic.min_confidence, rows, scored: scored.length, disagreements: disagreements.length, errors: errors.length }, null, 2));
} else {
  console.log(`live evaluation, world ${worldName}, min_confidence ${semantic.min_confidence}`);
  for (const r of rows) {
    const mark = r.agrees === null ? "  " : r.agrees ? "ok" : "XX";
    const conf = r.confidence === null ? "   -" : r.confidence.toFixed(2);
    console.log(`${mark} ${r.id.padEnd(32)} expected ${r.expected.padEnd(14)} verdict ${r.verdict.padEnd(14)} ${conf}  ${r.detail}`);
  }
  console.log(`\nscored pairs: ${scored.length}, disagreements: ${disagreements.length}, ambiguous (reported, not scored): ${rows.length - scored.length - errors.length}, errors: ${errors.length}`);
  for (const r of disagreements) console.log(`disagreement: ${r.id} expected ${r.expected}, model said ${r.verdict}. ${pairs.find((p) => p.id === r.id)!.why}`);
}

// A disagreement is a finding, not a build failure. Only a provider error
// exits non-zero, because then nothing was measured at all.
process.exit(errors.length > 0 ? 1 : 0);
