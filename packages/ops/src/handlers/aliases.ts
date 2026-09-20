import { loadAliases, saveAliases, suggestAliases } from "@sil/store";
import type { AliasArgs, WorldArgs } from "../args.ts";

export function aliasesGet(args: WorldArgs) {
  return loadAliases(args.world);
}

export function aliasesSet(args: AliasArgs) {
  saveAliases(args.world, args.aliases);
  return loadAliases(args.world);
}

export function aliasesSuggest(args: WorldArgs) {
  return suggestAliases(args.world);
}
