// Reflection metadata served from the reflection_index cache (design D12). The
// files stay the source: a file whose size, mtime and inode match its row is not
// opened, anything else is parsed again, and an index that cannot be used only
// costs speed.

import { statSync } from "node:fs";
import { relative } from "node:path";
import { fsx, paths, StateReadError, type Reflection as ReflectionT } from "@sil/core";
import { logStateLineOnce, reasonOf, readReflectionIndex, type ReflectionIndexRow, type ReflectionIndexUpsert, updateReflectionIndex, worldKey } from "@sil/statedb";
import { loadAliases } from "./aliases.ts";
import { readReflectionStrict, reflectionFromText, sortNewestFirst, walkMarkdown } from "./reflections.ts";

/** A reflection without its body and lesson, plus the file's mtime from the same stat. */
export type ReflectionHead = Omit<ReflectionT, "body" | "lesson"> & { mtime_ms: number };

export interface ReflectionHeadScan {
  heads: ReflectionHead[];
  /** Changed reflection files that cannot be read or parsed, relative to their dir. */
  unreadable: string[];
}

type Mode = "strict" | "tolerant";

function logIndexUnused(world: string, error: unknown): void {
  logStateLineOnce(
    `reflection_index\0${worldKey(world)}`,
    `${new Date().toISOString()} the reflections index of world ${JSON.stringify(world)} was not used (${reasonOf(error)}); reflections were read from their files`,
  );
}

/** The stored head of a row, or null when it is not a JSON object (a stale row). */
function storedHead(row: ReflectionIndexRow): Omit<ReflectionHead, "mtime_ms"> | null {
  try {
    const v: unknown = JSON.parse(row.head);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Omit<ReflectionHead, "mtime_ms">) : null;
  } catch {
    return null;
  }
}

/** A changed file parsed the strict way, so a row only ever holds a record
 * the strict reader accepts. Tolerant mode falls back to the file reader's
 * own parse for what it returns, but does not store it. */
function parseChanged(p: string, world: string, label: string, mode: Mode, mtimeMs: number, unreadable: string[]): { r: ReflectionT | null; store: boolean } {
  try {
    return { r: readReflectionStrict(p, world, label), store: true };
  } catch (err) {
    if (!(err instanceof StateReadError)) throw err;
    if (mode === "strict") {
      unreadable.push(label);
      return { r: null, store: false };
    }
  }
  let text: string;
  try {
    text = fsx.readText(p);
  } catch {
    return { r: null, store: false };
  }
  return { r: reflectionFromText(p, world, text, () => mtimeMs), store: false };
}

function headsPass(world: string, extraDirs: string[], mode: Mode): ReflectionHeadScan {
  let rows: Map<string, ReflectionIndexRow> | null = null;
  // A header without a world takes the caller's spelling, so only the NFC
  // spelling, the one the rows are keyed by, may read or fill them.
  if (world === worldKey(world)) {
    try {
      rows = new Map(readReflectionIndex(world).map((r) => [r.path, r]));
    } catch (error) {
      logIndexUnused(world, error);
    }
  }
  const heads: ReflectionHead[] = [];
  const unreadable: string[] = [];
  const upserts: ReflectionIndexUpsert[] = [];
  const kept = new Set<string>();
  const seen = new Set<string>();
  const strictWalk = mode === "strict";
  for (const d of [paths.reflectionsDir(world), ...extraDirs]) {
    const label = (p: string): string => {
      const rel = relative(d, p);
      return rel === "" ? `the reflections dir of world ${JSON.stringify(world)}` : rel;
    };
    for (const { path: p, real } of walkMarkdown(d, seen, strictWalk ? { unreadable, label } : undefined)) {
      if (relative(d, p).startsWith("..")) continue;
      let st;
      try {
        st = statSync(real);
      } catch (err) {
        // Gone since the listing: moved on. Anything else is named when strict.
        if (strictWalk && fsx.errnoCode(err) !== "ENOENT") unreadable.push(label(p));
        continue;
      }
      const row = rows?.get(real);
      if (row && row.size === st.size && row.mtimeMs === st.mtimeMs && row.ino === st.ino) {
        const stored = storedHead(row);
        if (stored) {
          kept.add(real);
          heads.push({ ...stored, path: p, mtime_ms: st.mtimeMs });
          continue;
        }
      }
      const { r, store } = parseChanged(p, world, label(p), mode, st.mtimeMs, unreadable);
      if (!r) continue;
      const { body: _body, lesson: _lesson, ...head } = r;
      heads.push({ ...head, mtime_ms: st.mtimeMs });
      if (!store) continue;
      kept.add(real);
      upserts.push({
        path: real,
        dirWorld: world,
        id: head.id,
        world: head.world,
        pattern: head.pattern,
        sessionId: head.session_id,
        created: head.created,
        createdAt: head.created_at,
        head: JSON.stringify(head),
        size: st.size,
        mtimeMs: st.mtimeMs,
        ino: st.ino,
      });
    }
  }
  if (rows) {
    const deletes = [...rows.values()].filter((r) => !kept.has(r.path)).map((r) => ({ path: r.path, indexedAt: r.indexedAt }));
    try {
      updateReflectionIndex(world, upserts, deletes);
    } catch (error) {
      logIndexUnused(world, error);
    }
  }
  const out = heads.filter((h) => h.world === world);
  sortNewestFirst(out);
  return { heads: out, unreadable };
}

/** Every reflection head of a world, read strictly, newest first: the same
 * walk, filter and `unreadable` labels as scanReflections. */
export function scanReflectionHeads(world: string, extraDirs: string[] = []): ReflectionHeadScan {
  return headsPass(world, extraDirs, "strict");
}

/** Every reflection head of the world, or StateReadError naming the ones that
 * cannot be read, with listReflectionsStrict's message. */
export function listReflectionHeadsStrict(world: string, extraDirs: string[] = []): ReflectionHead[] {
  const scan = scanReflectionHeads(world, extraDirs);
  if (scan.unreadable.length > 0) {
    const n = scan.unreadable.length;
    throw new StateReadError(`world ${JSON.stringify(world)} has ${n} ${n === 1 ? "reflection" : "reflections"} that cannot be read or parsed: ${scan.unreadable.join(", ")}`);
  }
  return scan.heads;
}

/** Tolerant, like listReflections: a file that cannot be read is skipped. */
export function listReflectionHeads(world: string, extraDirs: string[] = []): ReflectionHead[] {
  return headsPass(world, extraDirs, "tolerant").heads;
}

/** session id -> when this world's newest reflection of it was written, in ms.
 *
 * The queue is the only guard against a second reflection of one session, and a
 * re-queued or replayed entry passes it. The files on disk are the durable
 * record, so the worker asks them instead.
 *
 * The time matters as much as the id. A resumed session keeps its id and earns
 * new work, so "already reflected" alone would throw that work away for ever; a
 * caller compares against the queue entry's own first stop. The time is the
 * mtime from the head's own stat. */
export function reflectedSessions(world: string, extraDirs: string[] = []): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of listReflectionHeads(world, extraDirs)) {
    if (!r.session_id) continue;
    const at = r.mtime_ms;
    const prev = out.get(r.session_id);
    if (prev === undefined || at > prev) out.set(r.session_id, at);
  }
  return out;
}

export function patternCounts(world: string, extraDirs: string[] = []): Record<string, number> {
  const counts: Record<string, number> = {};
  const aliases = loadAliases(world);
  for (const r of listReflectionHeads(world, extraDirs)) {
    const p = aliases[r.pattern] ?? r.pattern;
    counts[p] = (counts[p] ?? 0) + 1;
  }
  return counts;
}
