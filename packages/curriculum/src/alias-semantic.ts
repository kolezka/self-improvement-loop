// An opt-in second opinion on the deterministic alias suggestions.
//
// `suggestAliases` compares slug tokens, so it cannot see that
// `stale-cached-env` and `env-read-before-refresh` are one mechanism under two
// names. This asks a System One endpoint one typed question per candidate pair
// and hangs the answer off the suggestion.
//
// Three rules shape it. It reads and never writes, so `sil aliases set` stays
// the only way a pair becomes an alias. The deterministic list comes back
// whole, in order, whatever the model said. The model picks one of two named
// options, so every sentence a human reads is a fixed template plus real ids.

import { apiKey, type AliasSemanticConfig, type Config, loadLlm, type LlmConfig, resolveRole, type Reflection, type World } from "@sil/core";
import { type ChoiceAnswer, type ChoiceQuestion, decideChoice as defaultDecideChoice, type DecideChoiceFn } from "@sil/providers";
import { type AliasSuggestion, listReflections, loadAliases, suggestAliases } from "@sil/store";

/** The three answers a human sees. `unsure` is never a model option: it is
 * what a pick below the confidence bar becomes. */
export type SemanticVerdict = "same_mechanism" | "distinct" | "unsure";

/** What the model may actually pick. `unsure` is ours, not the model's. */
export type ModelChoice = Exclude<SemanticVerdict, "unsure">;

export const QUESTION_ID = "same_mechanism";

/** The options the model picks between, with what each one means. */
export const PAIR_CRITERIA: Record<ModelChoice, string> = {
  same_mechanism:
    "The two patterns describe one underlying failure mechanism. The same cause produces both, " +
    "and one corrective lesson would cover both occurrences. The names differ; the mechanism does not.",
  distinct:
    "The two patterns describe different failure mechanisms. The causes differ, or a lesson written for one " +
    "would not correct the other. A shared topic, a shared tool or shared words in the name are not enough.",
};

export const isModelChoice = (v: unknown): v is ModelChoice => typeof v === "string" && Object.hasOwn(PAIR_CRITERIA, v);

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

/** The reflection ids behind one pair, named so the two lists cannot be
 * swapped by a positional mistake. */
export interface EvidenceIds {
  alias: string[];
  canonical: string[];
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
 * null when the pair was not assessed at all: the feature is off, the pass
 * never started, or the pair sits past `max_candidates`. */
export interface AssessedAliasSuggestion extends AliasSuggestion {
  semantic: SemanticAssessment | null;
}

export interface AliasSemanticReport {
  world: string;
  /** `disabled`: the feature is off. `preflight_failed`: config or endpoint
   * stopped the pass before any request, so no row carries an assessment.
   * `none_assessed`: every pair was tried and every pair failed. `ok`: at
   * least one pair was assessed. */
  status: "disabled" | "ok" | "preflight_failed" | "none_assessed";
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

/** A verdict and the number it was gated on. */
export interface GatedVerdict {
  verdict: SemanticVerdict;
  confidence: number;
}

/** The verdict an answer carries, or null when nothing can be read from it.
 *
 * Null covers two cases the caller has to treat as a failed assessment: a pick
 * outside the two options, and a server that reported neither a confidence nor
 * a probability for its own pick. Neither is a hedge, so neither may become
 * `unsure`. Shared with the evaluation script so both judge answers alike. */
export function verdictFor(answer: ChoiceAnswer, minConfidence: number): GatedVerdict | null {
  if (!isModelChoice(answer.choice)) return null;
  const gate = answer.confidence ?? (answer.probabilities ?? {})[answer.choice] ?? null;
  if (gate === null) return null;
  return { verdict: gate < minConfidence ? "unsure" : answer.choice, confidence: gate };
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
    const excerpt = excerptOf(r, cfg.max_excerpt_chars);
    // An empty excerpt is not evidence. Kept, it would send the model a blank
    // string and print the id below the verdict as if it grounded the answer.
    if (excerpt === "") continue;
    bucket.push({ id: r.id, excerpt });
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

/** A rejected pick is printed under a candidate, so a transport that answers
 * with a paragraph must not get that paragraph echoed back. */
function quotePick(v: unknown): string {
  if (typeof v !== "string") return JSON.stringify(v) ?? "undefined";
  return /^[\w.-]{1,64}$/.test(v) ? JSON.stringify(v) : `a ${v.length}-character string`;
}

function unavailable(alias: string, canonical: string, ids: EvidenceIds, error: string): SemanticAssessment {
  return {
    alias,
    canonical,
    status: "unavailable",
    verdict: null,
    confidence: null,
    probabilities: {},
    alias_reflection_ids: ids.alias,
    canonical_reflection_ids: ids.canonical,
    model: null,
    error,
  };
}

/** The error most rows agree on. One dead endpoint reads better as the run's
 * reason than whichever pair happened to be first in the list. */
function commonReason(results: SemanticAssessment[]): string {
  const counts = new Map<string, number>();
  for (const r of results) {
    if (r.error === null) continue;
    counts.set(r.error, (counts.get(r.error) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [error, count] of counts) {
    if (count > bestCount) {
      best = error;
      bestCount = count;
    }
  }
  return best ?? "no candidate could be assessed";
}

/** Runs `jobs` with at most `limit` in flight, keeping the input order. A job
 * that rejects would abandon the other workers, so every job self-catches. */
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

  // Everything that would fail identically for every pair is settled here,
  // before any request, so the answer is one clear reason instead of the same
  // error repeated under every candidate.
  let model: string;
  try {
    const llm = opts.llm ?? loadLlm(world);
    const resolved = resolveRole(llm, "judge", world);
    if (resolved.endpoint.kind !== "system-one") {
      return plain(
        "preflight_failed",
        `role judge runs on endpoint ${JSON.stringify(resolved.endpoint.name)} of kind ${JSON.stringify(resolved.endpoint.kind)}; ` +
          "semantic assessment needs a system-one endpoint (sil llm use <endpoint> --role judge)",
      );
    }
    if (!resolved.endpoint.base_url?.trim()) {
      return plain("preflight_failed", `endpoint ${JSON.stringify(resolved.endpoint.name)} has no base_url configured`);
    }
    // Raises when api_key_env names a variable that is not set. resolveRole
    // does not look at credentials, so without this one unset key would print
    // the same line under every candidate.
    apiKey(resolved.endpoint);
    model = resolved.model;
  } catch (e) {
    return plain("preflight_failed", describe(e));
  }

  const evidence = evidenceByPattern(world, semantic);
  const candidates = suggestions.slice(0, semantic.max_candidates);
  const decide = opts.decideChoice ?? defaultDecideChoice;

  const jobs = candidates.map((s) => async (): Promise<SemanticAssessment> => {
    const aliasRows = evidence.get(s.alias) ?? [];
    const canonicalRows = evidence.get(s.canonical) ?? [];
    const ids: EvidenceIds = { alias: aliasRows.map((r) => r.id), canonical: canonicalRows.map((r) => r.id) };
    // One pair can never take the report down with it: whatever goes wrong in
    // here, including a transport that breaks its own contract, is this row's
    // `unavailable` and nothing else.
    try {
      if (aliasRows.length === 0 || canonicalRows.length === 0) {
        const empty = aliasRows.length === 0 ? s.alias : s.canonical;
        return unavailable(s.alias, s.canonical, ids, `no reflection resolves to ${empty} in world ${world.name} after alias folding`);
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
      if (!answer || !isModelChoice(answer.choice)) {
        return unavailable(s.alias, s.canonical, ids, `provider answered ${quotePick(answer?.choice ?? null)} for ${QUESTION_ID}`);
      }

      const gated = verdictFor(answer, semantic.min_confidence);
      // No confidence and no probability for the pick means nothing was
      // measured. That is a failed assessment, not a hedge, and `unsure` would
      // read as a hedge.
      if (gated === null) {
        return unavailable(s.alias, s.canonical, ids, `provider reported neither confidence nor probabilities for ${QUESTION_ID}`);
      }
      return {
        alias: s.alias,
        canonical: s.canonical,
        status: "assessed",
        verdict: gated.verdict,
        confidence: gated.confidence,
        probabilities: { ...(answer.probabilities ?? {}) },
        alias_reflection_ids: ids.alias,
        canonical_reflection_ids: ids.canonical,
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
    status: assessed > 0 ? "ok" : "none_assessed",
    reason: assessed > 0 ? null : commonReason(results),
    model,
    assessed,
    suggestions: suggestions.map((s, i) => ({ ...s, semantic: i < results.length ? results[i]! : null })),
  };
}
