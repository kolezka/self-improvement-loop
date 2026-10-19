import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// The launchers also look in these; a bun there would make "no bun" untestable.
const systemBun = ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"].some(existsSync);

let tmp: string;
let home: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-launch-"));
  home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function run(script: string, env: Record<string, string>) {
  return Bun.spawnSync(["/bin/sh", join(ROOT, "scripts", script), "status"], {
    env: { HOME: home, PATH: "/usr/bin:/bin", ...env },
    stdin: new TextEncoder().encode("{}"),
    stdout: "pipe",
    stderr: "pipe",
  });
}

// A stand-in bun that records the script it was asked to run.
function fakeBun(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const log = join(tmp, "bun-argv");
  writeFileSync(join(dir, "bun"), `#!/bin/sh\necho "$1" > "${log}"\n`);
  chmodSync(join(dir, "bun"), 0o755);
  return log;
}

describe.each(["hook", "sil"])("scripts/%s", (script) => {
  test.skipIf(systemBun)("with no bun anywhere, fails with an install hint instead of command not found", () => {
    const r = run(script, { SIL_PLUGIN_ROOT: ROOT });
    expect(r.exitCode).not.toBe(0);
    const err = r.stderr.toString();
    expect(err).toContain("https://bun.sh");
    expect(err).not.toContain("not found");
  });

  test("finds bun in ~/.bun/bin when it is not on PATH", () => {
    const log = fakeBun(join(home, ".bun", "bin"));
    const r = run(script, { SIL_PLUGIN_ROOT: ROOT });
    expect(r.exitCode).toBe(0);
    expect(existsSync(log)).toBe(true);
  });
});
