import { describe, expect, test } from "bun:test";
import { ValidationError } from "../src/errors.ts";
import { RULES_IMPORT_END, RULES_IMPORT_START } from "../src/consts.ts";
import { claudeMdImportsRules, MAX_CLAUDE_MD_BYTES, parseRulesImport, removeRulesImport, rulesImportBlock, rulesImportPathProblem, upsertRulesImport } from "../src/rules-import.ts";

const RULES = "/tmp/sil/rules/RULES.md";
const OTHER = "/tmp/sil/rules/OTHER.md";

describe("rules import block", () => {
  test("an empty CLAUDE.md gets a block with one standalone @ line", () => {
    const text = upsertRulesImport("", RULES);
    expect(text).toContain(RULES_IMPORT_START);
    expect(text).toContain(`${RULES_IMPORT_END}\n`);
    expect(text).toContain(`\n@${RULES}\n`);
    expect(text.indexOf(RULES_IMPORT_START)).toBeLessThan(text.indexOf(RULES_IMPORT_END));
    expect(parseRulesImport(text)).toEqual({ path: RULES });
  });

  test("existing content is kept and the block is appended after a blank line", () => {
    const text = upsertRulesImport("# My memory\n\nKeep this line.\n", RULES);
    expect(text.startsWith("# My memory\n\nKeep this line.\n")).toBe(true);
    expect(text).toContain(`\n\n${RULES_IMPORT_START}`);
    expect(parseRulesImport(text)).toEqual({ path: RULES });
  });

  test("a second upsert is byte-identical", () => {
    const once = upsertRulesImport("# My memory\n", RULES);
    expect(upsertRulesImport(once, RULES)).toBe(once);
  });

  test("replacing a stale import keeps the text around it", () => {
    const seeded = `before\n${rulesImportBlock(OTHER)}\nafter\n`;
    const text = upsertRulesImport(seeded, RULES);
    expect(text).toBe(`before\n${rulesImportBlock(RULES)}\nafter\n`);
  });

  test("relative imports resolve against the CLAUDE.md directory", () => {
    const text = upsertRulesImport("", "RULES.md");
    expect(claudeMdImportsRules(text, "/home/me/.claude/CLAUDE.md", "/home/me/.claude/RULES.md")).toBe(true);
    expect(claudeMdImportsRules(text, "/home/me/.claude/CLAUDE.md", "/home/me/.local/share/RULES.md")).toBe(false);
  });

  test("a stale absolute path is not an import of the configured file", () => {
    const text = upsertRulesImport("", OTHER);
    expect(claudeMdImportsRules(text, "/home/me/.claude/CLAUDE.md", RULES)).toBe(false);
  });

  test("no block means nothing is imported", () => {
    expect(parseRulesImport("# Just memory\n")).toBeNull();
    expect(claudeMdImportsRules("# Just memory\n", "/home/me/.claude/CLAUDE.md", RULES)).toBe(false);
  });

  test("a duplicated pair is refused instead of guessing which is live", () => {
    const text = `${rulesImportBlock(OTHER)}\n\n${rulesImportBlock(RULES)}\n`;
    expect(parseRulesImport(text)).toBeNull();
    expect(() => upsertRulesImport(text, RULES)).toThrow(ValidationError);
  });

  test("reversed markers are refused", () => {
    const text = `${RULES_IMPORT_END}\n@${RULES}\n${RULES_IMPORT_START}\n`;
    expect(parseRulesImport(text)).toBeNull();
    expect(() => upsertRulesImport(text, RULES)).toThrow(ValidationError);
  });

  test("two @ lines in one block are refused", () => {
    const text = `${RULES_IMPORT_START}\n@${RULES}\n@${OTHER}\n${RULES_IMPORT_END}\n`;
    expect(parseRulesImport(text)).toBeNull();
    expect(() => upsertRulesImport(text, RULES)).toThrow(ValidationError);
  });

  test("an empty @ line is refused", () => {
    const text = `${RULES_IMPORT_START}\n@\n${RULES_IMPORT_END}\n`;
    expect(parseRulesImport(text)).toBeNull();
    expect(() => upsertRulesImport(text, RULES)).toThrow(ValidationError);
  });

  test("the CLAUDE.md cap is a positive size", () => {
    expect(MAX_CLAUDE_MD_BYTES).toBeGreaterThan(0);
  });

  // Claude Code does not expand an @path at whitespace, so writing one would
  // make the hook skip injection while the session loads nothing.
  test("a rules path with whitespace is refused, and a hand-written one is not trusted", () => {
    const spaced = "/home/me/My Data/RULES.md";
    expect(rulesImportPathProblem(spaced)).toContain("whitespace");
    expect(() => rulesImportBlock(spaced)).toThrow(ValidationError);
    expect(() => upsertRulesImport("", spaced)).toThrow(ValidationError);

    const handWritten = `${RULES_IMPORT_START}\n@${spaced}\n${RULES_IMPORT_END}\n`;
    expect(claudeMdImportsRules(handWritten, "/home/me/.claude/CLAUDE.md", spaced)).toBe(false);
  });

  test("removing the block keeps the surrounding text and returns null when absent", () => {
    const withBlock = upsertRulesImport("# Keep\n\nA line.\n", RULES);
    expect(removeRulesImport(withBlock)).toBe("# Keep\n\nA line.\n");
    expect(removeRulesImport(upsertRulesImport("", RULES))).toBe("");
    expect(removeRulesImport("no block here\n")).toBeNull();
    const middle = `before\n${rulesImportBlock(RULES)}\nafter\n`;
    expect(removeRulesImport(middle)).toBe("before\n\nafter\n");
  });

  test("removing a malformed block is refused rather than deleting a guess", () => {
    const text = `${rulesImportBlock(OTHER)}\n\n${rulesImportBlock(RULES)}\n`;
    expect(() => removeRulesImport(text)).toThrow(ValidationError);
  });
});
