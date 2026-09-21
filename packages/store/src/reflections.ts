// Reflection store: append-only markdown files, one per occurrence, world scoped.
// `reflectionPattern()` is the one definition of "this file is a reflection".

import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import YAML from "yaml";
import { fsx, paths, Reflection, type Reflection as ReflectionT } from "@sil/core";
import { loadAliases } from "./aliases.ts";

export const PATTERN_RE = /^Pattern:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/m;

export function reflectionPattern(text: string): string | null {
  const m = PATTERN_RE.exec(text);
  return m ? m[1]! : null;
}

export function splitFrontMatter(text: string): [Record<string, unknown>, string] {
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) {
      let meta: unknown = {};
      try {
        meta = YAML.parse(text.slice(4, end)) ?? {};
      } catch {
        meta = {};
      }
      const obj = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
      return [obj, text.slice(end + 5)];
    }
  }
  return [{}, text];
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

export function parseReflection(path: string, world: string): ReflectionT | null {
  let text: string;
  try {
    text = fsx.readText(path);
  } catch {
    return null;
  }
  const [meta, body] = splitFrontMatter(text);
  const pattern = reflectionPattern(body) ?? reflectionPattern(text);
  if (!pattern) return null;
  const created = meta["created"] ? String(meta["created"]) : new Date(statSync(path).mtimeMs).toISOString().slice(0, 10);
  const parsed = Reflection.safeParse({
    id: meta["id"] ? String(meta["id"]) : basename(path).replace(/\.md$/, ""),
    world: meta["world"] ? String(meta["world"]) : world,
    pattern,
    path,
    created,
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

/** Markdown under `dir`, each real file once, never through a directory symlink.
 *
 * `lstatSync`, so a symlinked directory is not a directory here. Followed, they
 * were both a multiplier and a door: `reflections/sub/loop -> ..` yielded one
 * reflection 41 times and cleared the promotion threshold on its own, and a link
 * to any other directory pulled that directory's markdown into the world.
 *
 * `seen` carries across the whole walk, including the extra dirs, so a file
 * reachable by two paths still counts once. */
function* walkMarkdown(dir: string, seen: Set<string>): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") || name === "graphify-out" || name === "vec-index") continue;
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walkMarkdown(p, seen);
      continue;
    }
    if (!name.endsWith(".md")) continue;
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    yield p;
  }
}

/** All reflections of a world, newest first. `extraDirs` lets a world read a
 * V1 mirror tree read-only (import without copying). */
export function listReflections(world: string, extraDirs: string[] = []): ReflectionT[] {
  const out: ReflectionT[] = [];
  const seen = new Set<string>();
  for (const d of [paths.reflectionsDir(world), ...extraDirs]) {
    for (const p of walkMarkdown(d, seen)) {
      if (relative(d, p).startsWith("..")) continue;
      const r = parseReflection(p, world);
      if (r && r.world === world) out.push(r);
    }
  }
  out.sort((a, b) => (a.created === b.created ? (a.id < b.id ? 1 : -1) : a.created < b.created ? 1 : -1));
  return out;
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
    ...meta,
  };
  const front = YAML.stringify(full).trimEnd();
  fsx.atomicWrite(path, `---\n${front}\n---\n${body.trimEnd()}\n`);
  return path;
}

/** session id -> when this world's newest reflection of it was written, in ms.
 *
 * The queue is the only guard against a second reflection of one session, and a
 * re-queued or replayed entry passes it. The files on disk are the durable
 * record, so the worker asks them instead.
 *
 * The time matters as much as the id. A resumed session keeps its id and earns
 * new work, so "already reflected" alone would throw that work away for ever; a
 * caller compares against the queue entry's own first stop. An unreadable mtime
 * counts as 0, which reflects again rather than losing a lesson. */
export function reflectedSessions(world: string, extraDirs: string[] = []): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of listReflections(world, extraDirs)) {
    if (!r.session_id) continue;
    let at = 0;
    try {
      at = statSync(r.path).mtimeMs;
    } catch {
      at = 0;
    }
    const prev = out.get(r.session_id);
    if (prev === undefined || at > prev) out.set(r.session_id, at);
  }
  return out;
}

export function patternCounts(world: string, extraDirs: string[] = []): Record<string, number> {
  const counts: Record<string, number> = {};
  const aliases = loadAliases(world);
  for (const r of listReflections(world, extraDirs)) {
    const p = aliases[r.pattern] ?? r.pattern;
    counts[p] = (counts[p] ?? 0) + 1;
  }
  return counts;
}
