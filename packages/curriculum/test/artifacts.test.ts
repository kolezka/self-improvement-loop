// Artifact paths and writers, and the managed rules block.
// Covers INVARIANTS 7 (refuse rather than append blind) and 8 (replace by tag).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerPath, paths, RULE_END, RULE_START, ruleTag } from "@sil/core";
import { artifacts } from "@sil/curriculum";
import { cleanupEnv, makeWorld, silEnv, type TestEnv, V1_LAYOUT } from "./fixtures.ts";

const PATTERN = "verify-callsites";

let env: TestEnv;
beforeEach(() => {
  env = silEnv();
});
afterEach(() => {
  cleanupEnv(env);
});

describe("paths", () => {
  test("default layout paths", () => {
    const world = makeWorld();
    expect(artifacts.artifactRel(world, "skill", PATTERN)).toBe(`skills/${PATTERN}/SKILL.md`);
    expect(artifacts.artifactRel(world, "hook", PATTERN)).toBe(`nudges/${PATTERN}.json`);
    expect(artifacts.artifactRel(world, "agent", PATTERN)).toBe(`agents/${PATTERN}.md`);
    expect(artifacts.artifactRel(world, "rule", PATTERN)).toBe("RULES.md");
    expect(artifacts.artifactRel(world, "none", PATTERN)).toBe("");
  });

  test("the V1 dotfiles layout keeps its on-disk contract", () => {
    const world = makeWorld({ layout: V1_LAYOUT });
    expect(artifacts.artifactRel(world, "skill", PATTERN)).toBe(`claude/skills/${PATTERN}/SKILL.md`);
    expect(artifacts.artifactRel(world, "hook", PATTERN)).toBe(`claude/hooks/nudges/${PATTERN}.json`);
    expect(artifacts.artifactRel(world, "agent", PATTERN)).toBe(`claude/agents/${PATTERN}.md`);
    expect(artifacts.artifactRel(world, "rule", PATTERN)).toBe("global.CLAUDE.md");
    expect(ledgerPath(world).endsWith("promotions.json")).toBe(true);
    expect(world.layout.ledger).toBe("claude/skills/promotions.json");
  });

  test("an unsafe slug is refused at the one choke point", () => {
    const world = makeWorld();
    for (const bad of ["../escape", "a/b", "Upper", "", "with space", "."]) {
      for (const artifactType of ["skill", "hook", "agent", "rule", "none"]) {
        expect(() => artifacts.artifactRel(world, artifactType, bad)).toThrow();
      }
    }
  });

  test("allowed paths cover every type so a migration is acceptable", () => {
    const allowed = artifacts.allowedPaths(makeWorld(), PATTERN);
    expect([...allowed].sort()).toEqual(
      [`skills/${PATTERN}/SKILL.md`, `nudges/${PATTERN}.json`, `agents/${PATTERN}.md`, "RULES.md", "promotions.json"].sort(),
    );
  });
});

describe("writers", () => {
  test("writers land at the declared paths for both layouts", () => {
    for (const world of [makeWorld(), makeWorld({ layout: V1_LAYOUT })]) {
      const root = join(env.tmp, `target-${world.layout.skills_dir.replace(/\//g, "-")}`);
      artifacts.writeArtifact(world, "skill", PATTERN, "SKILL\n", root);
      artifacts.writeArtifact(world, "agent", PATTERN, "AGENT\n", root);
      artifacts.writeArtifact(world, "hook", PATTERN, { pattern: PATTERN }, root);
      expect(readFileSync(join(root, artifacts.artifactRel(world, "skill", PATTERN)), "utf8")).toBe("SKILL\n");
      expect(readFileSync(join(root, artifacts.artifactRel(world, "agent", PATTERN)), "utf8")).toBe("AGENT\n");
      const hookRel = artifacts.artifactRel(world, "hook", PATTERN);
      expect(JSON.parse(readFileSync(join(root, hookRel), "utf8"))).toEqual({ pattern: PATTERN });
    }
  });

  test("a hook write keeps only the keys the dispatcher reads", () => {
    // The drafter is free to invent keys. Nothing downstream reads them, so
    // persisting them puts an unreviewed field in a file a human is asked to
    // approve, and leaves it there for good.
    const world = makeWorld();
    const root = join(env.tmp, "target");
    const payload = {
      pattern: PATTERN,
      event: "PreToolUse",
      matcher: "Bash",
      gate: { command_matches: "git push" },
      once_per: "session",
      text: "check the call sites",
      run: "rm -rf /",
      priority: 99,
      blocking: true,
    };
    const path = artifacts.writeArtifact(world, "hook", PATTERN, payload, root)!;
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual([...artifacts.HOOK_KEYS].sort());
    expect(written["gate"]).toEqual({ command_matches: "git push" });
    expect(written["text"]).toBe("check the call sites");
  });

  test("writing type none writes nothing", () => {
    const root = join(env.tmp, "target");
    expect(artifacts.writeArtifact(makeWorld(), "none", PATTERN, "x", root)).toBeNull();
    expect(existsSync(root)).toBe(false);
  });

  test("removing a skill drops its file and empty directory", () => {
    const world = makeWorld();
    const root = join(env.tmp, "target");
    artifacts.writeArtifact(world, "skill", PATTERN, "SKILL\n", root);
    expect(artifacts.removeArtifact(world, "skill", PATTERN, root)).toBe(`skills/${PATTERN}/SKILL.md`);
    expect(existsSync(join(root, "skills", PATTERN))).toBe(false);
  });
});

// --- the managed rules block -------------------------------------------------

const MARKED = `# Boot contract\n\nHand written.\n\n${RULE_START}\n${RULE_END}\n\n## Tail\n`;

function writeRules(root: string, body: string): string {
  const path = join(root, "RULES.md");
  mkdirSync(root, { recursive: true });
  writeFileSync(path, body, "utf8");
  return path;
}

describe("managed rules block", () => {
  test("a rule write refuses a file with no marker pair", () => {
    const root = join(env.tmp, "target");
    writeRules(root, "# Boot contract\n\nHand written, never volunteered.\n");
    expect(() => artifacts.writeArtifact(makeWorld(), "rule", PATTERN, "- do the thing", root)).toThrow(/no .* marker pair/);
  });

  test("a rule write refuses a missing file", () => {
    const root = join(env.tmp, "target");
    mkdirSync(root, { recursive: true });
    expect(() => artifacts.writeArtifact(makeWorld(), "rule", PATTERN, "- do the thing", root)).toThrow(/no .* marker pair/);
  });

  test("a rule write refuses duplicated markers", () => {
    const root = join(env.tmp, "target");
    writeRules(root, `${RULE_START}\n${RULE_END}\n\nExample:\n\n${RULE_START}\n${RULE_END}\n`);
    expect(() => artifacts.writeArtifact(makeWorld(), "rule", PATTERN, "- do the thing", root)).toThrow(/ambiguous/);
  });

  test("a rule write refuses markers out of order", () => {
    const root = join(env.tmp, "target");
    writeRules(root, `${RULE_END}\nsome content\n${RULE_START}\n`);
    expect(() => artifacts.writeArtifact(makeWorld(), "rule", PATTERN, "- do the thing", root)).toThrow(
      /malformed marker order/,
    );
  });

  test("a rule write refuses a bullet carrying a block marker, before writing", () => {
    // Written once, such a bullet wedges the file for good: a duplicated marker
    // pair makes every later write ambiguous, and a second tag outlives the
    // removal that matches only the last one, so retire throws forever after.
    for (const marker of [RULE_START, RULE_END, ruleTag("other-pattern")]) {
      const root = join(env.tmp, `target-${marker.length}-${Math.random().toString(16).slice(2)}`);
      const path = writeRules(root, MARKED);
      const before = readFileSync(path, "utf8");
      expect(() => artifacts.writeArtifact(makeWorld(), "rule", PATTERN, `- see ${marker}`, root)).toThrow(/wedge/);
      expect(readFileSync(path, "utf8")).toBe(before);
    }
  });

  test("a rule replaces by tag in place and never duplicates", () => {
    const world = makeWorld();
    const root = join(env.tmp, "target");
    const path = writeRules(root, MARKED);
    artifacts.writeArtifact(world, "rule", PATTERN, "- first wording", root);
    artifacts.writeArtifact(world, "rule", PATTERN, "- second wording", root);
    const text = readFileSync(path, "utf8");
    expect(text.split(ruleTag(PATTERN)).length - 1).toBe(1);
    expect(text).toContain("- second wording");
    expect(text).not.toContain("- first wording");
    // Everything outside the markers is byte-identical.
    expect(text.startsWith("# Boot contract\n\nHand written.\n\n")).toBe(true);
    expect(text.endsWith("\n\n## Tail\n")).toBe(true);
  });

  test("a rule write leaves other patterns bullets alone", () => {
    const world = makeWorld();
    const root = join(env.tmp, "target");
    const path = writeRules(root, MARKED);
    const other = `- somebody else's rule ${ruleTag("other-pattern")}`;
    const untagged = "- a hand-written bullet with no tag";
    writeFileSync(path, readFileSync(path, "utf8").replace(`${RULE_START}\n`, `${RULE_START}\n${other}\n${untagged}\n`), "utf8");

    artifacts.writeArtifact(world, "rule", PATTERN, "- mine", root);
    const text = readFileSync(path, "utf8");
    expect(text).toContain(other);
    expect(text).toContain(untagged);
    expect(text).toContain(`- mine ${ruleTag(PATTERN)}`);
  });

  test("remove drops only this pattern's bullet and never the file", () => {
    const world = makeWorld();
    const root = join(env.tmp, "target");
    const path = writeRules(root, MARKED);
    artifacts.writeArtifact(world, "rule", "other-pattern", "- theirs", root);
    artifacts.writeArtifact(world, "rule", PATTERN, "- mine", root);

    expect(artifacts.removeArtifact(world, "rule", PATTERN, root)).toBe("RULES.md");
    const text = readFileSync(path, "utf8");
    expect(existsSync(path)).toBe(true);
    expect(text).not.toContain(ruleTag(PATTERN));
    expect(text).toContain("- theirs");
    // Removing something that is not there is a no-op, not an error.
    expect(artifacts.removeArtifact(world, "rule", PATTERN, root)).toBe("");
  });

  test("reading a rule returns only this pattern's bullet", () => {
    const world = makeWorld();
    const root = join(env.tmp, "target");
    writeRules(root, MARKED);
    artifacts.writeArtifact(world, "rule", "other-pattern", "- theirs", root);
    artifacts.writeArtifact(world, "rule", PATTERN, "- mine", root);
    const body = artifacts.readArtifact(world, "rule", PATTERN, root);
    expect(body.startsWith("- mine")).toBe(true);
    expect(body).not.toContain("theirs");
  });
});

describe("rules-file ownership", () => {
  test("the built-in learned repo gets its marker pair", () => {
    const world = makeWorld();
    expect(artifacts.ownsRulesFile(world)).toBe(true);
    const path = artifacts.ensureRulesFile(world)!;
    expect(path).toBe(join(paths.defaultTarget(world.name), "RULES.md"));
    const text = readFileSync(path, "utf8");
    expect(text).toContain(RULE_START);
    expect(text).toContain(RULE_END);
    expect(artifacts.rulesProblem(world)).toBeNull();
  });

  test("a custom target never gets a rules file created", () => {
    const target = join(env.tmp, "someone-elses-repo");
    mkdirSync(target, { recursive: true });
    const world = makeWorld({ target });
    expect(artifacts.ownsRulesFile(world)).toBe(false);
    expect(artifacts.ensureRulesFile(world)).toBeNull();
    expect(readdirSync(target)).toEqual([]);
  });

  test("ensureRulesFile can write into a scratch tree", () => {
    const world = makeWorld();
    const tree = join(env.tmp, "scratch");
    mkdirSync(tree, { recursive: true });
    expect(artifacts.ensureRulesFile(world, tree)).toBe(join(tree, "RULES.md"));
    expect(existsSync(join(paths.defaultTarget(world.name), "RULES.md"))).toBe(false);
  });
});

describe("placeholders", () => {
  test("a rehome stub is recognised as a placeholder", () => {
    for (const artifactType of ["skill", "agent", "rule", "hook"]) {
      const body = artifacts.placeholderBody(PATTERN, artifactType, "skill");
      const text = typeof body === "string" ? body : JSON.stringify(body);
      expect(artifacts.isPlaceholderBody(artifactType, text)).toBe(true);
    }
  });

  test("a real artifact that merely mentions TODO is not a placeholder", () => {
    const skill = "---\nname: p\ndescription: Use when a TODO is left in the tree.\n---\n\n## TODO\n\nResolve the TODO before shipping.\n";
    expect(artifacts.isPlaceholderBody("skill", skill)).toBe(false);
    expect(artifacts.isPlaceholderBody("rule", "- TODO: chase the owner")).toBe(false);
    expect(
      artifacts.isPlaceholderBody(
        "hook",
        JSON.stringify({ event: "PreToolUse", gate: { always: true }, once_per: "session", text: "a real always-fire hook" }),
      ),
    ).toBe(false);
    expect(artifacts.isPlaceholderBody("skill", "")).toBe(false);
  });
});
