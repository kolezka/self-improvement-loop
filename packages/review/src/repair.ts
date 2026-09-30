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

/** UTC ISO, or null when `x` is not a readable date. A malformed historic
 * timestamp must not abort the whole repair. */
function normalizeDate(x: string | null | undefined): string | null {
  if (!x) return null;
  const t = new Date(x);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** Date of a span's first promoted snapshot. promoted_at is right on that
 * first snapshot even under the old bug, which only reset it on later accepts. */
function startDate(row: PromotionEntry, snapDate: string): string | null {
  return normalizeDate(row.promoted_at) ?? normalizeDate(snapDate);
}

/** Date a later version went live: the row's own revised_at when it has one
 * (post-fix), else its promoted_at (pre-fix accepts reset it to the accept
 * time), else the commit date. */
function versionDate(row: PromotionEntry, snapDate: string): string | null {
  return normalizeDate(row.revised_at) ?? normalizeDate(row.promoted_at) ?? normalizeDate(snapDate);
}

interface Span {
  start: string | null;
  /** Each version's date, oldest first. */
  versions: Array<string | null>;
  /** Content of the newest version, null until one could be read. */
  last: string | null;
}

/** Recompute promoted_at, revised_at and revisions for every pattern in the
 * final snapshot's ledger, from the full history of ledger snapshots.
 *
 * A span is the run of "promoted" snapshots since the last "retired" one. A
 * new version is a readable content that differs from the one before it, so
 * a revert to an earlier text still counts. This relies on `ledgerHistory`
 * walking only the default line: stale side snapshots never reach here. A
 * snapshot whose content could not be read counts toward the span start only.
 *
 * promoted_at is the span start; revised_at is the date of the newest version
 * (promoted_at when there is only one); revisions is the number of versions
 * minus one. A retired row uses the span that ended at its retirement. */
export function computeRepair(snapshots: readonly LedgerSnapshot[]): RepairedRow[] {
  if (snapshots.length === 0) return [];

  const live = snapshots[snapshots.length - 1]!.ledger;
  const out: RepairedRow[] = [];
  for (const pattern of Object.keys(live.entries).sort()) {
    const current = live.entries[pattern]!;

    let span: Span | null = null;
    let lastClosed: Span | null = null;

    for (const snap of snapshots) {
      if (!Object.hasOwn(snap.ledger.entries, pattern)) continue;
      const row = snap.ledger.entries[pattern]!;
      if (row.status === "retired") {
        if (span) lastClosed = span;
        span = null;
        continue;
      }
      if (row.status !== "promoted") continue;
      if (!span) span = { start: startDate(row, snap.date), versions: [], last: null };
      if (!Object.hasOwn(snap.content, pattern)) continue;
      const content = snap.content[pattern]!;
      if (span.versions.length === 0) {
        span.versions.push(span.start);
        span.last = content;
      } else if (content !== span.last) {
        span.versions.push(versionDate(row, snap.date));
        span.last = content;
      }
    }

    const chosen = current.status === "retired" ? lastClosed : span;

    let repairedPromotedAt = current.promoted_at;
    let repairedRevisedAt = current.revised_at;
    let repairedRevisions = current.revisions;
    if (chosen && chosen.start) {
      repairedPromotedAt = chosen.start;
      if (chosen.versions.length > 1) {
        repairedRevisions = chosen.versions.length - 1;
        repairedRevisedAt = chosen.versions[chosen.versions.length - 1] ?? chosen.start;
      } else {
        // One visible version says nothing about redrafts before the history
        // starts (a shallow or imported repo), so a post-fix row keeps its own.
        const own = normalizeDate(current.revised_at);
        repairedRevisedAt = own ?? chosen.start;
        repairedRevisions = own ? current.revisions : 0;
      }
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

/** Pattern content out of a file's text, or null when the pattern has no
 * content there. For a rule only its own tagged bullet counts, never the whole
 * shared file; a rules file without that bullet is missing, not empty. */
function contentOf(text: string, row: PromotionEntry, pattern: string): string | null {
  if (servedType(row) !== "rule") return text;
  const bullet = artifacts.ruleBulletInText(text, pattern);
  return bullet ? artifacts.stripRuleTag(bullet, pattern) : null;
}

/** Blob ids of `paths` at `sha`, one subprocess for all of them. */
function blobIds(repo: string, sha: string, paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const listing = git.git(repo, ["ls-tree", "-r", "-z", sha, "--", ...paths], { check: false });
  for (const entry of listing.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const oid = entry.slice(0, tab).split(" ")[2];
    if (oid) out.set(entry.slice(tab + 1), oid);
  }
  return out;
}

/** Commits of the default branch's own line, oldest first.
 *
 * Neither `--first-parent` nor a plain log is right here. An accept of a stale
 * branch merges the default branch into it and commits the merge as
 * `... (reviewed)`, first parent the branch, second parent the old default
 * tip; that line continues through the second parent. Any other merge keeps
 * the default line on its first parent, so a side branch's stale ledger never
 * gets read. */
/** The exact subject acceptInner commits with; a looser match would let a
 * hand-made merge steer the walk. */
const ACCEPT_SUBJECT = /^feat\([a-z]+\): (retire )?[a-z0-9][a-z0-9-]* \(reviewed\)$/;

function defaultLine(repo: string, defaultRef: string): Array<{ sha: string; date: string }> {
  const log = git.git(repo, ["log", "--format=%H%x09%P%x09%aI%x09%s", defaultRef], { check: false });
  const commits = new Map<string, { parents: string[]; date: string; subject: string }>();
  for (const line of log.split("\n")) {
    const [sha, parents, date, ...rest] = line.split("\t");
    if (!sha || date === undefined) continue;
    commits.set(sha, { parents: parents ? parents.split(" ") : [], date, subject: rest.join("\t") });
  }
  const out: Array<{ sha: string; date: string }> = [];
  let sha = git.git(repo, ["rev-parse", defaultRef], { check: false });
  const seen = new Set<string>();
  while (sha && commits.has(sha) && !seen.has(sha)) {
    seen.add(sha);
    const c = commits.get(sha)!;
    out.push({ sha, date: c.date });
    const acceptMerge = c.parents.length > 1 && ACCEPT_SUBJECT.test(c.subject);
    sha = (acceptMerge ? c.parents[1] : c.parents[0]) ?? "";
  }
  return out.reverse();
}

/** Ledger snapshots along the default branch's own line, oldest first, one per
 * change of the ledger blob.
 *
 * Content is read per blob id and cached: one `ls-tree` per line commit, plus
 * one read per distinct ledger or artifact blob. A missing path or unreadable
 * blob leaves the pattern out of `content` for that snapshot. A commit whose
 * ledger fails to parse is skipped, not fatal. */
export function ledgerHistory(world: World, repo: string): LedgerSnapshot[] {
  const rel = ledgerRel(world);
  const defaultRef = git.defaultBranch(repo);
  const blobs = new Map<string, string | null>();
  const readBlob = (oid: string): string | null => {
    if (!blobs.has(oid)) {
      // Raw read: git.git trims, and a trailing newline can be a redraft.
      const res = git.gitRaw(repo, ["cat-file", "blob", oid]);
      blobs.set(oid, res.code === 0 ? res.stdout : null);
    }
    return blobs.get(oid) ?? null;
  };

  const out: LedgerSnapshot[] = [];
  let lastLedgerOid: string | null = null;
  for (const { sha, date } of defaultLine(repo, defaultRef)) {
    const ledgerOid = blobIds(repo, sha, [rel]).get(rel) ?? null;
    if (ledgerOid === null || ledgerOid === lastLedgerOid) continue;
    lastLedgerOid = ledgerOid;
    const text = readBlob(ledgerOid);
    if (text === null) continue;
    let ledger: Ledger;
    try {
      ledger = parseLedger(text, sha);
    } catch {
      continue;
    }
    const promoted: Array<[string, PromotionEntry, string]> = [];
    for (const [pattern, row] of Object.entries(ledger.entries)) {
      const path = row.served_by?.path;
      if (row.status === "promoted" && path) promoted.push([pattern, row, path]);
    }
    const ids = blobIds(repo, sha, [...new Set(promoted.map(([, , path]) => path))]);
    const content: Record<string, string> = {};
    for (const [pattern, row, path] of promoted) {
      const oid = ids.get(path);
      const file = oid ? readBlob(oid) : null;
      if (file === null) continue;
      const value = contentOf(file, row, pattern);
      if (value !== null) content[pattern] = value;
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
