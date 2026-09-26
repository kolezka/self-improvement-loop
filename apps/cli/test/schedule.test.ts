import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "@sil/core";
import {
  install,
  launchdDir,
  LEGACY_LAUNCHD_PLISTS,
  realRunner,
  renderLaunchd,
  resolveKind,
  renderSystemd,
  shimPath,
  show,
  SYSTEMD_WEB_UNIT,
  systemdDir,
  uninstall,
} from "../src/schedule.ts";

// Built from code points so this file passes the dash lint itself.
const EM = String.fromCodePoint(0x2014);
const EN = String.fromCodePoint(0x2013);
const LONG_DASH_RE = new RegExp(`[${EN}${EM}]`);

let tmp: string;
let savedHome: string | undefined;
let savedStateDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-schedule-"));
  savedHome = process.env["HOME"];
  savedStateDir = process.env["SIL_STATE_DIR"];
  process.env["HOME"] = tmp;
  // paths uses homedir(), which ignores the HOME change, so pin state too.
  process.env["SIL_STATE_DIR"] = join(tmp, "state");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
  if (savedStateDir === undefined) delete process.env["SIL_STATE_DIR"];
  else process.env["SIL_STATE_DIR"] = savedStateDir;
  rmSync(tmp, { recursive: true, force: true });
});

describe("realRunner", () => {
  test("does not throw when the executable is missing", () => {
    // sil schedule uninstall runs both kinds; on macOS there is no systemctl.
    expect(() => realRunner(["sil-test-no-such-binary-4f2a", "--version"])).not.toThrow();
  });
});

describe("renderSystemd", () => {
  test("contains the shim path and interval, no long dashes", () => {
    const units = renderSystemd(45, false);
    expect(Object.keys(units)).toEqual(["sil-worker.service", "sil-worker.timer"]);
    for (const content of Object.values(units)) {
      expect(LONG_DASH_RE.test(content)).toBe(false);
    }
    expect(units["sil-worker.service"]).toContain(shimPath());
    expect(units["sil-worker.timer"]).toContain("OnUnitActiveSec=45min");
  });

  test("adds the web unit when asked", () => {
    const units = renderSystemd(60, true);
    expect(Object.keys(units)).toContain(SYSTEMD_WEB_UNIT);
    expect(units[SYSTEMD_WEB_UNIT]).toContain(shimPath());
  });

  test("the web unit restarts on a clean exit, which is how an update lands", () => {
    // sil web exits 0 when the plugin is updated; Restart=on-failure would
    // leave the old version stopped and nothing serving.
    const units = renderSystemd(60, true);
    expect(units[SYSTEMD_WEB_UNIT]).toContain("Restart=always");
    expect(units[SYSTEMD_WEB_UNIT]).not.toContain("Restart=on-failure");
  });
});

describe("renderLaunchd", () => {
  test("contains the shim path and interval in seconds, no long dashes", () => {
    const units = renderLaunchd(30, false);
    for (const content of Object.values(units)) {
      expect(content).toContain(shimPath());
      expect(LONG_DASH_RE.test(content)).toBe(false);
    }
    const worker = Object.values(units)[0]!;
    expect(worker).toContain("<integer>1800</integer>");
  });

  test("every agent sends stdout and stderr to its sil log file", () => {
    // Without these keys launchd drops all output and `sil logs` shows nothing.
    const units = renderLaunchd(60, true);
    const expected: Record<string, string> = {
      "com.raqz.sil-worker.plist": paths.logFile("worker"),
      "com.raqz.sil-web.plist": paths.logFile("web"),
    };
    for (const [name, log] of Object.entries(expected)) {
      expect(units[name]).toContain(`<key>StandardOutPath</key><string>${log}</string>`);
      expect(units[name]).toContain(`<key>StandardErrorPath</key><string>${log}</string>`);
    }
  });
});

describe("resolveKind", () => {
  test("an explicit flag wins on any platform", () => {
    expect(resolveKind({ systemd: true }, "darwin")).toBe("systemd");
    expect(resolveKind({ launchd: true }, "linux")).toBe("launchd");
  });

  test("with no flag the platform picks the supervisor", () => {
    expect(resolveKind({}, "darwin")).toBe("launchd");
    expect(resolveKind({}, "linux")).toBe("systemd");
  });

  test("both flags, or no flag on an unknown platform, is an error", () => {
    expect(() => resolveKind({ systemd: true, launchd: true }, "darwin")).toThrow(/only one of/);
    expect(() => resolveKind({}, "win32")).toThrow(/--systemd or --launchd/);
  });
});

describe("install", () => {
  test("writes systemd unit files under a fake HOME and reloads the daemon", () => {
    const calls: string[][] = [];
    const written = install("systemd", 60, true, (cmd) => {
      calls.push(cmd);
    });

    expect(written.length).toBeGreaterThan(0);
    for (const p of written) {
      expect(p.startsWith(systemdDir())).toBe(true);
      expect(existsSync(p)).toBe(true);
    }
    expect(existsSync(shimPath())).toBe(true);
    expect(readFileSync(shimPath(), "utf8").length).toBeGreaterThan(0);

    const joined = calls.map((c) => c.join(" "));
    expect(joined).toContain("systemctl --user daemon-reload");
  });

  test("show reports what install wrote, uninstall removes it", () => {
    install("systemd", 60, false, () => {});
    const before = show();
    expect(before.systemd.length).toBeGreaterThan(0);

    const removed = uninstall("systemd", () => {});
    expect(removed.length).toBeGreaterThan(0);
    for (const p of removed) expect(existsSync(p)).toBe(false);

    const after = show();
    expect(after.systemd).toEqual([]);
  });

  test("launchd install loads each plist through the injected runner", () => {
    const calls: string[][] = [];
    const written = install("launchd", 60, false, (cmd) => {
      calls.push(cmd);
    });
    expect(written.length).toBe(1);
    expect(written[0]!.startsWith(launchdDir())).toBe(true);
    expect(calls.some((c) => c[0] === "launchctl" && c[1] === "load")).toBe(true);
  });

  test("launchd reinstall unloads each agent before loading it again", () => {
    // launchctl load refuses an agent that is already loaded, so without the
    // unload a changed --interval-min never reaches the running agent.
    const calls: string[][] = [];
    const written = install("launchd", 60, true, (cmd) => {
      calls.push(cmd);
    });
    expect(written.length).toBe(2);
    for (const p of written) {
      const unloadAt = calls.findIndex((c) => c.join(" ") === `launchctl unload ${p}`);
      const loadAt = calls.findIndex((c) => c.join(" ") === `launchctl load ${p}`);
      expect(unloadAt).toBeGreaterThanOrEqual(0);
      expect(loadAt).toBeGreaterThan(unloadAt);
    }
  });

  test("launchd install creates the log directory the agents write to", () => {
    // launchd does not create a missing parent dir for StandardOutPath.
    expect(paths.logFile("worker").startsWith(tmp)).toBe(true);
    install("launchd", 60, true, () => {});
    expect(existsSync(dirname(paths.logFile("worker")))).toBe(true);
    expect(existsSync(dirname(paths.logFile("web")))).toBe(true);
  });

  test("launchd plists carry the com.raqz label, never the old com.kolezka one", () => {
    const units = renderLaunchd(60, true);
    expect(Object.keys(units)).toEqual(["com.raqz.sil-worker.plist", "com.raqz.sil-web.plist"]);
    for (const content of Object.values(units)) {
      expect(content).toContain("<string>com.raqz.sil-");
      expect(content).not.toContain("kolezka");
    }
  });

  test("launchd uninstall also unloads and removes legacy com.kolezka plists", () => {
    const d = launchdDir();
    mkdirSync(d, { recursive: true });
    const legacy = LEGACY_LAUNCHD_PLISTS.map((n) => join(d, n));
    for (const p of legacy) writeFileSync(p, "<plist/>", "utf8");
    expect(show().launchd).toEqual([...LEGACY_LAUNCHD_PLISTS].sort());
    const calls: string[][] = [];
    const removed = uninstall("launchd", (cmd) => {
      calls.push(cmd);
    });
    expect(removed.sort()).toEqual([...legacy].sort());
    for (const p of legacy) {
      expect(existsSync(p)).toBe(false);
      expect(calls).toContainEqual(["launchctl", "unload", p]);
    }
    expect(show().launchd).toEqual([]);
  });
});
