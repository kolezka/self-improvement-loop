import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDeps, type Deps } from "../src/deps.ts";
import { run } from "../src/main.ts";
import { install, MINIMAL_PATH, systemdDir } from "../src/schedule.ts";

/** Runs `sil status --json` with console.log captured, and returns the
 * parsed payload plus the exit code. Every test below needs this dance, so
 * it is pulled out rather than repeated. */
async function statusJson(deps?: Deps): Promise<{ code: number; payload: any }> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  let code: number;
  try {
    code = deps === undefined ? await run(["status", "--json"]) : await run(["status", "--json"], deps);
  } finally {
    console.log = origLog;
  }
  return { code, payload: JSON.parse(logs.join("\n")) };
}

function writeFakeClaude(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "claude"), "#!/bin/sh\necho 2.1.0\n", "utf8");
  chmodSync(join(dir, "claude"), 0o755);
}

let tmp: string;
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-status-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_CONFIG_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
  // The real providers.status probes every configured endpoint, and `sil init`
  // seeds a LiteLLM host. Keep the real key and the network out of the tests.
  saved["LITELLM_API_KEY"] = process.env["LITELLM_API_KEY"];
  delete process.env["LITELLM_API_KEY"];
  globalThis.fetch = (async () => {
    throw new Error("network disabled in status tests");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function fakeDeps(): Deps {
  return {
    worker: {
      status: () => ({ lock_held: false, lock_pid: null, pending: 0, done: 0, failed: 0, last_run: null, last_summary: null, last_curriculum: {} }),
    } as unknown as Deps["worker"],
    feedback: {} as Deps["feedback"],
    providers: {
      status: async () => ({ endpoint: "http://127.0.0.1:4000", reachable: true, error: null }),
    } as unknown as Deps["providers"],
    review: {
      queue: () => [],
      inventory: () => [],
    } as unknown as Deps["review"],
    curriculum: {} as Deps["curriculum"],
  };
}

describe("sil status --json", () => {
  test("reports worker, queue and per world provider status through the deps seam", async () => {
    const initCode = await run(["init"]);
    expect(initCode).toBe(0);

    const { code, payload } = await statusJson(fakeDeps());
    expect(code).toBe(0);
    expect(payload.queue).toEqual({ pending: 0, done: 0, failed: 0 });
    expect(payload.worlds.length).toBe(1);
    expect(payload.worlds[0].world).toBe("default");
    expect(payload.worlds[0].provider.reachable).toBe(true);
  });

  test("omits unit_path_reachable and unit_path_error entirely when no worker unit is installed", async () => {
    expect(await run(["init"])).toBe(0);

    const { code, payload } = await statusJson(fakeDeps());
    expect(code).toBe(0);
    expect(Object.hasOwn(payload.worlds[0], "unit_path_reachable")).toBe(false);
    expect(Object.hasOwn(payload.worlds[0], "unit_path_error")).toBe(false);
  });
});

// Regression: a launchd/systemd unit bakes its own PATH at install time
// (PR #48). The old probe always used this process's PATH, so a schedule
// installed from a shell that has claude reported reachable=true even when
// the unit's own baked PATH has no claude, and the scheduled worker failed.
describe("sil status with a scheduled worker unit", () => {
  let savedHome: string | undefined;
  let savedPath: string | undefined;
  let unitBinDir: string;

  beforeEach(() => {
    savedHome = process.env["HOME"];
    savedPath = process.env["PATH"];
    process.env["HOME"] = tmp;
    process.env["CLAUDE_CONFIG_DIR"] = join(tmp, "claude");

    // A fake claude on this process's own PATH: what the un-fixed probe (no
    // PATH override) sees, standing in for the interactive shell in the bug.
    const shellBinDir = join(tmp, "shell-bin");
    mkdirSync(shellBinDir, { recursive: true });
    writeFileSync(join(shellBinDir, "claude"), "#!/bin/sh\necho 2.1.0\n", "utf8");
    chmodSync(join(shellBinDir, "claude"), 0o755);
    process.env["PATH"] = `${shellBinDir}:/usr/bin:/bin`;

    // Empty: the installer's PATH used to bake the unit, so the rendered
    // unit's own PATH resolves to MINIMAL_PATH, which has no claude.
    unitBinDir = join(tmp, "unit-bin-empty");
    mkdirSync(unitBinDir, { recursive: true });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
  });

  test("reports unit_path_reachable=false when the installed unit's PATH lacks claude, even though reachable=true under the interactive PATH", async () => {
    expect(await run(["init"])).toBe(0);
    expect(await run(["llm", "use", "claude"])).toBe(0);

    // Never realRunner: a real systemctl exists on Linux CI and must not run.
    install("systemd", 60, false, () => {}, unitBinDir);

    // linux: systemd is the native supervisor there, so this actually reads
    // and probes the unit instead of hitting the non-native-leftover branch.
    const { code, payload } = await statusJson({ ...defaultDeps, platform: "linux" });
    expect(code).toBe(0);
    expect(payload.worlds[0].provider.endpoint).toBe("claude");
    expect(payload.worlds[0].provider.reachable).toBe(true);
    expect(payload.worlds[0].unit_path_reachable).toBe(false);
    // The probe's own error must survive, not get discarded into a bare false.
    expect(typeof payload.worlds[0].unit_path_error).toBe("string");
    expect(payload.worlds[0].unit_path_error.length).toBeGreaterThan(0);
  });

  test("launchd: reports unit_path_reachable=true when the installed unit's PATH has claude", async () => {
    expect(await run(["init"])).toBe(0);
    expect(await run(["llm", "use", "claude"])).toBe(0);

    // This time the rendered unit's PATH does have claude: the correctly
    // installed case, exercised through launchd rather than systemd.
    writeFakeClaude(unitBinDir);
    install("launchd", 60, false, () => {}, unitBinDir);

    const { code, payload } = await statusJson({ ...defaultDeps, platform: "darwin" });
    expect(code).toBe(0);
    expect(payload.worlds[0].unit_path_reachable).toBe(true);
    expect(payload.worlds[0].unit_path_error).toBeNull();
  });

  test("does not crash and surfaces the reason when the installed unit file cannot be read", async () => {
    expect(await run(["init"])).toBe(0);
    expect(await run(["llm", "use", "claude"])).toBe(0);

    // A broken symlink named sil-worker.service: schedule.show() lists it as
    // installed, but readFileSync on it throws ENOENT. platform "linux" keeps
    // systemd native so the read is actually attempted (a non-native unit is
    // never read at all).
    const dir = systemdDir();
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(tmp, "does-not-exist"), join(dir, "sil-worker.service"));

    const { code, payload } = await statusJson({ ...defaultDeps, platform: "linux" });
    expect(code).toBe(0);
    // Everything else still prints: this is a degraded field, not a crash.
    expect(payload.worlds[0].world).toBe("default");
    expect(payload.worlds[0].provider.endpoint).toBe("claude");
    expect(payload.worlds[0].unit_path_reachable).toBe(false);
    expect(typeof payload.worlds[0].unit_path_error).toBe("string");
    expect(payload.worlds[0].unit_path_error.length).toBeGreaterThan(0);
  });

  test("probes when drafter, not critic, is the claude-cli endpoint", async () => {
    expect(await run(["init"])).toBe(0);
    // Critic (and judge) stay on litellm; only drafter moves to claude-cli.
    expect(await run(["llm", "use", "claude", "--role", "drafter"])).toBe(0);

    writeFakeClaude(unitBinDir);
    install("systemd", 60, false, () => {}, unitBinDir);

    // Force the litellm (openai) endpoint's own probe to fail fast on the
    // missing key rather than trying a real network call to its base_url.
    const savedKey = process.env["LITELLM_API_KEY"];
    delete process.env["LITELLM_API_KEY"];
    let result: { code: number; payload: any };
    try {
      result = await statusJson({ ...defaultDeps, platform: "linux" });
    } finally {
      if (savedKey === undefined) delete process.env["LITELLM_API_KEY"];
      else process.env["LITELLM_API_KEY"] = savedKey;
    }

    expect(result.code).toBe(0);
    // Critic (the top-level provider fields) is still litellm, not claude-cli.
    expect(result.payload.worlds[0].provider.endpoint).toBe("litellm");
    expect(result.payload.worlds[0].provider.kind).toBe("openai");
    // The probe still ran, because drafter resolves to claude-cli.
    expect(result.payload.worlds[0].unit_path_reachable).toBe(true);
  });

  // Stubs only providers.status (a claude-cli role always active), keeping
  // the real probeClaudeCli so the PATH-under-test still runs for real.
  // Avoids a real network probe of the world's litellm endpoint, which
  // `llm use claude` does not remove from the endpoint list and which has
  // hung for the full per-test timeout against this machine's real
  // LITELLM_API_KEY / base_url.
  function depsWithClaudeCli(platform: string): Deps {
    return {
      ...defaultDeps,
      platform,
      providers: {
        ...defaultDeps.providers,
        status: async () => ({
          endpoint: "claude",
          kind: "claude-cli",
          base_url: null,
          models: {},
          reachable: true,
          error: null,
          endpoints: [{ kind: "claude-cli", roles: ["critic", "drafter", "judge"] }],
        }),
      } as unknown as Deps["providers"],
    };
  }

  // Finding 1: status checked systemd before launchd unconditionally, so a
  // stale systemd unit left over on macOS shadowed the real launchd plist.
  test("prefers the platform-native unit over a stale unit left by the other supervisor", async () => {
    expect(await run(["init"])).toBe(0);

    // Stale leftover: a systemd unit whose baked PATH has claude. On darwin
    // this file never runs (there is no systemd), so it must not decide
    // reachability once the real launchd unit exists.
    const staleSystemdBinDir = join(tmp, "stale-systemd-bin-with-claude");
    writeFakeClaude(staleSystemdBinDir);
    install("systemd", 60, false, () => {}, staleSystemdBinDir);

    // The real, native unit: baked PATH has no claude.
    install("launchd", 60, false, () => {}, unitBinDir);

    const deps = depsWithClaudeCli("darwin");
    const { code, payload } = await statusJson(deps);
    expect(code).toBe(0);
    // Decisive line: the old code checked systemd first and would report
    // true here (the stale unit's fake claude), even though the native
    // launchd unit's real PATH has none.
    expect(payload.worlds[0].unit_path_reachable).toBe(false);
    // The leftover still gets reported, it just does not decide reachability.
    expect(payload.worlds[0].unit_path_error).toContain("systemd worker unit");

    // Deleting the stale systemd file must not change the answer: proves
    // the native launchd unit, not the leftover, decided it.
    rmSync(join(systemdDir(), "sil-worker.service"));
    const second = await statusJson(deps);
    expect(second.payload.worlds[0].unit_path_reachable).toBe(false);
  });

  test("reports the non-native unit in unit_path_error instead of using it silently", async () => {
    expect(await run(["init"])).toBe(0);

    // Only a systemd unit exists; platform is darwin, whose native
    // supervisor is launchd.
    writeFakeClaude(unitBinDir);
    install("systemd", 60, false, () => {}, unitBinDir);

    const { code, payload } = await statusJson(depsWithClaudeCli("darwin"));
    expect(code).toBe(0);
    expect(payload.worlds[0].unit_path_reachable).toBe(false);
    expect(typeof payload.worlds[0].unit_path_error).toBe("string");
    expect(payload.worlds[0].unit_path_error).toMatch(/systemd/);
    expect(payload.worlds[0].unit_path_error).toMatch(/launchd/);
  });

  test("on linux, a leftover launchd plist is reported, never used", async () => {
    expect(await run(["init"])).toBe(0);

    writeFakeClaude(unitBinDir);
    install("launchd", 60, false, () => {}, unitBinDir);

    const { code, payload } = await statusJson(depsWithClaudeCli("linux"));
    expect(code).toBe(0);
    expect(payload.worlds[0].unit_path_reachable).toBe(false);
    expect(payload.worlds[0].unit_path_error).toContain("found a launchd worker unit");
    expect(payload.worlds[0].unit_path_error).toContain("native supervisor is systemd");
  });

  // Finding 2: a worker unit installed before PR #48 declares no PATH at
  // all, which used to read back as "no unit installed" (unitPath === null),
  // hiding the exact bug PR #48 fixed.
  test("probes with the OS minimal PATH when the installed unit predates the baked-PATH fix, and flags it for reinstall", async () => {
    expect(await run(["init"])).toBe(0);
    expect(await run(["llm", "use", "claude"])).toBe(0);

    // Hand-write a systemd unit with no Environment=PATH line: what a unit
    // installed before PR #48 looks like on disk.
    const dir = systemdDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "sil-worker.service"),
      ["[Unit]", "Description=x", "", "[Service]", "Type=oneshot", "ExecStart=/x", ""].join("\n"),
      "utf8",
    );

    let probedPath: string | undefined;
    const deps: Deps = {
      ...defaultDeps,
      platform: "linux",
      providers: {
        ...defaultDeps.providers,
        probeClaudeCli: (p?: string) => {
          probedPath = p;
          // Reachable is real, unrelated low-level error; status must not
          // surface this raw message, only the predates-fix note.
          return { reachable: true, error: "exit 127: claude: command not found" };
        },
        status: async () => ({
          endpoint: "claude",
          kind: "claude-cli",
          base_url: null,
          models: {},
          reachable: true,
          error: null,
          endpoints: [{ kind: "claude-cli", roles: ["critic"] }],
        }),
      } as unknown as Deps["providers"],
    };

    const { code, payload } = await statusJson(deps);
    expect(code).toBe(0);
    // Probed with the OS's own minimal PATH (schedule.ts's constant), not
    // skipped as "no unit".
    expect(probedPath).toBe(MINIMAL_PATH.join(":"));
    // Probe result still decides reachable.
    expect(payload.worlds[0].unit_path_reachable).toBe(true);
    expect(payload.worlds[0].unit_path_error).toMatch(/predates|PR #48|PATH/);
  });
});
