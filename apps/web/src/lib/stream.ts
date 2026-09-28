// Reads GET /api/logs/stream. EventSource cannot send the X-SIL-* headers the
// server guard requires, so the SSE body is read through fetch instead.

import { authHeaders } from "./api.ts";

/** Parses an SSE body into events. Feed raw chunks; complete events come out. */
export function createSseParser(onEvent: (event: string, data: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length > 0) onEvent(event, data.join("\n"));
    }
  };
}

export interface StreamHandlers {
  onLine: (line: string) => void;
  /** The file was truncated or rotated; lines restart from its first byte. */
  onReset?: () => void;
  /** The log file does not exist yet; the server keeps polling for it. */
  onMissing?: () => void;
}

/** Streams one engine log. Resolves when the server ends the stream, rejects on
 * an HTTP error or an abort through `signal`. */
export async function streamLog(name: string, handlers: StreamHandlers, signal: AbortSignal): Promise<void> {
  const url = new URL("/api/logs/stream", window.location.origin);
  url.searchParams.set("name", name);
  const res = await fetch(url, { headers: authHeaders(), signal });
  if (!res.ok || !res.body) throw new Error(`log stream: HTTP ${res.status}`);
  const feed = createSseParser((event, data) => {
    if (event === "line") handlers.onLine((JSON.parse(data) as { line: string }).line);
    else if (event === "reset") handlers.onReset?.();
    else if (event === "missing") handlers.onMissing?.();
  });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    feed(value);
  }
}
