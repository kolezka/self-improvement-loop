// sil import reflections|ledger: one-time V1 data bridge.

import { loadConfig, worldNamed } from "@sil/core";
import { importLedger, importReflections } from "../importer.ts";

export interface ImportReflectionsOptions {
  world: string;
}

export function cmdImportReflections(dir: string, opts: ImportReflectionsOptions): number {
  const cfg = loadConfig();
  const world = worldNamed(cfg, opts.world);
  const result = importReflections(dir, world.name);
  console.log(`copied ${result.copied}, skipped ${result.skippedDuplicate} duplicate, ${result.skippedNonReflection} non-reflection`);
  return 0;
}

export interface ImportLedgerOptions {
  world: string;
}

export function cmdImportLedger(file: string, opts: ImportLedgerOptions): number {
  const cfg = loadConfig();
  const world = worldNamed(cfg, opts.world);
  const count = importLedger(file, world);
  console.log(`imported ${count} ledger entries for world ${world.name}`);
  return 0;
}
