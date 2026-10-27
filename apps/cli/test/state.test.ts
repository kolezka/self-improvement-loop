// sil state: status, migrate, export --legacy-paths and quarantine, run as a
// real child process against a tmp home.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fsx, paths, StateReadError } from "@sil/core";
import { closeState, readRecords, replaceStream } from "@sil/statedb";

const CLI = join(import.meta.dir, "..", "src", "main.ts");

let tmp: string;
let env: Record<string, string>;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "sil-state-cli-")));
  env = { PATH: process.env["PATH"] ?? "", HOME: join(tmp, "home") };
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
    env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  try {
    closeState();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

function sil(...args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bun", "run", CLI, ...args], { env, cwd: tmp, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

const CRITIC = [
  { ts: "2026-10-01T00:00:00.000Z", world: "default", pattern: "a", verdict: "keep" },
  { ts: "2026-10-02T00:00:00.000Z", world: "default", pattern: "b", verdict: "drop" },
];

function seedCritic(): string {
  const file = paths.criticFeedbackFile();
  for (const record of CRITIC) fsx.appendJsonl(file, record);
  return readFileSync(file, "utf8");
}

/** A global and a per-world document at their legacy paths, as fsx.writeJson writes them. */
function seedDocs(): { cleared: string } {
  fsx.writeJson(paths.queueClearedFile(), { default: "2026-10-01T00:00:00.000Z" });
  fsx.writeJson(paths.refineAttemptsFile("default"), { "skill-a": 1 });
  return { cleared: readFileSync(paths.queueClearedFile(), "utf8") };
}

/** Two samples of world default at the legacy path, plus `extra` raw text. */
function seedPayloads(extra = ""): void {
  const file = paths.payloadSamplesFile("default");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `{"world":"default","tool_name":"Bash"}\n{"world":"default","tool_name":"Edit"}\n${extra}`);
}

const backupsOf = (file: string): string[] =>
  readdirSync(dirname(file))
    .filter((name) => name.startsWith(`${basename(file)}.imported-`))
    .map((name) => join(dirname(file), name));

interface StatusJson {
  dbPath: string;
  suspended: string | null;
  schemaVersion: number;
  streams: Record<string, { rows: number; quarantined: number; pending: boolean }>;
  docs: { store: string; world: string | null; rows: number; quarantined: number; pending: boolean }[];
  worldStreams: { store: string; world: string; rows: number; quarantined: number; pending: boolean }[];
  invalidWorldEntries: { store: string; name: string }[];
  imports: { store: string; world: string | null; state: string; backupPath: string | null; failure: string | null; lines: number; backupCheck: string | null }[];
}

function status(): StatusJson {
  const r = sil("state", "status", "--json");
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as StatusJson;
}

describe("sil state", () => {
  test("status shows invalid legacy world names without importing their files", () => {
    const invalid = join(paths.dataDir(), "worlds", "a b", "aliases.json");
    mkdirSync(dirname(invalid), { recursive: true });
    writeFileSync(invalid, '{"wrong":"target"}\n');
    const json = status();
    expect(json.invalidWorldEntries).toContainEqual({ store: "aliases", name: "a b" });
    const text = sil("state", "status");
    expect(text.code).toBe(0);
    expect(text.out).toContain('documents:\n  invalid world name, not imported: aliases "a b"');
    expect(readFileSync(invalid, "utf8")).toBe('{"wrong":"target"}\n');
  });

  test("status prints a payload samples block, one line per world, or none", () => {
    expect(sil("state", "status").out).toContain("\npayload samples: none\n");
    const legacy = paths.payloadSamplesFile("inkitt");
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, '{"n":1}\n');
    writeFileSync(join(dirname(legacy), "a b.jsonl"), '{"n":1}\n');
    const text = sil("state", "status");
    expect(text.code).toBe(0);
    // The open imports a valid world's file and leaves an invalid name alone.
    expect(text.out).toContain('\npayload samples:\n  inkitt                 1 rows\n  invalid world name, not imported: payload_samples "a b"\n');
    expect(readFileSync(join(dirname(legacy), "a b.jsonl"), "utf8")).toBe('{"n":1}\n');
    // The per-world stream is not a line of the stores block.
    const stores = text.out.slice(text.out.indexOf("\nstores:\n"), text.out.indexOf("\ndocuments:"));
    expect(stores).toContain("\n  usage_events");
    expect(stores).not.toContain("\n  payload_samples");
  });

  test("the first open imports a seeded payloads file: status --json counts its rows per world", () => {
    seedPayloads();
    const s = status();
    expect(s.worldStreams).toEqual([{ store: "payload_samples", world: "default", rows: 2, quarantined: 0, pending: false }]);
    expect(existsSync(paths.payloadSamplesFile("default"))).toBe(false);
    const text = sil("state", "status");
    expect(text.out).toMatch(/\npayload samples:\n {2}default\s+2 rows\n/);
  });

  test("migrate imports a seeded payloads file and prints it with its world", () => {
    seedPayloads();
    const r = sil("state", "migrate");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("payload_samples (default): 2 imported, 0 quarantined");
  });

  test("quarantine --drop payload_samples --world default drops that world's bad line", () => {
    seedPayloads("not json\n");
    expect(sil("state", "migrate").code).toBe(0);
    expect(sil("state", "quarantine").out).toContain("payload_samples (default)");
    const dropped = sil("state", "quarantine", "--drop", "payload_samples", "--world", "default");
    expect(dropped.err).toBe("");
    expect(dropped.code).toBe(0);
    expect(dropped.out).toContain("dropped 1");
    expect(status().worldStreams).toEqual([{ store: "payload_samples", world: "default", rows: 2, quarantined: 0, pending: false }]);
  });

  test("quarantine --world rejects invalid names as a usage error", () => {
    const result = sil("state", "quarantine", "--drop", "aliases", "--world", "a b");
    expect(result.code).toBe(2);
    expect(result.err).toContain('world name "a b" is not a valid world name');
  });

  test("migrate imports a seeded log, prints its outcome and leaves a backup", () => {
    const seed = seedCritic();
    const r = sil("state", "migrate");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("critic");
    expect(lines[0]).toContain("2 imported");
    expect(existsSync(paths.criticFeedbackFile())).toBe(false);
    const backups = backupsOf(paths.criticFeedbackFile());
    expect(backups).toHaveLength(1);
    expect(readFileSync(backups[0]!, "utf8")).toBe(seed);
  });

  test("status reports rows and re-checks each backup against its import row", () => {
    seedCritic();
    expect(sil("state", "migrate").code).toBe(0);

    const first = status();
    // Positive control: the child used the tmp state dir, not the real one.
    expect(first.dbPath).toBe(join(env["SIL_STATE_DIR"]!, "loop-state.sqlite"));
    expect(first.schemaVersion).toBe(3);
    expect(first.streams["critic"]).toEqual({ rows: 2, quarantined: 0, pending: false });
    expect(first.imports).toHaveLength(1);
    expect(first.imports[0]).toMatchObject({ store: "critic", state: "verified", lines: 2, failure: null, backupCheck: "ok" });

    const backup = first.imports[0]!.backupPath!;
    appendFileSync(backup, `${JSON.stringify({ ts: "2026-10-03T00:00:00.000Z", pattern: "late" })}\n`);
    expect(status().imports[0]!.backupCheck).toBe("grew");

    const text = readFileSync(backup, "utf8");
    writeFileSync(backup, `X${text.slice(1)}`);
    expect(status().imports[0]!.backupCheck).toBe("changed");

    rmSync(backup);
    expect(status().imports[0]!.backupCheck).toBe("missing");
  });

  test("status text names the source file of a failed import", () => {
    expect(sil("state", "migrate").code).toBe(0);
    const segment = `${paths.usageEventsFile()}.spill/20261026T000000000Z-1-0.jsonl`;
    const db = new Database(paths.loopStateDb(), { readwrite: true, create: false });
    try {
      db.query("INSERT INTO legacy_imports (store, original_path, state, failure, started_at) VALUES ('usage_events', ?, 'failed', 'EIO', 't')").run(segment);
    } finally {
      db.close();
    }
    const r = sil("state", "status");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`failed: the usage log (${segment}): EIO\n`);
    expect(status().imports).toContainEqual(expect.objectContaining({ store: "usage_events", state: "failed", originalPath: segment }));
  });

  test("status prints the late-append warning in text mode", () => {
    seedCritic();
    expect(sil("state", "migrate").code).toBe(0);
    const backup = backupsOf(paths.criticFeedbackFile())[0]!;
    appendFileSync(backup, "{}\n");
    const r = sil("state", "status");
    expect(r.code).toBe(0);
    expect(r.out).toContain("backup grew after import: 3 bytes not in the DB");
  });

  test("export --legacy-paths writes the original bytes back and refuses a second run without --force", () => {
    const seed = seedCritic();
    expect(sil("state", "migrate").code).toBe(0);
    expect(existsSync(paths.criticFeedbackFile())).toBe(false);

    const first = sil("state", "export", "--legacy-paths");
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(readFileSync(paths.criticFeedbackFile(), "utf8")).toBe(seed);
    // Streams with no rows write no file.
    expect(existsSync(paths.humanFeedbackFile())).toBe(false);

    const second = sil("state", "export", "--legacy-paths");
    expect(second.code).toBe(1);
    expect(second.err).toContain("critic.jsonl already exists");
    expect(readFileSync(paths.criticFeedbackFile(), "utf8")).toBe(seed);
    expect(status().streams["critic"]!.rows).toBe(2);

    const forced = sil("state", "export", "--legacy-paths", "--force");
    expect(forced.code).toBe(0);
    expect(readFileSync(paths.criticFeedbackFile(), "utf8")).toBe(seed);
    expect(status().streams["critic"]!.rows).toBe(2);
    // The replaced export's row goes once the new file is in place.
    expect(status().imports.filter((i) => i.backupPath === null)).toEqual([expect.objectContaining({ store: "critic", backupCheck: null })]);
  });

  test("export --legacy-paths writes a payload-only state back to payloads/default.jsonl", () => {
    seedPayloads();
    const seed = readFileSync(paths.payloadSamplesFile("default"), "utf8");
    expect(sil("state", "migrate").code).toBe(0);
    expect(existsSync(paths.payloadSamplesFile("default"))).toBe(false);

    const r = sil("state", "export", "--legacy-paths");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("nothing to export");
    expect(r.out).toContain(`wrote ${paths.payloadSamplesFile("default")}`);
    expect(readFileSync(paths.payloadSamplesFile("default"), "utf8")).toBe(seed);
  });

  test("export --legacy-paths writes every payload world, a stray world included", () => {
    const seeds: Record<string, string> = {
      default: '{"world":"default","tool_name":"Bash"}\n',
      inkitt: '{"world":"inkitt","tool_name":"Edit"}\n{"world":"inkitt","tool_name":"Read"}\n',
      // No configured world has this name; its rows still belong to it.
      stray: '{"tool_name":"Grep"}\n',
    };
    for (const [world, text] of Object.entries(seeds)) {
      fsx.ensureDir(dirname(paths.payloadSamplesFile(world)));
      writeFileSync(paths.payloadSamplesFile(world), text);
    }
    expect(sil("state", "migrate").code).toBe(0);
    expect(status().worldStreams.map((w) => [w.world, w.rows])).toEqual([
      ["default", 1],
      ["inkitt", 2],
      ["stray", 1],
    ]);

    const r = sil("state", "export", "--legacy-paths");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const exported = (world: string): string | null => (existsSync(paths.payloadSamplesFile(world)) ? readFileSync(paths.payloadSamplesFile(world), "utf8") : null);
    for (const [world, text] of Object.entries(seeds)) expect({ world, text: exported(world) }).toEqual({ world, text });
  });

  test("export --legacy-paths refuses a payload world with only quarantined lines and still writes the others", () => {
    seedPayloads();
    const bad = paths.payloadSamplesFile("q");
    writeFileSync(bad, "not json\n");
    expect(sil("state", "migrate").code).toBe(0);
    expect(status().worldStreams).toContainEqual({ store: "payload_samples", world: "q", rows: 0, quarantined: 1, pending: false });

    const r = sil("state", "export", "--legacy-paths");
    expect(r.code).toBe(1);
    expect(r.err).toContain('error: the payload samples of world "q" has 1 quarantined line; see sil state quarantine');
    expect(existsSync(bad)).toBe(false);
    expect(existsSync(paths.payloadSamplesFile("default"))).toBe(true);
  });

  test("migrate after a payload export adds no rows and moves the file to a backup", () => {
    seedPayloads();
    expect(sil("state", "migrate").code).toBe(0);
    expect(sil("state", "export", "--legacy-paths").code).toBe(0);
    expect(existsSync(paths.payloadSamplesFile("default"))).toBe(true);

    const r = sil("state", "migrate");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const s = status();
    expect(s.suspended).toBeNull();
    expect(s.worldStreams).toEqual([{ store: "payload_samples", world: "default", rows: 2, quarantined: 0, pending: false }]);
    expect(existsSync(paths.payloadSamplesFile("default"))).toBe(false);
    expect(backupsOf(paths.payloadSamplesFile("default"))).toHaveLength(2);
    expect(s.imports.every((i) => i.backupCheck === "ok")).toBe(true);
  });

  test("forced export retains history but hides only its superseded export row", () => {
    const critic = paths.criticFeedbackFile();
    fsx.appendJsonl(critic, { n: 1 });
    expect(sil("state", "migrate").code).toBe(0);
    const [olderBackup] = backupsOf(critic);
    appendFileSync(olderBackup!, '{"late":true}\n');
    fsx.appendJsonl(critic, { n: 2 });
    expect(sil("state", "migrate").code).toBe(0);
    const [newerBackup] = backupsOf(critic).filter((path) => path !== olderBackup);
    expect(sil("state", "export", "--legacy-paths").code).toBe(0);
    expect(sil("state", "export", "--legacy-paths", "--force").code).toBe(0);
    const s = status();
    expect(s.imports.find((row) => row.backupPath === olderBackup)?.backupCheck).toBe("grew");
    expect(s.imports.find((row) => row.backupPath === newerBackup)?.backupCheck).toBe("ok");
    expect(s.imports.filter((row) => row.store === "critic" && row.backupPath === null)).toHaveLength(1);
    const db = new Database(s.dbPath, { readonly: true });
    try {
      const retained = db.query("SELECT count(*) AS n FROM legacy_imports WHERE store = 'critic' AND backup_path IS NULL").get() as { n: number };
      expect(retained.n).toBe(2);
      const exportRows = db.query("SELECT id, superseded_by FROM legacy_imports WHERE store = 'critic' AND origin = 'export' ORDER BY id").all() as { id: number; superseded_by: number | null }[];
      expect(exportRows).toHaveLength(2);
      expect(exportRows[0]!.superseded_by).toBe(exportRows[1]!.id);
      expect(exportRows[1]!.superseded_by).toBeNull();
    } finally {
      db.close();
    }
  });

  test("a forced export empties a verified legacy target after a stream is replaced with empty data", () => {
    const critic = paths.criticFeedbackFile();
    fsx.appendJsonl(critic, { n: 1 });
    expect(sil("state", "migrate").code).toBe(0);
    expect(sil("state", "export", "--legacy-paths").code).toBe(0);
    expect(readFileSync(critic, "utf8")).toBe('{"n":1}\n');
    expect(replaceStream("critic", "", "empty-bundle", true).written).toBe(true);
    expect(readRecords("critic", "strict").records).toEqual([]);
    closeState();
    const result = sil("state", "export", "--legacy-paths", "--force");
    expect(result.code).toBe(0);
    expect(result.out).toContain(`wrote ${critic}`);
    expect(readFileSync(critic, "utf8")).toBe("");
    const s = status();
    expect(s.streams["critic"]!.rows).toBe(0);
    expect(s.imports.filter((row) => row.store === "critic" && row.backupPath === null)).toEqual([
      expect.objectContaining({ lines: 0, backupCheck: null }),
    ]);
    const db = new Database(s.dbPath, { readonly: true });
    try {
      const row = db.query("SELECT origin, size FROM legacy_imports WHERE store = 'critic' AND backup_path IS NULL ORDER BY id DESC LIMIT 1").get() as { origin: string; size: number };
      expect(row).toEqual({ origin: "export", size: 0 });
    } finally {
      db.close();
    }
  });

  test("an empty export refuses an unrecorded legacy target and keeps its bytes", () => {
    const critic = paths.criticFeedbackFile();
    fsx.appendJsonl(critic, { n: 1 });
    expect(sil("state", "migrate").code).toBe(0);
    expect(sil("state", "export", "--legacy-paths").code).toBe(0);
    expect(replaceStream("critic", "", "empty-bundle", true).written).toBe(true);
    appendFileSync(critic, '{"n":2}\n');
    const before = readFileSync(critic, "utf8");
    closeState();
    const result = sil("state", "export", "--legacy-paths", "--force");
    expect(result.code).toBe(1);
    expect(result.err).toContain("sil state migrate");
    expect(readFileSync(critic, "utf8")).toBe(before);
    expect(status().imports.filter((row) => row.store === "critic" && row.backupPath === null)).toHaveLength(1);
  });

  test("status shows the export's suspension and no backup check for an export row", () => {
    seedCritic();
    expect(sil("state", "migrate").code).toBe(0);
    const before = Date.now();
    expect(sil("state", "export", "--legacy-paths").code).toBe(0);
    const s = status();
    expect(s.suspended).not.toBeNull();
    expect(Date.parse(s.suspended!)).toBeGreaterThanOrEqual(before - 1000);
    expect(s.imports).toHaveLength(2);
    expect(s.imports[1]).toMatchObject({ store: "critic", state: "verified", backupPath: null, lines: 2, backupCheck: null });
  });

  test("after an export a new process reads the DB as is and leaves the legacy files alone", () => {
    const critic = seedCritic();
    fsx.appendJsonl(paths.humanFeedbackFile(), { ts: "2026-10-01T00:00:00.000Z", world: "default", ref: "hook:x", vote: "good", note: "" });
    const human = readFileSync(paths.humanFeedbackFile(), "utf8");
    expect(sil("state", "migrate").code).toBe(0);
    expect(sil("state", "export", "--legacy-paths").code).toBe(0);

    const reader = join(tmp, "reader.ts");
    writeFileSync(
      reader,
      [
        `import { paths } from ${JSON.stringify(join(import.meta.dir, "..", "..", "..", "packages", "core", "src", "index.ts"))};`,
        `import { readRecords, STREAMS } from ${JSON.stringify(join(import.meta.dir, "..", "..", "..", "packages", "statedb", "src", "index.ts"))};`,
        `const global = Object.keys(STREAMS).filter((s) => !STREAMS[s].perWorld);`,
        `const counts = Object.fromEntries(global.map((s) => [s, readRecords(s, "strict").records.length]));`,
        `console.log(JSON.stringify({ db: paths.loopStateDb(), counts }));`,
      ].join("\n"),
    );
    const p = Bun.spawnSync(["bun", reader], { env, cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    expect(p.stderr.toString()).toBe("");
    expect(p.exitCode).toBe(0);
    const out = JSON.parse(p.stdout.toString()) as { db: string; counts: Record<string, number> };
    // Positive control: the child read the tmp DB.
    expect(out.db).toBe(join(env["SIL_STATE_DIR"]!, "loop-state.sqlite"));
    expect(out.counts).toEqual({ reflect_runs: 0, critic: 2, human: 1, proposal_events: 0, usage_events: 0, nudge_fires: 0, hook_runs: 0 });
    expect(readFileSync(paths.criticFeedbackFile(), "utf8")).toBe(critic);
    expect(readFileSync(paths.humanFeedbackFile(), "utf8")).toBe(human);
  });

  test("migrate after an export imports only lines the older build appended", () => {
    seedCritic();
    expect(sil("state", "migrate").code).toBe(0);
    expect(sil("state", "export", "--legacy-paths").code).toBe(0);
    fsx.appendJsonl(paths.criticFeedbackFile(), { ts: "2026-10-03T00:00:00.000Z", world: "default", pattern: "c", verdict: "keep" });
    const appended = readFileSync(paths.criticFeedbackFile(), "utf8");

    const r = sil("state", "migrate");
    expect(r.code).toBe(0);
    expect(r.out).toContain("critic: 1 imported");
    const s = status();
    expect(s.suspended).toBeNull();
    expect(s.streams["critic"]).toEqual({ rows: 3, quarantined: 0, pending: false });
    expect(existsSync(paths.criticFeedbackFile())).toBe(false);
    const backups = backupsOf(paths.criticFeedbackFile()).map((b) => readFileSync(b, "utf8"));
    expect(backups).toContain(appended);
    expect(s.imports.every((i) => i.backupCheck === "ok")).toBe(true);
  });

  test("migrate after an unchanged export adds no rows and moves the files to backups", () => {
    seedCritic();
    fsx.appendJsonl(paths.humanFeedbackFile(), { ts: "2026-10-01T00:00:00.000Z", world: "default", ref: "hook:x", vote: "good", note: "" });
    expect(sil("state", "migrate").code).toBe(0);
    expect(sil("state", "export", "--legacy-paths").code).toBe(0);

    const r = sil("state", "migrate");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const s = status();
    expect(s.suspended).toBeNull();
    expect(s.streams["critic"]!.rows).toBe(2);
    expect(s.streams["human"]!.rows).toBe(1);
    expect(existsSync(paths.criticFeedbackFile())).toBe(false);
    expect(existsSync(paths.humanFeedbackFile())).toBe(false);
    expect(backupsOf(paths.criticFeedbackFile())).toHaveLength(2);
    expect(backupsOf(paths.humanFeedbackFile())).toHaveLength(2);
    expect(s.imports.every((i) => i.backupCheck === "ok")).toBe(true);
  });

  test("a forced export refuses a file the older build appended to, and migrate imports that line", () => {
    seedCritic();
    expect(sil("state", "migrate").code).toBe(0);
    expect(sil("state", "export", "--legacy-paths").code).toBe(0);
    fsx.appendJsonl(paths.criticFeedbackFile(), { ts: "2026-10-03T00:00:00.000Z", world: "default", pattern: "old-build", verdict: "keep" });
    const appended = readFileSync(paths.criticFeedbackFile(), "utf8");

    const forced = sil("state", "export", "--legacy-paths", "--force");
    expect(forced.code).toBe(1);
    expect(forced.err).toContain("critic.jsonl");
    expect(forced.err).toContain("run sil state migrate first");
    expect(readFileSync(paths.criticFeedbackFile(), "utf8")).toBe(appended);
    expect(status().streams["critic"]!.rows).toBe(2);

    expect(sil("state", "migrate").code).toBe(0);
    expect(status().streams["critic"]!.rows).toBe(3);
  });

  test("status shows an exported file that is gone as missing", () => {
    seedCritic();
    expect(sil("state", "migrate").code).toBe(0);
    expect(sil("state", "export", "--legacy-paths").code).toBe(0);
    rmSync(paths.criticFeedbackFile());
    const s = status();
    expect(s.imports[1]).toMatchObject({ store: "critic", backupPath: null, backupCheck: "missing" });
  });

  test("a StateReadError reaching the CLI prints one error line and exits 1", () => {
    seedCritic();
    expect(sil("state", "migrate").code).toBe(0);
    const backup = backupsOf(paths.criticFeedbackFile())[0]!;
    chmodSync(backup, 0o000);
    try {
      const r = sil("state", "status");
      expect(r.code).toBe(1);
      const lines = r.err.trimEnd().split("\n");
      expect(lines).toEqual(["error: the backup of the critic feedback log cannot be read (EACCES)"]);
    } finally {
      chmodSync(backup, 0o600);
    }
  });

  test("export without --legacy-paths is a usage error", () => {
    const r = sil("state", "export");
    expect(r.code).toBe(2);
    expect(r.err).toContain("--legacy-paths");
  });

  test("quarantine lists bad lines, export refuses that stream only, and --drop clears it", () => {
    const file = paths.criticFeedbackFile();
    fsx.ensureDir(dirname(file));
    writeFileSync(file, `${JSON.stringify(CRITIC[0])}\nnot json\n`);
    const human = paths.humanFeedbackFile();
    fsx.appendJsonl(human, { ts: "2026-10-01T00:00:00.000Z", world: "default", ref: "hook:x", vote: "good", note: "" });
    const humanSeed = readFileSync(human, "utf8");
    expect(sil("state", "migrate").code).toBe(0);

    const listed = sil("state", "quarantine");
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("critic");
    expect(listed.out).toContain("not JSON");

    const exported = sil("state", "export", "--legacy-paths");
    expect(exported.code).toBe(1);
    expect(exported.err).toContain("the critic feedback log has 1 quarantined line; see sil state quarantine");
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(human, "utf8")).toBe(humanSeed);
    rmSync(human);

    expect(() => readRecords("critic", "strict")).toThrow(StateReadError);
    closeState();

    const dropped = sil("state", "quarantine", "--drop", "critic");
    expect(dropped.code).toBe(0);
    expect(dropped.out).toContain("1");
    expect(sil("state", "quarantine").out).not.toContain("not JSON");
    expect(readRecords("critic", "strict").records).toHaveLength(1);
  });

  test("quarantine --drop refuses an unknown store", () => {
    const r = sil("state", "quarantine", "--drop", "toString");
    expect(r.code).toBe(2);
    expect(r.err).toContain("toString");
  });

  test("migrate prints one line per document, with the world for a per-world one", () => {
    seedDocs();
    const r = sil("state", "migrate");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("queue_cleared:"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("refine_attempts (default):"))).toHaveLength(1);
  });

  test("status --json lists the documents and the world of a per-world import", () => {
    seedDocs();
    expect(sil("state", "migrate").code).toBe(0);
    const s = status();
    expect(s.docs).toEqual([
      { store: "queue_cleared", world: null, rows: 1, quarantined: 0, pending: false },
      { store: "refine_attempts", world: "default", rows: 1, quarantined: 0, pending: false },
    ]);
    expect(s.imports.filter((i) => i.world === "default").map((i) => i.store)).toEqual(["refine_attempts"]);
    expect(s.imports.filter((i) => i.world === null).map((i) => i.store)).toEqual(["queue_cleared"]);
  });

  test("status text lists a documents block with the world in parentheses", () => {
    seedDocs();
    expect(sil("state", "migrate").code).toBe(0);
    const r = sil("state", "status");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    const at = lines.indexOf("documents:");
    expect(at).toBeGreaterThan(-1);
    const block = lines.slice(at + 1, at + 3);
    expect(block[0]).toMatch(/^  queue_cleared\s+1 rows?$/);
    expect(block[1]).toMatch(/^  refine_attempts \(default\)\s+1 rows?$/);
  });

  test("export --legacy-paths after a migrate writes cleared.json back byte for byte", () => {
    const { cleared } = seedDocs();
    expect(sil("state", "migrate").code).toBe(0);
    expect(existsSync(paths.queueClearedFile())).toBe(false);
    const r = sil("state", "export", "--legacy-paths");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(readFileSync(paths.queueClearedFile(), "utf8")).toBe(cleared);
  });

  test("quarantine --drop with --world drops one world's quarantined document", () => {
    const file = paths.refineAttemptsFile("default");
    fsx.writeJson(file, [1]);
    fsx.writeJson(paths.refineAttemptsFile("other"), [2]);
    expect(sil("state", "migrate").code).toBe(0);
    const listed = sil("state", "quarantine");
    expect(listed.out).toContain("refine_attempts");

    const dropped = sil("state", "quarantine", "--drop", "refine_attempts", "--world", "default");
    expect(dropped.err).toBe("");
    expect(dropped.code).toBe(0);
    expect(dropped.out).toContain("dropped 1");
    expect(status().docs.filter((d) => d.store === "refine_attempts").map((d) => [d.world, d.quarantined])).toEqual([
      ["default", 0],
      ["other", 1],
    ]);
  });

  test("quarantine --drop names every store when the store is unknown", () => {
    const r = sil("state", "quarantine", "--drop", "nope");
    expect(r.code).toBe(2);
    for (const store of ["reflect_runs", "critic", "human", "proposal_events", "queue_cleared", "worker_status", "refine_attempts", "aliases"]) {
      expect(r.err).toContain(store);
    }
  });

  test("quarantine --drop of a global store with --world is a usage error", () => {
    const r = sil("state", "quarantine", "--drop", "critic", "--world", "default");
    expect(r.code).toBe(2);
    const lines = r.err.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("error: ");
    expect(lines[0]).toContain("--world");
  });

  test("a broken database fails status with one error line and no stack", () => {
    mkdirSync(join(env["SIL_STATE_DIR"]!, "loop-state.sqlite"), { recursive: true });
    const r = sil("state", "status");
    expect(r.code).toBe(1);
    const lines = r.err.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("error: loop state");
    expect(r.err).not.toMatch(/^\s+at /m);
  });
});
