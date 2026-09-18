// sil aliases: list, set, rm the one-hop pattern alias map, plus suggest
// candidates from token overlap. suggest never writes; only set and rm do.

import { isSlug, loadConfig, ValidationError } from "@sil/core";
import { loadAliases, saveAliases, suggestAliases } from "@sil/store";
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
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const current = loadAliases(world.name);
  // Resolution is one hop only: aliasing to something that is itself an
  // alias would silently need a second hop to resolve.
  if (canonical in current) {
    throw new ValidationError(
      `${JSON.stringify(canonical)} is itself an alias for ${JSON.stringify(current[canonical])}; point ${JSON.stringify(alias)} at ${JSON.stringify(current[canonical])} instead`,
    );
  }
  saveAliases(world.name, { ...current, [alias]: canonical });
  console.log(`aliased ${alias} -> ${canonical} in world ${world.name}`);
  return 0;
}

export interface AliasesRmOptions {
  world?: string;
}

export function cmdAliasesRm(alias: string, opts: AliasesRmOptions): number {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const current = loadAliases(world.name);
  if (!(alias in current)) {
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

export function cmdAliasesSuggest(opts: AliasesSuggestOptions): number {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const suggestions = suggestAliases(world.name);
  if (suggestions.length === 0) {
    console.log(`no alias suggestions for world ${world.name}`);
    return 0;
  }
  console.log(`possible near-duplicate patterns (same mechanism, different slug). Review each, then apply with the command shown:`);
  for (const s of suggestions) {
    console.log(`  ${s.alias} (${s.alias_count}) ~ ${s.canonical} (${s.canonical_count})  score=${s.score.toFixed(2)}`);
    console.log(`    sil aliases set ${s.alias} ${s.canonical} --world ${world.name}`);
  }
  return 0;
}
