// Repair promoted_at, revised_at and revisions from the ledger file's own git
// history, for rows the accept bug (fixed alongside this file) corrupted by
// resetting promoted_at on every accepted redraft.
//
// The walk is a thin wrapper: it turns the ledger path's commit history into a
// list of (sha, author date, parsed ledger) snapshots. `computeRepair` is the
// pure function over that list, so the repair logic is testable against a
// synthetic history with no git or filesystem involved.

import { join } from "node:path";
import { type Config, type Ledger, type PromotionEntry, targetRoot, type World } from "@sil/core";
import { git } from "@sil/curriculum";
import { loadLedger as loadLedgerFile, parseLedger, saveLedger } from "@sil/store";
import { commitOnDefault, withWorkerLock } from "./index.ts";
import { ledgerRel } from "./snapshot.ts";

export interface LedgerSnapshot {
  sha: string;
  /** Commit author date, ISO. Used when a row's own promoted_at is null: the
   * one V1 case where a row predates the field entirely. */
  date: string;
  ledger: Ledger;
}

export interface RepairedRow {
  pattern: string;
  current_promoted_at: string | null;
  repaired_promoted_at: string | null;
  current_revised_at: string | null;
  repaired_revised_at: string | null;
  current_revisions: number;
  repaired_revisions: number;
  changed: boolean;
}

interface RepairEvent {
  sha: string;
  date: string;
  kind: "promoted" | "retired";
  promoted_at: string | null;
}

/** Recompute promoted_at, revised_at and revisions for every pattern in the
 * final snapshot's ledger, from the full history of ledger snapshots.
 *
 * For each pattern: find its last "retired" event, or none if it was never
 * retired. The earliest "promoted" event after that (or the earliest ever,
 * with no retirement) is the real promoted_at, taken from that commit's own
 * `promoted_at` field, or the commit's own date when the row predates the
 * field. The latest such event is revised_at, and the count of promotions in
 * that span past the first is revisions.
 *
 * Only `accept` ever moves a live row to "promoted" or "retired" (see
 * ARCHITECTURE.md, the curriculum-and-review section). A reject of a refine
 * leaves an already-promoted row's status and commit untouched, so it can
 * never be mistaken here for a redraft's accept: the discriminator is not
 * "status reads promoted" alone but "status reads promoted AND the artifact
 * commit changed", which a reject never does. */
export function computeRepair(snapshots: readonly LedgerSnapshot[]): RepairedRow[] {
  if (snapshots.length === 0) return [];

  const eventsByPattern = new Map<string, RepairEvent[]>();
  const prevRowByPattern = new Map<string, PromotionEntry>();
  for (const snap of snapshots) {
    for (const [pattern, row] of Object.entries(snap.ledger.entries)) {
      const prev = prevRowByPattern.get(pattern) ?? null;
      const becamePromoted = row.status === "promoted" && (!prev || prev.status !== "promoted" || prev.commit !== row.commit);
      const becameRetired = row.status === "retired" && (!prev || prev.status !== "retired");
      if (becamePromoted || becameRetired) {
        const list = eventsByPattern.get(pattern) ?? [];
        list.push({ sha: snap.sha, date: snap.date, kind: becamePromoted ? "promoted" : "retired", promoted_at: row.promoted_at });
        eventsByPattern.set(pattern, list);
      }
      prevRowByPattern.set(pattern, row);
    }
  }

  const live = snapshots[snapshots.length - 1]!.ledger;
  const out: RepairedRow[] = [];
  for (const pattern of Object.keys(live.entries).sort()) {
    const current = live.entries[pattern]!;
    const events = eventsByPattern.get(pattern) ?? [];
    let start = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.kind === "retired") {
        start = i + 1;
        break;
      }
    }
    const promotions = events.slice(start).filter((e) => e.kind === "promoted");

    let repairedPromotedAt = current.promoted_at;
    let repairedRevisedAt = current.revised_at;
    let repairedRevisions = current.revisions;
    if (promotions.length > 0) {
      const first = promotions[0]!;
      const latest = promotions[promotions.length - 1]!;
      repairedPromotedAt = first.promoted_at ?? first.date;
      repairedRevisions = promotions.length - 1;
      repairedRevisedAt = promotions.length > 1 ? (latest.promoted_at ?? latest.date) : repairedPromotedAt;
    }

    out.push({
      pattern,
      current_promoted_at: current.promoted_at,
      repaired_promoted_at: repairedPromotedAt,
      current_revised_at: current.revised_at,
      repaired_revised_at: repairedRevisedAt,
      current_revisions: current.revisions,
      repaired_revisions: repairedRevisions,
      changed:
        repairedPromotedAt !== current.promoted_at ||
        repairedRevisedAt !== current.revised_at ||
        repairedRevisions !== current.revisions,
    });
  }
  return out;
}

/** `rows` written onto `ledger`, changed rows only. Untouched fields (status,
 * served_by, feedback, the counts) are never part of a repair. */
export function applyRepair(ledger: Ledger, rows: readonly RepairedRow[]): Ledger {
  const entries = { ...ledger.entries };
  for (const row of rows) {
    if (!row.changed) continue;
    const entry = entries[row.pattern];
    if (!entry) continue;
    entries[row.pattern] = {
      ...entry,
      promoted_at: row.repaired_promoted_at,
      revised_at: row.repaired_revised_at,
      revisions: row.repaired_revisions,
    };
  }
  return { ...ledger, entries };
}

/** The ledger file's own commit history on the current branch, oldest first.
 * A commit whose ledger blob fails to parse is skipped, not fatal: history
 * a human already lived with should not block reading the rest of it. */
export function ledgerHistory(world: World, repo: string): LedgerSnapshot[] {
  const rel = ledgerRel(world);
  const log = git.git(repo, ["log", "--reverse", "--format=%H%x09%aI", "--", rel], { check: false });
  if (!log) return [];
  const out: LedgerSnapshot[] = [];
  for (const line of log.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const sha = line.slice(0, tab);
    const date = line.slice(tab + 1);
    const { found, text } = git.show(repo, sha, rel);
    if (!found) continue;
    try {
      out.push({ sha, date, ledger: parseLedger(text, sha) });
    } catch {
      continue;
    }
  }
  return out;
}

export interface RepairOptions {
  apply?: boolean;
}

export interface RepairResult {
  rows: RepairedRow[];
  applied: boolean;
  commit: string | null;
}

/** Dry run by default: `rows` is always the full forecast, `applied` says
 * whether anything was actually written. `--apply` takes the worker lock,
 * the same one every other ledger writer takes, and never pushes. */
export function repairPromotedAt(world: World, _cfg: Config, opts: RepairOptions = {}): RepairResult {
  const repo = targetRoot(world);
  if (!opts.apply) return { rows: computeRepair(ledgerHistory(world, repo)), applied: false, commit: null };

  return withWorkerLock(() => {
    const rows = computeRepair(ledgerHistory(world, repo));
    if (!rows.some((r) => r.changed)) return { rows, applied: false, commit: null };

    const rel = ledgerRel(world);
    const defaultRef = git.defaultBranch(repo);
    const commit = commitOnDefault(world, repo, defaultRef, "chore(ledger): repair promoted_at from history", (tree) => {
      const ledger = loadLedgerFile(join(tree, rel));
      saveLedger(join(tree, rel), applyRepair(ledger, rows));
      return [rel];
    });
    return { rows, applied: true, commit };
  });
}
