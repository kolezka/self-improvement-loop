// The git helpers themselves: how a killed subprocess is reported, and what a
// scratch worktree leaves behind when the body it wraps throws.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_TIMEOUT_MS, isTimeoutSignal, signalMessage } from "../src/git.ts";
import * as git from "../src/git.ts";
import { cleanupEnv, initTarget, makeWorld, silEnv, type TestEnv } from "./fixtures.ts";

let env: TestEnv;

beforeEach(() => {
  env = silEnv();
});
afterEach(() => {
  cleanupEnv(env);
});

describe("a killed git run", () => {
  test("only a SIGTERM at or past the deadline is a timeout", () => {
    // Bun's own spawn timeout kills with SIGTERM, so that pair is the timeout.
    expect(isTimeoutSignal("SIGTERM", DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)).toBe(true);
    expect(isTimeoutSignal("SIGTERM", DEFAULT_TIMEOUT_MS + 5, DEFAULT_TIMEOUT_MS)).toBe(true);
    // An operator's Ctrl-C, an OOM kill, a SIGTERM 12ms in: not a deadline.
    expect(isTimeoutSignal("SIGTERM", 12, DEFAULT_TIMEOUT_MS)).toBe(false);
    expect(isTimeoutSignal("SIGKILL", DEFAULT_TIMEOUT_MS * 2, DEFAULT_TIMEOUT_MS)).toBe(false);
    expect(isTimeoutSignal("SIGINT", 12, DEFAULT_TIMEOUT_MS)).toBe(false);
    expect(isTimeoutSignal(null, DEFAULT_TIMEOUT_MS * 2, DEFAULT_TIMEOUT_MS)).toBe(false);
  });

  test("the message names the signal instead of claiming a timeout", () => {
    const killed = signalMessage(["status", "--porcelain"], "SIGKILL", 12, 60_000);
    expect(killed).toContain("SIGKILL");
    expect(killed).toContain("git status --porcelain");
    expect(killed).not.toContain("timed out");

    expect(signalMessage(["status"], "SIGTERM", 60_000, 60_000)).toContain("timed out after 60000ms");
    expect(signalMessage(["status"], null, 12, 60_000)).toContain("unknown signal");
  });
});

describe("withScratchWorktree", () => {
  const BRANCH = "curriculum/default/boom";

  test("a branch it created is deleted when the body throws", () => {
    // Left behind, the next run checks the failed draft's branch out and lands
    // on top of it, so a draft nobody ever reviewed becomes the base.
    const repo = initTarget(makeWorld());

    expect(() =>
      git.withScratchWorktree(repo, BRANCH, "main", () => {
        throw new Error("the drafter failed");
      }),
    ).toThrow("the drafter failed");

    expect(git.refExists(repo, `refs/heads/${BRANCH}`)).toBe(false);
  });

  test("a branch that already existed survives a throwing body", () => {
    const repo = initTarget(makeWorld());
    git.git(repo, ["branch", BRANCH, "main"]);

    expect(() =>
      git.withScratchWorktree(repo, BRANCH, "main", () => {
        throw new Error("the drafter failed");
      }),
    ).toThrow("the drafter failed");

    expect(git.refExists(repo, `refs/heads/${BRANCH}`)).toBe(true);
  });

  test("a branch it created survives a body that returns", () => {
    const repo = initTarget(makeWorld());

    git.withScratchWorktree(repo, BRANCH, "main", (tree) => {
      git.git(tree, ["commit", "-q", "--allow-empty", "-m", "chore: staged"]);
    });

    expect(git.refExists(repo, `refs/heads/${BRANCH}`)).toBe(true);
  });
});
