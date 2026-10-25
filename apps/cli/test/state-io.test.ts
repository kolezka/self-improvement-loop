// sil state failure paths that need the importer's filesystem seam, so they
// run the CLI in this process through run().

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fsx, paths } from "@sil/core";
import { closeState, type ImportIo, migrateLegacy, openState, setImportIoForTest, stateStatus } from "@sil/statedb";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "sil-state-io-")));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  try {
    setImportIoForTest(null);
    closeState();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

const REAL: ImportIo = {
  stat: (path) => statSync(path),
  rename: (from, to) => require("node:fs").renameSync(from, to),
  readFile: (path) => readFileSync(path),
};

async function sil(...args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  try {
    return { code: await run(args), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function seed(): void {
  fsx.appendJsonl(paths.criticFeedbackFile(), { ts: "2026-10-01T00:00:00.000Z", world: "default", pattern: "a" });
  fsx.appendJsonl(paths.criticFeedbackFile(), { ts: "2026-10-02T00:00:00.000Z", world: "default", pattern: "b" });
  fsx.appendJsonl(paths.humanFeedbackFile(), { ts: "2026-10-01T00:00:00.000Z", world: "default", ref: "hook:x", vote: "good", note: "" });
}

const filesNear = (file: string, marker: string): string[] =>
  readdirSync(dirname(file)).filter((name) => name.startsWith(`${basename(file)}${marker}`));

const rows = (stream: string): number =>
  (openState().query("SELECT count(*) AS n FROM log_records WHERE stream = ?").get(stream) as { n: number }).n;

describe("sil state failure paths", () => {
  test("migrate reports one stream's failed import, exits 1, and still imports the others", async () => {
    seed();
    const claim = `${paths.criticFeedbackFile()}.importing`;
    setImportIoForTest({
      ...REAL,
      readFile: (path) => {
        if (path === claim) throw Object.assign(new Error("injected"), { code: "EIO" });
        return REAL.readFile(path);
      },
    });
    const r = await sil("state", "migrate");
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["error: the critic feedback log cannot be imported (EIO)"]);
    expect(r.out.some((line) => line.startsWith("human: 1 imported"))).toBe(true);
    expect(existsSync(paths.humanFeedbackFile())).toBe(false);
    expect(rows("human")).toBe(1);
    expect(rows("critic")).toBe(0);
  });

  test("an export row claimed and committed but not yet renamed is finished by the next open, adding no rows", async () => {
    seed();
    expect((await sil("state", "migrate")).code).toBe(0);
    expect((await sil("state", "export", "--legacy-paths")).code).toBe(0);
    const critic = readFileSync(paths.criticFeedbackFile());

    // Crash between D6 step 5 (commit, backup name set) and the step 6 rename.
    const claim = `${paths.criticFeedbackFile()}.importing`;
    setImportIoForTest({
      ...REAL,
      rename: (from, to) => {
        if (from === claim) throw Object.assign(new Error("injected"), { code: "EIO" });
        REAL.rename(from, to);
      },
    });
    expect((await sil("state", "migrate")).code).toBe(1);
    expect(existsSync(claim)).toBe(true);
    const named = openState()
      .query("SELECT backup_path FROM legacy_imports WHERE store = 'critic' AND state = 'verified' ORDER BY id DESC LIMIT 1")
      .get() as { backup_path: string | null };
    expect(named.backup_path).not.toBeNull();

    setImportIoForTest(null);
    closeState();
    expect(rows("critic")).toBe(2);
    expect(existsSync(claim)).toBe(false);
    expect(readFileSync(named.backup_path!)).toEqual(critic);
  });

  test("a failure before the commit deletes only the temps and leaves a forced original alone", async () => {
    seed();
    expect((await sil("state", "migrate")).code).toBe(0);
    expect((await sil("state", "export", "--legacy-paths")).code).toBe(0);
    const critic = paths.criticFeedbackFile();
    const before = { bytes: readFileSync(critic), ino: statSync(critic).ino };
    const importRows = (openState().query("SELECT count(*) AS n FROM legacy_imports").get() as { n: number }).n;
    const suspended = stateStatus().suspended;

    // Critic stages first; the human temp's stat fails before the commit.
    setImportIoForTest({
      ...REAL,
      stat: (path) => {
        if (path.startsWith(`${paths.humanFeedbackFile()}.export-`)) throw Object.assign(new Error("injected"), { code: "EIO" });
        return REAL.stat(path);
      },
    });
    const r = await sil("state", "export", "--legacy-paths", "--force");
    setImportIoForTest(null);
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["error: loop state export cannot be recorded (EIO)"]);
    expect(readFileSync(critic)).toEqual(before.bytes);
    expect(statSync(critic).ino).toBe(before.ino);
    expect(filesNear(critic, ".export-")).toEqual([]);
    expect(filesNear(paths.humanFeedbackFile(), ".export-")).toEqual([]);
    expect((openState().query("SELECT count(*) AS n FROM legacy_imports").get() as { n: number }).n).toBe(importRows);
    expect(stateStatus().suspended).toBe(suspended);
  });

  test("a rename that fails after the commit is reported, keeps the temp, and status shows the file missing", async () => {
    seed();
    expect((await sil("state", "migrate")).code).toBe(0);
    const critic = paths.criticFeedbackFile();
    setImportIoForTest({
      ...REAL,
      rename: (from, to) => {
        if (to === critic) throw Object.assign(new Error("injected"), { code: "EIO" });
        REAL.rename(from, to);
      },
    });
    const r = await sil("state", "export", "--legacy-paths");
    setImportIoForTest(null);
    expect(r.code).toBe(1);
    const temps = filesNear(critic, ".export-");
    expect(temps).toHaveLength(1);
    expect(r.err).toEqual([`error: the critic feedback log was exported but not moved into place (EIO); the export is at ${join(dirname(critic), temps[0]!)}`]);
    expect(existsSync(critic)).toBe(false);
    expect(existsSync(paths.humanFeedbackFile())).toBe(true);
    const exportRow = stateStatus().imports.find((i) => i.store === "critic" && i.backupPath === null);
    expect(exportRow?.backupCheck).toBe("missing");
  });

  test("a forced export whose rename fails keeps the original recorded, so migrate only backs it up", async () => {
    seed();
    expect((await sil("state", "migrate")).code).toBe(0);
    expect((await sil("state", "export", "--legacy-paths")).code).toBe(0);
    const critic = paths.criticFeedbackFile();
    const original = { bytes: readFileSync(critic), ino: statSync(critic).ino };

    setImportIoForTest({
      ...REAL,
      rename: (from, to) => {
        if (to === critic) throw Object.assign(new Error("injected"), { code: "EIO" });
        REAL.rename(from, to);
      },
    });
    const forced = await sil("state", "export", "--legacy-paths", "--force");
    setImportIoForTest(null);
    expect(forced.code).toBe(1);
    expect(statSync(critic).ino).toBe(original.ino);

    expect((await sil("state", "migrate")).code).toBe(0);
    expect(rows("critic")).toBe(2);
    expect(existsSync(critic)).toBe(false);
    const row = openState()
      .query("SELECT backup_path FROM legacy_imports WHERE store = 'critic' AND state = 'verified' AND ino = ?")
      .get(original.ino) as { backup_path: string | null } | null;
    expect(row?.backup_path).toBeTruthy();
    expect(readFileSync(row!.backup_path!)).toEqual(original.bytes);
    const entry = stateStatus().imports.find((i) => i.backupPath === row!.backup_path);
    expect(entry?.backupCheck).toBe("ok");
  });

  test("a migrate that claims the original between a forced export's commit and its rename keeps the claimed row", async () => {
    seed();
    expect((await sil("state", "migrate")).code).toBe(0);
    expect((await sil("state", "export", "--legacy-paths")).code).toBe(0);
    const critic = paths.criticFeedbackFile();
    const claim = `${critic}.importing`;
    const original = { bytes: readFileSync(critic), ino: statSync(critic).ino };

    // Right before the export renames its critic temp into place, a migrate
    // claims the original and commits the claim, then stops before finalize
    // (its stat of the claim fails, as a crash there would leave it).
    let claimRead = false;
    let interleaved = false;
    const io: ImportIo = {
      stat: (path) => {
        if (path === claim && claimRead) throw Object.assign(new Error("stopped before finalize"), { code: "EIO" });
        return REAL.stat(path);
      },
      readFile: (path) => {
        if (path === claim) claimRead = true;
        return REAL.readFile(path);
      },
      rename: (from, to) => {
        if (to === critic && from.includes(".export-") && !interleaved) {
          interleaved = true;
          const claimed = migrateLegacy();
          expect(claimed.failures.map((f) => f.stream)).toEqual(["critic"]);
          expect(existsSync(claim)).toBe(true);
        }
        REAL.rename(from, to);
      },
    };
    setImportIoForTest(io);
    const forced = await sil("state", "export", "--legacy-paths", "--force");
    setImportIoForTest(null);
    expect(interleaved).toBe(true);
    expect(forced.code).toBe(0);

    expect((await sil("state", "migrate")).code).toBe(0);
    expect(rows("critic")).toBe(2);
    expect(existsSync(claim)).toBe(false);
    const row = openState()
      .query("SELECT backup_path FROM legacy_imports WHERE store = 'critic' AND state = 'verified' AND ino = ?")
      .get(original.ino) as { backup_path: string | null } | null;
    expect(row?.backup_path).toBeTruthy();
    expect(readFileSync(row!.backup_path!)).toEqual(original.bytes);
  });
});
