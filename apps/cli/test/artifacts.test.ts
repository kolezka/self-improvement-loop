import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ledgerPath, loadConfig, worldNamed } from "@sil/core";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-artifacts-"));
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

/** Seeds a promoted ledger row with no reflected sessions at all: the
 * simplest case for the rate columns, all three windows read as `n/a`. */
function seedPromotedRow(pattern: string): void {
  const cfg = loadConfig();
  const world = worldNamed(cfg, "default");
  const path = ledgerPath(world);
  mkdirSync(dirname(path), { recursive: true });
  const ledger = {
    version: 1,
    entries: {
      [pattern]: {
        pattern,
        status: "promoted",
        artifact_type: "skill",
        served_by: { type: "skill", path: `skills/${pattern}/SKILL.md` },
        promoted_at: "2026-09-01T00:00:00Z",
      },
    },
  };
  writeFileSync(path, JSON.stringify(ledger), "utf8");
}

async function artifactsText(): Promise<{ code: number; text: string }> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  let code: number;
  try {
    code = await run(["artifacts", "--world", "default"]);
  } finally {
    console.log = orig;
  }
  return { code, text: logs.join("\n") };
}

describe("sil artifacts", () => {
  test("shows the three rate windows for a promoted pattern, n/a with no reflected sessions", async () => {
    expect(await run(["init"])).toBe(0);
    seedPromotedRow("verify-callsites");

    const { code, text } = await artifactsText();

    expect(code).toBe(0);
    expect(text).toContain("verify-callsites");
    expect(text).toContain("rate baseline=n/a (0 sessions) since_promotion=n/a (0 sessions) since_revision=n/a (0 sessions)");
  });

  test("--json carries the scorecard rate fields", async () => {
    expect(await run(["init"])).toBe(0);
    seedPromotedRow("verify-callsites");

    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await run(["artifacts", "--world", "default", "--json"]);
    } finally {
      console.log = orig;
    }

    expect(code).toBe(0);
    const payload = JSON.parse(logs.join("\n"));
    const row = payload.inventory.find((r: { pattern: string }) => r.pattern === "verify-callsites");
    expect(row.scorecard).toMatchObject({
      rate_baseline: { sessions: 0, hits: 0, rate: null },
      rate_since_promotion: { sessions: 0, hits: 0, rate: null },
      rate_since_revision: { sessions: 0, hits: 0, rate: null },
    });
  });
});
