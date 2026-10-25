import { describe, expect, test } from "bun:test";
import * as core from "../src/index.ts";
import { ValidationError } from "../src/index.ts";

// Read through the namespace so a missing export fails at the assertion, not at import.
const assertOneHop = (aliases: Record<string, string>): void =>
  (core as unknown as { assertOneHop: (a: Record<string, string>) => void }).assertOneHop(aliases);

function thrown(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

describe("assertOneHop", () => {
  test("refuses a key that is also another entry's value", () => {
    const error = thrown(() => assertOneHop({ a: "b", b: "c" }));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toBe(`"b" is a key (-> "c") and also the value of "a" (-> "b"); aliases resolve one hop only`);
  });

  test("refuses a key that is its own value", () => {
    const error = thrown(() => assertOneHop({ a: "a" }));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toBe(`"a" is a key (-> "a") and also its own value`);
  });

  test("accepts two keys sharing one canonical", () => {
    expect(typeof (core as Record<string, unknown>)["assertOneHop"]).toBe("function");
    expect(() => assertOneHop({ a: "b", c: "b" })).not.toThrow();
  });
});
