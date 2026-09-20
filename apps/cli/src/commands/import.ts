// sil import reflections|ledger|payloads: one-time data bridges.

import { loadConfig, worldNamed } from "@sil/core";
import { importLedger, importPayloadSamples, importReflections } from "../importer.ts";

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

export interface ImportPayloadsCmdOptions {
  days?: number;
}

export function cmdImportPayloads(opts: ImportPayloadsCmdOptions): number {
  const cfg = loadConfig();
  const days = opts.days ?? 30;
  const result = importPayloadSamples(cfg, { days });
  const worlds = Object.keys(result.written).sort();
  if (worlds.length === 0) console.log(`no samples written from ${result.files} transcript files`);
  for (const world of worlds) {
    console.log(`world ${world}: ${result.written[world]} samples from ${result.files} files`);
  }
  console.log(`scanned ${result.records} tool calls, skipped ${result.skippedNoWorld} with no owning world`);
  return 0;
}
