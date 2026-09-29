// Unit tests for the queue bucket result styling helper.

import { describe, expect, test } from "bun:test";
import { resultTextClass } from "../src/lib/queue.ts";

describe("resultTextClass", () => {
  test("marks a failed entry's result red", () => {
    expect(resultTextClass("failed")).toBe("error-text");
  });

  test("marks a done entry's result neutral, not red", () => {
    expect(resultTextClass("done")).toBe("muted");
  });

  test("marks a pending entry's result neutral", () => {
    expect(resultTextClass("pending")).toBe("muted");
  });
});
