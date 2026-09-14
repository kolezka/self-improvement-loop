// Public surface of @sil/nudges. Re-exports the split implementation
// (gates.ts, lint.ts, firelog.ts, dispatch.ts, gate-runner.ts) under the
// exact names the contract stub declared, plus additions used by apps/hook
// and the curriculum drafter.

export type { Gate, Nudge, DispatchOptions, LoadedNudges, RejectedNudge } from "./dispatch.ts";
export { dispatch, loadNudges, loadNudgesDetailed } from "./dispatch.ts";

export {
  MAX_MATCH_LEN,
  MAX_PATTERN_LEN,
  MAX_QUANTIFIED_GROUPS,
  EVENTS,
  LOW_FREQUENCY_EVENTS,
  PREDICATES,
  splitTrigger,
  evaluate,
  validateGate,
  gateTruth,
  isUnsafeRegex,
  unsafeRegexReason,
  hasNestedQuantifier,
} from "./gates.ts";

export { MAX_TEXT, unboundedBroadcastRule, lintNudge } from "./lint.ts";

export type { FireRecord } from "./firelog.ts";
export {
  ROTATE_AT_BYTES,
  ROTATE_KEEP_LINES,
  withDirLock,
  appendLine,
  claimMarker,
  writeBreadcrumb,
  readFires,
} from "./firelog.ts";

export type { GateCorpusResult } from "./gate-runner.ts";
export { runGateCorpus } from "./gate-runner.ts";
