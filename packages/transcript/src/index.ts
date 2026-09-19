// Read a Claude Code session transcript (JSONL) and build a compact evidence
// pack for the critic. Pure apart from the git subprocess calls in evidencePack.

import { existsSync, readFileSync } from "node:fs";
import { adaptOpenclawRecords, isOpenclawRecord } from "./openclaw.ts";

export { adaptOpenclawRecords, isOpenclawRecord } from "./openclaw.ts";

export interface ToolCall { name: string; summary: string; is_error: boolean }
export interface BashCall { command: string; is_error: boolean; tail: string }
export interface HookStat { runs: number; errors: number; max_ms: number }
export interface EvidencePack {
  session_id: string; cwd: string; prompts: string[]; final_assistant_texts: string[]; tool_calls: ToolCall[];
  bash: BashCall[]; test_like: BashCall[]; skills_used: string[]; agents_used: Array<{ subagent_type: string; model: string | null }>;
  hooks: Record<string, HookStat>; errors: string[];
  counts: { tool_uses: number; turns: number; user_prompts: number; attachments: number };
  git: { head_at_start: string | null; head_now: string | null; diff_stat: string; diff_excerpt: string; files_changed: string[] };
}
export interface EvidenceOptions { gitHeadAtStart?: string | null; maxChars?: number }

const NOISE_TYPES = new Set(["ai-title", "last-prompt", "queue-operation", "atis-latch"]);

const TEST_LIKE_RE = /pytest|jest|vitest|go test|cargo test|npm test|pnpm test|make test|ruff|eslint|tsc|mypy/;

// Fields tried in order for a tool_use input's human-readable summary.
const SUMMARY_KEYS = ["command", "file_path", "skill", "subagent_type", "pattern", "path"] as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Yield each JSON object line of a transcript, skipping bad lines. Stops
 * reading once maxBytes of the file have been consumed. */
export function* iterRecords(path: string, maxBytes = 50_000_000): Generator<Record<string, unknown>> {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  let readBytes = 0;
  for (const rawLine of text.split("\n")) {
    readBytes += Buffer.byteLength(rawLine, "utf8") + 1;
    if (readBytes > maxBytes) break;
    const line = rawLine.trim();
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = asRecord(rec);
    if (obj) yield obj;
  }
}

/** Records in Claude Code shape, whatever the host wrote. An OpenClaw
 * transcript is detected from its first record and translated on the fly. */
export function* iterEvidenceRecords(path: string, maxBytes = 50_000_000): Generator<Record<string, unknown>> {
  const raw = iterRecords(path, maxBytes);
  const first = raw.next();
  if (first.done) return;
  if (isOpenclawRecord(first.value)) {
    yield* adaptOpenclawRecords(prepend(first.value, raw));
    return;
  }
  yield first.value;
  yield* raw;
}

function* prepend<T>(head: T, rest: Iterator<T>): Generator<T> {
  yield head;
  for (let step = rest.next(); !step.done; step = rest.next()) yield step.value;
}

export function countToolUses(path: string): number {
  let count = 0;
  for (const rec of iterEvidenceRecords(path)) {
    if (rec["type"] !== "assistant") continue;
    for (const block of contentBlocks(rec)) {
      const b = asRecord(block);
      if (b && b["type"] === "tool_use") count++;
    }
  }
  return count;
}

function contentBlocks(rec: Record<string, unknown>): unknown[] {
  const message = asRecord(rec["message"]) ?? {};
  return asArray(message["content"]);
}

function recordText(rec: Record<string, unknown>): string {
  const message = asRecord(rec["message"]) ?? {};
  const content = message["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((b) => asRecord(b))
      .filter((b): b is Record<string, unknown> => b !== null && b["type"] === "text")
      .map((b) => String(b["text"] ?? ""));
    return parts.join("\n");
  }
  return "";
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      const obj = asRecord(b);
      if (obj && obj["type"] === "text") parts.push(String(obj["text"] ?? ""));
      else if (typeof b === "string") parts.push(b);
    }
    return parts.join("\n");
  }
  if (content === null || content === undefined) return "";
  return String(content);
}

function toolSummary(inp: Record<string, unknown>): string {
  for (const key of SUMMARY_KEYS) {
    const val = inp[key];
    if (val) return String(val);
  }
  return Object.keys(inp).length > 0 ? JSON.stringify(inp).slice(0, 160) : "";
}

interface ToolUseEntry { id: string | null; name: string; summary: string }
interface ToolResult { is_error: boolean; content: string }

function recordHook(rec: Record<string, unknown>, hooks: Record<string, HookStat>): void {
  const att = asRecord(rec["attachment"]);
  if (!att || !att["hookName"]) return;
  const name = String(att["hookName"]);
  const h = (hooks[name] ??= { runs: 0, errors: 0, max_ms: 0 });
  h.runs += 1;
  if (String(att["exitCode"] ?? "0") !== "0") h.errors += 1;
  const ms = Number.parseInt(String(att["durationMs"] ?? "0"), 10);
  h.max_ms = Math.max(h.max_ms, Number.isFinite(ms) ? ms : 0);
}

function recordUser(
  rec: Record<string, unknown>,
  prompts: string[],
  counts: EvidencePack["counts"],
  toolResultById: Map<string, ToolResult>,
  errors: string[],
): void {
  const message = asRecord(rec["message"]) ?? {};
  const content = message["content"];
  const blocks = asArray(content);
  const hasText = typeof content === "string" || blocks.some((b) => {
    const obj = asRecord(b);
    return obj !== null && obj["type"] === "text";
  });
  for (const b of blocks) {
    const obj = asRecord(b);
    if (!obj || obj["type"] !== "tool_result") continue;
    const toolUseId = obj["tool_use_id"];
    const isError = Boolean(obj["is_error"]);
    const contentText = stringifyToolResultContent(obj["content"]);
    if (toolUseId) toolResultById.set(String(toolUseId), { is_error: isError, content: contentText });
    if (isError) errors.push(contentText.slice(0, 300));
  }
  if (hasText) {
    const text = recordText(rec).trim();
    if (text && !text.startsWith("<")) {
      counts.user_prompts += 1;
      prompts.push(text.slice(0, 400));
    }
  }
}

export function evidencePack(transcriptPath: string, cwd: string, opts: EvidenceOptions = {}): EvidencePack {
  const maxChars = opts.maxChars ?? 24_000;
  const gitHeadAtStart = opts.gitHeadAtStart ?? null;

  let sessionId: string | null = null;
  const prompts: string[] = [];
  const finalAssistantTexts: string[] = [];
  const toolUseEntries: ToolUseEntry[] = [];
  const toolResultById = new Map<string, ToolResult>();
  const skillsUsed: string[] = [];
  const agentsUsed: Array<{ subagent_type: string; model: string | null }> = [];
  const hooks: Record<string, HookStat> = {};
  const errors: string[] = [];
  const counts = { tool_uses: 0, turns: 0, user_prompts: 0, attachments: 0 };

  for (const rec of iterEvidenceRecords(transcriptPath)) {
    const rtype = rec["type"];
    if (typeof rtype === "string" && NOISE_TYPES.has(rtype)) continue;
    if (sessionId === null && rec["sessionId"]) sessionId = String(rec["sessionId"]);

    if (rtype === "attachment") {
      counts.attachments += 1;
      recordHook(rec, hooks);
      continue;
    }

    if (rtype === "user") {
      recordUser(rec, prompts, counts, toolResultById, errors);
      continue;
    }

    if (rtype === "assistant") {
      counts.turns += 1;
      const text = recordText(rec);
      if (text && text.trim()) finalAssistantTexts.push(text.trim().slice(0, 800));
      for (const block of contentBlocks(rec)) {
        const b = asRecord(block);
        if (!b || b["type"] !== "tool_use") continue;
        counts.tool_uses += 1;
        const name = String(b["name"] ?? "");
        const inp = asRecord(b["input"]) ?? {};
        const summary = toolSummary(inp);
        toolUseEntries.push({ id: b["id"] != null ? String(b["id"]) : null, name, summary: summary.slice(0, 160) });
        if (name === "Skill" && inp["skill"]) skillsUsed.push(String(inp["skill"]));
        else if (name === "Agent") {
          agentsUsed.push({
            subagent_type: inp["subagent_type"] != null ? String(inp["subagent_type"]) : "",
            model: inp["model"] != null ? String(inp["model"]) : null,
          });
        }
      }
      continue;
    }
    // any other type is ignored, not noise but not evidence either
  }

  const toolCallsFull: ToolCall[] = [];
  const bashFull: BashCall[] = [];
  for (const t of toolUseEntries) {
    const res = (t.id !== null ? toolResultById.get(t.id) : undefined) ?? { is_error: false, content: "" };
    toolCallsFull.push({ name: t.name, summary: t.summary, is_error: res.is_error });
    if (t.name === "Bash") {
      const tail = res.content.slice(-300);
      bashFull.push({ command: t.summary, is_error: res.is_error, tail });
    }
  }

  const toolCalls = toolCallsFull.length > 80 ? [...toolCallsFull.slice(0, 20), ...toolCallsFull.slice(-60)] : toolCallsFull;

  // Most recent bash calls are the ones closest to the session's final state.
  const bash = bashFull.slice(-30);
  const testLike = bash.filter((b) => TEST_LIKE_RE.test(b.command || ""));

  const pack: EvidencePack = {
    session_id: sessionId ?? "",
    cwd: String(cwd),
    prompts: prompts.slice(0, 12),
    final_assistant_texts: finalAssistantTexts.slice(-3),
    tool_calls: toolCalls,
    bash,
    test_like: testLike,
    skills_used: skillsUsed,
    agents_used: agentsUsed,
    hooks,
    errors: errors.slice(0, 15),
    counts,
    git: gitInfo(cwd, gitHeadAtStart),
  };
  return enforceBudget(pack, maxChars);
}

function git(cwd: string, args: string[], timeoutMs = 5000): string | null {
  try {
    const r = Bun.spawnSync(["git", ...args], { cwd, timeout: timeoutMs, stdout: "pipe", stderr: "pipe" });
    return r.success ? r.stdout.toString("utf8") : null;
  } catch {
    return null;
  }
}

function gitInfo(cwd: string, headAtStart: string | null): EvidencePack["git"] {
  const info: EvidencePack["git"] = {
    head_at_start: headAtStart,
    head_now: null,
    diff_stat: "",
    diff_excerpt: "",
    files_changed: [],
  };
  if (git(cwd, ["rev-parse", "--show-toplevel"]) === null) return info;
  const headNow = git(cwd, ["rev-parse", "HEAD"]);
  info.head_now = headNow ? headNow.trim() : null;

  const diffs: string[] = [];
  const stats: string[] = [];
  const names = new Set<string>();
  if (headAtStart) {
    diffs.push(git(cwd, ["diff", `${headAtStart}..HEAD`]) ?? "");
    stats.push(git(cwd, ["diff", "--stat", `${headAtStart}..HEAD`]) ?? "");
    for (const line of (git(cwd, ["diff", "--name-only", `${headAtStart}..HEAD`]) ?? "").split("\n")) {
      if (line.trim()) names.add(line.trim());
    }
  }
  diffs.push(git(cwd, ["diff"]) ?? "");
  stats.push(git(cwd, ["diff", "--stat"]) ?? "");
  for (const line of (git(cwd, ["diff", "--name-only"]) ?? "").split("\n")) {
    if (line.trim()) names.add(line.trim());
  }

  info.diff_excerpt = diffs.filter((d) => d).join("\n").slice(0, 6000);
  info.diff_stat = stats.filter((s) => s).join("\n").trim();
  info.files_changed = [...names].sort();
  return info;
}

function enforceBudget(pack: EvidencePack, maxChars: number): EvidencePack {
  const size = () => JSON.stringify(pack).length;

  if (size() <= maxChars) return pack;

  let excerpt = pack.git.diff_excerpt;
  while (excerpt && size() > maxChars) {
    excerpt = excerpt.slice(0, Math.floor(excerpt.length / 2));
    pack.git.diff_excerpt = excerpt;
  }

  while (pack.tool_calls.length > 20 && size() > maxChars) {
    pack.tool_calls.splice(20, 1);
  }

  while (size() > maxChars && pack.bash.length > 0) {
    const longest = pack.bash.reduce((a, b) => (b.tail.length > a.tail.length ? b : a));
    if (longest.tail.length <= 20) break;
    longest.tail = longest.tail.slice(0, Math.floor(longest.tail.length / 2));
  }

  return pack;
}
