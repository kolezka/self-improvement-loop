// Shared lesson curation contract: wire types, key encoding, byte limits and
// error codes. Native-safe: no node:, no Bun, no zod, so the console can
// import it. Host validation lives in the separate schema subpath.

import { WORLD_NAME_RE } from "./consts.ts";

export type LessonKey = { world: string; kind: "capture" | "inbox"; id: string };
export type ProjectScope = { kind: "project"; id: string } | { kind: "world" } | { kind: "unresolved" };
export type LessonScope = { world: string; project: ProjectScope };
export type StoreBinding = { kind: "location" | "installation"; id: string };
export type CaptureSource = {
  kind: "native_selection" | "explicit_quote";
  quote: string | null;
  reference: string | null;
  quoteRedacted: boolean;
  captureSessionId: string | null;
  sourceConversationId: string | null;
  sourceRowId: string | null;
  sourceAgentId: string | null;
};
export type CurationChange =
  | { kind: "capture"; text: string; source: CaptureSource }
  | { kind: "edit"; text: string }
  | { kind: "important"; value: boolean }
  | { kind: "acknowledge-source"; digest: string }
  | { kind: "purge"; confirmed: true };
export type CurationMutation = {
  requestId: string;
  binding: StoreBinding;
  scope: LessonScope;
  key: LessonKey;
  expectedRevision: number;
  change: CurationChange;
};
export type CurationReceipt =
  | { state: "unknown"; requestId: string }
  | {
      state: "committed";
      requestId: string;
      payloadHash: string;
      key: LessonKey;
      revision: number;
      changed: boolean;
      startedAt: string;
      finishedAt: string;
    }
  | { state: "purged"; requestId: string; key: LessonKey; startedAt: string; finishedAt: string };
export type SourceStatus = "saved" | "queued" | "archived" | "missing" | "changed" | "conflict" | "invalid" | "purged";
export interface LessonView {
  key: LessonKey;
  scope: LessonScope;
  revision: number;
  important: boolean;
  effectiveText: string | null;
  originalText: string | null;
  source: CaptureSource | null;
  sourceStatus: SourceStatus;
  sourceDigest: string | null;
  baselineDigest: string | null;
  relatedPattern: string | null;
  created: string;
  updated: string;
}
export interface CurationPage<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}
export interface CurationRevision {
  revision: number;
  kind: CurationChange["kind"];
  at: string;
  text: string | null;
  important: boolean | null;
  oldSourceDigest: string | null;
  newSourceDigest: string | null;
}
export interface CurationQuery {
  scope: LessonScope;
  collection: "saved" | "inbox" | "archived" | "all";
  important?: boolean;
  search?: string;
  cursor?: string;
  limit?: number;
}

export const MAX_TEXT_BYTES = 4000;
export const MAX_QUOTE_BYTES = 4000;
export const MAX_REFERENCE_BYTES = 1000;
export const MAX_MUTATION_BYTES = 16 * 1024;
// A key travels inside a mutation or a query, so its UTF-8 JSON triple can
// never exceed the envelope. Legacy ids get no tighter cap of their own.
export const MAX_KEY_JSON_BYTES = MAX_MUTATION_BYTES;
export const MAX_ENCODED_KEY_CHARS = Math.ceil(MAX_KEY_JSON_BYTES / 3) * 4;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CURATION_REQUEST_ID_RE = /^lc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
// Versioned digest of a canonical repository root.
export const PROJECT_ID_RE = /^p1_[0-9a-f]{64}$/;

export const CURATION_ERROR_CODES = [
  "CURATION_CONFLICT",
  "CAPTURE_EXISTS",
  "SOURCE_CONFLICT",
  "SCOPE_CONFLICT",
  "INSTALLATION_MISMATCH",
  "UNSUPPORTED_SCHEMA",
  "STORAGE_UNAVAILABLE",
  "STORAGE_BUSY",
  "SENSITIVE_CONTENT",
  "PURGED",
  "INVALID_INPUT",
] as const;
export type CurationErrorCode = (typeof CURATION_ERROR_CODES)[number];

const MESSAGES: Record<CurationErrorCode, string> = {
  CURATION_CONFLICT: "curation revision conflict",
  CAPTURE_EXISTS: "capture already exists",
  SOURCE_CONFLICT: "lesson source conflict",
  SCOPE_CONFLICT: "lesson scope conflict",
  INSTALLATION_MISMATCH: "different SIL installation",
  UNSUPPORTED_SCHEMA: "unsupported curation schema version",
  STORAGE_UNAVAILABLE: "curation storage unavailable",
  STORAGE_BUSY: "curation storage busy",
  SENSITIVE_CONTENT: "possible secret in curation field",
  PURGED: "lesson curation was purged",
  INVALID_INPUT: "invalid curation input",
};

/** Fixed message plus field names. Never carries input text or SQL values. */
export class CurationError extends Error {
  override name = "CurationError";
  readonly fields: string[];
  constructor(
    public readonly code: CurationErrorCode,
    fields: string[] = [],
  ) {
    super(fields.length > 0 ? `${MESSAGES[code]}: ${fields.join(", ")}` : MESSAGES[code]);
    this.fields = [...fields];
  }
}

/** UTF-8 length. A lone surrogate counts as U+FFFD (3 bytes), like TextEncoder. */
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < value.length && isLowSurrogate(value.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** True when the string has no lone surrogate. */
export function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (i + 1 < value.length && isLowSurrogate(value.charCodeAt(i + 1))) i++;
      else return false;
    } else if (isLowSurrogate(unit)) return false;
  }
  return true;
}

/** Non-empty after ignoring whitespace. Never used to rewrite the value. */
export function hasVisibleText(value: string): boolean {
  return value.trim().length > 0;
}


/** Field names (relative to the key) that break the key rules. */
export function lessonKeyProblems(key: LessonKey): string[] {
  const problems: string[] = [];
  // WORLD_NAME_RE bounds length in code points, the same domain as config.
  if (typeof key.world !== "string" || !WORLD_NAME_RE.test(key.world)) {
    problems.push("world");
  }
  if (key.kind === "capture") {
    if (typeof key.id !== "string" || !UUID_RE.test(key.id)) problems.push("id");
  } else if (key.kind === "inbox") {
    // Any string the Lesson schema accepts is opaque identity. JSON escapes
    // control and lone surrogate units, so the encoded key stays ASCII.
    if (typeof key.id !== "string") problems.push("id");
  } else {
    problems.push("kind");
  }
  return problems;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function utf8Encode(value: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    let cp = value.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < value.length && isLowSurrogate(value.charCodeAt(i + 1))) {
      cp = 0x10000 + ((cp - 0xd800) << 10) + (value.charCodeAt(i + 1) - 0xdc00);
      i++;
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

/** Strict UTF-8 decode. Returns null on any malformed sequence. */
function utf8Decode(bytes: number[]): string | null {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp: number;
    let need: number;
    let min: number;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i++;
      continue;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) [cp, need, min] = [b0 & 31, 1, 0x80];
    else if (b0 >= 0xe0 && b0 <= 0xef) [cp, need, min] = [b0 & 15, 2, 0x800];
    else if (b0 >= 0xf0 && b0 <= 0xf4) [cp, need, min] = [b0 & 7, 3, 0x10000];
    else return null;
    for (let k = 1; k <= need; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (b & 63);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

function base64UrlEncode(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL[b0 >> 2]!;
    out += B64URL[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 !== undefined) out += B64URL[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]!;
    if (b2 !== undefined) out += B64URL[b2 & 63]!;
  }
  return out;
}

function base64UrlDecode(value: string): number[] | null {
  if (value.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const n = B64URL.indexOf(char);
    if (n < 0) return null;
    buffer = (buffer << 6) | n;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

/** Canonical base64url of the UTF-8 JSON triple `[world, kind, id]`. */
export function encodeLessonKey(key: LessonKey): string {
  if (lessonKeyProblems(key).length > 0) throw new CurationError("INVALID_INPUT", ["key"]);
  const bytes = utf8Encode(JSON.stringify([key.world, key.kind, key.id]));
  if (bytes.length > MAX_KEY_JSON_BYTES) throw new CurationError("INVALID_INPUT", ["key"]);
  return base64UrlEncode(bytes);
}

/** Inverse of encodeLessonKey. Refuses any value that is not its exact output. */
export function decodeLessonKey(value: string): LessonKey {
  const invalid = () => new CurationError("INVALID_INPUT", ["key"]);
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENCODED_KEY_CHARS) throw invalid();
  const bytes = base64UrlDecode(value);
  if (bytes === null || bytes.length > MAX_KEY_JSON_BYTES) throw invalid();
  const text = utf8Decode(bytes);
  if (text === null) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((part) => typeof part === "string")) throw invalid();
  const [world, kind, id] = parsed as [string, string, string];
  if (kind !== "capture" && kind !== "inbox") throw invalid();
  const key: LessonKey = { world, kind, id };
  if (lessonKeyProblems(key).length > 0) throw invalid();
  // Canonical form only: one key, one string.
  if (encodeLessonKey(key) !== value) throw invalid();
  return key;
}

/** What the executing store handle must be. Kept outside the domain payload and its hash. */
export type CurationPrecondition = { kind: "installation"; id: string } | { kind: "uninitialized"; locationId: string };
