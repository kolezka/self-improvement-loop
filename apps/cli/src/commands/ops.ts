// `sil ops`: read one control request on stdin, write one response envelope
// on stdout. Exit 0 for a valid envelope (even with per-read errors), 2 for
// invalid input, 1 for an unexpected host failure. Diagnostics go to stderr.

import "@sil/ops";
import { decodeControlRequestBytes, executeControlRead, redactMessage } from "@sil/ops/control";
import { CONTROL_MAX_REQUEST_BYTES, ControlProtocolError, encodeControlResponse } from "@sil/core/control-protocol";

/** Read at most `limit + 1` bytes, so an oversize request is detected
 * without buffering all of it. Returns null when the input is over limit. */
async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export async function cmdOps(
  input: ReadableStream<Uint8Array> = Bun.stdin.stream(),
  write: (text: string) => Promise<unknown> = (text) => Bun.write(Bun.stdout, text),
): Promise<number> {
  let text: string;
  try {
    const bytes = await readBounded(input, CONTROL_MAX_REQUEST_BYTES);
    if (bytes === null) throw new ControlProtocolError(`request: too large (over ${CONTROL_MAX_REQUEST_BYTES} bytes)`);
    const request = decodeControlRequestBytes(bytes);
    text = encodeControlResponse(await executeControlRead(request));
  } catch (err) {
    if (err instanceof ControlProtocolError) {
      console.error(`sil ops: invalid request: ${err.message}`);
      return 2;
    }
    console.error(`sil ops: internal error: ${redactMessage(err instanceof Error ? `${err.name}: ${err.message}` : String(err))}`);
    return 1;
  }
  // Awaited so process.exit in main.ts cannot cut a large envelope short.
  try {
    await write(`${text}\n`);
  } catch (err) {
    console.error(`sil ops: could not write the response: ${redactMessage(err instanceof Error ? `${err.name}: ${err.message}` : String(err))}`);
    return 1;
  }
  return 0;
}
