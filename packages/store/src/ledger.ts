// promotions.json: per world, per pattern watermarks and status.

import { fsx, Ledger, type Ledger as LedgerT, type PromotionEntry } from "@sil/core";

/** The ledger at `path`, or an empty one when there is no file. A corrupt
 * ledger throws an Error naming the file. */
export function loadLedger(path: string): LedgerT {
  if (!fsx.exists(path)) return Ledger.parse({});
  return parseLedger(fsx.readText(path), path);
}

export function parseLedger(text: string, label = "<text>"): LedgerT {
  try {
    let raw: unknown = JSON.parse(text.trim() === "" ? "{}" : text);
    if (Array.isArray(raw)) {
      // V1 shape: a bare list of entries
      raw = { version: 1, entries: byPattern(raw) };
    } else if (raw && typeof raw === "object" && Array.isArray((raw as { entries?: unknown }).entries)) {
      // The shape V1 actually wrote: a list of rows under `version`. Read as a
      // record this threw, and every caller that swallowed the throw then saw an
      // empty ledger with every watermark gone.
      raw = { ...(raw as object), entries: byPattern((raw as { entries: unknown[] }).entries) };
    } else if (raw && typeof raw === "object" && !("entries" in (raw as object))) {
      const values = Object.values(raw as Record<string, unknown>);
      if (values.every((v) => v && typeof v === "object")) raw = { version: 1, entries: raw };
    }
    const parsed = Ledger.safeParse(raw);
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return parsed.data;
  } catch (e) {
    throw new Error(`unreadable ledger ${label}: ${(e as Error).message}`);
  }
}

/** A list of rows keyed by their own `pattern`. A row without one keeps an empty
 * key, so the schema reports it instead of the list silently losing it. */
function byPattern(rows: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const pattern = row && typeof row === "object" ? (row as { pattern?: unknown }).pattern : undefined;
    out[typeof pattern === "string" ? pattern : ""] = row;
  }
  return out;
}

export function saveLedger(path: string, ledger: LedgerT): string {
  const entries: Record<string, unknown> = {};
  for (const key of Object.keys(ledger.entries).sort()) entries[key] = stripNulls(ledger.entries[key]!);
  fsx.atomicWrite(path, JSON.stringify({ version: ledger.version, entries }, null, 2) + "\n");
  return path;
}

export function upsertEntry(ledger: LedgerT, entry: PromotionEntry): LedgerT {
  ledger.entries[entry.pattern] = entry;
  return ledger;
}

function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (val !== null && val !== undefined) out[k] = stripNulls(val);
    }
    return out;
  }
  return v;
}
