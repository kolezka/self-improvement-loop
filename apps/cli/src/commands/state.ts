// sil state: the loop-state database. Status, migrate (import now), export
// back to the legacy JSONL paths, and the quarantine of lines that could not
// be imported (design D14).

import {
  dropQuarantine,
  exportLegacy,
  type GlobalStream,
  listQuarantine,
  migrateLegacy,
  type StoreName,
  STORES,
  type Stream,
  stateStatus,
  STREAMS,
} from "@sil/statedb";

// Per-world streams have their own block, one line per world.
const STREAM_NAMES = (Object.keys(STREAMS) as Stream[]).filter((stream) => !STREAMS[stream].perWorld) as GlobalStream[];
const STORE_NAMES = Object.keys(STORES) as StoreName[];

/** A store as the operator types it, with the world for a per-world one. */
const named = (store: string, world: string | null): string => (world === null ? store : `${store} (${world})`);

interface WorldLine {
  store: string;
  world: string | null;
  rows: number;
  quarantined: number;
  pending: boolean;
}

/** A block of per-store or per-world lines, then the on-disk names left alone. */
function printWorldBlock(title: string, lines: WorldLine[], invalid: { store: string; name: string }[]): void {
  if (lines.length === 0 && invalid.length === 0) {
    console.log(`${title}: none`);
    return;
  }
  console.log(`${title}:`);
  for (const d of lines) {
    const notes = [d.quarantined > 0 ? `${d.quarantined} quarantined` : "", d.pending ? "legacy file waiting" : ""].filter(Boolean);
    console.log(`  ${named(d.store, d.world).padEnd(16)} ${String(d.rows).padStart(7)} rows${notes.length ? `  (${notes.join(", ")})` : ""}`);
  }
  for (const entry of invalid) console.log(`  invalid world name, not imported: ${entry.store} ${JSON.stringify(entry.name)}`);
}

export function cmdStateStatus(opts: { json?: boolean }): number {
  const status = stateStatus();
  if (opts.json) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }
  console.log(`database: ${status.dbPath}`);
  console.log(`schema:   ${status.schemaVersion}`);
  console.log(`fs class: ${status.fsClass ?? "unknown"}`);
  if (status.suspended) console.log(`legacy imports suspended since ${status.suspended} (sil state export); sil state migrate resumes them`);
  console.log("stores:");
  for (const stream of STREAM_NAMES) {
    const s = status.streams[stream];
    const notes = [s.quarantined > 0 ? `${s.quarantined} quarantined` : "", s.pending ? "legacy file waiting" : ""].filter(Boolean);
    console.log(`  ${stream.padEnd(16)} ${String(s.rows).padStart(7)} rows${notes.length ? `  (${notes.join(", ")})` : ""}`);
  }
  const invalidPayloads = status.invalidWorldEntries.filter((entry) => entry.store === "payload_samples");
  const invalidDocs = status.invalidWorldEntries.filter((entry) => entry.store !== "payload_samples");
  printWorldBlock("documents", status.docs, invalidDocs);
  // One line per world, named by the world alone.
  printWorldBlock("payload samples", status.worldStreams.map((w) => ({ ...w, store: w.world, world: null })), invalidPayloads);
  if (status.imports.length === 0) {
    console.log("imports: none");
    return 0;
  }
  console.log("imports:");
  for (const imp of status.imports) {
    if (imp.state === "failed") {
      const label = Object.hasOwn(STORES, imp.store) ? STORES[imp.store as StoreName].label(imp.world) : imp.store;
      console.log(`  ${named(imp.store, imp.world).padEnd(16)} failed: ${label} (${imp.originalPath}): ${imp.failure ?? "no reason recorded"}`);
      continue;
    }
    let check: string;
    if (imp.backupCheck === "grew") check = `backup grew after import: ${imp.grewBytes} bytes not in the DB`;
    else if (imp.backupCheck === "changed") check = "backup changed after import";
    else if (imp.backupCheck === "missing") check = "backup missing";
    else if (imp.backupCheck === "ok") check = "backup ok";
    else check = "exported, not imported back yet";
    console.log(`  ${named(imp.store, imp.world).padEnd(16)} ${imp.lines} lines, ${check}${imp.backupPath ? `: ${imp.backupPath}` : ""}`);
  }
  return 0;
}

export function cmdStateMigrate(): number {
  const { resumed, outcomes, failures } = migrateLegacy();
  if (resumed !== null) console.log(`resumed legacy imports (suspended by the export at ${resumed})`);
  for (const o of outcomes) {
    console.log(`${named(o.store, o.world)}: ${o.imported} imported, ${o.quarantined} quarantined, ${o.blank} blank; backup ${o.backupPath}`);
  }
  for (const f of failures) console.error(`error: ${f.message}`);
  if (outcomes.length === 0 && failures.length === 0) console.log("nothing to import");
  return failures.length > 0 ? 1 : 0;
}

export function cmdStateExport(opts: { legacyPaths?: boolean; force?: boolean }): number {
  if (!opts.legacyPaths) {
    console.error("error: sil state export needs --legacy-paths (the only export target)");
    return 2;
  }
  const result = exportLegacy(opts.force === true);
  for (const path of result.written) console.log(`wrote ${path}`);
  for (const r of result.refused) console.error(`error: ${r.message}`);
  for (const f of result.failures) console.error(`error: ${f.message}`);
  if (result.written.length === 0 && result.refused.length === 0 && result.failures.length === 0) console.log("nothing to export");
  return result.refused.length > 0 || result.failures.length > 0 ? 1 : 0;
}

export function cmdStateQuarantine(opts: { drop?: string; world?: string }): number {
  if (opts.world !== undefined && opts.drop === undefined) {
    console.error("error: --world goes with --drop <store>");
    return 2;
  }
  if (opts.drop !== undefined) {
    if (!Object.hasOwn(STORES, opts.drop)) {
      console.error(`error: unknown store ${JSON.stringify(opts.drop)}; expected one of ${STORE_NAMES.join(", ")}`);
      return 2;
    }
    const store = opts.drop as StoreName;
    if (opts.world !== undefined && !STORES[store].perWorld) {
      console.error(`error: ${store} is global and has no world; drop it without --world`);
      return 2;
    }
    // Without --world a per-world store drops every world's rows.
    const n = dropQuarantine(store, opts.world);
    console.log(`dropped ${n} quarantined ${n === 1 ? "entry" : "entries"} from ${named(store, opts.world ?? null)}`);
    return 0;
  }
  const entries = listQuarantine();
  if (entries.length === 0) {
    console.log("no quarantined lines");
    return 0;
  }
  for (const e of entries) {
    console.log(`${named(e.store, e.world).padEnd(16)} line ${String(e.lineNo ?? "?").padStart(6)}  ${e.reason}  (${e.source})`);
  }
  return 0;
}
