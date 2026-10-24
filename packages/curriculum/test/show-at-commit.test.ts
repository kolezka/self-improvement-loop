// showAtCommit: one committed blob, whatever spelling of its layout path, read
// byte for byte; a path that is not there is absent; a path that leaves the
// repository is refused; a failed blob read is an error.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError } from "@sil/core";
import { gitRaw, showAtCommit, treePath } from "../src/git.ts";

let repo: string;
let sha: string;
const BYTES = "line one\r\nline two with ✓\nno newline at the end";

function git(...args: string[]): string {
  const r = gitRaw(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args]);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sil-show-at-commit-"));
  git("init", "-q", "-b", "main");
  mkdirSync(join(repo, "skills", "p"), { recursive: true });
  writeFileSync(join(repo, "skills", "p", "SKILL.md"), BYTES);
  writeFileSync(join(repo, "skills", "*"), "a file literally named star");
  git("add", "-A");
  git("commit", "-q", "-m", "c");
  sha = git("rev-parse", "HEAD");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("showAtCommit", () => {
  test.each(["skills/p/SKILL.md", "./skills/p/SKILL.md", "skills/./p/SKILL.md", "skills/x/../p/SKILL.md"])("%s reads the same bytes", (rel) => {
    expect(showAtCommit(repo, sha, rel)).toEqual({ found: true, text: BYTES });
  });

  test("a path not in the commit is absent, in either spelling", () => {
    expect(showAtCommit(repo, sha, "skills/q/SKILL.md")).toEqual({ found: false, text: "" });
    expect(showAtCommit(repo, sha, "./skills/q/SKILL.md")).toEqual({ found: false, text: "" });
  });

  test("a glob character is a literal name, not a pattern", () => {
    expect(showAtCommit(repo, sha, "skills/*")).toEqual({ found: true, text: "a file literally named star" });
    expect(showAtCommit(repo, sha, "skills/?")).toEqual({ found: false, text: "" });
  });

  test("a path that leaves the repository is refused, not looked up", () => {
    for (const rel of ["../outside", "skills/../../outside", "/etc/passwd", ".", "./"]) {
      expect(treePath(rel)).toBeNull();
      expect(() => showAtCommit(repo, sha, rel)).toThrow(GitError);
    }
  });

  test("a commit git cannot read is an error with a fixed message", () => {
    let thrown: unknown;
    try {
      showAtCommit(repo, "0".repeat(40), "skills/p/SKILL.md");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GitError);
    expect((thrown as Error).message).toMatch(/^git ls-tree failed \(exit \d+\)$/);
  });
});
