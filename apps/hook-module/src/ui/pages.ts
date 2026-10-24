// The page values `console.page` and `console.proposalPage` answer, checked on
// arrival: they crossed a process boundary as JSON. Pure, so state.ts and
// views.ts share one reading of them. The host shapes live in
// packages/ops/src/handlers/console.ts.

import { utf8ByteLength } from "@sil/core/control-protocol";

/** Mirrors the host's PROPOSAL_PAGE_MAX_BYTES: a page's text is under it. */
export const PROPOSAL_PAGE_MAX_BYTES = 65536;
export const PROPOSAL_PAGE_MAX_LINES = 200;
export const REVIEWED_STATE_RE = /^[0-9a-f]{64}$/;

export type ProposalPart = "body" | "diff";

export interface ListPage {
  world: string;
  total: number;
  offset: number;
  limit: number;
  items: unknown[];
}

export interface ProposalPage {
  world: string;
  pattern: string;
  part: ProposalPart;
  text: string;
  offset: number;
  lineCount: number;
  nextOffset: number | null;
  totalLines: number;
  totalBytes: number;
  reviewedState: string;
  complete: boolean;
  oversizedLine: { line: number; bytes: number } | null;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const LIST_KEYS = ["world", "total", "offset", "limit", "items"] as const;

/** A list page for `world`, or null when it is anything else. */
export function parseListPage(value: unknown, world: string): ListPage | null {
  if (!isPlainObject(value) || !hasExactKeys(value, LIST_KEYS)) return null;
  const { total, offset, limit, items } = value;
  if (value.world !== world || !isCount(total) || !isCount(offset) || !isCount(limit) || limit < 1) return null;
  if (!Array.isArray(items) || items.length > limit) return null;
  if (items.length !== Math.max(0, Math.min(limit, total - offset))) return null;
  return { world, total, offset, limit, items };
}

const PAGE_KEYS = [
  "world",
  "pattern",
  "part",
  "text",
  "offset",
  "lineCount",
  "nextOffset",
  "totalLines",
  "totalBytes",
  "reviewedState",
  "complete",
  "oversizedLine",
] as const;

export interface ProposalScope {
  world: string;
  pattern: string;
  part: ProposalPart;
  offset: number;
}

/** A proposal page for exactly `scope`, whole and consistent, or null. A
 * page whose text could be cut by the engine is refused here too, whatever
 * the host claims. */
export function parseProposalPage(value: unknown, scope: ProposalScope): ProposalPage | null {
  if (!isPlainObject(value) || !hasExactKeys(value, PAGE_KEYS)) return null;
  const v = value;
  if (v.world !== scope.world || v.pattern !== scope.pattern || v.part !== scope.part || v.offset !== scope.offset) return null;
  if (typeof v.text !== "string" || typeof v.reviewedState !== "string" || !REVIEWED_STATE_RE.test(v.reviewedState)) return null;
  if (typeof v.complete !== "boolean") return null;
  if (!isCount(v.lineCount) || !isCount(v.totalLines) || !isCount(v.totalBytes)) return null;
  if (v.lineCount > PROPOSAL_PAGE_MAX_LINES || scope.offset + v.lineCount > v.totalLines) return null;
  if (utf8ByteLength(v.text) >= PROPOSAL_PAGE_MAX_BYTES) return null;
  const next = v.nextOffset;
  if (next !== null && (!isCount(next) || next <= scope.offset || next > v.totalLines)) return null;
  let oversized: { line: number; bytes: number } | null = null;
  if (v.oversizedLine !== null) {
    const o = v.oversizedLine;
    if (!isPlainObject(o) || !hasExactKeys(o, ["line", "bytes"]) || !isCount(o.line) || !isCount(o.bytes)) return null;
    if (o.line !== scope.offset + 1 || v.text !== "" || v.lineCount !== 0 || v.complete) return null;
    oversized = { line: o.line, bytes: o.bytes };
  } else if (next !== null && next !== scope.offset + v.lineCount) {
    return null;
  }
  // The end is only claimed by a page that reaches it with nothing left out.
  if (v.complete && (next !== null || scope.offset + v.lineCount !== v.totalLines)) return null;
  return {
    world: scope.world,
    pattern: scope.pattern,
    part: scope.part,
    text: v.text,
    offset: scope.offset,
    lineCount: v.lineCount,
    nextOffset: next,
    totalLines: v.totalLines,
    totalBytes: v.totalBytes,
    reviewedState: v.reviewedState,
    complete: v.complete,
    oversizedLine: oversized,
  };
}
