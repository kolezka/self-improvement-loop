import { describe, expect, test } from "bun:test";
import { createSseParser } from "../src/lib/stream.ts";

describe("createSseParser", () => {
  test("emits events split across chunks and ignores comments", () => {
    const got: [string, string][] = [];
    const feed = createSseParser((e, d) => got.push([e, d]));
    feed(': heartbeat\n\nevent: line\ndata: {"line":"a"}\n');
    feed('\nevent: line\ndata: {"line":"b"}\n\n');
    expect(got).toEqual([
      ["line", '{"line":"a"}'],
      ["line", '{"line":"b"}'],
    ]);
  });

  test("joins multi-line data with newlines and defaults event to message", () => {
    const got: [string, string][] = [];
    const feed = createSseParser((e, d) => got.push([e, d]));
    feed("data: x\ndata: y\n\n");
    expect(got).toEqual([["message", "x\ny"]]);
  });

  test("holds an unterminated event until its blank line arrives", () => {
    const got: [string, string][] = [];
    const feed = createSseParser((e, d) => got.push([e, d]));
    feed("event: reset\ndata: {}\n");
    expect(got).toEqual([]);
    feed("\n");
    expect(got).toEqual([["reset", "{}"]]);
  });
});
