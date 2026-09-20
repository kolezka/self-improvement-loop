// The typed judge (System One): judgeQuestions' state and question shape, and
// verdictFromNouls' pass/reject logic, including its missing-rule and
// boundary behavior.

import { describe, expect, test } from "bun:test";
import { boundedSources, JUDGE_RULES, judgeQuestions, verdictFromNouls } from "../src/prompts.ts";

const JUDGE_RULE_IDS = JUDGE_RULES.map(([id]) => id);

describe("judgeQuestions", () => {
  test("the state carries the pattern, artifact type, body and the bounded sources", () => {
    const lessons = ["lesson one", "lesson two"];
    const { state } = judgeQuestions("my-pattern", "hook", "ARTIFACT BODY", lessons);
    expect(state).toContain("my-pattern");
    expect(state).toContain("hook");
    expect(state).toContain("ARTIFACT BODY");
    expect(state).toContain(boundedSources(lessons));
  });

  test("the questions map has exactly the five JUDGE_RULES ids", () => {
    const { questions } = judgeQuestions("p", "rule", "body", ["a lesson"]);
    expect(Object.keys(questions).sort()).toEqual([...JUDGE_RULE_IDS].sort());
  });

  test("each question is {instructions} with no type key", () => {
    const { questions } = judgeQuestions("p", "rule", "body", ["a lesson"]);
    for (const [id, instructions] of JUDGE_RULES) {
      expect(questions[id]).toEqual({ instructions });
      expect(Object.keys(questions[id]!)).toEqual(["instructions"]);
    }
  });
});

describe("verdictFromNouls", () => {
  // Every rule below the 0.5 threshold; unsafe is the worst at 0.30.
  const low = { contradicts: 0.1, vague: 0.2, unsupported: 0.05, unsafe: 0.3, unrelated: 0.15 };

  test("all probabilities below the threshold pass, naming the worst rule and its probability", () => {
    const [passed, reason] = verdictFromNouls(low, 0.5);
    expect(passed).toBe(true);
    expect(reason).toBe("accepted (worst unsafe p=0.30, threshold 0.50)");
  });

  test("one probability at or above the threshold rejects, naming that rule and the threshold", () => {
    const answers = { ...low, unsafe: 0.6 };
    const [passed, reason] = verdictFromNouls(answers, 0.5);
    expect(passed).toBe(false);
    expect(reason).toBe("unsafe p=0.60, threshold 0.50");
  });

  test("exactly at the threshold rejects", () => {
    const answers = { ...low, unsafe: 0.5 };
    const [passed, reason] = verdictFromNouls(answers, 0.5);
    expect(passed).toBe(false);
    expect(reason).toBe("unsafe p=0.50, threshold 0.50");
  });

  test("a missing rule id rejects with a no-verdict reason naming the missing ids, never passes", () => {
    const answers = { contradicts: 0.1, vague: 0.1 };
    const [passed, reason] = verdictFromNouls(answers, 0.5);
    expect(passed).toBe(false);
    expect(reason).toBe("no verdict: judge answered no probability for unsupported, unsafe, unrelated");
  });

  test("a single missing rule id still rejects rather than falling back to the rest", () => {
    const answers = { contradicts: 0.01, vague: 0.01, unsupported: 0.01, unsafe: 0.01 };
    const [passed, reason] = verdictFromNouls(answers, 0.5);
    expect(passed).toBe(false);
    expect(reason).toBe("no verdict: judge answered no probability for unrelated");
  });

  test("the rule named in the reason is the highest probability one when several are high", () => {
    const answers = { contradicts: 0.6, vague: 0.3, unsupported: 0.2, unsafe: 0.9, unrelated: 0.1 };
    const [passed, reason] = verdictFromNouls(answers, 0.5);
    expect(passed).toBe(false);
    expect(reason).toBe("unsafe p=0.90, threshold 0.50");
  });
});
