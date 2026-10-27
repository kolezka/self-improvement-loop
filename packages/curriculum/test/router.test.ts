// The artifact-type decision: total, evidence-bound, and gate-executing.
// Covers INVARIANTS 4 (total), 5 (verbatim evidence), 6 (the gate is executed).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { appendRecord } from "@sil/statedb";
import {
  emptyAnswer,
  loadPayloadCorpus,
  MIN_QUOTE_CHARS,
  MIN_QUOTE_WORDS,
  parseDraft,
  route,
  RouteAnswer,
  splitTrigger,
} from "@sil/curriculum";
import { cleanupEnv, fakeGateRunner, installFakeNudge, makeWorld, silEnv, type TestEnv, uninstallFakeNudge } from "./fixtures.ts";
import { draftedType } from "../src/run.ts";

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
    expect(result.reason).toContain('"command_matches":"zzz-never-appears"');
  });

  test("a rejected gate is shown without flooding the route reason", () => {
    const result = route(
      answer({ trigger_event: "PreToolUse:Bash", gate: { command_matches: "z".repeat(195) } }),
      SOURCES,
      PAYLOADS,
      opts,
    );
    expect(result.reason).toContain('"command_matches":"zzzz');
    expect(result.reason).toContain("...");
    expect(result.reason.length).toBeLessThan(400);
  });

  test("the gate excerpt never cuts a character in half", () => {
    // `{"command_matches":"` is 20 code units, so 139 more puts the emoji on 159 and 160.
    const result = route(
      answer({ trigger_event: "PreToolUse:Bash", gate: { command_matches: `${"z".repeat(139)}\u{1F600}${"z".repeat(40)}` } }),
      SOURCES,
      PAYLOADS,
      opts,
    );
    expect(result.reason).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  test("a gate that fires on everything is a broadcast when its matcher's tool dominates the corpus", () => {
    // Once merged a hook runs unattended on every session of the machine. A
    // gate that cannot tell a Bash-heavy session apart will not tell
    // production apart either. Broadcast is judged by how often the
    // trigger's own matcher is actually called, not by how often `always`
    // matches literally everything regardless of matcher: see the small-share
    // MCP case below, where the same gate is NOT a broadcast.
    const bash = (i: number) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `cmd ${i}` } });
    const read = (i: number) => ({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: `/f${i}` } });
    const corpus = [...Array.from({ length: 8 }, (_, i) => bash(i)), ...Array.from({ length: 2 }, (_, i) => read(i))];
    const result = route(answer({ trigger_event: "PreToolUse:Bash", gate: { always: true } }), SOURCES, corpus, opts);
    expect(result.artifact_type).not.toBe("hook");
    expect(result.reason).toContain("broadcast");
    expect(result.reason).toContain("8 of 10");
  });

  test("a gate that never fires on the trigger's own tool is refused, not routed on an off-target hit", () => {
    // The reported defect: hookVerdict ran the gate over the whole corpus
    // with no notion of the trigger, so trigger
    // PreToolUse:mcp__outline__update_document + gate {tool_is:["Bash"]}
    // "matched" the corpus's unrelated Bash call and routed to hook, though
    // dispatchWith never runs this gate against that Bash call at all: the
    // matcher restricts it to the MCP tool alone.
    uninstallFakeNudge();
    const corpus = [
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } },
      { hook_event_name: "PreToolUse", tool_name: "mcp__outline__update_document", tool_input: {} },
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/f" } },
    ];
    const result = route(
      answer({ trigger_event: "PreToolUse:mcp__outline__update_document", gate: { tool_is: ["Bash"] } }),
      SOURCES,
      corpus,
      opts,
    );
    expect(result.artifact_type).not.toBe("hook");
    expect(result.reason).toContain("matched nothing");
    expect(result.reason).toContain("mcp__outline__update_document");
  });

  test("always with an exact MCP matcher routes to hook when that tool is a small share of the corpus", () => {
    // The reported defect's mirror image: a gate that only ever fires for
    // one already-narrow MCP tool was refused as a broadcast because the old
    // ratio was computed against how often `always` matches the whole
    // corpus, not how often this tool is actually called.
    uninstallFakeNudge();
    const bash = (i: number) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `cmd ${i}` } });
    const mcpCall = { hook_event_name: "PreToolUse", tool_name: "mcp__outline__update_document", tool_input: {} };
    const corpus = [...Array.from({ length: 18 }, (_, i) => bash(i)), mcpCall, mcpCall];
    const result = route(
      answer({ trigger_event: "PreToolUse:mcp__outline__update_document", gate: { always: true } }),
      SOURCES,
      corpus,
      opts,
    );
    expect(result.artifact_type).toBe("hook");
    expect(result.reason).toContain("2 of 20");
  });

  test("a PostToolUse hook is tested against the PreToolUse samples of the same calls", () => {
    // The hook samples only PreToolUse. Every sampled call also reaches PostToolUse.
    uninstallFakeNudge();
    const bash = (i: number) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `cmd ${i}` } });
    const mcpCall = { hook_event_name: "PreToolUse", tool_name: "mcp__outline__update_document", tool_input: {} };
    const corpus = [...Array.from({ length: 18 }, (_, i) => bash(i)), mcpCall, mcpCall];
    const result = route(
      answer({ trigger_event: "PostToolUse:mcp__outline__update_document", gate: { always: true } }),
      SOURCES,
      corpus,
      opts,
    );
    expect(result.artifact_type).toBe("hook");
    expect(result.reason).toContain("2 of 20");
  });

  test("a gate that fires on more than half of a recorded corpus is a broadcast too", () => {
    // With two thousand recorded tool calls in the corpus nothing but `always`
    // matches every one, so "fires on everything" alone would let a gate on
    // most Bash calls through as narrow.
    const bash = (i: number) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `cmd ${i}` } });
    const edit = (i: number) => ({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: `/f${i}` } });
    const wide = [...Array.from({ length: 6 }, (_, i) => bash(i)), ...Array.from({ length: 4 }, (_, i) => edit(i))];
    const narrow = [...Array.from({ length: 4 }, (_, i) => bash(i)), ...Array.from({ length: 6 }, (_, i) => edit(i))];
    const gate = answer({ trigger_event: "PreToolUse:Bash", gate: { tool_is: ["Bash"] } });

    const refused = route(gate, SOURCES, wide, opts);
    expect(refused.artifact_type).not.toBe("hook");
    expect(refused.reason).toContain("6 of 10");
    expect(refused.reason).toContain("broadcast");

    const accepted = route(gate, SOURCES, narrow, opts);
    expect(accepted.artifact_type).toBe("hook");
    expect(accepted.reason).toContain("4 of 10");
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

  test("an MCP-matcher trigger is accepted and evaluated by the real out-of-process runner", () => {
    // Live curriculum reason, verbatim: "no workable gate (unsupported
    // event/matcher \"PreToolUse:mcp__outline__update_document\")". Proves the
    // real gates.ts/gate-runner.ts wiring, not just the fake runner's.
    uninstallFakeNudge();
    const payloads = [
      ...PAYLOADS,
      { session_id: "f", hook_event_name: "PreToolUse", tool_name: "mcp__outline__update_document", tool_input: {} },
    ];
    const result = route(
      answer({ trigger_event: "PreToolUse:mcp__outline__update_document", gate: { tool_is: ["mcp__outline__update_document"] } }),
      SOURCES,
      payloads,
      realOpts,
    );
    expect(result.artifact_type).toBe("hook");
  });
});

describe("MCP tool matchers end to end: route() to hook, dispatch fires it", () => {
  // The reported cause: TOOL_MATCHERS was a closed list of built-in tools, so
  // the drafter's trigger_event never routed past "no workable gate
  // (unsupported event/matcher ...)" even though hooks.json's matcher "*"
  // already delivered the MCP call to the dispatcher. This exercises the real
  // @sil/nudges adapter (not the fixtures' fake one) through both halves: the
  // curriculum router's hook verdict, and dispatch-core's actual fire.
  const MCP_MATCHER = "mcp__outline__update_document";
  const MCP_TRIGGER = `PreToolUse:${MCP_MATCHER}`;
  const MCP_GATE = { tool_is: [MCP_MATCHER] };

  test("a narrow MCP gate with MCP payloads in the corpus routes to hook, and the dispatcher fires it", async () => {
    uninstallFakeNudge();
    const corpus = [
      ...PAYLOADS,
      { session_id: "s1", hook_event_name: "PreToolUse", tool_name: MCP_MATCHER, tool_input: {} },
      { session_id: "s2", hook_event_name: "PreToolUse", tool_name: "mcp__outline__fetch", tool_input: {} },
    ];
    const result = route(answer({ trigger_event: MCP_TRIGGER, gate: MCP_GATE }), SOURCES, corpus, { gateRunner: fakeGateRunner });
    expect(result.artifact_type).toBe("hook");

    const { dispatchWith } = await import("@sil/nudges/dispatch-core");
    const drafted = {
      pattern: "outline-update-caution",
      event: "PreToolUse",
      matcher: MCP_MATCHER,
      gate: MCP_GATE,
      once_per: "always" as const,
      text: "Double check the collection before overwriting the document.",
    };
    const fires: Array<Record<string, unknown>> = [];
    const sink = {
      claimMarker: () => true,
      fire: (record: Record<string, unknown>) => fires.push(record),
      breadcrumb: () => {},
    };
    const hit = { session_id: "s3", hook_event_name: "PreToolUse", tool_name: MCP_MATCHER, tool_input: {} };
    expect(dispatchWith(hit, [drafted], sink)).toBe(drafted.text);
    expect(fires[0]?.["pattern"]).toBe("outline-update-caution");

    // A different MCP tool on the same server must not fire this nudge.
    const otherTool = { ...hit, tool_name: "mcp__outline__fetch" };
    expect(dispatchWith(otherTool, [drafted], sink)).toBeNull();
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

describe("empty drafter signals normalize before routing", () => {
  const parsedDraft = (fields: Record<string, unknown>): RouteAnswer =>
    parseDraft(JSON.stringify({ artifact: "drafted body", ...fields }))[1];

  test("RouteAnswer parse and safeParse normalize blank fields", () => {
    const fields = { trigger_event: "", gate: {}, context_evidence: "", capability_evidence: "   " };
    const parsed = RouteAnswer.parse(fields);
    const safe = RouteAnswer.safeParse(fields);
    expect(safe.success).toBe(true);
    if (!safe.success) throw new Error("expected blank routing fields to parse");
    expect(safe.data).toEqual(parsed);
    expect(parsed).toMatchObject({
      trigger_event: "none",
      gate: null,
      context_evidence: null,
      capability_evidence: null,
    });
  });

  test("blank capability evidence does not claim a skill", () => {
    for (const evidence of ["", "   "]) {
      const parsed = parsedDraft({ capability_evidence: evidence });
      expect(parsed.capability_evidence).toBeNull();
      expect(draftedType(parsed)).toBe("rule");
      expect(route(parsed, SOURCES, PAYLOADS, opts).artifact_type).toBe("rule");
    }
  });

  test("blank context evidence does not claim an agent", () => {
    for (const evidence of ["", "   "]) {
      const parsed = parsedDraft({ needs_own_context: true, context_evidence: evidence });
      expect(parsed.context_evidence).toBeNull();
      expect(draftedType(parsed)).toBe("rule");
      const result = route(parsed, SOURCES, PAYLOADS, opts);
      expect(result.artifact_type).toBe("rule");
      expect(result.reason).toContain("no context_evidence");
    }
  });

  test("blank trigger and empty gate do not claim a hook", () => {
    const blankTrigger = parsedDraft({ trigger_event: "", gate: WORKABLE_GATE });
    expect(blankTrigger.trigger_event).toBe("none");
    expect(draftedType(blankTrigger)).toBe("rule");
    expect(route(blankTrigger, SOURCES, PAYLOADS, opts).artifact_type).toBe("rule");

    const emptyGate = parsedDraft({ trigger_event: "PreToolUse:Bash", gate: {} });
    expect(emptyGate.gate).toBeNull();
    expect(draftedType(emptyGate)).toBe("rule");
    expect(route(emptyGate, SOURCES, PAYLOADS, opts).artifact_type).toBe("rule");
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

describe("and scaffolding is not evidence", () => {
  // Every reflection ever written carries these lines, so a quote made of them
  // is verbatim in all of them and says nothing about this one.
  const TEMPLATE_SOURCES =
    "Last updated: 2026-09-01\n\nPattern: verify-callsites\n\n## What worked\n\n" +
    "## What failed & why\n\n## Reusable lesson\n\n## Verification\n";
  const SCAFFOLDING = [
    "Last updated: 2026-09-01 Pattern: verify-callsites",
    "Pattern: verify-callsites ## What worked ## What failed & why",
    "## What worked ## What failed & why ## Reusable lesson ## Verification",
  ];

  test("the reflection template's own lines buy no artifact type", () => {
    for (const quote of SCAFFOLDING) {
      // Long enough and wordy enough: the refusal is about what the words are.
      expect(quote.length).toBeGreaterThanOrEqual(MIN_QUOTE_CHARS);
      expect(quote.split(" ").length).toBeGreaterThanOrEqual(MIN_QUOTE_WORDS);
      expect(TEMPLATE_SOURCES.split(/\s+/).join(" ")).toContain(quote);

      for (const field of ["capability_evidence", "context_evidence"] as const) {
        const result = route(
          answer({ needs_own_context: field === "context_evidence", [field]: quote }),
          TEMPLATE_SOURCES,
          PAYLOADS,
          opts,
        );
        expect(result.artifact_type).toBe("rule");
      }
    }
  });

  test("a real lesson quote out of a real reflection still earns its type", () => {
    const sources =
      "Last updated: 2026-09-01\n\nPattern: verify-callsites\n\n## Reusable lesson\n\n" +
      "Run `rg` over every call site of the changed symbol and read the graphify " +
      "inventory before calling the change safe.\n";
    const quote = "over every call site of the changed symbol and read the graphify inventory";

    expect(route(answer({ capability_evidence: quote }), sources, PAYLOADS, opts).artifact_type).toBe("skill");
    expect(
      route(answer({ needs_own_context: true, context_evidence: quote }), sources, PAYLOADS, opts).artifact_type,
    ).toBe("agent");
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
  test("a malformed answer costs a routing decision, never a crash", () => {
    // A caller handing null from a failed file read, or a drafter reply parsed
    // into a bare object, must not take the whole curriculum run down.
    const answers: unknown[] = [null, undefined, {}, 42, "a string", [], { gate: {} }, { trigger_event: null }];
    for (const a of answers) {
      const result = route(a, SOURCES, PAYLOADS, opts);
      expect(["skill", "hook", "rule", "agent", "none"]).toContain(result.artifact_type);
    }
  });

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

  describe("recorded samples make a narrow gate testable", () => {
    // The measured failure this fixes: 6 of 8 proposed hooks were downgraded
    // with "gate matched nothing", because a gate on a real flag cannot match a
    // synthetic fixture. Nothing about the gate changes here, only the corpus.
    const NARROW_GATE = { command_matches: "--no-verify" };
    let env: TestEnv;

    beforeEach(() => {
      env = silEnv();
    });
    afterEach(() => {
      cleanupEnv(env);
    });

    test("a gate on a real command is a hook once that command has been recorded", () => {
      const world = makeWorld();
      const fixturesOnly = loadPayloadCorpus(world);
      expect(route(answer({ trigger_event: "PreToolUse:Bash", gate: NARROW_GATE }), SOURCES, fixturesOnly, opts).artifact_type).toBe(
        "rule",
      );

      // Where the hook records it: a payload_samples row of the world.
      appendRecord(
        "payload_samples",
        {
          ts: "2026-09-19T10:00:00.000Z",
          session_id: "sess-1",
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "git push --no-verify" },
        },
        world.name,
      );

      const withSamples = loadPayloadCorpus(world);
      expect(withSamples.length).toBe(fixturesOnly.length + 1);
      expect(route(answer({ trigger_event: "PreToolUse:Bash", gate: NARROW_GATE }), SOURCES, withSamples, opts).artifact_type).toBe(
        "hook",
      );
    });
  });
});

test("a prototype key is not a hook event", async () => {
  const { splitTrigger } = await import("../src/router.ts");
  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    expect(splitTrigger(name)).toBeNull();
    expect(splitTrigger(`${name}:Bash`)).toBeNull();
  }
});
