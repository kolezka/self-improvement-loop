// The spill dir of a legacy JSONL path (design D5): sealed segments that wait
// for import. Pure filesystem code with no database imports, so the hook
// module and the importer can both use it.

import { readdirSync } from "node:fs";

/** `P` is sealed into the spill dir before an append once it holds this many bytes. */
export const SPILL_SEAL_BYTES = 4 * 1024 * 1024;

/** The hook keeps at most this many unclaimed sealed segments per store. */
export const SPILL_MAX_SEGMENTS = 8;

/** Where the sealed segments of `legacyPath` live. */
export const spillDir = (legacyPath: string): string => `${legacyPath}.spill`;

/** Segment and claim basenames in the spill dir, each sorted. A missing dir
 * has none; any other listing error throws. Backups (`*.imported-*`) are neither. */
export function listSpillSegments(legacyPath: string): { segments: string[]; claims: string[] } {
  let names: string[];
  try {
    names = readdirSync(spillDir(legacyPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { segments: [], claims: [] };
    throw error;
  }
  return {
    segments: names.filter((name) => name.endsWith(".jsonl")).sort(),
    claims: names.filter((name) => name.endsWith(".importing")).sort(),
  };
}

/** Whether a segment or a claim waits in the spill dir of `legacyPath`. */
export function spillPending(legacyPath: string): boolean {
  const { segments, claims } = listSpillSegments(legacyPath);
  return segments.length > 0 || claims.length > 0;
}
