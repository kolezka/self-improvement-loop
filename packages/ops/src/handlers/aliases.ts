import { loadAliases, saveAliases, suggestAliases } from "@sil/store";
import type { AliasArgs, WorldArgs } from "../args.ts";
import { cfgWorld } from "../cfg-world.ts";

// Every op resolves the world first. The store takes a bare name and happily
// reads or creates a directory under it, so an unknown world used to answer
// with an empty alias map instead of the 503 every other op gives.

export function aliasesGet(args: WorldArgs) {
  const [, world] = cfgWorld(args.world);
  return loadAliases(world.name);
}

export function aliasesSet(args: AliasArgs) {
  const [, world] = cfgWorld(args.world);
  saveAliases(world.name, args.aliases);
  return loadAliases(world.name);
}

export function aliasesSuggest(args: WorldArgs) {
  const [, world] = cfgWorld(args.world);
  return suggestAliases(world.name);
}
