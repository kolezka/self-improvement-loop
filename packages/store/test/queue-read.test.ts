// What a queue bucket read may claim. A bucket that does not exist yet is
// empty. A bucket that exists but cannot be listed is an error, never an
// empty list. Entry files that cannot be read or parsed are named, so a count
// built from them is not mistaken for a complete one.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "@sil/core";
import { listQueue, listQueueStrict, QueueReadError, scanQueue, writeEntry, type Bucket } from "../src/index.ts";

const BUCKETS: Bucket[] = ["pending", "done", "failed"];

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-queue-read-"));
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

function entry(sessionId: string) {
  return { session_id: sessionId, transcript_path: "/t", cwd: "/c", world: "w", git_head: null, first_stop: "a", last_stop: "b", stops: 1, ended: true, tool_uses: 0, attempts: 0, result: null };
}

/** Puts a regular file where the bucket's directory belongs: listing it
 * fails with ENOTDIR on every platform. */
function breakBucket(bucket: Bucket): void {
  const dir = paths.queueDir(bucket);
  mkdirSync(join(dir, ".."), { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, "not a directory\n");
}

describe.each(BUCKETS)("queue bucket %s", (bucket) => {
  test("positive control: written entries are listed", () => {
    writeEntry(bucket, entry("s1"));
    writeEntry(bucket, entry("s2"));
    expect(listQueue(bucket).map((e) => e.session_id)).toEqual(["s1", "s2"]);
    expect(listQueueStrict(bucket).map((e) => e.session_id)).toEqual(["s1", "s2"]);
    expect(scanQueue(bucket).unreadable).toEqual([]);
  });

  test("a bucket that does not exist yet is empty, not an error", () => {
    expect(listQueue(bucket)).toEqual([]);
    expect(listQueueStrict(bucket)).toEqual([]);
    expect(scanQueue(bucket)).toEqual({ entries: [], unreadable: [] });
  });

  test("a bucket that cannot be listed throws, for every reader", () => {
    breakBucket(bucket);
    for (const read of [() => listQueue(bucket), () => listQueueStrict(bucket), () => scanQueue(bucket)]) {
      let thrown: unknown;
      try {
        read();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(QueueReadError);
      expect((thrown as Error).message).toContain(bucket);
      expect((thrown as Error).message).toContain("ENOTDIR");
      // Named by bucket and code: no absolute path in an operator message.
      expect((thrown as Error).message).not.toContain(tmp);
    }
  });

  test("entries that cannot be read or parsed are named, and a strict read refuses", () => {
    writeEntry(bucket, entry("good"));
    const dir = paths.queueDir(bucket);
    writeFileSync(join(dir, "broken-json.json"), "{");
    writeFileSync(join(dir, "wrong-shape.json"), JSON.stringify({ session_id: 7 }));
    mkdirSync(join(dir, "a-dir.json"));
    const scan = scanQueue(bucket);
    expect(scan.entries.map((e) => e.session_id)).toEqual(["good"]);
    expect(scan.unreadable).toEqual(["a-dir.json", "broken-json.json", "wrong-shape.json"]);
    // The worker's own passes keep going past a bad file, as before.
    expect(listQueue(bucket).map((e) => e.session_id)).toEqual(["good"]);
    expect(() => listQueueStrict(bucket)).toThrow(QueueReadError);
    expect(() => listQueueStrict(bucket)).toThrow(/3 entries .*a-dir\.json, broken-json\.json, wrong-shape\.json/);
  });

  test("an entry gone between listing and reading (moved on) is skipped, not called broken", () => {
    writeEntry(bucket, entry("stays"));
    // A dangling link reads as ENOENT, as a file moved away after readdir does.
    symlinkSync(join(tmp, "moved-away.json"), join(paths.queueDir(bucket), "moved.json"));
    expect(scanQueue(bucket)).toEqual({ entries: [entry("stays")], unreadable: [] });
    expect(listQueueStrict(bucket).map((e) => e.session_id)).toEqual(["stays"]);
  });
});
