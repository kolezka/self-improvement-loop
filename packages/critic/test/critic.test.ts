import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AliasSemanticConfig, fsx, paths, SECTIONS, type Config, type LlmConfig, type QueueEntry, type World } from "@sil/core";
import { listLessons, listReflections } from "@sil/store";
import type { ChatMessage } from "@sil/providers";
import { installedArtifacts, parseAnswer, reflectSession } from "../src/index.ts";
import { setSilDirs, restoreEnv, writeSampleTranscript } from "../../transcript/test/fixture.ts";

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sil-critic-"));
  savedEnv = setSilDirs(tmpDir);
});

afterEach(() => {
  restoreEnv(savedEnv);
  rmSync(tmpDir, { recursive: true, force: true });
});

function entry(sessionId = "sess-1", world = "default"): QueueEntry {
  const cwd = join(tmpDir, "session");
  const transcriptPath = writeSampleTranscript(cwd, sessionId);
  return {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    world,
    git_head: "abc123",
    first_stop: "2026-09-14T10:00:00Z",
    last_stop: "2026-09-14T10:05:00Z",
    stops: 1,
    ended: true,
    tool_uses: 3,
    attempts: 0,
    result: null,
  };
}

function goodAnswer(pattern = "verify-callsites"): string {
  return JSON.stringify({
    record: true,
    pattern,
    what_worked: "Ran the full test suite before editing.",
    what_failed: "Missed one call site on the first pass.",
    lesson: "Grep every call site before renaming a shared symbol.",
    verification: "Ran: pytest -q -> exit 0, 12 passed",
    not_verified: ["performance impact not measured"],
    lesson_short: "Grep all call sites before renaming a shared symbol.",
    confidence: 0.8,
    artifacts_used: ["skill:debugging"],
    artifacts_helpful: ["skill:debugging"],
    artifacts_misfired: [],
    rules_relevant: [],
  });
}

function world(name = "default"): World {
  return {
    name,
    llm: "cloud",
    repos: [],
    target: null,
    layout: { skills_dir: "skills", nudges_dir: "nudges", agents_dir: "agents", rules_file: "RULES.md", ledger: "promotions.json" },
    remote: "none",
    rules_inject: true,
    outline: null,
    llm_config: null,
  };
}

function cfg(w: World): Config {
  return { version: 1, worlds: [w], promotion: { threshold: 3, per_run_cap: 3, max_rule_chars: 500, auto_merge: false, retire_after_days: 45 }, worker: { idle_minutes: 10, curriculum_interval_minutes: 60, min_tool_uses: 6, auto_kick: true }, web: { port: 8766, host: "127.0.0.1", allowed_hosts: [] }, alias_semantic: AliasSemanticConfig.parse({}) };
}

function llm(): LlmConfig {
  return {
    endpoints: [{ name: "test", kind: "openai", base_url: "http://test", api_key_env: null, timeout_s: 240, models: {}, extra_body: {}, decision_threshold: 0.5, effort: null }],
    active: "test",
    role_endpoints: {},
    local_models: [],
    models: { critic: "test-model" },
  };
}

// --- parseAnswer -----------------------------------------------------------

describe("parseAnswer", () => {
  test("tolerates a code fence", () => {
    const text = "```json\n" + goodAnswer() + "\n```";
    const answer = parseAnswer(text);
    expect(answer.record).toBe(true);
    expect(answer.pattern).toBe("verify-callsites");
  });

  test("rejects a non-slug pattern", () => {
    const text = JSON.stringify({ record: true, pattern: "Not A Slug!", lesson: "x" });
    const answer = parseAnswer(text);
    expect(answer.record).toBe(false);
    expect(answer.pattern).toBeNull();
    expect(answer.reason).toBeTruthy();
  });

  test("rejects non-JSON", () => {
    const answer = parseAnswer("not json at all");
    expect(answer.record).toBe(false);
    expect(answer.pattern).toBeNull();
  });

  test("not_verified never iterates a non-list", () => {
    const text = JSON.stringify({ record: false, pattern: null, not_verified: "single reason" });
    const answer = parseAnswer(text);
    expect(answer.not_verified).toEqual([]);
  });
});

// --- reflectSession: recorded path ------------------------------------------

describe("reflectSession recorded path", () => {
  test("writes reflection, feedback and lesson", async () => {
    const w = world();
    const c = cfg(w);
    const e = entry();

    const fakeChat = async (role: string, _messages: ChatMessage[], opts: { jsonMode?: boolean }) => {
      expect(role).toBe("critic");
      expect(opts.jsonMode).toBe(true);
      return goodAnswer();
    };

    const result = await reflectSession(e, { cfg: c, world: w, llm: llm(), chat: fakeChat });

    expect(result.recorded).toBe(true);
    expect(result.pattern).toBe("verify-callsites");
    expect(result.path).toBeTruthy();
    expect(fsx.exists(result.path!)).toBe(true);

    const text = fsx.readText(result.path!);
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("\nPattern: verify-callsites\n");
    for (const heading of SECTIONS) expect(text).toContain(heading);

    const fbLines = fsx.readJsonl<{ ref: string; verdict: string }>(paths.criticFeedbackFile());
    const verdicts = new Set(fbLines.map((l) => `${l.ref}:${l.verdict}`));
    expect(verdicts.has("skill:debugging:used")).toBe(true);
    expect(verdicts.has("skill:debugging:helpful")).toBe(true);

    const lessons = listLessons("default");
    expect(lessons.length).toBe(1);
    expect(lessons[0]!.id).toBe(result.reflection_id!);
    expect(lessons[0]!.text).toBe("Grep all call sites before renaming a shared symbol.");
  });

  test("appends misfired feedback with reason", async () => {
    const w = world();
    const c = cfg(w);
    const e = entry();

    const answer = JSON.parse(goodAnswer());
    answer.artifacts_misfired = [{ ref: "hook:noisy-thing", reason: "fired on an unrelated file" }];

    const fakeChat = async () => JSON.stringify(answer);

    await reflectSession(e, { cfg: c, world: w, llm: llm(), chat: fakeChat });

    const fbLines = fsx.readJsonl<{ ref: string; verdict: string; reason?: string }>(paths.criticFeedbackFile());
    const misfired = fbLines.find((l) => l.verdict === "misfired")!;
    expect(misfired.ref).toBe("hook:noisy-thing");
    expect(misfired.reason).toBe("fired on an unrelated file");
  });
});

// --- reflectSession: record false path --------------------------------------

describe("reflectSession record false path", () => {
  test("writes nothing", async () => {
    const w = world();
    const c = cfg(w);
    const e = entry();

    const fakeChat = async () => JSON.stringify({ record: false, pattern: null });

    const result = await reflectSession(e, { cfg: c, world: w, llm: llm(), chat: fakeChat });

    expect(result.recorded).toBe(false);
    expect(result.reflection_id).toBeNull();
    expect(result.path).toBeNull();
    expect(fsx.exists(paths.criticFeedbackFile())).toBe(false);
    expect(listLessons("default")).toEqual([]);
  });

  test("low confidence records reflection but not a lesson", async () => {
    const w = world();
    const c = cfg(w);
    const e = entry();

    const answer = JSON.parse(goodAnswer());
    answer.confidence = 0.1;
    const fakeChat = async () => JSON.stringify(answer);

    const result = await reflectSession(e, { cfg: c, world: w, llm: llm(), chat: fakeChat });

    expect(result.recorded).toBe(true);
    expect(listLessons("default")).toEqual([]);
  });
});

// --- no env vars or transcript_path reach the model -------------------------

describe("reflectSession never leaks secrets", () => {
  test("no env var value or transcript_path in any message", async () => {
    process.env["LITELLM_API_KEY"] = "sk-sentinel-value-should-not-leak";
    const w = world();
    const c = cfg(w);
    const e = entry();

    let captured: ChatMessage[] = [];
    const fakeChat = async (_role: string, messages: ChatMessage[]) => {
      captured = messages;
      return goodAnswer();
    };

    await reflectSession(e, { cfg: c, world: w, llm: llm(), chat: fakeChat });

    const serialized = JSON.stringify(captured);
    expect(serialized).not.toContain("sk-sentinel-value-should-not-leak");
    expect(serialized).not.toContain("LITELLM_API_KEY");
    expect(serialized).not.toContain(e.transcript_path);
    delete process.env["LITELLM_API_KEY"];
  });
});

// --- installedArtifacts ------------------------------------------------------

describe("installedArtifacts", () => {
  test("reads promoted ledger entries", async () => {
    const w = world();
    const c = cfg(w);
    const { saveLedger } = await import("@sil/store");
    const { ledgerPath } = await import("@sil/core");
    const ledger = {
      version: 1,
      entries: {
        "good-skill": { pattern: "good-skill", promoted_at_count: 3, rejected_at_count: 0, status: "promoted" as const, artifact_type: "skill" as const, served_by: null, last_updated: "2026-09-14T10:00:00Z", promoted_at: null, commit: null, feedback: null },
        "staged-thing": { pattern: "staged-thing", promoted_at_count: 1, rejected_at_count: 0, status: "staged" as const, artifact_type: "skill" as const, served_by: null, last_updated: "2026-09-14T10:00:00Z", promoted_at: null, commit: null, feedback: null },
      },
    };
    saveLedger(ledgerPath(w), ledger);

    const refs = installedArtifacts(w, c);
    expect(refs).toContain("skill:good-skill");
    expect(refs).not.toContain("skill:staged-thing");
  });

  test("a promoted entry served by another artifact is keyed by the served type", async () => {
    const w = world();
    const c = cfg(w);
    const { saveLedger } = await import("@sil/store");
    const { ledgerPath } = await import("@sil/core");
    const ledger = {
      version: 1,
      entries: {
        rehomed: { pattern: "rehomed", promoted_at_count: 3, rejected_at_count: 0, status: "promoted" as const, artifact_type: "none" as const, served_by: { type: "skill" as const, path: null }, last_updated: "2026-09-14T10:00:00Z", promoted_at: null, commit: null, feedback: null },
      },
    };
    saveLedger(ledgerPath(w), ledger);

    const refs = installedArtifacts(w, c);
    expect(refs).toContain("skill:rehomed");
    expect(refs).not.toContain("none:rehomed");
  });

  test("a served_by of none is not an artifact: no none:<name> ref", async () => {
    const w = world();
    const c = cfg(w);
    const { saveLedger } = await import("@sil/store");
    const { ledgerPath } = await import("@sil/core");
    const row = (pattern: string, artifact_type: "skill" | "none") => ({ pattern, promoted_at_count: 3, rejected_at_count: 0, status: "promoted" as const, artifact_type, served_by: { type: "none" as const, path: null }, last_updated: "2026-09-14T10:00:00Z", promoted_at: null, commit: null, feedback: null });
    saveLedger(ledgerPath(w), { version: 1, entries: { drafted: row("drafted", "skill"), empty: row("empty", "none") } });

    const refs = installedArtifacts(w, c);
    expect(refs).toContain("skill:drafted");
    expect(refs.some((r) => r.startsWith("none:"))).toBe(false);
  });
});

describe("reflectSession feedback refs and lesson repo", () => {
  test("a rule named by its bare slug is recorded as rule:<slug>", async () => {
    const w = world();
    const c = cfg(w);
    const answer = { ...JSON.parse(goodAnswer()), rules_relevant: ["verify-callsites", "rule:already-prefixed"] };
    const fakeChat = async () => JSON.stringify(answer);
    await reflectSession(entry(), { cfg: c, world: w, llm: llm(), chat: fakeChat });
    const lines = fsx.readJsonl<{ ref: string; verdict: string }>(paths.criticFeedbackFile());
    const relevant = lines.filter((l) => l.verdict === "relevant").map((l) => l.ref).sort();
    expect(relevant).toEqual(["rule:already-prefixed", "rule:verify-callsites"]);
  });

  test("a session that ended inside a linked worktree keys its lesson on the main checkout", async () => {
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const main = join(tmpDir, "repo");
    mkdirSync(main, { recursive: true });
    const git = (args: string[], cwd = main) => {
      const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      if (!r.success) throw new Error(r.stderr.toString());
    };
    git(["init", "-q", "-b", "main"]);
    writeFileSync(join(main, "a.txt"), "a\n");
    git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "a.txt"]);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    const wt = join(main, ".claude", "worktrees", "fix");
    git(["worktree", "add", "-q", "-b", "fix", wt]);

    const e = { ...entry(), cwd: wt };
    const w = world();
    const fakeChat = async () => goodAnswer();
    await reflectSession(e, { cfg: cfg(w), world: w, llm: llm(), chat: fakeChat });
    const lessons = listLessons("default");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.repo).toBe(require("node:fs").realpathSync(main));
  });
});

// --- bare artifact ref normalization -----------------------------------------

describe("reflectSession normalizes bare artifact refs", () => {
  test("a bare ref matching exactly one installed artifact is written as type:name", async () => {
    const w = world();
    const c = cfg(w);
    const { saveLedger } = await import("@sil/store");
    const { ledgerPath } = await import("@sil/core");
    saveLedger(ledgerPath(w), {
      version: 1,
      entries: {
        "concurrent-worktree-mutation": {
          pattern: "concurrent-worktree-mutation",
          promoted_at_count: 3,
          rejected_at_count: 0,
          status: "promoted",
          artifact_type: "skill",
          served_by: null,
          last_updated: "2026-09-14T10:00:00Z",
          promoted_at: null,
          commit: null,
          feedback: null,
        },
      },
    });

    const answer = { ...JSON.parse(goodAnswer()), artifacts_used: ["concurrent-worktree-mutation"], artifacts_helpful: ["concurrent-worktree-mutation"], artifacts_misfired: [] };
    const fakeChat = async () => JSON.stringify(answer);

    const result = await reflectSession(entry(), { cfg: c, world: w, llm: llm(), chat: fakeChat });

    expect(result.recorded).toBe(true);
    const lines = fsx.readJsonl<{ ref: string; verdict: string }>(paths.criticFeedbackFile());
    const refs = lines.map((l) => `${l.ref}:${l.verdict}`);
    expect(refs).toContain("skill:concurrent-worktree-mutation:used");
    expect(refs).toContain("skill:concurrent-worktree-mutation:helpful");
    expect(refs.some((r) => r.startsWith("concurrent-worktree-mutation:"))).toBe(false);
  });

  // The ref comes from model output, and sessions use skills the loop did not
  // make (e.g. a user skill "outline"). One unknown name must not cost the
  // reflection; it is kept out of `ref` so it cannot become a phantom row.
  test("an unresolved bare ref still records the reflection and flags the feedback line", async () => {
    const w = world();
    const c = cfg(w);
    const answer = { ...JSON.parse(goodAnswer()), artifacts_used: ["totally-unknown-thing"], artifacts_helpful: [], artifacts_misfired: [] };
    const fakeChat = async () => JSON.stringify(answer);

    const result = await reflectSession(entry(), { cfg: c, world: w, llm: llm(), chat: fakeChat });

    expect(result.recorded).toBe(true);
    expect(listReflections("default")).toHaveLength(1);
    const lines = fsx.readJsonl<Record<string, unknown>>(paths.criticFeedbackFile());
    const flagged = lines.filter((l) => l["ref_unresolved"] === "totally-unknown-thing");
    expect(flagged).toHaveLength(1);
    expect(Object.hasOwn(flagged[0]!, "ref")).toBe(false);
  });
});
