// Small filesystem helpers: atomic writes, tolerant JSONL, append with rotation.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StateReadError } from "./errors.ts";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function exists(path: string): boolean {
  return existsSync(path);
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function readTextOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

/** Write via a temp file in the same directory and rename over the target. */
export function atomicWrite(path: string, text: string): void {
  ensureDir(dirname(path));
  const tmp = join(dirname(path), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

export function writeJson(path: string, value: unknown): void {
  atomicWrite(path, JSON.stringify(value, null, 2) + "\n");
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readJsonOr<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** The `code` of a Node filesystem error, or "unknown error". */
export function errnoCode(err: unknown): string {
  const code = err && typeof err === "object" ? (err as NodeJS.ErrnoException).code : undefined;
  return typeof code === "string" ? code : "unknown error";
}

/** The file's text, or null when it does not exist (ENOENT). Any other read
 * error is thrown as it is, for the caller to name. */
export function readTextIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  }
}

/** A JSONL log read for a value shown as complete. A missing file is empty.
 * Every nonempty line, the last one too with or without its newline, must be
 * a JSON object; otherwise, or when the file cannot be read, this raises
 * StateReadError naming `label`. An append caught half written therefore
 * makes this read fail until it finishes, rather than answer a shorter list
 * as if complete. Only "is a JSON object" is checked here; each record's
 * fields are the caller's to read. The tolerant readJsonl below is unchanged. */
export function readJsonlStrict<T = Record<string, unknown>>(path: string, label: string): T[] {
  let text: string | null;
  try {
    text = readTextIfPresent(path);
  } catch (err) {
    throw new StateReadError(`${label} cannot be read (${errnoCode(err)})`);
  }
  if (text === null) return [];
  const out: T[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v as T);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  if (bad > 0) throw new StateReadError(`${label} has ${bad} ${bad === 1 ? "line" : "lines"} that ${bad === 1 ? "is" : "are"} not a JSON record`);
  return out;
}

/** Parse a JSONL file, skipping lines that are not valid JSON objects. */
export function readJsonl<T = Record<string, unknown>>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object") out.push(v as T);
    } catch {
      // a torn or foreign line is data loss for one record, not for the file
    }
  }
  return out;
}

export function appendJsonl(path: string, record: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

export const ROTATE_AT_BYTES = 10 * 1024 * 1024;
export const ROTATE_KEEP_LINES = 5000;

/** Append one line; when the file passes `rotateAt` keep only the last `keep`
 * lines, cut further until they fit in half of `rotateAt`. */
export function appendLine(path: string, line: string, rotateAt = ROTATE_AT_BYTES, keep = ROTATE_KEEP_LINES): void {
  ensureDir(dirname(path));
  try {
    if (statSync(path).size >= rotateAt) {
      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
      atomicWrite(path, rotated(lines, rotateAt, keep));
    }
  } catch {
    // no file yet
  }
  appendFileSync(path, line.endsWith("\n") ? line : line + "\n", "utf8");
}

/** The newest `keep` lines, dropped from the front until under `rotateAt / 2`.
 *
 * A line-only bound never shrinks a file whose lines average more than
 * `rotateAt / keep` bytes: the kept tail is still over the threshold, so every
 * later append reads and rewrites the whole file. */
function rotated(lines: string[], rotateAt: number, keep: number): string {
  const kept = lines.slice(-keep);
  let size = kept.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
  let start = 0;
  while (start < kept.length - 1 && size > rotateAt / 2) {
    size -= Buffer.byteLength(kept[start]!, "utf8") + 1;
    start += 1;
  }
  return kept.slice(start).join("\n") + "\n";
}

export function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
