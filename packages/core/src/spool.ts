// The module-spool wire format: what apps/hook-module buffers in its sandbox
// (no Node, no append) and hands to the Stop/SessionEnd command hook to apply.
// Pure and dependency free: the hooks module bundle is checked for forbidden
// imports, and this file has to be safe to include on either side of that
// check.

export const SPOOL_VERSION = 1;
export const SPOOL_FILE_NAME = "module-spool.json";

export type SpoolTarget =
  | { kind: "usage-events" }
  | { kind: "hook-runs" }
  | { kind: "nudge-fires" }
  | { kind: "payload-samples"; world: string }
  | { kind: "session-file"; name: string };

export interface SpoolAppend {
  target: SpoolTarget;
  line: string;
}

export interface SpoolMove {
  from: string;
  to: string;
}

export interface Spool {
  version: 1;
  session_id: string;
  written_at: string;
  appends: SpoolAppend[];
  moves: SpoolMove[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseTarget(v: unknown): SpoolTarget | null {
  if (!isRecord(v)) return null;
  const kind = v["kind"];
  if (kind === "usage-events" || kind === "hook-runs" || kind === "nudge-fires") return { kind };
  if (kind === "payload-samples") {
    const world = v["world"];
    return typeof world === "string" && world ? { kind, world } : null;
  }
  if (kind === "session-file") {
    const name = v["name"];
    return typeof name === "string" && name ? { kind, name } : null;
  }
  return null;
}

function parseAppend(v: unknown): SpoolAppend | null {
  if (!isRecord(v)) return null;
  const target = parseTarget(v["target"]);
  const line = v["line"];
  if (!target || typeof line !== "string") return null;
  return { target, line };
}

function parseMove(v: unknown): SpoolMove | null {
  if (!isRecord(v)) return null;
  const from = v["from"];
  const to = v["to"];
  if (typeof from !== "string" || !from || typeof to !== "string" || !to) return null;
  return { from, to };
}

/** Parses a spool file's text. Null on anything that makes the whole spool
 * unusable (bad JSON, wrong shape, wrong version, bad session_id, appends or
 * moves not arrays). Individual malformed entries inside otherwise-valid
 * arrays are dropped rather than failing the whole spool: one bad line from a
 * buggy module build should not strand every other line behind it. */
export function parseSpool(text: string): Spool | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed["version"] !== SPOOL_VERSION) return null;

  const sessionId = parsed["session_id"];
  if (typeof sessionId !== "string" || !sessionId) return null;

  const rawAppends = parsed["appends"];
  const rawMoves = parsed["moves"];
  if (!Array.isArray(rawAppends) || !Array.isArray(rawMoves)) return null;

  const appends: SpoolAppend[] = [];
  for (const a of rawAppends) {
    const parsedAppend = parseAppend(a);
    if (parsedAppend) appends.push(parsedAppend);
  }
  const moves: SpoolMove[] = [];
  for (const m of rawMoves) {
    const parsedMove = parseMove(m);
    if (parsedMove) moves.push(parsedMove);
  }

  const writtenAt = typeof parsed["written_at"] === "string" ? parsed["written_at"] : "";
  return { version: SPOOL_VERSION, session_id: sessionId, written_at: writtenAt, appends, moves };
}

export function serializeSpool(spool: Spool): string {
  return `${JSON.stringify(spool)}\n`;
}
