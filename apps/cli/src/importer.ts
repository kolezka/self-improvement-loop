// Import V1 data into the v2 layout: worlds.yaml, reflection mirrors, ledgers.
//
// V1 (dotfiles-next) kept worlds in a manifest read by `kb list`, reflections
// in a flat markdown mirror, and one ledger per repo. This module is the
// one-time bridge from that shape into sil's config and data dirs. It never
// runs on a schedule and never deletes the V1 source.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import YAML from "yaml";
import { type Config, type World, Layout, World as WorldSchema, fsx, ledgerPath, paths } from "@sil/core";
import { parseLedger, reflectionPattern, saveLedger } from "@sil/store";

export interface ImportReflectionsResult {
  copied: number;
  skippedDuplicate: number;
  skippedNonReflection: number;
}

function walkMarkdownFiles(dir: string): string[] {
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
      else if (name.endsWith(".md")) out.push(full);
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
  for (const p of walkMarkdownFiles(src)) {
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

/** Read a V1 `kb list` manifest and return one sil World per V1 world. Each
 * V1 project's `repo` becomes a `repos` prefix. No `target` is set: an
 * imported world writes artifacts into the built-in `learned/` repo until an
 * operator points it at a real target with `sil worlds add --target`. */
export function importKbWorlds(path: string): World[] {
  const text = fsx.readText(paths.expandHome(path));
  const raw = (YAML.parse(text) ?? {}) as { worlds?: V1World[] };
  const worlds: World[] = [];
  for (const w of raw.worlds ?? []) {
    const repos = (w.projects ?? []).filter((p) => p.repo).map((p) => paths.expandHome(p.repo!));
    worlds.push(
      WorldSchema.parse({
        name: w.name,
        llm: w.llm ?? "cloud",
        repos,
        target: null,
        layout: Layout.parse({}),
      }),
    );
  }
  return worlds;
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
