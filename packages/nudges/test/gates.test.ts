import { describe, expect, test } from "bun:test";
import { evaluate, gateTruth, hasNestedQuantifier, splitTrigger, validateGate } from "../src/gates.ts";

describe("splitTrigger", () => {
  test("event only", () => {
    expect(splitTrigger("SessionStart")).toEqual(["SessionStart", null]);
  });

  test("event with allowed matcher", () => {
    expect(splitTrigger("PreToolUse:Bash")).toEqual(["PreToolUse", "Bash"]);
  });

  test("every tool hooks.json delivers is a matcher", () => {
    // hooks.json registers PreToolUse and PostToolUse with matcher "*". A
    // drafted `PreToolUse:ToolSearch` was refused as unsupported and the
    // pattern downgraded to a rule while the tool call reached the hook fine.
    for (const tool of ["ToolSearch", "WebFetch", "WebSearch", "NotebookEdit"]) {
      expect(splitTrigger(`PreToolUse:${tool}`)).toEqual(["PreToolUse", tool]);
      expect(splitTrigger(`PostToolUse:${tool}`)).toEqual(["PostToolUse", tool]);
    }
  });

  test("unknown event", () => {
    expect(splitTrigger("NotAnEvent")).toBeNull();
  });

  test("Stop is not a supported trigger event", () => {
    expect(splitTrigger("Stop")).toBeNull();
  });

  test("matcher not allowed for this event", () => {
    expect(splitTrigger("SessionStart:Bash")).toBeNull();
  });

  test("matcher not in the allowed set for PreToolUse", () => {
    expect(splitTrigger("PreToolUse:NotATool")).toBeNull();
  });
});

describe("evaluate", () => {
  test("always is true for any payload", () => {
    expect(evaluate({ always: true }, {})).toBe(true);
  });

  test("tool_is matches tool_name", () => {
    expect(evaluate({ tool_is: ["Bash", "Edit"] }, { tool_name: "Bash" })).toBe(true);
    expect(evaluate({ tool_is: ["Bash"] }, { tool_name: "Edit" })).toBe(false);
  });

  test("command_matches searches tool_input.command", () => {
    const payload = { tool_input: { command: "git commit -m wip" } };
    expect(evaluate({ command_matches: "git commit" }, payload)).toBe(true);
    expect(evaluate({ command_matches: "git push" }, payload)).toBe(false);
  });

  test("file_path_matches globs tool_input.file_path", () => {
    expect(evaluate({ file_path_matches: "*.ts" }, { tool_input: { file_path: "foo.ts" } })).toBe(true);
    expect(evaluate({ file_path_matches: "*.ts" }, { tool_input: { file_path: "foo.py" } })).toBe(false);
    expect(evaluate({ file_path_matches: "*.ts" }, {})).toBe(false);
  });

  test("prompt_matches searches the prompt field", () => {
    expect(evaluate({ prompt_matches: "commit" }, { prompt: "please commit this" })).toBe(true);
  });

  test("all requires every child true", () => {
    const gate = { all: [{ always: true }, { tool_is: ["Bash"] }] };
    expect(evaluate(gate, { tool_name: "Bash" })).toBe(true);
    expect(evaluate(gate, { tool_name: "Edit" })).toBe(false);
  });

  test("any requires one child true", () => {
    const gate = { any: [{ tool_is: ["Bash"] }, { tool_is: ["Edit"] }] };
    expect(evaluate(gate, { tool_name: "Edit" })).toBe(true);
    expect(evaluate(gate, { tool_name: "Read" })).toBe(false);
  });

  test("not inverts the child", () => {
    expect(evaluate({ not: { always: true } }, {})).toBe(false);
  });

  test("malformed gate is false, never throws", () => {
    expect(evaluate(null, {})).toBe(false);
    expect(evaluate({}, {})).toBe(false);
    expect(evaluate({ a: 1, b: 2 }, {})).toBe(false);
    expect(evaluate({ unknown_predicate: true }, {})).toBe(false);
  });

  test("bad regex is false, never throws", () => {
    expect(evaluate({ command_matches: "(" }, { tool_input: { command: "x" } })).toBe(false);
  });

  test("regex match is capped to MAX_MATCH_LEN of the subject", () => {
    // A pattern anchored at the very end only matches if the whole
    // (uncapped) subject were scanned; capping the subject makes this false.
    const longCommand = "a".repeat(5000) + "TAIL";
    expect(evaluate({ command_matches: "TAIL$" }, { tool_input: { command: longCommand } })).toBe(false);
  });
});

describe("hasNestedQuantifier", () => {
  test("flags classic catastrophic shapes", () => {
    expect(hasNestedQuantifier("(a+)+")).toBe(true);
    expect(hasNestedQuantifier("(.*)*")).toBe(true);
    expect(hasNestedQuantifier("(\\w+\\s?)+")).toBe(true);
  });

  test("does not flag ordinary patterns", () => {
    expect(hasNestedQuantifier("git (commit|push)")).toBe(false);
    expect(hasNestedQuantifier("^rm -rf")).toBe(false);
  });
});

describe("validateGate", () => {
  test("clean gate has no problems", () => {
    expect(validateGate({ tool_is: ["Bash"] })).toEqual([]);
  });

  test("rejects a catastrophically backtracking regex", () => {
    const problems = validateGate({ command_matches: "(a+)+$" });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes("backtrack catastrophically"))).toBe(true);
  });

  test("rejects unknown predicate", () => {
    expect(validateGate({ nope: true })).not.toEqual([]);
  });

  test("recurses into all/any/not", () => {
    const problems = validateGate({ all: [{ command_matches: "(a+)+" }] });
    expect(problems.some((p) => p.includes("backtrack catastrophically"))).toBe(true);
  });
});

describe("gateTruth", () => {
  test("always is statically true", () => {
    expect(gateTruth({ always: true })).toBe(true);
  });

  test("empty tool_is list is statically false", () => {
    expect(gateTruth({ tool_is: [] })).toBe(false);
  });

  test("normal predicate is payload-dependent (null)", () => {
    expect(gateTruth({ tool_is: ["Bash"] })).toBeNull();
  });

  test("all of only-true children is true", () => {
    expect(gateTruth({ all: [{ always: true }, { always: true }] })).toBe(true);
  });

  test("all with one false child is false", () => {
    expect(gateTruth({ all: [{ always: true }, { tool_is: [] }] })).toBe(false);
  });
});

describe("file_path_matches glob", () => {
  const glob = (pattern: string, path: string): boolean =>
    evaluate({ file_path_matches: pattern }, { tool_input: { file_path: path } });

  // Every answer the RegExp translation gave, so replacing it with the
  // two-pointer matcher is a pure performance change for the shapes nudges
  // actually use.
  const AGREEMENT: [string, string, boolean][] = [
    ["*.ts", "foo.ts", true],
    ["*.ts", "x.md", false],
    ["/a/*/c.ts", "/a/b/c.ts", true],
    ["/a/*/c.ts", "/a/b/d.ts", false],
    ["*c?ts", "abc.ts", true],
    ["*c?ts", "abcXts", true],
    ["*c?ts", "abcts", false],
    ["/a/b", "/a/b", true],
    ["/a/b", "/a/bc", false],
    ["/a/**", "/a/b/c.ts", true],
    ["/a/**", "/b/c.ts", false],
    ["[ab]*.ts", "b1.ts", true],
    ["[ab]*.ts", "c1.ts", false],
    ["[!ab]*.ts", "c1.ts", true],
    ["[!ab]*.ts", "a1.ts", false],
    ["[^ab]*.ts", "c1.ts", true],
    ["[a-c]1.ts", "b1.ts", true],
    ["[a-c]1.ts", "d1.ts", false],
  ];
  for (const [pattern, path, want] of AGREEMENT) {
    test(`${JSON.stringify(pattern)} vs ${JSON.stringify(path)} is ${want}`, () => {
      expect(glob(pattern, path)).toBe(want);
    });
  }

  test("a ] in first position is a literal ], as fnmatch has it", () => {
    // The RegExp translation emitted "[]]", which JS reads as an empty class
    // followed by a literal ], so this never matched anything.
    expect(glob("[]]x", "]x")).toBe(true);
    expect(glob("[]]x", "ax")).toBe(false);
  });

  test("an unterminated class is a literal [", () => {
    expect(glob("[abc", "[abc")).toBe(true);
  });

  test("a ten star glob on a long path returns in under 5 ms", () => {
    // Every `*` became `.*` with no atomic group to stop the engine
    // re-splitting the path across the stars, so this exact input ran for
    // minutes instead of failing fast.
    const path = "a".repeat(200);
    const started = performance.now();
    expect(glob("*a*a*a*a*a*a*a*a*a*b", path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(5);
  });

  test("file_path_matches is capped to MAX_MATCH_LEN, like the regex predicates", () => {
    // One 5000 char subject, three predicates, each given a pattern that can
    // only match the whole uncapped 5000 characters. All three must be false:
    // file_path_matches used to be the one that bypassed the cap.
    const subject = "a".repeat(5000);
    const payload = { tool_input: { command: subject, file_path: subject }, prompt: subject };
    expect(evaluate({ command_matches: "^a{5000}$" }, payload)).toBe(false);
    expect(evaluate({ prompt_matches: "^a{5000}$" }, payload)).toBe(false);
    expect(evaluate({ file_path_matches: "?".repeat(5000) }, payload)).toBe(false);
  });
});

describe("splitTrigger rejects Object.prototype keys", () => {
  // `event in EVENTS` walked the prototype chain, so these passed lint and
  // then handed a function to the matcher check.
  for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
    test(`${key} is not an event`, () => {
      expect(splitTrigger(key)).toBeNull();
      expect(splitTrigger(`${key}:Bash`)).toBeNull();
    });
  }
});

describe("isUnsafeRegex", () => {
  const REJECTED: [string, string][] = [
    ["(a+)+", "nested quantifier"],
    ["(.*)*", "nested quantifier"],
    ["(\\w+\\s?)+", "nested quantifier"],
    ["(a|aa)+$", "alternation inside a quantified group"],
    ["(a|aa)+", "alternation inside a quantified group, unanchored"],
    ["(\\w*\\s*)*", "two stars inside a starred group"],
    ["(.+)+\\d", "nested quantifier before a literal"],
    ["(a?b)+", "optional inside a quantified group"],
    ["x".repeat(250), "over the 200 char pattern cap"],
    ["(a)+(b)+(c)+(d)+", "more than three quantified groups"],
  ];
  for (const [pattern, why] of REJECTED) {
    test(`rejects ${why}`, () => {
      expect(hasNestedQuantifier(pattern)).toBe(true);
    });
  }

  const ACCEPTED = ["^(git|hg) (push|commit)", "rm -rf", "\\.(ts|js)$", "git (commit|push)", "^rm -rf", "(a)+(b)+(c)+"];
  for (const pattern of ACCEPTED) {
    test(`accepts ${JSON.stringify(pattern)}`, () => {
      expect(hasNestedQuantifier(pattern)).toBe(false);
    });
  }

  test("an escaped paren is not a group", () => {
    expect(hasNestedQuantifier("\\(a|b\\)+")).toBe(false);
  });

  test("isUnsafeRegex is the current name and hasNestedQuantifier its alias", async () => {
    const mod = await import("../src/gates.ts");
    expect(typeof mod.isUnsafeRegex).toBe("function");
    expect(mod.hasNestedQuantifier).toBe(mod.isUnsafeRegex);
  });

  test("validateGate refuses every rejected pattern", () => {
    for (const [pattern] of REJECTED) {
      expect(validateGate({ command_matches: pattern }).length).toBeGreaterThan(0);
      expect(validateGate({ prompt_matches: pattern }).length).toBeGreaterThan(0);
    }
    for (const pattern of ACCEPTED) {
      expect(validateGate({ command_matches: pattern })).toEqual([]);
    }
  });
});
