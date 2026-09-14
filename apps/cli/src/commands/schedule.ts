// sil schedule install|uninstall|show: wires apps/cli/src/schedule.ts to argv.

import * as schedule from "../schedule.ts";

export interface ScheduleInstallOptions {
  systemd?: boolean;
  launchd?: boolean;
  web?: boolean;
  intervalMin?: number;
}

export function cmdScheduleInstall(opts: ScheduleInstallOptions): number {
  if (!opts.systemd && !opts.launchd) {
    console.error("error: sil schedule install needs --systemd or --launchd");
    return 2;
  }
  if (opts.systemd && opts.launchd) {
    console.error("error: sil schedule install takes only one of --systemd or --launchd");
    return 2;
  }
  const kind = opts.systemd ? "systemd" : "launchd";
  const written = schedule.install(kind, opts.intervalMin ?? 60, opts.web ?? false);
  for (const p of written) console.log(`wrote ${p}`);
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
  for (const [kind, names] of Object.entries(info)) {
    console.log(`${kind}:`);
    if (names.length === 0) console.log("  (none installed)");
    for (const name of names) console.log(`  ${name}`);
  }
  return 0;
}
