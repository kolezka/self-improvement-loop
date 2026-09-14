// The artifact-type decision: total, evidence-bound, and gate-executing.
// Covers INVARIANTS 4 (total), 5 (verbatim evidence), 6 (the gate is executed).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  emptyAnswer,
  loadPayloadCorpus,
  MIN_QUOTE_CHARS,
  MIN_QUOTE_WORDS,
  route,
  RouteAnswer,
  splitTrigger,
} from "@sil/curriculum";
import { fakeGateRunner, installFakeNudge, uninstallFakeNudge } from "./fixtures.ts";

const PAYLOADS = loadPayloadCorpus();

const SOURCES =
  "I went looking for a way to query the dependency graph and could not find one.\n" +
  "Then I claimed the fix was safe without running anything.\n";
const CONTEXT_QUOTE = "went looking for a way to query the dependency graph and could not find one";
const CAPABILITY_QUOTE = "claimed the fix was safe without running anything";
const WORKABLE_GATE = { command_matches: "git (commit|push)" };

const answer = (fields: Record<string, unknown> = {}): RouteAnswer => RouteAnswer.parse(fields);
const opts = { gateRunner: fakeGateRunner };

beforeEach(() => {
  installFakeNudge();
});
afterEach(() => {
  uninstallFakeNudge();
});

test("the recorded corpus is present", () => {
  // The gate rules below are only meaningful against real payloads.
  expect(PAYLOADS.length).toBeGreaterThanOrEqual(20);
});

describe("hook: the claim is executed, not read", () => {
  test("a workable gate routes to hook", () => {
    const result = route(answer({ trigger_event: "PreToolUse:Bash", gate: WORKABLE_GATE }), SOURCES, PAYLOADS, opts);
    expect(result.artifact_type).toBe("hook");
  });

  test("a gate that matches nothing in the corpus is not a hook", () => {
    const result = route(
      answer({ trigger_event: "PreToolUse:Bash", gate: { command_matches: "zzz-never-appears" } }),
      SOURCES,
      PAYLOADS,
      opts,
    );
    expect(result.artifact_type).not.toBe("hook");
    expect(result.reason).toContain("matched nothing");
  });

  test("a gate that fires on everything is a broadcast, not a hook", () => {
    // Once merged a hook runs unattended on every session of the machine. A gate
    // that cannot tell the corpus apart will not tell production apart either.
    const result = route(answer({ trigger_event: "PreToolUse:Bash", gate: { always: true } }), SOURCES, PAYLOADS, opts);
    expect(result.artifact_type).not.toBe("hook");
    expect(result.reason).toContain("broadcast");
  });

  test("a gate that raises is not a hook", () => {
    const result = route(answer({ trigger_event: "PreToolUse:Bash", gate: { tool_is: "Bash" } }), SOURCES, PAYLOADS, opts);
    expect(result.artifact_type).not.toBe("hook");
    expect(result.reason).toContain("gate");
  });

  test("an unsupported event is not a hook", () => {
    const result = route(answer({ trigger_event: "PreToolFly:Bash", gate: WORKABLE_GATE }), SOURCES, PAYLOADS, opts);
    expect(result.artifact_type).not.toBe("hook");
    expect(result.reason).toContain("unsupported");
  });

  test("an empty corpus cannot prove a hook", () => {
    const result = route(answer({ trigger_event: "PreToolUse:Bash", gate: WORKABLE_GATE }), SOURCES, [], opts);
    expect(result.artifact_type).not.toBe("hook");
  });

  test("a gate run that times out is refused, never treated as a clean non-match", () => {
    // try/catch cannot catch a hang; only the out-of-process deadline can. A
    // timeout reported as "matched nothing" would hide a pegged core.
    const result = route(answer({ trigger_event: "PreToolUse:Bash", gate: { command_matches: "(a+)+$" } }), SOURCES, PAYLOADS, {
      gateRunner: () => ({ results: [], error: null, timedOut: true }),
    });
    expect(result.artifact_type).not.toBe("hook");
    expect(result.reason).toContain("timed out");
  });

  test("a runner that answers for fewer payloads than it was given is refused", () => {
    const result = route(answer({ trigger_event: "PreToolUse:Bash", gate: WORKABLE_GATE }), SOURCES, PAYLOADS, {
      gateRunner: () => ({ results: [true], error: null, timedOut: false }),
    });
    expect(result.artifact_type).not.toBe("hook");
    expect(result.reason).toContain("answered for 1 of");
  });

  test("a runner that throws refuses the hook rather than crashing", () => {
    const result = route(answer({ trigger_event: "PreToolUse:Bash", gate: WORKABLE_GATE }), SOURCES, PAYLOADS, {
      gateRunner: () => {
        throw new Error("spawn failed");
      },
    });
    expect(result.artifact_type).toBe("rule");
  });

  test("a dispatcher with no corpus runner refuses the hook rather than crashing", () => {
    // Nothing can be proven without a runner, so the claim is not granted.
    installFakeNudge({ runGateCorpus: undefined });
    const result = route(answer({ trigger_event: "PreToolUse:Bash", gate: WORKABLE_GATE }), SOURCES, PAYLOADS);
    expect(result.artifact_type).toBe("rule");
    expect(result.reason).toContain("no gate runner");
  });
});

describe("against the real out-of-process runner", () => {
  // The fake runner cannot prove INVARIANT 6: only the real one spawns a
  // process and kills it on a deadline. These two run the shipped
  // `runGateCorpus`, so a regression in the wiring between the packages shows
  // up here and nowhere else.
  // Measured on this machine: a benign corpus run answers in ~7ms, so 600ms is
  // ~85x headroom for the control and the backtracking corpus below is ~16s of
  // work. Both margins are wide enough that neither result is a timing race.
  const realOpts = { timeoutMs: 600 };

  test("a benign gate is evaluated per payload", () => {
    uninstallFakeNudge();
    const result = route(answer({ trigger_event: "PreToolUse:Bash", gate: WORKABLE_GATE }), SOURCES, PAYLOADS, realOpts);
    // The positive control. Without it a timeout below would equally be
    // explained by a runner that never starts at all.
    expect(result.artifact_type).toBe("hook");
  });

  test("a catastrophically backtracking gate is killed and refused", () => {
    uninstallFakeNudge();
    const evil = "a".repeat(40) + "!";
    const payloads = Array.from({ length: 40 }, () => ({
      session_id: "f",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: evil },
    }));
    const result = route(
      answer({ trigger_event: "PreToolUse:Bash", gate: { command_matches: "(a+)+$" } }),
      SOURCES,
      payloads,
      realOpts,
    );
    expect(result.artifact_type).not.toBe("hook");
    expect(result.reason).toContain("timed out");
  });
});

describe("evidence has to be verbatim", () => {
  test("a quoted own-context need routes to agent", () => {
    const result = route(answer({ needs_own_context: true, context_evidence: CONTEXT_QUOTE }), SOURCES, PAYLOADS, opts);
    expect(result.artifact_type).toBe("agent");
  });

  test("an unevidenced boolean does not buy an agent", () => {
    const result = route(answer({ needs_own_context: true }), SOURCES, PAYLOADS, opts);
    expect(result.artifact_type).toBe("rule");
    expect(result.reason).toContain("unevidenced");
  });

  test("a fabricated own-context quote does not buy an agent", () => {
    const result = route(
      answer({ needs_own_context: true, context_evidence: "this obviously needs its own budget" }),
      SOURCES,
      PAYLOADS,
      opts,
    );
    expect(result.artifact_type).toBe("rule");
    expect(result.reason).toContain("context_evidence is not verbatim");
  });

  test("quoted capability evidence routes to skill", () => {
    expect(route(answer({ capability_evidence: CAPABILITY_QUOTE }), SOURCES, PAYLOADS, opts).artifact_type).toBe("skill");
  });

  test("unquotable capability evidence downgrades to rule", () => {
    const result = route(answer({ capability_evidence: "the agent wanted this badly" }), SOURCES, PAYLOADS, opts);
    expect(result.artifact_type).toBe("rule");
    expect(result.reason).toContain("verbatim");
  });

  test("a rewrapped quote still counts", () => {
    // The drafter re-wraps what it copied, so the compare is whitespace
    // insensitive and nothing else.
    const rewrapped = CAPABILITY_QUOTE.replace(" safe ", "\n   safe\n");
    expect(route(answer({ capability_evidence: rewrapped }), SOURCES, PAYLOADS, opts).artifact_type).toBe("skill");
  });

  test("a discipline with no evidence falls through to rule", () => {
    expect(route(emptyAnswer(), SOURCES, PAYLOADS, opts).artifact_type).toBe("rule");
  });
});

describe("and substantive: a quote has to be long enough to be one", () => {
  const tinies = ["a", ".", "the", "for a way"];

  test("a tiny quote does not buy a skill", () => {
    for (const tiny of tinies) {
      // Every one of these is a substring of almost any English text, so the
      // bare containment test made the evidence requirement satisfiable by
      // typing one character.
      expect(SOURCES).toContain(tiny);
      const result = route(answer({ capability_evidence: tiny }), SOURCES, PAYLOADS, opts);
      expect(result.artifact_type).toBe("rule");
      expect(result.reason).toContain(String(MIN_QUOTE_WORDS));
      expect(result.reason).toContain(String(MIN_QUOTE_CHARS));
    }
  });

  test("a tiny quote does not buy an agent", () => {
    for (const tiny of tinies) {
      const result = route(answer({ needs_own_context: true, context_evidence: tiny }), SOURCES, PAYLOADS, opts);
      expect(result.artifact_type).toBe("rule");
      expect(result.reason).toContain(String(MIN_QUOTE_WORDS));
      expect(result.reason).toContain(String(MIN_QUOTE_CHARS));
    }
  });

  const UNSAFE_SOURCES = "I called the change unsafe without running anything at all, then shipped it.\n";
  const INSIDE_A_WORD = "safe without running anything at all";

  test("a quote that only matches inside a longer word is not verbatim", () => {
    // "safe" sits inside "unsafe", so a raw substring test reports a quote the
    // source never contains, with the meaning inverted.
    expect(UNSAFE_SOURCES).toContain(INSIDE_A_WORD);
    expect(INSIDE_A_WORD.length).toBeGreaterThanOrEqual(MIN_QUOTE_CHARS);
    expect(INSIDE_A_WORD.split(" ").length).toBeGreaterThanOrEqual(MIN_QUOTE_WORDS);
    for (const field of ["capability_evidence", "context_evidence"]) {
      const result = route(
        answer({ needs_own_context: field === "context_evidence", [field]: INSIDE_A_WORD }),
        UNSAFE_SOURCES,
        PAYLOADS,
        opts,
      );
      expect(result.artifact_type).toBe("rule");
      expect(result.reason).toContain("word boundaries");
    }
  });

  test("a word-aligned quote still earns its type", () => {
    const quote = "unsafe without running anything at all";
    for (const [field, expected] of [
      ["capability_evidence", "skill"],
      ["context_evidence", "agent"],
    ] as const) {
      const result = route(
        answer({ needs_own_context: field === "context_evidence", [field]: quote }),
        UNSAFE_SOURCES,
        PAYLOADS,
        opts,
      );
      expect(result.artifact_type).toBe(expected);
    }
  });
});

describe("precedence: the order the checks run in is the contract", () => {
  test("a parse error outranks an explicit decline", () => {
    const result = route(answer({ parse_error: "reply is not a JSON object", no_artifact: true }), SOURCES, PAYLOADS, opts);
    expect(result.artifact_type).toBe("none");
    expect(result.reason).toContain("unreadable");
  });

  test("a decline outranks an otherwise workable gate", () => {
    const result = route(
      answer({ no_artifact: true, trigger_event: "PreToolUse:Bash", gate: WORKABLE_GATE }),
      SOURCES,
      PAYLOADS,
      opts,
    );
    expect(result.artifact_type).toBe("none");
    expect(result.reason).toContain("declined");
  });

  test("a workable gate outranks a fully evidenced agent", () => {
    const result = route(
      answer({
        trigger_event: "PreToolUse:Bash",
        gate: WORKABLE_GATE,
        needs_own_context: true,
        context_evidence: CONTEXT_QUOTE,
      }),
      SOURCES,
      PAYLOADS,
      opts,
    );
    expect(result.artifact_type).toBe("hook");
  });

  test("a quoted own-context need outranks quoted capability evidence", () => {
    const result = route(
      answer({ needs_own_context: true, context_evidence: CONTEXT_QUOTE, capability_evidence: CAPABILITY_QUOTE }),
      SOURCES,
      PAYLOADS,
      opts,
    );
    expect(result.artifact_type).toBe("agent");
  });

  test("an unevidenced need costs the skill it would have earned", () => {
    // The sharp edge of the ordering: the needs_own_context branch returns, so a
    // perfectly good capability quote in the same answer is never read.
    const result = route(answer({ needs_own_context: true, capability_evidence: CAPABILITY_QUOTE }), SOURCES, PAYLOADS, opts);
    expect(result.artifact_type).toBe("rule");
    expect(result.reason).toContain("unevidenced");
  });
});

describe("totality", () => {
  test("route never throws", () => {
    const cases: [RouteAnswer, unknown, unknown][] = [
      [answer({ trigger_event: "PreToolUse:Bash", gate: { all: "not a list" } }), "", []],
      [emptyAnswer(), null, PAYLOADS],
      [answer({ trigger_event: "PreToolUse:Bash", gate: WORKABLE_GATE }), SOURCES, 42],
      [answer({ trigger_event: "", gate: {} }), SOURCES, PAYLOADS],
    ];
    for (const [a, sources, payloads] of cases) {
      const result = route(a, sources, payloads, opts);
      expect(["skill", "hook", "rule", "agent", "none"]).toContain(result.artifact_type);
    }
  });

  test("splitTrigger rejects a matcher on an event that takes none", () => {
    expect(splitTrigger("PreToolUse:Bash")).toEqual(["PreToolUse", "Bash"]);
    expect(splitTrigger("PreToolUse")).toEqual(["PreToolUse", null]);
    expect(splitTrigger("Stop:Bash")).toBeNull();
    expect(splitTrigger("PreToolUse:Telepathy")).toBeNull();
    expect(splitTrigger("Nope")).toBeNull();
  });
});

describe("the payload corpus", () => {
  test("the plugin's own corpus is always available", () => {
    const fixtures = join(import.meta.dir, "..", "..", "..", "tests", "fixtures", "hook-payloads");
    expect(PAYLOADS.length).toBe(readdirSync(fixtures).filter((n) => n.endsWith(".json")).length);
    expect(PAYLOADS.every((p) => typeof p === "object" && p !== null)).toBe(true);
  });
});
