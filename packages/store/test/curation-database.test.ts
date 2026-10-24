// Curation database lifecycle: inspection is write-free, initialization runs
// once under a guard, and every inconsistent or interrupted state fails loud
// instead of minting a new installation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CurationError, SHA256_HEX_RE, UUID_RE, isWellFormed } from "@sil/core/lesson-curation";
import type { StoreBinding } from "@sil/core/lesson-curation";
import {
  classifyDarwinMounts,
  classifyLinuxMountinfo,
  curationDatabaseFile,
  curationDir,
  curationGuardFile,
  curationIdentityFile,
  curationLocationId,
  decodeRecordId,
  encodeRecordId,
  inspectCurationStore,
  openCurationStore,
  probeFilesystem,
} from "../src/index.ts";
import { inspectCurationStoreWith, openCurationStoreWith } from "../src/curation/database.ts";
import type { CurationDatabase, FilesystemClass } from "../src/curation/database.ts";
import { createCurationFixture, runCurationChild, spawnCurationChild, useFixtureEnv } from "../../../tests/curation-fixture.ts";
import type { CurationFixture } from "../../../tests/curation-fixture.ts";

let fx: CurationFixture;
let restoreEnv: () => void;
const opened: CurationDatabase[] = [];

beforeEach(() => {
  fx = createCurationFixture();
  restoreEnv = useFixtureEnv(fx);
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  restoreEnv();
  fx.cleanup();
});

const location = () => ({ kind: "location" as const, id: curationLocationId() });

function open(binding: StoreBinding = location(), initialize = true): CurationDatabase {
  const db = openCurationStore(binding, { initialize });
  opened.push(db);
  return db;
}

/** Every entry under the SIL and HOME roots with mode, size, mtime and content hash. */
function snapshot(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path);
      const hash = st.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "-";
      out.push(`${path} ${st.mode.toString(8)} ${st.size} ${st.mtimeMs} ${hash}`);
      if (st.isDirectory()) walk(path);
    }
  };
  for (const key of ["HOME", "SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_CONFIG_DIR"]) walk(fx.env[key]!);
  return out;
}

function codeOf(run: () => unknown): { code: string; problem: string | null } {
  try {
    run();
  } catch (error) {
    if (error instanceof CurationError) return { code: error.code, problem: (error as { problem?: string }).problem ?? null };
    throw error;
  }
  throw new Error("expected a CurationError");
}

function readMarker(): Record<string, unknown> {
  return JSON.parse(readFileSync(curationIdentityFile(), "utf8")) as Record<string, unknown>;
}

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

describe("fresh store", () => {
  test("inspection reports uninitialized with a location binding and writes nothing", () => {
    const before = snapshot();
    const status = inspectCurationStore();
    expect(status).toEqual({ state: "uninitialized", binding: { kind: "location", id: curationLocationId() } });
    if (status.state === "uninitialized") expect(status.binding.id).toMatch(SHA256_HEX_RE);
    expect(snapshot()).toEqual(before);
    expect(existsSync(curationDir())).toBe(false);
  });

  test("location id is stable and depends on the data directory", () => {
    const first = curationLocationId();
    expect(curationLocationId()).toBe(first);
    const saved = process.env["SIL_DATA_DIR"];
    process.env["SIL_DATA_DIR"] = join(fx.root, "other-data");
    try {
      expect(curationLocationId()).not.toBe(first);
    } finally {
      process.env["SIL_DATA_DIR"] = saved;
    }
  });

  test("open without initialize fails and writes nothing", () => {
    const before = snapshot();
    expect(codeOf(() => open(location(), false))).toEqual({ code: "STORAGE_UNAVAILABLE", problem: "uninitialized" });
    expect(snapshot()).toEqual(before);
  });

  test("a pinned installation id never initializes an absent store", () => {
    const before = snapshot();
    const pinned = { kind: "installation" as const, id: "00000000-0000-4000-8000-000000000000" };
    expect(codeOf(() => open(pinned))).toEqual({ code: "INSTALLATION_MISMATCH", problem: "identity_mismatch" });
    expect(snapshot()).toEqual(before);
  });

  test("a location binding for another data directory is refused", () => {
    const before = snapshot();
    expect(codeOf(() => open({ kind: "location", id: "0".repeat(64) }))).toEqual({
      code: "INSTALLATION_MISMATCH",
      problem: "identity_mismatch",
    });
    expect(snapshot()).toEqual(before);
  });

  test("malformed bindings are invalid input", () => {
    expect(codeOf(() => open({ kind: "location", id: "ABC" })).code).toBe("INVALID_INPUT");
    expect(codeOf(() => open({ kind: "installation", id: "not-a-uuid" })).code).toBe("INVALID_INPUT");
  });
});

describe("first authorized open", () => {
  test("returns one stable UUID across reopen, inspection and both binding kinds", () => {
    const first = open();
    expect(first.installationId).toMatch(UUID_RE);
    const id = first.installationId;
    first.close();
    expect(inspectCurationStore()).toEqual({ state: "ready", binding: { kind: "installation", id }, schemaVersion: 1 });
    expect(open({ kind: "installation", id }).installationId).toBe(id);
    expect(open(location()).installationId).toBe(id);
    expect(readMarker()).toEqual({ format: "sil-curation-identity", version: 1, installationId: id, state: "ready", createdAt: expect.any(String) });
    expect(existsSync(curationGuardFile())).toBe(false);
  });

  test("files are owner-only and the database records the same UUID", () => {
    const db = open();
    expect(mode(curationDir())).toBe(0o700);
    expect(mode(curationIdentityFile())).toBe(0o600);
    expect(mode(curationDatabaseFile())).toBe(0o600);
    const meta = db.sqlite.query("SELECT key, value FROM meta ORDER BY key").all();
    expect(meta).toEqual([
      { key: "created_at", value: readMarker()["createdAt"] },
      { key: "installation_id", value: db.installationId },
      { key: "schema_version", value: "1" },
    ]);
  });

  test("the returned connection has the required effective settings", () => {
    const { sqlite } = open();
    const get = (pragma: string) => Object.values(sqlite.query(`PRAGMA ${pragma}`).get() as object)[0];
    expect(get("user_version")).toBe(1);
    expect(get("journal_mode")).toBe("delete");
    expect(get("secure_delete")).toBe(1);
    expect(get("synchronous")).toBe(2);
    expect(get("busy_timeout")).toBe(1000);
    expect(get("foreign_keys")).toBe(1);
  });

  test("a different pinned installation is refused on a ready store", () => {
    open();
    const other = { kind: "installation" as const, id: "00000000-0000-4000-8000-000000000000" };
    expect(codeOf(() => open(other))).toEqual({ code: "INSTALLATION_MISMATCH", problem: "identity_mismatch" });
  });

  test("inspecting a ready store writes nothing", () => {
    open().close();
    opened.length = 0;
    const before = snapshot();
    expect(inspectCurationStore().state).toBe("ready");
    expect(snapshot()).toEqual(before);
  });

  test("close is idempotent", () => {
    const db = open();
    db.close();
    expect(() => db.close()).not.toThrow();
  });
});

describe("concurrent initialization", () => {
  test("two processes racing the first open resolve one UUID", async () => {
    const barrier = join(fx.root, "barrier");
    const ready = [join(fx.root, "ready-a"), join(fx.root, "ready-b")];
    const children = ready.map((file) => spawnCurationChild(fx, ["race", barrier, file]));
    const deadline = Date.now() + 10_000;
    while (!ready.every((file) => existsSync(file))) {
      if (Date.now() > deadline) throw new Error("children never became ready");
      await Bun.sleep(5);
    }
    writeFileSync(barrier, "");
    const outputs = await Promise.all(
      children.map(async (child) => {
        const stdout = await new Response(child.stdout).text();
        const stderr = await new Response(child.stderr).text();
        await child.exited;
        return { exitCode: child.exitCode, stdout, stderr };
      }),
    );
    for (const out of outputs) expect(out).toMatchObject({ exitCode: 0, stderr: "" });
    const ids = outputs.map((out) => (JSON.parse(out.stdout) as { installationId: string }).installationId);
    expect(ids[0]).toMatch(UUID_RE);
    expect(ids[1]).toBe(ids[0]!);
    expect(inspectCurationStore()).toEqual({ state: "ready", binding: { kind: "installation", id: ids[0]! }, schemaVersion: 1 });
  }, 20_000);
});

describe("inconsistent state fails without repair", () => {
  test("a ready marker whose UUID differs from the database is an identity mismatch", () => {
    open().close();
    opened.length = 0;
    const marker = readMarker();
    marker["installationId"] = "11111111-1111-4111-8111-111111111111";
    writeFileSync(curationIdentityFile(), JSON.stringify(marker), { mode: 0o600 });
    const before = snapshot();
    expect(inspectCurationStore()).toEqual({ state: "error", code: "STORAGE_UNAVAILABLE", problem: "identity_mismatch", recoveryRequired: true });
    expect(codeOf(() => open()).problem).toBe("identity_mismatch");
    expect(snapshot()).toEqual(before);
  });

  test("a ready marker with its database removed is not recreated", () => {
    const id = open().installationId;
    opened.splice(0).forEach((db) => db.close());
    unlinkSync(curationDatabaseFile());
    expect(inspectCurationStore()).toEqual({ state: "error", code: "STORAGE_UNAVAILABLE", problem: "database_missing", recoveryRequired: true });
    expect(codeOf(() => open()).problem).toBe("database_missing");
    expect(existsSync(curationDatabaseFile())).toBe(false);
    expect(readMarker()["installationId"]).toBe(id);
  });

  test("a database with no marker is not given a new identity", () => {
    open().close();
    opened.length = 0;
    unlinkSync(curationIdentityFile());
    const before = snapshot();
    expect(inspectCurationStore()).toEqual({ state: "error", code: "STORAGE_UNAVAILABLE", problem: "database_without_marker", recoveryRequired: true });
    expect(codeOf(() => open()).problem).toBe("database_without_marker");
    expect(snapshot()).toEqual(before);
  });

  test("a future database schema is refused for reads and writes", () => {
    open().close();
    opened.length = 0;
    const raw = new Database(curationDatabaseFile());
    raw.run("PRAGMA user_version = 2");
    raw.close();
    const before = snapshot();
    expect(inspectCurationStore()).toEqual({ state: "error", code: "UNSUPPORTED_SCHEMA", problem: "unsupported_schema", recoveryRequired: false });
    expect(codeOf(() => open()).code).toBe("UNSUPPORTED_SCHEMA");
    expect(codeOf(() => open(location(), false)).code).toBe("UNSUPPORTED_SCHEMA");
    expect(snapshot()).toEqual(before);
  });

  test("an extra schema object is refused as an invalid database", () => {
    open().close();
    opened.length = 0;
    const raw = new Database(curationDatabaseFile());
    raw.run("CREATE TABLE extra (x TEXT)");
    raw.close();
    expect(inspectCurationStore()).toMatchObject({ state: "error", problem: "database_invalid" });
  });

  test("a future marker version is unsupported, a malformed one is invalid", () => {
    open().close();
    opened.length = 0;
    const marker = readMarker();
    writeFileSync(curationIdentityFile(), JSON.stringify({ ...marker, version: 2 }));
    expect(inspectCurationStore()).toMatchObject({ state: "error", code: "UNSUPPORTED_SCHEMA" });
    writeFileSync(curationIdentityFile(), "{not json");
    expect(inspectCurationStore()).toMatchObject({ state: "error", code: "STORAGE_UNAVAILABLE", problem: "marker_invalid" });
    writeFileSync(curationIdentityFile(), JSON.stringify({ ...marker, extra: true }));
    expect(inspectCurationStore()).toMatchObject({ state: "error", problem: "marker_invalid" });
  });

  test("group or world access on the directory or database is refused", () => {
    open().close();
    opened.length = 0;
    chmodSync(curationDir(), 0o755);
    expect(inspectCurationStore()).toMatchObject({ state: "error", problem: "insecure_permissions" });
    expect(codeOf(() => open()).problem).toBe("insecure_permissions");
    chmodSync(curationDir(), 0o700);
    chmodSync(curationDatabaseFile(), 0o644);
    expect(inspectCurationStore()).toMatchObject({ state: "error", problem: "insecure_permissions" });
    chmodSync(curationDatabaseFile(), 0o600);
    expect(inspectCurationStore().state).toBe("ready");
  });

  test("error messages carry the problem name only", () => {
    open().close();
    opened.length = 0;
    unlinkSync(curationDatabaseFile());
    try {
      open();
      throw new Error("expected failure");
    } catch (error) {
      expect((error as Error).message).toBe("curation storage unavailable: database_missing");
      expect((error as Error).message).not.toContain(fx.root);
    }
  });
});

describe("interrupted initialization", () => {
  async function crashAfter(step: string) {
    const result = await runCurationChild(fx, ["crash-after", step]);
    expect(result.signalCode).toBe("SIGKILL");
    expect(result.stdout).toBe("");
  }

  test("killed after taking the guard: busy and recovery required, guard kept", async () => {
    await crashAfter("guard-acquired");
    expect(existsSync(curationGuardFile())).toBe(true);
    expect(existsSync(curationIdentityFile())).toBe(false);
    expect(inspectCurationStore()).toEqual({ state: "error", code: "STORAGE_BUSY", problem: "initialization_guard_held", recoveryRequired: true });
    const before = snapshot();
    expect(codeOf(() => open())).toEqual({ code: "STORAGE_BUSY", problem: "initialization_guard_held" });
    expect(snapshot()).toEqual(before);
  }, 20_000);

  test("killed after the initializing marker: interrupted, identity preserved, no database made", async () => {
    await crashAfter("marker-initializing");
    const marker = readMarker();
    expect(marker["state"]).toBe("initializing");
    expect(marker["installationId"]).toMatch(UUID_RE);
    expect(inspectCurationStore()).toEqual({ state: "error", code: "STORAGE_UNAVAILABLE", problem: "initialization_interrupted", recoveryRequired: true });
    const before = snapshot();
    expect(codeOf(() => open()).problem).toBe("initialization_interrupted");
    expect(snapshot()).toEqual(before);
    expect(existsSync(curationDatabaseFile())).toBe(false);
  }, 20_000);

  test("killed after creating the database: still interrupted, not promoted to ready", async () => {
    await crashAfter("database-created");
    expect(existsSync(curationDatabaseFile())).toBe(true);
    expect(readMarker()["state"]).toBe("initializing");
    expect(inspectCurationStore()).toMatchObject({ state: "error", problem: "initialization_interrupted", recoveryRequired: true });
    const before = snapshot();
    expect(codeOf(() => open()).problem).toBe("initialization_interrupted");
    expect(snapshot()).toEqual(before);
  }, 20_000);

  test("killed after the ready marker: ready with that UUID, leftover guard untouched", async () => {
    await crashAfter("marker-ready");
    const id = readMarker()["installationId"] as string;
    expect(inspectCurationStore()).toEqual({ state: "ready", binding: { kind: "installation", id }, schemaVersion: 1 });
    expect(open().installationId).toBe(id);
    expect(existsSync(curationGuardFile())).toBe(true);
  }, 20_000);

  test("a child with an env outside its root refuses to run", async () => {
    const escaped = { ...fx, env: { ...fx.env, SIL_DATA_DIR: "/tmp/elsewhere" } };
    const result = await runCurationChild(escaped, ["inspect"]);
    expect(result.exitCode).toBe(3);
  });
});

describe("filesystem placement", () => {
  const stub = (cls: FilesystemClass) => ({ probeFilesystem: () => cls, onInitStep: () => {} });

  test("the real probe classifies the fixture directory as local (positive control)", () => {
    expect(["darwin", "linux"]).toContain(process.platform);
    expect(probeFilesystem(fx.root)).toBe("local");
    expect(probeFilesystem(join(fx.root, "missing", "deeper"))).toBe("local");
  });

  for (const cls of ["unsupported", "unknown"] as const) {
    test(`${cls} placement fails inspection and open and writes nothing`, () => {
      const before = snapshot();
      expect(inspectCurationStoreWith(stub(cls))).toEqual({
        state: "error",
        code: "STORAGE_UNAVAILABLE",
        problem: "unsupported_filesystem",
        recoveryRequired: false,
      });
      expect(codeOf(() => openCurationStoreWith(location(), { initialize: true }, stub(cls))).problem).toBe("unsupported_filesystem");
      expect(snapshot()).toEqual(before);
    });
  }

  test("darwin mount table: local apfs, network shares and unknown types", () => {
    const table = [
      "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
      "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)",
      "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
      "//user@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by user)",
      "nas:/export on /Volumes/nfs (nfs, nodev, nosuid)",
      "/dev/disk5s1 on /Volumes/Odd Disk (exfat, local, nodev, nosuid)",
      "/dev/disk6s1 on /Volumes/NotLocal (apfs, nodev, nosuid)",
    ].join("\n");
    expect(classifyDarwinMounts(table, "/private/var/folders/x")).toBe("local");
    expect(classifyDarwinMounts(table, "/System/Volumes/Data/Users/me")).toBe("local");
    expect(classifyDarwinMounts(table, "/Volumes/share/sil")).toBe("unsupported");
    expect(classifyDarwinMounts(table, "/Volumes/nfs")).toBe("unsupported");
    expect(classifyDarwinMounts(table, "/System/Volumes/Data/home/me")).toBe("unsupported");
    expect(classifyDarwinMounts(table, "/Volumes/sharex")).toBe("local");
    expect(classifyDarwinMounts(table, "/Volumes/Odd Disk/sil")).toBe("unknown");
    expect(classifyDarwinMounts(table, "/Volumes/NotLocal/sil")).toBe("unsupported");
    expect(classifyDarwinMounts("", "/anything")).toBe("unknown");
  });

  test("linux mountinfo: local types, network, fuse, escapes and shadowing", () => {
    const info = [
      "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
      "30 22 0:40 / /mnt/nfs rw shared:5 - nfs4 server:/export rw",
      "31 22 0:41 / /mnt/my\\040disk rw - xfs /dev/sdb1 rw",
      "32 22 0:42 / /mnt/fuse rw - fuse.sshfs host: rw",
      "33 22 0:43 / /mnt/odd rw - weirdfs none rw",
      "34 22 0:44 / /mnt/nfs rw - tmpfs tmpfs rw",
    ].join("\n");
    expect(classifyLinuxMountinfo(info, "/home/me")).toBe("local");
    expect(classifyLinuxMountinfo(info, "/mnt/my disk/sil")).toBe("local");
    expect(classifyLinuxMountinfo(info, "/mnt/fuse/x")).toBe("unsupported");
    expect(classifyLinuxMountinfo(info, "/mnt/odd")).toBe("unknown");
    expect(classifyLinuxMountinfo(info, "/mnt/nfs/x")).toBe("local");
    expect(classifyLinuxMountinfo(info.split("\n").slice(0, 2).join("\n"), "/mnt/nfs/x")).toBe("unsupported");
  });
});

describe("schema", () => {
  const insertRecord = (db: CurationDatabase, id: string, extra: { projectKind?: string; projectId?: string | null } = {}) =>
    db.sqlite
      .query(
        `INSERT INTO records (world, kind, id_json, project_kind, project_id, revision, created_at, updated_at)
         VALUES (?, 'inbox', ?, ?, ?, 1, 't0', 't0')`,
      )
      .run(fx.world, encodeRecordId(id), extra.projectKind ?? "world", extra.projectId ?? null);

  test("legacy ids round-trip exactly, including empty, control and lone surrogate ids", () => {
    const db = open();
    const ids = ["", "\u0000", "\u001f\n\t", "\ud800", "\udc00", "x\udfffy", "😀", " "];
    for (const id of ids) insertRecord(db, id);
    const rows = db.sqlite.query("SELECT id_json FROM records ORDER BY rowid").all() as Array<{ id_json: string }>;
    expect(rows.map((row) => decodeRecordId(row.id_json))).toEqual(ids);
    // Distinct lone surrogates stay distinct keys.
    expect(new Set(rows.map((row) => row.id_json)).size).toBe(ids.length);
    // What SQLite receives is always well-formed, so nothing is replaced on bind.
    for (const row of rows) expect(isWellFormed(row.id_json)).toBe(true);
  });

  test("raw binding of a lone surrogate is lossy (why ids are JSON encoded)", () => {
    const db = open();
    const raw = db.sqlite.query("SELECT ? AS v").get("\ud800") as { v: string };
    expect(raw.v).not.toBe("\ud800");
  });

  test("decodeRecordId refuses non-canonical and non-string values", () => {
    expect(decodeRecordId('"a"')).toBe("a");
    for (const bad of ['"\\u0061"', "1", "null", "[]", "not json", '"a" ']) {
      expect(() => decodeRecordId(bad)).toThrow(CurationError);
    }
  });

  test("id_json must be a JSON string", () => {
    const db = open();
    expect(() =>
      db.sqlite
        .query("INSERT INTO records (world, kind, id_json, project_kind, revision, created_at, updated_at) VALUES (?, 'inbox', ?, 'world', 1, 't', 't')")
        .run(fx.world, "raw"),
    ).toThrow();
  });

  test("record identity is unique per (world, kind, id)", () => {
    const db = open();
    insertRecord(db, "a");
    expect(() => insertRecord(db, "a")).toThrow();
    db.sqlite
      .query("INSERT INTO records (world, kind, id_json, project_kind, revision, created_at, updated_at) VALUES ('other', 'inbox', ?, 'world', 1, 't', 't')")
      .run(encodeRecordId("a"));
  });

  test("scope is immutable after creation", () => {
    const db = open();
    insertRecord(db, "a", { projectKind: "project", projectId: `p1_${"a".repeat(64)}` });
    expect(() => db.sqlite.query("UPDATE records SET project_kind = 'world', project_id = NULL").run()).toThrow(/immutable/);
    expect(() => db.sqlite.query("UPDATE records SET world = 'other'").run()).toThrow(/immutable/);
    db.sqlite.query("UPDATE records SET revision = 2, important = 1").run();
    expect(db.sqlite.query("SELECT project_kind, project_id, revision FROM records").get()).toEqual({
      project_kind: "project",
      project_id: `p1_${"a".repeat(64)}`,
      revision: 2,
    });
  });

  test("project id is required exactly for project scope", () => {
    const db = open();
    expect(() => insertRecord(db, "a", { projectKind: "project", projectId: null })).toThrow();
    expect(() => insertRecord(db, "b", { projectKind: "world", projectId: "p1_x" })).toThrow();
  });

  test("a purged record holds no content and cannot be restored", () => {
    const db = open();
    insertRecord(db, "a");
    db.sqlite.query("UPDATE records SET text = 'wording'").run();
    expect(() => db.sqlite.query("UPDATE records SET purged = 1").run()).toThrow();
    db.sqlite.query("UPDATE records SET purged = 1, text = NULL").run();
    expect(() => db.sqlite.query("UPDATE records SET purged = 0").run()).toThrow(/cannot be restored/);
  });

  test("requests are unique, bound to a record and shaped by state", () => {
    const db = open();
    insertRecord(db, "a");
    const insert = db.sqlite.query(
      `INSERT INTO requests (request_id, world, kind, id_json, project_kind, project_id, state, payload_hash, revision, changed, started_at, finished_at)
       VALUES (?, ?, 'inbox', ?, 'world', NULL, ?, ?, ?, 1, 't', 't')`,
    );
    const rid = "lc_00000000-0000-4000-8000-000000000001";
    insert.run(rid, fx.world, encodeRecordId("a"), "committed", "h", 1);
    expect(() => insert.run(rid, fx.world, encodeRecordId("a"), "committed", "h", 1)).toThrow();
    expect(() => insert.run("bad", fx.world, encodeRecordId("a"), "committed", "h", 1)).toThrow();
    expect(() => insert.run("lc_00000000-0000-4000-8000-000000000002", fx.world, encodeRecordId("missing"), "committed", "h", 1)).toThrow();
    expect(() => insert.run("lc_00000000-0000-4000-8000-000000000003", fx.world, encodeRecordId("a"), "committed", null, 1)).toThrow();
    insert.run("lc_00000000-0000-4000-8000-000000000004", fx.world, encodeRecordId("a"), "purged", null, null);
    expect(() => db.sqlite.query("UPDATE requests SET id_json = ? WHERE request_id = ?").run(encodeRecordId("b"), rid)).toThrow();
  });
});

describe("occupied entries are never replaced", () => {
  // A path counts as occupied by its own directory entry, never by what a
  // symlink points at. Each shape must fail before any initialization write.
  const targets = {
    "curation directory": () => curationDir(),
    "identity marker": () => curationIdentityFile(),
    database: () => curationDatabaseFile(),
    "initialization guard": () => curationGuardFile(),
  } as const;
  const shapes = {
    "dangling symlink": (path: string) => symlinkSync(join(fx.root, "missing-target"), path),
    "symlink to a regular file": (path: string) => {
      const target = join(fx.root, "symlink-target");
      writeFileSync(target, "", { mode: 0o600 });
      symlinkSync(target, path);
    },
    "symlink to a directory": (path: string) => {
      const target = join(fx.root, "symlink-target-dir");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, path);
    },
    directory: (path: string) => mkdirSync(path, { mode: 0o700 }),
  } as const;

  for (const [targetName, target] of Object.entries(targets)) {
    for (const [shapeName, make] of Object.entries(shapes)) {
      if (targetName === "curation directory" && shapeName === "directory") continue; // the valid shape
      test(`${targetName} as ${shapeName} is unsafe, kept, and never initialized over`, () => {
        if (targetName !== "curation directory") mkdirSync(curationDir(), { mode: 0o700 });
        make(target());
        const before = snapshot();
        expect(inspectCurationStore()).toEqual({ state: "error", code: "STORAGE_UNAVAILABLE", problem: "unsafe_path", recoveryRequired: true });
        expect(codeOf(() => open()).problem).toBe("unsafe_path");
        expect(codeOf(() => open(location(), false)).problem).toBe("unsafe_path");
        expect(snapshot()).toEqual(before);
      });
    }
  }
});

describe("schema drift under unchanged names", () => {
  const drifts: Record<string, string> = {
    "same-name inert purge trigger":
      "DROP TRIGGER records_purge_final; CREATE TRIGGER records_purge_final BEFORE UPDATE OF purged ON records BEGIN SELECT 1; END;",
    "extra column on records": "ALTER TABLE records ADD COLUMN extra TEXT",
    "same-name index on other columns": "DROP INDEX records_by_scope; CREATE INDEX records_by_scope ON records (updated_at)",
    "extra meta key": "INSERT INTO meta (key, value) VALUES ('extra', 'x')",
  };
  for (const [name, sql] of Object.entries(drifts)) {
    test(`${name} is an invalid database for inspection and open`, () => {
      open().close();
      opened.length = 0;
      const raw = new Database(curationDatabaseFile());
      raw.run(sql);
      raw.close();
      const before = snapshot();
      expect(inspectCurationStore()).toEqual({ state: "error", code: "STORAGE_UNAVAILABLE", problem: "database_invalid", recoveryRequired: true });
      expect(codeOf(() => open()).problem).toBe("database_invalid");
      expect(snapshot()).toEqual(before);
    });
  }
});

describe("live initialization seen mid-inspection", () => {
  // The reader looks at the database entry while the initializer is between
  // its initializing marker and its database. The initializer then finishes.
  // A ready marker read after that must not be judged by the stale look.
  async function pausedInitializer() {
    const paused = join(fx.root, "paused");
    const barrier = join(fx.root, "barrier");
    const child = spawnCurationChild(fx, ["pause-at", "marker-initializing", paused, barrier]);
    const deadline = Date.now() + 10_000;
    while (!existsSync(paused)) {
      if (Date.now() > deadline) throw new Error("initializer never paused");
      await Bun.sleep(5);
    }
    expect(readMarker()["state"]).toBe("initializing");
    expect(existsSync(curationDatabaseFile())).toBe(false);
    let released = false;
    const deps = {
      probeFilesystem,
      onInitStep: () => {},
      onProbe: (entry: string) => {
        if (entry !== "database" || released) return;
        released = true;
        writeFileSync(barrier, "");
        const until = Date.now() + 10_000;
        while (!(existsSync(curationDatabaseFile()) && readMarker()["state"] === "ready" && !existsSync(curationGuardFile()))) {
          if (Date.now() > until) throw new Error("initializer never finished");
          Bun.sleepSync(5);
        }
      },
    };
    const childId = async () => {
      const stdout = await new Response(child.stdout).text();
      await child.exited;
      expect(child.exitCode).toBe(0);
      return (JSON.parse(stdout) as { installationId: string }).installationId;
    };
    return { deps, childId, released: () => released };
  }

  test("inspection reports the finished store, not database_missing", async () => {
    const run = await pausedInitializer();
    const status = inspectCurationStoreWith(run.deps);
    expect(run.released()).toBe(true);
    const id = await run.childId();
    expect(status).toEqual({ state: "ready", binding: { kind: "installation", id }, schemaVersion: 1 });
  }, 20_000);

  test("an initializing open resolves the same UUID", async () => {
    const run = await pausedInitializer();
    let result: unknown;
    try {
      const db = openCurationStoreWith(location(), { initialize: true }, run.deps);
      result = db.installationId;
      db.close();
    } catch (error) {
      result = (error as { problem?: string }).problem ?? String(error);
    }
    expect(run.released()).toBe(true);
    expect(result).toBe(await run.childId());
  }, 20_000);
});
