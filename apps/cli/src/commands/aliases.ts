// sil aliases: list, set, rm the one-hop pattern alias map, plus suggest
// candidates from token overlap. suggest never writes; only set and rm do.

import { isSlug, loadConfig, ValidationError } from "@sil/core";
import { assessAliasSuggestions, type SemanticAssessment, type SemanticVerdict } from "@sil/curriculum";
import { loadAliases, saveAliases } from "@sil/store";
import { resolveWorld } from "../common.ts";

export interface AliasesListOptions {
  world?: string;
}

export function cmdAliasesList(opts: AliasesListOptions): number {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const entries = Object.entries(loadAliases(world.name)).sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length === 0) {
    console.log(`no aliases for world ${world.name}`);
    return 0;
  }
  for (const [alias, canonical] of entries) console.log(`${alias.padEnd(30)} -> ${canonical}`);
  return 0;
}

export interface AliasesSetOptions {
  world?: string;
}

export function cmdAliasesSet(alias: string, canonical: string, opts: AliasesSetOptions): number {
  if (!isSlug(alias)) throw new ValidationError(`alias ${JSON.stringify(alias)} is not a valid slug`);
  if (!isSlug(canonical)) throw new ValidationError(`canonical ${JSON.stringify(canonical)} is not a valid slug`);
  if (alias === canonical) throw new ValidationError(`alias and canonical cannot both be ${JSON.stringify(alias)}`);
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const current = loadAliases(world.name);
  // Resolution is one hop only: aliasing to something that is itself an
  // alias would silently need a second hop to resolve.
  if (Object.hasOwn(current, canonical)) {
    throw new ValidationError(
      `${JSON.stringify(canonical)} is itself an alias for ${JSON.stringify(current[canonical])}; point ${JSON.stringify(alias)} at ${JSON.stringify(current[canonical])} instead`,
    );
  }
  // The new alias may already be the canonical target of other entries.
  // Left alone that forms a chain the moment we add alias -> canonical, so
  // re-point those entries at the new canonical instead of splitting them off.
  const next: Record<string, string> = { ...current, [alias]: canonical };
  const repointed: string[] = [];
  for (const [k, v] of Object.entries(current)) {
    if (v === alias) {
      next[k] = canonical;
      repointed.push(k);
    }
  }
  repointed.sort();
  saveAliases(world.name, next);
  console.log(`aliased ${alias} -> ${canonical} in world ${world.name}`);
  for (const k of repointed) console.log(`re-pointed ${k} -> ${canonical} (was -> ${alias})`);
  return 0;
}

export interface AliasesRmOptions {
  world?: string;
}

export function cmdAliasesRm(alias: string, opts: AliasesRmOptions): number {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const current = loadAliases(world.name);
  if (!Object.hasOwn(current, alias)) {
    console.log(`no alias ${alias} in world ${world.name}`);
    return 0;
  }
  const { [alias]: _removed, ...rest } = current;
  saveAliases(world.name, rest);
  console.log(`removed alias ${alias} in world ${world.name}`);
  return 0;
}

export interface AliasesSuggestOptions {
  world?: string;
}

// Fixed labels. The model picks an option id; every word a human reads here
// is written in this file, never generated.
const VERDICT_LABEL: Record<SemanticVerdict, string> = {
  same_mechanism: "same mechanism",
  distinct: "different mechanisms",
  unsure: "unsure",
};

function semanticLines(semantic: SemanticAssessment | null, cap: number): string[] {
  if (semantic === null) return [`    semantic: not assessed (past the candidate cap of ${cap})`];
  if (semantic.status === "unavailable") return [`    semantic: unavailable (${semantic.error})`];
  const confidence = semantic.confidence === null ? "confidence not reported" : `confidence ${semantic.confidence.toFixed(2)}`;
  const model = semantic.model === null ? "unknown model" : `model ${semantic.model}`;
  return [
    `    semantic: ${VERDICT_LABEL[semantic.verdict ?? "unsure"]} (${confidence}, ${model})`,
    `      evidence ${semantic.alias}: ${semantic.alias_reflection_ids.join(", ") || "none"}`,
    `      evidence ${semantic.canonical}: ${semantic.canonical_reflection_ids.join(", ") || "none"}`,
  ];
}

export async function cmdAliasesSuggest(opts: AliasesSuggestOptions): Promise<number> {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  // Reads only. The semantic pass hangs an assessment off each candidate and
  // changes neither the candidates, their counts nor their order.
  const report = await assessAliasSuggestions(cfg, world);
  if (report.suggestions.length === 0) {
    console.log(`no alias suggestions for world ${world.name}`);
    return 0;
  }
  console.log(`possible near-duplicate patterns (same mechanism, different slug). Review each, then apply with the command shown:`);
  // A config, endpoint or locality problem stops every pair for the same
  // reason, and no pair carries an assessment. Say it once and leave the
  // per-candidate lines out; every other failure is per pair and prints there.
  const preflightFailed = report.status === "unavailable" && report.suggestions.every((s) => s.semantic === null);
  if (preflightFailed) console.log(`  semantic assessment unavailable: ${report.reason}`);
  for (const s of report.suggestions) {
    console.log(`  ${s.alias} (${s.alias_count}) ~ ${s.canonical} (${s.canonical_count})  score=${s.score.toFixed(2)}`);
    if (report.status !== "disabled" && !preflightFailed) {
      for (const line of semanticLines(s.semantic, cfg.alias_semantic.max_candidates)) console.log(line);
    }
    console.log(`    sil aliases set ${s.alias} ${s.canonical} --world ${world.name}`);
  }
  return 0;
}
