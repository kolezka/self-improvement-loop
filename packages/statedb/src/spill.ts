// The spill dir of a legacy JSONL path (design D5): the hook's open spill file
// and the sealed segments that wait for import. Pure filesystem code with no
// database imports, so the hook module and the importer can both use it.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The open spill file is sealed into a segment before an append once it holds this many bytes. */
export const SPILL_SEAL_BYTES = 4 * 1024 * 1024;

/** The hook keeps at most this many unclaimed sealed segments per store. */
export const SPILL_MAX_SEGMENTS = 8;

/** Basename of the one file a hook appends to. A 1.3.0 hook never looks inside the spill dir. */
export const OPEN_SPILL = "current.jsonl";

/** Where the spill files of `legacyPath` live. */
export const spillDir = (legacyPath: string): string => `${legacyPath}.spill`;

/** The hook's open spill file of `legacyPath`. */
export const openSpillPath = (legacyPath: string): string => join(spillDir(legacyPath), OPEN_SPILL);

/** A sealed segment's basename: any `*.jsonl` but the open spill file. */
export const isSealedSegment = (name: string): boolean => name.endsWith(".jsonl") && name !== OPEN_SPILL;

/** Sealed segment and claim basenames in the spill dir, each sorted. Claims
 * include a claimed open spill file. A missing dir has none; any other listing
 * error throws. Backups (`*.imported-*`) are neither. */
export function listSpillSegments(legacyPath: string): { segments: string[]; claims: string[] } {
  let names: string[];
  try {
    names = readdirSync(spillDir(legacyPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { segments: [], claims: [] };
    throw error;
  }
  return {
    segments: names.filter(isSealedSegment).sort(),
    claims: names.filter((name) => name.endsWith(".importing")).sort(),
  };
}

const statOrNullReal = (path: string): { size: number } | null => {
  try {
    return statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

/** Whether the spill dir of `legacyPath` holds input: a sealed segment, a
 * claim, or a nonempty open spill file. `statOrNull` returns null on ENOENT. */
export function spillPending(legacyPath: string, statOrNull: (path: string) => { size: number } | null = statOrNullReal): boolean {
  const { segments, claims } = listSpillSegments(legacyPath);
  if (segments.length > 0 || claims.length > 0) return true;
  return (statOrNull(openSpillPath(legacyPath))?.size ?? 0) > 0;
}
