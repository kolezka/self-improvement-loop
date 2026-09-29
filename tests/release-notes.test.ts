import { describe, expect, test } from "bun:test";
import { nextVersion, renderChangelog } from "../scripts/release-notes.ts";

describe("nextVersion", () => {
  test("each bump moves exactly one step", () => {
    expect(nextVersion("0.3.10", "patch")).toBe("0.3.11");
    expect(nextVersion("0.3.10", "minor")).toBe("0.4.0");
    expect(nextVersion("0.3.10", "major")).toBe("1.0.0");
  });

  test("refuses anything but the three bump kinds", () => {
    expect(() => nextVersion("0.3.10", "0.4.0")).toThrow();
    expect(() => nextVersion("0.3.10", "Major")).toThrow();
  });

  test("refuses a current version that is not x.y.z", () => {
    expect(() => nextVersion("1.0", "patch")).toThrow();
    expect(() => nextVersion("1.0.0-beta.1", "patch")).toThrow();
  });
});

describe("renderChangelog", () => {
  const commits = [
    { sha: "aaaaaaa", subject: "feat(web): live logs" },
    { sha: "bbbbbbb", subject: "fix(server): cap log reads" },
    { sha: "ccccccc", subject: "feat(review)!: revise needs a digest" },
    { sha: "ddddddd", subject: "docs: release notes" },
    { sha: "eeeeeee", subject: "Merge pull request #55 from kolezka/feat/web-console-ux" },
    { sha: "fffffff", subject: "chore: bump version to 1.0.0" },
    { sha: "0000000", subject: "chore(release): build dist for v1.0.0" },
    { sha: "1111111", subject: "no conventional prefix here" },
  ];

  test("groups by type and drops merges and release bookkeeping", () => {
    const md = renderChangelog("v0.3.10", "0.4.0", commits);
    expect(md).toContain("## Changes since v0.3.10");
    expect(md).toContain("### Breaking\n\n- **review:** revise needs a digest (ccccccc)");
    expect(md).toContain("### Features\n\n- **web:** live logs (aaaaaaa)");
    expect(md).toContain("### Fixes\n\n- **server:** cap log reads (bbbbbbb)");
    expect(md).toContain("### Other\n\n- docs: release notes (ddddddd)\n- no conventional prefix here (1111111)");
    expect(md).not.toContain("Merge pull request");
    expect(md).not.toContain("bump version");
    expect(md).not.toContain("build dist");
  });

  test("a breaking change is listed once, under Breaking only", () => {
    const md = renderChangelog("v0.3.10", "0.4.0", commits);
    expect(md.match(/revise needs a digest/g)).toHaveLength(1);
  });

  test("first release has no previous tag", () => {
    expect(renderChangelog(null, "0.1.0", commits)).toContain("## Changes in 0.1.0");
  });

  test("nothing to list says so instead of printing empty headings", () => {
    const md = renderChangelog("v1.0.0", "1.0.1", [{ sha: "fffffff", subject: "chore: bump version to 1.0.0" }]);
    expect(md).toContain("No changes since v1.0.0.");
    expect(md).not.toContain("###");
  });
});
