// Incremental transcript scan at Stop: turns hook-run attachments into usage
// events and counts tool_use blocks into the queue entry. Ported from
// sil/hook.py's _assistant_content, _read_offset, _write_offset,
// _scan_transcript.

import { closeSync, openSync, readSync, readFileSync, statSync } from "node:fs";
import { atomicWrite } from "@sil/core/fsx";
import * as paths from "@sil/core/paths";
import { log } from "./log.ts";
import { bumpToolUses } from "./queue.ts";

export const MAX_TRANSCRIPT_SCAN_BYTES = 20 * 1024 * 1024;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assistantContent(record: Record<string, unknown>): unknown[] {
  const message = record["message"];
  if (isRecord(message) && Array.isArray(message["content"])) return message["content"];
  const content = record["content"];
  return Array.isArray(content) ? content : [];
}

function offsetPath(sessionId: string): string {
  return `${paths.sessionDir(sessionId)}/offset`;
}

function readOffset(path: string): number {
  try {
    const text = readFileSync(path, "utf8").trim();
    const n = Number.parseInt(text || "0", 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeOffset(path: string, value: number): void {
  try {
    atomicWrite(path, String(value));
  } catch {
    // an unwritten offset just re-scans from the old one next time
  }
}

export interface UsageEventSink {
  (kind: string, ref: string, detail: Record<string, unknown>): void;
}

/** Read new bytes from `payload.transcript_path` since the last scan (offset
 * file under the session dir), turn hook-run attachments into usage events
 * via `emit`, and add any tool_use blocks to the session's queue entry.
 * Must run inside the caller's sessionLock: concurrent Stop calls for the
 * same session share the same offset file. */
export function scanTranscript(payload: Record<string, unknown>, sessionId: string, emit: UsageEventSink): void {
  const transcriptPath = payload["transcript_path"];
  if (typeof transcriptPath !== "string" || !transcriptPath) return;

  let size: number;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    return;
  }

  const offPath = offsetPath(sessionId);
  let offset = readOffset(offPath);
  if (offset > size) offset = 0; // transcript rotated or truncated: rescan from the top

  let data: Buffer;
  let fd: number;
  try {
    fd = openSync(transcriptPath, "r");
  } catch {
    return;
  }
  try {
    const toRead = Math.min(MAX_TRANSCRIPT_SCAN_BYTES, size - offset);
    const buf = Buffer.alloc(Math.max(toRead, 0));
    const bytesRead = toRead > 0 ? readSync(fd, buf, 0, toRead, offset) : 0;
    data = buf.subarray(0, bytesRead);
  } catch {
    return;
  } finally {
    closeSync(fd);
  }

  // Only whole lines count; a partial trailing line is left for next call.
  const lastNl = data.lastIndexOf(0x0a);
  if (lastNl === -1 && data.length >= MAX_TRANSCRIPT_SCAN_BYTES) {
    // A single line fills the whole scan cap with no newline in sight.
    // Waiting for one would stall the offset here forever and re-read this
    // same multi-MB blob on every future Stop. Skip past what was read; the
    // oversized record is lost, everything after it is not.
    log(`transcript line exceeds ${MAX_TRANSCRIPT_SCAN_BYTES} bytes, skipping`);
    writeOffset(offPath, offset + data.length);
    return;
  }
  const usable = lastNl !== -1 ? data.subarray(0, lastNl + 1) : Buffer.alloc(0);
  const newOffset = offset + usable.length;

  let toolUses = 0;
  for (const rawLine of usable.toString("utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;

    const rtype = record["type"];
    if (rtype === "attachment") {
      const attachmentRaw = record["attachment"];
      const attachment = isRecord(attachmentRaw) ? attachmentRaw : {};
      const hookName = attachment["hookName"];
      const attType = attachment["type"];
      if (attType === "hook_success" || attType === "hook_error" || attType === "hook_blocked" || hookName) {
        emit("hook_run", `hook:${typeof hookName === "string" && hookName ? hookName : "unknown"}`, {
          exitCode: attachment["exitCode"] ?? null,
          durationMs: attachment["durationMs"] ?? null,
          hookEvent: attachment["hookEvent"] ?? null,
        });
      }
    } else if (rtype === "assistant") {
      for (const block of assistantContent(record)) {
        if (isRecord(block) && block["type"] === "tool_use") toolUses++;
      }
    }
  }

  bumpToolUses(sessionId, toolUses);
  writeOffset(offPath, newOffset);
}
