// The typed judge (System One): judgeQuestions' state and question shape, and
// verdictFromNouls' pass/reject logic, including its missing-rule and
// boundary behavior.

import { describe, expect, test } from "bun:test";
import { boundedSources, draftMessages, JUDGE_RULES, judgeQuestions, parseDraft, verdictFromNouls } from "../src/prompts.ts";

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

describe("forced drafting with wantRouteAnswer", () => {
  test("without wantRouteAnswer, the prompt is unchanged", () => {
    const plain = draftMessages("p", ["a lesson"], null, "rule").at(-1)!.content;
    expect(plain).toContain('Reply with a JSON object holding exactly one key, "artifact".');
    expect(plain).not.toContain("trigger_event");
    expect(plain).not.toContain("for a human reviewer only");
  });

  test("wantRouteAnswer asks for the routing keys alongside artifact, not instead of it, and never touches the artifact shape instructions", () => {
    const plain = draftMessages("p", ["a lesson"], null, "rule").at(-1)!.content;
    const asked = draftMessages("p", ["a lesson"], null, "rule", { wantRouteAnswer: true }).at(-1)!.content;
    const markEnd = "do not include secrets or tokens.";
    // The shape block, from "value is" through the no-commentary line, is
    // byte-identical on both sides: wantRouteAnswer never changes what
    // "artifact" is told to contain. Everything after "Lessons to
    // generalise:" is byte-identical too.
    const shapeBlock = plain.slice(plain.indexOf("value is"), plain.indexOf(markEnd) + markEnd.length);
    const suffix = plain.slice(plain.indexOf("Lessons to generalise:"));
    expect(asked).toContain(shapeBlock);
    expect(asked.endsWith(suffix)).toBe(true);

    // The reply-line sentence has to change along with the ask: it used to
    // keep saying "exactly one key" even once the routing fields were
    // appended right after it, so a model obeying that sentence literally
    // omitted them and a re-route could never fire.
    expect(asked).toContain('Reply with a JSON object holding "artifact" plus the routing keys listed below.');
    expect(asked).not.toContain("exactly one key");
    expect(asked).not.toContain("for a human reviewer only");
    expect(asked).toContain("trigger_event");
    expect(asked).toContain("capability_evidence");
    expect(plain).not.toContain("trigger_event");
  });

  test("without wantRouteAnswer, parseDraft keeps returning the empty answer on the forced path", () => {
    const raw = JSON.stringify({ artifact: "- a bullet", trigger_event: "PreToolUse:Bash", gate: { always: true } });
    const [body, answer] = parseDraft(raw, { forcedType: "rule" });
    expect(body).toBe("- a bullet");
    expect(answer.trigger_event).toBe("none");
    expect(answer.gate).toBeNull();
  });

  test("keepRouteAnswer reads the routing fields the forced prompt asked for, body unaffected", () => {
    const raw = JSON.stringify({
      artifact: "- a bullet",
      trigger_event: "PreToolUse:Bash",
      gate: { always: true },
      needs_own_context: false,
      context_evidence: null,
      capability_evidence: null,
      no_artifact: false,
    });
    const [body, answer] = parseDraft(raw, { forcedType: "rule", keepRouteAnswer: true });
    expect(body).toBe("- a bullet");
    expect(answer.trigger_event).toBe("PreToolUse:Bash");
    expect(answer.gate).toEqual({ always: true });
  });

  test("keepRouteAnswer falls back to the empty answer on a reply that fails validation, body still used", () => {
    const raw = JSON.stringify({ artifact: "- a bullet", gate: "not an object" });
    const [body, answer] = parseDraft(raw, { forcedType: "rule", keepRouteAnswer: true });
    expect(body).toBe("- a bullet");
    expect(answer.trigger_event).toBe("none");
    expect(answer.gate).toBeNull();
    expect(answer.parse_error).toBe("");
  });
});
