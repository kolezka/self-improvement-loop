// reflections.count: the real total in a world, never capped at a list
// window. The Overview pane's "Reflections" tile used to show
// reflections.list's length with a default limit of 500, so a world with
// 799 reflections read as a permanent 500.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReflection } from "@sil/store";
import { invoke } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-ops-reflections-count-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_PLUGIN_ROOT"]) {
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

function reflectionBody(pattern: string): string {
  return `Pattern: ${pattern}\n\n## Reusable lesson\nDo the thing.\n`;
}

describe("reflections.count", () => {
  test("counts every reflection in the world, past a list window", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => i);
    for (const i of seven) {
      writeReflection("default", { id: `2026-09-14-verify-callsites-${String(i).padStart(4, "0")}` }, reflectionBody("verify-callsites"));
    }

    const count = (await invoke("reflections.count", { world: "default" })) as { total: number };
    expect(count.total).toBe(7);

    // reflections.list, called with a window narrower than the real total
    // (as the Overview pane does), stays capped: the count never is.
    const capped = (await invoke("reflections.list", { world: "default", limit: 5 })) as unknown[];
    expect(capped).toHaveLength(5);
    expect(count.total).toBeGreaterThan(capped.length);
  });

  test("rejects a world that is not configured, like every other world scoped op", async () => {
    await expect(invoke("reflections.count", { world: "ghost" })).rejects.toThrow(/ghost/);
  });
});
