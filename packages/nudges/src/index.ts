// Contract stub: replaced by the port. Signatures are the interface other packages code against.
const notImplemented = (name: string): never => { throw new Error(`${name} is not implemented yet`); };

import type { HookEvent } from "@sil/core";

export type Gate = Record<string, unknown>;
export interface Nudge { pattern: string; event: string; matcher?: string; gate: Gate; once_per: "session" | "always"; text: string }
export interface DispatchOptions { sessionDir: string; fireLog: string; budgetMs?: number; gateTimeoutMs?: number }
export interface FireRecord { ts: string; pattern?: string; session_id: string; event: string; kind?: string }

export const MAX_TEXT = 400;
export const MAX_MATCH_LEN = 4000;
export const EVENTS: Record<string, ReadonlySet<string> | null> = {
  SessionStart: null,
  UserPromptSubmit: null,
  PreToolUse: new Set(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent", "Skill"]),
  PostToolUse: new Set(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent", "Skill"]),
};
export const LOW_FREQUENCY_EVENTS: ReadonlySet<string> = new Set(["SessionStart"]);
export const PREDICATES: ReadonlySet<string> = new Set(["always", "tool_is", "command_matches", "file_path_matches", "prompt_matches", "all", "any", "not"]);

export function splitTrigger(_trigger: string): [HookEvent, string | null] | null { return notImplemented("splitTrigger"); }
export function evaluate(_gate: unknown, _payload: Record<string, unknown>): boolean { return notImplemented("evaluate"); }
export function validateGate(_gate: unknown): string[] { return notImplemented("validateGate"); }
export function gateTruth(_gate: unknown): boolean | null { return notImplemented("gateTruth"); }
export function unboundedBroadcastRule(): string { return notImplemented("unboundedBroadcastRule"); }
export function lintNudge(_obj: unknown): string[] { return notImplemented("lintNudge"); }
export function loadNudges(_dirs: string[]): Nudge[] { return notImplemented("loadNudges"); }
export function dispatch(_payload: Record<string, unknown>, _nudges: Nudge[], _opts: DispatchOptions): string | null { return notImplemented("dispatch"); }
export function writeBreadcrumb(_fireLog: string, _sessionDir: string, _kind: string, _sessionId: string, _event: string, _extra?: Record<string, unknown>): void { notImplemented("writeBreadcrumb"); }
export function readFires(_path: string): FireRecord[] { return notImplemented("readFires"); }
