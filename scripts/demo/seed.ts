// Fills an isolated SIL home with fake data for the README demo recording.
// Run through scripts/demo/record.sh, which sets SIL_*_DIR to a temp dir.
// No model is called: drafts come from a canned chat function.

import { loadConfig } from "@sil/core";
import { run } from "@sil/curriculum";
import * as feedback from "@sil/feedback";
import * as review from "@sil/review";
import { writeReflection } from "@sil/store";
import { fakeGateRunner, installFakeNudge } from "../../packages/curriculum/test/fixtures.ts";

if (!process.env["SIL_DATA_DIR"]?.includes("sil-demo")) {
  throw new Error("refusing to seed: SIL_DATA_DIR must point at a sil-demo temp dir");
}

interface Lesson {
  pattern: string;
  count: number;
  failed: string;
  lesson: string;
  description: string;
}

const LESSONS: Lesson[] = [
  {
    pattern: "worktree-tests-hit-main",
    count: 4,
    failed: "Edited files in a worktree but ran the test suite from the main checkout.",
    lesson: "Run tests from the worktree root you edited. Print `git rev-parse --show-toplevel` before trusting a green run.",
    description: "Use when running tests after editing files in a git worktree.",
  },
  {
    pattern: "verify-callsites",
    count: 3,
    failed: "Called a refactor safe after checking one caller while a second caller had no guard.",
    lesson: "Run `rg` over every call site of a changed symbol before calling the change safe.",
    description: "Use when a change touches a shared symbol and you are about to call it safe.",
  },
  {
    pattern: "stale-lockfile",
    count: 3,
    failed: "Trusted a frozen lockfile install and shipped a stale lockfile to the release branch.",
    lesson: "Diff `bun.lock` after install. A frozen install accepts a stale lockfile.",
    description: "Use when committing dependency changes.",
  },
  { pattern: "env-snapshot-in-spawn", count: 2, failed: "Set process.env after spawn started.", lesson: "Pass env explicitly to Bun.spawn.", description: "" },
  { pattern: "unbounded-regex-input", count: 1, failed: "Regex ran on a 2 MB transcript.", lesson: "Bound regex input at load time.", description: "" },
  { pattern: "silent-default-model", count: 2, failed: "Fell back to a default model when config was missing.", lesson: "Raise ModelNotConfigured, never pick a default.", description: "" },
];

function body(l: Lesson, day: string): string {
  return (
    `Last updated: ${day}\n\nPattern: ${l.pattern}\n\n` +
    "## What worked\nReading the failing output before changing code.\n\n" +
    `## What failed & why\n${l.failed}\n\n` +
    `## Reusable lesson\n${l.lesson}\n\n` +
    "## Verification\nRe-ran the check and read the result.\n\n" +
    "## Not verified\nWhether other repos hit the same trap.\n"
  );
}

function skill(l: Lesson): Record<string, unknown> {
  return {
    trigger_event: "none",
    gate: null,
    needs_own_context: false,
    context_evidence: null,
    capability_evidence: l.failed,
    no_artifact: false,
    artifact: `---\nname: ${l.pattern}\ndescription: ${l.description}\n---\n\n## ${l.lesson.split(".")[0]}\n\n${l.lesson}\n\nEvidence: ${l.failed}\n`,
  };
}

const cfg = loadConfig();
const world = cfg.worlds[0]!;
installFakeNudge();

let n = 0;
for (const l of LESSONS) {
  for (let i = 0; i < l.count; i++) {
    const day = `2026-09-${String(3 + ((n * 5) % 26)).padStart(2, "0")}`;
    writeReflection(world.name, { id: `${day}-${l.pattern}-${i}`, created: day, session_id: `demo-${n}` }, body(l, day));
    n++;
  }
}

// Stage the three patterns past the threshold, then accept one so it gets a scorecard.
const promotable = LESSONS.filter((l) => l.count >= 3);
// The drafter prompt quotes its own pattern's reflections most, so pick the most named.
const chat = async (role: string, messages: { role: string; content: string }[]): Promise<string> => {
  if (role === "judge") return JSON.stringify({ verdict: "yes", reason: "quoted from a source" });
  const prompt = messages.map((m) => m.content).join("\n");
  const hits = (l: Lesson) => prompt.split(l.pattern).length - 1;
  const match = [...promotable].sort((a, b) => hits(b) - hits(a))[0];
  if (!match || hits(match) === 0) throw new Error("drafter prompt names no known pattern");
  return JSON.stringify(skill(match));
};
const result = await run(world, cfg, { apply: true, chat, gateRunner: fakeGateRunner });

const accepted = "verify-callsites";
const detail = review.detail(world, cfg, accepted);
review.accept(world, cfg, accepted, detail.reviewed_state);

const now = Date.now();
for (let i = 0; i < 14; i++) {
  feedback.appendUsage({
    ts: new Date(now - i * 7_200_000).toISOString(),
    session_id: `demo-use-${i}`,
    world: world.name,
    kind: "skill",
    ref: `skill:${accepted}`,
    detail: {},
  });
}
for (const note of ["caught an unguarded caller", "saved a revert"]) {
  feedback.recordHuman({ ts: new Date(now).toISOString(), world: world.name, ref: `skill:${accepted}`, vote: "good", note, session_id: null });
}
await feedback.rebuild(world, cfg);
console.log(`seeded ${n} reflections, queue: ${review.queue(world, cfg).map((r) => r.pattern).join(", ")}`);
