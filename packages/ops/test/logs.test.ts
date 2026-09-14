// logs.tail: correctness of the reverse chunked reader, and proof it does not
// load a large file into memory. Bytes actually read are counted through a
// wrapped io seam rather than mocking node:fs globally.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REAL_TAIL_IO, tailLines, type TailIo } from "../src/handlers/logs.ts";
import "../src/index.ts";
import { invoke } from "../src/registry.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-ops-logs-"));
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

describe("tailLines", () => {
  test("returns an empty array for a missing file", () => {
    expect(tailLines(join(tmp, "nope.log"), 10)).toEqual([]);
  });

  test("returns the last n lines of a small file", () => {
    const path = join(tmp, "small.log");
    writeFileSync(path, ["a", "b", "c", "d", "e"].join("\n") + "\n");
    expect(tailLines(path, 2)).toEqual(["d", "e"]);
  });

  test("returns every line when the file has fewer than n lines", () => {
    const path = join(tmp, "short.log");
    writeFileSync(path, "only-one-line\n");
    expect(tailLines(path, 10)).toEqual(["only-one-line"]);
  });

  test("reads only a small slice of a 5 MB file, not the whole thing", () => {
    const path = join(tmp, "big.log");
    const lineCount = 100_000;
    const lines: string[] = [];
    for (let i = 0; i < lineCount; i++) lines.push(`line-${String(i).padStart(6, "0")}-${"x".repeat(40)}`);
    const content = lines.join("\n") + "\n";
    writeFileSync(path, content);
    expect(statSync(path).size).toBeGreaterThan(4_000_000);

    let bytesRead = 0;
    const countingIo: TailIo = {
      ...REAL_TAIL_IO,
      readSync: (fd, buffer, offset, length, position) => {
        const n = readSync(fd, buffer, offset, length, position);
        bytesRead += n;
        return n;
      },
    };

    const result = tailLines(path, 10, countingIo);
    expect(result).toEqual(lines.slice(-10));
    // Well under the 5 MB file size: proves the reader seeks from the end
    // instead of reading the file from the start.
    expect(bytesRead).toBeLessThan(200_000);
  });
});

describe("logs.tail op", () => {
  test("refuses a log name outside LOG_NAMES", () => {
    expect(invoke("logs.tail", { name: "not-a-real-log" })).rejects.toThrow();
  });

  test("returns lines for a known log name with no file yet", async () => {
    const result = (await invoke("logs.tail", { name: "worker" })) as { name: string; path: string; lines: string[] };
    expect(result.name).toBe("worker");
    expect(result.lines).toEqual([]);
  });

  test("tails an existing log file written under SIL_STATE_DIR", async () => {
    const dir = join(tmp, "sil_state_dir", "logs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "worker.log"), ["l1", "l2", "l3"].join("\n") + "\n");
    const result = (await invoke("logs.tail", { name: "worker", lines: 2 })) as { lines: string[] };
    expect(result.lines).toEqual(["l2", "l3"]);
  });
});
