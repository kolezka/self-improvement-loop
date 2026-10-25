// Documents in the docs table (one JSON object per name and world), with the
// strict and tolerant readers of design D8.

import type { Database } from "bun:sqlite";
import { StateReadError, StateWriteError, ValidationError, WORLD_NAME_RE } from "@sil/core";
import { ensureImported, ImportError, reasonOf } from "./import.ts";
import { openState } from "./open.ts";
import { type DocName, type StoreName, type StoreRef, STORES, worldKey } from "./stores.ts";
import { logStateOnce } from "./streams.ts";

export type DocMode = "strict" | "tolerant";

/** The ref of a store and world: the world is NFC for a per-world store and
 * must be null for a global one. A mismatch is a programming error. */
export function storeRef(store: StoreName, world: string | null): StoreRef {
  if (STORES[store].perWorld) {
    if (world === null) throw new Error(`${store} used without a world`);
    const normalized = worldKey(world);
    if (!WORLD_NAME_RE.test(normalized)) throw new ValidationError(`world name ${JSON.stringify(world)} is not a valid world name`);
    return { store, world: normalized };
  }
  if (world !== null) throw new Error(`${store} is global and has no world`);
  return { store, world: null };
}

const labelOf = (ref: StoreRef): string => STORES[ref.store].label(ref.world);

/** What a strict document or aliases read throws when the import before it fails. */
export function strictStoreImportError(ref: StoreRef, error: unknown): StateReadError {
  if (error instanceof ImportError && error.busy) return new StateReadError(`${labelOf(ref)} is being imported`);
  return new StateReadError(`${labelOf(ref)} cannot be read (${reasonOf(error)})`);
}

/** The quarantine message of a document or aliases world (design D8). */
export const quarantinedMessage = (ref: StoreRef): string => `${labelOf(ref)} could not be imported; see sil state quarantine`;

/** Quarantine rows for exactly this store and world (a global store's rows have a null world). */
export const quarantineCountOn = (db: Database, ref: StoreRef): number =>
  (db.query("SELECT count(*) AS n FROM quarantine WHERE store = ? AND world IS ?").get(ref.store, ref.world) as { n: number }).n;

/** The shared read path: pending check and import first, then the value and
 * the quarantine count in one snapshot. Strict throws StateReadError; tolerant
 * logs once per store and world and returns `empty` on any failure. */
export function readStore<T>(ref: StoreRef, mode: DocMode, empty: T, read: (db: Database) => T): T {
  const label = labelOf(ref);
  const logKey = `${ref.store}\0${ref.world ?? ""}`;
  try {
    ensureImported(ref);
  } catch (error) {
    if (mode === "strict") throw strictStoreImportError(ref, error);
    logStateOnce(logKey, label, reasonOf(error));
    // An import failure alone still leaves the database readable.
    if (!(error instanceof ImportError)) return empty;
  }

  let value: T;
  let quarantined: number;
  try {
    const db = openState();
    db.run("BEGIN");
    try {
      value = read(db);
      quarantined = quarantineCountOn(db, ref);
      db.run("COMMIT");
    } finally {
      if (db.inTransaction) db.run("ROLLBACK");
    }
  } catch (error) {
    if (mode === "strict") throw new StateReadError(`${label} cannot be read (${reasonOf(error)})`);
    logStateOnce(logKey, label, reasonOf(error));
    return empty;
  }

  if (quarantined > 0) {
    if (mode === "strict") throw new StateReadError(quarantinedMessage(ref));
    // Tolerant: what imported, quarantine ignored (design D8), and a line in the log.
    logStateOnce(logKey, label, "the legacy file was quarantined");
  }
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The `world` key of a docs row: '' for a global document. */
const rowWorld = (ref: StoreRef): string => ref.world ?? "";

/** One document, or null when it has no row (or on any failure in tolerant mode).
 * A row whose body is not a JSON object is malformed, never the same as no row. */
export function readDoc(name: DocName, world: string | null, mode: DocMode): Record<string, unknown> | null {
  const ref = storeRef(name, world);
  const found = readStore<{ body: unknown } | null>(ref, mode, null, (db) => {
    const row = db.query("SELECT body FROM docs WHERE name = ? AND world = ?").get(name, rowWorld(ref)) as { body: string } | null;
    return row ? { body: JSON.parse(row.body) as unknown } : null;
  });
  if (found === null) return null;
  if (isRecord(found.body)) return found.body;
  const label = labelOf(ref);
  if (mode === "strict") throw new StateReadError(`${label} is not a JSON object`);
  logStateOnce(`${ref.store}\0${ref.world ?? ""}`, label, "not a JSON object");
  return null;
}

/** Replace one document. The store's pending import runs first, so a legacy
 * file still waiting can never land over this write. Any failure throws
 * StateWriteError starting with the label. */
export function saveDoc(name: DocName, world: string | null, value: Record<string, unknown>): void {
  const ref = storeRef(name, world);
  const label = labelOf(ref);
  try {
    if (!isRecord(value)) throw new StateWriteError(`${label} cannot be written (not a JSON object)`);
    ensureImported(ref);
    openState()
      .query(
        `INSERT INTO docs (name, world, body, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name, world) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      )
      .run(name, rowWorld(ref), JSON.stringify(value), new Date().toISOString());
  } catch (error) {
    if (error instanceof StateWriteError && error.message.startsWith(label)) throw error;
    throw new StateWriteError(`${label} cannot be written (${reasonOf(error)})`);
  }
}
