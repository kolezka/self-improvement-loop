#!/usr/bin/env bun
// Builds a fully fake, deterministic demo home for the self-improvement-loop
// web console: one world ("default"), a mix of promoted, staged and
// below-threshold reflections, and usage/feedback signal for the three
// promoted artifacts (two clean, one backdated into a misfiring
// retire-candidate). No model is called, no network is reached, and nothing
// outside `root` is ever touched.
//
// Staging and promotion go through the real engine paths (curriculum.run with
// a canned chat, then review.detail/accept), the same way the test suite
// drives them in packages/curriculum/test/fixtures.ts and
// packages/review/test/review.test.ts.
//
// Run: bun scripts/demo/seed.ts <root>

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  Config,
  Endpoint,
  fsx,
  HumanFeedback,
  LlmConfig,
  loadConfig,
  paths,
  ReflectRunEvent,
  saveConfig,
  saveLlm,
  targetRoot,
  UsageEvent,
  World,
  worldNamed,
  writeHookSnapshot,
  type World as WorldT,
} from "@sil/core";
import * as curriculum from "@sil/curriculum";
import * as feedback from "@sil/feedback";
import * as review from "@sil/review";
import * as store from "@sil/store";
import type { ChatFn } from "@sil/providers";

// "default" is the world `sil init` creates, so the demo matches a fresh install.
export const DEMO_WORLD = "default";
export const STAGED_PATTERN = "verify-callsites";
export const PROMOTED_SKILL_PATTERN = "read-before-edit";
export const PROMOTED_RULE_PATTERN = "worktree-before-edit";
export const MISFIRE_PATTERN = "run-full-suite";
export const MISFIRE_REF = "hook:run-full-suite";

// --- env -----------------------------------------------------------------

// Only these pass through from the operator's shell. Everything else, secrets
// and GIT_DIR or GIT_CONFIG_* overrides included, stays out of the demo.
const PASSTHROUGH_ENV = ["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ"];

/** Env for every process that touches the demo home. Pure: no fs writes. */
export function demoEnv(root: string, repoRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env["HOME"] = join(root, "home");
  env["SIL_CONFIG_DIR"] = join(root, "config");
  env["SIL_STATE_DIR"] = join(root, "state");
  env["SIL_DATA_DIR"] = join(root, "data");
  env["CLAUDE_CONFIG_DIR"] = join(root, "claude");
  env["CLAUDE_PLUGIN_ROOT"] = repoRoot;
  // git must never read the operator's own config while the demo repo is built.
  env["GIT_CONFIG_GLOBAL"] = join(root, "gitconfig");
  env["GIT_CONFIG_SYSTEM"] = join(root, "gitconfig");
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  // Bun would otherwise write its transpiler cache under the fake HOME at
  // startup, before seedDemoHome checks that the root is empty.
  env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"] = "0";
  return env;
}

/** Replaces process.env outright, so nothing inherited survives the switch. */
function applyEnv(env: Record<string, string>): void {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

// --- dates -------------------------------------------------------------------

// Dates below are written as if the demo were recorded on 2026-10-01. They are
// shifted by the days since then, so a later recording still lands inside the
// 30 day scorecard window instead of showing zero uses.
const DESIGN_DAY = Date.parse("2026-10-01T00:00:00Z");
const SHIFT_MS = Math.floor((Date.now() - DESIGN_DAY) / 86_400_000) * 86_400_000;

function onDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + SHIFT_MS).toISOString().slice(0, 10);
}

function at(day: string, time: string): string {
  return `${onDay(day)}T${time}.000Z`;
}

// --- fake clock ----------------------------------------------------------

// `review.accept` stamps `promoted_at` with `fsx.nowIso()` (packages/core's
// `new Date().toISOString()`), so a real promotion with a backdated history
// has no supported knob: this overrides the global `Date` for the duration of
// one call. The offset is fixed at install time and real time keeps advancing
// underneath it, so a slow call still sees seconds tick forward rather than a
// frozen instant.
//
// git's own commit timestamps come from the git binary's system clock, not
// this process's Date, and stay real: acceptable here because the web
// console and `sil artifacts`/`review` never display a commit date, only the
// short commit sha (apps/web/src/lib/api-types.ts's `commit: string | null`).
async function withFakeNow<T>(targetDay: string, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const offsetMs = Date.parse(`${targetDay}T12:00:00Z`) - RealDate.now();
  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offsetMs);
      else super(...(args as ConstructorParameters<typeof Date>));
    }
    static override now(): number {
      return RealDate.now() + offsetMs;
    }
  }
  (globalThis as { Date: typeof Date }).Date = FakeDate as unknown as typeof Date;
  try {
    return await fn();
  } finally {
    (globalThis as { Date: typeof Date }).Date = RealDate;
  }
}

// --- reflection bodies -----------------------------------------------------

interface ReflectionSpec {
  pattern: string;
  created: string;
  sessionId: string;
  worked: string;
  failed: string;
  lesson: string;
  verification: string;
  notVerified: string;
}

/** The SECTIONS shape from @sil/core's reflection template, filled with
 * varied, realistic text per occurrence. */
function reflectionBody(s: ReflectionSpec): string {
  return (
    `Last updated: ${s.created}\n\n` +
    `Pattern: ${s.pattern}\n\n` +
    "## What worked\n" +
    `${s.worked}\n\n` +
    "## What failed & why\n" +
    `${s.failed}\n\n` +
    "## Reusable lesson\n" +
    `${s.lesson}\n\n` +
    "## Verification\n" +
    `${s.verification}\n\n` +
    "## Not verified\n" +
    `${s.notVerified}\n`
  );
}

function writeSpecs(world: WorldT, specs: ReflectionSpec[]): void {
  for (const [i, spec] of specs.entries()) {
    const s = { ...spec, created: onDay(spec.created) };
    const id = `${s.created}-${s.pattern}-${String(i).padStart(2, "0")}`;
    store.writeReflection(world.name, { id, created: s.created, session_id: s.sessionId }, reflectionBody(s));
  }
}

// The exact sentence quoted verbatim by the skill draft's capability_evidence,
// and embedded verbatim in every reflection's "Reusable lesson" section: the
// router's substantiveQuote() and the lint's lintGrounding() both need a real
// word-for-word match, not a paraphrase.
const READ_LESSON =
  "Read the whole function and every caller before editing it, because a caller " +
  "relying on the old behavior breaks silently when the function changes.";

const WORKTREE_BULLET_TEXT =
  "Work in an isolated git worktree before editing shared code, because a direct " +
  "edit on the main checkout blocks every other branch until it lands.";

const VERIFY_LESSON =
  "Before calling a change safe, enumerate every call site of the changed symbol " +
  "with ripgrep and confirm each consumer still honors its guard.";

const RUN_FULL_SUITE_LESSON =
  "Run the full test suite before committing or pushing, because a partial run " +
  "after editing one module can still miss a break somewhere else.";

function readBeforeEditReflections(): ReflectionSpec[] {
  return [
    {
      pattern: PROMOTED_SKILL_PATTERN,
      created: "2026-09-01",
      sessionId: "demo-session-rbe-0",
      worked: "Reading calculateRefund end to end before touching its rounding mode parameter.",
      failed:
        "I edited the function's default rounding mode without reading its callers first, and a " +
        "webhook handler that passed no explicit mode started rounding refunds the wrong way.",
      lesson: READ_LESSON,
      verification: "Re-ran the payments service's refund suite after reading every caller; all green.",
      notVerified: "Whether a third-party integration outside this repository also calls the function.",
    },
    {
      pattern: PROMOTED_SKILL_PATTERN,
      created: "2026-09-03",
      sessionId: "demo-session-rbe-1",
      worked: "Grepping the deploy tool for every place the old flag name appeared before renaming it.",
      failed:
        "I renamed --dry-run to --plan inside the flag-parsing function without reading its one " +
        "remaining caller, a docs generator script that still passed the old flag name.",
      lesson: READ_LESSON,
      verification: "Ran the docs generator against the renamed flag and confirmed it failed loud, then fixed it.",
      notVerified: "Whether any operator alias still invokes the tool with the old flag name.",
    },
    {
      pattern: PROMOTED_SKILL_PATTERN,
      created: "2026-09-05",
      sessionId: "demo-session-rbe-2",
      worked: "Reading the retry helper's call sites before changing its backoff calculation.",
      failed:
        "I changed the backoff calculation inside the retry helper function without reading every " +
        "caller, and a flaky integration test's caller relied on the old, shorter backoff timing.",
      lesson: READ_LESSON,
      verification: "Re-ran the integration suite ten times after reading every caller; no flakes.",
      notVerified: "Whether the CI runner's own retry wrapper is affected by the new timing.",
    },
  ];
}

function worktreeBeforeEditReflections(): ReflectionSpec[] {
  return [
    {
      pattern: PROMOTED_RULE_PATTERN,
      created: "2026-09-04",
      sessionId: "demo-session-wbe-0",
      worked: "Branching into a worktree before editing the database migration runner.",
      failed:
        "I edited the migration runner directly on the main checkout instead of an isolated git " +
        "worktree, which left the main checkout half migrated and blocked a teammate's branch.",
      lesson: WORKTREE_BULLET_TEXT,
      verification: "Re-did the migration edit in an isolated git worktree and merged it cleanly.",
      notVerified: "Whether the migration runner itself is safe to re-run after a partial apply.",
    },
    {
      pattern: PROMOTED_RULE_PATTERN,
      created: "2026-09-06",
      sessionId: "demo-session-wbe-1",
      worked: "Starting a fresh worktree before touching the shared config loader.",
      failed:
        "I patched the shared config loader in the primary checkout, not an isolated git worktree, " +
        "and the direct edit on the main checkout blocked every other branch until it landed.",
      lesson: WORKTREE_BULLET_TEXT,
      verification: "Confirmed the primary checkout stayed clean while the worktree carried the edit.",
      notVerified: "Whether the config loader's cache needs an explicit invalidation after the patch.",
    },
    {
      pattern: PROMOTED_RULE_PATTERN,
      created: "2026-09-08",
      sessionId: "demo-session-wbe-2",
      worked: "Opening an isolated git worktree before adjusting the request logger.",
      failed:
        "I adjusted the logging middleware on the main branch directly, and the direct edit on the " +
        "main checkout blocked every other branch until it landed, costing a teammate a rebase.",
      lesson: WORKTREE_BULLET_TEXT,
      verification: "Redid the change in an isolated git worktree; main stayed buildable the whole time.",
      notVerified: "Whether the logger's own test suite covers the middleware's error path.",
    },
  ];
}

function verifyCallsitesReflections(): ReflectionSpec[] {
  return [
    {
      pattern: STAGED_PATTERN,
      created: "2026-09-21",
      sessionId: "demo-session-vcs-0",
      worked: "Running ripgrep over the fee calculation function before calling the change safe.",
      failed:
        "I generalised from the one obvious consumer of the fee calculation function and missed an " +
        "unguarded call site in the payments service's batch job.",
      lesson: VERIFY_LESSON,
      verification: "Ran `rg` over the changed symbol and counted 9 call sites, all now guarded.",
      notVerified: "Whether a dynamically dispatched caller outside this repository exists.",
    },
    {
      pattern: STAGED_PATTERN,
      created: "2026-09-23",
      sessionId: "demo-session-vcs-1",
      worked: "Enumerating every call site of the renamed --output flag's parser before shipping.",
      failed:
        "I called the --output flag rename safe after checking only the CLI entry point, and missed " +
        "a consumer in a shell completion script that still read the old flag shape.",
      lesson: VERIFY_LESSON,
      verification: "Ran `rg` over the parser's changed symbol and found the completion script's call site.",
      notVerified: "Whether any external plugin also parses the flag directly.",
    },
    {
      pattern: STAGED_PATTERN,
      created: "2026-09-25",
      sessionId: "demo-session-vcs-2",
      worked: "Checking every call site of the shared test fixture builder before trusting the fix.",
      failed:
        "A flaky test's fixture builder changed shape, and I called the change safe before finding a " +
        "second suite's unguarded call site that still built the old fixture shape.",
      lesson: VERIFY_LESSON,
      verification: "Ran `rg` over the fixture builder's changed symbol across both suites.",
      notVerified: "Whether a third, rarely run suite also calls the builder.",
    },
    {
      pattern: STAGED_PATTERN,
      created: "2026-09-27",
      sessionId: "demo-session-vcs-3",
      worked: "Enumerating every call site of the config merge function before calling it safe.",
      failed:
        "I changed the config merge function's precedence order and called it safe from the one " +
        "obvious consumer, missing an unguarded call site in the worker's own bootstrap path.",
      lesson: VERIFY_LESSON,
      verification: "Ran `rg` over the merge function's changed symbol and guarded the bootstrap call site.",
      notVerified: "Whether a cached config snapshot elsewhere still holds the old precedence order.",
    },
  ];
}

/** This pattern is staged as a hook, promoted, and then left to misfire: the
 * reflections read like real sessions, but the artifact it buys goes on to
 * nudge on trivial doc edits (seeded in `seedScorecardSignal`), which is the
 * whole point: the Artifacts pane should show a planner proposing
 * retire-candidate for something that still does fire. */
function runFullSuiteReflections(): ReflectionSpec[] {
  return [
    {
      pattern: MISFIRE_PATTERN,
      created: "2026-09-07",
      sessionId: "demo-session-rfs-0",
      worked: "Running the full test suite before pushing a change to the fee calculation module.",
      failed:
        "I committed a fix to the fee calculation module after running only its own test file, and a " +
        "partial run after editing one module missed a break in the reporting module's integration test.",
      lesson: RUN_FULL_SUITE_LESSON,
      verification: "Ran the full suite after the fact and found the reporting module's failure.",
      notVerified: "Whether a slower, nightly-only suite would have caught it sooner.",
    },
    {
      pattern: MISFIRE_PATTERN,
      created: "2026-09-09",
      sessionId: "demo-session-rfs-1",
      worked: "Running the full suite before pushing a change to the shared auth middleware.",
      failed:
        "I pushed a change to the shared auth middleware after a partial run of just its own tests, and " +
        "a break in an unrelated billing test only showed up once the full suite finally ran in CI.",
      lesson: RUN_FULL_SUITE_LESSON,
      verification: "Ran the full suite locally afterward and reproduced the billing test failure.",
      notVerified: "Whether the billing test's dependency on auth middleware is intentional.",
    },
    {
      pattern: MISFIRE_PATTERN,
      created: "2026-09-11",
      sessionId: "demo-session-rfs-2",
      worked: "Running the full suite before committing a change to the shared logging format.",
      failed:
        "I committed a change to the shared logging format after a partial run limited to the logging " +
        "package, and a break somewhere else, in a log-parsing test for another service, went unnoticed.",
      lesson: RUN_FULL_SUITE_LESSON,
      verification: "Ran the full suite and found the log-parsing test failure before it reached review.",
      notVerified: "Whether every downstream consumer of the log format has a test at all.",
    },
  ];
}

function belowThresholdReflections(): ReflectionSpec[] {
  return [
    {
      pattern: "quote-zsh-globs",
      created: "2026-09-29",
      sessionId: "demo-session-qzg-0",
      worked: "Quoting the glob pattern before handing it to the deploy script's zsh shell.",
      failed:
        "An unquoted glob in a deploy script expanded against the local directory instead of being " +
        "passed through to the remote command, deploying the wrong file set.",
      lesson: "Quote every glob pattern passed to a zsh script, or it expands locally before the command runs.",
      verification: "Re-ran the deploy script with the pattern quoted and confirmed the remote file set.",
      notVerified: "Whether bash scripts in the same pipeline have the same exposure.",
    },
    {
      pattern: "flag-unknowns",
      created: "2026-09-30",
      sessionId: "demo-session-fu-0",
      worked: "Checking the CLI's own exit code after passing an unrecognized flag.",
      failed:
        "An unrecognized flag was silently ignored by the argument parser instead of failing loud, " +
        "so a typo'd flag ran the command with its default behavior instead of refusing.",
      lesson: "Flag an unknown CLI argument as a hard error instead of silently falling back to a default.",
      verification: "Passed a typo'd flag and confirmed the parser now exits non-zero.",
      notVerified: "Whether every subcommand's parser shares the same strict behavior.",
    },
  ];
}

// --- drafts ----------------------------------------------------------------

function skillArtifact(pattern: string, description: string, title: string, lesson: string): string {
  return (
    `---\nname: ${pattern}\ndescription: ${description}\n---\n\n` +
    `## ${title}\n\n${lesson}\n`
  );
}

function skillDraft(artifact: string, quote: string): Record<string, unknown> {
  return {
    trigger_event: "none",
    gate: null,
    needs_own_context: false,
    context_evidence: null,
    capability_evidence: quote,
    no_artifact: false,
    artifact,
  };
}

function ruleDraft(bullet: string): Record<string, unknown> {
  return {
    trigger_event: "none",
    gate: null,
    needs_own_context: false,
    context_evidence: null,
    capability_evidence: null,
    no_artifact: false,
    artifact: bullet,
  };
}

/** A nudge payload, same shape as `hookBody` in
 * packages/curriculum/test/fixtures.ts. `command_matches` is checked against
 * two checked-in fixtures the router always has on hand
 * (tests/fixtures/hook-payloads/pretooluse-bash-git-commit.json and
 * -push.json, 2 hits out of 21 total payloads), so the gate routes to `hook`
 * without this script having to seed its own payload-sample corpus. */
function hookBody(pattern: string): Record<string, unknown> {
  return {
    pattern,
    event: "PreToolUse",
    matcher: "Bash",
    gate: { command_matches: "git (commit|push)" },
    once_per: "session",
    text: `${RUN_FULL_SUITE_LESSON} The promotions ledger only records a watermark, not whether a break was caught.`,
  };
}

function hookDraft(pattern: string): Record<string, unknown> {
  return {
    trigger_event: "PreToolUse:Bash",
    gate: { command_matches: "git (commit|push)" },
    needs_own_context: false,
    context_evidence: null,
    capability_evidence: null,
    no_artifact: false,
    artifact: hookBody(pattern),
  };
}

/** A canned `chat`, modeled on FakeChat in packages/curriculum/test/fixtures.ts:
 * drafter always returns `draft`, judge always accepts. Never calls a model. */
function makeChat(draft: Record<string, unknown>): ChatFn {
  return (async (role: string) => {
    if (role === "judge") return JSON.stringify({ verdict: "yes", reason: "grounded in its sources" });
    if (role === "drafter") return JSON.stringify(draft);
    throw new Error(`demo seed: unexpected chat role ${JSON.stringify(role)}`);
  }) as ChatFn;
}

/** Stages and accepts `pattern`, with the whole curriculum.run + review.accept
 * sequence running under a fake clock pinned to `promotedDay`, so
 * `review.accept`'s `fsx.nowIso()` stamp (packages/review/src/index.ts) backdates
 * `promoted_at` instead of recording the moment this script happened to run. */
async function promote(
  world: WorldT,
  cfg: Config,
  pattern: string,
  draft: Record<string, unknown>,
  promotedDay: string,
  expectedType?: "skill" | "hook" | "rule" | "agent",
): Promise<void> {
  await withFakeNow(promotedDay, async () => {
    const report = await curriculum.run(world, cfg, { apply: true, chat: makeChat(draft) });
    if (report.staged.length !== 1 || report.staged[0] !== pattern) {
      throw new Error(`seed: expected only ${pattern} staged, got ${JSON.stringify(report.staged)}, gated_out=${JSON.stringify(report.gated_out)}`);
    }
    const detail = review.detail(world, cfg, pattern);
    if (expectedType && detail.artifact_type !== expectedType) {
      throw new Error(`seed: ${pattern} routed to ${detail.artifact_type}, expected ${expectedType} (reason recorded in routed.${pattern})`);
    }
    if (detail.accept_blocked) throw new Error(`seed: ${pattern} accept_blocked: ${detail.accept_blocked}`);
    const out = review.accept(world, cfg, pattern, detail.reviewed_state);
    if (!out.merged) throw new Error(`seed: ${pattern} did not merge: ${JSON.stringify(out)}`);
  });
}

async function stageOnly(world: WorldT, cfg: Config, pattern: string, draft: Record<string, unknown>): Promise<void> {
  const report = await curriculum.run(world, cfg, { apply: true, chat: makeChat(draft) });
  if (report.staged.length !== 1 || report.staged[0] !== pattern) {
    throw new Error(`seed: expected only ${pattern} staged, got ${JSON.stringify(report.staged)}, gated_out=${JSON.stringify(report.gated_out)}`);
  }
  const detail = review.detail(world, cfg, pattern);
  if (detail.accept_blocked) throw new Error(`seed: ${pattern} unexpectedly accept_blocked: ${detail.accept_blocked}`);
}

// --- scorecard signal --------------------------------------------------------

/** Usage events, human votes, critic verdicts and reflect-run denominators for
 * all three promoted artifacts, so the Artifacts pane's live scorecard reads a
 * real rate instead of "n/a (0 sessions)". Dates stay inside the reflection
 * window so they are always within a 30 day scorecard window from "now". */
function seedScorecardSignal(world: WorldT): void {
  const rbeUseDays = ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-24", "2026-09-26", "2026-09-28", "2026-09-30"];
  rbeUseDays.forEach((day, i) => {
    feedback.appendUsage(
      UsageEvent.parse({
        ts: at(day, "09:00:00"),
        session_id: `demo-use-rbe-${i}`,
        world: world.name,
        kind: "skill",
        ref: `skill:${PROMOTED_SKILL_PATTERN}`,
      }),
    );
  });
  for (const day of ["2026-09-22", "2026-09-26", "2026-09-29"]) {
    feedback.recordHuman(
      HumanFeedback.parse({
        ts: at(day, "10:00:00"),
        world: world.name,
        ref: `skill:${PROMOTED_SKILL_PATTERN}`,
        vote: "good",
        note: "Caught a caller I would have missed.",
      }),
    );
  }
  for (const [i, day] of ["2026-09-21", "2026-09-27"].entries()) {
    fsx.appendJsonl(paths.criticFeedbackFile(), {
      ref: `skill:${PROMOTED_SKILL_PATTERN}`,
      verdict: "helpful",
      reason: "The skill surfaced the caller before the session called the change safe.",
      reflection_id: `demo-critic-rbe-${i}`,
      ts: at(day, "11:00:00"),
      world: world.name,
    });
  }

  const wbeUseDays = ["2026-09-21", "2026-09-24", "2026-09-27", "2026-09-30"];
  wbeUseDays.forEach((day, i) => {
    feedback.appendUsage(
      UsageEvent.parse({
        ts: at(day, "09:30:00"),
        session_id: `demo-use-wbe-${i}`,
        world: world.name,
        kind: "rule",
        ref: `rule:${PROMOTED_RULE_PATTERN}`,
      }),
    );
  });
  for (const day of ["2026-09-23", "2026-09-28"]) {
    feedback.recordHuman(
      HumanFeedback.parse({
        ts: at(day, "10:30:00"),
        world: world.name,
        ref: `rule:${PROMOTED_RULE_PATTERN}`,
        vote: "good",
        note: "Stopped me editing the main checkout directly.",
      }),
    );
  }
  fsx.appendJsonl(paths.criticFeedbackFile(), {
    ref: `rule:${PROMOTED_RULE_PATTERN}`,
    verdict: "helpful",
    reason: "The rule was quoted back before the session touched the main checkout.",
    reflection_id: "demo-critic-wbe-0",
    ts: at("2026-09-25", "11:30:00"),
    world: world.name,
  });

  // run-full-suite: promoted 09-12, fires for real afterward (it is a working
  // hook, not a dead one), but it fires on trivial commits as often as useful
  // ones. packages/feedback/src/index.ts's propose() only has one
  // `retire-candidate` path, and it requires `uses + fires === 0`; a hook
  // with real fires can never take it. Giving it nonzero fires routes it to
  // the misfired/human_bad fallback branch instead: `refine`, with
  // `misfired + human_bad (5) > helpful + human_good (1)`.
  //
  // Fires bump both `uses_30d` and `fires_30d` (packages/feedback/src/index.ts:
  // "a fire is how a hook gets used, so it counts in both columns"), written
  // with the exact shape `dispatch()`'s real fire log line carries
  // (packages/nudges/src/dispatch-core.ts's `fire()` contract: ts, pattern,
  // session_id, event).
  const fireDays = ["2026-09-13", "2026-09-15", "2026-09-17", "2026-09-19", "2026-09-21", "2026-09-23", "2026-09-25", "2026-09-27", "2026-09-29"];
  fireDays.forEach((day, i) => {
    fsx.appendJsonl(paths.nudgeFiresFile(), {
      ts: at(day, "08:30:00"),
      pattern: MISFIRE_PATTERN,
      session_id: `demo-fire-rfs-${i}`,
      event: "PreToolUse",
    });
  });
  for (const [i, day] of ["2026-09-13", "2026-09-14", "2026-09-15"].entries()) {
    fsx.appendJsonl(paths.criticFeedbackFile(), {
      ref: MISFIRE_REF,
      verdict: "misfired",
      reason: "It fired on a one-line README fix and the session had nothing left to test.",
      reflection_id: `demo-critic-rfs-${i}`,
      ts: at(day, "11:00:00"),
      world: world.name,
    });
  }
  fsx.appendJsonl(paths.criticFeedbackFile(), {
    ref: MISFIRE_REF,
    verdict: "helpful",
    reason: "It caught a real break before the session called the change safe.",
    reflection_id: "demo-critic-rfs-helpful-0",
    ts: at("2026-09-18", "11:00:00"),
    world: world.name,
  });
  for (const [i, day] of ["2026-09-14", "2026-09-16"].entries()) {
    feedback.recordHuman(
      HumanFeedback.parse({
        ts: at(day, "12:00:00"),
        world: world.name,
        ref: MISFIRE_REF,
        vote: "bad",
        note: i === 0 ? "Fired on a doc-only commit, nothing to run." : "Slowed the session down for no reason.",
      }),
    );
  }

  // Plain sessions that reflected nothing noteworthy, so the rate windows read
  // a real denominator instead of "every reflected session hit this pattern".
  // About 3 a day across the whole design window, so observe_min_sessions (set
  // low in the demo config) is comfortably cleared in every window.
  let plainIndex = 0;
  for (let d = 1; d <= 30; d++) {
    const day = `2026-09-${String(d).padStart(2, "0")}`;
    for (let n = 0; n < 3; n++) {
      feedback.recordReflectRun(
        ReflectRunEvent.parse({
          ts: at(day, `0${7 + n}:00:00`),
          world: world.name,
          session_id: `demo-session-plain-${plainIndex++}`,
          recorded: false,
          pattern: null,
        }),
      );
    }
  }
}

// --- the home ----------------------------------------------------------------

/** Builds the demo home under `root` (must be empty or absent). Never calls a
 * model. Points `process.env` at `root` first, since `@sil/*` path helpers
 * read it on every call. */
export async function seedDemoHome(root: string, repoRoot: string): Promise<{ staged: string[]; promoted: string[] }> {
  if (existsSync(root)) {
    if (readdirSync(root).length > 0) throw new Error(`seedDemoHome: ${root} already exists and is not empty`);
  } else {
    mkdirSync(root, { recursive: true });
  }

  const env = demoEnv(root, repoRoot);
  applyEnv(env);

  for (const dir of [env["HOME"]!, env["SIL_CONFIG_DIR"]!, env["SIL_STATE_DIR"]!, env["SIL_DATA_DIR"]!, env["CLAUDE_CONFIG_DIR"]!]) {
    mkdirSync(dir, { recursive: true });
  }

  // A fake, unreachable endpoint: present so `sil status` has something to
  // show, never resolved for a real call since every chat in this script is
  // injected directly into curriculum.run.
  saveLlm(
    LlmConfig.parse({
      endpoints: [
        Endpoint.parse({
          name: "demo",
          kind: "openai",
          base_url: "http://demo.invalid:4000",
          api_key_env: "SIL_DEMO_UNUSED_KEY",
          models: { critic: "fake/demo-model", drafter: "fake/demo-model", judge: "fake/demo-model" },
        }),
      ],
      active: "demo",
    }),
  );

  const world = World.parse({ name: DEMO_WORLD, remote: "none" });
  saveConfig(
    Config.parse({
      worlds: [world],
      worker: { auto_kick: false },
      promotion: {
        // Low enough that a rate window clears it inside the ~30 day design
        // range above; packages/core/src/schemas.ts defaults this to 20.
        observe_min_sessions: 8,
      },
    }),
  );
  const cfg = loadConfig();
  const demoWorld = worldNamed(cfg, DEMO_WORLD);

  curriculum.git.ensureRepo(targetRoot(demoWorld));
  fsx.ensureDir(paths.reflectionsDir(demoWorld.name));
  fsx.ensureDir(paths.inboxDir(demoWorld.name));
  for (const bucket of ["pending", "done", "failed"] as const) fsx.ensureDir(paths.queueDir(bucket));
  for (const sub of ["logs", "sessions", "usage", "feedback"]) fsx.ensureDir(join(paths.stateDir(), sub));
  writeHookSnapshot(cfg);

  const staged: string[] = [];
  const promoted: string[] = [];

  // 1. read-before-edit: three reflections (09-01..09-05), staged and
  // accepted as a skill backdated to 09-06.
  writeSpecs(demoWorld, readBeforeEditReflections());
  const readSkill = skillArtifact(
    PROMOTED_SKILL_PATTERN,
    "Use when you are about to edit a function and have not yet read every caller.",
    "Read before you edit",
    READ_LESSON,
  );
  await promote(demoWorld, cfg, PROMOTED_SKILL_PATTERN, skillDraft(readSkill, READ_LESSON), onDay("2026-09-06"), "skill");
  promoted.push(PROMOTED_SKILL_PATTERN);

  // 2. worktree-before-edit: three reflections (09-04..09-08), staged and
  // accepted as a rule backdated to 09-09.
  writeSpecs(demoWorld, worktreeBeforeEditReflections());
  await promote(demoWorld, cfg, PROMOTED_RULE_PATTERN, ruleDraft(`- ${WORKTREE_BULLET_TEXT}`), onDay("2026-09-09"), "rule");
  promoted.push(PROMOTED_RULE_PATTERN);

  // 3. run-full-suite: three reflections (09-07..09-11), staged and accepted
  // as a hook backdated to 09-12. Promoted and then left to misfire: see
  // seedScorecardSignal for the critic/human signal that makes its scorecard
  // propose retire-candidate.
  writeSpecs(demoWorld, runFullSuiteReflections());
  await promote(demoWorld, cfg, MISFIRE_PATTERN, hookDraft(MISFIRE_PATTERN), onDay("2026-09-12"), "hook");
  promoted.push(MISFIRE_PATTERN);

  // 4. verify-callsites: four reflections, staged and left unmerged on its
  // own curriculum/default/verify-callsites branch, for the Review pane. Real
  // "now", not backdated: this one is still awaiting review.
  writeSpecs(demoWorld, verifyCallsitesReflections());
  const verifySkill = skillArtifact(
    STAGED_PATTERN,
    "Use when a change touches a shared symbol and you are about to call it safe.",
    "Enumerate every call site",
    VERIFY_LESSON,
  );
  await stageOnly(demoWorld, cfg, STAGED_PATTERN, skillDraft(verifySkill, VERIFY_LESSON));
  staged.push(STAGED_PATTERN);

  // 5. two patterns below the promotion threshold: clustering in progress.
  writeSpecs(demoWorld, belowThresholdReflections());

  seedScorecardSignal(demoWorld);

  return { staged, promoted };
}

// --- CLI ---------------------------------------------------------------------

if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: bun scripts/demo/seed.ts <root>");
    process.exit(2);
  }
  const root = resolve(arg);
  const repoRoot = resolve(import.meta.dir, "..", "..");
  const result = await seedDemoHome(root, repoRoot);
  console.log(JSON.stringify({ root, ...result }, null, 2));
}
