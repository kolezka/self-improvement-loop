#!/usr/bin/env bun
// Times the full reflection reader against the index-backed heads reader on a
// copy of one reflections dir. Runs against temp SIL_CONFIG_DIR, SIL_STATE_DIR
// and SIL_DATA_DIR, so the source dir and the real home are never touched.
//
// Run: bun scripts/bench-reflection-index.ts <reflections-dir> [n]
//      n is the warm repeat count, default 3.
//
// See docs/BENCHMARK.md, "Reflections index".

import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, paths, saveConfig, worldNamed } from "@sil/core";
import { closeState } from "@sil/statedb";
import { listReflectionHeads, listReflections } from "@sil/store";

export interface BenchRow {
  name: string;
  n: number;
  p50: number;
  max: number;
  /** Records the last timed call returned, so an empty read cannot pass as fast. */
  records: number;
}

const ENV_KEYS = ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"] as const;
const WORLD = "default";

function timed(name: string, n: number, fn: () => unknown[]): BenchRow {
  const durations: number[] = [];
  let records = 0;
  for (let i = 0; i < n; i++) {
    const started = performance.now();
    records = fn().length;
    durations.push(performance.now() - started);
  }
  const sorted = [...durations].sort((a, b) => a - b);
  return { name, n, p50: sorted[Math.floor(sorted.length / 2)]!, max: sorted[sorted.length - 1]!, records };
}

/** Copies `dir` into a fresh temp home and times both readers there. */
export async function run(dir: string, n: number): Promise<BenchRow[]> {
  const tmp = mkdtempSync(join(tmpdir(), "sil-bench-index-"));
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
  try {
    const cfg = loadConfig();
    worldNamed(cfg, WORLD);
    saveConfig(cfg);
    cpSync(dir, paths.reflectionsDir(WORLD), { recursive: true });
    return [
      timed("listReflections", n, () => listReflections(WORLD)),
      timed("listReflectionHeads cold", 1, () => listReflectionHeads(WORLD)),
      timed("listReflectionHeads warm", n, () => listReflectionHeads(WORLD)),
    ];
  } finally {
    // Restore the env and remove the temp tree even if closing the DB throws.
    try {
      closeState();
    } finally {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const [dir, nArg] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: bun scripts/bench-reflection-index.ts <reflections-dir> [n]");
    process.exit(2);
  }
  const n = nArg === undefined ? 3 : Number(nArg);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`error: n must be a positive integer, got ${JSON.stringify(nArg)}`);
    process.exit(2);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).length;
  const rows = await run(dir, n);
  console.log(`top-level .md files: ${files}`);
  console.log("| reader | n | p50 ms | max ms | records |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.name} | ${r.n} | ${r.p50.toFixed(1)} | ${r.max.toFixed(1)} | ${r.records} |`);
}

if (import.meta.main) {
  await main();
}
