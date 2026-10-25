// Alias maps in the aliases table, one row per pair and world. replaceAliases
// is the single place an alias write checks the one-hop rule.

import { assertOneHop, StateWriteError } from "@sil/core";
import { type DocMode, readStore, storeRef } from "./docs.ts";
import { ensureImported, reasonOf } from "./import.ts";
import { openState } from "./open.ts";
import { STORES } from "./stores.ts";

/** A world's aliases sorted by alias; {} when it has none (or on any failure in tolerant mode). */
export function readAliases(world: string, mode: DocMode): Record<string, string> {
  const ref = storeRef("aliases", world);
  return readStore<Record<string, string>>(ref, mode, {}, (db) => {
    const rows = db.query("SELECT alias, canonical FROM aliases WHERE world = ? ORDER BY alias").all(ref.world) as {
      alias: string;
      canonical: string;
    }[];
    const map: Record<string, string> = {};
    for (const row of rows) map[row.alias] = row.canonical;
    return map;
  });
}

/** Replace every alias of a world. A chain throws the core ValidationError
 * unchanged; any other failure throws StateWriteError starting with the label. */
export function replaceAliases(world: string, aliases: Record<string, string>): void {
  const ref = storeRef("aliases", world);
  const label = STORES.aliases.label(ref.world);
  assertOneHop(aliases);
  try {
    for (const canonical of Object.values(aliases)) {
      if (typeof canonical !== "string") throw new StateWriteError(`${label} cannot be written (not a map of names)`);
    }
    // A legacy file still waiting at the old path is older than this write.
    ensureImported(ref);
    const db = openState();
    db.run("BEGIN IMMEDIATE");
    try {
      db.query("DELETE FROM aliases WHERE world = ?").run(ref.world);
      const insert = db.query("INSERT INTO aliases (world, alias, canonical) VALUES (?, ?, ?)");
      for (const [alias, canonical] of Object.entries(aliases)) insert.run(ref.world, alias, canonical);
      db.run("COMMIT");
    } finally {
      if (db.inTransaction) db.run("ROLLBACK");
    }
  } catch (error) {
    if (error instanceof StateWriteError && error.message.startsWith(label)) throw error;
    throw new StateWriteError(`${label} cannot be written (${reasonOf(error)})`);
  }
}
