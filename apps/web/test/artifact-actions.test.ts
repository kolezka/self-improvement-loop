import { describe, expect, test } from "bun:test";
import { canRefine, canRetire } from "../src/lib/artifact-actions.ts";

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

describe("canRefine", () => {
  // Same eligibility as Retire: review.refine refuses a row that is not
  // currently live, or that is inline, so showing the button on either kind
  // of row only ever produces a failed call.
  test("shows Refine on a live (promoted) row", () => {
    expect(canRefine({ status: "promoted" })).toBe(true);
  });

  test("hides Refine on a retired row", () => {
    expect(canRefine({ status: "retired" })).toBe(false);
  });

  test("hides Refine on a row that was never promoted", () => {
    expect(canRefine({ status: "rejected" })).toBe(false);
  });

  test("hides Refine on a live inline row", () => {
    expect(canRefine({ status: "promoted", origin: "inline" })).toBe(false);
  });
});
