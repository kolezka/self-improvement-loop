// dist/ is what the plugin actually runs (a plugin install has no install
// step). It is built, never committed on main: the release workflow builds it
// and commits it on the release tag. So these tests only run when a build is
// present, and then they check it has not drifted from source: every build
// input is hashed, and the hash must match dist/.srchash exactly.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DIST, sourceHash } from "../scripts/build.ts";

const built = existsSync(join(DIST, ".srchash"));
if (!built) console.warn("dist/ not built: drift checks skipped, run `bun run build`");

describe.skipIf(!built)("dist/", () => {
  test("dist/.srchash matches the current source tree", () => {
    const recorded = readFileSync(join(DIST, ".srchash"), "utf8").trim();
    expect(recorded).toBe(sourceHash());
  });

  test.each(["hook.js", "cli.js", "server.js", "gate-runner.js"])("dist/%s exists", (name) => {
    expect(existsSync(join(DIST, name))).toBe(true);
  });

  test("dist/web/index.html exists", () => {
    expect(existsSync(join(DIST, "web", "index.html"))).toBe(true);
  });
});
