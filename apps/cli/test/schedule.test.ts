import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  install,
  launchdDir,
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
});
