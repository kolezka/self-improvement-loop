// sil schedule install|uninstall|show: wires apps/cli/src/schedule.ts to argv.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as schedule from "../schedule.ts";

export interface ScheduleInstallOptions {
  systemd?: boolean;
  launchd?: boolean;
  web?: boolean;
  intervalMin?: number;
}

export function cmdScheduleInstall(opts: ScheduleInstallOptions, run: schedule.Runner = schedule.realRunner): number {
  let kind: "systemd" | "launchd";
  try {
    kind = schedule.resolveKind(opts);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  }
  const { written, resolvedBins } = schedule.install(kind, opts.intervalMin ?? 60, opts.web ?? false, run);
  for (const p of written) console.log(`wrote ${p}`);
  for (const [bin, dir] of Object.entries(resolvedBins)) {
    if (dir === null) {
      console.warn(`warning: ${bin} not found on PATH; the scheduled worker will fail every reflection until you reinstall from a shell that has it`);
    }
  }
  return 0;
}

export function cmdScheduleUninstall(): number {
  const removed = [...schedule.uninstall("systemd"), ...schedule.uninstall("launchd")];
  if (removed.length === 0) {
    console.log("nothing installed");
    return 0;
  }
  for (const p of removed) console.log(`removed ${p}`);
  return 0;
}

export function cmdScheduleShow(): number {
  const info = schedule.show();
  const dirs: Record<"systemd" | "launchd", string> = { systemd: schedule.systemdDir(), launchd: schedule.launchdDir() };
  for (const [kind, names] of Object.entries(info) as [keyof typeof dirs, string[]][]) {
    console.log(`${kind}:`);
    if (names.length === 0) console.log("  (none installed)");
    for (const name of names) {
      const content = readFileSync(join(dirs[kind], name), "utf8");
      const path = schedule.unitPath(kind, content);
      console.log(`  ${name}${path ? ` (PATH=${path})` : ""}`);
    }
  }
  return 0;
}
