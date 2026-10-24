// Project scope for curation. World first: a path counts only when the
// configured world rules give it to the asked world. A configured repo is an
// ownership prefix: it picks the world, while the Git root found from an owned
// path is the project. Git runs only in owned paths, with a fixed env, no
// optional locks and no hooks or fsmonitor. A probe that fails is an error.

import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { loadConfig, paths, worldForCwd } from "@sil/core";
import type { Config, World } from "@sil/core";
import { CurationError, PROJECT_ID_RE } from "@sil/core/lesson-curation";
import type { LessonKey, LessonScope, StoreBinding } from "@sil/core/lesson-curation";
import { probeGitRepositoryRoot } from "@sil/core/repo-root";
import type { GitProbeOptions } from "@sil/core/repo-root";
import type { CurationContext, CurationReadResult, ProjectChoice, ProjectChoiceOrigin, RepoUnresolvedReason } from "@sil/core/curation-read";
import { decodeRecordId, openCurationStoreForRead } from "./database.ts";
import { boundedResult } from "./bounds.ts";
import type { CurationDatabase } from "./database.ts";
import { scanLegacySources } from "./sources.ts";
import type { LegacySourceSnapshot } from "./source.ts";

/** Git probe settings for every curation lookup. Nothing comes from this process's env. */
export const CURATION_GIT_PROBE: GitProbeOptions = Object.freeze({
  env: Object.freeze({
    PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  }) as Record<string, string>,
  configArgs: Object.freeze(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]) as string[],
  timeoutMs: 2000,
});

/** A Git probe that could not give an answer. Never read as "not a repository". */
export class GitProbeError extends CurationError {
  override name = "GitProbeError";
  constructor(public readonly reason: "spawn_failed" | "timeout" | "git_error") {
    super("STORAGE_UNAVAILABLE", ["git_probe", reason]);
  }
}

/** Versioned project key: p1_ plus sha256 of the canonical root in UTF-8. */
export function projectIdForRoot(root: string): string {
  return `p1_${createHash("sha256").update(root, "utf8").digest("hex")}`;
}

export interface ProjectResolver {
  world: World;
  config: Config;
  git: GitProbeOptions;
  /** Project ids already recorded for this world: established canonical mappings. */
  storedProjectIds: ReadonlySet<string>;
  cache: Map<string, RootResolution>;
}

export type RootResolution =
  | { state: "resolved"; root: string; worldMatch: "configured" | "catch_all" }
  | { state: "unresolved"; reason: RepoUnresolvedReason };

export type SourceScope = { scope: LessonScope; root: string | null; unresolved: RepoUnresolvedReason | null };

/** The configured world of that name, or INVALID_INPUT. Never a guessed default. */
export function configuredWorld(config: Config, name: string, field = "world"): World {
  const world = config.worlds.find((w) => w.name === name);
  if (world === undefined) throw new CurationError("INVALID_INPUT", [field]);
  return world;
}

export function projectResolver(world: World, config: Config, git: GitProbeOptions = CURATION_GIT_PROBE, storedProjectIds: ReadonlySet<string> = new Set()): ProjectResolver {
  return { world: configuredWorld(config, world.name), config, git, storedProjectIds, cache: new Map() };
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function realDirectory(path: string): string | null {
  const real = realOrNull(path);
  if (real === null) return null;
  try {
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** Configured prefixes of the world, canonical where they exist. */
function prefixesOf(world: World): Array<{ configured: string; real: string | null }> {
  return world.repos.map((repo) => {
    const configured = resolve(paths.expandHome(repo));
    return { configured, real: realDirectory(configured) };
  });
}

/** Which prefix of the world owns `real`, "catch_all", or null when another world owns it. */
function owner(r: ProjectResolver, real: string): string | "catch_all" | null {
  let owning: World;
  try {
    owning = worldForCwd(r.config, real);
  } catch {
    return null;
  }
  if (owning.name !== r.world.name) return null;
  if (r.world.repos.length === 0) return "catch_all";
  let best: string | null = null;
  for (const prefix of prefixesOf(r.world)) {
    const root = prefix.real ?? prefix.configured;
    if (isWithin(real, root) && (best === null || root.length > best.length)) best = root;
  }
  return best;
}

/** Canonical project root for an absolute path, or why there is none. Git runs only after ownership holds. */
export function resolveProjectRoot(r: ProjectResolver, path: string): RootResolution {
  const cached = r.cache.get(path);
  if (cached !== undefined) return cached;
  const result = resolveUncached(r, path);
  r.cache.set(path, result);
  return result;
}

function resolveUncached(r: ProjectResolver, path: string): RootResolution {
  if (!isAbsolute(path)) return { state: "unresolved", reason: "relative_path" };
  const real = realDirectory(path);
  if (real === null) return { state: "unresolved", reason: "missing_root" };
  const own = owner(r, real);
  if (own === null) return { state: "unresolved", reason: "not_owned_by_world" };
  const worldMatch = own === "catch_all" ? "catch_all" : "configured";
  // The Git root found from an owned path is the project, even above the
  // prefix: a prefix decides the world, never the project.
  const probe = probeGitRepositoryRoot(real, { ...r.git, env: r.git.env ?? CURATION_GIT_PROBE.env! });
  if (probe.state === "failed") throw new GitProbeError(probe.reason);
  if (probe.state === "root") {
    const root = realDirectory(probe.root);
    if (root === null) throw new GitProbeError("git_error");
    return { state: "resolved", root, worldMatch };
  }
  if (own === "catch_all") return { state: "unresolved", reason: "no_project_root" };
  // Outside Git the configured root is the project, but only when exactly one
  // configured root holds the path. Nested roots need an explicit choice.
  const holding = new Set(prefixesOf(r.world).flatMap((p) => (p.real !== null && isWithin(real, p.real) ? [p.real] : [])));
  if (holding.size !== 1) return { state: "unresolved", reason: "ambiguous" };
  return { state: "resolved", root: [...holding][0]!, worldMatch };
}

/**
 * Project root for a recorded or submitted path. An owned path resolves
 * directly. An unowned path counts only as an ancestor Git root that an owned
 * configured root resolves to; Git never runs in the unowned path itself.
 */
export function projectRootFor(r: ProjectResolver, path: string): RootResolution {
  const direct = resolveProjectRoot(r, path);
  if (direct.state === "resolved" || direct.reason !== "not_owned_by_world") return direct;
  const real = realDirectory(path)!;
  for (const prefix of prefixesOf(r.world)) {
    if (prefix.real === null || prefix.real === real || !isWithin(prefix.real, real) || owner(r, prefix.real) === null) continue;
    const viaPrefix = resolveProjectRoot(r, prefix.real);
    // Several owned subdirectories of one repository all land here: one project.
    if (viaPrefix.state === "resolved" && viaPrefix.root === real) return viaPrefix;
  }
  return direct;
}

/** Like projectRootFor, but an explicitly chosen configured non-Git root is its own project. */
function chosenRoot(r: ProjectResolver, path: string): RootResolution {
  const found = projectRootFor(r, path);
  if (found.state === "resolved" || found.reason !== "ambiguous") return found;
  const real = realDirectory(path);
  const configured = prefixesOf(r.world).some((p) => p.real !== null && p.real === real);
  return configured && real !== null ? { state: "resolved", root: real, worldMatch: "configured" } : found;
}

const projectScope = (world: string, root: string): LessonScope => ({ world, project: { kind: "project", id: projectIdForRoot(root) } });

/** Scope a legacy source's repo value maps to. The value is data: validated, never run blindly. */
export function sourceScope(r: ProjectResolver, repo: string | null): SourceScope {
  const world = r.world.name;
  if (repo === null) return { scope: { world, project: { kind: "world" } }, root: null, unresolved: null };
  const unresolved = (reason: RepoUnresolvedReason): SourceScope => ({ scope: { world, project: { kind: "unresolved" } }, root: null, unresolved: reason });
  // An empty or relative repo would mean cwd. It never does.
  if (repo.length === 0 || !isAbsolute(repo)) return unresolved("relative_path");
  const found = projectRootFor(r, repo);
  if (found.state === "resolved") return { scope: projectScope(world, found.root), root: found.root, unresolved: null };
  if (found.reason === "missing_root") {
    const id = projectIdForRoot(resolve(repo));
    if (r.storedProjectIds.has(id)) return { scope: { world, project: { kind: "project", id } }, root: null, unresolved: null };
  }
  return unresolved(found.reason);
}

// --- context -----------------------------------------------------------

/** Choices from configured roots alone. No source scan, no store. */
function configuredChoices(r: ProjectResolver): ProjectChoice[] {
  const out: ProjectChoice[] = [];
  const seen = new Set<string>();
  for (const prefix of prefixesOf(r.world)) {
    const resolved = prefix.real === null ? null : chosenRoot(r, prefix.real);
    const id = projectIdForRoot(resolved?.state === "resolved" ? resolved.root : prefix.configured);
    if (seen.has(id)) continue;
    seen.add(id);
    if (resolved !== null && resolved.state === "resolved") {
      out.push({ scope: projectScope(r.world.name, resolved.root), label: resolved.root, root: resolved.root, available: true, origins: ["configured"] });
    } else {
      out.push({
        scope: projectScope(r.world.name, prefix.configured),
        label: `${prefix.configured} (unavailable)`,
        root: null,
        available: false,
        origins: ["configured"],
      });
    }
  }
  return out;
}

function worldWideChoice(world: string): ProjectChoice {
  return { scope: { world, project: { kind: "world" } }, label: "World-wide", root: null, available: true, origins: [] };
}

/**
 * The project a native session at `cwd` would save into, or the reason an
 * explicit choice is needed. Reads only: nothing is recorded about the result.
 */
export function resolveCurationContext(cwd: string, world: World, config: Config = loadConfig(), git: GitProbeOptions = CURATION_GIT_PROBE): CurationContext {
  if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) throw new CurationError("INVALID_INPUT", ["cwd"]);
  const r = projectResolver(world, config, git);
  const real = realDirectory(cwd);
  if (real === null) throw new CurationError("INVALID_INPUT", ["cwd"]);
  const choices = (): ProjectChoice[] => [worldWideChoice(r.world.name), ...configuredChoices(r)];
  if (owner(r, real) === null) return { state: "choice_required", reason: "outside_world", choices: choices() };
  const resolved = resolveProjectRoot(r, real);
  if (resolved.state !== "resolved") {
    return { state: "choice_required", reason: resolved.reason === "ambiguous" ? "ambiguous_root" : "no_project_root", choices: choices() };
  }
  const projectId = projectIdForRoot(resolved.root);
  return {
    state: "resolved",
    scope: { world: r.world.name, project: { kind: "project", id: projectId } },
    project: { world: r.world.name, projectId, root: resolved.root },
    worldMatch: resolved.worldMatch,
    requiresConfirmation: resolved.worldMatch === "catch_all",
  };
}

// --- choices -----------------------------------------------------------

/** Distinct non-purged scopes recorded for the world. */
export function storedScopes(db: CurationDatabase | null, world: string): LessonScope[] {
  if (db === null) return [];
  const rows = db.sqlite
    .query("SELECT DISTINCT project_kind, project_id FROM records WHERE world = ? AND purged = 0 ORDER BY project_kind, project_id")
    .all(world) as Array<{ project_kind: string; project_id: string | null }>;
  return rows.map((row) => scopeFromRow(world, row.project_kind, row.project_id));
}

/** Ids of purged inbox records: their sources stay hidden from curation. */
function purgedInboxIds(db: CurationDatabase | null, world: string): Set<string> {
  if (db === null) return new Set();
  const rows = db.sqlite.query("SELECT id_json FROM records WHERE world = ? AND kind = 'inbox' AND purged = 1").all(world) as Array<{ id_json: string }>;
  return new Set(rows.map((row) => decodeRecordId(row.id_json)));
}

/** Decode a stored scope. Anything the schema would not have written is damage. */
export function scopeFromRow(world: string, kind: string, id: string | null): LessonScope {
  if (kind === "world" && id === null) return { world, project: { kind: "world" } };
  if (kind === "unresolved" && id === null) return { world, project: { kind: "unresolved" } };
  if (kind === "project" && typeof id === "string" && PROJECT_ID_RE.test(id)) return { world, project: { kind: "project", id } };
  throw new CurationError("STORAGE_UNAVAILABLE", ["database_invalid"]);
}

export interface CurationProjectOptions {
  config?: Config;
  git?: GitProbeOptions;
}

/**
 * Project choices for an explicit picker: configured roots, validated
 * same-world source repos and stored scopes. World-wide first, Unresolved last.
 */
export function listCurationProjects(world: World, binding: StoreBinding, options: CurationProjectOptions = {}): CurationReadResult<ProjectChoice[]> {
  const config = options.config ?? loadConfig();
  const name = configuredWorld(config, world.name).name;
  const handle = openCurationStoreForRead(binding);
  try {
    const stored = storedScopes(handle.db, name);
    const storedIds = new Set(stored.flatMap((s) => (s.project.kind === "project" ? [s.project.id] : [])));
    const r = projectResolver(world, config, options.git ?? CURATION_GIT_PROBE, storedIds);
    const projects = new Map<string, ProjectChoice>();
    const add = (id: string, origin: ProjectChoiceOrigin, make: () => ProjectChoice): void => {
      const existing = projects.get(id);
      if (existing === undefined) projects.set(id, make());
      else if (!existing.origins.includes(origin)) existing.origins.push(origin);
    };
    for (const choice of configuredChoices(r)) add((choice.scope.project as { id: string }).id, "configured", () => choice);

    let unresolved = stored.some((s) => s.project.kind === "unresolved");
    const scan = scanLegacySources(name);
    const purged = purgedInboxIds(handle.db, name);
    for (const [sourceId, seen] of scan.sources) {
      // A tombstoned lesson's repo is not offered as a choice either.
      if (purged.has(sourceId)) continue;
      if (seen.state !== "present" && seen.state !== "conflict") continue;
      const mapped = sourceScope(r, seen.state === "present" ? seen.snapshot.lesson.repo : seen.copies[0]!.repo);
      if (mapped.scope.project.kind === "unresolved") unresolved = true;
      if (mapped.scope.project.kind !== "project") continue;
      const id = mapped.scope.project.id;
      const root = mapped.root;
      add(id, "source", () => ({
        scope: mapped.scope,
        label: root ?? unavailableLabel(id),
        root,
        available: root !== null,
        origins: ["source"],
      }));
    }
    for (const scope of stored) {
      if (scope.project.kind !== "project") continue;
      const id = scope.project.id;
      add(id, "stored", () => ({ scope, label: unavailableLabel(id), root: null, available: false, origins: ["stored"] }));
    }

    const order: ProjectChoiceOrigin[] = ["configured", "source", "stored"];
    const sorted = [...projects.values()]
      .map((choice) => ({ ...choice, origins: order.filter((o) => choice.origins.includes(o)) }))
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    const value = [worldWideChoice(name), ...sorted];
    if (unresolved) value.push({ scope: { world: name, project: { kind: "unresolved" } }, label: "Unresolved", root: null, available: true, origins: [] });
    return boundedResult({ store: handle.identity, value });
  } finally {
    handle.db?.close();
  }
}

function unavailableLabel(id: string): string {
  return `Unavailable project ${id.slice(0, 11)}`;
}

// --- write-side validation ----------------------------------------------

export interface ScopeValidationInput {
  world: World;
  config: Config;
  scope: LessonScope;
  key: LessonKey;
  /** For an inbox key: the snapshot the first annotation will use. */
  source?: LegacySourceSnapshot | null;
  /** For a capture into a project: the root to revalidate. Never reversed from the id. */
  projectRoot?: string | null;
  storedProjectIds?: ReadonlySet<string>;
  git?: GitProbeOptions;
}

/**
 * The one scope check for a first annotation or a capture. Returns the scope
 * unchanged when it holds; otherwise SCOPE_CONFLICT, SOURCE_CONFLICT or INVALID_INPUT.
 */
export function validateCurationScope(input: ScopeValidationInput): LessonScope {
  const world = configuredWorld(input.config, input.world.name);
  const { scope, key } = input;
  if (scope?.world !== world.name || key?.world !== world.name) throw new CurationError("SCOPE_CONFLICT", ["scope.world"]);
  const project = scope.project;
  const shapeOk =
    project?.kind === "world" || project?.kind === "unresolved" || (project?.kind === "project" && typeof project.id === "string" && PROJECT_ID_RE.test(project.id));
  if (!shapeOk) throw new CurationError("INVALID_INPUT", ["scope.project"]);
  const r = projectResolver(world, input.config, input.git ?? CURATION_GIT_PROBE, input.storedProjectIds ?? new Set());

  if (key.kind === "inbox") {
    const source = input.source;
    if (source === null || source === undefined || source.lesson.world !== key.world || source.lesson.id !== key.id) {
      throw new CurationError("SOURCE_CONFLICT", ["source"]);
    }
    const expected = sourceScope(r, source.lesson.repo).scope;
    if (!sameScope(expected, scope)) throw new CurationError("SCOPE_CONFLICT", ["scope"]);
    return scope;
  }

  // A new capture never lands in an unresolved scope.
  if (project.kind === "unresolved") throw new CurationError("INVALID_INPUT", ["scope.project"]);
  if (project.kind === "world") return scope;
  const root = input.projectRoot;
  if (typeof root !== "string" || root.length === 0 || !isAbsolute(root)) throw new CurationError("INVALID_INPUT", ["projectRoot"]);
  const resolved = chosenRoot(r, root);
  if (resolved.state !== "resolved" || projectIdForRoot(resolved.root) !== project.id) throw new CurationError("SCOPE_CONFLICT", ["scope.project"]);
  return scope;
}

export function sameScope(a: LessonScope, b: LessonScope): boolean {
  if (a.world !== b.world || a.project.kind !== b.project.kind) return false;
  return a.project.kind !== "project" || a.project.id === (b.project as { id: string }).id;
}
