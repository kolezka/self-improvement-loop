// Detached background process launcher for loop.run and curriculum.run.
// Output goes to the named engine log; the caller gets the pid back so the
// UI can say "started" without waiting for the process to finish.

import { closeSync, existsSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fsx, paths } from "@sil/core";
import { deps } from "./deps.ts";

export interface SpawnResult { pid: number; log: string }

/** `bun <pluginRoot>/dist/cli.js <args>`, falling back to running the CLI
 * entry straight from source when the built bundle is missing (dev, or a
 * fresh clone before the first `bun run build`). */
function cliCommand(args: string[]): string[] {
  const root = paths.pluginRoot();
  const distCli = join(root, "dist", "cli.js");
  if (existsSync(distCli)) return ["bun", distCli, ...args];
  return ["bun", "run", join(root, "apps", "cli", "src", "main.ts"), ...args];
}

export function spawnCli(args: string[], logName: string): SpawnResult {
  const logPath = paths.logFile(logName);
  fsx.ensureDir(dirname(logPath));
  const fd = openSync(logPath, "a");
  const [bin, ...rest] = cliCommand(args);
  try {
    const child = deps.spawn(bin!, rest, { detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    if (child.pid === undefined) throw new Error(`failed to spawn: ${bin}`);
    return { pid: child.pid, log: logPath };
  } finally {
    closeSync(fd);
  }
}
