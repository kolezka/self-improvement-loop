// Nudge loading and dispatch, ported from packages/nudges/src/dispatch.ts and
// handlers.ts's dispatchNudge. The decisions are the same pure dispatchWith the
// command hook runs; only the sink differs: a fire and a breadcrumb go to the
// spool, and the once-per-session marker is an in-memory set backed by the same
// marker files firelog writes.
//
// The directories are read once per session, not once per event. The command
// hook pays a fresh readdir per invocation because it is a fresh process; this
// one is not, and a PreToolUse that re-read the nudge dir on every tool call
// would give back most of what the module exists to save.

import { posixJoin } from "@sil/core/layout";
import { dispatchWith, lintLoadedNudges } from "@sil/nudges/dispatch-core";
import type { DispatchSink } from "@sil/nudges/dispatch-core";
import type { EngineInterface } from "claude-code";
import { listDirIfPresent, readText } from "./io.ts";
import { claimMarker, flushMarkers, nowIso, precomputeMarkers, spoolAppend } from "./state.ts";
import type { SessionState } from "./state.ts";

// The events the module handles, for the breadcrumb marker names that carry the
// event in their dedupe key.
const HANDLED_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"];
// The breadcrumb kinds dispatchWith raises on its own, one marker per kind and
// event. nudge_invalid is not here: it dedupes per file instead.
const BREADCRUMB_KINDS = ["nudge_dir_missing", "gate_overrun", "gate_budget_exhausted"];

async function loadNudges($: EngineInterface, state: SessionState): Promise<void> {
  if (state.nudges !== null) return;

  const worldDir = state.world.nudges_dir;
  const dirs = typeof worldDir === "string" && worldDir.trim() ? [worldDir] : [];
  dirs.push(`${state.pluginRoot}/nudges`);

  const files: Array<{ file: string; raw: unknown }> = [];
  let anyDir = false;
  for (const dir of dirs) {
    const entries = await listDirIfPresent($, dir);
    if (entries === null) continue;
    anyDir = true;
    const names = entries
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of names) {
      const file = posixJoin(dir, name);
      const text = await readText($, file);
      let raw: unknown = null;
      if (text !== null) {
        try {
          raw = JSON.parse(text);
        } catch {
          // same as readJsonOr(file, null): an unreadable file is a rejection
        }
      }
      files.push({ file, raw });
    }
  }

  const loaded = lintLoadedNudges(files);
  state.nudges = loaded.nudges;
  state.rejected = loaded.rejected;
  state.nudgeDirsMissing = !anyDir;

  const markerNames: string[] = [];
  for (const nudge of loaded.nudges) markerNames.push(`nudge-${nudge.pattern}`);
  for (const rejected of loaded.rejected) markerNames.push(`breadcrumb-nudge_invalid-${rejected.file}`);
  for (const kind of BREADCRUMB_KINDS) {
    for (const event of HANDLED_EVENTS) markerNames.push(`breadcrumb-${kind}-${event}`);
  }
  await precomputeMarkers(state, markerNames);
}

/** Same record, same dedupe key and same field order as firelog's
 * writeBreadcrumb, so the line on disk is unchanged. */
function breadcrumb(
  state: SessionState,
  kind: string,
  event: string,
  extra: Record<string, unknown>,
  dedupeKey?: string,
): void {
  if (!claimMarker(state, `breadcrumb-${dedupeKey ?? `${kind}-${event}`}`)) return;
  spoolAppend(
    state,
    { kind: "nudge-fires" },
    JSON.stringify({ ts: nowIso(), kind, session_id: state.sessionId, event, ...extra }),
  );
}

/** Fire at most one nudge for `payload` and return its text, or "". */
export async function dispatchNudges(
  $: EngineInterface,
  state: SessionState,
  payload: Record<string, unknown>,
): Promise<string> {
  await loadNudges($, state);
  const event = typeof payload["hook_event_name"] === "string" ? payload["hook_event_name"] : "";

  if (state.nudgeDirsMissing) breadcrumb(state, "nudge_dir_missing", event, {});
  // One breadcrumb per rejected file per session: a hand-placed nudge that lint
  // refuses is never evaluated, and silence about it is how a nudge appears to
  // be installed but never fires.
  for (const rejected of state.rejected) {
    breadcrumb(
      state,
      "nudge_invalid",
      event,
      { file: rejected.file, problems: rejected.problems.slice(0, 3) },
      `nudge_invalid-${rejected.file}`,
    );
  }

  const sink: DispatchSink = {
    claimMarker: (name) => claimMarker(state, name),
    fire: (record) => spoolAppend(state, { kind: "nudge-fires" }, JSON.stringify(record)),
    breadcrumb: (record) => spoolAppend(state, { kind: "nudge-fires" }, JSON.stringify(record)),
  };
  const text = dispatchWith(payload, state.nudges ?? [], sink) ?? "";
  await flushMarkers($, state);
  return text;
}
