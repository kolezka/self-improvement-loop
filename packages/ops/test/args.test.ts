// Argument schema edge cases: the same invariants sil/ops.py's pydantic
// models enforced (bad slug, bad reviewed_state digest, a traversal-shaped
// session id, an argv-flag-shaped world name).

import { describe, expect, test } from "bun:test";
import "../src/index.ts";
import { invoke } from "../src/registry.ts";
import * as Args from "../src/args.ts";

describe("PatternArgs", () => {
  test("rejects a pattern that is not a slug", () => {
    expect(() => Args.PatternArgs.parse({ world: "default", pattern: "Not A Slug!" })).toThrow();
  });
  test("accepts a real slug", () => {
    expect(() => Args.PatternArgs.parse({ world: "default", pattern: "foo-bar-2" })).not.toThrow();
  });
});

describe("AcceptArgs", () => {
  test("rejects a short reviewed_state", () => {
    expect(() => Args.AcceptArgs.parse({ world: "default", pattern: "foo-bar", reviewed_state: "abc" })).toThrow();
  });
  test("rejects a reviewed_state with non-hex characters", () => {
    expect(() => Args.AcceptArgs.parse({ world: "default", pattern: "foo-bar", reviewed_state: "z".repeat(64) })).toThrow();
  });
  test("accepts a 64 char hex digest", () => {
    expect(() => Args.AcceptArgs.parse({ world: "default", pattern: "foo-bar", reviewed_state: "a".repeat(64) })).not.toThrow();
  });
});

describe("SessionArgs", () => {
  test("rejects a traversal-shaped session id", () => {
    expect(() => Args.SessionArgs.parse({ session_id: "../../etc/passwd" })).toThrow();
  });
  test("rejects an empty session id", () => {
    expect(() => Args.SessionArgs.parse({ session_id: "" })).toThrow();
  });
  test("accepts a realistic session id", () => {
    expect(() => Args.SessionArgs.parse({ session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" })).not.toThrow();
  });
});

describe("WorldArgs", () => {
  test("rejects an argv-flag-shaped world name", () => {
    expect(() => Args.WorldArgs.parse({ world: "--no-curriculum" })).toThrow();
  });
  test("rejects a world name starting with a dot (hidden/relative path shape)", () => {
    expect(() => Args.WorldArgs.parse({ world: "..secret" })).toThrow();
  });
  test("accepts a normal world name", () => {
    expect(() => Args.WorldArgs.parse({ world: "default" })).not.toThrow();
  });
  test("accepts a unicode world name, so the web UI can reach it", () => {
    expect(() => Args.WorldArgs.parse({ world: "Koleżka" })).not.toThrow();
  });
  test("rejects a path separator", () => {
    expect(() => Args.WorldArgs.parse({ world: "a/b" })).toThrow();
  });
});

describe("RetireArgs", () => {
  test("requires confirm: true, missing confirm rejected", () => {
    expect(() => Args.RetireArgs.parse({ world: "default", pattern: "foo-bar" })).toThrow();
  });
  test("requires confirm: true, confirm: false rejected", () => {
    expect(() => Args.RetireArgs.parse({ world: "default", pattern: "foo-bar", confirm: false })).toThrow();
  });
  test("confirm: true accepted", () => {
    expect(() => Args.RetireArgs.parse({ world: "default", pattern: "foo-bar", confirm: true })).not.toThrow();
  });
});

describe("RehomeArgs", () => {
  // Re-homing to "none" is a retirement: it stages the deletion of the
  // artifact. It costs the same confirmation router.retire costs.
  test("artifact_type none without confirm rejected", () => {
    expect(() => Args.RehomeArgs.parse({ world: "default", pattern: "foo-bar", artifact_type: "none" })).toThrow();
  });
  test("artifact_type none with confirm: true accepted", () => {
    expect(() =>
      Args.RehomeArgs.parse({ world: "default", pattern: "foo-bar", artifact_type: "none", confirm: true }),
    ).not.toThrow();
  });
  test("any other type needs no confirm", () => {
    expect(() => Args.RehomeArgs.parse({ world: "default", pattern: "foo-bar", artifact_type: "agent" })).not.toThrow();
  });
});

describe("AliasArgs", () => {
  test("rejects an alias map with a non-slug key or value", () => {
    expect(() => Args.AliasArgs.parse({ world: "default", aliases: { "Bad Key": "ok-target" } })).toThrow();
    expect(() => Args.AliasArgs.parse({ world: "default", aliases: { "ok-source": "Bad Value" } })).toThrow();
  });
  test("accepts a slug to slug map", () => {
    expect(() => Args.AliasArgs.parse({ world: "default", aliases: { "old-name": "new-name" } })).not.toThrow();
  });
  test("holds the world name to the same shape every other op does", () => {
    expect(() => Args.AliasArgs.parse({ world: "a/b", aliases: {} })).toThrow();
    expect(() => Args.AliasArgs.parse({ world: "--no-curriculum", aliases: {} })).toThrow();
  });
});

describe("FeedbackArgs", () => {
  test("holds the world name to the same shape every other op does", () => {
    const base = { ref: "skill:foo-bar", vote: "good" };
    expect(() => Args.FeedbackArgs.parse({ ...base, world: "a/b" })).toThrow();
    expect(() => Args.FeedbackArgs.parse({ ...base, world: "default" })).not.toThrow();
  });
});

describe("LogArgs", () => {
  test("rejects a log name outside LOG_NAMES", () => {
    expect(() => Args.LogArgs.parse({ name: "not-a-real-log" })).toThrow();
  });
  test("rejects lines above 2000", () => {
    expect(() => Args.LogArgs.parse({ name: "worker", lines: 2001 })).toThrow();
  });
  test("defaults lines to 200", () => {
    expect(Args.LogArgs.parse({ name: "worker" }).lines).toBe(200);
  });
});

describe("ReflectionListArgs", () => {
  test("rejects a limit above 2000", () => {
    expect(() => Args.ReflectionListArgs.parse({ world: "default", limit: 2001 })).toThrow();
  });
  test("defaults limit to 200", () => {
    expect(Args.ReflectionListArgs.parse({ world: "default" }).limit).toBe(200);
  });
});

describe("invoke() routes payloads through the op's own schema", () => {
  test("an unknown op name raises", () => {
    expect(invoke("nope.nope", {})).rejects.toThrow(/unknown op/);
  });
  test("review.detail rejects a bad pattern slug before touching disk", () => {
    expect(invoke("review.detail", { world: "default", pattern: "Not A Slug!" })).rejects.toThrow();
  });
  test("queue.skip rejects a traversal-shaped session id before touching the worker", () => {
    expect(invoke("queue.skip", { session_id: "../../x" })).rejects.toThrow();
  });
  test("router.retire rejects a payload missing confirm: true", () => {
    expect(invoke("router.retire", { world: "default", pattern: "foo-bar" })).rejects.toThrow();
  });
});
