// The reflections index (design D12): a per-file cache of reflection headers,
// keyed by realpath. It has no legacy file, so nothing here imports.

import type { Database } from "bun:sqlite";
import { StateReadError, StateWriteError } from "@sil/core";
import { reasonOf } from "./import.ts";
import { openState } from "./open.ts";
import { worldKey } from "./stores.ts";

export interface ReflectionIndexRow {
  path: string;
  dirWorld: string;
  id: string;
  world: string;
  pattern: string;
  sessionId: string | null;
  created: string;
  createdAt: string | null;
  /** JSON text of the record minus body and lesson. */
  head: string;
  size: number;
  mtimeMs: number;
  ino: number;
  indexedAt: string;
}

export type ReflectionIndexUpsert = Omit<ReflectionIndexRow, "indexedAt">;

const label = (world: string): string => `the reflections index of world ${JSON.stringify(world)}`;

/** A failed rollback after `primary`, so the message can name both. */
class RollbackFailed extends Error {
  constructor(
    readonly primary: unknown,
    readonly secondary: unknown,
  ) {
    super("rollback failed");
  }
}

/** Roll back after `primary` and return the error to throw: `primary`, or both when the rollback fails too. */
function rollbackAfter(db: Database, primary: unknown): unknown {
  try {
    if (db.inTransaction) db.run("ROLLBACK");
    return primary;
  } catch (secondary) {
    return new RollbackFailed(primary, secondary);
  }
}

const reasonWithRollback = (error: unknown): string =>
  error instanceof RollbackFailed ? `${reasonOf(error.primary)}; rollback failed: ${reasonOf(error.secondary)}` : reasonOf(error);

/** Every row of the world, ordered by path, from one read snapshot. Throws StateReadError on any failure. */
export function readReflectionIndex(dirWorld: string): ReflectionIndexRow[] {
  const key = worldKey(dirWorld);
  try {
    const db = openState();
    db.run("BEGIN");
    try {
      const rows = db
        .query(
          `SELECT path, dir_world AS dirWorld, id, world, pattern, session_id AS sessionId, created, created_at AS createdAt,
             head, size, mtime_ms AS mtimeMs, ino, indexed_at AS indexedAt
           FROM reflection_index WHERE dir_world = ? ORDER BY path`,
        )
        .all(key) as ReflectionIndexRow[];
      db.run("COMMIT");
      return rows;
    } catch (error) {
      throw rollbackAfter(db, error);
    }
  } catch (error) {
    throw new StateReadError(`${label(key)} cannot be read (${reasonWithRollback(error)})`);
  }
}

/** Upsert rows (indexed_at = now) and delete rows still carrying the indexedAt
 * the caller read, in one write transaction. The world comes from `dirWorld`.
 * Throws StateWriteError on any failure. */
export function updateReflectionIndex(dirWorld: string, upserts: ReflectionIndexUpsert[], deletes: { path: string; indexedAt: string }[]): void {
  const key = worldKey(dirWorld);
  if (upserts.length === 0 && deletes.length === 0) return;
  try {
    const db = openState();
    db.run("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const upsert = db.query(
        `INSERT INTO reflection_index (path, dir_world, id, world, pattern, session_id, created, created_at, head, size, mtime_ms, ino, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET dir_world = excluded.dir_world, id = excluded.id, world = excluded.world,
           pattern = excluded.pattern, session_id = excluded.session_id, created = excluded.created, created_at = excluded.created_at,
           head = excluded.head, size = excluded.size, mtime_ms = excluded.mtime_ms, ino = excluded.ino, indexed_at = excluded.indexed_at`,
      );
      for (const r of upserts) {
        upsert.run(r.path, key, r.id, r.world, r.pattern, r.sessionId, r.created, r.createdAt, r.head, r.size, r.mtimeMs, r.ino, now);
      }
      // Only a row no other pass rewrote since the caller read it.
      const remove = db.query("DELETE FROM reflection_index WHERE path = ? AND indexed_at = ?");
      for (const d of deletes) remove.run(d.path, d.indexedAt);
      db.run("COMMIT");
    } catch (error) {
      throw rollbackAfter(db, error);
    }
  } catch (error) {
    throw new StateWriteError(`${label(key)} cannot be written (${reasonWithRollback(error)})`);
  }
}
