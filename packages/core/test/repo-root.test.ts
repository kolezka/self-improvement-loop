import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRepositoryRoot } from "../src/repo-root.ts";

let tmp: string;
let main: string;
let linked: string;
let submodule: string;
let lib: string;

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: tmp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function repo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(["add", "a.txt"], dir);
  git(["commit", "-qm", "init"], dir);
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "sil-repo-root-")));
  main = join(tmp, "main");
  lib = join(tmp, "lib");
  repo(main);
  repo(lib);
  linked = join(main, ".claude", "worktrees", "fix");
  git(["worktree", "add", "-q", "-b", "fix", linked], main);
  git(["submodule", "add", "-q", lib, "vendor/lib"], main);
  submodule = join(main, "vendor", "lib");
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("gitRepositoryRoot", () => {
  test("a main checkout resolves to itself, also from a subdirectory", () => {
    mkdirSync(join(main, "src", "deep"), { recursive: true });
    expect(gitRepositoryRoot(main)).toBe(main);
    expect(gitRepositoryRoot(join(main, "src", "deep"))).toBe(main);
  });

  test("a linked worktree maps to its main checkout", () => {
    expect(gitRepositoryRoot(linked)).toBe(main);
    expect(gitRepositoryRoot(linked)).toBe(gitRepositoryRoot(main));
  });

  test("a submodule stays a distinct root", () => {
    expect(gitRepositoryRoot(submodule)).toBe(submodule);
    expect(gitRepositoryRoot(submodule)).not.toBe(gitRepositoryRoot(main));
    expect(gitRepositoryRoot(lib)).toBe(lib);
  });

  test("git failure yields null", () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    expect(gitRepositoryRoot(plain)).toBeNull();
    expect(gitRepositoryRoot(join(tmp, "does-not-exist"))).toBeNull();
  });
});
