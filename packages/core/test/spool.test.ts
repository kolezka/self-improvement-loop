import { describe, expect, test } from "bun:test";
import { parseSpool, serializeSpool, SPOOL_VERSION } from "../src/spool.ts";
import type { Spool } from "../src/spool.ts";

const FULL_SPOOL: Spool = {
  version: SPOOL_VERSION,
  session_id: "sess-1",
  written_at: "2026-09-21T00:00:00.000Z",
  appends: [
    { target: { kind: "usage-events" }, line: '{"kind":"skill"}' },
    { target: { kind: "hook-runs" }, line: '{"kind":"hook_run"}' },
    { target: { kind: "nudge-fires" }, line: '{"kind":"fire"}' },
    { target: { kind: "payload-samples", world: "default" }, line: '{"tool_name":"Bash"}' },
    { target: { kind: "session-file", name: "start.json" }, line: '{"ts":"x"}' },
  ],
  moves: [{ from: "/state/inbox/default/x.json", to: "/state/inbox/default/archive/x.json" }],
};

describe("serializeSpool / parseSpool round trip", () => {
  test("every target kind and a move survive a round trip", () => {
    const text = serializeSpool(FULL_SPOOL);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseSpool(text)).toEqual(FULL_SPOOL);
  });

  test("written_at defaults to empty string when missing", () => {
    const { written_at, ...rest } = FULL_SPOOL;
    const text = JSON.stringify(rest);
    expect(parseSpool(text)).toEqual({ ...FULL_SPOOL, written_at: "" });
  });
});

describe("parseSpool rejection cases", () => {
  test("invalid JSON", () => {
    expect(parseSpool("not json")).toBeNull();
  });

  test("valid JSON that is not an object", () => {
    expect(parseSpool("[]")).toBeNull();
    expect(parseSpool('"a string"')).toBeNull();
    expect(parseSpool("42")).toBeNull();
  });

  test("wrong version", () => {
    expect(parseSpool(JSON.stringify({ ...FULL_SPOOL, version: 2 }))).toBeNull();
  });

  test("missing or invalid session_id", () => {
    const { session_id, ...withoutSessionId } = FULL_SPOOL;
    expect(parseSpool(JSON.stringify(withoutSessionId))).toBeNull();
    expect(parseSpool(JSON.stringify({ ...FULL_SPOOL, session_id: "" }))).toBeNull();
    expect(parseSpool(JSON.stringify({ ...FULL_SPOOL, session_id: 123 }))).toBeNull();
  });

  test("appends or moves not arrays", () => {
    expect(parseSpool(JSON.stringify({ ...FULL_SPOOL, appends: {} }))).toBeNull();
    expect(parseSpool(JSON.stringify({ ...FULL_SPOOL, moves: "nope" }))).toBeNull();
  });
});

describe("bad entries are dropped, not fatal", () => {
  test("a malformed append is dropped, valid ones survive", () => {
    const spool = {
      ...FULL_SPOOL,
      appends: [
        { target: { kind: "usage-events" }, line: "{}" },
        { target: { kind: "unknown-kind" }, line: "{}" }, // bad target kind
        { target: { kind: "session-file" }, line: "{}" }, // session-file missing name
        { target: { kind: "payload-samples" }, line: "{}" }, // payload-samples missing world
        { target: { kind: "hook-runs" } }, // missing line
        "not an object",
        { target: { kind: "nudge-fires" }, line: "{}" },
      ],
    };
    const parsed = parseSpool(JSON.stringify(spool));
    expect(parsed).not.toBeNull();
    expect(parsed!.appends).toEqual([
      { target: { kind: "usage-events" }, line: "{}" },
      { target: { kind: "nudge-fires" }, line: "{}" },
    ]);
  });

  test("a malformed move is dropped, valid ones survive", () => {
    const spool = {
      ...FULL_SPOOL,
      moves: [
        { from: "/a", to: "/b" },
        { from: "/a" }, // missing to
        { to: "/b" }, // missing from
        { from: "", to: "/b" }, // empty from
        "not an object",
      ],
    };
    const parsed = parseSpool(JSON.stringify(spool));
    expect(parsed).not.toBeNull();
    expect(parsed!.moves).toEqual([{ from: "/a", to: "/b" }]);
  });
});
