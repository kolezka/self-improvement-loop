// Loop state end to end through the real modules, no mocks and no seams: four
// legacy JSONL logs in a tmp home, read back through scorecards, proposal
// events, history.series and the real `sil state` CLI. Then the way back:
// export to the legacy paths and migrate again without doubling a row.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Ledger, ledgerPath, loadConfig, paths, type Scorecard, worldNamed } from "@sil/core";
import * as feedback from "@sil/feedback";
import { invoke } from "@sil/ops";
import { closeState, readRecords, type StateStatus, type Stream } from "@sil/statedb";
import { readProposalEvents, saveLedger } from "@sil/store";
import type { HistorySeries } from "../packages/ops/src/handlers/history.ts";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "apps/cli/src/main.ts");
const ENV_KEYS = ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_ROOT", "HOME"];

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-e2e-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["SIL_CONFIG_DIR"] = join(tmp, "config");
  process.env["SIL_STATE_DIR"] = join(tmp, "state");
  process.env["SIL_DATA_DIR"] = join(tmp, "data");
  process.env["CLAUDE_CONFIG_DIR"] = join(tmp, "claude");
  process.env["CLAUDE_PLUGIN_ROOT"] = REPO;
  process.env["HOME"] = join(tmp, "home");
  mkdirSync(process.env["HOME"]);
});

afterEach(() => {
  try {
    closeState();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** Built from the tmp dirs at spawn time: a spawned child must never see the real home. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "" };
  for (const k of ENV_KEYS) env[k] = process.env[k]!;
  return env;
}

function sil(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", CLI, ...args], { env: childEnv() });
  return { exitCode: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const WORLD = "default";
const PATTERN = "verify-callsites";
const REF = `skill:${PATTERN}`;

/** The four legacy logs as the previous release wrote them, one compact JSON object per line. */
function seeds(): Record<Stream, Record<string, unknown>[]> {
  const ts = new Date().toISOString();
  return {
    reflect_runs: [1, 2, 3].map((i) => ({ ts, world: WORLD, session_id: `s-${i}`, recorded: i !== 2 })),
    critic: [
      { ts, world: WORLD, ref: REF, verdict: "helpful", session_id: "s-1" },
      { ts, world: WORLD, ref: REF, verdict: "helpful", session_id: "s-2" },
      { ts, world: WORLD, ref: REF, verdict: "misfired", reason: "fired on a docs edit", session_id: "s-3" },
      { ts, world: WORLD, ref: REF, verdict: "used", session_id: "s-3" },
    ],
    human: [
      { ts, world: WORLD, ref: REF, vote: "good", note: "" },
      { ts, world: WORLD, ref: REF, vote: "bad", note: "too noisy" },
    ],
    proposal_events: [
      { ts, world: WORLD, pattern: PATTERN, event: "staged" },
      { ts, world: WORLD, pattern: PATTERN, event: "accepted" },
      { ts, world: WORLD, pattern: "other-pattern", event: "rejected" },
    ],
  };
}

const LEGACY: Record<Stream, () => string> = {
  reflect_runs: () => paths.reflectRunsFile(),
  critic: () => paths.criticFeedbackFile(),
  human: () => paths.humanFeedbackFile(),
  proposal_events: () => paths.proposalEventsFile(),
};
const STREAM_NAMES = Object.keys(LEGACY) as Stream[];

/** Writes every legacy file and returns its exact text. */
function seedLegacy(): Record<Stream, string> {
  const s = seeds();
  const text = {} as Record<Stream, string>;
  for (const stream of STREAM_NAMES) {
    text[stream] = s[stream].map((r) => JSON.stringify(r)).join("\n") + "\n";
    mkdirSync(dirname(LEGACY[stream]()), { recursive: true });
    writeFileSync(LEGACY[stream](), text[stream]);
  }
  // Promoted a week ago, so the scorecard's rate window counts the reflect runs.
  const world = worldNamed(loadConfig(), WORLD);
  const promotedAt = new Date(Date.now() - 7 * 86_400_000).toISOString();
  saveLedger(
    ledgerPath(world),
    Ledger.parse({ entries: { [PATTERN]: { pattern: PATTERN, status: "promoted", artifact_type: "skill", promoted_at: promotedAt } } }),
  );
  return text;
}

function statusJson(): StateStatus {
  const out = sil(["state", "status", "--json"]);
  expect(out.stderr).toBe("");
  expect(out.exitCode).toBe(0);
  return JSON.parse(out.stdout) as StateStatus;
}

const total = (points: { count: number }[]): number => points.reduce((n, p) => n + p.count, 0);

describe("loop state end to end", () => {
  test("legacy logs import once, read the same through every reader, and keep byte-exact backups", async () => {
    const text = seedLegacy();
    for (const stream of STREAM_NAMES) expect(existsSync(LEGACY[stream]())).toBe(true);
    expect(existsSync(paths.loopStateDb())).toBe(false);

    // Scorecards: critic and human counts on the card, reflect runs in the rate window.
    const world = worldNamed(loadConfig(), WORLD);
    const written = feedback.rebuild(world, loadConfig());
    const cards = JSON.parse(readFileSync(written, "utf8")) as Scorecard[];
    const card = cards.find((c) => c.ref === REF);
    expect(card).toBeDefined();
    expect(card!.helpful).toBe(2);
    expect(card!.misfired).toBe(1);
    expect(card!.human_good).toBe(1);
    expect(card!.human_bad).toBe(1);
    expect(card!.rate_since_promotion?.sessions).toBe(3);

    const proposals = readProposalEvents();
    expect(proposals.skipped).toBe(0);
    expect(proposals.events.map((e) => e.event)).toEqual(["staged", "accepted", "rejected"]);

    const history = (await invoke("history.series", { world: WORLD })) as HistorySeries;
    expect(total(history.series.votes_good)).toBe(1);
    expect(total(history.series.votes_bad)).toBe(1);
    expect(total(history.series.critic_verdicts)).toBe(4);
    expect(total(history.series.proposals_staged)).toBe(1);
    expect(total(history.series.proposals_accepted)).toBe(1);
    expect(total(history.series.proposals_rejected)).toBe(1);
    expect(history.skipped.critic_verdicts).toBe(0);

    // The real CLI in a child. Its dbPath being the tmp one is the positive
    // control that the child ran against the tmp home, not the real one.
    const status = statusJson();
    expect(status.dbPath).toBe(resolve(join(tmp, "state", "loop-state.sqlite")));
    expect(status.schemaVersion).toBe(1);
    expect(status.suspended).toBeNull();
    const counts = { reflect_runs: 3, critic: 4, human: 2, proposal_events: 3 };
    for (const stream of STREAM_NAMES) {
      expect(status.streams[stream]).toEqual({ rows: counts[stream], quarantined: 0, pending: false });
    }
    expect(status.imports).toHaveLength(4);
    for (const imp of status.imports) {
      const stream = imp.store as Stream;
      expect(imp.state).toBe("verified");
      expect(imp.backupCheck).toBe("ok");
      expect(imp.lines).toBe(counts[stream]);
      // The original sits under P.imported-<stamp>-<id>, byte for byte.
      expect(imp.backupPath!.startsWith(`${LEGACY[stream]()}.imported-`)).toBe(true);
      expect(imp.backupPath).toMatch(/\.imported-[^/]+-\d+$/);
      expect(readFileSync(imp.backupPath!, "utf8")).toBe(text[stream]);
      expect(existsSync(LEGACY[stream]())).toBe(false);
    }
    expect(new Set(status.imports.map((i) => i.store))).toEqual(new Set(STREAM_NAMES));
  });

  test("the way back: export writes the legacy files, migrate takes them back without doubling a row", async () => {
    const text = seedLegacy();
    const first = sil(["state", "migrate"]);
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(0);
    for (const stream of STREAM_NAMES) expect(existsSync(LEGACY[stream]())).toBe(false);

    const exported = sil(["state", "export", "--legacy-paths"]);
    expect(exported.stderr).toBe("");
    expect(exported.exitCode).toBe(0);
    for (const stream of STREAM_NAMES) {
      expect(exported.stdout).toContain(`wrote ${LEGACY[stream]()}`);
      // What the older plugin reads is what it wrote.
      expect(readFileSync(LEGACY[stream](), "utf8")).toBe(text[stream]);
    }

    // While suspended, the files stay put and nothing is imported twice.
    const suspended = statusJson();
    expect(suspended.suspended).not.toBeNull();
    expect(readRecords("critic", "strict").records).toHaveLength(4);
    for (const stream of STREAM_NAMES) expect(existsSync(LEGACY[stream]())).toBe(true);

    // A second export without --force refuses to overwrite.
    const again = sil(["state", "export", "--legacy-paths"]);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("pass --force to overwrite it");

    const back = sil(["state", "migrate"]);
    expect(back.stderr).toBe("");
    expect(back.exitCode).toBe(0);
    expect(back.stdout).toContain("resumed legacy imports");

    const after = statusJson();
    expect(after.suspended).toBeNull();
    const counts = { reflect_runs: 3, critic: 4, human: 2, proposal_events: 3 };
    for (const stream of STREAM_NAMES) {
      expect(after.streams[stream]).toEqual({ rows: counts[stream], quarantined: 0, pending: false });
      expect(existsSync(LEGACY[stream]())).toBe(false);
    }
    expect(readProposalEvents().events).toHaveLength(3);
  });
});
