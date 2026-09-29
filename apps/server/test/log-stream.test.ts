// SSE log stream: the pure byte-range follower (nextRange) plus an end to end
// check of the route through a real Bun.serve instance, the way a browser
// would read it (guard, initial tail, growth, truncation, partial lines).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "@sil/core";
import { LOCAL_HEADER, TOKEN_HEADER } from "../src/guard.ts";
import { handleLogStream, nextRange } from "../src/log-stream.ts";
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
  });

  test("a read failing between stat and read is a rotation race, not an error loop", async () => {
    const path = seedLog("worker", "one\n");
    // existsWebError(tmp) === false is not evidence of "no exception": it is
    // also true whenever web.log was never created. Prove liveness directly
    // instead, by forcing the exact race (a readRange call failing right
    // after a successful stat) and checking a later line still arrives.
    let inject = false;
    let failedOnce = false;
    const flaky = createServer({
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      logStream: {
        pollMs: 20,
        heartbeatMs: 100,
        readRange: (p, from, to) => {
          if (inject && !failedOnce && to > from) {
            failedOnce = true;
            const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
          }
          return readFileSync(p).subarray(from, to);
        },
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${flaky.port}/api/logs/stream?name=worker`, { headers: goodHeaders() });
      const reader = res.body!.getReader();
      try {
        await readUntil(reader, '"line":"one"}');

        // Only after the initial tail: the forced failure must hit the poll
        // reading "two", not the initial tail's own byte-0 newline check.
        inject = true;
        appendFileSync(path, "two\n");

        const grown = await readUntil(reader, '"line":"two"}', 3000);
        expect(failedOnce).toBe(true);
        expect(grown.match(/event: error/g)).toBeNull();
        expect(existsWebError(tmp)).toBe(false);
      } finally {
        await reader.cancel();
      }
    } finally {
      flaky.stop(true);
    }
  }, 5000);

  test("a rotation during the initial connect does not crash the stream", async () => {
    const path = seedLog("worker", "one\n");
    let calls = 0;
    const flaky = createServer({
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      logStream: {
        pollMs: 20,
        heartbeatMs: 100,
        readRange: (p, from, to) => {
          calls += 1;
          // Fails the very first call: the initial tail's own byte-0
          // newline check, run before any poll timer exists.
          if (calls === 1) {
            const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
            err.code = "ENOENT";
            throw err;
          }
          return readFileSync(p).subarray(from, to);
        },
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${flaky.port}/api/logs/stream?name=worker`, { headers: goodHeaders() });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      try {
        // The connect-time read failed and was swallowed; the next poll
        // rediscovers the file from scratch and the stream keeps working.
        appendFileSync(path, "two\n");
        const grown = await readUntil(reader, '"line":"two"}', 2000);
        expect(grown).toContain('"line":"one"}');
        expect(grown).toContain('"line":"two"}');
      } finally {
        await reader.cancel();
      }
    } finally {
      flaky.stop(true);
    }
  }, 4000);

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

  test("a delta bigger than the read cap is spread over several poll ticks, lines intact", async () => {
    const ticks: { skipped: boolean; offset: number }[] = [];
    const capped = createServer({
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      logStream: { pollMs: 20, heartbeatMs: 60_000, readCapBytes: 5, onPollTick: (info) => ticks.push(info) },
    });
    try {
      const path = seedLog("worker", "");
      const res = await fetch(`http://127.0.0.1:${capped.port}/api/logs/stream?name=worker`, { headers: goodHeaders() });
      const reader = res.body!.getReader();
      try {
        // 17 bytes over a 5-byte cap needs exactly 4 capped reads: 5, 10, 15,
        // 17. An uncapped read would jump straight from 0 to 17 in one tick.
        appendFileSync(path, "alpha\nbeta\ngamma\n");
        const grown = await readUntil(reader, '"line":"gamma"', 3000);
        const got = [...grown.matchAll(/data: (\{"line":"[^}]*"\})/g)].map((m) => (JSON.parse(m[1]!) as { line: string }).line);
        expect(got).toEqual(["alpha", "beta", "gamma"]);

        const nonSkipped = ticks.filter((t) => !t.skipped).map((t) => t.offset);
        const distinct = nonSkipped.filter((o, i) => i === 0 || o !== nonSkipped[i - 1]);
        // A leading 0 or two may or may not show up depending on whether a
        // poll fires before the append lands; the growth itself must not.
        expect(distinct.slice(-4)).toEqual([5, 10, 15, 17]);
      } finally {
        await reader.cancel();
      }
    } finally {
      capped.stop(true);
    }
  });

  test("a capped read never corrupts a multi-byte UTF-8 character at the boundary", async () => {
    const capped = createServer({
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      // Small enough that "ż" and friends (2 bytes each in UTF-8) are
      // guaranteed to land split across at least one capped read.
      logStream: { pollMs: 20, heartbeatMs: 60_000, readCapBytes: 3 },
    });
    try {
      const path = seedLog("worker", "");
      const res = await fetch(`http://127.0.0.1:${capped.port}/api/logs/stream?name=worker`, { headers: goodHeaders() });
      const reader = res.body!.getReader();
      try {
        const text = "zażółć gęślą jaźń";
        appendFileSync(path, `${text}\n`);
        const grown = await readUntil(reader, "jaźń", 3000);
        expect(grown).toContain(`"line":${JSON.stringify(text)}`);
        expect(grown).not.toContain("�");
      } finally {
        await reader.cancel();
      }
    } finally {
      capped.stop(true);
    }
  }, 5000);

  test("a pending line over the cap is flushed without waiting for a newline", async () => {
    const capped = createServer({
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      logStream: { pollMs: 20, heartbeatMs: 100, pendingCapBytes: 1000 },
    });
    try {
      const path = seedLog("worker", "");
      const res = await fetch(`http://127.0.0.1:${capped.port}/api/logs/stream?name=worker`, { headers: goodHeaders() });
      const reader = res.body!.getReader();
      try {
        const big = "A".repeat(1500);
        appendFileSync(path, big);
        const grown = await readUntil(reader, `"line":"${big}"`, 2000);
        expect(grown).toContain(`"line":"${big}"`);
      } finally {
        await reader.cancel();
      }
    } finally {
      capped.stop(true);
    }
  }, 4000);

  test("a forced read error emits one event: error and the stream recovers", async () => {
    if (process.getuid?.() === 0) return; // root ignores file permissions
    const capped = createServer({
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      logStream: { pollMs: 20, heartbeatMs: 100 },
    });
    try {
      const path = seedLog("worker", "a\n");
      const res = await fetch(`http://127.0.0.1:${capped.port}/api/logs/stream?name=worker`, { headers: goodHeaders() });
      const reader = res.body!.getReader();
      try {
        await readUntil(reader, '"line":"a"}', 2000);

        appendFileSync(path, "b\n");
        chmodSync(path, 0o000);
        let errored: string;
        try {
          errored = await readUntil(reader, "event: error", 2000);
        } finally {
          chmodSync(path, 0o644);
        }
        expect(errored).toContain('"detail"');

        const recovered = await readUntil(reader, '"line":"b"}', 2000);
        expect(recovered.match(/event: error/g)).toBeNull();
      } finally {
        await reader.cancel();
      }
    } finally {
      capped.stop(true);
    }
  }, 6000);

  test("a broken web.log (the trace target itself) does not crash the stream it is tracing", async () => {
    if (process.getuid?.() === 0) return; // root ignores file permissions
    // Streaming "web" and breaking web.log itself makes the mapError-style
    // trace write inside the catch target the exact file that is already
    // failing: a rethrow there would escape the interval uncaught.
    const capped = createServer({
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      logStream: { pollMs: 20, heartbeatMs: 100 },
    });
    try {
      const path = seedLog("web", "a\n");
      const res = await fetch(`http://127.0.0.1:${capped.port}/api/logs/stream?name=web`, { headers: goodHeaders() });
      const reader = res.body!.getReader();
      try {
        await readUntil(reader, '"line":"a"}', 2000);

        appendFileSync(path, "b\n");
        chmodSync(path, 0o000);
        let errored: string;
        try {
          errored = await readUntil(reader, "event: error", 2000);
        } finally {
          chmodSync(path, 0o644);
        }
        expect(errored).toContain('"detail"');

        const recovered = await readUntil(reader, '"line":"b"}', 2000);
        expect(recovered.match(/event: error/g)).toBeNull();
      } finally {
        await reader.cancel();
      }
    } finally {
      capped.stop(true);
    }
  }, 6000);

  test("a reader that never drains does not let the stream read the whole file into memory", async () => {
    // Calls handleLogStream directly rather than through a real HTTP round
    // trip: Bun's own socket layer pulls from the response stream to fill
    // the OS send buffer regardless of whether a JS reader ever reads, which
    // masks backpressure in a real fetch() over loopback. Never touching the
    // returned body's reader here is what keeps controller.desiredSize
    // reflecting only what this poll loop itself has enqueued.
    const path = seedLog("worker", "start\n");
    const ticks: { skipped: boolean; offset: number }[] = [];
    const abort = new AbortController();
    const url = new URL("http://x/api/logs/stream?name=worker");
    const request = new Request(url, { signal: abort.signal });
    handleLogStream(request, url, {
      pollMs: 15,
      heartbeatMs: 60_000,
      queueHighWaterMark: 3,
      onPollTick: (info) => ticks.push(info),
    });
    try {
      // Bigger than the 1 MiB read cap, so even the one tick backpressure
      // cannot stop (it already has desiredSize > 0 when it starts, and a
      // single tick's own enqueues are not throttled mid-tick) still only
      // drains one capped read's worth, not the whole burst.
      let big = "";
      while (big.length < 3 * 1024 * 1024) big += `line-${big.length}\n`;
      appendFileSync(path, big);

      const deadline = Date.now() + 2000;
      while (ticks.length < 15 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(ticks.some((t) => t.skipped)).toBe(true);
      const fullSize = readFileSync(path, "utf8").length;
      const lastOffset = ticks[ticks.length - 1]!.offset;
      // Bounded near one capped read, nowhere close to the 3 MiB burst: the
      // first tick (desiredSize still positive) reads at most readCapBytes,
      // which drives desiredSize deeply negative, and every following tick
      // is skipped since nothing ever drains the queue.
      expect(lastOffset).toBeLessThan(fullSize);
      expect(lastOffset).toBeLessThan(2 * 1024 * 1024);
    } finally {
      abort.abort();
    }
  }, 5000);
});

describe("log stream queue bound", () => {
  // Counts queued chunks through desiredSize (highWaterMark minus queued
  // chunks). Direct handleLogStream call, reader never touched; see above.
  async function runUndrained(append: string, opts: { heartbeatMs: number; waitMs: number }) {
    const path = seedLog("worker", "start\n");
    const ticks: { skipped: boolean; offset: number; desiredSize: number | null }[] = [];
    const abort = new AbortController();
    const url = new URL("http://x/api/logs/stream?name=worker");
    handleLogStream(new Request(url, { signal: abort.signal }), url, {
      pollMs: 15,
      heartbeatMs: opts.heartbeatMs,
      queueHighWaterMark: 3,
      onPollTick: (info) => ticks.push(info),
    });
    try {
      if (append) appendFileSync(path, append);
      await new Promise((r) => setTimeout(r, opts.waitMs));
      return ticks;
    } finally {
      abort.abort();
    }
  }

  test("one read of many short lines queues one chunk, not one per line", async () => {
    let many = "";
    while (many.length < 512 * 1024) many += `l${many.length}\n`;
    const ticks = await runUndrained(many, { heartbeatMs: 60_000, waitMs: 200 });
    const lowest = Math.min(...ticks.map((t) => t.desiredSize ?? 0));
    // Connect heartbeat, initial tail and one batch: a handful of chunks,
    // not the ~70k line events this read contains.
    expect(lowest).toBeGreaterThan(-5);
  }, 5000);

  test("heartbeats stop queueing while the client is not reading", async () => {
    const ticks = await runUndrained("", { heartbeatMs: 5, waitMs: 300 });
    const lowest = Math.min(...ticks.map((t) => t.desiredSize ?? 0));
    expect(lowest).toBeGreaterThan(-5);
  }, 5000);
});

function existsWebError(root: string): boolean {
  try {
    const text = readFileSync(join(root, "sil_state_dir", "logs", "web.log"), "utf8");
    return text.includes("ERROR");
  } catch {
    return false;
  }
}
