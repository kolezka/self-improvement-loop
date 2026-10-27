// The mixed-version upgrade window (design D5): a 1.3.0 hook still rotates `P`
// in place while 1.4 hooks and the importer run. Its rotation may duplicate its
// own overlap; it must never erase what a new hook spilled.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { paths } from "@sil/core";
import { closeHookDb, hookWrite } from "../src/hook.ts";
import { closeState, openState, readRecords, setImportIoForTest, stateStatus } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"] as const;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-upgrade-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  try {
    setImportIoForTest(null);
    closeHookDb();
    closeState();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

describe("upgrade window", () => {
  test("an old hook renaming its rotated tail over a claimed P cannot erase a new hook's spill", async () => {
    openState();
    const p = paths.hookRunsFile();
    mkdirSync(dirname(p), { recursive: true });
    // Past the 1.3.0 rotation size, so the old writer rewrites P before it appends.
    const rows = Array.from({ length: 1100 }, (_, i) => JSON.stringify({ marker: `original-${i}`, padding: "x".repeat(8192) }));
    writeFileSync(p, `${rows.join("\n")}\n`);
    expect(statSync(p).size).toBeGreaterThanOrEqual(8 * 1024 * 1024);

    const ready = join(tmp, "ready");
    const resume = join(tmp, "resume");
    const env: Record<string, string> = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: join(tmp, "home"),
      SIL_CONFIG_DIR: process.env["SIL_CONFIG_DIR"]!,
      SIL_STATE_DIR: process.env["SIL_STATE_DIR"]!,
      SIL_DATA_DIR: process.env["SIL_DATA_DIR"]!,
      OLD_P: p,
      OLD_READY: ready,
      OLD_RESUME: resume,
    };
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/old-rotation-writer.ts")], {
      env,
      cwd: resolve(import.meta.dir, "../../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(ready)) {
        if (Date.now() > deadline) throw new Error("the old writer never reached its rename");
        await Bun.sleep(5);
      }

      // The importer claims P; under its write lock a new hook's record spills.
      let outcome = "";
      setImportIoForTest({
        stat: statSync,
        readFile: readFileSync,
        rename: (from, to) => {
          renameSync(from, to);
          if (from === p && to === `${p}.importing` && outcome === "") outcome = hookWrite("hook_runs", [{ marker: "new-hook-spill" }]);
        },
      });
      readRecords("hook_runs", "strict");
      setImportIoForTest(null);
      expect(outcome).toBe("spilled");
    } finally {
      writeFileSync(resume, "go");
    }
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
    // Positive control: the old writer ran in the tmp state dir and really paused at its rename.
    expect(JSON.parse(out)).toEqual({ state: process.env["SIL_STATE_DIR"], paused: true });

    const records = readRecords("hook_runs", "strict").records;
    const count = (marker: string): number => records.filter((r) => r["marker"] === marker).length;
    expect(count("new-hook-spill")).toBe(1);
    expect(count("old-writer-after-rotation")).toBe(1);
    // The old writer's own overlap comes back once more: the accepted duplicate.
    expect(count("original-1099")).toBe(2);
    expect(count("original-0")).toBe(1);
    expect(stateStatus().streams.hook_runs.pending).toBe(false);
  }, 60_000);
});
