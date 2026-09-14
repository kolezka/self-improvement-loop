// Reflection store: append-only markdown files, one per occurrence, world scoped.
// `reflectionPattern()` is the one definition of "this file is a reflection".

import { readdirSync, statSync } from "node:fs";
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

function* walkMarkdown(dir: string): Generator<string> {
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
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walkMarkdown(p);
    else if (name.endsWith(".md")) yield p;
  }
}

/** All reflections of a world, newest first. `extraDirs` lets a world read a
 * V1 mirror tree read-only (import without copying). */
export function listReflections(world: string, extraDirs: string[] = []): ReflectionT[] {
  const out: ReflectionT[] = [];
  for (const d of [paths.reflectionsDir(world), ...extraDirs]) {
    for (const p of walkMarkdown(d)) {
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

/** Append-only: a new file per occurrence, never overwrite. */
export function writeReflection(world: string, meta: Record<string, unknown>, body: string): string {
  const pattern = reflectionPattern(body);
  if (!pattern) throw new Error("reflection body has no `Pattern: <slug>` line");
  const id = meta["id"] ? String(meta["id"]) : newReflectionId(pattern);
  const full: Record<string, unknown> = {
    id,
    world,
    pattern,
    created: meta["created"] ? String(meta["created"]) : fsx.today(),
    ...meta,
  };
  const path = join(paths.reflectionsDir(world), `${id}.md`);
  if (fsx.exists(path)) throw new Error(`reflection already exists: ${path}`);
  const front = YAML.stringify(full).trimEnd();
  fsx.atomicWrite(path, `---\n${front}\n---\n${body.trimEnd()}\n`);
  return path;
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
