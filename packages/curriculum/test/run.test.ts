// The curriculum run: gates, staging, and what it is not allowed to touch.
// Covers INVARIANTS 1 (never pushes), 3 (a served pattern is only re-routed to
// a different real type on new promote evidence, and never over a human's own
// choice), 7 (rule writability), 9 (one commit) and 13 (per-pattern provider
// isolation).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fsx,
  type Ledger,
  ledgerPath,
  LlmConfig,
  paths,
  type PlanAction,
  type PromotionEntry,
  RULE_END,
  RULE_START,
  ruleTag,
  saveLlm,
  Scorecard,
  targetRoot,
  type World,
} from "@sil/core";
import type { ChatFn, DecideFn } from "@sil/providers";
import {
  artifacts,
  branchName,
  draftMessages,
  git,
  lintRule,
  MAX_RULE_CHARS,
  MIN_QUOTE_CHARS,
  MIN_QUOTE_WORDS,
  ruleBudget,
  run,
  type RunOptions,
} from "@sil/curriculum";
import { parseLedger, readProposalEvents, recordProposalEvent, saveLedger } from "@sil/store";
import {
  addReflections,
  agentBody,
  cleanupEnv,
  commitFile,
  FakeChat,
  fakeGateRunner,
  hookBody,
  hookDraft,
  initTarget,
  installFakeNudge,
  makeCfg,
  makeWorld,
  ruleBody,
  ruleDraft,
  silEnv,
  skillBody,
  skillDraft,
  type TestEnv,
  uninstallFakeNudge,
} from "./fixtures.ts";

const PATTERN = "verify-callsites";
const QUOTE = "run `rg` over every call site of the changed symbol and read the graphify inventory";

/** A scorecard past observe_min_sessions for `pattern`, so a redraft of an
 * already-promoted row is not read as "too few sessions on the live text
 * yet" (`observing`) by a test that is not about the new redraft policy. */
function observedCard(pattern: string, type = "rule"): Scorecard {
  return Scorecard.parse({
    ref: `${type}:${pattern}`,
    type,
    name: pattern,
    rate_since_revision: { sessions: 999, hits: 0, rate: 0 },
    rate_since_promotion: { sessions: 999, hits: 0, rate: 0 },
  });
}

/** The pattern a prompt is about, from its own task line.
 *
 * Substring matching on the bare slug stopped working when the prompt gained
 * the world's knowledge map: every drafting prompt now names the other
 * patterns too, so only the quoted task line identifies the subject. */
function subjectOf(prompt: string): string {
  return /recurring lesson '([a-z0-9-]+)'/.exec(prompt)?.[1] ?? "";
}

let env: TestEnv;

beforeEach(() => {
  env = silEnv();
  installFakeNudge();
});
afterEach(() => {
  uninstallFakeNudge();
  cleanupEnv(env);
});

/** Always inject the in-process gate runner: the router's own integration with
 * the real out-of-process one is proved in router.test.ts. */
function opts(extra: Partial<RunOptions> & { apply: boolean }): RunOptions {
  return { gateRunner: fakeGateRunner, ...extra };
}

function worldWith(pattern = PATTERN, count = 3, overrides: Partial<World> = {}): World {
  const world = makeWorld(overrides);
  addReflections(world, pattern, count);
  return world;
}

function writeLedger(world: World, entries: PromotionEntry[]): string {
  const ledger: Ledger = { version: 1, entries: Object.fromEntries(entries.map((e) => [e.pattern, e])) };
  const path = ledgerPath(world);
  mkdirSync(join(path, ".."), { recursive: true });
  saveLedger(path, ledger);
  return path;
}

function entry(fields: Partial<PromotionEntry> & { pattern: string }): PromotionEntry {
  return {
    promoted_at_count: 0,
    rejected_at_count: 0,
    status: "staged",
    artifact_type: "none",
    served_by: null,
    last_updated: "2026-09-01T00:00:00Z",
    promoted_at: null,
    revised_at: null,
    revisions: 0,
    commit: null,
    feedback: null,
    ...fields,
  };
}

/** Points the judge role at a `system-one` endpoint, so
 * `providers.systemOneEndpoint("judge", world)` returns it and `run()` takes
 * the typed-decision path instead of the chat judge. */
function useTypedJudge(threshold = 0.5): void {
  saveLlm(LlmConfig.parse({ endpoints: [{ name: "s1", kind: "system-one", decision_threshold: threshold }], active: "s1" }));
}

const ruleDraftFor = (artifact: string) => ({
  trigger_event: "none",
  gate: null,
  needs_own_context: false,
  context_evidence: null,
  capability_evidence: null,
  no_artifact: false,
  artifact,
});

describe("dry run", () => {
  test("a dry run mutates nothing and calls no provider", async () => {
    const world = worldWith();
    addReflections(world, "thin-pattern", 1, { startDay: 20 });
    const chat = new FakeChat({ draft: skillDraft(PATTERN, QUOTE) });

    const report = await run(world, makeCfg(), opts({ apply: false, chat: chat.fn }));

    expect(report.dry_run).toBe(true);
    expect(report.staged).toEqual([PATTERN]);
    expect(report.dropped).toEqual({ "thin-pattern": 1 });
    expect(chat.calls).toEqual([]);
    // Not even the built-in target repo is created.
    expect(existsSync(targetRoot(world))).toBe(false);
  });
});

describe("the happy path", () => {
  test("apply stages one commit carrying the artifact and only its own ledger row", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    const chat = new FakeChat({ draft: skillDraft(PATTERN, QUOTE) });

    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn }));

    expect(report.staged).toEqual([PATTERN]);
    expect(report.merged).toEqual([]);
    const branch = branchName(world.name, PATTERN);
    const commits = git.git(repo, ["log", "--format=%H", `main..${branch}`]).split("\n").filter(Boolean);
    expect(commits.length).toBe(1);
    expect(git.commitPaths(repo, "main", branch)).toEqual(["promotions.json", `skills/${PATTERN}/SKILL.md`]);

    const { found, text } = git.show(repo, branch, "promotions.json");
    expect(found).toBe(true);
    const ledger = parseLedger(text);
    expect(Object.keys(ledger.entries)).toEqual([PATTERN]);
    const row = ledger.entries[PATTERN]!;
    expect(row.status).toBe("staged");
    expect(row.promoted_at_count).toBe(3);
    expect(row.artifact_type).toBe("skill");
    expect(row.served_by!.path).toBe(`skills/${PATTERN}/SKILL.md`);

    const events = readProposalEvents().events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ world: world.name, pattern: PATTERN, event: "staged" });
  });

  test("each staged branch carries only its own ledger row", async () => {
    // Branches are reviewed independently, so one may never claim another's
    // promotion. Accepting the second would otherwise record the first as
    // promoted without anyone approving it, and the loop then reads that
    // watermark and never proposes it again.
    const world = makeWorld();
    addReflections(world, "aaa-pattern", 3);
    addReflections(world, "bbb-pattern", 3, { startDay: 20 });
    const repo = initTarget(world);

    const chat: ChatFn = async (role, messages) => {
      if (role === "judge") return JSON.stringify({ verdict: "yes", reason: "quoted" });
      const prompt = messages[messages.length - 1]!.content;
      return JSON.stringify(skillDraft(subjectOf(prompt), QUOTE));
    };

    const report = await run(world, makeCfg(), opts({ apply: true, chat }));
    expect([...report.staged].sort()).toEqual(["aaa-pattern", "bbb-pattern"]);

    for (const pattern of ["aaa-pattern", "bbb-pattern"]) {
      const { found, text } = git.show(repo, branchName(world.name, pattern), "promotions.json");
      expect(found).toBe(true);
      expect(Object.keys(parseLedger(text).entries)).toEqual([pattern]);
    }
  });

  test("staging never moves the live head or dirties the tree", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    const beforeHead = git.head(repo);
    const beforeBranch = git.currentBranch(repo);

    const report = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: skillDraft(PATTERN, QUOTE) }).fn }));

    expect(report.staged).toEqual([PATTERN]);
    expect(git.head(repo)).toBe(beforeHead);
    expect(git.currentBranch(repo)).toBe(beforeBranch);
    expect(git.git(repo, ["status", "--porcelain"])).toBe("");
    // The ledger exists only on the branch, never as untracked residue on main:
    // a later run reading that residue would skip the pattern forever.
    expect(existsSync(join(repo, "promotions.json"))).toBe(false);
    expect(existsSync(join(repo, "skills", PATTERN))).toBe(false);
  });

  test("a routed hook is written as JSON at the nudges path", async () => {
    const world = worldWith();
    const repo = initTarget(world);

    const report = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: hookDraft(PATTERN) }).fn }));

    expect(report.staged).toEqual([PATTERN]);
    const { found, text } = git.show(repo, branchName(world.name, PATTERN), `nudges/${PATTERN}.json`);
    expect(found).toBe(true);
    expect(JSON.parse(text)["gate"]).toEqual({ command_matches: "git (commit|push)" });
  });

  test("a rule is written into the managed block of a created rules file", async () => {
    const world = worldWith();
    const repo = initTarget(world);

    const report = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: ruleDraftFor(ruleBody()) }).fn }));

    expect(report.staged).toEqual([PATTERN]);
    const { found, text } = git.show(repo, branchName(world.name, PATTERN), "RULES.md");
    expect(found).toBe(true);
    expect(text).toContain(ruleTag(PATTERN));
    // The live tree is untouched: the rules file was created inside the worktree.
    expect(existsSync(join(repo, "RULES.md"))).toBe(false);
  });

  test("promotion.max_rule_chars reaches the drafter and the lint alike", async () => {
    const world = worldWith();
    initTarget(world);
    const bullet =
      ruleBody().slice(0, -1) +
      ", then re-run `rg` after every later edit, count the hits again, compare that count with the graphify " +
      "inventory, and name the call sites that changed in the commit message before calling the change safe.";
    const total = bullet.length + 1 + ruleTag(PATTERN).length;
    const stated = (cap: number) => `at most ${cap - 1 - ruleTag(PATTERN).length} characters`;

    const tight = new FakeChat({ draft: ruleDraftFor(bullet) });
    const refused = await run(world, makeCfg({ max_rule_chars: 150 }), opts({ apply: true, chat: tight.fn }));
    expect(refused.staged).toEqual([]);
    expect(refused.gated_out[PATTERN]).toContain(`rule is ${total} chars`);
    expect(refused.gated_out[PATTERN]).toContain("the cap is 150");
    expect(tight.promptsFor("drafter")[0]).toContain(stated(150));

    const roomy = new FakeChat({ draft: ruleDraftFor(bullet) });
    const staged = await run(world, makeCfg({ max_rule_chars: 400 }), opts({ apply: true, chat: roomy.fn }));
    expect(staged.staged).toEqual([PATTERN]);
    expect(roomy.promptsFor("drafter")[0]).toContain(stated(400));
  });

  test("an agent draft is written at the agents path", async () => {
    // The fourth type. Skill, hook and rule each had a staging test; agent had
    // none, and the loop had never staged one since the V2 port.
    const world = worldWith();
    const repo = initTarget(world);
    const draft = {
      trigger_event: "none",
      gate: null,
      needs_own_context: true,
      context_evidence: QUOTE,
      capability_evidence: null,
      no_artifact: false,
      artifact: agentBody(PATTERN, QUOTE),
    };

    const report = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft }).fn }));

    expect(report.staged).toEqual([PATTERN]);
    expect(report.routed[PATTERN]).toMatchObject({ drafted: "agent", type: "agent" });
    const branch = branchName(world.name, PATTERN);
    expect(git.commitPaths(repo, "main", branch)).toEqual([`agents/${PATTERN}.md`, "promotions.json"]);
    const { text } = git.show(repo, branch, "promotions.json");
    expect(parseLedger(text).entries[PATTERN]!.artifact_type).toBe("agent");
  });

  test("the report records the route of every pattern that reached the router", async () => {
    // Staged or gated, the operator sees what the drafter proposed and what
    // the router settled on. Before this field every promotion that came out
    // as a rule looked the same in the log, whether or not a hook was asked for.
    const world = worldWith();
    initTarget(world);

    const report = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: skillDraft(PATTERN, QUOTE) }).fn }));

    expect(report.routed[PATTERN]).toEqual({
      drafted: "skill",
      type: "skill",
      reason: "capability evidence quoted verbatim from a source",
    });
  });

  test("a second run on the same evidence replaces the branch, not the history", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    const chat = new FakeChat({ draft: skillDraft(PATTERN, QUOTE) });
    await run(world, makeCfg(), opts({ apply: true, chat: chat.fn }));
    const first = git.git(repo, ["rev-parse", branchName(world.name, PATTERN)]);

    addReflections(world, PATTERN, 3, { startDay: 20 });
    await run(world, makeCfg(), opts({ apply: true, chat: chat.fn }));
    const second = git.git(repo, ["rev-parse", branchName(world.name, PATTERN)]);

    expect(second).not.toBe(first);
    const commits = git.git(repo, ["log", "--format=%H", `main..${branchName(world.name, PATTERN)}`]).split("\n").filter(Boolean);
    expect(commits.length).toBe(1);
  });
});

describe("gates", () => {
  test("a rule bullet carrying a block marker never reaches a branch", async () => {
    // The bullet is written into the shared managed block verbatim. One carrying
    // the block's own markers duplicates the pair, and from then on every rule
    // write is refused as ambiguous and retire throws: the file is wedged with
    // no way back through the loop. Gated at the lint, before any worktree.
    const world = worldWith();
    const repo = initTarget(world);
    const draft = ruleDraftFor(`${ruleBody().trimEnd()} ${RULE_END}`);

    const report = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft }).fn }));

    expect(report.staged).toEqual([]);
    expect(report.gated_out[PATTERN]).toContain("managed-block marker");
    expect(git.refExists(repo, `refs/heads/${branchName(world.name, PATTERN)}`)).toBe(false);
    expect(existsSync(join(repo, "RULES.md"))).toBe(false);
    expect(readProposalEvents().events).toEqual([]);
  });

  test("a refined rule that carries its own tag is normalised, not gated", async () => {
    // The refine path shows the drafter the bullet it is replacing. That bullet
    // lives in the managed block with a `<!--rule:pattern-->` tag, the drafter
    // copies the tag, and the lint refuses a tagged bullet: the pattern is stuck
    // on every run with no way out but a hand edit. The tag is the writer's, so
    // reading drops it and a draft that still carries one is normalised.
    const world = worldWith();
    const repo = initTarget(world);
    const old = `- old wording ${ruleTag(PATTERN)}`;
    commitFile(repo, "RULES.md", `# Rules\n\n${RULE_START}\n${old}\n${RULE_END}\n`, "chore: rules");
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        status: "promoted",
        artifact_type: "rule",
        served_by: { type: "rule", path: "RULES.md" },
      }),
    ]);
    commitFile(repo, "promotions.json", readFileSync(ledgerPath(world), "utf8"), "chore: ledger");
    const chat = new FakeChat({ draft: { artifact: `${ruleBody()} ${ruleTag(PATTERN)}` } });

    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [observedCard(PATTERN)] }));

    expect(report.gated_out).toEqual({});
    expect(report.staged).toEqual([PATTERN]);
    // The drafter never saw a tag, so it had none to copy.
    expect(chat.promptsFor("drafter")[0]).toContain("- old wording");
    expect(chat.promptsFor("drafter")[0]).not.toContain(ruleTag(PATTERN));
    const { found, text } = git.show(repo, branchName(world.name, PATTERN), "RULES.md");
    expect(found).toBe(true);
    expect(text.split(ruleTag(PATTERN)).length - 1).toBe(1);
    expect(text).toContain(ruleBody());
  });

  test("a custom target without a marker pair refuses the rule write", async () => {
    const target = join(env.tmp, "someone-elses-repo");
    const world = makeWorld({ target });
    addReflections(world, PATTERN, 3);
    initTarget(world);

    const report = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: ruleDraftFor(ruleBody()) }).fn }));

    expect(report.staged).toEqual([]);
    expect(report.gated_out[PATTERN]).toContain("rule target not writable");
  });

  test("a failing judge gates only that pattern", async () => {
    const world = makeWorld();
    addReflections(world, "aaa-pattern", 3);
    addReflections(world, "bbb-pattern", 3, { startDay: 20 });
    const repo = initTarget(world);

    const chat: ChatFn = async (role, messages) => {
      const prompt = messages[messages.length - 1]!.content;
      if (role === "judge") {
        const bad = subjectOf(prompt) === "aaa-pattern";
        return JSON.stringify({ verdict: bad ? "no" : "yes", reason: bad ? "rule 2: vague" : "quoted" });
      }
      return JSON.stringify(skillDraft(subjectOf(prompt), QUOTE));
    };

    const report = await run(world, makeCfg(), opts({ apply: true, chat }));

    expect(report.staged).toEqual(["bbb-pattern"]);
    expect(report.gated_out["aaa-pattern"]).toContain("judge:");
    expect(git.refExists(repo, `refs/heads/${branchName(world.name, "aaa-pattern")}`)).toBe(false);
    expect(git.refExists(repo, `refs/heads/${branchName(world.name, "bbb-pattern")}`)).toBe(true);
  });

  test("a provider failure gates one pattern and the run continues", async () => {
    const world = makeWorld();
    addReflections(world, "aaa-pattern", 3);
    addReflections(world, "bbb-pattern", 3, { startDay: 20 });
    initTarget(world);

    const chat: ChatFn = async (role, messages) => {
      const prompt = messages[messages.length - 1]!.content;
      if (subjectOf(prompt) === "aaa-pattern") throw new Error("the endpoint never answered");
      if (role === "judge") return JSON.stringify({ verdict: "yes", reason: "quoted" });
      return JSON.stringify(skillDraft("bbb-pattern", QUOTE));
    };

    const report = await run(world, makeCfg(), opts({ apply: true, chat }));

    expect(report.staged).toEqual(["bbb-pattern"]);
    expect(report.gated_out["aaa-pattern"]!.startsWith("draft failed:")).toBe(true);
  });

  test("a failing lint gates the pattern and names the route", async () => {
    const world = worldWith();
    initTarget(world);
    const vacuous = {
      trigger_event: "none",
      gate: null,
      needs_own_context: false,
      context_evidence: null,
      capability_evidence: QUOTE,
      no_artifact: false,
      artifact: `---\nname: ${PATTERN}\ndescription: Use when careless.\n---\n\n## Be careful\n\n${"Always be careful. ".repeat(10)}`,
    };

    const report = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: vacuous }).fn }));

    expect(report.staged).toEqual([]);
    expect(report.gated_out[PATTERN]!.startsWith("artifact-lint:")).toBe(true);
    expect(report.gated_out[PATTERN]).toContain("router:");
  });

  test("an unreadable drafter reply is reported as a transport problem", async () => {
    const world = worldWith();
    initTarget(world);
    const chat: ChatFn = async () => "I'm sorry, I can't help with that.";
    const report = await run(world, makeCfg(), opts({ apply: true, chat }));
    expect(report.gated_out[PATTERN]).toContain("unreadable drafter reply");
  });

  test("a dirty artifact directory blocks the run", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    commitFile(repo, "skills/other/SKILL.md", "hand written\n");
    writeFileSync(join(repo, "skills", "other", "SKILL.md"), "edited, uncommitted\n", "utf8");

    const report = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: skillDraft(PATTERN, QUOTE) }).fn }));

    expect(report.staged).toEqual([]);
    expect(report.gated_out[PATTERN]).toContain("repo integrity");
  });

  test("an unrelated dirty file does not block the run", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    commitFile(repo, "README.md", "hello\n");
    writeFileSync(join(repo, "README.md"), "edited, uncommitted\n", "utf8");

    const report = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: skillDraft(PATTERN, QUOTE) }).fn }));

    expect(report.staged).toEqual([PATTERN]);
    // And the unrelated edit survives.
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("edited, uncommitted\n");
  });

  test("over-cap patterns are reported, not silently dropped", async () => {
    const world = makeWorld();
    addReflections(world, "aaa-pattern", 3);
    addReflections(world, "bbb-pattern", 3, { startDay: 20 });
    initTarget(world);

    const chat: ChatFn = async (role) =>
      role === "judge"
        ? JSON.stringify({ verdict: "yes", reason: "quoted" })
        : JSON.stringify(skillDraft("aaa-pattern", QUOTE));

    const report = await run(world, makeCfg({ per_run_cap: 1 }), opts({ apply: true, chat }));
    expect(report.staged).toEqual(["aaa-pattern"]);
    expect(report.gated_out["bbb-pattern"]).toContain("cap");
  });

  test("a gated-out pattern frees its cap slot for the next candidate", async () => {
    // The starvation bug: the cap was spent while planning, so a pattern that
    // fails a gate still burned a budget slot and a viable later pattern was
    // stranded at over-cap, staging nothing. Here the alphabetically-first
    // pattern fails the judge; with a cap of one the second must still get its
    // turn and stage.
    const world = makeWorld();
    addReflections(world, "aaa-pattern", 3);
    addReflections(world, "bbb-pattern", 3, { startDay: 20 });
    initTarget(world);

    const chat: ChatFn = async (role, messages) => {
      const isAaa = subjectOf(messages[messages.length - 1]!.content) === "aaa-pattern";
      if (role === "judge") {
        return JSON.stringify({ verdict: isAaa ? "no" : "yes", reason: isAaa ? "rule 2: vague" : "quoted" });
      }
      return JSON.stringify(skillDraft(isAaa ? "aaa-pattern" : "bbb-pattern", QUOTE));
    };

    const report = await run(world, makeCfg({ per_run_cap: 1 }), opts({ apply: true, chat }));

    expect(report.staged).toEqual(["bbb-pattern"]);
    expect(report.gated_out["aaa-pattern"]).toContain("judge:");
    expect(report.gated_out["bbb-pattern"]).toBeUndefined();
  });

  test("a declined pattern stages nothing", async () => {
    const world = worldWith();
    initTarget(world);
    const declined = {
      trigger_event: "none",
      gate: null,
      needs_own_context: false,
      context_evidence: null,
      capability_evidence: null,
      no_artifact: true,
      artifact: "",
    };
    const report = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: declined }).fn }));
    expect(report.staged).toEqual([]);
    expect(report.gated_out[PATTERN]).toContain("drafter declined");
    // A decline is on the route record too, not only a staged outcome.
    expect(report.routed[PATTERN]).toMatchObject({ drafted: "rule", type: "none" });
    expect(report.routed[PATTERN]!.reason).toContain("declined");
  });
});

describe("typed judge (System One)", () => {
  test("a typed judge answering low probabilities stages the artifact and never calls chat for the judge role", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    useTypedJudge();
    const chat = new FakeChat({ draft: skillDraft(PATTERN, QUOTE) });
    const decideRoles: string[] = [];
    const decide: DecideFn = async (role, _state, questions) => {
      decideRoles.push(role);
      return Object.fromEntries(Object.keys(questions).map((id) => [id, 0.05]));
    };

    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, decide }));

    expect(report.staged).toEqual([PATTERN]);
    expect(chat.roles).toEqual(["drafter"]);
    expect(decideRoles).toEqual(["judge"]);
    expect(git.refExists(repo, `refs/heads/${branchName(world.name, PATTERN)}`)).toBe(true);
  });

  test("a typed judge answering a high probability gates the pattern out with the rule name", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    useTypedJudge();
    const chat = new FakeChat({ draft: skillDraft(PATTERN, QUOTE) });
    const decide: DecideFn = async (_role, _state, questions) => {
      const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, 0.05]));
      answers["unsafe"] = 0.9;
      return answers;
    };

    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, decide }));

    expect(report.staged).toEqual([]);
    expect(report.gated_out[PATTERN]).toContain("judge:");
    expect(report.gated_out[PATTERN]).toContain("unsafe");
    expect(chat.roles).toEqual(["drafter"]);
    expect(git.refExists(repo, `refs/heads/${branchName(world.name, PATTERN)}`)).toBe(false);
  });

  test("a decide that throws gates out with 'judge failed' and stages nothing", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    useTypedJudge();
    const chat = new FakeChat({ draft: skillDraft(PATTERN, QUOTE) });
    const decide: DecideFn = async () => {
      throw new Error("the endpoint never answered");
    };

    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, decide }));

    expect(report.staged).toEqual([]);
    expect(report.gated_out[PATTERN]).toContain("judge failed");
    expect(git.refExists(repo, `refs/heads/${branchName(world.name, PATTERN)}`)).toBe(false);
    expect(existsSync(join(repo, "skills", PATTERN))).toBe(false);
  });
});

describe("auto merge", () => {
  test("a cloud world can opt into auto merge", async () => {
    const world = worldWith(PATTERN, 3, { llm: "cloud" });
    const repo = initTarget(world);
    const before = git.head(repo);

    const report = await run(
      world,
      makeCfg({ auto_merge: true }),
      opts({ apply: true, chat: new FakeChat({ draft: skillDraft(PATTERN, QUOTE) }).fn }),
    );

    expect(report.merged).toEqual([PATTERN]);
    expect(git.head(repo)).not.toBe(before);
    expect(existsSync(join(repo, "skills", PATTERN, "SKILL.md"))).toBe(true);
    expect(parseLedger(git.show(repo, "main", "promotions.json").text).entries[PATTERN]!.status).toBe("promoted");
  });

  test("a local world never auto merges even when config asks", async () => {
    // The on-machine judge accepted 3 of 4 adversarial-but-lint-clean drafts,
    // including one that fabricated its supporting source quote.
    const world = worldWith(PATTERN, 3, { llm: "local" });
    const repo = initTarget(world);
    const before = git.head(repo);

    const report = await run(
      world,
      makeCfg({ auto_merge: true }),
      opts({ apply: true, chat: new FakeChat({ draft: skillDraft(PATTERN, QUOTE) }).fn }),
    );

    expect(report.merged).toEqual([]);
    expect(report.staged).toEqual([PATTERN]);
    expect(git.head(repo)).toBe(before);
    const { text } = git.show(repo, branchName(world.name, PATTERN), "promotions.json");
    expect(parseLedger(text).entries[PATTERN]!.status).toBe("staged");
  });

  test("no run reaches a real remote, whatever the world's remote setting says", async () => {
    // INVARIANT 1. `run()` stages; only accept may publish, and only on request.
    // A real bare remote is wired up, so a stray push would land somewhere this
    // test can see rather than merely failing.
    const world = worldWith(PATTERN, 3, { remote: "pr" });
    const repo = initTarget(world);
    const bare = join(env.tmp, "origin.git");
    git.git(env.tmp, ["init", "-q", "--bare", "-b", "main", bare]);
    git.git(repo, ["remote", "add", "origin", bare]);

    const report = await run(
      world,
      makeCfg({ auto_merge: true }),
      opts({ apply: true, chat: new FakeChat({ draft: skillDraft(PATTERN, QUOTE) }).fn }),
    );

    expect(report.merged).toEqual([PATTERN]);
    // Nothing at all reached the remote: no branches, no tags, no objects.
    expect(git.git(bare, ["for-each-ref", "--format=%(refname)"])).toBe("");
  });
});

describe("served_by suppression", () => {
  test("an already served pattern with no upgrade signal is not re-routed", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        status: "promoted",
        artifact_type: "rule",
        served_by: { type: "rule", path: "RULES.md" },
      }),
    ]);
    commitFile(repo, "promotions.json", readFileSync(ledgerPath(world), "utf8"), "chore: ledger");

    // The forced draft carries no trigger_event or gate, so the re-route probe
    // (see "re-routing an already served pattern" below) falls through to
    // "rule" without ever reaching the gate runner: hookVerdict refuses "no
    // trigger event proposed" before it is called. A throwing runner here
    // proves that, and the drafter prompt below proves the forced path, not
    // the free-routing one, was taken.
    const chat = new FakeChat({ draft: { artifact: ruleBody() } });
    const report = await run(
      world,
      makeCfg(),
      opts({
        apply: true,
        chat: chat.fn,
        gateRunner: () => {
          throw new Error("route() was consulted for an already-served pattern");
        },
        cards: [observedCard(PATTERN)],
      }),
    );

    expect(report.staged).toEqual([PATTERN]);
    expect(chat.roles).toEqual(["drafter", "judge"]);
    expect(chat.promptsFor("drafter")[0]).toContain("Its type is already decided");
    expect(report.routed[PATTERN]).toEqual({ drafted: "rule", type: "rule", reason: "already served by this artifact" });
    const { found, text } = git.show(repo, branchName(world.name, PATTERN), "RULES.md");
    expect(found).toBe(true);
    expect(text).toContain(ruleTag(PATTERN));
  });

  test("a placeholder is never offered to the drafter as an existing draft", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    const stub = artifacts.placeholderBody(PATTERN, "skill", "rule") as string;
    commitFile(repo, `skills/${PATTERN}/SKILL.md`, stub, "chore: stub");
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        status: "staged",
        artifact_type: "skill",
        served_by: { type: "skill", path: `skills/${PATTERN}/SKILL.md` },
      }),
    ]);
    commitFile(repo, "promotions.json", readFileSync(ledgerPath(world), "utf8"), "chore: ledger");

    const chat = new FakeChat({ draft: { artifact: skillBody(PATTERN, QUOTE) } });
    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn }));

    expect(report.staged).toEqual([PATTERN]);
    const prompt = chat.promptsFor("drafter")[0]!;
    expect(prompt).toContain("Write a");
    expect(prompt).not.toContain("Refine the existing");
    expect(prompt).not.toContain("awaiting a real draft");
  });
});

describe("re-routing an already served pattern", () => {
  /** A pattern already promoted and served by a rule bullet, which this
   * describe block's tests redraft on new evidence. */
  function seedRuleServed(world: World, repo: string, overrides: Partial<PromotionEntry> = {}): void {
    // Deliberately not `ruleBody()`: the fake drafter's forced-mode reply
    // below returns that text, and an "existing" that already reads the same
    // would gate out as "no change" before the route probe matters.
    commitFile(
      repo,
      "RULES.md",
      `# Rules\n\n${RULE_START}\n- old wording for ${PATTERN}. ${ruleTag(PATTERN)}\n${RULE_END}\n`,
      "chore: rules",
    );
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        status: "promoted",
        artifact_type: "rule",
        served_by: { type: "rule", path: "RULES.md" },
        ...overrides,
      }),
    ]);
    commitFile(repo, "promotions.json", readFileSync(ledgerPath(world), "utf8"), "chore: ledger");
  }

  // A gate already proved narrow against the real payload corpus by "a routed
  // hook is written as JSON at the nudges path" above; reused here so a
  // genuine router call, not a fixture quirk, is what earns the upgrade.
  const HOOK_PROBE = { ...ruleDraft(), trigger_event: "PreToolUse:Bash", gate: { command_matches: "git (commit|push)" } };

  test("new evidence that earns a hook re-routes a promoted rule, removing the rule bullet", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    seedRuleServed(world, repo);

    // First call: forced "rule" body plus the routing fields the probe asks
    // for. Second call: the real redraft, in the shape the router earned.
    const chat = new FakeChat({ drafts: [HOOK_PROBE, hookDraft(PATTERN)] });
    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [observedCard(PATTERN)] }));

    expect(report.staged).toEqual([PATTERN]);
    expect(chat.roles).toEqual(["drafter", "drafter", "judge"]);
    expect(chat.promptsFor("drafter")[0]).toContain("Its type is already decided");
    expect(report.routed[PATTERN]).toMatchObject({ drafted: "rule", type: "hook" });
    expect(report.routed[PATTERN]!.reason).toContain("re-routed from rule to hook");

    const branch = branchName(world.name, PATTERN);
    const hook = git.show(repo, branch, `nudges/${PATTERN}.json`);
    expect(hook.found).toBe(true);
    const rules = git.show(repo, branch, "RULES.md");
    expect(rules.found).toBe(true);
    expect(rules.text).not.toContain(ruleTag(PATTERN));
    const row = parseLedger(git.show(repo, branch, "promotions.json").text).entries[PATTERN]!;
    expect(row.served_by).toEqual({ type: "hook", path: `nudges/${PATTERN}.json` });
    expect(row.artifact_type).toBe("hook");
    expect(git.git(repo, ["log", "-1", "--format=%s", branch])).toBe(
      `feat(hook): re-route ${PATTERN} from rule (auto, gated)`,
    );
    const events = readProposalEvents().events;
    expect(events.at(-1)).toMatchObject({ world: world.name, pattern: PATTERN, event: "rerouted" });
  });

  test("a re-route is always staged, never auto-merged, even with auto_merge true", async () => {
    // A re-route is a type change nobody has reviewed yet, so auto_merge must
    // never land it directly on the default branch the way it does an
    // ordinary redraft.
    const world = worldWith();
    const repo = initTarget(world);
    seedRuleServed(world, repo);

    const chat = new FakeChat({ drafts: [HOOK_PROBE, hookDraft(PATTERN)] });
    const report = await run(
      world,
      makeCfg({ auto_merge: true }),
      opts({ apply: true, chat: chat.fn, cards: [observedCard(PATTERN)] }),
    );

    expect(report.staged).toEqual([PATTERN]);
    expect(report.merged).toEqual([]);
    expect(report.routed[PATTERN]!.reason).toContain("re-routed from rule to hook");
    const branch = branchName(world.name, PATTERN);
    const row = parseLedger(git.show(repo, branch, "promotions.json").text).entries[PATTERN]!;
    expect(row.status).toBe("staged");
  });

  test("a re-route is never gated out as 'no change' merely because the redraft matches the old type's stored text", async () => {
    // `ruleBulletInText` only ever returns one line, so the old rule's stored
    // text is made to be, byte for byte, the exact JSON the hook redraft will
    // produce: the narrowest case where the "no change" skip could otherwise
    // mistake a type change for no change at all.
    const world = worldWith();
    const repo = initTarget(world);
    commitFile(
      repo,
      "RULES.md",
      `# Rules\n\n${RULE_START}\n${JSON.stringify(hookBody(PATTERN))} ${ruleTag(PATTERN)}\n${RULE_END}\n`,
      "chore: rules",
    );
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        status: "promoted",
        artifact_type: "rule",
        served_by: { type: "rule", path: "RULES.md" },
      }),
    ]);
    commitFile(repo, "promotions.json", readFileSync(ledgerPath(world), "utf8"), "chore: ledger");

    const chat = new FakeChat({ drafts: [HOOK_PROBE, hookDraft(PATTERN)] });
    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [observedCard(PATTERN)] }));

    expect(report.gated_out[PATTERN]).toBeUndefined();
    expect(report.staged).toEqual([PATTERN]);
    expect(report.routed[PATTERN]!.reason).toContain("re-routed from rule to hook");
  });

  test("a pattern already served by a non-rule type never asks the drafter for routing fields", async () => {
    // Only a `rule` is eligible for an automatic re-route; a hook, skill or
    // agent already serving a pattern is moved only by a human `rehome`, so
    // the forced redraft must never pay for the extra routing-field ask.
    const world = worldWith();
    const repo = initTarget(world);
    commitFile(repo, `skills/${PATTERN}/SKILL.md`, skillBody(PATTERN, QUOTE), "chore: skill");
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        status: "promoted",
        artifact_type: "skill",
        served_by: { type: "skill", path: `skills/${PATTERN}/SKILL.md` },
      }),
    ]);
    commitFile(repo, "promotions.json", readFileSync(ledgerPath(world), "utf8"), "chore: ledger");

    const chat = new FakeChat({ draft: { artifact: skillBody(PATTERN, `a new angle on ${QUOTE}`) } });
    const report = await run(
      world,
      makeCfg(),
      opts({
        apply: true,
        chat: chat.fn,
        gateRunner: () => {
          throw new Error("route() was consulted for a pattern already served by a non-rule type");
        },
        cards: [observedCard(PATTERN)],
      }),
    );

    expect(chat.roles).toEqual(["drafter", "judge"]);
    expect(chat.promptsFor("drafter")[0]).not.toContain("trigger_event");
    expect(report.staged).toEqual([PATTERN]);
    expect(report.routed[PATTERN]).toEqual({ drafted: "skill", type: "skill", reason: "already served by this artifact" });
  });

  test("type_set_by: human on the live row blocks re-routing even with no rehomed event recorded", async () => {
    // The durable fallback: a human's own choice must hold even when the
    // best-effort proposal-events log never recorded a `rehomed` event for
    // this pattern at all. Uses the same real, hook-earning gate as "new
    // evidence that earns a hook re-routes..." above, deliberately not a
    // throwing stub: a throw is swallowed into a route refusal by
    // `hookVerdict` either way, so it cannot tell "blocked" apart from
    // "probed, and the gate happened to fail". Only a gate that would
    // genuinely earn the upgrade, and a count of drafter calls, can.
    const world = worldWith();
    const repo = initTarget(world);
    seedRuleServed(world, repo, { type_set_by: "human" });

    const chat = new FakeChat({ drafts: [HOOK_PROBE, hookDraft(PATTERN)] });
    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [observedCard(PATTERN)] }));

    // One drafter call, not two: `wantRouteAnswer` was never even asked for,
    // so there is no redraft in a new type to make.
    expect(chat.roles).toEqual(["drafter", "judge"]);
    expect(report.staged).toEqual([PATTERN]);
    expect(report.routed[PATTERN]).toEqual({ drafted: "rule", type: "rule", reason: "already served by this artifact" });
    const rules = git.show(repo, branchName(world.name, PATTERN), "RULES.md");
    expect(rules.text).toContain(ruleTag(PATTERN));
  });

  test("a router result of rule leaves an already served type alone", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    seedRuleServed(world, repo);

    // A gate that fires on nothing in the corpus downgrades to "rule": real
    // signal, real router call, no upgrade earned, so no churn.
    const probe = { ...ruleDraft(), trigger_event: "PreToolUse:Bash", gate: { command_matches: "this-matches-nothing-xyz" } };
    const chat = new FakeChat({ draft: probe });
    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [observedCard(PATTERN)] }));

    expect(report.staged).toEqual([PATTERN]);
    expect(chat.roles).toEqual(["drafter", "judge"]);
    expect(report.routed[PATTERN]).toEqual({ drafted: "rule", type: "rule", reason: "already served by this artifact" });
    const rules = git.show(repo, branchName(world.name, PATTERN), "RULES.md");
    expect(rules.text).toContain(ruleTag(PATTERN));
  });

  test("a refine action never considers a re-route, even with hook-earning evidence", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    // promoted_at_count matches the reflection count, so there is no evidence
    // past the watermark: plan() reads this as a scorecard refine, not a promote.
    seedRuleServed(world, repo, { promoted_at_count: 3 });

    const card = Scorecard.parse({ ref: "rule:" + PATTERN, type: "rule", name: PATTERN, misfired: 3, human_bad: 1, helpful: 1, proposal: "refine", reason: "misfires" });
    const chat = new FakeChat({ draft: HOOK_PROBE });
    const report = await run(
      world,
      makeCfg(),
      opts({
        apply: true,
        chat: chat.fn,
        gateRunner: () => {
          throw new Error("route() was consulted on a refine");
        },
        cards: [card],
      }),
    );

    expect(report.staged).toEqual([PATTERN]);
    expect(report.routed[PATTERN]).toEqual({ drafted: "rule", type: "rule", reason: "already served by this artifact" });
    const rules = git.show(repo, branchName(world.name, PATTERN), "RULES.md");
    expect(rules.text).toContain(ruleTag(PATTERN));
  });

  test("a rehomed event ever recorded for this pattern blocks re-routing", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    seedRuleServed(world, repo);
    recordProposalEvent(world.name, PATTERN, "rehomed");

    const chat = new FakeChat({ draft: HOOK_PROBE });
    const report = await run(
      world,
      makeCfg(),
      opts({
        apply: true,
        chat: chat.fn,
        gateRunner: () => {
          throw new Error("route() was consulted over a human's own rehome");
        },
        cards: [observedCard(PATTERN)],
      }),
    );

    expect(report.staged).toEqual([PATTERN]);
    expect(report.routed[PATTERN]).toEqual({ drafted: "rule", type: "rule", reason: "already served by this artifact" });
    const rules = git.show(repo, branchName(world.name, PATTERN), "RULES.md");
    expect(rules.text).toContain(ruleTag(PATTERN));
  });

  test("an open same-type restaged branch does not block re-routing", async () => {
    // The worker restages this same branch on every tick with new evidence, so
    // an open branch here is the normal state, not an edge case: measured on
    // live state, every pattern with new evidence had one. Only a branch whose
    // own type already disagrees with the live one (a pending re-home or an
    // earlier pending re-route), or a recorded `rehomed` event, is a human
    // choice this feature must not second-guess.
    const world = worldWith();
    const repo = initTarget(world);
    const first = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: ruleDraft() }).fn }));
    expect(first.staged).toEqual([PATTERN]);

    addReflections(world, PATTERN, 3, { startDay: 20 });
    const chat = new FakeChat({ drafts: [HOOK_PROBE, hookDraft(PATTERN)] });
    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn }));

    expect(report.staged).toEqual([PATTERN]);
    expect(chat.roles).toEqual(["drafter", "drafter", "judge"]);
    expect(report.routed[PATTERN]).toMatchObject({ drafted: "rule", type: "hook" });
    expect(report.routed[PATTERN]!.reason).toContain("re-routed from rule to hook");
    const branch = branchName(world.name, PATTERN);
    const hook = git.show(repo, branch, `nudges/${PATTERN}.json`);
    expect(hook.found).toBe(true);
    const row = parseLedger(git.show(repo, branch, "promotions.json").text).entries[PATTERN]!;
    expect(row.served_by).toEqual({ type: "hook", path: `nudges/${PATTERN}.json` });
  });

  test("a pending re-route is not flipped back or re-routed again on the next tick", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    seedRuleServed(world, repo);

    // Tick 1: new evidence earns a hook. Staged, not accepted.
    const first = await run(
      world,
      makeCfg(),
      opts({ apply: true, chat: new FakeChat({ drafts: [HOOK_PROBE, hookDraft(PATTERN)] }).fn, cards: [observedCard(PATTERN)] }),
    );
    expect(first.routed[PATTERN]!.type).toBe("hook");

    // Tick 2: more evidence arrives before a human reviews tick 1's branch.
    // The live ledger still says "rule" (nothing accepted), the branch says
    // "hook": migrating() reads that disagreement as a re-route still
    // pending review, exactly like a pending human re-home, and route() must
    // not be consulted again.
    addReflections(world, PATTERN, 3, { startDay: 40 });
    const chat = new FakeChat({ draft: hookDraft(PATTERN) });
    const report = await run(
      world,
      makeCfg(),
      opts({
        apply: true,
        chat: chat.fn,
        gateRunner: () => {
          throw new Error("route() was consulted while an earlier re-route awaits review");
        },
        cards: [observedCard(PATTERN)],
      }),
    );

    expect(report.staged).toEqual([PATTERN]);
    expect(chat.roles).toEqual(["drafter", "judge"]);
    expect(report.routed[PATTERN]).toEqual({ drafted: "hook", type: "hook", reason: "already served by this artifact" });
    const branch = branchName(world.name, PATTERN);
    const hook = git.show(repo, branch, `nudges/${PATTERN}.json`);
    expect(hook.found).toBe(true);
    const rules = git.show(repo, branch, "RULES.md");
    // Still gone, not restored: the branch landed on top rather than
    // resetting, so tick 1's removal of the rule bullet was not reverted.
    expect(rules.text).not.toContain(ruleTag(PATTERN));
  });
});

describe("a scorecard refine with no reflections", () => {
  // V1 rows were migrated without reflections; for them the complaints are the
  // only evidence, so they are what the redraft is grounded in.
  const REASON = "misfired+human_bad=4 exceeds helpful+human_good=1";
  const COMPLAINT = "It let me call the change safe before I ran rg over the changed symbol and read the graphify inventory.";
  const card = (misfired = 3) =>
    Scorecard.parse({ ref: `rule:${PATTERN}`, type: "rule", name: PATTERN, misfired, human_bad: 1, helpful: 1, proposal: "refine", reason: REASON });

  function complain(world: World, reason: string): void {
    fsx.appendJsonl(paths.criticFeedbackFile(), { ref: `rule:${PATTERN}`, verdict: "misfired", reason, reflection_id: "r1", ts: "2026-09-20T00:00:00Z", world: world.name });
  }

  function seedLive(opts: { complaint?: string | null } = {}): { world: World; repo: string } {
    const world = makeWorld();
    const repo = initTarget(world);
    const old = `- Run \`rg\` over the changed symbol before calling the change safe; the graphify inventory misses consumers. ${ruleTag(PATTERN)}`;
    commitFile(repo, "RULES.md", `# Rules\n\n${RULE_START}\n${old}\n${RULE_END}\n`, "chore: rules");
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        promoted_at_count: 17,
        rejected_at_count: 20,
        status: "promoted",
        artifact_type: "rule",
        served_by: { type: "rule", path: "RULES.md" },
      }),
    ]);
    commitFile(repo, "promotions.json", readFileSync(ledgerPath(world), "utf8"), "chore: ledger");
    const complaint = opts.complaint === undefined ? COMPLAINT : opts.complaint;
    if (complaint !== null) complain(world, complaint);
    return { world, repo };
  }

  test("it redrafts with the feedback and never lowers the watermark", async () => {
    const { world, repo } = seedLive();
    const chat = new FakeChat({ draft: { artifact: ruleBody() } });

    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card()] }));

    expect(report.gated_out).toEqual({});
    expect(report.staged).toEqual([PATTERN]);
    expect(chat.promptsFor("drafter")[0]).toContain(`Artifact feedback: ${REASON}`);
    expect(chat.promptsFor("drafter")[0]).toContain(COMPLAINT);
    expect(chat.promptsFor("judge")[0]).toContain(COMPLAINT);
    const branch = branchName(world.name, PATTERN);
    expect(git.git(repo, ["log", "-1", "--format=%s", branch])).toBe(`feat(rule): refine ${PATTERN} (auto, gated)`);
    const row = parseLedger(git.show(repo, branch, "promotions.json").text).entries[PATTERN]!;
    expect(row.promoted_at_count).toBe(17);
    expect(row.rejected_at_count).toBe(20);
    expect(row.feedback).toEqual({ ...card(), snapshot_at: expect.any(String) });
  });

  test("a refine with fewer reflections than the mark keeps the mark", async () => {
    const { world, repo } = seedLive();
    addReflections(world, PATTERN, 2);
    const chat = new FakeChat({ draft: { artifact: ruleBody() } });

    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card()] }));

    expect(report.staged).toEqual([PATTERN]);
    const row = parseLedger(git.show(repo, branchName(world.name, PATTERN), "promotions.json").text).entries[PATTERN]!;
    expect(row.promoted_at_count).toBe(17);
  });

  test("with no complaint text there is nothing to ground in and no model call", async () => {
    const { world } = seedLive({ complaint: null });
    const chat = new FakeChat({ draft: { artifact: ruleBody() } });

    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card()] }));

    expect(report.gated_out[PATTERN]).toBe("no complaint text to ground a refine in");
    expect(chat.calls).toEqual([]);
  });

  test("a legacy bare-ref misfire still grounds a redraft", async () => {
    // The critic used to write a bare name, no "type:" prefix, to
    // critic.jsonl. complaints() must resolve it the same way the scorecard
    // does, or a refine it counts has no text to ground the redraft in.
    const { world } = seedLive({ complaint: null });
    fsx.appendJsonl(paths.criticFeedbackFile(), {
      ref: PATTERN,
      verdict: "misfired",
      reason: COMPLAINT,
      reflection_id: "r1",
      ts: "2026-09-20T00:00:00Z",
      world: world.name,
    });
    const chat = new FakeChat({ draft: { artifact: ruleBody() } });

    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card()] }));

    expect(report.gated_out[PATTERN]).toBeUndefined();
    expect(report.staged).toEqual([PATTERN]);
    expect(chat.promptsFor("drafter")[0]).toContain(COMPLAINT);
  });

  test("a redraft that only keeps the old wording is not grounded", async () => {
    // Grounded in the live artifact, keeping its vocabulary passed the lint by
    // construction. The complaints say something else, so this draft must fail.
    const { world } = seedLive({ complaint: "It interrupted a docs-only markdown session repeatedly." });
    const kept = "- Run `rg` over the changed symbol before calling the change safe; the graphify inventory misses wrapped consumers.";
    const chat = new FakeChat({ draft: { artifact: kept } });

    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card()] }));

    expect(report.staged).toEqual([]);
    expect(report.gated_out[PATTERN]).toContain("not grounded");
  });

  test("a refused refine is not redrafted until the scorecard changes", async () => {
    const { world } = seedLive();
    const chat = new FakeChat({ draft: { artifact: ruleBody() }, verdict: false, reason: "rule 3" });

    const first = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card()] }));
    expect(first.gated_out[PATTERN]).toBe("judge: rule 3");
    const second = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card()] }));

    expect(second.gated_out[PATTERN]).toContain("waiting for new feedback");
    expect(chat.roles.filter((r) => r === "drafter")).toHaveLength(1);

    complain(world, COMPLAINT);
    await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card(4)] }));
    expect(chat.roles.filter((r) => r === "drafter")).toHaveLength(2);
  });

  test("a provider failure is not cached: the next tick drafts again", async () => {
    const { world } = seedLive();
    let drafts = 0;
    const failing: ChatFn = async () => {
      drafts += 1;
      throw new Error("provider down");
    };
    const first = await run(world, makeCfg(), opts({ apply: true, chat: failing, cards: [card()] }));
    expect(first.gated_out[PATTERN]).toContain("draft failed");

    const chat = new FakeChat({ draft: { artifact: ruleBody() } });
    const second = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card()] }));

    expect(drafts).toBe(1);
    expect(chat.roles.filter((r) => r === "drafter")).toHaveLength(1);
    expect(second.staged).toEqual([PATTERN]);
  });

  test("a second tick while the refine is staged makes no model call", async () => {
    const { world, repo } = seedLive();
    await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: { artifact: ruleBody() } }).fn, cards: [card()] }));
    const branch = branchName(world.name, PATTERN);
    const first = git.git(repo, ["rev-parse", branch]);

    const chat = new FakeChat({ draft: { artifact: ruleBody() } });
    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card()] }));

    expect(report.staged).toEqual([]);
    expect(report.gated_out[PATTERN]).toBe("a refine is staged and waits for review");
    expect(chat.calls).toEqual([]);
    expect(git.git(repo, ["rev-parse", branch])).toBe(first);
  });
});

describe("a cluster refine by recurrence", () => {
  // Reflections on disk but below the mark, so the refine comes from the cluster
  // loop with those reflections as sources, not from the ledger-only pass.
  const card = (recurrence = 3) =>
    Scorecard.parse({
      ref: `rule:${PATTERN}`,
      type: "rule",
      name: PATTERN,
      uses_30d: 40,
      recurrence_30d: recurrence,
      proposal: "refine",
      reason: `served 40 times, failure reflected ${recurrence} times since promotion`,
      // Past observe_min_sessions, so a promote action here is not read as
      // "too few sessions on the live text yet" (`observing`).
      rate_since_revision: { sessions: 999, hits: recurrence, rate: recurrence / 999 },
      rate_since_promotion: { sessions: 999, hits: recurrence, rate: recurrence / 999 },
    });

  function seedLive(): { world: World; repo: string } {
    const world = makeWorld();
    const repo = initTarget(world);
    const old = `- Check the call sites before you ship. ${ruleTag(PATTERN)}`;
    commitFile(repo, "RULES.md", `# Rules\n\n${RULE_START}\n${old}\n${RULE_END}\n`, "chore: rules");
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        promoted_at_count: 17,
        status: "promoted",
        artifact_type: "rule",
        served_by: { type: "rule", path: "RULES.md" },
      }),
    ]);
    commitFile(repo, "promotions.json", readFileSync(ledgerPath(world), "utf8"), "chore: ledger");
    addReflections(world, PATTERN, 3);
    return { world, repo };
  }

  test("a second tick while the refine is staged makes no model call", async () => {
    const { world, repo } = seedLive();
    const first = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: { artifact: ruleBody() } }).fn, cards: [card()] }));
    expect(first.staged).toEqual([PATTERN]);
    const branch = branchName(world.name, PATTERN);
    const sha = git.git(repo, ["rev-parse", branch]);

    const chat = new FakeChat({ draft: { artifact: ruleBody() } });
    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card()] }));

    expect(report.staged).toEqual([]);
    expect(report.gated_out[PATTERN]).toBe("a refine is staged and waits for review");
    expect(chat.calls).toEqual([]);
    expect(git.git(repo, ["rev-parse", branch])).toBe(sha);
  });

  test("a refused refine waits until recurrence grows", async () => {
    const { world } = seedLive();
    const chat = new FakeChat({ draft: { artifact: ruleBody() }, verdict: false, reason: "rule 3" });

    const first = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card()] }));
    expect(first.gated_out[PATTERN]).toBe("judge: rule 3");
    const second = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card()] }));

    expect(second.gated_out[PATTERN]).toContain("waiting for new feedback");
    expect(chat.roles.filter((r) => r === "drafter")).toHaveLength(1);

    await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card(6)] }));
    expect(chat.roles.filter((r) => r === "drafter")).toHaveLength(2);
  });

  test("a refused refine stays refused when reflections age out of the window", async () => {
    const { world } = seedLive();
    const chat = new FakeChat({ draft: { artifact: ruleBody() }, verdict: false, reason: "rule 3" });

    await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card(6)] }));
    const second = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card(5)] }));

    expect(second.gated_out[PATTERN]).toContain("waiting for new feedback");
    expect(chat.roles.filter((r) => r === "drafter")).toHaveLength(1);
  });

  test("a promote that stages clears a cached refine refusal", async () => {
    const { world } = seedLive();
    const refused = new FakeChat({ draft: { artifact: ruleBody() }, verdict: false, reason: "rule 3" });
    await run(world, makeCfg(), opts({ apply: true, chat: refused.fn, cards: [card()] }));
    expect(Object.keys(fsx.readJsonOr<Record<string, string>>(paths.refineAttemptsFile(world.name), {}))).toEqual([PATTERN]);

    // Past the mark of 17, so the plan promotes instead of refining.
    addReflections(world, PATTERN, 17, { startDay: 4 });
    const report = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: { artifact: ruleBody() } }).fn, cards: [card()] }));

    expect(report.gated_out).toEqual({});
    expect(report.staged).toEqual([PATTERN]);
    expect(fsx.readJsonOr<Record<string, string>>(paths.refineAttemptsFile(world.name), {})).toEqual({});
  });

  test("a provider failure on a cluster refine is not cached", async () => {
    const { world } = seedLive();
    const failing: ChatFn = async () => {
      throw new Error("provider down");
    };
    const first = await run(world, makeCfg(), opts({ apply: true, chat: failing, cards: [card()] }));
    expect(first.gated_out[PATTERN]).toContain("draft failed");

    const chat = new FakeChat({ draft: { artifact: ruleBody() } });
    const second = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card()] }));
    expect(second.staged).toEqual([PATTERN]);
  });
});

describe("manualRefine: the bypass review.refine needs", () => {
  // review.refine runs this same pipeline with a single explicit refine
  // action and manualRefine: true. These two gates are the ones a human's
  // explicit request must get past that an automatic retry must not.
  function seedLive(): { world: World; repo: string } {
    const world = makeWorld();
    const repo = initTarget(world);
    const old = `- Check the call sites before you ship. ${ruleTag(PATTERN)}`;
    commitFile(repo, "RULES.md", `# Rules\n\n${RULE_START}\n${old}\n${RULE_END}\n`, "chore: rules");
    writeLedger(world, [
      entry({ pattern: PATTERN, promoted_at_count: 17, status: "promoted", artifact_type: "rule", served_by: { type: "rule", path: "RULES.md" } }),
    ]);
    commitFile(repo, "promotions.json", readFileSync(ledgerPath(world), "utf8"), "chore: ledger");
    return { world, repo };
  }

  function refineAction(overrides: Partial<PlanAction> = {}): PlanAction {
    return { pattern: PATTERN, count: 17, watermark: 17, action: "refine", sources: [], reason: "manual refine requested", feedback: null, ...overrides };
  }

  test("skips the cached-refusal gate that blocks an ordinary automatic retry", async () => {
    const { world } = seedLive();
    const ids = addReflections(world, PATTERN, 3);
    const card = Scorecard.parse({ ref: `rule:${PATTERN}`, type: "rule", name: PATTERN, proposal: "refine", reason: "misfires" });
    const action = refineAction({ sources: ids, feedback: "scorecard says misfires" });

    const refused = new FakeChat({ draft: { artifact: ruleBody() }, verdict: false, reason: "rule 3" });
    const first = await run(world, makeCfg(), opts({ apply: true, chat: refused.fn, cards: [card], actions: [action] }));
    expect(first.gated_out[PATTERN]).toBe("judge: rule 3");

    // An automatic retry at the same scorecard state reads the cached refusal
    // and never calls the drafter again.
    const second = await run(world, makeCfg(), opts({ apply: true, chat: refused.fn, cards: [card], actions: [action] }));
    expect(second.gated_out[PATTERN]).toContain("waiting for new feedback");
    expect(refused.roles.filter((r) => r === "drafter")).toHaveLength(1);

    // A human's explicit retry at the exact same scorecard state must reach
    // the drafter instead of reading back that cached refusal.
    const chat = new FakeChat({ draft: { artifact: ruleBody() } });
    const manual = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [card], actions: [action], manualRefine: true }));
    expect(manual.gated_out[PATTERN]).toBeUndefined();
    expect(manual.staged).toEqual([PATTERN]);
    expect(chat.roles.filter((r) => r === "drafter")).toHaveLength(1);
  });

  test("grounds a ledger-only refine in the action's own feedback, but only when manually requested", async () => {
    const { world } = seedLive();
    const feedbackText = "Mention every call site, read the graphify inventory, and keep calling the change safe worded concisely.";
    const action = refineAction({ sources: [], feedback: feedbackText });
    const draft = { artifact: ruleBody() };

    // No reflections and no scorecard complaint: an automatic refine (or a
    // worker tick that happened to carry this action) has nothing to ground
    // the redraft in and must still refuse.
    const automatic = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft }).fn, actions: [action] }));
    expect(automatic.gated_out[PATTERN]).toBe("no complaint text to ground a refine in");

    // The human's own instruction is real grounding text, so a manual refine
    // with the same evidence (none) succeeds instead.
    const chat = new FakeChat({ draft });
    const manual = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, actions: [action], manualRefine: true }));
    expect(manual.gated_out[PATTERN]).toBeUndefined();
    expect(manual.staged).toEqual([PATTERN]);
    expect(chat.promptsFor("drafter")[0]).toContain(feedbackText);
  });
});

describe("cross-type redraft cleanup", () => {
  test("a redraft that changes type removes the old artifact", async () => {
    // A ledger row missing `served_by` parses as null while `artifact_type` still
    // names the real, live artifact, so `stageOne` free routes with no forced type.
    const world = worldWith();
    const repo = initTarget(world);
    commitFile(
      repo,
      "RULES.md",
      `# Learned rules\n\nPromoted by the loop. Edit outside the markers only.\n\n${RULE_START}\n- old wording ${ruleTag(PATTERN)}\n${RULE_END}\n`,
      "chore: rules",
    );
    writeLedger(world, [entry({ pattern: PATTERN, status: "promoted", artifact_type: "rule", served_by: null })]);
    commitFile(repo, "promotions.json", readFileSync(ledgerPath(world), "utf8"), "chore: ledger");

    const chat = new FakeChat({ draft: hookDraft(PATTERN) });
    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn, cards: [observedCard(PATTERN)] }));

    expect(report.staged).toEqual([PATTERN]);
    expect(report.routed[PATTERN]!.type).toBe("hook");
    const branch = branchName(world.name, PATTERN);
    const hook = git.show(repo, branch, `nudges/${PATTERN}.json`);
    expect(hook.found).toBe(true);
    // Exactly one artifact serves the pattern: the old rule bullet is gone.
    const rules = git.show(repo, branch, "RULES.md");
    expect(rules.found).toBe(true);
    expect(rules.text).not.toContain(ruleTag(PATTERN));
  });
});

describe("redraft after a route change", () => {
  test("a route change redrafts once in the selected shape", async () => {
    const world = worldWith();
    const repo = initTarget(world);
    // The drafter claims a skill on evidence that is not in the sources, so the
    // router downgrades it to a rule and the body has to be rewritten.
    const first = {
      trigger_event: "none",
      gate: null,
      needs_own_context: false,
      context_evidence: null,
      capability_evidence: "the agent really wanted this",
      no_artifact: false,
      artifact: "---\nname: x\n---\nbody",
    };
    const chat = new FakeChat({ drafts: [first, { artifact: ruleBody() }] });

    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn }));

    expect(report.staged).toEqual([PATTERN]);
    expect(chat.roles).toEqual(["drafter", "drafter", "judge"]);
    // The downgrade is on the record, with the router's reason.
    expect(report.routed[PATTERN]!.drafted).toBe("skill");
    expect(report.routed[PATTERN]!.type).toBe("rule");
    expect(report.routed[PATTERN]!.reason).toContain("not verbatim");
    const { found, text } = git.show(repo, branchName(world.name, PATTERN), "RULES.md");
    expect(found).toBe(true);
    expect(text).toContain(ruleTag(PATTERN));
  });

  test("the drafter prompt states the router's quote bar", () => {
    // The prompt and the router are two halves of one contract. A prompt asking
    // for "an exact substring" while the router requires five words downgrades
    // an honest drafter to `rule` on every run, and nothing says why.
    const prompt = draftMessages(PATTERN, ["a lesson"], null, null).at(-1)!.content;
    expect(prompt).toContain(`${MIN_QUOTE_WORDS} words`);
    expect(prompt).toContain(`${MIN_QUOTE_CHARS} characters`);
    // And what buys a skill or an agent, in concrete terms. Without them the
    // drafter proposed hook or rule on every one of five real clusters.
    expect(prompt).toContain(`does not fit one ${ruleBudget(PATTERN)}-character bullet`);
    expect(prompt).toContain("reads many files, logs or tool outputs");
  });

  test("a rule written to the length the prompt states passes the lint", () => {
    // The lint measures the line the writer produces, tag included. A prompt
    // quoting the raw cap asks for a bullet that is then refused for being a
    // few characters over, on every run, with nothing saying why.
    const prompt = draftMessages(PATTERN, ["a lesson"], null, "rule").at(-1)!.content;
    const stated = Number(/(?:at most|under) (\d+) characters/.exec(prompt)?.[1]);
    expect(stated).toBeGreaterThan(0);
    const bullet = "- " + "x".repeat(stated - 2);
    expect(bullet.length).toBe(stated);
    expect(lintRule(bullet, PATTERN)).toEqual([]);
    // The stated number is the maximum, not just some length that fits: one
    // character more is refused, and the raw cap never reaches the drafter.
    expect(lintRule(bullet + "x", PATTERN).some((p) => p.includes("cap is"))).toBe(true);
    expect(prompt).not.toContain(`${MAX_RULE_CHARS} characters`);
  });

  test("the prompt states the configured cap net of the tag", () => {
    const cap = 200;
    const prompt = draftMessages(PATTERN, ["a lesson"], null, "rule", { maxRuleChars: cap }).at(-1)!.content;
    expect(prompt).toContain(`at most ${cap - 1 - ruleTag(PATTERN).length} characters`);
    const bullet = "- " + "x".repeat(cap - 1 - ruleTag(PATTERN).length - 2);
    expect(lintRule(bullet, PATTERN, cap)).toEqual([]);
    expect(lintRule(bullet + "x", PATTERN, cap).some((p) => p.includes(`cap is ${cap}`))).toBe(true);
    // The routing contract names the same budget when it says what a rule holds.
    const free = draftMessages(PATTERN, ["a lesson"], null, null, { maxRuleChars: cap }).at(-1)!.content;
    expect(free).toContain(`does not fit one ${ruleBudget(PATTERN, cap)}-character bullet`);
  });
});

describe("target handling", () => {
  test("the built-in learned repo is initialised on demand", async () => {
    const world = worldWith();
    expect(existsSync(targetRoot(world))).toBe(false);
    const report = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: skillDraft(PATTERN, QUOTE) }).fn }));
    expect(report.staged).toEqual([PATTERN]);
    expect(git.isRepo(targetRoot(world))).toBe(true);
  });

  test("a custom target that is not a repo is an error, not an init", async () => {
    const target = join(env.tmp, "not-a-repo");
    mkdirSync(target, { recursive: true });
    const world = makeWorld({ target });
    addReflections(world, PATTERN, 3);
    const report = await run(world, makeCfg(), opts({ apply: true, chat: new FakeChat({ draft: skillDraft(PATTERN, QUOTE) }).fn }));
    expect(report.error).toContain("not a git repository");
    expect(git.isRepo(target)).toBe(false);
  });
});
