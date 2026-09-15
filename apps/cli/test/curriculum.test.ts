import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "@sil/core";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-curriculum-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("sil curriculum run --apply", () => {
  test("refuses to run while the worker lock is held by a live pid", async () => {
    const initCode = await run(["init"]);
    expect(initCode).toBe(0);

    const lockPath = paths.workerLockFile();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, String(process.pid), "utf8");

    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await run(["curriculum", "run", "--apply", "--world", "default"]);
    } finally {
      console.error = origErr;
    }

    expect(code).toBe(2);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("worker lock held");
    expect(errs[0]).not.toContain("at ");
  });

  test("without --apply does not touch the lock and succeeds", async () => {
    const initCode = await run(["init"]);
    expect(initCode).toBe(0);

    const lockPath = paths.workerLockFile();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, String(process.pid), "utf8");

    const code = await run(["curriculum", "run", "--world", "default"]);
    expect(code).toBe(0);
  });
});
