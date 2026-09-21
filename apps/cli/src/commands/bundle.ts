// sil export / sil import bundle: the human-facing side of a host migration.

import { exportBundle, humanBytes, importBundle } from "../bundle.ts";

export interface ExportCmdOptions {
  world?: string[];
  history?: boolean;
  force?: boolean;
}

export function cmdExport(dest: string, opts: ExportCmdOptions): number {
  const result = exportBundle({ dest, worlds: opts.world, history: opts.history, force: opts.force });
  const kind = result.archive ? "archive" : "directory";
  console.log(`wrote ${kind} ${result.path} (${result.files} files, ${humanBytes(result.bytes)})`);
  for (const w of result.manifest.worlds) {
    console.log(`  world ${w.name}: ${w.reflections} reflections${w.learned_repo ? ", learned repo" : ""}`);
  }
  if (!result.manifest.history) console.log("  history left out (--no-history)");
  for (const warning of result.warnings) console.log(`  note: ${warning}`);
  console.log();
  console.log("No credentials are in the bundle. Set the API key env vars again on the new host.");
  console.log(`Restore it with: sil import bundle ${result.path}`);
  return 0;
}

export interface ImportBundleCmdOptions {
  world?: string[];
  force?: boolean;
}

export function cmdImportBundle(src: string, opts: ImportBundleCmdOptions): number {
  const result = importBundle({ src, worlds: opts.world, force: opts.force });
  console.log(`restored ${result.files} files from ${result.path}`);
  console.log(`  worlds: ${result.worlds.join(", ")} (${result.addedWorlds} new)`);
  if (result.skipped > 0) console.log(`  kept ${result.skipped} file(s) this host already had; pass --force to overwrite them`);
  for (const warning of result.warnings) console.log(`  note: ${warning}`);
  console.log();
  console.log("Set the API key env vars this install needs, then run: sil status");
  return 0;
}
