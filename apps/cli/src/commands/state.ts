// sil state: the loop-state database. Status, migrate (import now), export
// back to the legacy JSONL paths, and the quarantine of lines that could not
// be imported (design D14).

import { dropQuarantine, exportLegacy, listQuarantine, migrateLegacy, type Stream, stateStatus, STREAMS } from "@sil/statedb";

const STREAM_NAMES = Object.keys(STREAMS) as Stream[];

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
  if (status.imports.length === 0) {
    console.log("imports: none");
    return 0;
  }
  console.log("imports:");
  for (const imp of status.imports) {
    if (imp.state === "failed") {
      console.log(`  ${imp.store.padEnd(16)} failed: ${imp.failure ?? "no reason recorded"}`);
      continue;
    }
    let check: string;
    if (imp.backupCheck === "grew") check = `backup grew after import: ${imp.grewBytes} bytes not in the DB`;
    else if (imp.backupCheck === "changed") check = "backup changed after import";
    else if (imp.backupCheck === "missing") check = "backup missing";
    else if (imp.backupCheck === "ok") check = "backup ok";
    else check = "exported, not imported back yet";
    console.log(`  ${imp.store.padEnd(16)} ${imp.lines} lines, ${check}${imp.backupPath ? `: ${imp.backupPath}` : ""}`);
  }
  return 0;
}

export function cmdStateMigrate(): number {
  const { resumed, outcomes, failures } = migrateLegacy();
  if (resumed !== null) console.log(`resumed legacy imports (suspended by the export at ${resumed})`);
  for (const o of outcomes) {
    console.log(`${o.world === null ? o.store : `${o.store} (${o.world})`}: ${o.imported} imported, ${o.quarantined} quarantined, ${o.blank} blank; backup ${o.backupPath}`);
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

export function cmdStateQuarantine(opts: { drop?: string }): number {
  if (opts.drop !== undefined) {
    if (!Object.hasOwn(STREAMS, opts.drop)) {
      console.error(`error: unknown store ${JSON.stringify(opts.drop)}; expected one of ${STREAM_NAMES.join(", ")}`);
      return 2;
    }
    const n = dropQuarantine(opts.drop as Stream);
    console.log(`dropped ${n} quarantined ${n === 1 ? "line" : "lines"} from ${opts.drop}`);
    return 0;
  }
  const entries = listQuarantine();
  if (entries.length === 0) {
    console.log("no quarantined lines");
    return 0;
  }
  for (const e of entries) {
    console.log(`${e.store.padEnd(16)} line ${String(e.lineNo ?? "?").padStart(6)}  ${e.reason}  (${e.source})`);
  }
  return 0;
}
