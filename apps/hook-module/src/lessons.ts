// Inbox lesson delivery, the rules block and the rule-use events, ported from
// apps/hook/src/lessons.ts and handlers.ts's recordRuleUses onto the engine's
// filesystem. The selection itself is the same pure @sil/core/lessons the
// command hook uses, so both paths choose the same lessons.
//
// The sandbox cannot append, so "mark delivered" and "archive" become a spool
// append and a spool move that the Stop command hook applies.

import { posixBasename, posixJoin } from "@sil/core/layout";
import { formatLesson, LESSON_ARCHIVE_AT_DELIVERIES, rulesBlockFrom, selectLessons } from "@sil/core/lessons";
import type { LessonCandidate } from "@sil/core/lessons";
import type { EngineInterface } from "claude-code";
import { listDirIfPresent, readText, readTextIfPresent, statPath, statPathIfPresent, writeText } from "./io.ts";
import { claimMarker, cwdUnderRepo, flushMarkers, nowIso, precomputeMarkers, spoolAppend, spoolMove } from "./state.ts";
import type { SessionState } from "./state.ts";

// The rules block is a handful of lines. Anything larger is not a rules file,
// and reading it on the hook's hot path is time we cannot afford.
const MAX_RULES_BYTES = 256 * 1024;

// The tag the curriculum writes after a promoted rule line.
const RULE_TAG_RE = /<!--\s*rule:([A-Za-z0-9._-]+)\s*-->/g;

/** The text between the managed-block markers in the world's rules file, or ""
 * when injection is off, the file is missing, or the markers are absent. Read
 * only when the stat says a regular file under the cap: pointed at /dev/zero,
 * an unbounded read hangs the hook. */
export async function rulesBlock($: EngineInterface, state: SessionState): Promise<string> {
  if (state.world.rules_inject === false) return "";
  const rulesFile = state.world.rules_file;
  if (!rulesFile) return "";
  const st = await statPathIfPresent($, rulesFile);
  if (!st || st.kind !== "file" || st.size > MAX_RULES_BYTES) return "";
  const text = await readText($, rulesFile);
  if (text === null) return "";
  return rulesBlockFrom(text);
}

/** One usage event per rule the injected block carried. The injection is the
 * use: without this every rule sits at uses_30d 0 forever. Claimed once per
 * session because SessionStart runs again on resume and on compact.
 *
 * The markers are written here, not left for the next dispatch: a resume runs
 * in a new process, and a claim that never reached disk counts every rule a
 * second time. Any claim made outside dispatchNudges needs the same flush. */
export async function recordRuleUses($: EngineInterface, state: SessionState, rulesText: string): Promise<void> {
  const slugs = [...new Set([...rulesText.matchAll(RULE_TAG_RE)].map((m) => m[1] ?? ""))].filter((s) => s);
  if (slugs.length === 0) return;
  await precomputeMarkers(state, slugs.map((s) => `rule-use-${s}`));
  for (const slug of slugs) {
    if (!claimMarker(state, `rule-use-${slug}`)) continue;
    spoolAppend(
      state,
      { kind: "usage-events" },
      JSON.stringify({
        ts: nowIso(),
        session_id: state.sessionId,
        world: state.worldName,
        kind: "rule",
        ref: `rule:${slug}`,
        detail: {},
      }),
    );
  }
  await flushMarkers($, state);
}

/** Cutoff for "arrived since session start": start.json's own mtime, written
 * once at SessionStart and never touched again. Falls back to the session
 * dir's mtime, then to null, which delivers nothing. */
export async function sessionStartMtime($: EngineInterface, state: SessionState): Promise<number | null> {
  if (state.startMtimeMs !== null) return state.startMtimeMs;
  const start = await statPathIfPresent($, `${state.sessionDir}/start.json`);
  if (start) {
    state.startMtimeMs = start.mtimeMs;
    return start.mtimeMs;
  }
  // Not cached: the session dir's mtime moves as files land in it.
  const dir = await statPathIfPresent($, state.sessionDir);
  return dir ? dir.mtimeMs : null;
}

/** Undelivered inbox lessons for this session, newest first, filtered to a repo
 * that owns cwd. Marks the chosen ones delivered and bumps their delivery
 * count, both through the spool. */
export async function deliverLessons(
  $: EngineInterface,
  state: SessionState,
  limit: number,
  minMtime: number | null,
): Promise<string[]> {
  const inbox = state.layout.inboxDir(state.worldName);
  const entries = await listDirIfPresent($, inbox);
  if (entries === null) return [];
  const names = entries
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".json"))
    .sort();

  const already = new Set<string>(state.delivered);
  const deliveredText = await readTextIfPresent($, `${state.sessionDir}/delivered`);
  if (deliveredText !== null) {
    for (const line of deliveredText.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) already.add(trimmed);
    }
  }

  const candidates: LessonCandidate[] = [];
  for (const name of names) {
    const stem = name.slice(0, -".json".length);
    if (already.has(stem)) continue;
    const path = posixJoin(inbox, name);
    let mtimeMs = 0;
    if (minMtime !== null) {
      const st = await statPath($, path);
      if (!st) continue;
      mtimeMs = st.mtimeMs;
      if (mtimeMs < minMtime) continue;
    }
    const body = await readText($, path);
    let raw: unknown;
    if (body !== null) {
      try {
        raw = JSON.parse(body);
      } catch {
        // an unparseable lesson is skipped by selectLessons, not fatal here
      }
    }
    candidates.push({ path, stem, mtimeMs, raw });
  }

  const chosen = selectLessons(candidates, already, (repo) => cwdUnderRepo(state, repo), limit, minMtime);

  for (const { obj, path } of chosen) {
    state.delivered.add(String(obj["id"]));
    spoolAppend(state, { kind: "session-file", name: "delivered" }, String(obj["id"]));
    const deliveries = (typeof obj["deliveries"] === "number" ? obj["deliveries"] : 0) + 1;
    obj["deliveries"] = deliveries;
    await writeText($, path, `${JSON.stringify(obj, null, 2)}\n`);
    if (deliveries >= LESSON_ARCHIVE_AT_DELIVERIES) {
      spoolMove(state, path, posixJoin(inbox, "archive", posixBasename(path)));
    }
  }

  return chosen.map((c) => formatLesson(c.obj));
}
