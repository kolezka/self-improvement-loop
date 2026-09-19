// The version lives in many manifests and the release workflow bumps them in
// one shot. These tests lock the bump arithmetic and the "all manifests agree"
// invariant, so a partial bump fails here instead of at install time.

import { describe, expect, test } from "bun:test";
import { currentVersion, manifestPaths, nextVersion, readVersion } from "../scripts/version.ts";

describe("version manifests", () => {
  test("every manifest carries the root version", () => {
    const root = currentVersion();
    expect(root).toMatch(/^\d+\.\d+\.\d+$/);
    for (const p of manifestPaths()) expect([p, readVersion(p)]).toEqual([p, root]);
  });

  test("plugin.json is in the set", () => {
    expect(manifestPaths().some((p) => p.endsWith("/.claude-plugin/plugin.json"))).toBe(true);
  });
});

describe("nextVersion", () => {
  test.each([
    ["1.2.3", "patch", "1.2.4"],
    ["1.2.3", "minor", "1.3.0"],
    ["1.2.3", "major", "2.0.0"],
    ["1.2.3", "9.0.0", "9.0.0"],
  ])("%s + %s = %s", (current, bump, want) => {
    expect(nextVersion(current, bump)).toBe(want);
  });

  test("rejects a bump that is neither a keyword nor a version", () => {
    expect(() => nextVersion("1.2.3", "next")).toThrow();
  });
});
