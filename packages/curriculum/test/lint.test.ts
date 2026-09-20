// Artifact lint: the cheap deterministic gate before the model judge.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RULE_END, RULE_START, ruleTag } from "@sil/core";
import {
  lint,
  lintDescriptionCap,
  lintGrounding,
  lintRule,
  lintSkill,
  MAX_DESCRIPTION,
  MAX_RULE_CHARS,
  ruleBudget,
} from "@sil/curriculum";
import { hookBody, installFakeNudge, reflectionBody, uninstallFakeNudge } from "./fixtures.ts";

const SOURCES =
  "Run `rg` over every call site of the changed symbol and read the graphify " +
  "inventory before calling the change safe. The promotions ledger records only a watermark.";

const GOOD_SKILL =
  "---\nname: verify-callsites\n" +
  "description: Use when a change touches a shared symbol and you are about to call it safe.\n---\n\n" +
  "## Enumerate every call site\n\n" +
  "Run `rg` over the changed symbol and read the graphify inventory before calling the change safe; the promotions ledger will not tell you.\n";

beforeEach(() => {
  installFakeNudge();
});
afterEach(() => {
  uninstallFakeNudge();
});

describe("skill shape", () => {
  test("a well-formed skill is clean", () => {
    expect(lint("skill", GOOD_SKILL, "verify-callsites", SOURCES)).toEqual([]);
  });

  test("frontmatter must exist", () => {
    expect(lintSkill("## No frontmatter here\n" + "x".repeat(200), "verify-callsites")).toEqual([
      "missing or malformed frontmatter (--- ... --- at top of file)",
    ]);
  });

  test("the frontmatter name must equal the pattern", () => {
    const text = GOOD_SKILL.replace("name: verify-callsites", "name: something-else");
    expect(lintSkill(text, "verify-callsites").some((p) => p.includes("must equal the pattern"))).toBe(true);
  });

  test("a description that is not a trigger is refused", () => {
    const text = GOOD_SKILL.replace(
      "description: Use when a change touches a shared symbol and you are about to call it safe.",
      "description: Some notes about call sites.",
    );
    expect(lintSkill(text, "verify-callsites").some((p) => p.includes("must read as a trigger"))).toBe(true);
  });

  test("the description cap bounds an unbounded refine", () => {
    // One V1 description grew one appended trigger per refine cycle until it was
    // a single ~300-word sentence, which fires less often rather than more.
    const longDesc = "Use when " + Array(60).fill("the thing happens").join(", or when ");
    expect(longDesc.length).toBeGreaterThan(MAX_DESCRIPTION);
    expect(lintDescriptionCap(longDesc).some((p) => p.includes(String(MAX_DESCRIPTION)))).toBe(true);
  });

  test("the description cap counts sentences but not abbreviations", () => {
    expect(lintDescriptionCap("Use when a call site changes, e.g. a shared enum. Check every consumer.")).toEqual([]);
    expect(lintDescriptionCap("Use when A. Then B. Then C. Then D.").some((p) => p.includes("sentences"))).toBe(true);
  });

  test("an unreplaced template placeholder is refused", () => {
    const text = GOOD_SKILL.replace(
      "description: Use when a change touches a shared symbol and you are about to call it safe.",
      "description: Use when <the situation that should trigger this skill>",
    );
    expect(lintSkill(text, "verify-callsites").some((p) => p.includes("unreplaced template placeholder"))).toBe(true);
  });

  test("a code-like angle bracket is not a placeholder", () => {
    const text = GOOD_SKILL.trimEnd() + "\n\nRun `git log -- <file>` and read Vec<String>.\n";
    expect(lintSkill(text, "verify-callsites").some((p) => p.includes("placeholder"))).toBe(false);
  });

  test("echoed drafting scaffolding is refused", () => {
    const text = GOOD_SKILL.trimEnd() + "\n\nLessons to generalise:\n\nsomething\n";
    expect(lintSkill(text, "verify-callsites").some((p) => p.includes("scaffolding echoed"))).toBe(true);
  });
});

describe("secrets", () => {
  test("a secret is never promoted from a skill", () => {
    const text = GOOD_SKILL.trimEnd() + "\n\napi_key: AKIAIOSFODNN7EXAMPLE\n";
    expect(lint("skill", text, "verify-callsites", SOURCES).some((p) => p.includes("secret"))).toBe(true);
  });

  test("a secret in a rule is never promoted", () => {
    // The sniff used to run on the skill path only, so the same token rode into
    // the shared rules file untouched.
    const bullet =
      "- Run `rg` over every call site of the changed symbol against the graphify promotions inventory with AKIAIOSFODNN7EXAMPLE";
    expect(lint("rule", bullet, "verify-callsites", SOURCES).some((p) => p.includes("secret"))).toBe(true);
  });

  test("a secret in a hook is never promoted", () => {
    const payload = hookBody("verify-callsites");
    payload["text"] = String(payload["text"]) + " AKIAIOSFODNN7EXAMPLE";
    expect(lint("hook", payload, "verify-callsites", SOURCES).some((p) => p.includes("secret"))).toBe(true);
  });
});

describe("hooks", () => {
  test("a hook must be bound to its own pattern", () => {
    // Unbound, a hook logs its fires under another artifact's name and spends
    // that artifact's once-per-session marker.
    const payload = hookBody("verify-callsites");
    payload["pattern"] = "somebody-elses-pattern";
    expect(
      lint("hook", payload, "verify-callsites", SOURCES).some((p) => p.includes("must equal the artifact's pattern")),
    ).toBe(true);
    // And the matching one is clean.
    expect(lint("hook", hookBody("verify-callsites"), "verify-callsites", SOURCES)).toEqual([]);
  });

  test("hook lint is delegated to the nudge dispatcher", () => {
    let seen: unknown = null;
    installFakeNudge({
      lintNudge: (obj) => {
        seen = obj;
        return ["gate fires unconditionally"];
      },
    });
    const payload = {
      pattern: "p",
      event: "PreToolUse",
      gate: { always: true },
      once_per: "session",
      text: "rg the graphify promotions inventory",
    };
    const problems = lint("hook", payload, "p", SOURCES);
    expect(seen).toBe(payload);
    expect(problems).toContain("gate fires unconditionally");
  });

  test("a hook payload that is not an object is refused", () => {
    expect(lint("hook", "not json", "p", SOURCES)).toEqual(["hook artifact must be a JSON object"]);
  });
});

describe("grounding", () => {
  test("grounding rejects a vacuous body", () => {
    // The one failure class the model judge does not catch: measured, it
    // credited the SOURCES' specificity to the artifact.
    const vacuous =
      "---\nname: verify-callsites\n" +
      "description: Use when you are about to be careless.\n---\n\n" +
      "## Be careful\n\nAlways be careful and verify things properly before you claim anything. Think about whether your result could be wrong.\n";
    expect(lint("skill", vacuous, "verify-callsites", SOURCES).some((p) => p.includes("not grounded in its sources"))).toBe(
      true,
    );
  });

  test("grounding accepts a body that reuses its sources vocabulary", () => {
    expect(lintGrounding(GOOD_SKILL, SOURCES)).toEqual([]);
  });

  test("grounding ignores the reflection template's own headings", () => {
    // Real sources, not a hand-written paragraph: the words being credited as
    // shared vocabulary are core.SECTIONS, which every reflection carries.
    const filler = "Think about what worked and what failed. Capture the reusable lesson. Do the verification.";
    const sources = reflectionBody("verify-callsites", "2026-09-01");
    expect(lintGrounding(filler, sources).some((p) => p.includes("not grounded in its sources"))).toBe(true);
    // A body that names what the sources actually name still passes.
    expect(lintGrounding(GOOD_SKILL, sources)).toEqual([]);
  });
});

describe("rules", () => {
  test("a rule is exactly one bullet under the cap", () => {
    expect(lintRule("- Run `rg` over every call site before calling it safe.")).toEqual([]);
    expect(lintRule("Run rg.")[0]!.startsWith("a rule must start")).toBe(true);
    expect(lintRule("- first bullet\n- second bullet")[0]).toContain("2 line(s)");
    const over = "- " + "x".repeat(MAX_RULE_CHARS);
    expect(lintRule(over).some((p) => p.includes(String(MAX_RULE_CHARS)))).toBe(true);
  });

  test("the rule cap counts the tag the writer appends", () => {
    const pattern = "verify-callsites";
    const tagCost = 1 + ruleTag(pattern).length;
    const fits = "- " + "x".repeat(MAX_RULE_CHARS - tagCost - 2);
    expect(fits.length + tagCost).toBe(MAX_RULE_CHARS);
    expect(lint("rule", fits, pattern, SOURCES).some((p) => p.includes("cap is"))).toBe(false);

    const over = fits + "x";
    // The bullet alone is under the cap; only the appended tag pushes it over.
    expect(over.length).toBeLessThanOrEqual(MAX_RULE_CHARS);
    expect(lint("rule", over, pattern, SOURCES).some((p) => p.includes(String(MAX_RULE_CHARS)))).toBe(true);
  });

  test("the cap is configurable and the budget is the cap net of the tag", () => {
    const pattern = "verify-callsites";
    const cap = 120;
    const fits = "- " + "x".repeat(ruleBudget(pattern, cap) - 2);
    expect(fits.length + 1 + ruleTag(pattern).length).toBe(cap);
    expect(lintRule(fits, pattern, cap)).toEqual([]);
    expect(lintRule(fits + "x", pattern, cap).some((p) => p.includes(`the cap is ${cap}`))).toBe(true);
    // The same bullet passes once the configured cap has room for it.
    expect(lint("rule", fits + "x", pattern, SOURCES, { maxRuleChars: cap + 1 }).some((p) => p.includes("cap is"))).toBe(false);
  });

  test("a rule bullet carrying a block marker is refused", () => {
    // A second marker pair makes every later rule write ambiguous, and a second
    // tag survives the removal that matches only its own. Either wedges the file
    // permanently, so the bullet never gets as far as the writer.
    for (const marker of [RULE_START, RULE_END, ruleTag("other-pattern")]) {
      const bullet = `- Run \`rg\` over every call site of the changed symbol ${marker}`;
      expect(lint("rule", bullet, "verify-callsites", SOURCES).some((p) => p.includes("managed-block marker"))).toBe(true);
    }
  });
});

describe("type dispatch", () => {
  test("an object forced onto a text type is refused, not crashed", () => {
    // Reachable at runtime: a served_by suppression forces the ledger's type
    // onto whatever the drafter returned, so a hook body can meet a skill's
    // lint path.
    for (const artifactType of ["skill", "agent", "rule"]) {
      expect(lint(artifactType, { gate: { always: true } }, "p", SOURCES)).toEqual([
        `${artifactType} artifact must be text, not dict`,
      ]);
    }
  });

  test("type none is always clean", () => {
    expect(lint("none", "", "p", SOURCES)).toEqual([]);
  });

  test("an unknown type is named rather than passed", () => {
    expect(lint("widget", "x", "p", SOURCES)).toEqual(['unknown artifact type "widget"']);
  });
});
