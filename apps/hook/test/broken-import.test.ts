// A broken partial install (one of the dynamically imported modules throws
// at its own top level) must still exit 0 and log a short, payload-free
// line. main.ts only static-imports node: builtins; every @sil/* and local
// module loads through a dynamic import() inside main()'s try/catch, so a
// throw during module evaluation rejects the import promise instead of
// crashing the process.
//
// bun's workspace package resolution (@sil/core, @sil/nudges) is driven by
// per-package node_modules/@sil/* symlinks (apps/hook/node_modules/@sil/core
// -> ../../../../packages/core), not by anything under the repo-root
// node_modules. Excluding only the repo-root node_modules, .git and dist
// keeps the copy small while preserving those symlinks so the copy resolves
// exactly like the real repo.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

let copyRoot: string;
let stateDir: string;

beforeEach(() => {
  copyRoot = mkdtempSync(join(tmpdir(), "sil-broken-import-"));
  stateDir = mkdtempSync(join(tmpdir(), "sil-broken-import-state-"));
  const rsync = Bun.spawnSync([
    "rsync",
    "-a",
    "--exclude",
    "/node_modules",
    "--exclude",
    "/.git",
    "--exclude",
    "/dist",
    "--exclude",
    "/.venv",
    `${REPO_ROOT}/`,
    `${copyRoot}/`,
  ]);
  if (rsync.exitCode !== 0) {
    throw new Error(`rsync setup failed: ${rsync.stderr.toString("utf8")}`);
  }
  // Inject a top-level throw into a module main.ts only reaches through a
  // dynamic import, simulating a broken partial install.
  appendFileSync(join(copyRoot, "apps/hook/src/kick.ts"), '\nthrow new TypeError("simulated broken install");\n');
});

afterEach(() => {
  rmSync(copyRoot, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe("broken partial install", () => {
  test("a top-level throw in a dynamically imported module still exits 0 and logs one payload-free line", () => {
    const payload = { session_id: "sess-broken-1", hook_event_name: "SessionStart", source: "startup", cwd: "/tmp", prompt: "sensitive-should-not-leak" };
    const proc = Bun.spawnSync(["bun", join(copyRoot, "apps/hook/src/main.ts")], {
      stdin: Buffer.from(JSON.stringify(payload), "utf8"),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env["PATH"] ?? "",
        SIL_CONFIG_DIR: join(stateDir, "config"),
        SIL_STATE_DIR: join(stateDir, "state"),
        SIL_DATA_DIR: join(stateDir, "data"),
        CLAUDE_PLUGIN_ROOT: copyRoot,
      },
    });

    expect(proc.exitCode).toBe(0);
    expect((proc.stdout ?? Buffer.alloc(0)).toString("utf8").trim()).toBe("");

    const logPath = join(stateDir, "state/logs/hook.log");
    const log = readFileSync(logPath, "utf8").trim();
    const lines = log.split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("hook unavailable: import failed: TypeError");
    expect(lines[0]).not.toContain("sensitive-should-not-leak");
  });
});
