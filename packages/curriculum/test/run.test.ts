// The curriculum run: gates, staging, and what it is not allowed to touch.
// Covers INVARIANTS 1 (never pushes), 3 (served patterns are not re-routed),
// 7 (rule writability), 9 (one commit) and 13 (per-pattern provider isolation).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Ledger,
  ledgerPath,
  type PromotionEntry,
  RULE_END,
  RULE_START,
  ruleTag,
  targetRoot,
  type World,
} from "@sil/core";
import type { ChatFn } from "@sil/providers";
import {
  artifacts,
  branchName,
  draftMessages,
  git,
  lintRule,
  MAX_RULE_CHARS,
  MIN_QUOTE_CHARS,
  MIN_QUOTE_WORDS,
  run,
  type RunOptions,
} from "@sil/curriculum";
import { parseLedger, saveLedger } from "@sil/store";
import {
  addReflections,
  agentBody,
  cleanupEnv,
  commitFile,
  FakeChat,
  fakeGateRunner,
  hookDraft,
  initTarget,
  installFakeNudge,
  makeCfg,
  makeWorld,
  ruleBody,
  silEnv,
  skillBody,
  skillDraft,
  type TestEnv,
  uninstallFakeNudge,
} from "./fixtures.ts";

const PATTERN = "verify-callsites";
const QUOTE = "run `rg` over every call site of the changed symbol and read the graphify inventory";

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
    commit: null,
    feedback: null,
    ...fields,
  };
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
      const pattern = prompt.includes("aaa-pattern") ? "aaa-pattern" : "bbb-pattern";
      return JSON.stringify(skillDraft(pattern, QUOTE));
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

    const report = await run(world, makeCfg(), opts({ apply: true, chat: chat.fn }));

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
        const bad = prompt.includes("aaa-pattern");
        return JSON.stringify({ verdict: bad ? "no" : "yes", reason: bad ? "rule 2: vague" : "quoted" });
      }
      return JSON.stringify(skillDraft(prompt.includes("aaa-pattern") ? "aaa-pattern" : "bbb-pattern", QUOTE));
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
      if (prompt.includes("aaa-pattern")) throw new Error("the endpoint never answered");
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
      const isAaa = messages[messages.length - 1]!.content.includes("aaa-pattern");
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
  test("an already served pattern is not re-routed", async () => {
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

    // route() must never be consulted: a fake runner that throws would surface
    // any call, and the drafter prompt below proves the forced path was taken.
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
    expect(prompt).toContain("does not fit one 300-character bullet");
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
