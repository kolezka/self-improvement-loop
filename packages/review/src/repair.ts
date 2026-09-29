// Repair promoted_at, revised_at and revisions from the ledger file's own git
// history, for rows the accept bug (fixed alongside this file) corrupted by
// resetting promoted_at on every accepted redraft.
//
// The walk is a thin wrapper: it turns the ledger path's commit history into a
// list of (sha, author date, parsed ledger, artifact content) snapshots.
// `computeRepair` is the pure function over that list, so the repair logic is
// testable against a synthetic history with no git or filesystem involved.
//
// Version identity is the pattern's own artifact content, never the ledger
// `commit` field (auto-merge always writes `commit: null`, see run.ts) and
// never `promoted_at` read back off the live row (a pre-fix redraft resets it
// on every accept). A new version is the first promoted snapshot in the
// current promotion span whose content differs from the version before it.

import { join } from "node:path";
import { type Config, type Ledger, type PromotionEntry, servedType, targetRoot, type World } from "@sil/core";
import { artifacts, git } from "@sil/curriculum";
import { loadLedger as loadLedgerFile, parseLedger, saveLedger } from "@sil/store";
import { commitOnDefault, withWorkerLock } from "./index.ts";
import { ledgerRel } from "./snapshot.ts";

export interface LedgerSnapshot {
  sha: string;
  /** Commit author date, ISO with whatever offset git reported. Normalised to
   * UTC before it is ever compared or shown; used only when a row carries no
   * usable date of its own. */
  date: string;
  ledger: Ledger;
  /** This pattern's own artifact content at this commit, for every row that
   * reads "promoted" here. Read once during the git walk so `computeRepair`
   * stays pure and testable against synthetic content. */
  content: Record<string, string>;
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

function normalizeDate(x: string): string {
  return new Date(x).toISOString();
}

/** The date a version boundary is stamped with: whatever date the row itself
 * already carries (post-fix `revised_at`, or `promoted_at` on a pre-fix row
 * or a span's first version, where it equals this snapshot's own date rather
 * than a later reset), falling back to the commit's own author date only for
 * a row that predates both fields. */
function versionDate(row: PromotionEntry, snapDate: string): string {
  return normalizeDate(row.revised_at ?? row.promoted_at ?? snapDate);
}

/** Recompute promoted_at, revised_at and revisions for every pattern in the
 * final snapshot's ledger, from the full history of ledger snapshots.
 *
 * For each pattern, walk the snapshots oldest to newest, tracking the current
 * promotion span (the run of "promoted" snapshots since the last "retired"
 * one, if any). Within a span, a new version starts whenever a promoted
 * snapshot's own artifact content differs from the span's current version; a
 * repeat of the same content (a reject of a refine, or an unrelated commit
 * that happens to touch the shared ledger file) is not a new version.
 *
 * promoted_at is the date of the span's first version; revised_at is the date
 * of its latest version (equal to promoted_at when there is only one);
 * revisions is the version count minus one. A currently "promoted" row uses
 * the span still open; a currently "retired" row uses the span that just
 * closed, so a retirement never loses the history of what it retired. A row
 * that was never promoted, or is retired with no promotion span behind it,
 * needs no repair. */
export function computeRepair(snapshots: readonly LedgerSnapshot[]): RepairedRow[] {
  if (snapshots.length === 0) return [];

  const live = snapshots[snapshots.length - 1]!.ledger;
  const out: RepairedRow[] = [];
  for (const pattern of Object.keys(live.entries).sort()) {
    const current = live.entries[pattern]!;

    let versions: string[] = [];
    let lastClosedSpan: string[] = [];
    let currentContent: string | null = null;

    for (const snap of snapshots) {
      const row = snap.ledger.entries[pattern];
      if (!row) continue;
      if (row.status === "retired") {
        if (versions.length > 0) lastClosedSpan = versions;
        versions = [];
        currentContent = null;
        continue;
      }
      if (row.status !== "promoted") continue;
      const content = snap.content[pattern] ?? "";
      if (versions.length === 0 || content !== currentContent) {
        versions.push(versionDate(row, snap.date));
        currentContent = content;
      }
    }

    const span = current.status === "retired" ? lastClosedSpan : versions;

    let repairedPromotedAt = current.promoted_at;
    let repairedRevisedAt = current.revised_at;
    let repairedRevisions = current.revisions;
    if (span.length > 0) {
      repairedPromotedAt = span[0]!;
      repairedRevisedAt = span.length > 1 ? span[span.length - 1]! : span[0]!;
      repairedRevisions = span.length - 1;
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

/** This pattern's artifact content at `sha`, or "" when it cannot be read.
 *
 * `served_by.path` is the row's own record of where its text lived at that
 * commit, read straight rather than recomputed from the world's current
 * layout: a re-homed or migrated pattern's own history is the one thing that
 * can name its path honestly. For a rule, only the pattern's own tagged
 * bullet counts, never the whole shared file every pattern's rule lives in. */
function artifactContentAt(repo: string, sha: string, row: PromotionEntry, pattern: string): string {
  const path = row.served_by?.path;
  if (!path) return "";
  const { found, text } = git.show(repo, sha, path);
  if (!found) return "";
  return servedType(row) === "rule" ? artifacts.stripRuleTag(artifacts.ruleBulletInText(text, pattern), pattern) : text;
}

/** The ledger file's own commit history on the default branch, oldest first.
 *
 * `--first-parent` on the default branch only: a curriculum tick's own
 * commits are always fast-forwarded in, but the world's repo can carry other
 * branches merged in with a real merge commit, and plain `git log` walks
 * those in too, interleaved by date with the real history. A pattern's ledger
 * row read off such a side commit can show stale content or a stale status
 * that never actually happened on the branch anyone is repairing from.
 *
 * A commit whose ledger blob fails to parse is skipped, not fatal: history a
 * human already lived with should not block reading the rest of it. */
export function ledgerHistory(world: World, repo: string): LedgerSnapshot[] {
  const rel = ledgerRel(world);
  const defaultRef = git.defaultBranch(repo);
  const log = git.git(repo, ["log", "--first-parent", "--reverse", "--format=%H%x09%aI", defaultRef, "--", rel], { check: false });
  if (!log) return [];
  const out: LedgerSnapshot[] = [];
  for (const line of log.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const sha = line.slice(0, tab);
    const date = line.slice(tab + 1);
    const { found, text } = git.show(repo, sha, rel);
    if (!found) continue;
    let ledger: Ledger;
    try {
      ledger = parseLedger(text, sha);
    } catch {
      continue;
    }
    const content: Record<string, string> = {};
    for (const [pattern, row] of Object.entries(ledger.entries)) {
      if (row.status !== "promoted") continue;
      content[pattern] = artifactContentAt(repo, sha, row, pattern);
    }
    out.push({ sha, date, ledger, content });
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
