// Render and install systemd user units / launchd agents for the worker and
// web UI.
//
// Every unit's ExecStart points at the shim `~/.local/bin/sil` (scripts/sil,
// installed here), never at a path inside one plugin version. A plugin
// upgrade changes `${CLAUDE_PLUGIN_ROOT}`; the shim resolves the current
// install at call time, so an installed schedule never goes stale.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "@sil/core";

export const SYSTEMD_WORKER_UNITS = ["sil-worker.service", "sil-worker.timer"] as const;
export const SYSTEMD_WEB_UNIT = "sil-web.service";
export const LAUNCHD_WORKER_PLIST = "com.kolezka.sil-worker.plist";
export const LAUNCHD_WEB_PLIST = "com.kolezka.sil-web.plist";

/** Runs a command and never throws; tests inject a fake so no real
 * systemctl/launchctl is ever invoked. */
export type Runner = (cmd: string[]) => void;

export const realRunner: Runner = (cmd) => {
  Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" });
};

export function shimPath(): string {
  return join(homedir(), ".local", "bin", "sil");
}

export function systemdDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

export function launchdDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

export function renderSystemd(intervalMin: number, web: boolean): Record<string, string> {
  const shim = shimPath();
  const units: Record<string, string> = {
    "sil-worker.service": [
      "[Unit]",
      "Description=self-improvement-loop worker, one pass",
      "",
      "[Service]",
      "Type=oneshot",
      `ExecStart=${shim} worker --once`,
      "",
    ].join("\n"),
    "sil-worker.timer": [
      "[Unit]",
      "Description=self-improvement-loop worker schedule",
      "",
      "[Timer]",
      "OnBootSec=5min",
      `OnUnitActiveSec=${intervalMin}min`,
      "",
      "[Install]",
      "WantedBy=timers.target",
      "",
    ].join("\n"),
  };
  if (web) {
    units[SYSTEMD_WEB_UNIT] = [
      "[Unit]",
      "Description=self-improvement-loop web UI",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${shim} web`,
      "Restart=on-failure",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
  }
  return units;
}

export function renderLaunchd(intervalMin: number, web: boolean): Record<string, string> {
  const shim = shimPath();
  const intervalS = intervalMin * 60;
  const units: Record<string, string> = {
    [LAUNCHD_WORKER_PLIST]: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      "  <key>Label</key><string>com.kolezka.sil-worker</string>",
      "  <key>ProgramArguments</key><array>",
      `    <string>${shim}</string>`,
      "    <string>worker</string>",
      "    <string>--once</string>",
      "  </array>",
      `  <key>StartInterval</key><integer>${intervalS}</integer>`,
      "  <key>RunAtLoad</key><true/>",
      "</dict></plist>",
      "",
    ].join("\n"),
  };
  if (web) {
    units[LAUNCHD_WEB_PLIST] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      "  <key>Label</key><string>com.kolezka.sil-web</string>",
      "  <key>ProgramArguments</key><array>",
      `    <string>${shim}</string>`,
      "    <string>web</string>",
      "  </array>",
      "  <key>KeepAlive</key><true/>",
      "  <key>RunAtLoad</key><true/>",
      "</dict></plist>",
      "",
    ].join("\n");
  }
  return units;
}

function installShim(): string {
  const dest = shimPath();
  mkdirSync(dirname(dest), { recursive: true });
  const src = join(paths.pluginRoot(), "scripts", "sil");
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  return dest;
}

/** Write the units for `kind` (systemd | launchd) and load them. Returns the
 * written file paths. Idempotent: re-running overwrites the same files. */
export function install(kind: "systemd" | "launchd", intervalMin = 60, web = false, run: Runner = realRunner): string[] {
  installShim();
  if (kind === "systemd") {
    const d = systemdDir();
    mkdirSync(d, { recursive: true });
    const written: string[] = [];
    for (const [name, content] of Object.entries(renderSystemd(intervalMin, web))) {
      const p = join(d, name);
      writeFileSync(p, content, "utf8");
      written.push(p);
    }
    run(["systemctl", "--user", "daemon-reload"]);
    run(["systemctl", "--user", "enable", "--now", "sil-worker.timer"]);
    if (web) run(["systemctl", "--user", "enable", "--now", SYSTEMD_WEB_UNIT]);
    return written;
  }
  if (kind === "launchd") {
    const d = launchdDir();
    mkdirSync(d, { recursive: true });
    const written: string[] = [];
    for (const [name, content] of Object.entries(renderLaunchd(intervalMin, web))) {
      const p = join(d, name);
      writeFileSync(p, content, "utf8");
      written.push(p);
      run(["launchctl", "load", p]);
    }
    return written;
  }
  throw new Error(`unknown schedule kind: ${JSON.stringify(kind)}, use systemd or launchd`);
}

/** Stop and remove whatever units of `kind` are installed. A no-op, not an
 * error, when nothing is installed. */
export function uninstall(kind: "systemd" | "launchd", run: Runner = realRunner): string[] {
  if (kind === "systemd") {
    const d = systemdDir();
    run(["systemctl", "--user", "disable", "--now", "sil-worker.timer"]);
    run(["systemctl", "--user", "disable", "--now", SYSTEMD_WEB_UNIT]);
    const removed: string[] = [];
    for (const name of [...SYSTEMD_WORKER_UNITS, SYSTEMD_WEB_UNIT]) {
      const p = join(d, name);
      if (existsSync(p)) {
        rmSync(p);
        removed.push(p);
      }
    }
    run(["systemctl", "--user", "daemon-reload"]);
    return removed;
  }
  if (kind === "launchd") {
    const d = launchdDir();
    const removed: string[] = [];
    for (const name of [LAUNCHD_WORKER_PLIST, LAUNCHD_WEB_PLIST]) {
      const p = join(d, name);
      if (existsSync(p)) {
        run(["launchctl", "unload", p]);
        rmSync(p);
        removed.push(p);
      }
    }
    return removed;
  }
  throw new Error(`unknown schedule kind: ${JSON.stringify(kind)}, use systemd or launchd`);
}

/** What is currently installed, by kind. Reads the filesystem, runs nothing. */
export function show(): { systemd: string[]; launchd: string[] } {
  const d = systemdDir();
  const systemd = existsSync(d) ? readdirSync(d).filter((n) => n.startsWith("sil-")).sort() : [];
  const ld = launchdDir();
  const launchd = existsSync(ld) ? readdirSync(ld).filter((n) => n.startsWith("com.kolezka.sil-") && n.endsWith(".plist")).sort() : [];
  return { systemd, launchd };
}
