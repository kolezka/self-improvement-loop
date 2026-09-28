// GET /api/logs/stream: follows one engine log over server-sent events.
//
// The guard runs in main.ts before this is ever called, same as every other
// route. Everything here is the follower itself: a pure byte-range decision
// (nextRange), and the poll loop that reads that range, buffers an incomplete
// trailing line, and restarts from 0 on truncation or rotation.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { fsx, LOG_NAMES, paths } from "@sil/core";
import { tailLines } from "@sil/ops";

export interface LogStreamOptions {
  pollMs?: number;
  heartbeatMs?: number;
  initialLines?: number;
  /** Cap on bytes read in one poll tick; a bigger delta continues over the
   * following ticks instead of one unbounded allocation. */
  readCapBytes?: number;
  /** Cap on the buffered partial line; past this it is flushed as a line of
   * its own rather than growing forever while no newline arrives. */
  pendingCapBytes?: number;
  /** Test-only override for the range reader, letting a test force a read
   * failure (a file removed or replaced between stat and read) without
   * racing a real file system. */
  readRange?: (path: string, from: number, to: number) => string;
}

const DEFAULT_POLL_MS = 500;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_INITIAL_LINES = 500;
const DEFAULT_READ_CAP_BYTES = 1024 * 1024;
const DEFAULT_PENDING_CAP_BYTES = 64 * 1024;

/** Pure follower: given the previous offset and the current file size, what
 * to read next. A shrunk file (truncation or rotation) reads from 0. */
export function nextRange(prevOffset: number, size: number): { from: number; to: number; reset: boolean } {
  if (size < prevOffset) return { from: 0, to: size, reset: true };
  return { from: prevOffset, to: size, reset: false };
}

function readRange(path: string, from: number, to: number): string {
  if (to <= from) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(to - from);
    readSync(fd, buf, 0, to - from, from);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function sseLine(line: string): string {
  return `event: line\ndata: ${JSON.stringify({ line })}\n\n`;
}

function sseError(detail: string): string {
  return `event: error\ndata: ${JSON.stringify({ detail })}\n\n`;
}

const SSE_RESET = "event: reset\ndata: {}\n\n";
const SSE_MISSING = "event: missing\ndata: {}\n\n";
const SSE_HEARTBEAT = ": hb\n\n";

/** name validated against LOG_NAMES; a GET the route in main.ts has already
 * guarded. Response body is a ReadableStream that polls the file on an
 * interval, so its timers stop on request.signal abort and on stream cancel,
 * never leaking past the connection that opened them. */
export function handleLogStream(request: Request, url: URL, opts: LogStreamOptions = {}): Response {
  const name = url.searchParams.get("name") ?? "";
  if (!(LOG_NAMES as readonly string[]).includes(name)) {
    return new Response(JSON.stringify({ detail: `unknown log name: ${JSON.stringify(name)}` }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const path = paths.logFile(name);
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const initialLines = opts.initialLines ?? DEFAULT_INITIAL_LINES;
  const readCapBytes = opts.readCapBytes ?? DEFAULT_READ_CAP_BYTES;
  const pendingCapBytes = opts.pendingCapBytes ?? DEFAULT_PENDING_CAP_BYTES;
  const readRangeFn = opts.readRange ?? readRange;
  const encoder = new TextEncoder();

  let offset = 0;
  let pending = "";
  let missingSent = false;
  let errorSent = false;
  let identity: { dev: number; ino: number } | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let hbTimer: ReturnType<typeof setInterval> | null = null;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string): void => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // Controller already closed by a cancel racing this tick: nothing
          // left to do, the next poll tick finds the cleared timers.
        }
      };

      // A comment flushes the response synchronously even when the file is
      // empty and no line event fires: a client's fetch() otherwise waits for
      // the first body byte to confirm the connection, which never came.
      send(SSE_HEARTBEAT);

      let size = 0;
      let exists = true;
      let initialStat: { size: number; dev: number; ino: number } | null = null;
      try {
        initialStat = statSync(path);
        size = initialStat.size;
      } catch {
        exists = false;
      }
      if (exists) {
        const tail = tailLines(path, initialLines, undefined, size);
        // tailLines splits on "\n" and only drops a trailing empty segment,
        // so a file not ending in a newline leaves a partial line as the
        // last entry. Sending it as a full line now, then the remainder as a
        // second line once the newline lands, tears one line into two.
        const endsInNewline = size === 0 || readRangeFn(path, size - 1, size) === "\n";
        if (!endsInNewline && tail.length > 0) pending = tail.pop() ?? "";
        for (const line of tail) send(sseLine(line));
        offset = size;
        identity = initialStat ? { dev: initialStat.dev, ino: initialStat.ino } : null;
      } else {
        send(SSE_MISSING);
        missingSent = true;
      }

      const stop = (): void => {
        if (pollTimer) clearInterval(pollTimer);
        if (hbTimer) clearInterval(hbTimer);
        pollTimer = null;
        hbTimer = null;
      };

      const poll = (): void => {
        try {
          let stat: { size: number; dev: number; ino: number };
          try {
            stat = statSync(path);
          } catch {
            if (!missingSent) {
              send(SSE_MISSING);
              missingSent = true;
            }
            identity = null;
            return;
          }
          missingSent = false;
          // A file renamed away and recreated can land at the same or a
          // larger size, so a shrink check alone misses it: the identity
          // (dev, ino) changes even when the byte count does not.
          const identityChanged = identity !== null && (stat.ino !== identity.ino || stat.dev !== identity.dev);
          const range = nextRange(offset, stat.size);
          const reset = range.reset || identityChanged;
          if (reset) {
            send(SSE_RESET);
            pending = "";
          }
          const from = reset ? 0 : range.from;
          // A delta bigger than the cap continues on the next tick instead
          // of one unbounded allocation for a burst of writes.
          const to = range.to - from > readCapBytes ? from + readCapBytes : range.to;
          let chunk: string;
          try {
            chunk = readRangeFn(path, from, to);
          } catch (err) {
            const code = err && typeof err === "object" && "code" in err ? String((err as NodeJS.ErrnoException).code) : undefined;
            if (code !== "ENOENT") throw err; // a real problem, handled below
            // The file was removed or replaced between stat and read: a
            // rotation race, not a real error. Forget the old position and
            // identity so the next poll's stat rediscovers the truth,
            // whether that is "still missing" or a fresh file from 0.
            send(SSE_RESET);
            offset = 0;
            pending = "";
            identity = null;
            return;
          }
          if (chunk) {
            pending += chunk;
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) send(sseLine(line));
            // No newline in sight for a very long time: flush what is held
            // rather than growing pending without bound.
            if (Buffer.byteLength(pending, "utf8") > pendingCapBytes) {
              send(sseLine(pending));
              pending = "";
            }
          }
          offset = to;
          identity = { dev: stat.dev, ino: stat.ino };
          errorSent = false;
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          const trace = e.stack ?? `${e.name}: ${e.message}`;
          fsx.appendLine(paths.logFile("web"), `${fsx.nowIso()} ERROR ${trace}`);
          if (!errorSent) {
            send(sseError(e.message));
            errorSent = true;
          }
        }
      };

      pollTimer = setInterval(poll, pollMs);
      hbTimer = setInterval(() => send(SSE_HEARTBEAT), heartbeatMs);

      request.signal.addEventListener("abort", () => {
        stop();
        try {
          controller.close();
        } catch {
          // Already closed by the client cancelling the reader first.
        }
      });
    },
    cancel() {
      if (pollTimer) clearInterval(pollTimer);
      if (hbTimer) clearInterval(hbTimer);
      pollTimer = null;
      hbTimer = null;
    },
  });

  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}
