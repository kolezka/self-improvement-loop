import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "@sil/core";
import {
  install,
  LAUNCHD_WORKER_PLIST,
  launchdDir,
  LEGACY_LAUNCHD_PLISTS,
  realRunner,
  renderLaunchd,
  resolveBinDir,
  resolveKind,
  renderSystemd,
  shimPath,
  show,
  SYSTEMD_WEB_UNIT,
  systemdDir,
  uninstall,
  unitPath,
  workerPath,
  WORKER_BINS,
} from "../src/schedule.ts";
import { cmdScheduleInstall } from "../src/commands/schedule.ts";

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

/** A dir named `subdir` holding an executable named `name`, standing in for
 * wherever a real install puts claude or bun on some machine. Never on
 * MINIMAL_PATH, so a test using it proves the resolve step actually ran. */
function makeFakeBinIn(subdir: string, name: string): string {
  const dir = join(tmp, subdir);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\n", "utf8");
  chmodSync(p, 0o755);
  return dir;
}

function makeFakeBin(name: string): string {
  return makeFakeBinIn("fakebin", name);
}

// The literal PATH launchd and systemd both start a job with when nothing
// else sets it (see the bug this file guards against). Used to simulate what
// the OS actually hands the installed job when a unit declares no PATH.
const OS_MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

describe("realRunner", () => {
  test("does not throw when the executable is missing", () => {
    // sil schedule uninstall runs both kinds; on macOS there is no systemctl.
    expect(() => realRunner(["sil-test-no-such-binary-4f2a", "--version"])).not.toThrow();
  });
});

describe("resolveBinDir", () => {
  test("finds the directory holding an executable on the given PATH", () => {
    const dir = makeFakeBin("claude");
    expect(resolveBinDir("claude", `/usr/bin:${dir}:/bin`)).toBe(dir);
  });

  test("returns null when no PATH entry has it", () => {
    expect(resolveBinDir("sil-test-no-such-binary-4f2a", "/usr/bin:/bin")).toBeNull();
  });
});

describe("workerPath", () => {
  test("puts resolved WORKER_BINS dirs ahead of the minimal fallback", () => {
    const dir = makeFakeBin("claude");
    const path = workerPath(`${dir}:/usr/bin`);
    expect(path.split(":")).toContain(dir);
    expect(path.startsWith(dir)).toBe(true);
    expect(path.endsWith("/usr/bin:/bin:/usr/sbin:/sbin")).toBe(true);
  });

  test("a bin that cannot be resolved is left out, not an error", () => {
    expect(() => workerPath("/usr/bin:/bin")).not.toThrow();
    expect(workerPath("/usr/bin:/bin")).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  });
});

describe("renderSystemd", () => {
  test("contains the shim path and interval, no long dashes", () => {
    const units = renderSystemd(45, false, OS_MINIMAL_PATH);
    expect(Object.keys(units)).toEqual(["sil-worker.service", "sil-worker.timer"]);
    for (const content of Object.values(units)) {
      expect(LONG_DASH_RE.test(content)).toBe(false);
    }
    expect(units["sil-worker.service"]).toContain(shimPath());
    expect(units["sil-worker.timer"]).toContain("OnUnitActiveSec=45min");
  });

  test("declares a PATH that resolves claude even though the OS gives the unit a minimal one", () => {
    const dir = makeFakeBin("claude");
    const units = renderSystemd(45, false, `${dir}:/usr/bin`);
    const path = unitPath("systemd", units["sil-worker.service"]!);
    expect(path).not.toBeNull();
    expect(resolveBinDir("claude", path!)).toBe(dir);
  });

  test("quotes the PATH assignment and doubles a literal % so systemd does not treat it as a specifier", () => {
    const dir = makeFakeBinIn("fake%dir with space", "claude");
    const service = renderSystemd(45, false, `${dir}:/usr/bin`)["sil-worker.service"]!;
    expect(service).toContain(`Environment="PATH=${dir.replace(/%/g, "%%")}:/usr/bin:/bin:/usr/sbin:/sbin"`);
    const path = unitPath("systemd", service);
    expect(path).not.toBeNull();
    expect(resolveBinDir("claude", path!)).toBe(dir);
  });

  test("adds the web unit when asked", () => {
    const units = renderSystemd(60, true, OS_MINIMAL_PATH);
    expect(Object.keys(units)).toContain(SYSTEMD_WEB_UNIT);
    expect(units[SYSTEMD_WEB_UNIT]).toContain(shimPath());
  });

  test("the web unit restarts on a clean exit, which is how an update lands", () => {
    // sil web exits 0 when the plugin is updated; Restart=on-failure would
    // leave the old version stopped and nothing serving.
    const units = renderSystemd(60, true, OS_MINIMAL_PATH);
    expect(units[SYSTEMD_WEB_UNIT]).toContain("Restart=always");
    expect(units[SYSTEMD_WEB_UNIT]).not.toContain("Restart=on-failure");
  });
});

describe("renderLaunchd", () => {
  test("contains the shim path and interval in seconds, no long dashes", () => {
    const units = renderLaunchd(30, false, OS_MINIMAL_PATH);
    for (const content of Object.values(units)) {
      expect(content).toContain(shimPath());
      expect(LONG_DASH_RE.test(content)).toBe(false);
    }
    const worker = Object.values(units)[0]!;
    expect(worker).toContain("<integer>1800</integer>");
  });

  test("every agent sends stdout and stderr to its sil log file", () => {
    // Without these keys launchd drops all output and `sil logs` shows nothing.
    const units = renderLaunchd(60, true, OS_MINIMAL_PATH);
    const expected: Record<string, string> = {
      "com.raqz.sil-worker.plist": paths.logFile("worker"),
      "com.raqz.sil-web.plist": paths.logFile("web"),
    };
    for (const [name, log] of Object.entries(expected)) {
      expect(units[name]).toContain(`<key>StandardOutPath</key><string>${log}</string>`);
      expect(units[name]).toContain(`<key>StandardErrorPath</key><string>${log}</string>`);
    }
  });

  test("declares a PATH that resolves claude even though the OS gives the agent a minimal one", () => {
    const dir = makeFakeBin("claude");
    const units = renderLaunchd(60, true, `${dir}:/usr/bin`);
    for (const content of Object.values(units)) {
      const path = unitPath("launchd", content);
      expect(path).not.toBeNull();
      expect(resolveBinDir("claude", path!)).toBe(dir);
    }
  });

  // Falls back to a bare-& scan when plutil is unavailable (non-macOS); an
  // unescaped & is exactly what an XML parser would also reject here.
  function plistIsWellFormed(content: string): boolean {
    if (existsSync("/usr/bin/plutil")) {
      const p = join(tmp, "check.plist");
      writeFileSync(p, content, "utf8");
      const res = Bun.spawnSync(["/usr/bin/plutil", "-lint", p]);
      return res.exitCode === 0;
    }
    return !/&(?!amp;|lt;|gt;)/.test(content);
  }

  test("a resolved bin dir containing & still renders a plist that is valid XML", () => {
    const dir = makeFakeBinIn("fake & bin", "claude");
    const units = renderLaunchd(60, false, `${dir}:/usr/bin`);
    const content = units[LAUNCHD_WORKER_PLIST]!;
    expect(content).toContain("fake &amp; bin");
    expect(plistIsWellFormed(content)).toBe(true);
    const path = unitPath("launchd", content);
    expect(resolveBinDir("claude", path!)).toBe(dir);
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
    const { written } = install("systemd", 60, true, (cmd) => {
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
    const { written } = install("launchd", 60, false, (cmd) => {
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
    const { written } = install("launchd", 60, true, (cmd) => {
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
    const units = renderLaunchd(60, true, OS_MINIMAL_PATH);
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

  // Regression: an installed job used to run with the OS's minimal PATH,
  // which has neither claude nor bun, so the worker failed every reflection.
  for (const kind of ["systemd", "launchd"] as const) {
    test(`${kind} install lets the worker resolve every WORKER_BINS binary even under the OS's minimal PATH`, () => {
      const dir = makeFakeBin("claude");
      // The installer's own PATH: it has the fake claude, and the fake bin
      // dir doubles as bun's dir too (WORKER_BINS both resolve from it).
      writeFileSync(join(dir, "bun"), "#!/bin/sh\n", "utf8");
      chmodSync(join(dir, "bun"), 0o755);
      const installerPath = `${dir}:/usr/bin:/bin`;

      const { written } = install(kind, 60, false, () => {}, installerPath);
      const unitFile = written.find((p) => p.includes("worker"))!;
      const content = readFileSync(unitFile, "utf8");

      // What the OS actually gives the job at runtime: the file's own
      // declared PATH, or (pre-fix) nothing, which means OS_MINIMAL_PATH.
      const jobPath = unitPath(kind, content) ?? OS_MINIMAL_PATH;
      for (const bin of WORKER_BINS) {
        expect(resolveBinDir(bin, jobPath)).not.toBeNull();
      }
    });
  }

  test("resolvedBins reports null for a WORKER_BINS entry the installer's PATH cannot find", () => {
    const dir = makeFakeBin("claude");
    // No fake bun here, so bun must come back null: the installer's own PATH
    // does not have it, same as the pre-fix bug for whichever bin is missing.
    const { resolvedBins } = install("systemd", 60, false, () => {}, `${dir}:/usr/bin`);
    expect(resolvedBins["claude"]).toBe(dir);
    expect(resolvedBins["bun"]).toBeNull();
  });

  test("cmdScheduleInstall warns loudly when a WORKER_BINS entry cannot be resolved", () => {
    const dir = makeFakeBin("claude");
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${dir}:/usr/bin`;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      // Never the default realRunner here: a real systemctl exists on Linux
      // CI, and this test must not touch it.
      cmdScheduleInstall({ systemd: true }, () => {});
    } finally {
      console.warn = originalWarn;
      if (savedPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = savedPath;
    }
    expect(warnings.some((w) => w.includes("bun") && w.includes("not found on PATH"))).toBe(true);
    expect(warnings.some((w) => w.includes("claude"))).toBe(false);
  });
});
