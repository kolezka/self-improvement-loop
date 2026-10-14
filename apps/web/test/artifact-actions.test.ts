import { describe, expect, test } from "bun:test";
import { canRetire } from "../src/lib/artifact-actions.ts";

describe("canRetire", () => {
  test("shows Retire on a live (promoted) row", () => {
    expect(canRetire({ status: "promoted" })).toBe(true);
  });

  // The regression this guards: the old Artifacts.svelte rendered the Retire
  // button on every row, so clicking it on a row already retired failed with
  // `"<pattern>" is already retired` from retireInner.
  test("hides Retire on an already-retired row", () => {
    expect(canRetire({ status: "retired" })).toBe(false);
  });

  test("hides Retire on a row that was never promoted", () => {
    expect(canRetire({ status: "rejected" })).toBe(false);
  });

  // refuseInline refuses retire for any inline row regardless of status.
  test("hides Retire on a live inline row", () => {
    expect(canRetire({ status: "promoted", origin: "inline" })).toBe(false);
  });

  test("shows Retire on a live row with no origin field (the loop's own artifacts)", () => {
    expect(canRetire({ status: "promoted", origin: undefined })).toBe(true);
  });
});
