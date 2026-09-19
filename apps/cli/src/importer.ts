// Import V1 data into the v2 layout: worlds.yaml, reflection mirrors, ledgers.
//
// V1 (dotfiles-next) kept worlds in a manifest read by `kb list`, reflections
// in a flat markdown mirror, and one ledger per repo. This module is the
// one-time bridge from that shape into sil's config and data dirs. It never
// runs on a schedule and never deletes the V1 source.
//
// The payload backfill below is the same kind of one-time bridge, from Claude
// Code's own session transcripts into the hook's payload sample file.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { type Config, type World, Layout, World as WorldSchema, fsx, ledgerPath, paths, samples, worldForCwd } from "@sil/core";
import { parseLedger, reflectionPattern, saveLedger } from "@sil/store";
import { iterRecords } from "@sil/transcript";

export interface ImportReflectionsResult {
  copied: number;
  skippedDuplicate: number;
  skippedNonReflection: number;
}

function walkFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    let entries: string[];
    try {
      entries = readdirSync(p).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(p, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(suffix)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Copy V1 mirror reflection docs into the world's reflections dir. A file
 * counts as a reflection when it has a `Pattern:` line. Filenames are kept;
 * a file already present at the destination is skipped (reflections are
 * append-only, never overwritten). */
export function importReflections(dir: string, world: string): ImportReflectionsResult {
  const src = paths.expandHome(dir);
  const dest = paths.reflectionsDir(world);
  mkdirSync(dest, { recursive: true });

  let copied = 0;
  let skippedDuplicate = 0;
  let skippedNonReflection = 0;
  for (const p of walkFiles(src, ".md")) {
    const text = fsx.readTextOr(p, "");
    if (!reflectionPattern(text)) {
      skippedNonReflection++;
      continue;
    }
    const target = join(dest, relative(src, p));
    if (existsSync(target)) {
      skippedDuplicate++;
      continue;
    }
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(p, target);
    copied++;
  }
  return { copied, skippedDuplicate, skippedNonReflection };
}

/** Map a V1 `promotions.json` (list or dict shaped) into the world's ledger.
 * `store.parseLedger` already understands the V1 list shape; this reads at
 * the source path and writes at the world's own ledger path. Returns the
 * entry count. */
export function importLedger(file: string, world: World): number {
  const src = paths.expandHome(file);
  const ledger = parseLedger(fsx.readText(src), src);
  saveLedger(ledgerPath(world), ledger);
  return Object.keys(ledger.entries).length;
}

interface V1Project {
  repo?: string;
}
interface V1World {
  name: string;
  llm?: string;
  projects?: V1Project[];
}

const KbManifest = z.object({ worlds: z.array(WorldSchema) });

/** Read a V1 `kb list` manifest and return one sil World per V1 world. Each
 * V1 project's `repo` becomes a `repos` prefix. No `target` is set: an
 * imported world writes artifacts into the built-in `learned/` repo until an
 * operator points it at a real target with `sil worlds add --target`. */
export function importKbWorlds(path: string): World[] {
  const text = fsx.readText(paths.expandHome(path));
  const raw = (YAML.parse(text) ?? {}) as { worlds?: V1World[] };
  const mapped = (raw.worlds ?? []).map((w) => ({
    name: w.name,
    llm: w.llm ?? "cloud",
    repos: (w.projects ?? []).filter((p) => p.repo).map((p) => paths.expandHome(p.repo!)),
    target: null,
    layout: Layout.parse({}),
  }));
  // Parsed as one list rather than world by world so a rejected entry reports
  // its position: worlds[2].name, not name.
  return KbManifest.parse({ worlds: mapped }).worlds;
}

// --- payload samples ----------------------------------------------------

export interface ImportPayloadsOptions {
  days: number;
  projectsDir?: string;
  now?: Date;
}

export interface ImportPayloadsResult {
  files: number;
  /** tool_use blocks seen, before dedupe and before the world check */
  records: number;
  /** world -> lines appended */
  written: Record<string, number>;
  skippedNoWorld: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v ? v : fallback;
}

/** Backfill the hook's payload sample file from Claude Code session
 * transcripts under `~/.claude/projects`.
 *
 * The router proves a drafted gate by running it over recorded payloads, so on
 * a machine that ran the loop before the sampler existed the file is empty and
 * every drafted hook is downgraded to a rule. The transcripts already hold the
 * same tool_use blocks, so one pass over them rebuilds the corpus. Records are
 * written through `samples.sampleRecord`, the same allowlist and redaction the
 * hook uses. */
export function importPayloadSamples(cfg: Config, opts: ImportPayloadsOptions): ImportPayloadsResult {
  const root = opts.projectsDir ? paths.expandHome(opts.projectsDir) : join(paths.claudeConfigDir(), "projects");
  const cutoff = (opts.now ?? new Date()).getTime() - opts.days * DAY_MS;

  const recent: { path: string; mtimeMs: number }[] = [];
  for (const path of walkFiles(root, ".jsonl")) {
    const mtimeMs = fsx.mtimeMs(path);
    if (mtimeMs === null || mtimeMs < cutoff) continue;
    recent.push({ path, mtimeMs });
  }
  // Oldest first so the newest samples land at the end of the file: rotation
  // keeps the tail, and the router reads the newest lines.
  recent.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const result: ImportPayloadsResult = { files: recent.length, records: 0, written: {}, skippedNoWorld: 0 };
  // Buffered per world and written once at the end. Appending as we go cost
  // 24k writes on one machine for a file that rotation then cut to 2k lines.
  const recordsByWorld = new Map<string, samples.PayloadSample[]>();
  // worldForCwd calls realpath per configured repo, and one transcript repeats
  // the same cwd on every record.
  const worldByCwd = new Map<string, string | null>();
  const worldFor = (cwd: string): string | null => {
    if (!cwd) return null;
    const cached = worldByCwd.get(cwd);
    if (cached !== undefined) return cached;
    let name: string | null;
    try {
      name = worldForCwd(cfg, cwd).name;
    } catch {
      // ConfigError: no world owns this path and there is no catch-all
      name = null;
    }
    worldByCwd.set(cwd, name);
    return name;
  };

  for (const file of recent) {
    const fileTs = new Date(file.mtimeMs).toISOString();
    try {
      for (const rec of iterRecords(file.path)) {
        if (rec["type"] !== "assistant") continue;
        const message = rec["message"];
        if (!isRecord(message) || !Array.isArray(message["content"])) continue;

        const ts = stringOr(rec["timestamp"], fileTs);
        const sessionId = stringOr(rec["sessionId"], stringOr(rec["session_id"], "unknown"));
        const world = worldFor(stringOr(rec["cwd"], ""));

        for (const block of message["content"]) {
          if (!isRecord(block) || block["type"] !== "tool_use" || typeof block["name"] !== "string") continue;
          result.records += 1;
          if (world === null) {
            result.skippedNoWorld += 1;
            continue;
          }
          const record = samples.sampleRecord(
            { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: block["name"], tool_input: block["input"] },
            ts,
          );
          if (!record) continue;
          let bucket = recordsByWorld.get(world);
          if (!bucket) {
            bucket = [];
            recordsByWorld.set(world, bucket);
          }
          bucket.push(record);
        }
      }
    } catch {
      // one unreadable transcript is not a failed import
      continue;
    }
  }

  for (const [world, bucket] of recordsByWorld) {
    const kept = newestDistinct(bucket, samples.SAMPLES_KEEP_LINES);
    for (const record of kept) {
      fsx.appendLine(paths.payloadSamplesFile(world), JSON.stringify(record), samples.SAMPLES_ROTATE_AT_BYTES, samples.SAMPLES_KEEP_LINES);
    }
    result.written[world] = kept.length;
  }
  return result;
}

/** The newest `limit` records with a distinct (tool_name, tool_input) shape,
 * oldest first.
 *
 * Deduped from the newest end: a thousand `git status` calls say the same
 * thing about a gate, and keeping the oldest copy would let a common shape
 * fall out of the tail the router reads. */
function newestDistinct(records: samples.PayloadSample[], limit: number): samples.PayloadSample[] {
  const seen = new Set<string>();
  const out: samples.PayloadSample[] = [];
  for (let i = records.length - 1; i >= 0 && out.length < limit; i--) {
    const record = records[i]!;
    const shape = JSON.stringify({ tool_name: record.tool_name, tool_input: record.tool_input });
    if (seen.has(shape)) continue;
    seen.add(shape);
    out.push(record);
  }
  return out.reverse();
}

/** Add imported worlds not already present by name. Returns the added count. */
export function mergeWorlds(cfg: Config, worlds: World[]): number {
  const existing = new Set(cfg.worlds.map((w) => w.name));
  let added = 0;
  for (const w of worlds) {
    if (!existing.has(w.name)) {
      cfg.worlds.push(w);
      existing.add(w.name);
      added++;
    }
  }
  return added;
}
