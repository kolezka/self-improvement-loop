// sil logs: tail one of the fixed log files.

import { existsSync } from "node:fs";
import { fsx, LOG_NAMES, paths } from "@sil/core";

export interface LogsOptions {
  lines?: number;
}

export function cmdLogs(name: string, opts: LogsOptions): number {
  if (!(LOG_NAMES as readonly string[]).includes(name)) {
    console.error(`error: unknown log ${JSON.stringify(name)}, choose from ${LOG_NAMES.join(", ")}`);
    return 2;
  }
  const p = paths.logFile(name);
  if (!existsSync(p)) {
    console.log(`no log file at ${p}`);
    return 0;
  }
  const text = fsx.readText(p).replace(/\n$/, "");
  const lines = text === "" ? [] : text.split("\n");
  const n = opts.lines ?? 50;
  for (const line of lines.slice(-n)) console.log(line);
  return 0;
}
