// sil worlds: list, add, import-kb.

import { ConfigError, Layout, loadConfig, paths, saveConfig, V1_LAYOUT, World, writeHookSnapshot } from "@sil/core";
import { importKbWorlds, mergeWorlds } from "../importer.ts";

export function cmdWorldsList(): number {
  const cfg = loadConfig();
  if (cfg.worlds.length === 0) {
    console.log("no worlds configured");
    return 0;
  }
  for (const w of cfg.worlds) {
    const repos = w.repos.join(", ") || "(catch-all)";
    const target = w.target || "(learned/)";
    console.log(`${w.name.padEnd(16)} llm=${w.llm.padEnd(6)} remote=${w.remote.padEnd(5)} target=${target}  repos=${repos}`);
  }
  return 0;
}

export interface WorldsAddOptions {
  repos?: string[];
  target?: string;
  llm?: "local" | "cloud";
  layout?: "v1" | "default";
}

export function cmdWorldsAdd(name: string, opts: WorldsAddOptions): number {
  const cfg = loadConfig();
  if (cfg.worlds.some((w) => w.name === name)) {
    throw new ConfigError(`world ${JSON.stringify(name)} already exists`);
  }
  const layout = opts.layout === "v1" ? Layout.parse(V1_LAYOUT) : Layout.parse({});
  const world = World.parse({
    name,
    llm: opts.llm || "cloud",
    repos: (opts.repos ?? []).map((p) => paths.expandHome(p)),
    target: opts.target ? paths.expandHome(opts.target) : null,
    layout,
  });
  cfg.worlds.push(world);
  saveConfig(cfg);
  writeHookSnapshot(cfg);
  console.log(`added world ${name} (layout: ${opts.layout || "default"})`);
  return 0;
}

export function cmdWorldsImportKb(path: string): number {
  const cfg = loadConfig();
  const imported = importKbWorlds(path);
  const added = mergeWorlds(cfg, imported);
  saveConfig(cfg);
  writeHookSnapshot(cfg);
  console.log(`read ${imported.length} world(s) from ${path}, added ${added} new`);
  return 0;
}
