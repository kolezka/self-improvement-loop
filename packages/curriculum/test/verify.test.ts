// previewArtifact and verifyArtifact: read-only inspection of a live artifact.
// verifyArtifact must never write a ledger row, a branch, a proposal event, a
// scorecard or a cluster-summary digest, regardless of whether the type-check
// probe runs, is skipped, or errors. The "nothing was written" snapshot below
// covers the whole state and data dirs, not just the three files the loop's
// own writers are named after, so a write anywhere new is caught too.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ledgerPath, paths, RULE_END, RULE_START, ruleTag, targetRoot, type Ledger, type PromotionEntry, type World } from "@sil/core";
import { MAX_RULES_BYTES } from "@sil/core/lessons";
import { artifacts, digestPath, git, previewArtifact, reflections, saveSummary, verifyArtifact } from "@sil/curriculum";
import { saveLedger } from "@sil/store";
import {
  addReflections,
  cleanupEnv,
  commitFile,
  fakeGateRunner,
  FakeChat,
  hookBody,
  hookDraft,
  initTarget,
  installFakeNudge,
  makeCfg,
  makeWorld,
  ruleBody,
  ruleDraft,
  silEnv,
  type TestEnv,
  uninstallFakeNudge,
} from "./fixtures.ts";

const PATTERN = "verify-callsites";

let env: TestEnv;
beforeEach(() => {
  env = silEnv();
  installFakeNudge();
});
afterEach(() => {
  uninstallFakeNudge();
  cleanupEnv(env);
});

function writeLedger(world: World, entries: PromotionEntry[]): void {
  const ledger: Ledger = { version: 1, entries: Object.fromEntries(entries.map((e) => [e.pattern, e])) };
  const path = ledgerPath(world);
  mkdirSync(join(path, ".."), { recursive: true });
  saveLedger(path, ledger);
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

/** sha256 per file, keyed by path relative to `root`. "" for a root that does
 * not exist. Content-hashed, not just listed, so a same-size overwrite still
 * shows up. */
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out[relative(root, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(root);
  return out;
}

/** Everything verifyArtifact must never touch: the ledger, the target repo's
 * branches, and a full content hash of every file under the state and data
 * dirs (queue, usage, feedback, proposal events, digests, worlds, the ledger
 * and the target repo's own .git, all of it), not only the three paths the
 * loop's named writers touch. */
function snapshotWrites(world: World, repo: string) {
  return {
    ledger: readFileSync(ledgerPath(world), "utf8"),
    branches: git.git(repo, ["branch", "--list"], { check: false }),
    events: existsSync(paths.proposalEventsFile()) ? readFileSync(paths.proposalEventsFile(), "utf8") : null,
    state: hashTree(paths.stateDir()),
    data: hashTree(paths.dataDir()),
  };
}

function writeRule(repo: string, pattern: string, bullet = ruleBody()): void {
  writeFileSync(join(repo, "RULES.md"), `# Rules\n\n${RULE_START}\n${bullet} ${ruleTag(pattern)}\n${RULE_END}\n`, "utf8");
}

function writeHook(repo: string, pattern: string, gate: unknown): void {
  const body = { ...hookBody(pattern), gate };
  mkdirSync(join(repo, "nudges"), { recursive: true });
  writeFileSync(join(repo, "nudges", `${pattern}.json`), JSON.stringify(body, null, 2) + "\n", "utf8");
}

const HOOK_PROBE = { ...ruleDraft(), trigger_event: "PreToolUse:Bash", gate: { command_matches: "git (commit|push)" } };

describe("verifyArtifact: upgrade signal", () => {
  test("a rule whose evidence earns a hook reports upgrade: true, and writes nothing", async () => {
    const world = makeWorld();
    const repo = initTarget(world);
    addReflections(world, PATTERN, 3);
    writeRule(repo, PATTERN);
    writeLedger(world, [
      entry({ pattern: PATTERN, status: "promoted", artifact_type: "rule", served_by: { type: "rule", path: "RULES.md" } }),
    ]);

    const before = snapshotWrites(world, repo);
    const chat = new FakeChat({ draft: HOOK_PROBE });
    const result = await verifyArtifact(world, makeCfg(), PATTERN, { chat: chat.fn, gateRunner: fakeGateRunner });

    expect(result.artifact_type).toBe("rule");
    expect(result.offline.exists).toBe(true);
    expect(result.offline.live).toEqual({ live: true, detail: `bullet present inside the managed block of RULES.md` });
    expect(result.offline.lint).toEqual([]);
    expect(result.offline.gate).toBeNull();
    expect(result.type_check).toEqual({
      current_type: "rule",
      router_type: "hook",
      reason: expect.stringContaining("gate fires"),
      upgrade: true,
    });

    expect(snapshotWrites(world, repo)).toEqual(before);
  });

  test("a router result of rule on a rule is not reported as an upgrade", async () => {
    const world = makeWorld();
    const repo = initTarget(world);
    addReflections(world, PATTERN, 3);
    writeRule(repo, PATTERN);
    writeLedger(world, [
      entry({ pattern: PATTERN, status: "promoted", artifact_type: "rule", served_by: { type: "rule", path: "RULES.md" } }),
    ]);

    const chat = new FakeChat({ draft: ruleDraft() });
    const result = await verifyArtifact(world, makeCfg(), PATTERN, { chat: chat.fn, gateRunner: fakeGateRunner });

    expect(result.type_check).toMatchObject({ current_type: "rule", router_type: "rule", upgrade: false });
  });
});

describe("verifyArtifact: the cluster summary is never recomputed or written", () => {
  test(">= SUMMARY_MIN_LESSONS reflections with no cached digest: exactly one chat call, digest dir unchanged", async () => {
    const world = makeWorld();
    const repo = initTarget(world);
    addReflections(world, PATTERN, 8);
    writeRule(repo, PATTERN);
    writeLedger(world, [
      entry({ pattern: PATTERN, status: "promoted", artifact_type: "rule", served_by: { type: "rule", path: "RULES.md" } }),
    ]);

    const digest = digestPath(world.name, PATTERN);
    expect(existsSync(digest)).toBe(false);

    const chat = new FakeChat({ draft: ruleDraft() });
    await verifyArtifact(world, makeCfg(), PATTERN, { chat: chat.fn, gateRunner: fakeGateRunner });

    // Before the fix this was ["drafter", "drafter"]: one call from
    // context.clusterSummary (which also wrote the digest), one for the
    // forced draft itself.
    expect(chat.roles).toEqual(["drafter"]);
    expect(existsSync(digest)).toBe(false);
  });

  test("a cached digest covering every reflection is reused, not recomputed", async () => {
    const world = makeWorld();
    const repo = initTarget(world);
    addReflections(world, PATTERN, 8);
    writeRule(repo, PATTERN);
    writeLedger(world, [
      entry({ pattern: PATTERN, status: "promoted", artifact_type: "rule", served_by: { type: "rule", path: "RULES.md" } }),
    ]);
    const ids = reflections(world).filter((r) => r.pattern === PATTERN).map((r) => r.id);
    saveSummary(world.name, { version: 1, pattern: PATTERN, summary: "the cached standing summary", covered: ids, updated: "2026-09-01T00:00:00Z" });

    const chat = new FakeChat({ draft: ruleDraft() });
    await verifyArtifact(world, makeCfg(), PATTERN, { chat: chat.fn, gateRunner: fakeGateRunner });

    expect(chat.roles).toEqual(["drafter"]);
    expect(chat.promptsFor("drafter")[0]).toContain("the cached standing summary");
  });
});

describe("verifyArtifact: offline checks", () => {
  test("a hook whose gate no longer fires reports a failed gate, and writes nothing", async () => {
    const world = makeWorld();
    const repo = initTarget(world);
    addReflections(world, PATTERN, 3);
    writeHook(repo, PATTERN, { command_matches: "this-matches-nothing-xyz" });
    writeLedger(world, [
      entry({ pattern: PATTERN, status: "promoted", artifact_type: "hook", served_by: { type: "hook", path: `nudges/${PATTERN}.json` } }),
    ]);

    const before = snapshotWrites(world, repo);
    const chat = new FakeChat({ draft: hookDraft(PATTERN) });
    const result = await verifyArtifact(world, makeCfg(), PATTERN, { chat: chat.fn, gateRunner: fakeGateRunner });

    expect(result.offline.exists).toBe(true);
    expect(result.offline.live.live).toBe(true);
    expect(result.offline.gate).not.toBeNull();
    expect(result.offline.gate!.fires).toBe(false);
    expect(result.offline.gate!.hits).toBe(0);
    expect(result.offline.gate!.verdict).toContain("matched nothing");

    expect(snapshotWrites(world, repo)).toEqual(before);
  });

  test("a malformed gate shape is reported as a failed check, not a thrown error", async () => {
    const world = makeWorld();
    const repo = initTarget(world);
    addReflections(world, PATTERN, 3);
    writeHook(repo, PATTERN, "invalid-gate");
    writeLedger(world, [
      entry({ pattern: PATTERN, status: "promoted", artifact_type: "hook", served_by: { type: "hook", path: `nudges/${PATTERN}.json` } }),
    ]);

    const before = snapshotWrites(world, repo);
    const chat = new FakeChat({ draft: hookDraft(PATTERN) });
    // Before the fix, RouteAnswer.parse threw a ZodError here and the whole
    // call rejected, losing offline.exists/live/lint along with it.
    const result = await verifyArtifact(world, makeCfg(), PATTERN, { chat: chat.fn, gateRunner: fakeGateRunner });

    expect(result.offline.exists).toBe(true);
    expect(result.offline.live.live).toBe(true);
    expect(result.offline.lint).toEqual([]);
    expect(result.offline.gate).toEqual({ verdict: "malformed gate", fires: false, hits: 0, total: expect.any(Number) });

    expect(snapshotWrites(world, repo)).toEqual(before);
  });

  test("a rule is not reported live when rules_inject is false, even with its bullet in the managed block", async () => {
    const world = makeWorld({ rules_inject: false });
    const repo = initTarget(world);
    addReflections(world, PATTERN, 3);
    writeRule(repo, PATTERN);
    writeLedger(world, [
      entry({ pattern: PATTERN, status: "promoted", artifact_type: "rule", served_by: { type: "rule", path: "RULES.md" } }),
    ]);

    const result = await verifyArtifact(world, makeCfg(), PATTERN, { gateRunner: fakeGateRunner });
    expect(result.offline.live.live).toBe(false);
    expect(result.offline.live.detail).toContain("rules_inject is false");
  });

  test("a rule over the size cap is not reported live, even with its bullet in the managed block", async () => {
    const world = makeWorld();
    const repo = initTarget(world);
    addReflections(world, PATTERN, 3);
    const filler = "x".repeat(MAX_RULES_BYTES + 1024);
    writeFileSync(join(repo, "RULES.md"), `# Rules\n\n${RULE_START}\n${ruleBody()} ${ruleTag(PATTERN)}\n${RULE_END}\n${filler}`, "utf8");
    writeLedger(world, [
      entry({ pattern: PATTERN, status: "promoted", artifact_type: "rule", served_by: { type: "rule", path: "RULES.md" } }),
    ]);

    const result = await verifyArtifact(world, makeCfg(), PATTERN, { gateRunner: fakeGateRunner });
    expect(result.offline.live.live).toBe(false);
    expect(result.offline.live.detail).toContain("injection cap");
  });

  test("no reflections for the pattern skips the type check with an explicit reason", async () => {
    const world = makeWorld();
    const repo = initTarget(world);
    writeRule(repo, PATTERN);
    writeLedger(world, [
      entry({ pattern: PATTERN, status: "promoted", artifact_type: "rule", served_by: { type: "rule", path: "RULES.md" } }),
    ]);

    const result = await verifyArtifact(world, makeCfg(), PATTERN, { gateRunner: fakeGateRunner });
    expect(result.type_check).toEqual({ skipped: expect.stringContaining("no reflections") });
  });

  test("an inline row skips the type check with an explicit reason but still runs offline checks", async () => {
    const world = makeWorld();
    const repo = initTarget(world);
    addReflections(world, PATTERN, 3);
    const external = join(env.tmp, "SKILL.md");
    writeFileSync(external, "---\nname: verify-callsites\ndescription: Use when something.\n---\n\nbody\n", "utf8");
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        status: "promoted",
        artifact_type: "skill",
        served_by: { type: "skill", path: null },
        origin: "inline",
        external_path: external,
      }),
    ]);

    const result = await verifyArtifact(world, makeCfg(), PATTERN, { gateRunner: fakeGateRunner });
    expect(result.type_check).toEqual({ skipped: expect.stringContaining("inline") });
    expect(result.offline.exists).toBe(true);
    // register() only checks "is an absolute, existing regular file", never
    // "is somewhere Claude Code loads a skill from"; /tmp/.../SKILL.md is
    // real on disk and never read by anything.
    expect(result.offline.live).toEqual({ live: false, detail: "file exists but is not in a location Claude Code loads" });
    void repo;
  });

  test("an inline skill in the Claude config's skills dir is reported live", async () => {
    const world = makeWorld();
    initTarget(world);
    addReflections(world, PATTERN, 3);
    const dir = join(paths.claudeConfigDir(), "skills", PATTERN);
    mkdirSync(dir, { recursive: true });
    const external = join(dir, "SKILL.md");
    writeFileSync(external, "---\nname: verify-callsites\ndescription: Use when something.\n---\n\nbody\n", "utf8");
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        status: "promoted",
        artifact_type: "skill",
        served_by: { type: "skill", path: null },
        origin: "inline",
        external_path: external,
      }),
    ]);

    const result = await verifyArtifact(world, makeCfg(), PATTERN, { gateRunner: fakeGateRunner });
    expect(result.offline.live).toEqual({ live: true, detail: `inline artifact present at ${external}` });
  });

  test("an inline agent in a project .claude/agents dir is reported live", async () => {
    const world = makeWorld();
    initTarget(world);
    addReflections(world, PATTERN, 3);
    const dir = join(env.tmp, "my-project", ".claude", "agents");
    mkdirSync(dir, { recursive: true });
    const external = join(dir, `${PATTERN}.md`);
    writeFileSync(external, "---\nname: verify-callsites\ndescription: Use when something.\n---\n\nbody\n", "utf8");
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        status: "promoted",
        artifact_type: "agent",
        served_by: { type: "agent", path: null },
        origin: "inline",
        external_path: external,
      }),
    ]);

    const result = await verifyArtifact(world, makeCfg(), PATTERN, { gateRunner: fakeGateRunner });
    expect(result.offline.live.live).toBe(true);
  });

  test("an inline rule is reported live only as a CLAUDE.md memory file", async () => {
    const world = makeWorld();
    initTarget(world);
    addReflections(world, PATTERN, 3);
    const notMemoryFile = join(env.tmp, "notes.md");
    writeFileSync(notMemoryFile, "- a rule\n", "utf8");
    writeLedger(world, [
      entry({
        pattern: PATTERN,
        status: "promoted",
        artifact_type: "rule",
        served_by: { type: "rule", path: null },
        origin: "inline",
        external_path: notMemoryFile,
      }),
    ]);

    const result = await verifyArtifact(world, makeCfg(), PATTERN, { gateRunner: fakeGateRunner });
    expect(result.offline.live.live).toBe(false);
  });

  test("retired or missing artifacts refuse", async () => {
    const world = makeWorld();
    initTarget(world);
    writeLedger(world, [entry({ pattern: PATTERN, status: "retired", artifact_type: "rule" })]);
    await expect(verifyArtifact(world, makeCfg(), PATTERN, { gateRunner: fakeGateRunner })).rejects.toThrow(/retired/);
    await expect(verifyArtifact(world, makeCfg(), "not-in-ledger", { gateRunner: fakeGateRunner })).rejects.toThrow(/not in the ledger/);
  });
});

describe("verifyArtifact: a missing drafter role fails loud", () => {
  test("surfaces ModelNotConfigured in type_check.error, with offline results present, and writes nothing", async () => {
    const world = makeWorld();
    const repo = initTarget(world);
    addReflections(world, PATTERN, 3);
    writeRule(repo, PATTERN);
    writeLedger(world, [
      entry({ pattern: PATTERN, status: "promoted", artifact_type: "rule", served_by: { type: "rule", path: "RULES.md" } }),
    ]);

    const before = snapshotWrites(world, repo);
    // No `chat` override: verifyArtifact falls back to the real provider chat,
    // and this environment's llm.yaml does not exist.
    const result = await verifyArtifact(world, makeCfg(), PATTERN, { gateRunner: fakeGateRunner });

    expect(result.offline.exists).toBe(true);
    expect(result.offline.live.live).toBe(true);
    expect(result.type_check).toMatchObject({ error: expect.stringContaining("ModelNotConfigured") });

    expect(snapshotWrites(world, repo)).toEqual(before);
  });
});

describe("previewArtifact", () => {
  function servedWorld(type: "rule" | "hook" | "skill"): { world: World; repo: string } {
    const world = makeWorld();
    const repo = initTarget(world);
    if (type === "rule") {
      writeRule(repo, PATTERN);
      writeLedger(world, [entry({ pattern: PATTERN, status: "promoted", artifact_type: "rule", served_by: { type: "rule", path: "RULES.md" } })]);
    } else if (type === "hook") {
      writeHook(repo, PATTERN, { command_matches: "git (commit|push)" });
      writeLedger(world, [entry({ pattern: PATTERN, status: "promoted", artifact_type: "hook", served_by: { type: "hook", path: `nudges/${PATTERN}.json` } })]);
    } else {
      const rel = artifacts.artifactRel(world, "skill", PATTERN);
      mkdirSync(join(targetRoot(world), "skills", PATTERN), { recursive: true });
      writeFileSync(join(targetRoot(world), rel), "---\nname: verify-callsites\ndescription: Use when something.\n---\n\nbody\n", "utf8");
      writeLedger(world, [entry({ pattern: PATTERN, status: "promoted", artifact_type: "skill", served_by: { type: "skill", path: rel } })]);
    }
    return { world, repo };
  }

  test.each(["rule", "hook", "skill"] as const)("returns the live body for a %s", (type) => {
    const { world } = servedWorld(type);
    const result = previewArtifact(world, makeCfg(), PATTERN);
    expect(result.pattern).toBe(PATTERN);
    expect(result.artifact_type).toBe(type);
    expect(result.body.length).toBeGreaterThan(0);
  });

  test("errors on a retired row", () => {
    const world = makeWorld();
    initTarget(world);
    writeLedger(world, [entry({ pattern: PATTERN, status: "retired", artifact_type: "rule" })]);
    expect(() => previewArtifact(world, makeCfg(), PATTERN)).toThrow(/retired/);
  });

  test("reads the bullet only from inside the managed block, not a stale duplicate outside it", () => {
    const world = makeWorld();
    const repo = initTarget(world);
    const liveBullet = ruleBody();
    const staleBullet = "- a stale duplicate bullet that must never be read";
    writeFileSync(
      join(repo, "RULES.md"),
      `# Rules\n\n${staleBullet} ${ruleTag(PATTERN)}\n\n${RULE_START}\n${liveBullet} ${ruleTag(PATTERN)}\n${RULE_END}\n`,
      "utf8",
    );
    writeLedger(world, [entry({ pattern: PATTERN, status: "promoted", artifact_type: "rule", served_by: { type: "rule", path: "RULES.md" } })]);

    const result = previewArtifact(world, makeCfg(), PATTERN);
    expect(result.body).toBe(liveBullet);
    expect(result.body).not.toContain("stale duplicate");
  });

  describe("matches_default_branch", () => {
    test("true when the live body is exactly what is committed on the default branch", () => {
      const world = makeWorld();
      const repo = initTarget(world);
      const bullet = `${ruleBody()} ${ruleTag(PATTERN)}`;
      commitFile(repo, "RULES.md", `# Rules\n\n${RULE_START}\n${bullet}\n${RULE_END}\n`, "chore: rules");
      writeLedger(world, [entry({ pattern: PATTERN, status: "promoted", artifact_type: "rule", served_by: { type: "rule", path: "RULES.md" } })]);

      const result = previewArtifact(world, makeCfg(), PATTERN);
      expect(result.matches_default_branch).toBe(true);
    });

    test("false when the working tree carries an uncommitted edit", () => {
      const world = makeWorld();
      const repo = initTarget(world);
      const bullet = `${ruleBody()} ${ruleTag(PATTERN)}`;
      commitFile(repo, "RULES.md", `# Rules\n\n${RULE_START}\n${bullet}\n${RULE_END}\n`, "chore: rules");
      // An uncommitted local edit, never committed.
      writeFileSync(join(repo, "RULES.md"), `# Rules\n\n${RULE_START}\n${ruleBody()} edited locally ${ruleTag(PATTERN)}\n${RULE_END}\n`, "utf8");
      writeLedger(world, [entry({ pattern: PATTERN, status: "promoted", artifact_type: "rule", served_by: { type: "rule", path: "RULES.md" } })]);

      const result = previewArtifact(world, makeCfg(), PATTERN);
      expect(result.matches_default_branch).toBe(false);
    });

    test("true for an inline artifact, which has no default-branch history to compare against", () => {
      const world = makeWorld();
      initTarget(world);
      const external = join(env.tmp, "SKILL.md");
      writeFileSync(external, "---\nname: verify-callsites\ndescription: Use when something.\n---\n\nbody\n", "utf8");
      writeLedger(world, [
        entry({
          pattern: PATTERN,
          status: "promoted",
          artifact_type: "skill",
          served_by: { type: "skill", path: null },
          origin: "inline",
          external_path: external,
        }),
      ]);

      const result = previewArtifact(world, makeCfg(), PATTERN);
      expect(result.matches_default_branch).toBe(true);
    });
  });
});
