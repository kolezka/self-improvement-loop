// loadQueueCleared: no cutoffs yet is "nothing hidden yet", but a corrupt or
// unreadable legacy cleared.json must not silently reset the cutoff. That
// would bring back every session the human already hid.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { paths, ValidationError } from "@sil/core";
import { closeState } from "@sil/statedb";
import { Database } from "bun:sqlite";
import { loadQueueCleared, setQueueCleared } from "../src/queue-cleared.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-store-queue-cleared-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
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

function seedLegacy(text: string): string {
  const path = paths.queueClearedFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
  return path;
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("loadQueueCleared", () => {
  test("no cutoffs yet is the default, both buckets null", () => {
    expect(loadQueueCleared()).toEqual({ done: null, failed: null });
  });

  test("setQueueCleared stores the cutoff in loop state, not in cleared.json", () => {
    expect(setQueueCleared("done", "2026-10-23T00:00:00Z")).toEqual({ done: "2026-10-23T00:00:00Z", failed: null });
    expect(existsSync(paths.queueClearedFile())).toBe(false);
    expect(loadQueueCleared()).toEqual({ done: "2026-10-23T00:00:00Z", failed: null });
  });

  test("a legacy cleared.json is imported and read", () => {
    seedLegacy(JSON.stringify({ done: "2026-09-01T00:00:00Z", failed: null }));
    expect(loadQueueCleared()).toEqual({ done: "2026-09-01T00:00:00Z", failed: null });
    expect(existsSync(paths.queueClearedFile())).toBe(false);
  });

  // The consoles show these messages: a fixed name and reason, never the
  // absolute path or the content.
  test("a legacy file that is not JSON throws the quarantine message as a ValidationError", () => {
    seedLegacy("{not json RAWSECRET");
    const error = caught(() => loadQueueCleared());
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toBe("the queue cutoffs could not be imported; see sil state quarantine");
  });

  test("valid JSON with the wrong shape throws a fixed message with no path", () => {
    seedLegacy(JSON.stringify({ done: 123, failed: "ok" }));
    const error = caught(() => loadQueueCleared());
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toBe("the queue cutoffs do not have the expected shape");
  });

  test("an unreadable legacy file throws, it does not reset the cutoff", () => {
    if (process.getuid?.() === 0) return; // root ignores file permissions
    const path = seedLegacy(JSON.stringify({ done: "2026-09-01T00:00:00Z", failed: null }));
    chmodSync(path, 0o000);
    try {
      const error = caught(() => loadQueueCleared());
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).toStartWith("the queue cutoffs cannot be read (");
      expect((error as Error).message).not.toContain(tmp);
    } finally {
      // The import claims the file under a new name before it fails to read it.
      for (const name of readdirSync(dirname(path))) chmodSync(join(dirname(path), name), 0o644);
    }
  });

  test("a cutoffs row whose body is JSON null is malformed, not 'nothing hidden'", () => {
    setQueueCleared("done", "2026-10-23T00:00:00Z");
    expect(loadQueueCleared()).toEqual({ done: "2026-10-23T00:00:00Z", failed: null });
    closeState();
    const db = new Database(paths.loopStateDb());
    try {
      db.run("UPDATE docs SET body = 'null' WHERE name = 'queue_cleared'");
    } finally {
      db.close();
    }
    const error = caught(() => loadQueueCleared());
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toContain("the queue cutoffs is not a JSON object");
  });

  test("setQueueCleared refuses over a malformed file and the bytes survive in the backup", () => {
    const path = seedLegacy("{not json");
    const error = caught(() => setQueueCleared("done", "2026-10-23T00:00:00Z"));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toBe("the queue cutoffs could not be imported; see sil state quarantine");
    const backups = readdirSync(dirname(path)).filter((n) => n.startsWith(`${basename(path)}.imported-`));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dirname(path), backups[0]!), "utf8")).toBe("{not json");
  });
});
