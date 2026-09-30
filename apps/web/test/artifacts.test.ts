// The artifacts table has no rendering harness (no Svelte/DOM test runner in
// this repo), so this checks the markup as text: every row variant must
// render the same number of cells as the header, or the Actions column
// silently shifts under whatever header sits one short. A row without a
// scorecard used to render one placeholder cell fewer than a row with one.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "../src/panes/Artifacts.svelte"), "utf8");

function countCells(tag: "th" | "td", text: string): number {
  return (text.match(new RegExp(`<${tag}[\\s>]`, "g")) ?? []).length;
}

describe("Artifacts.svelte table", () => {
  test("every row branch renders as many <td> as the header has <th>", () => {
    const thead = SRC.match(/<thead>([\s\S]*?)<\/thead>/);
    expect(thead).not.toBeNull();
    const headerCount = countCells("th", thead![1]!);
    expect(headerCount).toBeGreaterThan(0);

    const eachBlock = SRC.match(/\{#each rows as row[\s\S]*?\{\/each\}/);
    expect(eachBlock).not.toBeNull();
    const body = eachBlock![0]!;

    // The row template nests an earlier {#if row.served_by} inside the same
    // {#each}, so the scorecard branch's own {:else}/{/if} must be found
    // relative to its own {#if}, not the first occurrence in the whole row.
    const ifStart = body.indexOf("{#if row.scorecard}");
    const elseAt = body.indexOf("{:else}", ifStart);
    const ifEnd = body.indexOf("{/if}", elseAt);
    expect(ifStart).toBeGreaterThan(-1);
    expect(elseAt).toBeGreaterThan(ifStart);
    expect(ifEnd).toBeGreaterThan(elseAt);

    const before = body.slice(0, ifStart);
    const withScorecard = body.slice(ifStart, elseAt);
    const withoutScorecard = body.slice(elseAt, ifEnd);
    const after = body.slice(ifEnd + "{/if}".length);

    const sharedCount = countCells("td", before) + countCells("td", after);
    const withScorecardCount = sharedCount + countCells("td", withScorecard);
    const withoutScorecardCount = sharedCount + countCells("td", withoutScorecard);

    expect(withScorecardCount).toBe(headerCount);
    expect(withoutScorecardCount).toBe(headerCount);
  });
});
