// loadQueueCleared: a missing cleared.json is "nothing hidden yet", but a
// corrupt or unreadable one must not silently reset the cutoff. That would
// bring back every session the human already hid.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "@sil/core";
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
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadQueueCleared", () => {
  test("a missing file is the default, both buckets null", () => {
    expect(loadQueueCleared()).toEqual({ done: null, failed: null });
  });

  // The consoles show these messages: a fixed name and reason, never the
  // absolute path or the content (revised from "names the path").
  test("invalid JSON throws a fixed message with no path", () => {
    const path = paths.queueClearedFile();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json", "utf8");
    expect(() => loadQueueCleared()).toThrow(/^the queue cutoffs \(queue\/cleared\.json\) are not valid JSON$/);
  });

  test("valid JSON with the wrong shape throws a fixed message with no path", () => {
    const path = paths.queueClearedFile();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ done: 123, failed: "ok" }), "utf8");
    expect(() => loadQueueCleared()).toThrow(/^the queue cutoffs \(queue\/cleared\.json\) do not have the expected shape$/);
  });

  test("an unreadable file throws, it does not reset the cutoff", () => {
    if (process.getuid?.() === 0) return; // root ignores file permissions
    const path = paths.queueClearedFile();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ done: "2026-09-01T00:00:00Z", failed: null }), "utf8");
    chmodSync(path, 0o000);
    try {
      expect(() => loadQueueCleared()).toThrow();
    } finally {
      chmodSync(path, 0o644);
    }
  });

  test("setQueueCleared refuses over a malformed file and leaves it as it was", () => {
    const path = paths.queueClearedFile();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json", "utf8");
    expect(() => setQueueCleared("done", "2026-10-23T00:00:00Z")).toThrow(/not valid JSON/);
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });
});
