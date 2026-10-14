// previewArtifact and verifyArtifact: read-only inspection of a live artifact.
// verifyArtifact must never write a ledger row, a branch or a proposal event,
// regardless of whether the type-check probe runs, is skipped, or errors.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerPath, paths, RULE_END, RULE_START, ruleTag, targetRoot, type Ledger, type PromotionEntry, type World } from "@sil/core";
import { artifacts, git, previewArtifact, verifyArtifact } from "@sil/curriculum";
import { saveLedger } from "@sil/store";
import {
  addReflections,
  cleanupEnv,
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

/** Everything verifyArtifact must never touch. */
function snapshotWrites(world: World, repo: string) {
  return {
    ledger: readFileSync(ledgerPath(world), "utf8"),
    branches: git.git(repo, ["branch", "--list"], { check: false }),
    events: existsSync(paths.proposalEventsFile()) ? readFileSync(paths.proposalEventsFile(), "utf8") : null,
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
    expect(result.offline.live).toEqual({ live: true, detail: `inline artifact present at ${external}` });
    void repo;
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
});
