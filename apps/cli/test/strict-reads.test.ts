// Every read the native console and the web console share must either answer
// truly or fail: a missing input is absence, anything else that stops a read
// (an unreadable file, a broken directory, malformed content, a failed git
// call) is an error, never an empty or default success.
//
// Each case runs the real source `sil ops` in its own owned fixture with the
// fixture's allowlisted env. It first decodes a seeded value (so an empty
// answer later cannot be the probe's fault), then breaks one synthetic input.
// Failure messages must name no absolute path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeControlResponse, type ControlResult } from "@sil/core/control-protocol";
import { NATIVE_FIXTURE_PATTERN, prepareNativeConsoleFixture, type NativeConsoleFixture } from "../../../scripts/native-console-fixture.ts";
import {
  applyConsoleRead,
  initialConsoleState,
  selectConsolePattern,
  selectConsoleSection,
  setProposalPart,
  switchConsoleWorld,
  type ConsoleUiState,
} from "../../hook-module/src/ui/state.ts";
import { consoleReads, consoleView, type ConsoleBlock } from "../../hook-module/src/ui/views.ts";

const CLI = join(import.meta.dir, "..", "src", "main.ts");

let base: string;
let fx: NativeConsoleFixture;
// Paths given mode 000 by a test, restored before cleanup so rm can run.
let locked: string[] = [];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "sil-strict-reads-")));
  const root = join(base, "root");
  mkdirSync(root);
  fx = prepareNativeConsoleFixture(root);
  locked = [];
});

afterEach(() => {
  for (const p of locked) chmodSync(p, 0o700);
  rmSync(base, { recursive: true, force: true });
});

function lock(path: string): void {
  locked.push(path);
  chmodSync(path, 0o000);
}

let seq = 0;
function ops(reads: { id: string; op: string; args?: Record<string, unknown> }[], env: Record<string, string> = fx.env): Record<string, ControlResult> {
  const requestId = `strict-${++seq}`;
  const request = { version: 1, requestId, reads: reads.map((r) => ({ id: r.id, op: r.op, args: r.args ?? {} })) };
  const p = Bun.spawnSync(["bun", CLI, "ops"], { cwd: join(fx.root, "workspace"), env, stdin: new TextEncoder().encode(JSON.stringify(request)), stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(0);
  return decodeControlResponse(p.stdout.toString().trimEnd(), requestId).results;
}

function value<T>(r: ControlResult | undefined): T {
  if (!r?.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.value as T;
}

/** A failed read with one of `codes`, whose message names no absolute path. */
function failed(r: ControlResult | undefined, codes: string[], mentions?: string): void {
  expect(r?.ok).toBe(false);
  if (r?.ok !== false) return;
  expect(codes).toContain(r.error.code);
  expect(r.error.message).not.toContain(base);
  expect(r.error.message).not.toMatch(/(^|[\s(:'"])\/(private|var|tmp|Users|home)\//);
  if (mentions !== undefined) expect(r.error.message).toContain(mentions);
}

const W = "fixture";
const state = () => fx.env["SIL_STATE_DIR"]!;
const data = () => fx.env["SIL_DATA_DIR"]!;

/** Rewrites the fixture config (JSON, valid YAML) with `edit`. */
function editConfig(edit: (cfg: { worlds: Record<string, unknown>[] }) => void): void {
  const path = join(fx.configDir, "config.yaml");
  const cfg = JSON.parse(readFileSync(path, "utf8")) as { worlds: Record<string, unknown>[] };
  edit(cfg);
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}

describe("worker.status", () => {
  test("a malformed worker-status.json fails the read, not 'never ran'", () => {
    expect(value<{ last_run: string | null }>(ops([{ id: "w", op: "worker.status" }])["w"]).last_run).toBe("2026-10-21T09:30:00.000Z");
    writeFileSync(join(state(), "worker-status.json"), "{ not json");
    failed(ops([{ id: "w", op: "worker.status" }])["w"], ["StateReadError"], "worker-status.json");
  });

  test("an unreadable worker lock fails the read, not 'not held'", () => {
    const lockFile = join(state(), "worker.lock");
    writeFileSync(lockFile, `${process.pid}\n`);
    const before = value<{ lock_held: boolean; lock_pid: number | null }>(ops([{ id: "w", op: "worker.status" }])["w"]);
    expect(before).toMatchObject({ lock_held: true, lock_pid: process.pid });
    lock(lockFile);
    failed(ops([{ id: "w", op: "worker.status" }])["w"], ["StateReadError"], "worker lock");
  });

  test("no status file and no lock are absence: never ran, not held", () => {
    rmSync(join(state(), "worker-status.json"));
    const v = value<{ last_run: string | null; lock_held: boolean; lock_pid: number | null }>(ops([{ id: "w", op: "worker.status" }])["w"]);
    expect(v).toMatchObject({ last_run: null, lock_held: false, lock_pid: null });
  });
});

describe("lessons", () => {
  const inbox = () => join(state(), "inbox", W);
  const reads = [
    { id: "l", op: "lessons.list", args: { world: W } },
    { id: "p", op: "console.page", args: { world: W, kind: "lessons", offset: 0, limit: 10 } },
  ];
  function seed(): void {
    mkdirSync(inbox(), { recursive: true });
    writeFileSync(join(inbox(), "l1.json"), JSON.stringify({ id: "l1", world: W, pattern: "probe-skill", text: "seeded lesson", created: "2026-10-22T10:00:00Z" }));
    const r = ops(reads);
    expect(value<{ id: string }[]>(r["l"]).map((l) => l.id)).toEqual(["l1"]);
    expect(value<{ total: number }>(r["p"]).total).toBe(1);
  }

  test("an inbox that is not a directory fails both reads", () => {
    seed();
    renameSync(inbox(), join(base, "saved-inbox"));
    writeFileSync(inbox(), "not a directory\n");
    const r = ops(reads);
    failed(r["l"], ["StateReadError"], "ENOTDIR");
    failed(r["p"], ["StateReadError"], "ENOTDIR");
  });

  test("a malformed lesson fails the read instead of shrinking the list", () => {
    seed();
    writeFileSync(join(inbox(), "bad.json"), "{");
    const r = ops(reads);
    failed(r["l"], ["StateReadError"], "bad.json");
    failed(r["p"], ["StateReadError"], "bad.json");
  });

  test("no inbox yet is an empty list", () => {
    const r = ops(reads);
    expect(value<unknown[]>(r["l"])).toEqual([]);
    expect(value<{ total: number }>(r["p"]).total).toBe(0);
  });
});

describe("reflections", () => {
  const dir = () => join(data(), "worlds", W, "reflections");
  const reads = [
    { id: "c", op: "reflections.count", args: { world: W } },
    { id: "l", op: "reflections.list", args: { world: W } },
    { id: "p", op: "console.page", args: { world: W, kind: "reflections", offset: 0, limit: 10 } },
  ];
  function seed(): void {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), "r1.md"), "---\nid: r1\ncreated: 2026-10-22\n---\nPattern: probe-skill\n\nseeded one\n");
    writeFileSync(join(dir(), "r2.md"), "---\nid: r2\ncreated: 2026-10-22\n---\nPattern: probe-skill\n\nseeded two\n");
    const r = ops(reads);
    expect(value<{ total: number }>(r["c"]).total).toBe(2);
    expect(value<{ total: number }>(r["p"]).total).toBe(2);
  }

  test("one unreadable reflection fails the count instead of lowering it", () => {
    seed();
    lock(join(dir(), "r2.md"));
    const r = ops(reads);
    for (const id of ["c", "l", "p"]) failed(r[id], ["StateReadError"], "r2.md");
  });

  test("a reflections path that is not a directory fails every reflection read", () => {
    seed();
    renameSync(dir(), join(base, "saved-reflections"));
    writeFileSync(dir(), "not a directory\n");
    const r = ops(reads);
    for (const id of ["c", "l", "p"]) failed(r[id], ["StateReadError"], "ENOTDIR");
  });

  test("an unreadable reflection is an error from reflections.get, not 'no reflection'", () => {
    seed();
    lock(join(dir(), "r1.md"));
    failed(ops([{ id: "g", op: "reflections.get", args: { world: W, id: "r1" } }])["g"], ["StateReadError"], "r1.md");
  });

  test("a markdown file without a Pattern line is still not a reflection, and no reflections dir is zero", () => {
    let r = ops(reads);
    expect(value<{ total: number }>(r["c"]).total).toBe(0);
    seed();
    writeFileSync(join(dir(), "notes.md"), "just notes\n");
    r = ops(reads);
    expect(value<{ total: number }>(r["c"]).total).toBe(2);
  });
});

describe("review", () => {
  const queueReads = [
    { id: "q", op: "review.queue", args: { world: W } },
    { id: "p", op: "console.page", args: { world: W, kind: "review", offset: 0, limit: 10 } },
  ];

  test("a target whose git repository is broken fails the review list", () => {
    expect(value<unknown[]>(ops(queueReads)["q"])).toHaveLength(1);
    renameSync(join(fx.target, ".git"), join(base, "saved-git"));
    writeFileSync(join(fx.target, ".git"), "gitdir: /nonexistent/broken\n");
    const r = ops(queueReads);
    failed(r["q"], ["StateReadError", "ReviewError"]);
    failed(r["p"], ["StateReadError", "ReviewError"]);
  });

  test("a target that does not exist yet is an empty review list", () => {
    editConfig((cfg) => {
      cfg.worlds[0]!["target"] = join(fx.root, "not-created-yet");
    });
    const r = ops(queueReads);
    expect(value<unknown[]>(r["q"])).toEqual([]);
    expect(value<{ total: number }>(r["p"]).total).toBe(0);
  });

  test("a failing git diff fails the diff read, never an empty complete page", () => {
    const diffReads = [
      { id: "d", op: "review.diff", args: { world: W, pattern: NATIVE_FIXTURE_PATTERN } },
      { id: "p", op: "console.proposalPage", args: { world: W, pattern: NATIVE_FIXTURE_PATTERN, part: "diff", offset: 0, limit: 5 } },
    ];
    expect(value<{ diff: string }>(ops(diffReads)["d"]).diff).toContain("+++ b/skills/probe-skill/SKILL.md");
    const sha = fx.git(fx.target, "rev-parse", `${fx.branch}:skills/${NATIVE_FIXTURE_PATTERN}/SKILL.md`).trim();
    lock(join(fx.target, ".git", "objects", sha.slice(0, 2), sha.slice(2)));
    const r = ops(diffReads);
    failed(r["d"], ["StateReadError"]);
    failed(r["p"], ["StateReadError"]);
  });

  test("a body that git cannot read fails the body read, never an empty body", () => {
    const bodyReads = [
      { id: "b", op: "review.detail", args: { world: W, pattern: NATIVE_FIXTURE_PATTERN } },
      { id: "p", op: "console.proposalPage", args: { world: W, pattern: NATIVE_FIXTURE_PATTERN, part: "body", offset: 0, limit: 5 } },
    ];
    expect(value<{ body: string }>(ops(bodyReads)["b"]).body).toContain("name: probe-skill");
    const sha = fx.git(fx.target, "rev-parse", `${fx.branch}:skills/${NATIVE_FIXTURE_PATTERN}/SKILL.md`).trim();
    lock(join(fx.target, ".git", "objects", sha.slice(0, 2), sha.slice(2)));
    const r = ops(bodyReads);
    failed(r["b"], ["StateReadError"]);
    failed(r["p"], ["StateReadError"]);
  });

  test("a malformed ledger on the staged branch fails the body read; no ledger there is absence", () => {
    const bodyPage = [{ id: "p", op: "console.proposalPage", args: { world: W, pattern: NATIVE_FIXTURE_PATTERN, part: "body", offset: 0, limit: 5 } }];
    // No ledger on the branch: the default type, the real body.
    expect(value<{ text: string }>(ops(bodyPage)["p"]).text).toContain("name: probe-skill");
    fx.git(fx.target, "checkout", "-q", fx.branch);
    writeFileSync(join(fx.target, "promotions.json"), "{ not a ledger");
    fx.git(fx.target, "add", "promotions.json");
    fx.git(fx.target, "commit", "-q", "-m", "malformed ledger");
    fx.git(fx.target, "checkout", "-q", "main");
    const r = ops([...bodyPage, { id: "b", op: "review.detail", args: { world: W, pattern: NATIVE_FIXTURE_PATTERN } }]);
    failed(r["p"], ["StateReadError"], "ledger");
    failed(r["b"], ["StateReadError"], "ledger");
  });
});

describe("the live flag on a staged proposal", () => {
  const reads = [
    { id: "d", op: "review.detail", args: { world: W, pattern: NATIVE_FIXTURE_PATTERN } },
    { id: "p", op: "console.proposalPage", args: { world: W, pattern: NATIVE_FIXTURE_PATTERN, part: "body", offset: 0, limit: 5 } },
  ];

  test("no live ledger is not live; a live row is live; a malformed live ledger fails, never a false flag", () => {
    // Absence: the fixture's target has no promotions.json on main.
    expect(value<{ live: boolean }>(ops(reads)["d"]).live).toBe(false);
    const ledger = join(fx.target, "promotions.json");
    const row = { pattern: NATIVE_FIXTURE_PATTERN, artifact_type: "skill", status: "promoted", promoted_at_count: 3, last_updated: "2026-10-20T10:00:00Z", promoted_at: "2026-10-20T10:00:00Z" };
    writeFileSync(ledger, JSON.stringify({ version: 1, entries: { [NATIVE_FIXTURE_PATTERN]: row } }));
    // Positive control: the live row is read as live.
    expect(value<{ live: boolean }>(ops(reads)["d"]).live).toBe(true);
    writeFileSync(ledger, "{ RAWSECRET-live-ledger");
    const r = ops(reads);
    for (const id of ["d", "p"]) {
      failed(r[id], ["StateReadError"], "promotions.json");
      expect(r[id]!.ok ? "" : r[id]!.error.message).not.toContain("RAWSECRET");
    }
  });
});

describe("ledger, artifacts and aliases", () => {
  const artifactReads = [
    { id: "i", op: "router.inventory", args: { world: W } },
    { id: "p", op: "console.page", args: { world: W, kind: "artifacts", offset: 0, limit: 10 } },
  ];
  const ledgerRow = {
    pattern: "probe-skill",
    artifact_type: "skill",
    status: "promoted",
    promoted_at_count: 3,
    last_updated: "2026-10-20T10:00:00Z",
    promoted_at: "2026-10-20T10:00:00Z",
  };

  function seedLedger(): string {
    editConfig((cfg) => {
      cfg.worlds[0]!["layout"] = { ledger: "meta/promotions.json" };
    });
    const dir = join(fx.target, "meta");
    mkdirSync(dir);
    writeFileSync(join(dir, "promotions.json"), JSON.stringify({ version: 1, entries: { "probe-skill": ledgerRow } }));
    const r = ops(artifactReads);
    expect(value<{ pattern: string }[]>(r["i"]).map((x) => x.pattern)).toEqual(["probe-skill"]);
    expect(value<{ total: number }>(r["p"]).total).toBe(1);
    return dir;
  }

  test("a ledger that cannot be reached fails the artifact reads, not an empty ledger", () => {
    const dir = seedLedger();
    lock(dir);
    const r = ops(artifactReads);
    failed(r["i"], ["StateReadError"], "ledger");
    failed(r["p"], ["StateReadError"], "ledger");
  });

  test("an unreadable usage log fails the artifact reads instead of dropping scorecards", () => {
    seedLedger();
    const usage = join(state(), "usage", "events.jsonl");
    mkdirSync(join(usage, ".."), { recursive: true });
    writeFileSync(usage, `${JSON.stringify({ ts: new Date().toISOString(), world: W, kind: "skill", ref: "skill:probe-skill" })}\n`);
    const rows = value<{ pattern: string; scorecard: { uses_30d?: number } | null }[]>(ops(artifactReads)["i"]);
    expect(JSON.stringify(rows)).toContain("probe-skill");
    lock(usage);
    const r = ops(artifactReads);
    failed(r["i"], ["StateReadError"]);
    failed(r["p"], ["StateReadError"]);
  });

  test("a malformed aliases file fails the artifact reads instead of skipping aliases", () => {
    seedLedger();
    const aliases = join(data(), "worlds", W, "aliases.json");
    mkdirSync(join(aliases, ".."), { recursive: true });
    writeFileSync(aliases, JSON.stringify({ "old-name": "probe-skill" }));
    expect(value<{ total: number }>(ops(artifactReads)["p"]).total).toBe(1);
    writeFileSync(aliases, "{ broken");
    const r = ops(artifactReads);
    failed(r["i"], ["StateReadError"], "aliases");
    failed(r["p"], ["StateReadError"], "aliases");
  });
});

// --- fix round 1 (S1-S5) -------------------------------------------------------

describe("S1: a layout path spelled with ./ reads the same committed blob", () => {
  const bodyReads = [
    { id: "d", op: "review.detail", args: { world: W, pattern: NATIVE_FIXTURE_PATTERN } },
    { id: "p", op: "console.proposalPage", args: { world: W, pattern: NATIVE_FIXTURE_PATTERN, part: "body", offset: 0, limit: 5 } },
  ];
  function layout(over: Record<string, string>): void {
    editConfig((cfg) => {
      cfg.worlds[0]!["layout"] = over;
    });
  }

  test("skills_dir ./skills finds the body that skills finds", () => {
    layout({ skills_dir: "skills" });
    const canonical = value<{ body: string }>(ops(bodyReads)["d"]).body;
    expect(canonical).toContain("name: probe-skill");
    layout({ skills_dir: "./skills" });
    const r = ops(bodyReads);
    expect(value<{ body: string }>(r["d"]).body).toBe(canonical);
    expect(value<{ text: string }>(r["p"]).text).toContain("name: probe-skill");
  });

  test("a ledger at ./meta/promotions.json on the branch is found, its row read", () => {
    fx.git(fx.target, "checkout", "-q", fx.branch);
    mkdirSync(join(fx.target, "meta"));
    const row = { pattern: NATIVE_FIXTURE_PATTERN, artifact_type: "skill", status: "staged", promoted_at_count: 5, last_updated: "2026-10-20T10:00:00Z" };
    writeFileSync(join(fx.target, "meta", "promotions.json"), JSON.stringify({ version: 1, entries: { [NATIVE_FIXTURE_PATTERN]: row } }));
    fx.git(fx.target, "add", "meta/promotions.json");
    fx.git(fx.target, "commit", "-q", "-m", "ledger on the branch");
    fx.git(fx.target, "checkout", "-q", "main");
    layout({ ledger: "meta/promotions.json" });
    expect(value<{ count: number }>(ops(bodyReads)["d"]).count).toBe(5);
    layout({ ledger: "./meta/promotions.json" });
    expect(value<{ count: number }>(ops(bodyReads)["d"]).count).toBe(5);
  });

  test("a ./ path that is really absent is still absent, and a failed blob read still fails", () => {
    layout({ skills_dir: "./not-there" });
    expect(value<{ body: string }>(ops(bodyReads)["d"]).body).toBe("");
    layout({ skills_dir: "./skills" });
    const sha = fx.git(fx.target, "rev-parse", `${fx.branch}:skills/${NATIVE_FIXTURE_PATTERN}/SKILL.md`).trim();
    lock(join(fx.target, ".git", "objects", sha.slice(0, 2), sha.slice(2)));
    const r = ops(bodyReads);
    failed(r["d"], ["StateReadError"]);
    failed(r["p"], ["StateReadError"]);
  });
});

describe("S2: a reflection whose header does not parse is an error, never a default identity", () => {
  const dir = () => join(data(), "worlds", W, "reflections");
  const reads = [
    { id: "c", op: "reflections.count", args: { world: W } },
    { id: "l", op: "reflections.list", args: { world: W } },
    { id: "p", op: "console.page", args: { world: W, kind: "reflections", offset: 0, limit: 10 } },
  ];

  test("valid same-world counts, valid other-world is excluded, a broken header fails every read", () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), "mine.md"), "---\nid: mine\nworld: fixture\ncreated: 2026-10-22\n---\nPattern: probe-skill\n\nmine\n");
    writeFileSync(join(dir(), "theirs.md"), "---\nid: theirs\nworld: fixture-two\ncreated: 2026-10-22\n---\nPattern: probe-skill\n\ntheirs\n");
    let r = ops(reads);
    expect(value<{ total: number }>(r["c"]).total).toBe(1);
    expect(value<{ id: string }[]>(r["l"]).map((x) => x.id)).toEqual(["mine"]);
    writeFileSync(join(dir(), "theirs.md"), "---\nid: theirs\nworld: fixture-two\ncreated: [RAWSECRET-unclosed\n---\nPattern: probe-skill\n\ntheirs\n");
    r = ops(reads);
    for (const id of ["c", "l", "p"]) {
      failed(r[id], ["StateReadError"], "theirs.md");
      expect(r[id]!.ok ? "" : r[id]!.error.message).not.toContain("RAWSECRET");
    }
    failed(ops([{ id: "g", op: "reflections.get", args: { world: W, id: "theirs" } }])["g"], ["StateReadError"], "theirs.md");
  });

  test("no front matter and no Pattern line keep their old meaning", () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), "bare.md"), "Pattern: probe-skill\n\nno front matter at all\n");
    writeFileSync(join(dir(), "notes.md"), "---\ntitle: [unclosed\n---\njust notes, no pattern line\n");
    writeFileSync(join(dir(), "readme.md"), "plain markdown\n");
    const r = ops(reads);
    expect(value<{ total: number }>(r["c"]).total).toBe(1);
    expect(value<{ id: string }[]>(r["l"]).map((x) => x.id)).toEqual(["bare"]);
  });
});

// Fix round 2: a header has three states. None (plain text), closed (a
// `---` line ends it, even an empty one), or started and never closed. Once a
// file is a reflection, the last state is a broken header, not "no header".
describe("S2 round 2: header states, through every reflection read", () => {
  const dir = () => join(data(), "worlds", W, "reflections");
  const BODY = "Pattern: probe-skill\n\n## Reusable lesson\nknown reflection words\n";
  const FOREIGN = "---\nid: r1\nworld: fixture-two\ncreated: 2026-10-01\nsession_id: s1\n";
  const reads = () => [
    { id: "c", op: "reflections.count", args: { world: W } },
    { id: "l", op: "reflections.list", args: { world: W } },
    { id: "p", op: "console.page", args: { world: W, kind: "reflections", offset: 0, limit: 10 } },
    { id: "g", op: "reflections.get", args: { world: W, id: "r1" } },
  ];
  function put(text: string): void {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), "r1.md"), text);
  }
  const total = (r: Record<string, ControlResult>) => value<{ total: number }>(r["c"]).total;

  test("controls: plain, empty closed header and own-world header count; a foreign header is excluded", () => {
    put(BODY);
    expect(total(ops(reads()))).toBe(1);
    put(`---\n---\n${BODY}`);
    let r = ops(reads());
    expect(total(r)).toBe(1);
    expect(value<{ world: string }>(r["g"]).world).toBe(W);
    put(`---\nid: r1\nworld: fixture\ncreated: 2026-10-01\n---\n${BODY}`);
    r = ops(reads());
    expect(total(r)).toBe(1);
    expect(value<{ created: string }>(r["g"]).created).toBe("2026-10-01");
    put(`${FOREIGN}---\n${BODY}`);
    expect(total(ops(reads()))).toBe(0);
  });

  test.each([
    ["a header that is never closed", `${FOREIGN}${BODY}`],
    ["a closed header that is not YAML", `---\nid: r1\nworld: [fixture-two\n---\n${BODY}`],
    ["a closed header that is not a map", `---\njust words\n---\n${BODY}`],
    ["a header closed only by a later ruler inside the body", `${FOREIGN}${BODY}\n----\nmore\n`],
  ])("%s fails list, count, page and get with a safe error", (_name, text) => {
    put(text);
    const r = ops(reads());
    for (const id of ["c", "l", "p", "g"]) {
      failed(r[id], ["StateReadError"], "r1.md");
      expect(r[id]!.ok ? "" : r[id]!.error.message).not.toContain("fixture-two");
    }
  });

  test("an unclosed header with no Pattern line is still not a reflection", () => {
    put("---\ntitle: notes\njust notes, never closed\n");
    const r = ops(reads());
    expect(total(r)).toBe(0);
    failed(r["g"], ["ValidationError"]);
  });
});

describe("S3: queue.detail reports a transcript it could not read", () => {
  const entryPath = () => join(state(), "queue", "pending", "fixture-pending-1.json");
  function pointAt(transcript: string): void {
    const entry = JSON.parse(readFileSync(entryPath(), "utf8")) as Record<string, unknown>;
    entry["transcript_path"] = transcript;
    writeFileSync(entryPath(), JSON.stringify(entry));
  }
  const read = [{ id: "d", op: "queue.detail", args: { session_id: "fixture-pending-1" } }];
  type Detail = { transcript: { text: string }[] | null; transcript_reason: string | null };

  test("known words first; then a directory in its place is unavailable with a reason, never [] and null", () => {
    const transcript = join(base, "session.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: "known transcript words" } })}\n${JSON.stringify({ type: "ai-title", title: "noise" })}\n`);
    pointAt(transcript);
    const good = value<Detail>(ops(read)["d"]);
    expect(good.transcript?.map((m) => m.text)).toEqual(["known transcript words"]);
    expect(good.transcript_reason).toBeNull();
    renameSync(transcript, join(base, "saved-session.jsonl"));
    mkdirSync(transcript);
    const bad = value<Detail>(ops(read)["d"]);
    expect(bad.transcript).toBeNull();
    expect(bad.transcript_reason).toContain("EISDIR");
    expect(bad.transcript_reason).not.toContain(base);
  });

  test("a malformed line is unavailable with a reason, not a shorter healthy transcript", () => {
    const transcript = join(base, "session.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: "known transcript words" } })}\n{ RAWSECRET broken\n`);
    pointAt(transcript);
    const bad = value<Detail>(ops(read)["d"]);
    expect(bad.transcript).toBeNull();
    expect(bad.transcript_reason).toContain("malformed");
    expect(bad.transcript_reason).not.toContain("RAWSECRET");
  });

  test("a transcript that was never written is still 'not persisted'", () => {
    pointAt(join(base, "never-written.jsonl"));
    const d = value<Detail>(ops(read)["d"]);
    expect(d).toMatchObject({ transcript: null, transcript_reason: "transcript not persisted" });
  });
});

describe("S5: queue cutoff errors name no path and no content", () => {
  const cleared = () => join(state(), "queue", "cleared.json");
  const read = [{ id: "q", op: "queue.list" }];

  test("a valid cutoff hides done entries; a broken one fails with a safe ValidationError", () => {
    writeFileSync(cleared(), JSON.stringify({ done: "2026-10-21T09:10:00Z", failed: null }));
    expect(value<{ hidden: { done: number } }>(ops(read)["q"]).hidden.done).toBe(1);
    for (const text of ["{ RAWSECRET-cutoff", JSON.stringify({ done: "RAWSECRET-cutoff", failed: 7 })]) {
      writeFileSync(cleared(), text);
      const r = ops(read)["q"];
      failed(r, ["ValidationError"], "cleared.json");
      expect(r!.ok ? "" : r!.error.message).not.toContain("RAWSECRET");
    }
  });
});

describe("queue.detail", () => {
  test("a malformed entry is a read error, not 'unknown session'", () => {
    const read = [{ id: "d", op: "queue.detail", args: { session_id: "fixture-pending-1" } }];
    expect(value<{ bucket: string }>(ops(read)["d"]).bucket).toBe("pending");
    writeFileSync(join(state(), "queue", "pending", "fixture-pending-1.json"), "{");
    failed(ops(read)["d"], ["QueueReadError"], "fixture-pending-1.json");
  });
});

describe("logs.tail", () => {
  test("an unreadable logs dir fails the read, not 'no log'", () => {
    const read = [{ id: "t", op: "logs.tail", args: { name: "worker", lines: 5 } }];
    expect(value<{ exists: boolean }>(ops(read)["t"]).exists).toBe(true);
    lock(join(state(), "logs"));
    failed(ops(read)["t"], ["StateReadError"], "worker");
  });

  test("a log that does not exist is absence", () => {
    rmSync(join(state(), "logs", "worker.log"));
    expect(value<{ exists: boolean; lines: string[] }>(ops([{ id: "t", op: "logs.tail", args: { name: "worker", lines: 5 } }])["t"])).toMatchObject({ exists: false, lines: [] });
  });
});

describe("health.build", () => {
  function pluginEnv(): { env: Record<string, string>; dist: string } {
    const plugin = join(base, "plugin root");
    const dist = join(plugin, "dist");
    mkdirSync(dist, { recursive: true });
    return { env: { ...fx.env, CLAUDE_PLUGIN_ROOT: plugin }, dist };
  }

  test("an unreadable build hash fails the read; no dist is a dev run", () => {
    const { env, dist } = pluginEnv();
    expect(value<{ build: string | null }>(ops([{ id: "h", op: "health.build" }], env)["h"]).build).toBeNull();
    writeFileSync(join(dist, ".srchash"), "abc123\n");
    expect(value<{ build: string | null }>(ops([{ id: "h", op: "health.build" }], env)["h"]).build).toBe("abc123");
    lock(join(dist, ".srchash"));
    failed(ops([{ id: "h", op: "health.build" }], env)["h"], ["StateReadError"], ".srchash");
  });
});

describe("config", () => {
  test("a config dir that cannot be read fails world reads, not 'not set up' or a default world", () => {
    const reads = [
      { id: "b", op: "console.bootstrap", args: { cwd: join(fx.root, "workspace") } },
      { id: "w", op: "worlds.list" },
    ];
    const before = ops(reads);
    expect(value<{ selectedWorld: string }>(before["b"]).selectedWorld).toBe(W);
    expect(value<{ name: string }[]>(before["w"]).map((w) => w.name)).toEqual([W, "fixture-two"]);
    lock(fx.configDir);
    const r = ops(reads);
    failed(r["b"], ["ConfigError"], "config.yaml");
    failed(r["w"], ["ConfigError"], "config.yaml");
  });

  // Raw input in a broken config must not come back in the message, nor the
  // fixture's absolute path: the console shows this text.
  test.each([
    ["malformed YAML", "worlds: [ {name: RAWSECRET-7f3a\n"],
    ["a value the schema refuses", "version: 1\nworlds:\n  - name: 'Bad RAWSECRET-7f3a!'\n"],
  ])("%s fails world reads with a safe ConfigError", (_name, text) => {
    writeFileSync(join(fx.configDir, "config.yaml"), text);
    const r = ops([
      { id: "b", op: "console.bootstrap", args: { cwd: join(fx.root, "workspace") } },
      { id: "w", op: "worlds.list" },
    ]);
    for (const id of ["b", "w"]) {
      failed(r[id], ["ConfigError"], "config.yaml");
      const message = r[id]!.ok ? "" : r[id]!.error.message;
      expect(message).not.toContain("RAWSECRET");
      expect(message).not.toContain(fx.root);
      expect(message).not.toContain(fx.configDir);
    }
  });

  test("no config.yaml is still 'not set up'", () => {
    rmSync(join(fx.configDir, "config.yaml"));
    const b = value<{ initialized: boolean; worlds: string[] }>(ops([{ id: "b", op: "console.bootstrap", args: { cwd: join(fx.root, "workspace") } }])["b"]);
    expect(b).toMatchObject({ initialized: false, worlds: [] });
  });
});

// The native console's own path: the reads it builds, answered by the real
// `sil ops`, decoded into its state and drawn by its view. A failed strict
// read must reach the person as an error, never as an empty or finished page.
describe("the native console shows strict read failures", () => {
  function draw(state: ConsoleUiState): string {
    const text = (b: ConsoleBlock): string => {
      if (b.kind === "line") return b.line.text;
      if (b.kind === "code") return b.source;
      if (b.kind === "select") return b.label;
      if (b.kind === "card") return [b.title, ...b.blocks.map(text)].join("\n");
      if (b.kind === "row") return b.blocks.map(text).join("\n");
      return b.controls.map((c) => c.label).join(" ");
    };
    return consoleView(state, { columns: 80, canSelect: true, now: new Date() }).map(text).join("\n");
  }

  /** Runs the reads the console would send for `state`, as one batch. */
  function refresh(state: ConsoleUiState): ConsoleUiState {
    const reads = consoleReads(state, join(fx.root, "workspace"));
    const requestId = `view-${++seq}`;
    const request = { version: 1, requestId, reads };
    const p = Bun.spawnSync(["bun", CLI, "ops"], { cwd: join(fx.root, "workspace"), env: fx.env, stdin: new TextEncoder().encode(JSON.stringify(request)), stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    const response = { version: 1 as const, requestId, results: decodeControlResponse(p.stdout.toString().trimEnd(), requestId).results };
    return applyConsoleRead(state, state.generation, response, "2026-10-23T12:00:00Z");
  }

  test("a lessons inbox that cannot be listed: the Activity section says so", () => {
    const inbox = join(state(), "inbox", W);
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "l1.json"), JSON.stringify({ id: "l1", world: W, pattern: "probe-skill", text: "seeded lesson text", created: "2026-10-22T10:00:00Z" }));
    const activity = selectConsoleSection(switchConsoleWorld(initialConsoleState(), W), "activity");
    expect(draw(refresh(activity))).toContain("seeded lesson text");
    renameSync(inbox, join(base, "saved-inbox"));
    writeFileSync(inbox, "not a directory\n");
    const shown = draw(refresh(activity));
    expect(shown).toContain("StateReadError");
    expect(shown).not.toContain("seeded lesson text");
    expect(shown).not.toContain("Last complete refresh");
  });

  test("a diff git cannot read: the review shows the error, never 'End of the diff'", () => {
    let s = selectConsoleSection(switchConsoleWorld(initialConsoleState(), W), "review");
    s = setProposalPart(selectConsolePattern(s, NATIVE_FIXTURE_PATTERN), "diff");
    expect(draw(refresh(s))).toContain("+++ b/skills/probe-skill/SKILL.md");
    const sha = fx.git(fx.target, "rev-parse", `${fx.branch}:skills/${NATIVE_FIXTURE_PATTERN}/SKILL.md`).trim();
    lock(join(fx.target, ".git", "objects", sha.slice(0, 2), sha.slice(2)));
    const shown = draw(refresh(s));
    expect(shown).toContain("StateReadError");
    expect(shown).not.toContain("End of the diff");
    expect(shown).not.toContain("+++ b/skills");
    expect(shown).not.toContain("Last complete refresh");
  });
});
