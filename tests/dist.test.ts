// The committed dist/ is what the plugin actually runs (a plugin install is a
// git clone, no install step). This guards against it drifting from source:
// every build input is hashed, and the hash must match dist/.srchash exactly.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DIST, sourceHash } from "../scripts/build.ts";

describe("dist/", () => {
  test("dist/.srchash matches the current source tree", () => {
    const hashPath = join(DIST, ".srchash");
    expect(existsSync(hashPath)).toBe(true);
    const recorded = readFileSync(hashPath, "utf8").trim();
    expect(recorded).toBe(sourceHash());
  });

  test.each(["hook.js", "cli.js", "server.js", "gate-runner.js"])("dist/%s exists", (name) => {
    expect(existsSync(join(DIST, name))).toBe(true);
  });

  test("dist/web/index.html exists", () => {
    expect(existsSync(join(DIST, "web", "index.html"))).toBe(true);
  });
});
