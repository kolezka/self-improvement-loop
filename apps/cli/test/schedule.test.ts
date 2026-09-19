import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  install,
  launchdDir,
  LEGACY_LAUNCHD_PLISTS,
  realRunner,
  renderLaunchd,
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-schedule-"));
  savedHome = process.env["HOME"];
  process.env["HOME"] = tmp;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
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
