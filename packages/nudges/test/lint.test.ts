import { describe, expect, test } from "bun:test";
import { MAX_TEXT, lintNudge } from "../src/lint.ts";

function validNudge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pattern: "commit-nudge",
    event: "PreToolUse",
    matcher: "Bash",
    gate: { command_matches: "git commit" },
    once_per: "session",
    text: "Remember to write a good commit message.",
    ...overrides,
  };
}

describe("lintNudge", () => {
  test("a well-formed nudge is clean", () => {
    expect(lintNudge(validNudge())).toEqual([]);
  });

  test("missing required fields are reported", () => {
    const problems = lintNudge({ pattern: "x" });
    expect(problems.some((p) => p.includes("event"))).toBe(true);
    expect(problems.some((p) => p.includes("gate"))).toBe(true);
  });

  test("text over MAX_TEXT chars is rejected", () => {
    const problems = lintNudge(validNudge({ text: "a".repeat(MAX_TEXT + 1) }));
    expect(problems.some((p) => p.includes(String(MAX_TEXT)))).toBe(true);
  });

  test("text at exactly MAX_TEXT chars is fine", () => {
    expect(lintNudge(validNudge({ text: "a".repeat(MAX_TEXT) }))).toEqual([]);
  });

  test("a Stop event is not a supported trigger", () => {
    const problems = lintNudge(validNudge({ event: "Stop", matcher: undefined }));
    expect(problems.some((p) => p.includes("unsupported event"))).toBe(true);
  });

  test("an unconditional gate on a high-frequency event with once_per always is rejected", () => {
    const problems = lintNudge(
      validNudge({ event: "PreToolUse", matcher: "Bash", gate: { always: true }, once_per: "always" }),
    );
    expect(problems.some((p) => p.includes("degenerate gate"))).toBe(true);
  });

  test("an unconditional gate is fine once_per session", () => {
    const problems = lintNudge(
      validNudge({ event: "PreToolUse", matcher: "Bash", gate: { always: true }, once_per: "session" }),
    );
    expect(problems).toEqual([]);
  });

  test("an unconditional gate is fine on a low-frequency event", () => {
    const problems = lintNudge(
      validNudge({ event: "SessionStart", matcher: undefined, gate: { always: true }, once_per: "always" }),
    );
    expect(problems).toEqual([]);
  });

  test("a nested-quantifier regex is rejected", () => {
    const problems = lintNudge(validNudge({ gate: { command_matches: "(a+)+$" } }));
    expect(problems.some((p) => p.includes("nested quantifier"))).toBe(true);
  });

  test("pattern must be a slug", () => {
    expect(lintNudge(validNudge({ pattern: "Not A Slug!" })).length).toBeGreaterThan(0);
  });

  test("not an object is rejected", () => {
    expect(lintNudge("nope")).toEqual(["nudge must be a JSON object"]);
    expect(lintNudge(null)).toEqual(["nudge must be a JSON object"]);
  });
});
