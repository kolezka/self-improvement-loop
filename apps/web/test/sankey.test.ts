// Unit tests for the pure Sankey layout: node sizing, link ribbons and
// ordering. No Svelte or DOM here, so this runs as plain bun:test.

import { describe, expect, test } from "bun:test";
import { buildSankey } from "../src/lib/sankey.ts";

const OPTS = { width: 400, height: 200, nodeWidth: 12, gap: 4 };

describe("buildSankey", () => {
  test("returns no nodes or links for no flows", () => {
    expect(buildSankey([], OPTS)).toEqual({ nodes: [], links: [] });
  });

  test("node height is proportional to its total value", () => {
    const { nodes } = buildSankey(
      [
        { source: "a", target: "x", value: 1 },
        { source: "b", target: "x", value: 3 },
      ],
      OPTS,
    );
    const a = nodes.find((n) => n.id === "a")!;
    const b = nodes.find((n) => n.id === "b")!;
    // b carries 3x the value of a, so it must stand 3x as tall.
    expect(b.height).toBeCloseTo(a.height * 3, 5);
  });

  test("a node's height equals the sum of the value flowing through it", () => {
    const { nodes } = buildSankey(
      [
        { source: "a", target: "x", value: 2 },
        { source: "a", target: "y", value: 3 },
      ],
      OPTS,
    );
    const a = nodes.find((n) => n.id === "a")!;
    const x = nodes.find((n) => n.id === "x")!;
    const y = nodes.find((n) => n.id === "y")!;
    expect(a.value).toBe(5);
    // The source column's total value equals the target column's: nothing
    // is created or dropped between the two sides.
    expect(x.value + y.value).toBe(a.value);
  });

  test("keeps nodes in first-appearance order, not sorted by value", () => {
    const { nodes } = buildSankey(
      [
        { source: "b", target: "y", value: 1 },
        { source: "a", target: "x", value: 5 },
        { source: "a", target: "y", value: 1 },
      ],
      OPTS,
    );
    expect(nodes.filter((n) => n.column === 0).map((n) => n.id)).toEqual(["b", "a"]);
    expect(nodes.filter((n) => n.column === 1).map((n) => n.id)).toEqual(["y", "x"]);
  });

  test("places column 0 at x=0 and column 1 at the right edge", () => {
    const { nodes } = buildSankey([{ source: "a", target: "x", value: 1 }], OPTS);
    const a = nodes.find((n) => n.id === "a")!;
    const x = nodes.find((n) => n.id === "x")!;
    expect(a.x).toBe(0);
    expect(x.x).toBe(OPTS.width - OPTS.nodeWidth);
  });

  test("stacks two nodes in a column with a gap between them", () => {
    const { nodes } = buildSankey(
      [
        { source: "a", target: "x", value: 1 },
        { source: "b", target: "x", value: 1 },
      ],
      OPTS,
    );
    const a = nodes.find((n) => n.id === "a")!;
    const b = nodes.find((n) => n.id === "b")!;
    expect(a.y).toBe(0);
    expect(b.y).toBeCloseTo(a.y + a.height + OPTS.gap, 5);
  });

  test("produces one link per flow with a non-empty cubic bezier path", () => {
    const { links } = buildSankey(
      [
        { source: "a", target: "x", value: 2 },
        { source: "a", target: "y", value: 1 },
      ],
      OPTS,
    );
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.path.startsWith("M")).toBe(true);
      expect(link.path).toContain("C");
      expect(link.value).toBeGreaterThan(0);
    }
  });

  test("merges duplicate source-target pairs into a single link", () => {
    const { links } = buildSankey(
      [
        { source: "a", target: "x", value: 2 },
        { source: "a", target: "x", value: 3 },
      ],
      OPTS,
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.value).toBe(5);
  });

  test("a single flow's link thickness matches its node height on both ends", () => {
    const { nodes, links } = buildSankey([{ source: "a", target: "x", value: 4 }], OPTS);
    const a = nodes.find((n) => n.id === "a")!;
    const link = links[0]!;
    expect(link.sourceY1 - link.sourceY0).toBeCloseTo(a.height, 5);
    expect(link.targetY1 - link.targetY0).toBeCloseTo(a.height, 5);
  });
});
