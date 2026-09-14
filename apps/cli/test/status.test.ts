import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/deps.ts";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-status-"));
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

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await run(["status", "--json"], fakeDeps());
    } finally {
      console.log = origLog;
    }
    expect(code).toBe(0);

    const payload = JSON.parse(logs.join("\n"));
    expect(payload.queue).toEqual({ pending: 0, done: 0, failed: 0 });
    expect(payload.worlds.length).toBe(1);
    expect(payload.worlds[0].world).toBe("default");
    expect(payload.worlds[0].provider.reachable).toBe(true);
  });
});
