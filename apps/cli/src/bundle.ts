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

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type Config, ValidationError, fsx, loadConfig, paths, saveConfig, targetRoot, writeHookSnapshot } from "@sil/core";
import { git } from "@sil/curriculum";
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

function stageExport(work: string, cfg: Config, history: boolean): { manifest: BundleManifest; warnings: string[] } {
  const warnings: string[] = [];
  mkdirSync(join(work, "config"), { recursive: true });
  saveConfig(portableConfig(cfg), join(work, "config", "config.yaml"));
  copyOne(paths.llmFile(), join(work, "config", "llm.yaml"));

  const worlds: BundleWorld[] = [];
  for (const world of cfg.worlds) {
    const slot = join(work, "worlds", paths.safeComponent(world.name));
    const reflections = copyTree(paths.reflectionsDir(world.name), join(slot, "reflections"));
    copyOne(paths.aliasesFile(world.name), join(slot, "aliases.json"));
    copyOne(paths.scorecardsFile(world.name), join(slot, "scorecards.json"));

    // An external target is the operator's own repo with its own remote, so it
    // stays put. Only the built-in learned/ repo travels.
    const builtin = world.target === null;
    if (builtin) copyTree(targetRoot(world), join(slot, "learned"));
    else warnings.push(`world ${world.name}: target ${world.target} is outside sil and is not in the bundle; move or re-clone it yourself`);
    if (world.llm_config !== null) warnings.push(`world ${world.name}: llm_config ${world.llm_config} is not in the bundle; copy it yourself`);

    if (history) copyTree(paths.inboxDir(world.name), join(work, "state", "inbox", paths.safeComponent(world.name)));
    if (history) copyOne(paths.payloadSamplesFile(world.name), join(work, "state", "usage", "payloads", `${paths.safeComponent(world.name)}.jsonl`));

    worlds.push(BundleWorld.parse({
      name: world.name,
      target: portableConfig({ ...cfg, worlds: [world] }).worlds[0]!.target,
      learned_repo: builtin && !isEmptyDir(join(slot, "learned")),
      reflections: reflections.files,
    }));
  }

  if (history) {
    // hook-runs.jsonl is left out on purpose: about 90% of the volume and no
    // scorecard reads it.
    copyOne(paths.usageEventsFile(), join(work, "state", "usage", "events.jsonl"));
    copyOne(paths.nudgeFiresFile(), join(work, "state", "usage", "nudge-fires.jsonl"));
    copyOne(paths.humanFeedbackFile(), join(work, "state", "feedback", "human.jsonl"));
    copyOne(paths.criticFeedbackFile(), join(work, "state", "feedback", "critic.jsonl"));
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

  const work = archive ? mkdtempSync(join(tmpdir(), "sil-export-")) : dest;
  try {
    if (!archive && existsSync(dest) && opts.force) rmSync(dest, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const { manifest, warnings } = stageExport(work, cfg, history);
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

function restore(root: string, manifest: BundleManifest, opts: ImportOptions): ImportResult {
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
    add(stats, copyOne(join(slot, "aliases.json"), paths.aliasesFile(world.name), opts.force === true));
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
    add(stats, copyOne(join(root, "state", "usage", "payloads", `${paths.safeComponent(world.name)}.jsonl`), paths.payloadSamplesFile(world.name), opts.force === true));
  }

  // Whole-file copies, never appends: appending would double every usage event
  // the host already counted.
  const pairs: [string, string][] = [
    [join(root, "state", "usage", "events.jsonl"), paths.usageEventsFile()],
    [join(root, "state", "usage", "nudge-fires.jsonl"), paths.nudgeFiresFile()],
    [join(root, "state", "feedback", "human.jsonl"), paths.humanFeedbackFile()],
    [join(root, "state", "feedback", "critic.jsonl"), paths.criticFeedbackFile()],
  ];
  for (const [from, to] of pairs) add(stats, copyOne(from, to, opts.force === true));

  saveConfig(cfg);
  ensureRuntimeDirs(cfg);
  writeHookSnapshot(cfg);
  return { path: root, archive: false, worlds: worlds.map((w) => w.name), addedWorlds, files: stats.files, skipped: stats.skipped, warnings };
}

export function importBundle(opts: ImportOptions): ImportResult {
  const src = paths.expandHome(opts.src);
  if (!existsSync(src)) throw new ValidationError(`no such bundle: ${src}`);
  const archive = isArchivePath(src);
  if (!archive) return { ...restore(src, readManifest(src), opts), path: src, archive };

  const work = mkdtempSync(join(tmpdir(), "sil-import-"));
  try {
    runTar(["-xzf", src, "-C", work]);
    return { ...restore(work, readManifest(work), opts), path: src, archive };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
