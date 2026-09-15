// sil status: worker, queue and per-world provider status.
//
// Each optional integration (worker, review, providers) is wrapped so one
// package that is not implemented yet degrades this command instead of
// crashing it, the same graceful-degradation shape the Python port used for
// a module that had not landed.

import { loadConfig } from "@sil/core";
import { listQueue, listReflections } from "@sil/store";
import { defaultDeps, type Deps } from "../deps.ts";

export interface StatusOptions {
  json?: boolean;
}

interface WorldInfo {
  world: string;
  llm: string;
  reflections: number;
  staged: number;
  artifacts: number;
  provider: { endpoint: string | null; reachable: boolean | null; error: string | null };
}

export async function cmdStatus(opts: StatusOptions, deps: Deps = defaultDeps): Promise<number> {
  const cfg = loadConfig();

  let workerStatus: Record<string, unknown> = {};
  try {
    workerStatus = deps.worker.status() as unknown as Record<string, unknown>;
  } catch {
    // worker package not ready yet
  }

  const queueCounts = { pending: 0, done: 0, failed: 0 };
  for (const bucket of ["pending", "done", "failed"] as const) {
    try {
      queueCounts[bucket] = listQueue(bucket).length;
    } catch {
      // leave at 0
    }
  }

  const worldsInfo: WorldInfo[] = [];
  for (const w of cfg.worlds) {
    const info: WorldInfo = {
      world: w.name,
      llm: w.llm,
      reflections: 0,
      staged: 0,
      artifacts: 0,
      provider: { endpoint: null, reachable: null, error: "unknown" },
    };
    try {
      info.reflections = listReflections(w.name).length;
    } catch {
      // reflections dir unreadable: leave at 0
    }
    try {
      info.staged = deps.review.queue(w, cfg).length;
      info.artifacts = deps.review.inventory(w, cfg).length;
    } catch {
      // review package not ready yet
    }
    try {
      info.provider = await deps.providers.status(w);
    } catch (e) {
      info.provider = { endpoint: null, reachable: null, error: (e as Error).message };
    }
    worldsInfo.push(info);
  }

  const payload = { worker: workerStatus, queue: queueCounts, worlds: worldsInfo };
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  const workerLine = Object.keys(workerStatus).length > 0 ? JSON.stringify(workerStatus) : "(worker module not available)";
  console.log(`worker: ${workerLine}`);
  console.log(`queue: pending=${queueCounts.pending} done=${queueCounts.done} failed=${queueCounts.failed}`);
  console.log();
  console.log(`${"world".padEnd(16)} ${"llm".padEnd(6)} ${"reflections".padStart(11)} ${"staged".padStart(7)} ${"artifacts".padStart(9)}  provider`);
  for (const info of worldsInfo) {
    const prov = info.provider;
    const provStr = prov.error ? `${prov.endpoint ?? "?"} error: ${prov.error}` : `${prov.endpoint} reachable=${prov.reachable}`;
    console.log(
      `${info.world.padEnd(16)} ${info.llm.padEnd(6)} ${String(info.reflections).padStart(11)} ` +
        `${String(info.staged).padStart(7)} ${String(info.artifacts).padStart(9)}  ${provStr}`,
    );
  }
  return 0;
}
