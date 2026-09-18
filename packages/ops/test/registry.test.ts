// Registry self-checks and the full 31-op tier/gate table. Every test that
// mutates REGISTRY (self-check tests register throwaway ops) restores the
// snapshot taken at the start of the test so other test files still see the
// real 31 ops registered by the side-effecting "../src/index.ts" import.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import "../src/index.ts";
import { opPath, REGISTRY, register, type GateKind, type Op, type Tier } from "../src/registry.ts";

let snapshot: [string, Op][];

beforeEach(() => {
  snapshot = [...REGISTRY.entries()];
});

afterEach(() => {
  REGISTRY.clear();
  for (const [name, op] of snapshot) REGISTRY.set(name, op);
});

function stub(name: string, tier: Tier, gate: GateKind): Op {
  return { name, tier, gate, args: z.object({}), fn: () => null, doc: "" };
}

describe("register() self-checks", () => {
  test("a duplicate name throws", () => {
    register(stub("test.dup", "read", "none"));
    expect(() => register(stub("test.dup", "read", "none"))).toThrow(/duplicate/);
  });

  test("a remote op without a gate throws", () => {
    expect(() => register(stub("test.remote-ungated", "remote", "none"))).toThrow(/gate/);
  });

  test("a remote op with a gate registers fine", () => {
    expect(() => register(stub("test.remote-gated", "remote", "confirm"))).not.toThrow();
  });

  test.each(["test.accept-something", "test.push-something"])(
    "a %s named op must be tier remote",
    (name) => {
      expect(() => register(stub(name, "local", "none"))).toThrow(/remote/);
      expect(() => register(stub(name, "read", "none"))).toThrow(/remote/);
    },
  );

  test("an accept/push named op registers fine as tier remote", () => {
    expect(() => register(stub("test.accept-ok", "remote", "confirm"))).not.toThrow();
  });
});

// Name -> [tier, gate]: the 30 ops of sil/ops.py plus llm.use and aliases.suggest.
const EXPECTED: Record<string, [Tier, GateKind]> = {
  "health.report": ["read", "none"],
  "worlds.list": ["read", "none"],
  "config.get": ["read", "none"],
  "config.set": ["local", "none"],
  "llm.get": ["read", "none"],
  "llm.set": ["local", "none"],
  "llm.status": ["read", "none"],
  "llm.use": ["local", "none"],
  "queue.list": ["read", "none"],
  "queue.skip": ["local", "none"],
  "worker.status": ["read", "none"],
  "loop.run": ["local", "none"],
  "curriculum.plan": ["read", "none"],
  "curriculum.run": ["local", "none"],
  "reflections.list": ["read", "none"],
  "reflections.get": ["read", "none"],
  "aliases.get": ["read", "none"],
  "aliases.set": ["local", "none"],
  "aliases.suggest": ["read", "none"],
  "review.queue": ["read", "none"],
  "review.detail": ["read", "none"],
  "review.diff": ["read", "none"],
  "skill.accept": ["remote", "reviewed_state"],
  "skill.reject": ["local", "none"],
  "router.rehome": ["local", "none"],
  "router.retire": ["local", "confirm"],
  "router.inventory": ["read", "none"],
  "artifacts.scorecards": ["read", "none"],
  "artifacts.rebuild": ["local", "none"],
  "feedback.add": ["local", "none"],
  "lessons.list": ["read", "none"],
  "logs.tail": ["read", "none"],
};

describe("the 31 real ops", () => {
  test("registry has exactly the expected op names", () => {
    expect(new Set(REGISTRY.keys())).toEqual(new Set(Object.keys(EXPECTED)));
  });

  test.each(Object.entries(EXPECTED))("%s has the expected tier and gate", (name, [tier, gate]) => {
    const op = REGISTRY.get(name);
    expect(op).toBeDefined();
    expect(op!.tier).toBe(tier);
    expect(op!.gate).toBe(gate);
    expect(op!.doc.length).toBeGreaterThan(0);
  });

  test("no remote op lacks a gate", () => {
    for (const op of REGISTRY.values()) {
      if (op.tier === "remote") expect(op.gate).not.toBe("none");
    }
  });
});

describe("opPath", () => {
  test("maps area.verb to /api/area/verb", () => {
    expect(opPath("review.queue")).toBe("/api/review/queue");
    expect(opPath("health.report")).toBe("/api/health/report");
  });
});
