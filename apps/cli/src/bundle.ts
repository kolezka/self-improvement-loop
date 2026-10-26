// sil export / sil import bundle: move a whole install to another host.
//
// The bundle carries what the loop created and nothing the host owns:
// config.yaml, llm.yaml, and per world the reflections, aliases, scorecards,
// inbox and the built-in learned repo with its review branches, plus the
// usage and feedback history the scorecards are rebuilt from.
//
// Credentials stay behind. llm.yaml names an env var, never a key, and no
// other file in the config dir is read, so an `env` file an operator keeps
// next to it never travels. The new host sets its own secrets.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { assertOneHop, type Config, isSlug, ValidationError, fsx, loadConfig, paths, saveConfig, targetRoot, writeHookSnapshot } from "@sil/core";
import { git } from "@sil/curriculum";
import { loadAliasesStrict, saveAliases } from "@sil/store";
import { exportJsonl, replaceStream, type Stream } from "@sil/statedb";
import { mergeWorlds } from "./importer.ts";

export const BUNDLE_VERSION = 1;

export const BundleWorld = z.object({
  name: z.string(),
  /** The world's target repo, `~`-relative, or null for the built-in one. */
  target: z.string().nullable().default(null),
  /** True when the built-in learned repo travels inside the bundle. */
  learned_repo: z.boolean().default(false),
  reflections: z.number().int().default(0),
});
export type BundleWorld = z.infer<typeof BundleWorld>;

export const BundleManifest = z.object({
  version: z.number().int(),
  created_at: z.string(),
  worlds: z.array(BundleWorld),
  /** False when the operator exported with --no-history. */
  history: z.boolean().default(true),
});
export type BundleManifest = z.infer<typeof BundleManifest>;

export function isArchivePath(p: string): boolean {
  return /\.(tar\.gz|tgz)$/i.test(p);
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Byte count for a human: "512 B", "2.0 KB", "5.0 MB". */
export function humanBytes(n: number): string {
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

function toPortable(p: string, home: string): string {
  if (p === home) return "~";
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** Config with every path under $HOME written as `~/...`, so a bundle made in
 * /home/me restores under /Users/me. `paths.expandHome` reverses it, and
 * `worldForCwd` and `targetRoot` already run every stored path through it. */
export function portableConfig(cfg: Config, home: string = homedir()): Config {
  return {
    ...cfg,
    worlds: cfg.worlds.map((w) => ({
      ...w,
      repos: w.repos.map((r) => toPortable(r, home)),
      target: w.target === null ? null : toPortable(w.target, home),
      llm_config: w.llm_config === null ? null : toPortable(w.llm_config, home),
    })),
  };
}

// --- copying ------------------------------------------------------------

export interface CopyStats {
  files: number;
  bytes: number;
  skipped: number;
}

function blank(): CopyStats {
  return { files: 0, bytes: 0, skipped: 0 };
}

function add(into: CopyStats, other: CopyStats): void {
  into.files += other.files;
  into.bytes += other.bytes;
  into.skipped += other.skipped;
}

/** Copy one file. `overwrite: false` leaves an existing destination alone and
 * counts it as skipped, which is what an import onto a live host needs. */
export function copyOne(src: string, dest: string, overwrite = true): CopyStats {
  const out = blank();
  if (!existsSync(src)) return out;
  if (!overwrite && existsSync(dest)) {
    out.skipped = 1;
    return out;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  out.files = 1;
  out.bytes = statSync(dest).size;
  return out;
}

/** Copy a directory tree, files and symlink targets alike. Directories that do
 * not exist are not an error: a world with no inbox yet is normal. */
export function copyTree(src: string, dest: string, overwrite = true): CopyStats {
  const out = blank();
  let entries: string[];
  try {
    entries = readdirSync(src).sort();
  } catch {
    return out;
  }
  mkdirSync(dest, { recursive: true });
  for (const name of entries) {
    const from = join(src, name);
    const to = join(dest, name);
    let st;
    try {
      st = statSync(from);
    } catch {
      continue;
    }
    add(out, st.isDirectory() ? copyTree(from, to, overwrite) : copyOne(from, to, overwrite));
  }
  return out;
}

export function treeSize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { files, bytes };
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const sub = treeSize(full);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += st.size;
    }
  }
  return { files, bytes };
}

function isEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

function runTar(args: string[]): void {
  const proc = Bun.spawnSync(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    const detail = proc.stderr.toString().trim().split("\n")[0] ?? `exit ${proc.exitCode}`;
    throw new ValidationError(`tar failed: ${detail}`);
  }
}

// --- logs ---------------------------------------------------------------

/** A loop-state stream at its bundle path, with the world for a per-world one. */
interface BundleLog {
  stream: Stream;
  world?: string;
  rel: string;
}

/** The streams a bundle carries for these worlds, at the paths and in the line
 * format older bundles used. hook-runs.jsonl is left out on purpose: about 90%
 * of the volume and no scorecard reads it. */
function bundleLogs(worlds: string[]): BundleLog[] {
  return [
    { stream: "human", rel: join("state", "feedback", "human.jsonl") },
    { stream: "critic", rel: join("state", "feedback", "critic.jsonl") },
    { stream: "usage_events", rel: join("state", "usage", "events.jsonl") },
    { stream: "nudge_fires", rel: join("state", "usage", "nudge-fires.jsonl") },
    ...worlds.map((world): BundleLog => ({ stream: "payload_samples", world, rel: join("state", "usage", "payloads", `${paths.safeComponent(world)}.jsonl`) })),
  ];
}

/** Load one bundle log into loop state. Same counts as copyOne: a stream the
 * host already has rows in is skipped unless `force`, since appending would
 * double every event the host already counted. Quarantined lines become a warning. */
function restoreLog(file: string, source: string, log: BundleLog, force: boolean, warnings: string[]): CopyStats {
  const out = blank();
  if (!existsSync(file)) return out;
  const text = readFileSync(file, "utf8");
  const result = replaceStream(log.stream, text, source, force, log.world);
  if (!result.written) out.skipped = 1;
  else {
    out.files = 1;
    out.bytes = Buffer.byteLength(text);
  }
  const bad = result.quarantined;
  const name = log.world === undefined ? basename(file) : `${basename(file)} (world ${log.world})`;
  if (bad > 0) warnings.push(`${name}: ${bad} ${bad === 1 ? "line" : "lines"} could not be imported; see sil state quarantine`);
  return out;
}

// --- aliases ------------------------------------------------------------

/** A bundle aliases file as a one-hop map of names, or why it is not one. */
function checkBundleAliases(text: string): { map: Record<string, string> } | { reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: "not JSON" };
  }
  const notNames = { reason: "not a map of pattern names" };
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return notNames;
  const map: Record<string, string> = {};
  for (const [alias, canonical] of Object.entries(parsed)) {
    if (typeof canonical !== "string" || !isSlug(alias) || !isSlug(canonical)) return notNames;
    map[alias] = canonical;
  }
  try {
    assertOneHop(map);
  } catch (error) {
    if (error instanceof ValidationError) return { reason: error.message };
    throw error;
  }
  return { map };
}

/** Load one world's bundle aliases through saveAliases. A file that is not a
 * one-hop map of names becomes a warning and writes nothing, checked before the
 * host is read. A valid map follows copyOne's counts: a world the host already
 * has aliases for is skipped unless `force`. */
function restoreAliases(file: string, world: string, force: boolean, warnings: string[]): CopyStats {
  const out = blank();
  if (!existsSync(file)) return out;
  const text = readFileSync(file, "utf8");
  const notImported = (reason: string): CopyStats => {
    warnings.push(`aliases.json (world ${world}): not imported (${reason})`);
    return out;
  };
  const checked = checkBundleAliases(text);
  if ("reason" in checked) return notImported(checked.reason);
  if (!force && Object.keys(loadAliasesStrict(world)).length > 0) {
    out.skipped = 1;
    return out;
  }
  try {
    // replaceAliases checks the one-hop rule again; it is the write point every caller passes.
    saveAliases(world, checked.map);
  } catch (error) {
    if (error instanceof ValidationError) return notImported(error.message);
    throw error;
  }
  out.files = 1;
  out.bytes = Buffer.byteLength(text);
  return out;
}

// --- export -------------------------------------------------------------

export interface ExportOptions {
  dest: string;
  /** Names to export; every world when empty. */
  worlds?: string[];
  /** Usage, feedback and inbox files. Default true. */
  history?: boolean;
  force?: boolean;
}

export interface ExportResult {
  path: string;
  archive: boolean;
  files: number;
  bytes: number;
  manifest: BundleManifest;
  /** Things the bundle deliberately leaves behind, for the operator to move. */
  warnings: string[];
}

function selectWorlds(cfg: Config, names: string[] | undefined): Config {
  if (!names || names.length === 0) return cfg;
  const known = new Set(cfg.worlds.map((w) => w.name));
  const missing = names.filter((n) => !known.has(n));
  if (missing.length > 0) throw new ValidationError(`unknown world(s): ${missing.join(", ")}`);
  return { ...cfg, worlds: cfg.worlds.filter((w) => names.includes(w.name)) };
}

function stageExport(
  work: string,
  cfg: Config,
  aliases: Map<string, Record<string, string>>,
  logs: Map<string, string> | null,
): { manifest: BundleManifest; warnings: string[] } {
  const history = logs !== null;
  const warnings: string[] = [];
  mkdirSync(join(work, "config"), { recursive: true });
  saveConfig(portableConfig(cfg), join(work, "config", "config.yaml"));
  copyOne(paths.llmFile(), join(work, "config", "llm.yaml"));

  const worlds: BundleWorld[] = [];
  for (const world of cfg.worlds) {
    const slot = join(work, "worlds", paths.safeComponent(world.name));
    const reflections = copyTree(paths.reflectionsDir(world.name), join(slot, "reflections"));
    const map = aliases.get(world.name) ?? {};
    // Sorted by alias, as saveAliases stores it; a world with no aliases writes no file.
    if (Object.keys(map).length > 0) fsx.writeJson(join(slot, "aliases.json"), map);
    copyOne(paths.scorecardsFile(world.name), join(slot, "scorecards.json"));

    // An external target is the operator's own repo with its own remote, so it
    // stays put. Only the built-in learned/ repo travels.
    const builtin = world.target === null;
    if (builtin) copyTree(targetRoot(world), join(slot, "learned"));
    else warnings.push(`world ${world.name}: target ${world.target} is outside sil and is not in the bundle; move or re-clone it yourself`);
    if (world.llm_config !== null) warnings.push(`world ${world.name}: llm_config ${world.llm_config} is not in the bundle; copy it yourself`);

    if (history) copyTree(paths.inboxDir(world.name), join(work, "state", "inbox", paths.safeComponent(world.name)));

    worlds.push(BundleWorld.parse({
      name: world.name,
      target: portableConfig({ ...cfg, worlds: [world] }).worlds[0]!.target,
      learned_repo: builtin && !isEmptyDir(join(slot, "learned")),
      reflections: reflections.files,
    }));
  }

  if (history) {
    for (const [rel, text] of logs) {
      mkdirSync(dirname(join(work, rel)), { recursive: true });
      writeFileSync(join(work, rel), text);
    }
  }

  const manifest = BundleManifest.parse({
    version: BUNDLE_VERSION,
    created_at: fsx.nowIso(),
    worlds,
    history,
  });
  fsx.writeJson(join(work, "manifest.json"), manifest);
  return { manifest, warnings };
}

export function exportBundle(opts: ExportOptions): ExportResult {
  const dest = paths.expandHome(opts.dest);
  const archive = isArchivePath(dest);
  const history = opts.history !== false;

  if (existsSync(dest) && !opts.force) {
    if (archive || !isEmptyDir(dest)) throw new ValidationError(`${dest} already exists; pass --force to overwrite it`);
  }

  const cfg = selectWorlds(loadConfig(), opts.worlds);
  if (cfg.worlds.length === 0) throw new ValidationError("nothing to export: config.yaml has no worlds");

  // Read the aliases and logs before touching dest: a store that refuses to
  // export (quarantined lines, an unreadable map) must leave no half-written bundle behind.
  const aliases = new Map(cfg.worlds.map((w) => [w.name, loadAliasesStrict(w.name)]));
  let logs: Map<string, string> | null = null;
  if (history) {
    logs = new Map();
    // A stream with no rows writes no file, as an absent log file did before.
    for (const log of bundleLogs(cfg.worlds.map((w) => w.name))) {
      const text = exportJsonl(log.stream, log.world);
      if (text !== null) logs.set(log.rel, text);
    }
  }

  const work = archive ? mkdtempSync(join(tmpdir(), "sil-export-")) : dest;
  try {
    if (!archive && existsSync(dest) && opts.force) rmSync(dest, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const { manifest, warnings } = stageExport(work, cfg, aliases, logs);
    const size = treeSize(work);
    if (archive) {
      mkdirSync(dirname(dest), { recursive: true });
      rmSync(dest, { force: true });
      runTar(["-czf", dest, "-C", work, "."]);
    }
    const bytes = archive ? statSync(dest).size : size.bytes;
    return { path: dest, archive, files: size.files, bytes, manifest, warnings };
  } finally {
    if (archive) rmSync(work, { recursive: true, force: true });
  }
}

// --- import -------------------------------------------------------------

export function readManifest(root: string): BundleManifest {
  const p = join(root, "manifest.json");
  if (!existsSync(p)) throw new ValidationError(`${root} is not a sil bundle: manifest.json is missing`);
  const parsed = BundleManifest.safeParse(fsx.readJsonOr<unknown>(p, null));
  if (!parsed.success) throw new ValidationError(`${p} is not a valid bundle manifest`);
  if (parsed.data.version !== BUNDLE_VERSION) {
    throw new ValidationError(`bundle version ${parsed.data.version} is not supported; this sil reads version ${BUNDLE_VERSION}`);
  }
  return parsed.data;
}

export interface ImportOptions {
  src: string;
  /** Names to restore; every world in the bundle when empty. */
  worlds?: string[];
  /** Overwrite host files that already exist. Off by default: the host wins. */
  force?: boolean;
}

export interface ImportResult {
  path: string;
  archive: boolean;
  worlds: string[];
  addedWorlds: number;
  files: number;
  skipped: number;
  warnings: string[];
}

/** Recreate the dirs the engine expects, the same set `sil init` makes. */
export function ensureRuntimeDirs(cfg: Config): void {
  for (const world of cfg.worlds) {
    if (world.target === null && !git.isRepo(targetRoot(world))) git.ensureRepo(targetRoot(world));
    fsx.ensureDir(paths.reflectionsDir(world.name));
    fsx.ensureDir(paths.inboxDir(world.name));
  }
  for (const bucket of ["pending", "done", "failed"] as const) fsx.ensureDir(paths.queueDir(bucket));
  for (const sub of ["logs", "sessions", "usage", "feedback"]) fsx.ensureDir(join(paths.stateDir(), sub));
}

/** `source` is the bundle as the operator named it, for quarantine rows. */
function restore(root: string, source: string, manifest: BundleManifest, opts: ImportOptions): ImportResult {
  const bundleCfg = loadConfig(join(root, "config", "config.yaml"));
  const wanted = opts.worlds && opts.worlds.length > 0 ? opts.worlds : manifest.worlds.map((w) => w.name);
  const known = new Set(bundleCfg.worlds.map((w) => w.name));
  const missing = wanted.filter((n) => !known.has(n));
  if (missing.length > 0) throw new ValidationError(`bundle has no world(s): ${missing.join(", ")}`);
  const worlds = bundleCfg.worlds.filter((w) => wanted.includes(w.name));

  // A host with no config.yaml takes the bundle's wholesale, promotion
  // thresholds and web settings included. A live host keeps its own and only
  // gains the worlds it is missing.
  const fresh = !fsx.exists(paths.configFile());
  const cfg = fresh ? { ...bundleCfg, worlds: [...worlds] } : loadConfig();
  const addedWorlds = fresh ? worlds.length : mergeWorlds(cfg, worlds);

  const stats = blank();
  const warnings: string[] = [];
  add(stats, copyOne(join(root, "config", "llm.yaml"), paths.llmFile(), opts.force === true));

  for (const world of worlds) {
    const slot = join(root, "worlds", paths.safeComponent(world.name));
    // Reflections are append-only. A same-named file on the host is the same
    // reflection, so it is never overwritten, not even with --force.
    add(stats, copyTree(join(slot, "reflections"), paths.reflectionsDir(world.name), false));
    add(stats, restoreAliases(join(slot, "aliases.json"), world.name, opts.force === true, warnings));
    add(stats, copyOne(join(slot, "scorecards.json"), paths.scorecardsFile(world.name), opts.force === true));

    const learned = join(slot, "learned");
    if (existsSync(learned)) {
      const dest = targetRoot(world);
      // Copying into a live repo would mix two histories. Refuse unless the
      // operator says otherwise, and say which repo is in the way.
      if (!isEmptyDir(dest) && opts.force !== true) {
        warnings.push(`world ${world.name}: ${dest} is not empty, so its learned repo was not restored; pass --force to overwrite it`);
      } else {
        if (opts.force === true) rmSync(dest, { recursive: true, force: true });
        add(stats, copyTree(learned, dest, true));
      }
    }
    if (world.target !== null) warnings.push(`world ${world.name}: target ${world.target} is outside sil; clone or copy it yourself`);
    if (world.llm_config !== null) warnings.push(`world ${world.name}: llm_config ${world.llm_config} is not in the bundle; copy it yourself`);

    add(stats, copyTree(join(root, "state", "inbox", paths.safeComponent(world.name)), paths.inboxDir(world.name), false));
  }

  // A bundle payloads/<w>.jsonl restores into world <w> of the bundle's world list.
  for (const log of bundleLogs(worlds.map((w) => w.name))) {
    const where = root === source ? join(source, log.rel) : `${source}:${log.rel}`;
    add(stats, restoreLog(join(root, log.rel), where, log, opts.force === true, warnings));
  }

  saveConfig(cfg);
  ensureRuntimeDirs(cfg);
  writeHookSnapshot(cfg);
  return { path: root, archive: false, worlds: worlds.map((w) => w.name), addedWorlds, files: stats.files, skipped: stats.skipped, warnings };
}

export function importBundle(opts: ImportOptions): ImportResult {
  const src = paths.expandHome(opts.src);
  if (!existsSync(src)) throw new ValidationError(`no such bundle: ${src}`);
  const archive = isArchivePath(src);
  if (!archive) return { ...restore(src, src, readManifest(src), opts), path: src, archive };

  const work = mkdtempSync(join(tmpdir(), "sil-import-"));
  try {
    runTar(["-xzf", src, "-C", work]);
    return { ...restore(work, src, readManifest(work), opts), path: src, archive };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
