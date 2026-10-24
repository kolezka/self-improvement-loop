// Bounded, read-only access to legacy inbox lessons for curation. Never
// writes, repairs or moves a source file and never touches delivery counts.
// Unlike listLessons, a file it cannot use is reported, never skipped.

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Lesson, paths } from "@sil/core";
import { CurationError, lessonKeyProblems } from "@sil/core/lesson-curation";
import type { LessonKey } from "@sil/core/lesson-curation";
import type { LegacySourceCopy, LegacySourceFileProblem, LegacySourceLocation, LegacySourceProblem } from "@sil/core/curation-read";
import { legacySourceDigestV1 } from "./source.ts";
import type { LegacySourceSnapshot } from "./source.ts";

/** A legacy lesson file larger than this is refused before it is parsed. */
export const MAX_LEGACY_SOURCE_BYTES = 64 * 1024;

/** A source that exists but cannot be used, or a directory that cannot be read. */
export class LegacySourceError extends CurationError {
  override name = "LegacySourceError";
  constructor(
    public readonly problem: LegacySourceProblem | "conflict",
    public readonly location: LegacySourceLocation | null,
  ) {
    super(problem === "conflict" ? "SOURCE_CONFLICT" : "STORAGE_UNAVAILABLE", ["source", problem]);
  }
}

/** source_digest_v1 of a parsed legacy lesson. The one serializer, from source.ts. */
export function sourceDigest(lesson: Lesson): string {
  return legacySourceDigestV1(lesson);
}

export type LegacySourceObservation =
  | { state: "absent" }
  | { state: "present"; snapshot: LegacySourceSnapshot; copies: LegacySourceCopy[] }
  | { state: "conflict"; copies: LegacySourceCopy[] }
  | { state: "unusable"; problem: LegacySourceProblem; location: LegacySourceLocation };

type FileRead = { state: "absent" } | { state: "ok"; lesson: Lesson } | { state: "problem"; problem: LegacySourceProblem };

/** File name a legacy lesson with this id is stored under, in either location. */
export const legacySourceFileName = (id: string): string => `${paths.safeComponent(id)}.json`;
const fileNameFor = legacySourceFileName;

/**
 * Canonical source directory, or null when part of it does not exist yet.
 *
 * The configured state root is trusted and canonicalized as a whole, so a
 * symlinked or system-relocated root still works. Every component below it
 * (inbox, world, archive) must be a plain directory: a symlink anywhere in
 * that chain could lead reads out of the inbox tree.
 */
function trustedSourceDir(world: string, location: LegacySourceLocation): string | null {
  // The chain below assumes this layout; a layout change must fail here, not read elsewhere.
  if (paths.inboxDir(world) !== join(paths.stateDir(), "inbox", paths.safeComponent(world))) {
    throw new LegacySourceError("unsafe_path", location);
  }
  let dir: string;
  try {
    dir = realpathSync(paths.stateDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LegacySourceError("unreadable", location);
  }
  const parts = ["inbox", paths.safeComponent(world), ...(location === "archive" ? ["archive"] : [])];
  for (const part of parts) {
    dir = join(dir, part);
    let st;
    try {
      st = lstatSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new LegacySourceError("unreadable", location);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new LegacySourceError("unsafe_path", location);
  }
  return dir;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Read one file without following a symlink and without reading past the bound. */
function readBounded(path: string): { state: "absent" } | { state: "bytes"; bytes: Uint8Array } | { state: "problem"; problem: LegacySourceProblem } {
  let fd: number;
  try {
    // O_NONBLOCK keeps a FIFO planted under the name from blocking the open.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: "absent" };
    if (code === "ELOOP" || code === "EMLINK") return { state: "problem", problem: "unsafe_path" };
    return { state: "problem", problem: "unreadable" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { state: "problem", problem: "unsafe_path" };
    if (st.size > MAX_LEGACY_SOURCE_BYTES) return { state: "problem", problem: "too_large" };
    // One byte past the bound tells a file that grew after fstat.
    const buffer = new Uint8Array(MAX_LEGACY_SOURCE_BYTES + 1);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > MAX_LEGACY_SOURCE_BYTES) return { state: "problem", problem: "too_large" };
    }
    return { state: "bytes", bytes: buffer.subarray(0, total) };
  } catch {
    return { state: "problem", problem: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

/** Parse one source file and check that its name and world match its content. */
function readSourceFile(world: string, dir: string, file: string): FileRead {
  const read = readBounded(join(dir, file));
  if (read.state !== "bytes") return read;
  let raw: unknown;
  try {
    raw = JSON.parse(utf8.decode(read.bytes));
  } catch {
    return { state: "problem", problem: "invalid_json" };
  }
  const parsed = Lesson.safeParse(raw);
  if (!parsed.success) return { state: "problem", problem: "invalid_schema" };
  const lesson = parsed.data;
  if (lesson.world !== world || fileNameFor(lesson.id) !== file) return { state: "problem", problem: "identity_mismatch" };
  return { state: "ok", lesson };
}

function copyOf(location: LegacySourceLocation, lesson: Lesson): LegacySourceCopy {
  return {
    location,
    digest: legacySourceDigestV1(lesson),
    reflectionId: lesson.reflection_id,
    repo: lesson.repo,
    pattern: lesson.pattern,
    created: lesson.created,
    text: lesson.text,
  };
}

/** Combine the active and archive reads of one key. */
function observe(active: FileRead, archive: FileRead): LegacySourceObservation {
  if (active.state === "problem") return { state: "unusable", problem: active.problem, location: "active" };
  if (archive.state === "problem") return { state: "unusable", problem: archive.problem, location: "archive" };
  if (active.state === "absent" && archive.state === "absent") return { state: "absent" };
  if (active.state === "ok" && archive.state === "ok") {
    const copies = [copyOf("active", active.lesson), copyOf("archive", archive.lesson)];
    if (copies[0]!.digest !== copies[1]!.digest) return { state: "conflict", copies };
    // Same semantic lesson in both places: the archived copy is what delivery left.
    return { state: "present", snapshot: { lesson: archive.lesson, digest: copies[1]!.digest, location: "both" }, copies };
  }
  const location: LegacySourceLocation = active.state === "ok" ? "active" : "archive";
  const lesson = active.state === "ok" ? active.lesson : (archive as { lesson: Lesson }).lesson;
  return { state: "present", snapshot: { lesson, digest: legacySourceDigestV1(lesson), location }, copies: [copyOf(location, lesson)] };
}

/** Treat a file holding another id under a colliding safe name as not this key's source. */
function forKey(read: FileRead, id: string): FileRead {
  return read.state === "ok" && read.lesson.id !== id ? { state: "absent" } : read;
}

/** Observe one key's source in both locations. Directory failures throw. */
export function inspectLegacySource(key: LessonKey): LegacySourceObservation {
  if (lessonKeyProblems(key).length > 0 || key.kind !== "inbox") throw new CurationError("INVALID_INPUT", ["key"]);
  const file = fileNameFor(key.id);
  const read = (location: LegacySourceLocation): FileRead => {
    const dir = trustedSourceDir(key.world, location);
    return dir === null ? { state: "absent" } : forKey(readSourceFile(key.world, dir, file), key.id);
  };
  const active = read("active");
  const archive = read("archive");
  return observe(active, archive);
}

/**
 * The validated snapshot of one legacy lesson, or null when no source exists.
 * Conflicting copies, unsafe, oversize, unreadable or invalid files throw.
 */
export function readLegacySource(key: LessonKey): LegacySourceSnapshot | null {
  const seen = inspectLegacySource(key);
  if (seen.state === "absent") return null;
  if (seen.state === "present") return seen.snapshot;
  if (seen.state === "conflict") throw new LegacySourceError("conflict", null);
  throw new LegacySourceError(seen.problem, seen.location);
}

export interface LegacySourceScan {
  /** Usable or conflicting sources by lesson id. */
  sources: Map<string, LegacySourceObservation>;
  /** Unusable files by file name, per location. */
  unusable: Map<string, LegacySourceObservation>;
  problems: LegacySourceFileProblem[];
}

function listJsonFiles(dir: string | null, location: LegacySourceLocation): string[] {
  if (dir === null) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    throw new LegacySourceError("unreadable", location);
  }
}

/** Every source file of one world, active and archive. A directory it cannot read throws. */
export function scanLegacySources(world: string): LegacySourceScan {
  const reads = new Map<string, { active: FileRead; archive: FileRead }>();
  const problems: LegacySourceFileProblem[] = [];
  for (const location of ["active", "archive"] as const) {
    const dir = trustedSourceDir(world, location);
    for (const file of listJsonFiles(dir, location)) {
      const read = readSourceFile(world, dir!, file);
      if (read.state === "problem") problems.push({ location, file, problem: read.problem });
      const entry = reads.get(file) ?? { active: { state: "absent" }, archive: { state: "absent" } };
      entry[location] = read;
      reads.set(file, entry);
    }
  }
  const sources = new Map<string, LegacySourceObservation>();
  const unusable = new Map<string, LegacySourceObservation>();
  for (const [file, entry] of reads) {
    const seen = observe(entry.active, entry.archive);
    if (seen.state === "unusable") unusable.set(file, seen);
    else if (seen.state !== "absent") {
      const lesson = entry.active.state === "ok" ? entry.active.lesson : (entry.archive as { lesson: Lesson }).lesson;
      sources.set(lesson.id, seen);
    }
  }
  return { sources, unusable, problems };
}

/** The scan's observation for one key: usable, unusable by its file name, or absent. */
export function observationFor(scan: LegacySourceScan, id: string): LegacySourceObservation {
  return scan.sources.get(id) ?? scan.unusable.get(fileNameFor(id)) ?? { state: "absent" };
}
