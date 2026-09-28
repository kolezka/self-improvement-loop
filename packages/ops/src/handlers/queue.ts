import { existsSync, readFileSync } from "node:fs";
import { fsx, ValidationError } from "@sil/core";
import { SECRET_RE } from "@sil/curriculum";
import { isHidden, listQueue, listReflections, loadEntry, loadQueueCleared, setQueueCleared, type Bucket } from "@sil/store";
import { iterEvidenceRecords } from "@sil/transcript";
import type { ClearArgs, NoArgs, SessionArgs, WorldArgs } from "../args.ts";
import { cfgWorld } from "../cfg-world.ts";
import { deps } from "../deps.ts";
import { spawnCli } from "../spawn.ts";

// SECRET_RE has no "g" flag (it is used as a one-shot test elsewhere), so a
// global copy is needed here to replace every match, not just the first.
const SECRET_RE_GLOBAL = new RegExp(SECRET_RE.source, SECRET_RE.flags.includes("g") ? SECRET_RE.flags : `${SECRET_RE.flags}g`);

/** A transcript preview can carry raw command output; redact anything that
 * looks like a key, token or password before it leaves the server. */
function redactSecrets(text: string): string {
  return text.replace(SECRET_RE_GLOBAL, "[redacted]");
}

const QUEUE_LIST_CAP = 200;

function byLastStopDesc(a: { last_stop: string }, b: { last_stop: string }): number {
  return a.last_stop < b.last_stop ? 1 : a.last_stop > b.last_stop ? -1 : 0;
}

function capped(bucket: Bucket) {
  return [...listQueue(bucket)].sort(byLastStopDesc).slice(0, QUEUE_LIST_CAP);
}

// web console: history and queue ops
/** Entries not hidden by the bucket's clear cutoff, capped after hiding: the
 * cap bounds what the console renders, hidden counts the whole bucket. */
function visibleCapped(bucket: Bucket, clearedBefore: string | null): { visible: ReturnType<typeof listQueue>; hidden: number } {
  const all = listQueue(bucket);
  const shown = all.filter((e) => !isHidden(e, clearedBefore));
  return { visible: shown.sort(byLastStopDesc).slice(0, QUEUE_LIST_CAP), hidden: all.length - shown.length };
}

export function queueList(_args: NoArgs) {
  const cleared = loadQueueCleared();
  const done = visibleCapped("done", cleared.done);
  const failed = visibleCapped("failed", cleared.failed);
  return {
    pending: capped("pending"),
    done: done.visible,
    failed: failed.visible,
    hidden: { done: done.hidden, failed: failed.hidden },
    cleared,
  };
}

export function queueClear(args: ClearArgs) {
  return setQueueCleared(args.bucket, fsx.nowIso());
}

export function queueUnclear(args: ClearArgs) {
  return setQueueCleared(args.bucket, null);
}
// end: web console: history and queue ops

export function queueSkip(args: SessionArgs) {
  return { session_id: args.session_id, skipped: deps.worker.skipSession(args.session_id) };
}

const TRANSCRIPT_MESSAGE_LIMIT = 40;
const TRANSCRIPT_TEXT_MAX_CHARS = 2000;
const DETAIL_BUCKETS: Bucket[] = ["pending", "done", "failed"];

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Readable text for one transcript record: joined text blocks, plus a short
 * marker for a tool use or its result so the preview is not just prose. */
function messageText(rec: Record<string, unknown>): string {
  const message = asRecord(rec["message"]) ?? {};
  const content = message["content"];
  if (typeof content === "string") return redactSecrets(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    if (b["type"] === "text") parts.push(String(b["text"] ?? ""));
    else if (b["type"] === "tool_use") parts.push(`[tool_use: ${String(b["name"] ?? "")}]`);
    else if (b["type"] === "tool_result") {
      // Command output can carry anything, secrets included, and is not
      // useful as a queue preview anyway: report its size, never its text.
      const c = b["content"];
      const text = typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.map((x) => (asRecord(x)?.["type"] === "text" ? String(asRecord(x)?.["text"] ?? "") : "")).join("\n")
          : "";
      parts.push(`[tool_result: ${text.length} chars${b["is_error"] ? " error" : ""}]`);
    }
  }
  return redactSecrets(parts.join("\n").trim());
}

/** The last `limit` user/assistant messages with actual text: hook
 * attachments, ai-title lines and empty tool-only turns are not a message. */
function transcriptMessages(path: string, limit: number, maxChars: number): { role: string; text: string; ts: string | null }[] {
  const out: { role: string; text: string; ts: string | null }[] = [];
  for (const rec of iterEvidenceRecords(path)) {
    if (rec["type"] !== "user" && rec["type"] !== "assistant") continue;
    const text = messageText(rec).trim();
    if (!text) continue;
    const message = asRecord(rec["message"]) ?? {};
    const role = typeof message["role"] === "string" ? (message["role"] as string) : String(rec["type"]);
    const ts = typeof rec["timestamp"] === "string" ? (rec["timestamp"] as string) : null;
    out.push({ role, text: text.length > maxChars ? text.slice(0, maxChars) : text, ts });
  }
  return out.slice(-limit);
}

/** iterEvidenceRecords swallows a read failure (EACCES, a race) into an
 * empty generator, which would otherwise surface as an empty transcript
 * instead of the error it actually is. A direct read first tells them apart:
 * missing is "not persisted", anything else is a real failure to report. */
function transcriptStatus(path: string): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(path)) return { ok: false, reason: "transcript not persisted" };
  try {
    readFileSync(path, "utf8");
    return { ok: true };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as NodeJS.ErrnoException).code) : String(err);
    return { ok: false, reason: `transcript unreadable: ${code}` };
  }
}

export function queueDetail(args: SessionArgs) {
  for (const bucket of DETAIL_BUCKETS) {
    const entry = loadEntry(bucket, args.session_id);
    if (!entry) continue;
    const reflectionIds = listReflections(entry.world)
      .filter((r) => r.session_id === entry.session_id)
      .map((r) => r.id);
    const status = transcriptStatus(entry.transcript_path);
    return {
      bucket,
      entry,
      reflection_ids: reflectionIds,
      transcript: status.ok ? transcriptMessages(entry.transcript_path, TRANSCRIPT_MESSAGE_LIMIT, TRANSCRIPT_TEXT_MAX_CHARS) : null,
      transcript_reason: status.ok ? null : status.reason,
    };
  }
  throw new ValidationError(`unknown session: ${JSON.stringify(args.session_id)}`);
}

export function workerStatus(_args: NoArgs) {
  return deps.worker.status();
}

export function loopRun(args: WorldArgs) {
  const [, world] = cfgWorld(args.world);
  return spawnCli(["worker", "--once", "--world", world.name], "worker");
}
