// An opt-in second opinion on the deterministic alias suggestions.
//
// `suggestAliases` compares slug tokens, so it cannot see that
// `stale-cached-env` and `env-read-before-refresh` are one mechanism under two
// names, and it fires on pairs that only share vocabulary. This asks a System
// One endpoint one typed question per candidate pair and hangs the answer off
// the suggestion.
//
// Three rules shape the module:
//
// * It reads. It never writes an alias, never folds two counts together and
//   never reaches the ledger, the router or promotion. `sil aliases set` is
//   still the only way a pair becomes an alias.
// * The deterministic list is the list. Every candidate comes back, in the
//   same order, with the same counts, whatever the model said. A pair assessed
//   `distinct` stays visible.
// * No generated prose. The model picks one of two named options; every
//   sentence a human reads is a fixed template plus real reflection ids.

import { type AliasSemanticConfig, type Config, loadLlm, type LlmConfig, resolveRole, type Reflection, type World } from "@sil/core";
import { type ChoiceQuestion, decideChoice as defaultDecideChoice, type DecideChoiceFn } from "@sil/providers";
import { type AliasSuggestion, listReflections, loadAliases, suggestAliases } from "@sil/store";

/** The three answers a human sees. `unsure` is never a model option: it is
 * what a pick below the confidence bar becomes. */
export type SemanticVerdict = "same_mechanism" | "distinct" | "unsure";

export const QUESTION_ID = "same_mechanism";

/** The options the model picks between, with what each one means. */
export const PAIR_CRITERIA: Record<string, string> = {
  same_mechanism:
    "The two patterns describe one underlying failure mechanism. The same cause produces both, " +
    "and one corrective lesson would cover both occurrences. The names differ; the mechanism does not.",
  distinct:
    "The two patterns describe different failure mechanisms. The causes differ, or a lesson written for one " +
    "would not correct the other. A shared topic, a shared tool or shared words in the name are not enough.",
};

const INSTRUCTIONS =
  "`pattern_a` and `pattern_b` are two recurring failure patterns from one engineering log. " +
  "Each carries excerpts from the reflections filed under it. " +
  "Decide whether they describe the same underlying failure mechanism and justify the same corrective lesson.";

/** One reflection, cut to the configured budget, with the id it came from. */
export interface EvidenceExcerpt {
  id: string;
  excerpt: string;
}

export interface PatternEvidence {
  name: string;
  reflections: EvidenceExcerpt[];
}

/** What the model was asked and what it answered, for one candidate pair.
 * `status` is the honest one: `unavailable` means the assessment could not
 * run, and `error` says why. */
export interface SemanticAssessment {
  alias: string;
  canonical: string;
  status: "assessed" | "unavailable";
  verdict: SemanticVerdict | null;
  confidence: number | null;
  probabilities: Record<string, number>;
  alias_reflection_ids: string[];
  canonical_reflection_ids: string[];
  model: string | null;
  error: string | null;
}

/** A deterministic suggestion, unchanged, plus its assessment. `semantic` is
 * null when the pair was not assessed at all: the feature is off, or the pair
 * sits past `max_candidates`. */
export interface AssessedAliasSuggestion extends AliasSuggestion {
  semantic: SemanticAssessment | null;
}

export interface AliasSemanticReport {
  world: string;
  /** `disabled`: the feature is off. `unavailable`: it is on and could not
   * run at all. `ok`: at least one pair was assessed. */
  status: "disabled" | "ok" | "unavailable";
  reason: string | null;
  model: string | null;
  assessed: number;
  suggestions: AssessedAliasSuggestion[];
}

export interface AliasSemanticOptions {
  llm?: LlmConfig;
  /** Injected transport. Tests pass a fake; nothing else does. */
  decideChoice?: DecideChoiceFn;
}

/** State and question for one pair, shared by the live path and the offline
 * evaluation script so both ask the model exactly the same thing. */
export function pairQuestion(
  a: PatternEvidence,
  b: PatternEvidence,
): { state: Record<string, unknown>; questions: Record<string, ChoiceQuestion> } {
  return {
    state: { pattern_a: a, pattern_b: b },
    questions: { [QUESTION_ID]: { instructions: INSTRUCTIONS, criteria: { ...PAIR_CRITERIA } } },
  };
}

/** Newest reflections per alias-resolved pattern. Alias resolution has to
 * match `patternCounts`, or the evidence for a canonical slug would miss every
 * reflection filed under a name already aliased into it. */
function evidenceByPattern(world: World, cfg: AliasSemanticConfig): Map<string, EvidenceExcerpt[]> {
  const aliases = loadAliases(world.name);
  const out = new Map<string, EvidenceExcerpt[]>();
  // listReflections is newest first and world scoped: nothing from another
  // world, and no V1 mirror dir, can reach the request body.
  for (const r of listReflections(world.name)) {
    const pattern = aliases[r.pattern] ?? r.pattern;
    const bucket = out.get(pattern) ?? [];
    if (bucket.length >= cfg.max_reflections_per_pattern) continue;
    bucket.push({ id: r.id, excerpt: excerptOf(r, cfg.max_excerpt_chars) });
    out.set(pattern, bucket);
  }
  return out;
}

/** The reusable lesson, else the body. Cut to the budget, never padded. */
function excerptOf(r: Reflection, maxChars: number): string {
  const text = (r.lesson.trim() || r.body.trim()).replace(/\r\n/g, "\n");
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** One line, bounded. A provider error can carry a whole HTML error page, and
 * this string is printed under a candidate. */
function describe(e: unknown): string {
  const err = e as Error;
  const message = String(err?.message ?? e).replace(/\s+/g, " ").trim();
  return `${err?.name || "Error"}: ${message.slice(0, 200)}`;
}

function unavailable(alias: string, canonical: string, evidence: [string[], string[]], error: string): SemanticAssessment {
  return {
    alias,
    canonical,
    status: "unavailable",
    verdict: null,
    confidence: null,
    probabilities: {},
    alias_reflection_ids: evidence[0],
    canonical_reflection_ids: evidence[1],
    model: null,
    error,
  };
}

/** Runs `jobs` with at most `limit` in flight, keeping the input order. */
async function pooled<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out = new Array<T>(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      out[i] = await jobs[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return out;
}

/** The deterministic suggestions, plus a semantic assessment per candidate
 * when the feature is on and the judge role sits on a System One endpoint.
 *
 * Never raises for a provider or config problem: a broken endpoint must still
 * leave a human with the full deterministic list, and the reason it could not
 * run is a field, not an exception. */
export async function assessAliasSuggestions(
  cfg: Config,
  world: World,
  opts: AliasSemanticOptions = {},
): Promise<AliasSemanticReport> {
  const suggestions = suggestAliases(world.name);
  const plain = (status: AliasSemanticReport["status"], reason: string | null): AliasSemanticReport => ({
    world: world.name,
    status,
    reason,
    model: null,
    assessed: 0,
    suggestions: suggestions.map((s) => ({ ...s, semantic: null })),
  });

  const semantic = cfg.alias_semantic;
  if (!semantic.enabled) return plain("disabled", null);
  if (suggestions.length === 0) return plain("ok", null);

  // Resolved once, before any request. A wrong endpoint kind, a missing model
  // and a locality violation all land here, so the answer is one clear reason
  // instead of the same provider error repeated per pair.
  let model: string;
  try {
    const llm = opts.llm ?? loadLlm(world);
    const resolved = resolveRole(llm, "judge", world);
    if (resolved.endpoint.kind !== "system-one") {
      return plain(
        "unavailable",
        `role judge runs on endpoint ${JSON.stringify(resolved.endpoint.name)} of kind ${JSON.stringify(resolved.endpoint.kind)}; ` +
          "semantic assessment needs a system-one endpoint (sil llm use <endpoint> --role judge)",
      );
    }
    model = resolved.model;
  } catch (e) {
    return plain("unavailable", describe(e));
  }

  const evidence = evidenceByPattern(world, semantic);
  const candidates = suggestions.slice(0, semantic.max_candidates);
  const decide = opts.decideChoice ?? defaultDecideChoice;

  const jobs = candidates.map((s) => async (): Promise<SemanticAssessment> => {
    const aliasRows = evidence.get(s.alias) ?? [];
    const canonicalRows = evidence.get(s.canonical) ?? [];
    const ids: [string[], string[]] = [aliasRows.map((r) => r.id), canonicalRows.map((r) => r.id)];
    // One pair can never take the report down with it: whatever goes wrong in
    // here, including a transport that breaks its own contract, is this row's
    // `unavailable` and nothing else.
    try {
      if (aliasRows.length === 0 || canonicalRows.length === 0) {
        const empty = aliasRows.length === 0 ? s.alias : s.canonical;
        return unavailable(s.alias, s.canonical, ids, `no readable reflection evidence for ${empty}`);
      }

      const { state, questions } = pairQuestion(
        { name: s.alias, reflections: aliasRows },
        { name: s.canonical, reflections: canonicalRows },
      );
      const answers = await decide("judge", state, questions, { world, llm: opts.llm, timeoutMs: semantic.timeout_s * 1000 });

      const answer = answers?.[QUESTION_ID];
      // decideChoice already refuses an answer outside the question's options,
      // but the transport is injectable, so the identity check is repeated where
      // the result gets attached to a candidate.
      if (!answer || (answer.choice !== "same_mechanism" && answer.choice !== "distinct")) {
        return unavailable(s.alias, s.canonical, ids, `provider answered ${JSON.stringify(answer?.choice ?? null)} for ${QUESTION_ID}`);
      }

      // Confidence first, the winning option's probability when the server
      // reports no confidence, and `unsure` when it reports neither.
      const probabilities = answer.probabilities ?? {};
      const gate = answer.confidence ?? probabilities[answer.choice] ?? null;
      const verdict: SemanticVerdict = gate === null || gate < semantic.min_confidence ? "unsure" : answer.choice;
      return {
        alias: s.alias,
        canonical: s.canonical,
        status: "assessed",
        verdict,
        confidence: gate,
        probabilities: { ...probabilities },
        alias_reflection_ids: ids[0],
        canonical_reflection_ids: ids[1],
        model: answer.model,
        error: null,
      };
    } catch (e) {
      return unavailable(s.alias, s.canonical, ids, describe(e));
    }
  });

  const results = await pooled(jobs, semantic.concurrency);
  const assessed = results.filter((r) => r.status === "assessed").length;
  return {
    world: world.name,
    status: assessed > 0 ? "ok" : "unavailable",
    reason: assessed > 0 ? null : (results[0]?.error ?? "no candidate could be assessed"),
    model,
    assessed,
    suggestions: suggestions.map((s, i) => ({ ...s, semantic: i < results.length ? results[i]! : null })),
  };
}
