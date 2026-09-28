// SSE log stream: the pure byte-range follower (nextRange) plus an end to end
// check of the route through a real Bun.serve instance, the way a browser
// would read it (guard, initial tail, growth, truncation, partial lines).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "@sil/core";
import { LOCAL_HEADER, TOKEN_HEADER } from "../src/guard.ts";
import { nextRange } from "../src/log-stream.ts";
import { createServer } from "../src/main.ts";

describe("nextRange", () => {
  test("unchanged offset, size grown past it: read the new tail, no reset", () => {
    expect(nextRange(0, 10)).toEqual({ from: 0, to: 10, reset: false });
  });
  test("size unchanged: an empty range, no reset", () => {
    expect(nextRange(10, 10)).toEqual({ from: 10, to: 10, reset: false });
  });
  test("size shrank below the offset: reset, read from 0", () => {
    expect(nextRange(10, 4)).toEqual({ from: 0, to: 4, reset: true });
  });
});

const TOKEN = "test-token-xyz";
let tmp: string;
let server: ReturnType<typeof createServer>;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-server-logstream-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_PLUGIN_ROOT"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
  server = createServer({
    port: 0,
    host: "127.0.0.1",
    token: TOKEN,
    logStream: { pollMs: 20, heartbeatMs: 60_000 },
  });
});

afterEach(() => {
  server.stop(true);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function base(): string {
  return `http://127.0.0.1:${server.port}`;
}

function goodHeaders(): Record<string, string> {
  return { [LOCAL_HEADER]: "1", [TOKEN_HEADER]: TOKEN };
}

function seedLog(name: string, text: string): string {
  const path = paths.logFile(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** Read chunks off the SSE body until `needle` shows up in the accumulated
 * text, or fail after `timeoutMs`. Chunk boundaries are not exact across
 * runtimes, so tests assert on accumulated text rather than one read(). */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, timeoutMs = 2000): Promise<string> {
  const decoder = new TextDecoder();
  let acc = "";
  const deadline = Date.now() + timeoutMs;
  while (!acc.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(needle)}; got so far: ${acc}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before ${JSON.stringify(needle)}; got so far: ${acc}`);
    acc += decoder.decode(value, { stream: true });
  }
  return acc;
}

describe("GET /api/logs/stream", () => {
  test("without the guard headers: 401, guard runs before the stream opens", async () => {
    const res = await fetch(`${base()}/api/logs/stream?name=worker`);
    expect(res.status).toBe(401);
  });

  test("an unlisted log name: 400", async () => {
    const res = await fetch(`${base()}/api/logs/stream?name=nope`, { headers: goodHeaders() });
    expect(res.status).toBe(400);
  });

  test("emits the pre-existing tail on connect, then a line appended after", async () => {
    seedLog("worker", "line one\nline two\n");
    const res = await fetch(`${base()}/api/logs/stream?name=worker`, { headers: goodHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    try {
      const initial = await readUntil(reader, "line two");
      expect(initial).toContain('data: {"line":"line one"}');
      expect(initial).toContain('data: {"line":"line two"}');

      appendFileSync(paths.logFile("worker"), "line three\n");
      const grown = await readUntil(reader, "line three");
      expect(grown).toContain('data: {"line":"line three"}');
    } finally {
      await reader.cancel();
    }
  });

  test("truncation restarts the tail from byte 0 with a reset event, no exception", async () => {
    const path = seedLog("worker", "old line one\nold line two\n");
    const res = await fetch(`${base()}/api/logs/stream?name=worker`, { headers: goodHeaders() });
    const reader = res.body!.getReader();
    try {
      await readUntil(reader, "old line two");

      writeFileSync(path, "");
      appendFileSync(path, "after\n");

      const grown = await readUntil(reader, "after");
      expect(grown).toContain("event: reset");
      expect(grown.indexOf("event: reset")).toBeLessThan(grown.indexOf('"after"'));
    } finally {
      await reader.cancel();
    }
    // A truncation mid-poll must never throw inside the stream; the web log
    // would carry the trace if handleLogStream let a stat/read error escape.
    expect(existsWebError(tmp)).toBe(false);
  });

  test("a rename-away-and-recreate at equal or larger size resets, no dropped bytes", async () => {
    const path = seedLog("worker", "a\nb\n");
    const res = await fetch(`${base()}/api/logs/stream?name=worker`, { headers: goodHeaders() });
    const reader = res.body!.getReader();
    try {
      await readUntil(reader, '"line":"b"');

      renameSync(path, `${path}.old`);
      writeFileSync(path, "c\nd\ne\n");

      const grown = await readUntil(reader, '"line":"e"');
      expect(grown).toContain("event: reset");
      expect(grown.indexOf("event: reset")).toBeLessThan(grown.indexOf('"line":"c"'));
      expect(grown).toContain('data: {"line":"c"}');
      expect(grown).toContain('data: {"line":"d"}');
      expect(grown).toContain('data: {"line":"e"}');
    } finally {
      await reader.cancel();
    }
  });

  test("an initial tail not ending in a newline buffers its last line as partial", async () => {
    const path = seedLog("worker", "x\nhal");
    const res = await fetch(`${base()}/api/logs/stream?name=worker`, { headers: goodHeaders() });
    const reader = res.body!.getReader();
    try {
      // The initial tail flush is synchronous inside the route, so it has
      // already run by the time fetch() resolves: appending right away is
      // safe and keeps every event in one accumulated read.
      appendFileSync(path, "f done\n@@END@@\n");
      // A sentinel line after the remainder bounds the wait regardless of
      // whether the bug (which would split "hal" and "f done" apart) fires.
      const grown = await readUntil(reader, "@@END@@");
      const lineEvents = [...grown.matchAll(/data: (\{"line":"[^}]*"\})/g)].map((m) => JSON.parse(m[1]!).line as string);
      expect(lineEvents).toEqual(["x", "half done", "@@END@@"]);
    } finally {
      await reader.cancel();
    }
  });

  test("a partial line is buffered until its newline arrives: exactly one event", async () => {
    const path = seedLog("worker", "");
    const res = await fetch(`${base()}/api/logs/stream?name=worker`, { headers: goodHeaders() });
    const reader = res.body!.getReader();
    try {
      appendFileSync(path, "half");
      await new Promise((r) => setTimeout(r, 80));
      appendFileSync(path, " done\n");
      const grown = await readUntil(reader, "half done");
      expect(grown.match(/event: line/g)?.length).toBe(1);
      expect(grown).toContain('data: {"line":"half done"}');
    } finally {
      await reader.cancel();
    }
  });
});

function existsWebError(root: string): boolean {
  try {
    const text = readFileSync(join(root, "sil_state_dir", "logs", "web.log"), "utf8");
    return text.includes("ERROR");
  } catch {
    return false;
  }
}
