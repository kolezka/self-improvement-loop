// GET /api/logs/stream: follows one engine log over server-sent events.
//
// The guard runs in main.ts before this is ever called, same as every other
// route. Everything here is the follower itself: a pure byte-range decision
// (nextRange), and the poll loop that reads that range, buffers an incomplete
// trailing line, and restarts from 0 on truncation or rotation.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { LOG_NAMES, paths } from "@sil/core";
import { tailLines } from "@sil/ops";

export interface LogStreamOptions {
  pollMs?: number;
  heartbeatMs?: number;
  initialLines?: number;
}

const DEFAULT_POLL_MS = 500;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_INITIAL_LINES = 500;

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
  const encoder = new TextEncoder();

  let offset = 0;
  let pending = "";
  let missingSent = false;
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
      try {
        size = statSync(path).size;
      } catch {
        exists = false;
      }
      if (exists) {
        for (const line of tailLines(path, initialLines, undefined, size)) send(sseLine(line));
        offset = size;
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
        let size: number;
        try {
          size = statSync(path).size;
        } catch {
          if (!missingSent) {
            send(SSE_MISSING);
            missingSent = true;
          }
          return;
        }
        missingSent = false;
        const range = nextRange(offset, size);
        if (range.reset) {
          send(SSE_RESET);
          pending = "";
        }
        const chunk = readRange(path, range.from, range.to);
        if (chunk) {
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) send(sseLine(line));
        }
        offset = range.to;
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
