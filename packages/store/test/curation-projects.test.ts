// Project identity for curation: world first, canonical Git roots through the
// shared resolver, configured roots as ownership prefixes, explicit choices
// for the web, and one scope validator for later writes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Config, Lesson, paths } from "@sil/core";
import type { World } from "@sil/core";
import { gitRepositoryRoot, probeGitRepositoryRoot } from "@sil/core/repo-root";
import type { GitRunResult } from "@sil/core/repo-root";
import type { LessonScope, StoreBinding } from "@sil/core/lesson-curation";
import {
  CURATION_GIT_PROBE,
  GitProbeError,
  browseCuratedLessons,
  curationLocationId,
  getCuratedLesson,
  listCurationProjects,
  projectIdForRoot,
  readLegacySource,
  resolveCurationContext,
  validateCurationScope,
} from "../src/index.ts";
import { createCurationFixture, useFixtureEnv } from "../../../tests/curation-fixture.ts";
import type { CurationFixture } from "../../../tests/curation-fixture.ts";
import { apply, captureKey, inboxKey, mutation, openStore, rejection, worldScope } from "./curation-mutation-helpers.ts";

let fx: CurationFixture;
let restoreEnv: () => void;
let repos: string;

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: fx.env,
  });
  if (!r.success) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(["add", "a.txt"], dir);
  git(["commit", "-qm", "init"], dir);
  return dir;
}

function configWith(worlds: Array<Record<string, unknown>>): Config {
  return Config.parse({ worlds, worker: { auto_kick: false } });
}

function worldIn(cfg: Config, name: string): World {
  return cfg.worlds.find((w) => w.name === name)!;
}

const binding = (): StoreBinding => ({ kind: "location", id: curationLocationId() });
const project = (world: string, root: string): LessonScope => ({ world, project: { kind: "project", id: projectIdForRoot(root) } });

function writeSource(world: string, id: string, repoPath: string | null): void {
  const dir = paths.inboxDir(world);
  mkdirSync(dir, { recursive: true });
  const lesson = Lesson.parse({ id, world, pattern: "p", text: `text ${id}`, created: "2026-10-01T00:00:00.000Z", repo: repoPath });
  writeFileSync(join(dir, `${paths.safeComponent(id)}.json`), JSON.stringify(lesson));
}

beforeEach(() => {
  fx = createCurationFixture();
  restoreEnv = useFixtureEnv(fx);
  repos = join(fx.root, "repos");
  mkdirSync(repos);
});

afterEach(() => {
  restoreEnv();
  fx.cleanup();
});

describe("project identity", () => {
  test("a project id is p1_ plus sha256 of the canonical root", () => {
    const root = "/some/canonical/root";
    expect(projectIdForRoot(root)).toBe(`p1_${createHash("sha256").update(root, "utf8").digest("hex")}`);
  });

  test("main checkout and linked worktree share a project; clones and submodules do not", () => {
    const main = repo(join(repos, "main"));
    const lib = repo(join(repos, "lib"));
    const linked = join(main, ".claude", "worktrees", "fix");
    git(["worktree", "add", "-q", "-b", "fix", linked], main);
    git(["submodule", "add", "-q", lib, "vendor/lib"], main);
    const clone = join(repos, "clone");
    git(["clone", "-q", main, clone], repos);
    const cfg = configWith([{ name: "w", repos: [repos] }]);
    const w = worldIn(cfg, "w");

    const at = (cwd: string) => {
      const ctx = resolveCurationContext(cwd, w, cfg);
      if (ctx.state !== "resolved") throw new Error(`expected resolved for ${cwd}: ${JSON.stringify(ctx)}`);
      return ctx;
    };
    expect(at(main).project).toEqual({ world: "w", projectId: projectIdForRoot(main), root: main });
    expect(at(join(linked)).scope).toEqual(project("w", main));
    expect(at(join(main, "vendor", "lib")).scope).toEqual(project("w", join(main, "vendor", "lib")));
    expect(at(clone).scope).toEqual(project("w", clone));
    expect(at(clone).scope).not.toEqual(at(main).scope);
    expect(at(main).worldMatch).toBe("configured");
    expect(at(main).requiresConfirmation).toBe(false);

    // A legacy source recorded from the worktree maps to the main project.
    writeSource("w", "from-worktree", linked);
    writeSource("w", "from-main", main);
    const page = browseCuratedLessons({ scope: project("w", main), collection: "all" }, binding(), { config: cfg }).value;
    expect(page.items.map((item) => item.key.id).sort()).toEqual(["from-main", "from-worktree"]);
  });

  test("a world that owns a subdirectory of a larger repository keeps the Git root as its project", () => {
    const big = repo(join(repos, "big"));
    const sub = join(big, "packages", "sub");
    mkdirSync(join(sub, "src"), { recursive: true });
    const cfg = configWith([
      { name: "sub-world", repos: [sub] },
      { name: "big-world", repos: [big] },
    ]);
    // Ownership prefixes decide the world, not the project: both worlds see the Git root.
    const ctx = resolveCurationContext(join(sub, "src"), worldIn(cfg, "sub-world"), cfg);
    expect(ctx).toMatchObject({ state: "resolved", scope: project("sub-world", big), project: { root: big } });
    const bigCtx = resolveCurationContext(big, worldIn(cfg, "big-world"), cfg);
    expect(bigCtx).toMatchObject({ state: "resolved", scope: project("big-world", big) });
    expect(resolveCurationContext(big, worldIn(cfg, "sub-world"), cfg).state).toBe("choice_required");

    // The critic recorded the Git root of a session inside the subdirectory.
    writeSource("sub-world", "recorded-big", big);
    const page = browseCuratedLessons({ scope: project("sub-world", big), collection: "all" }, binding(), { config: cfg }).value;
    expect(page.items.map((item) => item.key.id)).toEqual(["recorded-big"]);
    // A save revalidates that ancestor root through the owned prefix.
    const w = worldIn(cfg, "sub-world");
    expect(validateCurationScope({ world: w, config: cfg, scope: project("sub-world", big), key: captureKey("sub-world"), projectRoot: big })).toEqual(
      project("sub-world", big),
    );
  });

  test("adding a nested ownership prefix in the same repository and world does not change the project", () => {
    const main = repo(join(repos, "main"));
    const sub = join(main, "owned-subdir");
    mkdirSync(sub);
    const before = configWith([{ name: "w", repos: [main] }]);
    const after = configWith([{ name: "w", repos: [main, sub] }]);
    const ctxBefore = resolveCurationContext(sub, worldIn(before, "w"), before);
    const ctxAfter = resolveCurationContext(sub, worldIn(after, "w"), after);
    if (ctxBefore.state !== "resolved" || ctxAfter.state !== "resolved") throw new Error("expected resolved contexts");
    expect(ctxAfter.project).toEqual(ctxBefore.project);
    expect(ctxAfter.project.root).toBe(main);

    // A legacy source whose critic repo is the actual Git root is accepted in that scope.
    writeSource("w", "legacy", main);
    const source = readLegacySource(inboxKey("w", "legacy"));
    expect(validateCurationScope({ world: worldIn(after, "w"), config: after, scope: ctxAfter.scope, key: inboxKey("w", "legacy"), source })).toEqual(
      ctxAfter.scope,
    );
  });

  test("several owned subdirectories of one Git root are one project, not an ambiguity", () => {
    const big = repo(join(repos, "big"));
    const a = join(big, "a");
    const b = join(big, "b");
    mkdirSync(a);
    mkdirSync(b);
    const cfg = configWith([{ name: "w", repos: [a, b] }]);
    const w = worldIn(cfg, "w");
    const at = (cwd: string) => resolveCurationContext(cwd, w, cfg);
    expect(at(a)).toMatchObject({ state: "resolved", scope: project("w", big) });
    expect(at(b)).toMatchObject({ state: "resolved", scope: project("w", big) });
    writeSource("w", "from-big", big);
    const detail = getCuratedLesson(project("w", big), inboxKey("w", "from-big"), binding(), { config: cfg }).value!;
    expect(detail.lesson.scope).toEqual(project("w", big));
    expect(detail.diagnostics.filter((d) => d.code === "repo_unresolved")).toEqual([]);
    const choices = listCurationProjects(w, binding(), { config: cfg }).value.filter((c) => c.scope.project.kind === "project");
    expect(choices.map((c) => c.root)).toEqual([big]);
  });

  test("a root above the ownership prefix flows from context into capture and annotation validation unchanged", () => {
    const big = repo(join(repos, "big"));
    for (const layout of [["one"], ["a", "b"]]) {
      const owned = layout.map((name) => join(big, name));
      for (const dir of owned) mkdirSync(join(dir, "src"), { recursive: true });
      const cfg = configWith([{ name: "w", repos: owned }]);
      const w = worldIn(cfg, "w");
      const probed: string[] = [];
      const git = {
        ...CURATION_GIT_PROBE,
        run: (args: string[], cwd: string, env: Record<string, string> | undefined, timeoutMs: number): GitRunResult => {
          probed.push(cwd);
          const r = Bun.spawnSync(["git", ...args], { cwd, env, timeout: timeoutMs, stdout: "pipe", stderr: "pipe" });
          return r.success ? { kind: "ok", stdout: r.stdout.toString("utf8").trim() } : { kind: "exit", code: r.exitCode, stderr: r.stderr.toString("utf8") };
        },
      };
      for (const dir of owned) {
        const ctx = resolveCurationContext(join(dir, "src"), w, cfg, git);
        if (ctx.state !== "resolved") throw new Error(`expected resolved for ${layout.join(",")}`);
        expect(ctx.project).toEqual({ world: "w", projectId: projectIdForRoot(big), root: big });

        // New capture: the descriptor's root is revalidated, its id kept.
        probed.length = 0;
        expect(validateCurationScope({ world: w, config: cfg, scope: ctx.scope, key: captureKey("w"), projectRoot: ctx.project.root, git })).toEqual(ctx.scope);
        // Legacy annotation: a critic source recording the same Git root lands in the same scope.
        writeSource("w", "legacy-big", big);
        const source = readLegacySource(inboxKey("w", "legacy-big"));
        expect(validateCurationScope({ world: w, config: cfg, scope: ctx.scope, key: inboxKey("w", "legacy-big"), source, git })).toEqual(ctx.scope);
        // The unowned root itself is never probed; only owned prefixes are.
        expect(probed.length).toBeGreaterThan(0);
        expect(probed.filter((cwd) => cwd === big)).toEqual([]);
        expect(probed.every((cwd) => owned.some((o) => cwd === o || cwd.startsWith(`${o}/`)))).toBe(true);
      }
    }
  });

  test("a native project newly found under a broad prefix comes back as a descriptor a save can revalidate", () => {
    const fresh = repo(join(repos, "fresh"));
    const cfg = configWith([{ name: "w", repos: [repos] }]);
    const w = worldIn(cfg, "w");
    const ctx = resolveCurationContext(join(fresh), w, cfg);
    if (ctx.state !== "resolved") throw new Error("expected resolved");
    const scope = validateCurationScope({ world: w, config: cfg, scope: ctx.scope, key: captureKey("w"), projectRoot: ctx.project.root });
    expect(scope).toEqual(ctx.scope);
    // Nothing was persisted by the read.
    expect(listCurationProjects(w, binding(), { config: cfg }).value.some((choice) => choice.root === fresh)).toBe(false);
  });

  test("a catch-all world needs confirmation, and a non-Git cwd needs an explicit choice", () => {
    const outside = repo(join(repos, "elsewhere"));
    const plain = join(repos, "plain");
    mkdirSync(plain);
    const cfg = configWith([
      { name: "owned", repos: [fx.projectRoot] },
      { name: "fallback", repos: [] },
    ]);
    const ctx = resolveCurationContext(outside, worldIn(cfg, "fallback"), cfg);
    expect(ctx).toMatchObject({ state: "resolved", worldMatch: "catch_all", requiresConfirmation: true, scope: project("fallback", outside) });
    expect(resolveCurationContext(plain, worldIn(cfg, "fallback"), cfg)).toMatchObject({ state: "choice_required", reason: "no_project_root" });
    expect(resolveCurationContext(outside, worldIn(cfg, "owned"), cfg)).toMatchObject({ state: "choice_required", reason: "outside_world" });
    // A configured non-Git root is its own project.
    expect(resolveCurationContext(fx.projectRoot, worldIn(cfg, "owned"), cfg)).toMatchObject({
      state: "resolved",
      scope: project("owned", fx.projectRoot),
    });
  });

  test("an empty or relative cwd is refused instead of meaning the current directory", () => {
    const cfg = configWith([{ name: "w", repos: [repos] }]);
    for (const cwd of ["", ".", "relative/path"]) {
      expect(rejection(() => resolveCurationContext(cwd, worldIn(cfg, "w"), cfg)).code).toBe("INVALID_INPUT");
    }
    const unknown = { ...worldIn(cfg, "w"), name: "not-configured" };
    expect(rejection(() => resolveCurationContext(repos, unknown, cfg)).code).toBe("INVALID_INPUT");
  });
});

describe("legacy source scopes", () => {
  test("repo null is world-wide; missing, relative and other-world repos stay unresolved", () => {
    const owned = repo(join(repos, "owned"));
    const foreign = repo(join(fx.root, "foreign"));
    const cfg = configWith([
      { name: "w", repos: [repos] },
      { name: "x", repos: [foreign] },
    ]);
    writeSource("w", "world-wide", null);
    writeSource("w", "owned", owned);
    writeSource("w", "gone", join(repos, "deleted-repo"));
    writeSource("w", "empty", "");
    writeSource("w", "relative", "some/relative");
    writeSource("w", "cross-world", foreign);
    const read = (scope: LessonScope) =>
      browseCuratedLessons({ scope, collection: "all" }, binding(), { config: cfg })
        .value.items.map((item) => item.key.id)
        .sort();

    expect(read(worldScope("w"))).toEqual(["world-wide"]);
    expect(read(project("w", owned))).toEqual(["owned"]);
    expect(read({ world: "w", project: { kind: "unresolved" } })).toEqual(["cross-world", "empty", "gone", "relative"]);
    const reasons = Object.fromEntries(
      ["gone", "empty", "relative", "cross-world"].map((id) => {
        const detail = getCuratedLesson({ world: "w", project: { kind: "unresolved" } }, inboxKey("w", id), binding(), { config: cfg }).value!;
        return [id, detail.diagnostics.find((d) => d.code === "repo_unresolved")];
      }),
    );
    expect(reasons).toEqual({
      gone: { code: "repo_unresolved", reason: "missing_root" },
      empty: { code: "repo_unresolved", reason: "relative_path" },
      relative: { code: "repo_unresolved", reason: "relative_path" },
      "cross-world": { code: "repo_unresolved", reason: "not_owned_by_world" },
    });
    // The other world's lesson store is never read for this world.
    writeSource("x", "x-only", foreign);
    expect(read(worldScope("w"))).toEqual(["world-wide"]);
  });

  test("a non-Git ancestor of an owned root is not accepted as that project's source", () => {
    const cfg = configWith([{ name: "w", repos: [fx.projectRoot] }]);
    const w = worldIn(cfg, "w");
    const ctx = resolveCurationContext(fx.projectRoot, w, cfg);
    if (ctx.state !== "resolved") throw new Error("configured-root positive control failed");
    writeSource("w", "ancestor", fx.root);
    const source = readLegacySource(inboxKey("w", "ancestor"));
    expect(rejection(() => validateCurationScope({ world: w, config: cfg, scope: ctx.scope, key: inboxKey("w", "ancestor"), source })).code).toBe("SCOPE_CONFLICT");
    const detail = getCuratedLesson({ world: "w", project: { kind: "unresolved" } }, inboxKey("w", "ancestor"), binding(), { config: cfg }).value!;
    expect(detail.diagnostics).toContainEqual({ code: "repo_unresolved", reason: "not_owned_by_world" });
  });

  test("Git never runs in a source path the world does not own", () => {
    const foreign = repo(join(fx.root, "foreign"));
    const cfg = configWith([
      { name: "w", repos: [repos] },
      { name: "x", repos: [foreign] },
    ]);
    writeSource("w", "cross-world", foreign);
    const probed: string[] = [];
    browseCuratedLessons({ scope: worldScope("w"), collection: "all" }, binding(), {
      config: cfg,
      git: { ...CURATION_GIT_PROBE, run: (_args, cwd) => (probed.push(cwd), { kind: "exit", code: 128, stderr: "fatal: not a git repository" }) },
    });
    expect(probed.filter((cwd) => cwd.startsWith(foreign))).toEqual([]);
  });

  test("a missing historical root maps through an already recorded canonical mapping", () => {
    const gone = join(repos, "moved-away");
    const cfg = configWith([{ name: "w", repos: [repos] }]);
    writeSource("w", "first", gone);
    writeSource("w", "second", gone);
    const db = openStore();
    try {
      // An earlier capture under that exact canonical root, saved while it existed.
      const capture = captureKey("w");
      apply(
        db,
        mutation(db, capture, { kind: "capture", text: "Saved while the repo existed.", source: { kind: "explicit_quote", quote: "q", reference: null, quoteRedacted: false, captureSessionId: null, sourceConversationId: null, sourceRowId: null, sourceAgentId: null } }, 0, {
          scope: project("w", gone),
        }),
        null,
      );
      const ids = browseCuratedLessons({ scope: project("w", gone), collection: "all" }, { kind: "installation", id: db.installationId }, { config: cfg })
        .value.items.map((item) => item.key.id)
        .sort();
      expect(ids).toEqual([capture.id, "first", "second"].sort());
    } finally {
      db.close();
    }
  });
});

describe("project choices", () => {
  test("choices come from configured roots, same-world sources and stored scopes, with honest labels", () => {
    const owned = repo(join(repos, "owned"));
    const cfg = configWith([{ name: "w", repos: [repos, join(fx.root, "missing-root")] }]);
    const w = worldIn(cfg, "w");
    writeSource("w", "src-owned", owned);
    writeSource("w", "src-gone", join(repos, "gone"));
    const stored = `p1_${"c".repeat(64)}`;
    const db = openStore();
    try {
      apply(
        db,
        mutation(db, captureKey("w"), { kind: "capture", text: "Stored elsewhere.", source: { kind: "explicit_quote", quote: "q", reference: null, quoteRedacted: false, captureSessionId: null, sourceConversationId: null, sourceRowId: null, sourceAgentId: null } }, 0, {
          scope: { world: "w", project: { kind: "project", id: stored } },
        }),
        null,
      );
      const result = listCurationProjects(w, { kind: "installation", id: db.installationId }, { config: cfg });
      expect(result.store.installationId).toBe(db.installationId);
      const choices = result.value;
      expect(choices[0]).toEqual({ scope: worldScope("w"), label: "World-wide", root: null, available: true, origins: [] });
      expect(choices.at(-1)).toMatchObject({ scope: { world: "w", project: { kind: "unresolved" } }, label: "Unresolved", root: null });
      const byId = new Map(choices.filter((c) => c.scope.project.kind === "project").map((c) => [(c.scope.project as { id: string }).id, c]));
      expect(byId.get(projectIdForRoot(repos))).toMatchObject({ root: repos, available: true, origins: ["configured"] });
      expect(byId.get(projectIdForRoot(owned))).toMatchObject({ root: owned, available: true, origins: ["source"] });
      expect(byId.get(projectIdForRoot(join(fx.root, "missing-root")))).toMatchObject({ root: null, available: false, origins: ["configured"] });
      expect(byId.get(stored)).toMatchObject({ root: null, available: false, origins: ["stored"] });
      expect(byId.get(stored)!.label).toContain("Unavailable project");
      // Each scope appears once.
      expect(new Set(choices.map((c) => JSON.stringify(c.scope))).size).toBe(choices.length);
    } finally {
      db.close();
    }
  });
});

describe("scope validation for writes", () => {
  test("capture needs a configured or world-wide scope, and a project id must match its revalidated root", () => {
    const owned = repo(join(repos, "owned"));
    const other = repo(join(repos, "other"));
    const cfg = configWith([{ name: "w", repos: [repos] }]);
    const w = worldIn(cfg, "w");
    const key = captureKey("w");
    expect(validateCurationScope({ world: w, config: cfg, scope: worldScope("w"), key })).toEqual(worldScope("w"));
    expect(rejection(() => validateCurationScope({ world: w, config: cfg, scope: { world: "w", project: { kind: "unresolved" } }, key })).code).toBe(
      "INVALID_INPUT",
    );
    expect(rejection(() => validateCurationScope({ world: w, config: cfg, scope: project("w", owned), key })).code).toBe("INVALID_INPUT");
    expect(rejection(() => validateCurationScope({ world: w, config: cfg, scope: project("w", owned), key, projectRoot: other })).code).toBe(
      "SCOPE_CONFLICT",
    );
    expect(validateCurationScope({ world: w, config: cfg, scope: project("w", owned), key, projectRoot: join(owned) })).toEqual(project("w", owned));
    expect(rejection(() => validateCurationScope({ world: w, config: cfg, scope: worldScope("x"), key })).code).toBe("SCOPE_CONFLICT");
  });

  test("a first annotation must target the scope its source maps to", () => {
    const owned = repo(join(repos, "owned"));
    const cfg = configWith([{ name: "w", repos: [repos] }]);
    const w = worldIn(cfg, "w");
    writeSource("w", "src", owned);
    const key = inboxKey("w", "src");
    const source = readLegacySource(key);
    expect(validateCurationScope({ world: w, config: cfg, scope: project("w", owned), key, source })).toEqual(project("w", owned));
    expect(rejection(() => validateCurationScope({ world: w, config: cfg, scope: worldScope("w"), key, source })).code).toBe("SCOPE_CONFLICT");
    expect(rejection(() => validateCurationScope({ world: w, config: cfg, scope: project("w", owned), key, source: null })).code).toBe(
      "SOURCE_CONFLICT",
    );
  });
});

describe("git probes", () => {
  test("curation probes pass an explicit safe env and config overrides; the default stays unchanged", () => {
    const main = repo(join(repos, "main"));
    const calls: Array<{ args: string[]; env: Record<string, string> | undefined }> = [];
    const root = gitRepositoryRoot(main, {
      ...CURATION_GIT_PROBE,
      run: (args, cwd, env, timeoutMs) => {
        calls.push({ args, env });
        const r = Bun.spawnSync(["git", ...args], { cwd, env, timeout: timeoutMs, stdout: "pipe", stderr: "pipe" });
        return r.success ? { kind: "ok", stdout: r.stdout.toString("utf8").trim() } : { kind: "exit", code: r.exitCode, stderr: r.stderr.toString("utf8") };
      },
    });
    expect(root).toBe(realpathSync(main));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.env?.["GIT_OPTIONAL_LOCKS"]).toBe("0");
      expect(call.env?.["GIT_CONFIG_NOSYSTEM"]).toBe("1");
      expect(call.env?.["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
      expect(call.env?.["HOME"]).toBeUndefined();
      expect(call.args.slice(0, 4)).toEqual(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]);
    }
    // The critic's call shape (no options) still resolves the same root.
    expect(gitRepositoryRoot(main)).toBe(main);
  });
});

describe("git probe failures", () => {
  const exitWith = (code: number, stderr: string): GitRunResult => ({ kind: "exit", code, stderr });

  test("a genuine non-Git directory under a configured root resolves to that root", () => {
    const plain = join(repos, "plain");
    mkdirSync(plain);
    const cfg = configWith([{ name: "w", repos: [repos] }]);
    expect(resolveCurationContext(plain, worldIn(cfg, "w"), cfg)).toMatchObject({ state: "resolved", scope: project("w", repos) });
  });

  test("a missing git executable fails visibly instead of guessing the broader prefix", () => {
    const main = repo(join(repos, "main"));
    const cfg = configWith([{ name: "w", repos: [repos] }]);
    const w = worldIn(cfg, "w");
    // Positive control: the same repository resolves with a working probe.
    expect(resolveCurationContext(main, w, cfg)).toMatchObject({ state: "resolved", project: { root: main } });
    const noGit = { ...CURATION_GIT_PROBE, env: { ...CURATION_GIT_PROBE.env, PATH: join(fx.root, "missing-bin") } };
    // Instrument check: git is really unavailable under that PATH.
    expect(() => Bun.spawnSync(["git", "--version"], { env: noGit.env, stdout: "pipe", stderr: "pipe" })).toThrow();
    const error = rejection(() => resolveCurationContext(main, w, cfg, noGit));
    expect(error).toBeInstanceOf(GitProbeError);
    expect((error as GitProbeError).reason).toBe("spawn_failed");
    expect(error.code).toBe("STORAGE_UNAVAILABLE");
    // A browse that needs the probe for a source repo fails the same way.
    writeSource("w", "src", main);
    expect(rejection(() => browseCuratedLessons({ scope: worldScope("w"), collection: "all" }, binding(), { config: cfg, git: noGit }))).toBeInstanceOf(
      GitProbeError,
    );
    // The critic's default helper keeps its old answer: null.
    expect(gitRepositoryRoot(main, noGit)).toBeNull();
  });

  test("nested configured non-Git roots make a cwd ambiguous, while an explicit choice of either stays valid", () => {
    const outer = join(repos, "outer");
    const inner = join(outer, "inner");
    mkdirSync(join(inner, "deep"), { recursive: true });
    const cfg = configWith([{ name: "w", repos: [outer, inner] }]);
    const w = worldIn(cfg, "w");
    expect(resolveCurationContext(join(inner, "deep"), w, cfg)).toMatchObject({ state: "choice_required", reason: "ambiguous_root" });
    expect(resolveCurationContext(outer, w, cfg)).toMatchObject({ state: "resolved", scope: project("w", outer) });
    for (const root of [outer, inner]) {
      expect(validateCurationScope({ world: w, config: cfg, scope: project("w", root), key: captureKey("w"), projectRoot: root })).toEqual(project("w", root));
    }
    const roots = listCurationProjects(w, binding(), { config: cfg }).value.flatMap((c) => (c.root === null ? [] : [c.root]));
    expect(roots.sort()).toEqual([inner, outer].sort());
  });

  test("a timeout or another git error fails visibly; only 'not a git repository' means non-Git", () => {
    const plain = join(repos, "plain");
    mkdirSync(plain);
    const cfg = configWith([{ name: "w", repos: [repos] }]);
    const w = worldIn(cfg, "w");
    const withRun = (result: GitRunResult) => ({ ...CURATION_GIT_PROBE, run: () => result });
    const timeout = rejection(() => resolveCurationContext(plain, w, cfg, withRun({ kind: "error", reason: "timeout" })));
    expect((timeout as GitProbeError).reason).toBe("timeout");
    const dubious = rejection(() => resolveCurationContext(plain, w, cfg, withRun(exitWith(128, "fatal: detected dubious ownership in repository"))));
    expect((dubious as GitProbeError).reason).toBe("git_error");
    const crashed = rejection(() => resolveCurationContext(plain, w, cfg, withRun(exitWith(1, ""))));
    expect((crashed as GitProbeError).reason).toBe("git_error");
    expect(resolveCurationContext(plain, w, cfg, withRun(exitWith(128, "fatal: not a git repository (or any of the parent directories): .git")))).toMatchObject({
      state: "resolved",
      scope: project("w", repos),
    });
    expect(probeGitRepositoryRoot(plain, withRun(exitWith(128, "fatal: not a git repository")))).toEqual({ state: "not_repository" });
  });
});
