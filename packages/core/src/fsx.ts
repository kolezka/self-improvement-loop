// Small filesystem helpers: atomic writes, tolerant JSONL, append with rotation.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** Append one line; when the file passes `rotateAt` keep only the last `keep` lines. */
export function appendLine(path: string, line: string, rotateAt = ROTATE_AT_BYTES, keep = ROTATE_KEEP_LINES): void {
  ensureDir(dirname(path));
  try {
    if (statSync(path).size >= rotateAt) {
      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
      atomicWrite(path, lines.slice(-keep).join("\n") + "\n");
    }
  } catch {
    // no file yet
  }
  appendFileSync(path, line.endsWith("\n") ? line : line + "\n", "utf8");
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
