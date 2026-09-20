import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import YAML from "yaml";
import { Config, fsx, ledgerPath, paths, samples, World } from "@sil/core";
import { loadLedger } from "@sil/store";
import { importKbWorlds, importLedger, importPayloadSamples, importReflections, mergeWorlds } from "../src/importer.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-importer-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_CONFIG_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("importReflections", () => {
  test("copies only files with a Pattern line, skips the rest", () => {
    const src = join(tmp, "mirror");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "one.md"), "---\nid: one\n---\nPattern: foo-bar\n\nbody\n");
    writeFileSync(join(src, "two.md"), "Pattern: baz-qux\n\nanother body\n");
    writeFileSync(join(src, "README.md"), "# not a reflection, no pattern line\n");

    const result = importReflections(src, "default");
    expect(result).toEqual({ copied: 2, skippedDuplicate: 0, skippedNonReflection: 1 });

    const destFiles = readdirSync(paths.reflectionsDir("default")).sort();
    expect(destFiles).toEqual(["one.md", "two.md"]);
  });

  test("skips duplicates on rerun", () => {
    const src = join(tmp, "mirror");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "one.md"), "Pattern: foo-bar\n\nbody\n");

    const first = importReflections(src, "default");
    const second = importReflections(src, "default");
    expect(first.copied).toBe(1);
    expect(second.copied).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
  });
});

describe("importLedger", () => {
  test("maps a V1 list shaped promotions.json", () => {
    const src = join(tmp, "promotions.json");
    writeFileSync(
      src,
      JSON.stringify([
        { pattern: "foo-bar", promoted_at_count: 3, status: "promoted", last_updated: "2026-01-01" },
        { pattern: "baz-qux", status: "staged", last_updated: "2026-01-02" },
      ]),
    );
    const world = World.parse({ name: "default", target: join(tmp, "target") });

    const count = importLedger(src, world);
    expect(count).toBe(2);

    const ledger = loadLedger(ledgerPath(world));
    expect(new Set(Object.keys(ledger.entries))).toEqual(new Set(["foo-bar", "baz-qux"]));
    expect(ledger.entries["foo-bar"]!.promoted_at_count).toBe(3);
    expect(ledger.entries["foo-bar"]!.status).toBe("promoted");
  });
});

describe("importKbWorlds and mergeWorlds", () => {
  test("reads a V1 kb worlds.yaml manifest into repos", () => {
    const manifest = join(tmp, "worlds.yaml");
    writeFileSync(
      manifest,
      YAML.stringify({
        worlds: [
          { name: "raqz", llm: "cloud", projects: [{ name: "dotfiles", repo: join(tmp, "dotfiles") }] },
          { name: "client-a", projects: [{ repo: join(tmp, "client-a") }] },
        ],
      }),
    );

    const worlds = importKbWorlds(manifest);
    expect(worlds.map((w) => w.name)).toEqual(["raqz", "client-a"]);
    expect(worlds[0]!.llm).toBe("cloud");
    expect(worlds[0]!.repos).toEqual([join(tmp, "dotfiles")]);
    expect(worlds[1]!.llm).toBe("cloud");
    expect(worlds[0]!.target).toBeNull();
  });

  test("merge adds only new names", () => {
    const cfg = Config.parse({ worlds: [World.parse({ name: "default" })] });
    const imported = [World.parse({ name: "default" }), World.parse({ name: "raqz" })];
    const added = mergeWorlds(cfg, imported);
    expect(added).toBe(1);
    expect(new Set(cfg.worlds.map((w) => w.name))).toEqual(new Set(["default", "raqz"]));
  });
});

describe("importPayloadSamples", () => {
  // Claude Code writes one JSONL record per line; an assistant record carries
  // the tool_use blocks plus the cwd the session ran in.
  function transcript(dir: string, name: string, records: unknown[]): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    return path;
  }

  function assistantRecord(cwd: string, blocks: unknown[], session = "sess-a"): unknown {
    return {
      type: "assistant",
      cwd,
      sessionId: session,
      timestamp: "2026-09-19T10:00:00.000Z",
      message: { role: "assistant", content: blocks },
    };
  }

  function setup(): { projects: string; repo: string; cfg: Config } {
    const repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    const projects = join(tmp, "claude", "projects");
    mkdirSync(projects, { recursive: true });
    // repos is non-empty and there is no second world, so nothing is a catch-all
    const cfg = Config.parse({ worlds: [World.parse({ name: "default", repos: [repo] })] });
    return { projects, repo, cfg };
  }

  const lines = (world: string): Record<string, unknown>[] => fsx.readJsonl(paths.payloadSamplesFile(world));

  test("backfills tool_use blocks from recent transcripts and ignores old ones", () => {
    const { projects, repo, cfg } = setup();
    transcript(projects, "recent.jsonl", [
      { type: "user", cwd: repo, sessionId: "sess-a", message: { role: "user", content: "push the branch" } },
      assistantRecord(repo, [
        { type: "text", text: "on it" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: "git push --no-verify", description: "free text the model wrote" },
        },
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Edit",
          input: { file_path: "/repo/src/a.ts", old_string: "AWS_SECRET_ACCESS_KEY=old", new_string: "AWS_SECRET_ACCESS_KEY=new" },
        },
      ]),
      {
        type: "user",
        cwd: repo,
        sessionId: "sess-a",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "pushed" }] },
      },
    ]);

    const old = transcript(projects, "old.jsonl", [
      assistantRecord(repo, [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "rm -rf /tmp/old" } }], "sess-old"),
    ]);
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    utimesSync(old, longAgo, longAgo);

    const result = importPayloadSamples(cfg, { days: 30, projectsDir: projects });
    expect(result.files).toBe(1);
    expect(result.records).toBe(2);
    expect(result.written).toEqual({ default: 2 });
    expect(result.skippedNoWorld).toBe(0);

    const rows = lines("default");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r["tool_name"])).toEqual(["Bash", "Edit"]);
    expect(rows[0]?.["tool_input"]).toEqual({ command: "git push --no-verify" });
    expect(rows[1]?.["tool_input"]).toEqual({ file_path: "/repo/src/a.ts" });
    expect(rows[0]?.["hook_event_name"]).toBe("PreToolUse");
    expect(rows[0]?.["session_id"]).toBe("sess-a");
    expect(rows[0]?.["ts"]).toBe("2026-09-19T10:00:00.000Z");

    const text = JSON.stringify(rows);
    expect(text).not.toContain("description");
    expect(text).not.toContain("free text the model wrote");
    expect(text).not.toContain("old_string");
    expect(text).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(text).not.toContain("rm -rf /tmp/old");
  });

  test("dedupes repeated calls within one run", () => {
    const { projects, repo, cfg } = setup();
    const status = { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git status" } };
    transcript(projects, "a.jsonl", [assistantRecord(repo, [status, status, status])]);

    const result = importPayloadSamples(cfg, { days: 30, projectsDir: projects });
    expect(result.records).toBe(3);
    expect(result.written).toEqual({ default: 1 });
    expect(lines("default").length).toBe(1);
  });

  test("only the newest distinct shapes are written, up to the rotation cap", () => {
    // 24k appends on one machine, cut to 2k lines by rotation a moment later.
    // The tail is all the router reads, so only the tail is written, and a
    // shape seen early and again late keeps its place in that tail.
    const { projects, repo, cfg } = setup();
    const cap = samples.SAMPLES_KEEP_LINES;
    const blocks = Array.from({ length: cap + 5 }, (_, i) => ({
      type: "tool_use",
      id: `toolu_${i}`,
      name: "Bash",
      input: { command: `cmd ${i}` },
    }));
    // `cmd 0` is the oldest shape and recurs as the very last call.
    blocks.push({ type: "tool_use", id: "toolu_again", name: "Bash", input: { command: "cmd 0" } });
    transcript(projects, "a.jsonl", [assistantRecord(repo, blocks)]);

    const result = importPayloadSamples(cfg, { days: 30, projectsDir: projects });

    expect(result.written).toEqual({ default: cap });
    const commands = lines("default").map((r) => (r["tool_input"] as Record<string, string>)["command"]);
    expect(commands.length).toBe(cap);
    expect(commands.at(-1)).toBe("cmd 0");
    expect(commands).not.toContain("cmd 5");
    expect(commands[0]).toBe("cmd 6");
  });

  test("dedupe is per run, so a second run appends the same samples again", () => {
    const { projects, repo, cfg } = setup();
    transcript(projects, "a.jsonl", [
      assistantRecord(repo, [
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git push --no-verify" } },
        { type: "tool_use", id: "toolu_2", name: "Edit", input: { file_path: "/repo/src/a.ts" } },
      ]),
    ]);

    expect(importPayloadSamples(cfg, { days: 30, projectsDir: projects }).written).toEqual({ default: 2 });
    expect(importPayloadSamples(cfg, { days: 30, projectsDir: projects }).written).toEqual({ default: 2 });
    expect(lines("default").length).toBe(4);
  });

  test("a cwd no world owns is skipped, not written", () => {
    const { projects, cfg } = setup();
    transcript(projects, "elsewhere.jsonl", [
      assistantRecord(join(tmp, "not-a-world"), [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]),
    ]);

    const result = importPayloadSamples(cfg, { days: 30, projectsDir: projects });
    expect(result.skippedNoWorld).toBe(1);
    expect(result.written).toEqual({});
    expect(lines("default").length).toBe(0);
  });

  test("a record with no cwd is skipped", () => {
    const { projects, cfg } = setup();
    transcript(projects, "no-cwd.jsonl", [
      {
        type: "assistant",
        sessionId: "sess-a",
        message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
      },
    ]);

    const result = importPayloadSamples(cfg, { days: 30, projectsDir: projects });
    expect(result.skippedNoWorld).toBe(1);
    expect(result.written).toEqual({});
  });

  test("credentials in a recorded command are blanked", () => {
    const { projects, repo, cfg } = setup();
    transcript(projects, "creds.jsonl", [
      assistantRecord(repo, [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: 'curl -H "Authorization: Bearer sk-live-abc123" https://api.example.com && git push --no-verify' },
        },
      ]),
    ]);

    importPayloadSamples(cfg, { days: 30, projectsDir: projects });
    const stored = String((lines("default")[0]?.["tool_input"] as Record<string, unknown>)["command"]);
    expect(stored).not.toContain("sk-live-abc123");
    expect(stored).toContain("Authorization: Bearer <redacted>");
    expect(stored).toContain("git push --no-verify");
  });

  test("a malformed line, a torn record and a missing dir never throw", () => {
    const { projects, repo, cfg } = setup();
    mkdirSync(projects, { recursive: true });
    writeFileSync(
      join(projects, "broken.jsonl"),
      ["{not json at all", JSON.stringify({ type: "assistant", cwd: repo, message: "a string, not blocks" }), ""].join("\n"),
      "utf8",
    );
    writeFileSync(join(projects, "notes.txt"), "ignored, not a transcript\n", "utf8");

    expect(() => importPayloadSamples(cfg, { days: 30, projectsDir: projects })).not.toThrow();
    expect(importPayloadSamples(cfg, { days: 30, projectsDir: join(tmp, "nope") }).files).toBe(0);
  });

  test("files are read oldest first so the newest samples land last", () => {
    const { projects, repo, cfg } = setup();
    const older = transcript(projects, "z-older.jsonl", [
      assistantRecord(repo, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo older" } }], "sess-old"),
    ]);
    const newer = transcript(projects, "a-newer.jsonl", [
      assistantRecord(repo, [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "echo newer" } }], "sess-new"),
    ]);
    // Alphabetical order is the opposite of mtime order here, so a sort by name
    // would put "echo newer" first.
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(older, past, past);

    importPayloadSamples(cfg, { days: 30, projectsDir: projects });
    const commands = lines("default").map((r) => (r["tool_input"] as Record<string, unknown>)["command"]);
    expect(commands).toEqual(["echo older", "echo newer"]);
    expect(newer).toContain("a-newer.jsonl");
  });
});

describe("unicode world names", () => {
  test("a world named Koleżka parses, imports, and keeps its own directory", () => {
    expect(World.parse({ name: "Koleżka" }).name).toBe("Koleżka");

    const manifest = join(tmp, "worlds.yaml");
    writeFileSync(manifest, YAML.stringify({ worlds: [{ name: "Koleżka", llm: "cloud", projects: [{ repo: join(tmp, "kolezka") }] }] }));

    const worlds = importKbWorlds(manifest);
    expect(worlds.map((w) => w.name)).toEqual(["Koleżka"]);
    expect(worlds[0]!.repos).toEqual([join(tmp, "kolezka")]);

    // The old safeComponent folded every non-ASCII letter to "_", so Koleżka
    // and Koleźka shared one data directory.
    expect(paths.safeComponent("Koleżka")).toBe("Koleżka");
    expect(paths.worldDir("Koleżka")).not.toBe(paths.worldDir("Koleźka"));

    const dir = paths.worldDir("Koleżka");
    expect(basename(dir)).toBe("Koleżka");
    mkdirSync(dir, { recursive: true });
    // macOS hands back NFD from readdir, Linux hands back what was written.
    expect(readdirSync(join(dir, "..")).map((n) => n.normalize("NFC"))).toEqual(["Koleżka"]);
  });

  test("separators, traversal and a leading dot are still rejected", () => {
    expect(() => World.parse({ name: "a/b" })).toThrow();
    expect(() => World.parse({ name: "../x" })).toThrow();
    expect(() => World.parse({ name: ".hidden" })).toThrow();
    expect(() => World.parse({ name: "" })).toThrow();
  });
});
