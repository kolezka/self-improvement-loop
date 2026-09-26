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
export const LAUNCHD_WORKER_PLIST = "com.raqz.sil-worker.plist";
export const LAUNCHD_WEB_PLIST = "com.raqz.sil-web.plist";
/** Labels written by earlier releases; uninstall still removes them. */
export const LEGACY_LAUNCHD_PLISTS = ["com.kolezka.sil-worker.plist", "com.kolezka.sil-web.plist"] as const;
const LAUNCHD_PREFIXES = ["com.raqz.sil-", "com.kolezka.sil-"] as const;

/** Runs a command and never throws; tests inject a fake so no real
 * systemctl/launchctl is ever invoked. */
export type Runner = (cmd: string[]) => void;

export const realRunner: Runner = (cmd) => {
  // Bun.spawnSync throws when the binary is missing, which is the normal case
  // for systemctl on macOS and launchctl on Linux. Uninstall runs both kinds.
  try {
    Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // Missing tool means nothing of that kind is installed. Nothing to do.
  }
};

// Bun's homedir() does not follow a HOME change made after startup, so a test
// that points HOME at a temp dir would still write into the real LaunchAgents.
function home(): string {
  return process.env["HOME"] || homedir();
}

export function shimPath(): string {
  return join(home(), ".local", "bin", "sil");
}

export function systemdDir(): string {
  return join(home(), ".config", "systemd", "user");
}

export function launchdDir(): string {
  return join(home(), "Library", "LaunchAgents");
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
      // always, not on-failure: `sil web` exits 0 on a plugin update so the
      // restart picks up the new version.
      "Restart=always",
      "RestartSec=2",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
  }
  return units;
}

// launchd drops stdout and stderr unless told where to put them. Both go to
// the same file `sil logs <name>` reads.
function launchdLogKeys(name: "worker" | "web"): string[] {
  const log = paths.logFile(name);
  return [`  <key>StandardOutPath</key><string>${log}</string>`, `  <key>StandardErrorPath</key><string>${log}</string>`];
}

export function renderLaunchd(intervalMin: number, web: boolean): Record<string, string> {
  const shim = shimPath();
  const intervalS = intervalMin * 60;
  const units: Record<string, string> = {
    [LAUNCHD_WORKER_PLIST]: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      "  <key>Label</key><string>com.raqz.sil-worker</string>",
      "  <key>ProgramArguments</key><array>",
      `    <string>${shim}</string>`,
      "    <string>worker</string>",
      "    <string>--once</string>",
      "  </array>",
      `  <key>StartInterval</key><integer>${intervalS}</integer>`,
      "  <key>RunAtLoad</key><true/>",
      ...launchdLogKeys("worker"),
      "</dict></plist>",
      "",
    ].join("\n"),
  };
  if (web) {
    units[LAUNCHD_WEB_PLIST] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      "  <key>Label</key><string>com.raqz.sil-web</string>",
      "  <key>ProgramArguments</key><array>",
      `    <string>${shim}</string>`,
      "    <string>web</string>",
      "  </array>",
      "  <key>KeepAlive</key><true/>",
      "  <key>RunAtLoad</key><true/>",
      ...launchdLogKeys("web"),
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

/** Pick the supervisor: an explicit flag, else the one this platform has. */
export function resolveKind(opts: { systemd?: boolean; launchd?: boolean }, platform: string = process.platform): "systemd" | "launchd" {
  if (opts.systemd && opts.launchd) throw new Error("sil schedule install takes only one of --systemd or --launchd");
  if (opts.systemd) return "systemd";
  if (opts.launchd) return "launchd";
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  throw new Error(`no default supervisor on ${platform}, pass --systemd or --launchd`);
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
    // launchd does not create the parent dir of StandardOutPath.
    mkdirSync(dirname(paths.logFile("worker")), { recursive: true });
    const written: string[] = [];
    for (const [name, content] of Object.entries(renderLaunchd(intervalMin, web))) {
      const p = join(d, name);
      writeFileSync(p, content, "utf8");
      written.push(p);
      // load refuses an agent that is already loaded, so a reinstall would
      // keep running the old settings. unload first; it is a no-op otherwise.
      run(["launchctl", "unload", p]);
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
    for (const name of [LAUNCHD_WORKER_PLIST, LAUNCHD_WEB_PLIST, ...LEGACY_LAUNCHD_PLISTS]) {
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
  const launchd = existsSync(ld) ? readdirSync(ld).filter((n) => LAUNCHD_PREFIXES.some((pre) => n.startsWith(pre)) && n.endsWith(".plist")).sort() : [];
  return { systemd, launchd };
}
