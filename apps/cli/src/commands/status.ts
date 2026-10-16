// sil status: worker, queue and per-world provider status.
//
// Each optional integration (worker, review, providers) is wrapped so one
// package that is not implemented yet degrades this command instead of
// crashing it, the same graceful-degradation shape the Python port used for
// a module that had not landed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_ERROR_RESULT_PREFIX, fsx, loadConfig, paths } from "@sil/core";
import type { ProviderStatus } from "@sil/providers";
import { listQueue, listReflections } from "@sil/store";
import { defaultDeps, type Deps } from "../deps.ts";
import * as schedule from "../schedule.ts";

export interface StatusOptions {
  json?: boolean;
}

interface WorldInfo {
  world: string;
  llm: string;
  reflections: number;
  staged: number;
  artifacts: number;
  provider: ProviderStatus;
  /** Pending entries held by a config error (ModelNotConfigured): the worker
   * never burns an attempt on these, so they sit in queue/pending until the
   * operator fixes llm.yaml, and `provider` above can still read reachable
   * and error-free (e.g. the endpoint exists and `claude` answers, but a
   * role's model mapping is missing). This is the only place that says why
   * the backlog is not draining when that happens. */
  config_error_pending: number;
  config_error: string | null;
  /** Reachability of `claude` under the installed worker unit's own baked
   * PATH, not this process's, probed once no matter how many worlds ask.
   * Present only when a worker unit is installed AND some role this world
   * uses (critic, drafter or judge, not just critic) resolves to a
   * claude-cli endpoint. Absent (not null) otherwise, including when no
   * worker unit is installed at all: JSON.stringify drops an undefined
   * field, so callers see no key rather than a meaningless null. */
  unit_path_reachable?: boolean | null;
  /** The probe's own error, or the unit discovery/read error when the unit
   * could not even be found. Present exactly when unit_path_reachable is. */
  unit_path_error?: string | null;
}

/** darwin runs launchd, everything else (linux, the CI/test default) runs
 * systemd: the same default `schedule.resolveKind` uses, minus its throw for
 * an unrecognized platform, since status must never crash on this. */
function nativeSupervisor(platform: string): "systemd" | "launchd" {
  return platform === "darwin" ? "launchd" : "systemd";
}

interface UnitDiscovery {
  /** PATH to probe with: the unit's own baked PATH, `schedule.MINIMAL_PATH`
   * for a unit that predates PR #48, or null when there is nothing to probe
   * (no unit at all, or only a unit for the other supervisor). */
  path: string | null;
  /** Set whenever there is something to tell the operator: a non-native
   * leftover unit, or a unit that predates the baked-PATH fix. Independent
   * of `path`: the predates case sets both. */
  note: string | null;
}

function joinNotes(...notes: (string | null)[]): string | null {
  const kept = notes.filter((n): n is string => n !== null && n !== "");
  return kept.length > 0 ? kept.join("; ") : null;
}

/** Finds the worker unit native to `platform` (default `process.platform`)
 * and reads the PATH it declares. Reads the same files `cmdScheduleShow`
 * does. A unit for the other supervisor is never read silently: its
 * presence is reported in `note` instead, since it will not run here. */
function installedWorkerUnitPath(platform: string = process.platform): UnitDiscovery {
  const info = schedule.show();
  const native = nativeSupervisor(platform);
  const other = native === "systemd" ? "launchd" : "systemd";
  const installed = (kind: "systemd" | "launchd"): boolean =>
    kind === "systemd" ? info.systemd.includes("sil-worker.service") : info.launchd.includes(schedule.LAUNCHD_WORKER_PLIST);
  const leftover = installed(other)
    ? `found a ${other} worker unit, but this platform's native supervisor is ${native}, it will not run, reinstall with sil schedule install`
    : null;

  if (installed(native)) {
    const content =
      native === "systemd"
        ? readFileSync(join(schedule.systemdDir(), "sil-worker.service"), "utf8")
        : readFileSync(join(schedule.launchdDir(), schedule.LAUNCHD_WORKER_PLIST), "utf8");
    const path = schedule.unitPath(native, content);
    if (path !== null) return { path, note: leftover };
    // Predates PR #48: the unit declares no PATH at all. Probe with the
    // same minimal PATH the OS actually gives a job like this one.
    const predates = "installed worker unit predates the baked-PATH fix (PR #48) and declares no PATH, run sil schedule install to refresh it";
    return { path: schedule.MINIMAL_PATH.join(":"), note: joinNotes(predates, leftover) };
  }
  return { path: null, note: leftover };
}

export async function cmdStatus(opts: StatusOptions, deps: Deps = defaultDeps): Promise<number> {
  // The one file `sil init` creates and never touches again, so its
  // presence is "init has run", independent of whether the config it wrote
  // (or an operator edited since) still resolves to a working provider.
  // `/loop` and anything else deciding whether to run init must use this,
  // never a provider field: a world's provider can read null/errored on an
  // already-initialized install with a broken llm.yaml, and re-running init
  // then would be a silent no-op that hides the real error.
  const initialized = fsx.exists(paths.configFile());
  const cfg = loadConfig();

  // Discovery reads whatever unit file is on disk (schedule.show() plus
  // readFileSync); a broken symlink or an unreadable unit must degrade this
  // command like every other optional integration here, not crash it.
  let unitPath: string | null = null;
  let unitNote: string | null = null;
  try {
    const discovery = installedWorkerUnitPath(deps.platform);
    unitPath = discovery.path;
    unitNote = discovery.note;
  } catch (e) {
    unitNote = `could not read installed worker unit: ${(e as Error).message}`;
  }
  const unitInstalled = unitPath !== null || unitNote !== null;

  // One machine has one unit PATH, so probe it once and reuse the answer for
  // every world that needs it, instead of shelling out to `claude --version`
  // per world.
  let unitProbe: { reachable: boolean | null; error: string | null } | null = null;
  const probeUnitPathOnce = (): { reachable: boolean | null; error: string | null } => {
    if (unitProbe === null) {
      if (unitPath === null) {
        unitProbe = { reachable: false, error: unitNote };
      } else {
        try {
          const p = deps.providers.probeClaudeCli(unitPath);
          // The probe result decides reachable; operator notes (predates
          // PR #48, leftover unit) sit next to the probe's own error.
          unitProbe = { reachable: p.reachable, error: joinNotes(unitNote, p.error) };
        } catch (e) {
          unitProbe = { reachable: false, error: joinNotes(unitNote, (e as Error).message) };
        }
      }
    }
    return unitProbe;
  };

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

  // Read once, grouped per world below: providers.status probes the
  // endpoint, not whether every role it serves actually has a model, so an
  // endpoint can read reachable and error-free while the worker still fails
  // every entry with ModelNotConfigured. Those entries name the error
  // themselves (CONFIG_ERROR_RESULT_PREFIX), which is what this surfaces.
  let pendingEntries: ReturnType<typeof listQueue> = [];
  try {
    pendingEntries = listQueue("pending");
  } catch {
    // queue dir unreadable: leave empty, same degrade as queueCounts above
  }

  const worldsInfo: WorldInfo[] = [];
  for (const w of cfg.worlds) {
    const info: WorldInfo = {
      world: w.name,
      llm: w.llm,
      reflections: 0,
      staged: 0,
      artifacts: 0,
      provider: { endpoint: null, kind: null, base_url: null, models: {}, reachable: null, error: "unknown", endpoints: [] },
      config_error_pending: 0,
      config_error: null,
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
      info.provider = { endpoint: null, kind: null, base_url: null, models: {}, reachable: null, error: (e as Error).message, endpoints: [] };
    }
    const worldConfigErrors = pendingEntries.filter(
      (e) => e.world === w.name && (e.result ?? "").startsWith(CONFIG_ERROR_RESULT_PREFIX),
    );
    info.config_error_pending = worldConfigErrors.length;
    info.config_error = worldConfigErrors.length > 0 ? worldConfigErrors[0]!.result : null;
    // Any endpoint serving a worker role, not only the one serving critic:
    // the worker also calls claude-cli for drafter and judge (run.ts), so a
    // claude-only drafter still needs the unit's PATH checked.
    const usesClaudeCli = (info.provider.endpoints ?? []).some((e) => e.kind === "claude-cli" && e.roles.length > 0);
    if (unitInstalled && usesClaudeCli) {
      const probe = probeUnitPathOnce();
      info.unit_path_reachable = probe.reachable;
      info.unit_path_error = probe.error;
    }
    worldsInfo.push(info);
  }

  const payload = { initialized, worker: workerStatus, queue: queueCounts, worlds: worldsInfo };
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  if (!initialized) {
    console.log("not initialized: run `sil init` to write config.yaml and llm.yaml");
    console.log();
  }
  const workerLine = Object.keys(workerStatus).length > 0 ? JSON.stringify(workerStatus) : "(worker module not available)";
  console.log(`worker: ${workerLine}`);
  console.log(`queue: pending=${queueCounts.pending} done=${queueCounts.done} failed=${queueCounts.failed}`);
  console.log();
  console.log(`${"world".padEnd(16)} ${"llm".padEnd(6)} ${"reflections".padStart(11)} ${"staged".padStart(7)} ${"artifacts".padStart(9)}  provider`);
  for (const info of worldsInfo) {
    const prov = info.provider;
    let unitStr = "";
    if (info.unit_path_reachable !== undefined) {
      unitStr = ` unit_path_reachable=${info.unit_path_reachable}`;
      if (info.unit_path_error) unitStr += ` (claude --version: ${info.unit_path_error})`;
    }
    const provStr = (prov.error ? `${prov.endpoint ?? "?"} error: ${prov.error}` : `${prov.endpoint} reachable=${prov.reachable}`) + unitStr;
    console.log(
      `${info.world.padEnd(16)} ${info.llm.padEnd(6)} ${String(info.reflections).padStart(11)} ` +
        `${String(info.staged).padStart(7)} ${String(info.artifacts).padStart(9)}  ${provStr}`,
    );
    // Printed under the row, not folded into provStr: the provider above can
    // read entirely healthy while these entries name the actual reason the
    // backlog is not draining.
    if (info.config_error_pending > 0) {
      console.log(`  ${info.config_error_pending} pending entr${info.config_error_pending === 1 ? "y" : "ies"} held by a config error: ${info.config_error}`);
    }
  }
  return 0;
}
