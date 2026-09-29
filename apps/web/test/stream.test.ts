import { describe, expect, test } from "bun:test";
import { createSseParser, streamLog } from "../src/lib/stream.ts";

describe("createSseParser", () => {
  test("emits events split across chunks and ignores comments", () => {
    const got: [string, string][] = [];
    const feed = createSseParser((e, d) => got.push([e, d]));
    feed(': heartbeat\n\nevent: line\ndata: {"line":"a"}\n');
    feed('\nevent: line\ndata: {"line":"b"}\n\n');
    expect(got).toEqual([
      ["line", '{"line":"a"}'],
      ["line", '{"line":"b"}'],
    ]);
  });

  test("joins multi-line data with newlines and defaults event to message", () => {
    const got: [string, string][] = [];
    const feed = createSseParser((e, d) => got.push([e, d]));
    feed("data: x\ndata: y\n\n");
    expect(got).toEqual([["message", "x\ny"]]);
  });

  test("holds an unterminated event until its blank line arrives", () => {
    const got: [string, string][] = [];
    const feed = createSseParser((e, d) => got.push([e, d]));
    feed("event: reset\ndata: {}\n");
    expect(got).toEqual([]);
    feed("\n");
    expect(got).toEqual([["reset", "{}"]]);
  });
});

describe("streamLog", () => {
  test("routes an event: error to onError with its detail, not onLine", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: error\ndata: {"detail":"boom"}\n\n'));
        controller.close();
      },
    });
    const originalFetch = globalThis.fetch;
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { location: { origin: "http://test.local", hash: "", pathname: "/", search: "" } };
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    try {
      const errors: string[] = [];
      const lines: string[] = [];
      await streamLog(
        "worker",
        { onLine: (l) => lines.push(l), onError: (d) => errors.push(d) },
        new AbortController().signal,
      );
      expect(errors).toEqual(["boom"]);
      expect(lines).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });
});
