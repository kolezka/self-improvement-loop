import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// An unclosed block in app.css makes the minifier drop every rule after it,
// including all scoped pane styles, with no build error. Several blocks here
// are appended by parallel branches, so a merge can lose a brace.
describe("app.css", () => {
  test("every block is closed", () => {
    const css = readFileSync(join(import.meta.dir, "../src/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0;
    let line = 1;
    for (const ch of css) {
      if (ch === "\n") line++;
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      expect(depth, `unbalanced "}" at line ${line}`).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
