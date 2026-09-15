import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countToolUses, evidencePack, iterRecords } from "../src/index.ts";
import { SESSION_ID, sampleRecords, writeSampleTranscript, writeTranscript } from "./fixture.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "sil-transcript-"));
}

describe("countToolUses", () => {
  test("counts all tool_use blocks", () => {
    const dir = tmp();
    const p = writeSampleTranscript(dir);
    expect(countToolUses(p)).toBe(3); // Bash, Skill, Agent
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file is zero", () => {
    const dir = tmp();
    expect(countToolUses(join(dir, "nope.jsonl"))).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("iterRecords", () => {
  test("tolerates bad lines", () => {
    const dir = tmp();
    const p = join(dir, "t.jsonl");
    Bun.write(p, '{"type": "user"}\nnot json\n{"type": "assistant"}\n\n');
    const recs = [...iterRecords(p)];
    expect(recs.map((r) => r["type"])).toEqual(["user", "assistant"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("evidencePack shapes", () => {
  test("basic shape", () => {
    const dir = tmp();
    const p = writeSampleTranscript(dir);
    const pack = evidencePack(p, dir, { gitHeadAtStart: null });

    expect(pack.session_id).toBe(SESSION_ID);
    expect(pack.cwd).toBe(dir);
    expect(pack.counts.tool_uses).toBe(3);
    expect(pack.counts.turns).toBe(4); // 4 assistant records
    expect(pack.counts.attachments).toBe(2);
    expect(pack.skills_used).toEqual(["debugging"]);
    expect(pack.agents_used).toEqual([{ subagent_type: "explorer", model: "sonnet" }]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("skips tool_result-only and system-ish prompts", () => {
    const dir = tmp();
    const p = writeSampleTranscript(dir);
    const pack = evidencePack(p, dir);
    expect(pack.prompts).toEqual(["Fix the bug in foo.py, tests are failing."]);
    expect(pack.counts.user_prompts).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("final assistant texts last three", () => {
    const dir = tmp();
    const p = writeSampleTranscript(dir);
    const pack = evidencePack(p, dir);
    expect(pack.final_assistant_texts).toEqual([
      "Let me run the tests first.",
      "Fixed the assertion and reran the suite; tests pass now.",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("bash and test_like", () => {
    const dir = tmp();
    const p = writeSampleTranscript(dir);
    const pack = evidencePack(p, dir);
    expect(pack.bash.length).toBe(1);
    const bashEntry = pack.bash[0]!;
    expect(bashEntry.command).toBe("pytest -q");
    expect(bashEntry.is_error).toBe(true);
    expect(bashEntry.tail).toContain("AssertionError");
    expect(pack.test_like).toEqual(pack.bash); // "pytest -q" matches the test-like regex
    rmSync(dir, { recursive: true, force: true });
  });

  test("errors captured", () => {
    const dir = tmp();
    const p = writeSampleTranscript(dir);
    const pack = evidencePack(p, dir);
    expect(pack.errors.length).toBe(1);
    expect(pack.errors[0]).toContain("AssertionError");
    rmSync(dir, { recursive: true, force: true });
  });

  test("hooks aggregated", () => {
    const dir = tmp();
    const p = writeSampleTranscript(dir);
    const pack = evidencePack(p, dir);
    expect(pack.hooks).toEqual({
      "PreToolUse:Bash": { runs: 1, errors: 0, max_ms: 56 },
      "PostToolUse:Bash": { runs: 1, errors: 1, max_ms: 120 },
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("no git repo has empty git info", () => {
    const dir = tmp();
    const p = writeSampleTranscript(dir);
    const pack = evidencePack(p, dir, { gitHeadAtStart: "deadbeef" });
    expect(pack.git.head_now).toBeNull();
    expect(pack.git.diff_excerpt).toBe("");
    expect(pack.git.files_changed).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("git repo reports diff", () => {
    const dir = tmp();
    const repo = join(dir, "repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    Bun.spawnSync(["git", "config", "user.email", "t@example.com"], { cwd: repo });
    Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: repo });
    Bun.write(join(repo, "a.txt"), "one\n");
    Bun.spawnSync(["git", "add", "a.txt"], { cwd: repo });
    Bun.spawnSync(["git", "commit", "-q", "-m", "init"], { cwd: repo });
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString("utf8").trim();
    Bun.write(join(repo, "a.txt"), "one\ntwo\n");

    const p = writeSampleTranscript(dir);
    const pack = evidencePack(p, repo, { gitHeadAtStart: head });
    expect(pack.git.head_at_start).toBe(head);
    expect(pack.git.head_now).toBe(head);
    expect(pack.git.files_changed).toContain("a.txt");
    expect(pack.git.diff_excerpt).toContain("two");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("truncation and caps", () => {
  test("prompt truncated to 400 chars", () => {
    const dir = tmp();
    const longPrompt = "x".repeat(500);
    const records = [
      { type: "user", sessionId: SESSION_ID, message: { role: "user", content: longPrompt } },
    ];
    const p = writeTranscript(join(dir, "t.jsonl"), records);
    const pack = evidencePack(p, dir);
    expect(pack.prompts[0]!.length).toBe(400);
    rmSync(dir, { recursive: true, force: true });
  });

  test("prompts capped at 12", () => {
    const dir = tmp();
    const records: Record<string, unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      records.push({ type: "user", sessionId: SESSION_ID, message: { role: "user", content: `prompt ${i}` } });
      records.push({ type: "assistant", sessionId: SESSION_ID, message: { role: "assistant", content: [{ type: "text", text: `reply ${i}` }] } });
    }
    const p = writeTranscript(join(dir, "t.jsonl"), records);
    const pack = evidencePack(p, dir);
    expect(pack.prompts.length).toBe(12);
    rmSync(dir, { recursive: true, force: true });
  });

  test("tool_calls capped first 20 last 60", () => {
    const dir = tmp();
    const blocks = Array.from({ length: 90 }, (_, i) => ({ type: "tool_use", id: `t${i}`, name: "Read", input: { file_path: `f${i}.py` } }));
    const records = [{ type: "assistant", sessionId: SESSION_ID, message: { role: "assistant", content: blocks } }];
    const p = writeTranscript(join(dir, "t.jsonl"), records);
    const pack = evidencePack(p, dir);
    expect(pack.tool_calls.length).toBe(80);
    expect(pack.tool_calls[0]!.summary).toBe("f0.py");
    expect(pack.tool_calls[19]!.summary).toBe("f19.py");
    expect(pack.tool_calls[20]!.summary).toBe("f30.py"); // first of the kept "last 60"
    expect(pack.tool_calls.at(-1)!.summary).toBe("f89.py");
    rmSync(dir, { recursive: true, force: true });
  });

  test("bash capped at 30", () => {
    const dir = tmp();
    const records: Record<string, unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      records.push({
        type: "assistant",
        sessionId: SESSION_ID,
        message: { role: "assistant", content: [{ type: "tool_use", id: `b${i}`, name: "Bash", input: { command: `echo ${i}` } }] },
      });
    }
    const p = writeTranscript(join(dir, "t.jsonl"), records);
    const pack = evidencePack(p, dir);
    expect(pack.bash.length).toBe(30);
    expect(pack.bash[0]!.command).toBe("echo 10");
    expect(pack.bash.at(-1)!.command).toBe("echo 39");
    rmSync(dir, { recursive: true, force: true });
  });

  test("respects max_chars budget", () => {
    const dir = tmp();
    const records: Record<string, unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      records.push({
        type: "assistant",
        sessionId: SESSION_ID,
        message: { role: "assistant", content: [{ type: "tool_use", id: `b${i}`, name: "Bash", input: { command: `echo ${i}`.repeat(20) } }] },
      });
      records.push({
        type: "user",
        sessionId: SESSION_ID,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `b${i}`, is_error: false, content: "x".repeat(500) }] },
      });
    }
    const p = writeTranscript(join(dir, "t.jsonl"), records);
    const pack = evidencePack(p, dir, { maxChars: 2000 });
    expect(JSON.stringify(pack).length).toBeLessThan(20_000); // trimmed well below the untrimmed size
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("sampleRecords helper", () => {
  test("produces the documented record count", () => {
    expect(sampleRecords().length).toBe(12);
  });
});
