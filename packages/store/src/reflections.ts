// Reflection store: append-only markdown files, one per occurrence, world scoped.
// `reflectionPattern()` is the one definition of "this file is a reflection".

import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import YAML from "yaml";
import { fsx, paths, Reflection, StateReadError, type Reflection as ReflectionT } from "@sil/core";

export const PATTERN_RE = /^Pattern:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/m;

export function reflectionPattern(text: string): string | null {
  const m = PATTERN_RE.exec(text);
  return m ? m[1]! : null;
}

/** The three states of a front matter header, from the one place a header
 * is found (parsing is the caller's):
 * - none: the text does not start with a `---` line;
 * - closed: a `---` line opens it and a later `---` line closes it, possibly
 *   with nothing between them;
 * - unclosed: a `---` line opens it and nothing closes it. */
type FrontMatter =
  | { kind: "none"; body: string }
  | { kind: "closed"; header: string; body: string }
  | { kind: "unclosed"; body: string };

/** Where a header opened on the first line is closed: the index of the
 * `\n---\n` after it, or -1. Searched from the opening line's own newline
 * on, so an empty header (a closing line right after the opening one) is
 * not seen here; frontMatterParts handles that case. */
function closingAt(text: string): number {
  return text.startsWith("---\n") ? text.indexOf("\n---\n", 4) : -1;
}

function frontMatterParts(text: string): FrontMatter {
  if (!text.startsWith("---\n")) return { kind: "none", body: text };
  if (text.startsWith("---\n---\n")) return { kind: "closed", header: "", body: text.slice(8) };
  const end = closingAt(text);
  if (end !== -1) return { kind: "closed", header: text.slice(4, end), body: text.slice(end + 5) };
  return { kind: "unclosed", body: text };
}

/** Tolerant, and unchanged: a header that does not parse, is not a map, or
 * is never closed reads as none. It finds the close with the same closingAt
 * as the strict reader, by the rule it has always used. */
export function splitFrontMatter(text: string): [Record<string, unknown>, string] {
  const end = closingAt(text);
  if (end === -1) return [{}, text];
  let meta: unknown = {};
  try {
    meta = YAML.parse(text.slice(4, end)) ?? {};
  } catch {
    meta = {};
  }
  const obj = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
  return [obj, text.slice(end + 5)];
}

/** Text under a `## heading` up to the next `## `. */
export function section(body: string, heading: string): string {
  const idx = body.indexOf(heading);
  if (idx === -1) return "";
  const rest = body.slice(idx + heading.length);
  const nxt = rest.indexOf("\n## ");
  return (nxt === -1 ? rest : rest.slice(0, nxt)).trim();
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const strOrNull = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));

/** A reflection from its parsed header and body, or null when the text has
 * no `Pattern:` line (not a reflection) or does not make a valid record. */
function reflectionFromParts(path: string, world: string, text: string, meta: Record<string, unknown>, body: string, mtimeMs: () => number): ReflectionT | null {
  const pattern = reflectionPattern(body) ?? reflectionPattern(text);
  if (!pattern) return null;
  const created = meta["created"] ? String(meta["created"]) : new Date(mtimeMs()).toISOString().slice(0, 10);
  // A file written before this field existed has no front matter value, so
  // fall back to the file's own mtime rather than null: a real write-order
  // signal beats no signal at all.
  const createdAt = meta["created_at"] ? String(meta["created_at"]) : new Date(mtimeMs()).toISOString();
  const parsed = Reflection.safeParse({
    id: meta["id"] ? String(meta["id"]) : basename(path).replace(/\.md$/, ""),
    world: meta["world"] ? String(meta["world"]) : world,
    pattern,
    path,
    created,
    created_at: createdAt,
    session_id: strOrNull(meta["session_id"]),
    cwd: strOrNull(meta["cwd"]),
    revision: strOrNull(meta["revision"]),
    model: strOrNull(meta["model"]),
    artifacts_used: strList(meta["artifacts_used"]),
    artifacts_helpful: strList(meta["artifacts_helpful"]),
    artifacts_misfired: strList(meta["artifacts_misfired"]),
    lesson: section(body, "## Reusable lesson"),
    body,
  });
  return parsed.success ? parsed.data : null;
}

export function reflectionFromText(path: string, world: string, text: string, mtimeMs: () => number): ReflectionT | null {
  const [meta, body] = splitFrontMatter(text);
  return reflectionFromParts(path, world, text, meta, body, mtimeMs);
}

/** Tolerant: a file that cannot be read is no reflection. For the learning
 * and processing callers; the consoles read through the strict forms below. */
export function parseReflection(path: string, world: string): ReflectionT | null {
  let text: string;
  try {
    text = fsx.readText(path);
  } catch {
    return null;
  }
  return reflectionFromText(path, world, text, () => statSync(path).mtimeMs);
}

/** One reflection file, read strictly: null when the file does not exist or
 * is not a reflection (no `Pattern:` line). A file that cannot be read, or a
 * reflection that does not make a valid record, raises StateReadError named
 * by `label`. */
export function readReflectionStrict(path: string, world: string, label: string): ReflectionT | null {
  let text: string | null;
  try {
    text = fsx.readTextIfPresent(path);
  } catch (err) {
    throw new StateReadError(`reflection ${label} cannot be read (${fsx.errnoCode(err)})`);
  }
  if (text === null) return null;
  const mtimeMs = (): number => {
    try {
      return statSync(path).mtimeMs;
    } catch (err) {
      throw new StateReadError(`reflection ${label} cannot be read (${fsx.errnoCode(err)})`);
    }
  };
  // Not a reflection at all (no Pattern line): null, whatever its header.
  const parts = frontMatterParts(text);
  const body = parts.body;
  if ((reflectionPattern(body) ?? reflectionPattern(text)) === null) return null;
  // A reflection's header is read strictly: one that is never closed, does
  // not parse, or is not a map must not lose its world, id or date to the
  // defaults. No header at all, or an empty closed one, means no metadata.
  if (parts.kind === "unclosed") throw new StateReadError(`reflection ${label} has a front matter header that is never closed`);
  let meta: Record<string, unknown> = {};
  if (parts.kind === "closed" && parts.header !== "") {
    let parsed: unknown;
    try {
      parsed = YAML.parse(parts.header) ?? {};
    } catch {
      throw new StateReadError(`reflection ${label} has a front matter header that does not parse`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new StateReadError(`reflection ${label} has a front matter header that is not a map`);
    meta = parsed as Record<string, unknown>;
  }
  const r = reflectionFromParts(path, world, text, meta, body, mtimeMs);
  if (r === null) throw new StateReadError(`reflection ${label} is not a valid reflection record`);
  return r;
}

/** reflections.get: one reflection by path, strictly. */
export function parseReflectionStrict(path: string, world: string): ReflectionT | null {
  return readReflectionStrict(path, world, basename(path));
}

/** Markdown under `dir` with its realpath, each real file once, never through a directory symlink.
 *
 * `lstatSync`, so a symlinked directory is not a directory here. Followed, they
 * were both a multiplier and a door: `reflections/sub/loop -> ..` yielded one
 * reflection 41 times and cleared the promotion threshold on its own, and a link
 * to any other directory pulled that directory's markdown into the world.
 *
 * `seen` carries across the whole walk, including the extra dirs, so a file
 * reachable by two paths still counts once. */
export function* walkMarkdown(dir: string, seen: Set<string>, strict?: WalkProblems): Generator<{ path: string; real: string }> {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch (err) {
    // Tolerant callers see nothing. Strict: only a dir that is not there is
    // empty; one that cannot be listed stops the whole read.
    if (!strict || fsx.errnoCode(err) === "ENOENT") return;
    throw new StateReadError(`${strict.label(dir)} cannot be listed (${fsx.errnoCode(err)})`);
  }
  let dirReal: string | undefined;
  for (const name of entries) {
    if (name.startsWith(".") || name === "graphify-out" || name === "vec-index") continue;
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch (err) {
      // Gone since the listing: moved on. Anything else is named when strict.
      if (strict && fsx.errnoCode(err) !== "ENOENT") strict.unreadable.push(strict.label(p));
      continue;
    }
    if (st.isDirectory()) {
      yield* walkMarkdown(p, seen, strict);
      continue;
    }
    if (!name.endsWith(".md")) continue;
    let real: string;
    try {
      // Bun's realpathSync opens the file and fails with EACCES on a 000 file;
      // for a non-link, the dir's realpath plus the name is the same path.
      if (st.isSymbolicLink()) real = realpathSync(p);
      else real = join((dirReal ??= realpathSync(dir)), name);
    } catch (err) {
      if (strict && fsx.errnoCode(err) !== "ENOENT") strict.unreadable.push(strict.label(p));
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    yield { path: p, real };
  }
}

/** What a strict walk reports besides the files: entries it could not stat or
 * resolve, and how to name a path without making it absolute. */
export interface WalkProblems {
  unreadable: string[];
  label: (path: string) => string;
}

export interface ReflectionScan {
  reflections: ReflectionT[];
  /** Reflection files that exist but cannot be read or parsed, relative to their reflections dir. */
  unreadable: string[];
}

/** All reflections of a world, read strictly, newest first. A reflections
 * dir that does not exist is empty; one that cannot be listed raises
 * StateReadError. A file gone mid-read is skipped; one that cannot be read or
 * does not parse is named in `unreadable`. The walk's symlink and loop
 * exclusions are the same as listReflections'. */
export function scanReflections(world: string, extraDirs: string[] = []): ReflectionScan {
  const out: ReflectionT[] = [];
  const seen = new Set<string>();
  const unreadable: string[] = [];
  for (const d of [paths.reflectionsDir(world), ...extraDirs]) {
    const label = (p: string): string => {
      const rel = relative(d, p);
      return rel === "" ? `the reflections dir of world ${JSON.stringify(world)}` : rel;
    };
    for (const { path: p } of walkMarkdown(d, seen, { unreadable, label })) {
      if (relative(d, p).startsWith("..")) continue;
      let r: ReflectionT | null;
      try {
        r = readReflectionStrict(p, world, label(p));
      } catch (err) {
        if (!(err instanceof StateReadError)) throw err;
        unreadable.push(label(p));
        continue;
      }
      if (r && r.world === world) out.push(r);
    }
  }
  sortNewestFirst(out);
  return { reflections: out, unreadable };
}

/** Every reflection of the world, or StateReadError naming the ones that
 * cannot be read. For counts and lists the consoles show as complete. */
export function listReflectionsStrict(world: string, extraDirs: string[] = []): ReflectionT[] {
  const scan = scanReflections(world, extraDirs);
  if (scan.unreadable.length > 0) {
    const n = scan.unreadable.length;
    throw new StateReadError(`world ${JSON.stringify(world)} has ${n} ${n === 1 ? "reflection" : "reflections"} that cannot be read or parsed: ${scan.unreadable.join(", ")}`);
  }
  return scan.reflections;
}

/** All reflections of a world, newest first. `extraDirs` lets a world read a
 * V1 mirror tree read-only (import without copying). */
export function listReflections(world: string, extraDirs: string[] = []): ReflectionT[] {
  const out: ReflectionT[] = [];
  const seen = new Set<string>();
  for (const d of [paths.reflectionsDir(world), ...extraDirs]) {
    for (const { path: p } of walkMarkdown(d, seen)) {
      if (relative(d, p).startsWith("..")) continue;
      const r = parseReflection(p, world);
      if (r && r.world === world) out.push(r);
    }
  }
  sortNewestFirst(out);
  return out;
}

/** `created` (date-only) stays the primary key so a hand-edited date wins
 * across days. Same-day ties break on `created_at` (write time), newest
 * first; `id` is only the last resort when both are equal. */
export function sortNewestFirst<T extends Pick<ReflectionT, "created" | "created_at" | "id">>(out: T[]): void {
  out.sort((a, b) => {
    if (a.created !== b.created) return a.created < b.created ? 1 : -1;
    const aAt = a.created_at;
    const bAt = b.created_at;
    if (aAt !== bAt) {
      if (aAt === null) return 1;
      if (bAt === null) return -1;
      return aAt < bAt ? 1 : -1;
    }
    return a.id < b.id ? 1 : -1;
  });
}

export function newReflectionId(pattern: string, when: Date = new Date()): string {
  const d = when.toISOString().slice(0, 10);
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${d}-${pattern}-${rand}`;
}

/** How many ids a generated one may try before it gives up. */
const ID_ATTEMPTS = 16;

/** A free reflection id for `pattern`, or the caller's own id unchanged.
 *
 * The generated id holds 16 random bits, so two reflections of one pattern on
 * one day collide about once in 65536. On a collision the loop used to throw and
 * the worker marked the session failed, which lost the reflection for a name
 * clash. A caller-supplied id still throws: it names a specific file, and
 * writing that content somewhere else would be a silent rename. */
function freeReflectionPath(world: string, pattern: string, wanted: string | null): [string, string] {
  const dir = paths.reflectionsDir(world);
  if (wanted !== null) {
    const path = join(dir, `${wanted}.md`);
    if (fsx.exists(path)) throw new Error(`reflection already exists: ${path}`);
    return [wanted, path];
  }
  for (let i = 0; i < ID_ATTEMPTS; i++) {
    const id = newReflectionId(pattern);
    const path = join(dir, `${id}.md`);
    if (!fsx.exists(path)) return [id, path];
  }
  throw new Error(`no free reflection id for ${pattern} in ${dir} after ${ID_ATTEMPTS} tries`);
}

/** Append-only: a new file per occurrence, never overwrite. */
export function writeReflection(world: string, meta: Record<string, unknown>, body: string): string {
  const pattern = reflectionPattern(body);
  if (!pattern) throw new Error("reflection body has no `Pattern: <slug>` line");
  const [id, path] = freeReflectionPath(world, pattern, meta["id"] ? String(meta["id"]) : null);
  const full: Record<string, unknown> = {
    id,
    world,
    pattern,
    created: meta["created"] ? String(meta["created"]) : fsx.today(),
    created_at: meta["created_at"] ? String(meta["created_at"]) : fsx.nowIso(),
    ...meta,
  };
  const front = YAML.stringify(full).trimEnd();
  fsx.atomicWrite(path, `---\n${front}\n---\n${body.trimEnd()}\n`);
  return path;
}
