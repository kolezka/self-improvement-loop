// Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first.

import { expect, test } from "bun:test";
import {
  buildOffsets,
  computeVariableWindow,
  computeWindow,
  findRowAt,
  rowSpan,
} from "../src/vendor/svelte-log-viewer/virtual.ts";

const ROW = 20;
const VIEWPORT = 400;

test("first window starts at row zero and does not overscan below it", () => {
  const window = computeWindow({ scrollTop: 0, viewportHeight: VIEWPORT, rowHeight: ROW, count: 50_000, overscan: 10 });
  expect(window).toEqual({ start: 0, end: 31, offsetTop: 0, totalHeight: 50_000 * ROW });
});

test("middle window is centred on the scrolled row", () => {
  const window = computeWindow({ scrollTop: 10_000, viewportHeight: VIEWPORT, rowHeight: ROW, count: 50_000, overscan: 10 });
  expect(window.start).toBe(490);
  expect(window.end).toBe(531);
  expect(window.offsetTop).toBe(490 * ROW);
  expect(window.end - window.start).toBe(41);
});

test("middle window keeps its offset aligned to the rendered slice", () => {
  const window = computeWindow({ scrollTop: 10_010, viewportHeight: VIEWPORT, rowHeight: ROW, count: 50_000, overscan: 0 });
  expect(window.start).toBe(500);
  expect(window.offsetTop).toBe(10_000);
  expect(window.end).toBe(521);
});

test("end window stops at the last row", () => {
  const count = 50_000;
  const window = computeWindow({ scrollTop: count * ROW - VIEWPORT, viewportHeight: VIEWPORT, rowHeight: ROW, count, overscan: 10 });
  expect(window.end).toBe(count);
  expect(window.start).toBe(count - 20 - 10);
  expect(window.offsetTop).toBe(window.start * ROW);
});

test("a scrollTop past the end clamps to the last window", () => {
  const count = 1000;
  const window = computeWindow({ scrollTop: 9_999_999, viewportHeight: VIEWPORT, rowHeight: ROW, count, overscan: 4 });
  expect(window.end).toBe(count);
  expect(window.start).toBe(count - 20 - 4);
  expect(window.offsetTop).toBeLessThanOrEqual(window.totalHeight);
});

test("overscan is clamped at both edges and never leaves the list", () => {
  const top = computeWindow({ scrollTop: 40, viewportHeight: VIEWPORT, rowHeight: ROW, count: 100, overscan: 500 });
  expect(top.start).toBe(0);
  expect(top.end).toBe(100);

  const short = computeWindow({ scrollTop: 0, viewportHeight: VIEWPORT, rowHeight: ROW, count: 3, overscan: 12 });
  expect(short).toMatchObject({ start: 0, end: 3, totalHeight: 60 });
});

test("negative and non-finite inputs degrade to the first window", () => {
  const negative = computeWindow({ scrollTop: -500, viewportHeight: VIEWPORT, rowHeight: ROW, count: 100, overscan: 2 });
  expect(negative).toMatchObject({ start: 0, offsetTop: 0 });

  const broken = computeWindow({ scrollTop: Number.NaN, viewportHeight: VIEWPORT, rowHeight: 0, count: 10, overscan: 1 });
  expect(broken).toMatchObject({ start: 0, totalHeight: 10 });
});

test("an empty list renders nothing", () => {
  expect(computeWindow({ scrollTop: 0, viewportHeight: VIEWPORT, rowHeight: ROW, count: 0 })).toEqual({
    start: 0,
    end: 0,
    offsetTop: 0,
    totalHeight: 0,
  });
});

test("rowSpan counts the wrapped rows of a line", () => {
  expect(rowSpan(0, 80)).toBe(1);
  expect(rowSpan(80, 80)).toBe(1);
  expect(rowSpan(81, 80)).toBe(2);
  expect(rowSpan(240, 80)).toBe(3);
  expect(rowSpan(240, 0)).toBe(1);
});

test("buildOffsets turns line lengths into a prefix sum", () => {
  const offsets = buildOffsets([10, 100, 30], 40, ROW);
  expect([...offsets]).toEqual([0, 20, 80, 100]);
  expect(findRowAt(offsets, 0)).toBe(0);
  expect(findRowAt(offsets, 25)).toBe(1);
  expect(findRowAt(offsets, 79)).toBe(1);
  expect(findRowAt(offsets, 80)).toBe(2);
  expect(findRowAt(offsets, 9999)).toBe(2);
});

test("wrapped window covers the viewport and clamps its overscan", () => {
  const lengths = Array.from({ length: 1000 }, (_, index) => (index % 3 === 0 ? 90 : 10));
  const offsets = buildOffsets(lengths, 80, ROW);

  const first = computeVariableWindow({ scrollTop: 0, viewportHeight: VIEWPORT, offsets, overscan: 5 });
  expect(first.start).toBe(0);
  expect(first.offsetTop).toBe(0);
  expect(offsets[first.end]).toBeGreaterThanOrEqual(VIEWPORT);

  const last = computeVariableWindow({ scrollTop: offsets[1000], viewportHeight: VIEWPORT, offsets, overscan: 5 });
  expect(last.end).toBe(1000);
  expect(last.offsetTop).toBeLessThanOrEqual(offsets[1000] - VIEWPORT);
  expect(last.totalHeight).toBe(offsets[1000]);
});
