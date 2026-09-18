import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAliases, saveAliases, writeReflection } from "@sil/store";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-aliases-"));
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

describe("sil aliases set", () => {
  test("adds one entry without wiping an existing one", async () => {
    expect(await run(["init"])).toBe(0);

    expect(await run(["aliases", "set", "old-name", "new-name"])).toBe(0);
    expect(await run(["aliases", "set", "second-old", "new-name"])).toBe(0);

    expect(loadAliases("default")).toEqual({ "old-name": "new-name", "second-old": "new-name" });
  });

  test("rejects a non-slug alias", async () => {
    expect(await run(["init"])).toBe(0);
    const code = await run(["aliases", "set", "Not A Slug", "new-name"]);
    expect(code).toBe(1);
  });

  test("rejects a non-slug canonical", async () => {
    expect(await run(["init"])).toBe(0);
    const code = await run(["aliases", "set", "old-name", "Not A Slug"]);
    expect(code).toBe(1);
  });

  test("rejects a two-hop chain: canonical is itself an alias", async () => {
    expect(await run(["init"])).toBe(0);
    expect(await run(["aliases", "set", "old-name", "new-name"])).toBe(0);

    const code = await run(["aliases", "set", "third-name", "old-name"]);
    expect(code).toBe(1);
    // the rejected write never landed
    expect(loadAliases("default")).toEqual({ "old-name": "new-name" });
  });
});

describe("sil aliases rm", () => {
  test("removes one entry and leaves the rest", async () => {
    expect(await run(["init"])).toBe(0);
    saveAliases("default", { "old-name": "new-name", "second-old": "new-name" });

    expect(await run(["aliases", "rm", "old-name"])).toBe(0);
    expect(loadAliases("default")).toEqual({ "second-old": "new-name" });
  });

  test("removing an alias that does not exist is a no-op, exit 0", async () => {
    expect(await run(["init"])).toBe(0);
    expect(await run(["aliases", "rm", "never-existed"])).toBe(0);
  });
});

describe("sil aliases list", () => {
  test("prints nothing configured for an empty map", async () => {
    expect(await run(["init"])).toBe(0);

    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      expect(await run(["aliases", "list"])).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(lines.join("\n")).toContain("no aliases");
  });
});

describe("sil aliases suggest", () => {
  test("prints a suggestion with the exact set command to apply it", async () => {
    expect(await run(["init"])).toBe(0);
    const body = (pattern: string) => `Pattern: ${pattern}\n\n## Reusable lesson\nx\n`;
    writeReflection("default", { id: "1" }, body("stale-env"));
    writeReflection("default", { id: "2" }, body("stale-env"));
    writeReflection("default", { id: "3" }, body("stale-cached-env"));

    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      expect(await run(["aliases", "suggest"])).toBe(0);
    } finally {
      console.log = orig;
    }
    const out = lines.join("\n");
    expect(out).toContain("stale-cached-env");
    expect(out).toContain("stale-env");
    expect(out).toContain("sil aliases set stale-cached-env stale-env --world default");
  });
});
