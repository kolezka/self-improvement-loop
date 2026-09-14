// The one critic implementation: one model call per session, reporter not
// fixer. Builds a reflection from the transcript evidence pack, never debugs
// or fixes anything itself.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  fsx,
  isSlug,
  loadLlm,
  ledgerPath,
  modelFor,
  paths,
  SECTIONS,
  targetRoot,
  type Config,
  type LlmConfig,
  type QueueEntry,
  type World,
} from "@sil/core";
import type { ChatFn, ChatMessage } from "@sil/providers";
import { chat as defaultChat } from "@sil/providers";
import { loadLedger, patternCounts, listReflections, putLesson, writeReflection } from "@sil/store";
import { evidencePack, type EvidencePack } from "@sil/transcript";

export interface CriticAnswer {
  record: boolean; pattern: string | null; what_worked: string; what_failed: string; lesson: string; verification: string;
  not_verified: string[]; lesson_short: string | null; confidence: number; artifacts_used: string[]; artifacts_helpful: string[];
  artifacts_misfired: Array<{ ref: string; reason: string }>; rules_relevant: string[]; reason?: string;
}
export interface ReflectResult { recorded: boolean; reflection_id: string | null; pattern: string | null; path: string | null; reason: string }
export interface BuildOptions { world: World; existingPatterns: Record<string, number>; installedArtifacts: string[]; recentTitles: string[] }
export interface ReflectOptions { cfg: Config; world: World; llm?: LlmConfig; chat?: ChatFn }

// `evidence-level-overclaim` is closed: reuse it only when the mechanism
// matches exactly. Never coin an evidence-grade sibling (overclaimed-*,
// unverified-*, insufficient-evidence-*); name the mechanism instead
// (stale-cached-env, relayed-subagent-claim, absence-from-filtered-view).
export const CLOSED_PATTERNS: ReadonlySet<string> = new Set(["evidence-level-overclaim"]);

// --- installed artifacts ----------------------------------------------------

/** Every artifact ref this world currently has installed, from the ledger's
 * promoted entries and a scan of the target repo's layout dirs. Never
 * raises: a missing dir or file just contributes nothing. */
export function installedArtifacts(world: World, _cfg: Config): string[] {
  const refs = new Set<string>();
  try {
    const ledger = loadLedger(ledgerPath(world));
    for (const entry of Object.values(ledger.entries)) {
      if (entry.status === "promoted") refs.add(`${entry.artifact_type}:${entry.pattern}`);
    }
  } catch {
    // a corrupt or missing ledger contributes nothing
  }

  let root: string;
  try {
    root = targetRoot(world);
  } catch {
    return [...refs].sort();
  }

  const skillsDir = join(root, world.layout.skills_dir);
  for (const name of listDir(skillsDir)) {
    if (isDir(join(skillsDir, name))) refs.add(`skill:${name}`);
  }

  const nudgesDir = join(root, world.layout.nudges_dir);
  for (const name of listDir(nudgesDir)) {
    if (name.endsWith(".json")) refs.add(`hook:${nudgePattern(join(nudgesDir, name))}`);
  }

  const agentsDir = join(root, world.layout.agents_dir);
  for (const name of listDir(agentsDir)) {
    if (name.endsWith(".md")) refs.add(`agent:${name.replace(/\.md$/, "")}`);
  }

  const rulesFile = join(root, world.layout.rules_file);
  if (fsx.exists(rulesFile)) {
    const text = fsx.readTextOr(rulesFile, "");
    for (const m of text.matchAll(/<!--rule:([a-z0-9-]+)-->/g)) refs.add(`rule:${m[1]}`);
  }

  return [...refs].sort();
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function nudgePattern(p: string): string {
  const stem = p.split("/").pop()!.replace(/\.json$/, "");
  const raw = fsx.readJsonOr<unknown>(p, null);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const pattern = (raw as Record<string, unknown>)["pattern"];
    if (pattern) return String(pattern);
  }
  return stem;
}

// --- prompt ------------------------------------------------------------------

export function buildMessages(pack: EvidencePack, opts: BuildOptions): ChatMessage[] {
  const closed = [...CLOSED_PATTERNS].sort();
  const system =
    "You are a reporter, not a fixer. Audit the claims in this evidence pack " +
    "against the recorded tool calls and their results, not the assistant's " +
    "prose alone. Output STRICT JSON only, no prose, no code fence, with " +
    "exactly these keys: record (bool), pattern (kebab-case slug or null), " +
    "what_worked (string), what_failed (string), lesson (string, one " +
    "concrete imperative rule, <= 300 chars), verification (string: what " +
    "the evidence shows, commands and exit codes), not_verified (list of " +
    "strings), lesson_short (string <= 200 chars for a future session, or " +
    "null), confidence (number 0..1), artifacts_used (list of strings), " +
    "artifacts_helpful (list of strings), artifacts_misfired (list of " +
    '{"ref": string, "reason": string}), rules_relevant (list of strings). ' +
    "artifacts_used/artifacts_helpful/artifacts_misfired/rules_relevant " +
    "must only reference refs from the installed artifacts list, or ones " +
    "derivable from the pack's skills_used/agents_used/hooks fields. Set " +
    "record false and pattern null when there is no concrete reusable " +
    "lesson.\n\n" +
    `The slug(s) ${JSON.stringify(closed)} are CLOSED: reuse one only when ` +
    "the mechanism matches exactly, never coin a sibling like overclaimed-*, " +
    "unverified-* or insufficient-evidence-*. Name the mechanism (e.g. " +
    "stale-cached-env, relayed-subagent-claim, absence-from-filtered-view), " +
    "never the evidence grade. Reuse an existing pattern slug below when its " +
    "mechanism matches this occurrence rather than coining a near-duplicate.";

  const existingDesc =
    Object.entries(opts.existingPatterns)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([p, n]) => `${p} (${n})`)
      .join(", ") || "none yet";

  const user = {
    world: opts.world.name,
    existing_patterns: opts.existingPatterns,
    installed_artifacts: opts.installedArtifacts,
    recent_reflection_ids: opts.recentTitles,
    evidence: pack,
  };

  return [
    { role: "system", content: system },
    {
      role: "user",
      content:
        `Existing pattern slugs and occurrence counts for world ` +
        `${JSON.stringify(opts.world.name)}: ${existingDesc}. Reuse one when the mechanism ` +
        "matches this occurrence.\n\nEvidence pack (JSON):\n" +
        JSON.stringify(user),
    },
  ];
}

// --- answer parsing ------------------------------------------------------------

const FENCE_RE = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/;

export function parseAnswer(text: string): CriticAnswer {
  let cleaned = (text ?? "").trim();
  const fence = FENCE_RE.exec(cleaned);
  if (fence) cleaned = fence[1]!.trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return rejected("no JSON object found in critic reply");

  let data: unknown;
  try {
    data = JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    return rejected(`unparseable critic reply: ${(e as Error).message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return rejected("critic reply JSON is not an object");
  return validated(data as Record<string, unknown>);
}

function rejected(reason: string): CriticAnswer {
  return {
    record: false,
    pattern: null,
    what_worked: "",
    what_failed: "",
    lesson: "",
    verification: "",
    not_verified: [reason],
    lesson_short: null,
    confidence: 0,
    artifacts_used: [],
    artifacts_helpful: [],
    artifacts_misfired: [],
    rules_relevant: [],
    reason,
  };
}

function validated(data: Record<string, unknown>): CriticAnswer {
  const record = Boolean(data["record"]);
  let pattern: string | null = data["pattern"] != null ? String(data["pattern"]) : null;
  if (pattern !== null) pattern = pattern.trim().toLowerCase().replace(/ /g, "-").replace(/-+/g, "-");
  if (record && (!pattern || !isSlug(pattern))) return rejected(`record is true but pattern ${JSON.stringify(pattern)} is not a valid slug`);

  let confidence = 0;
  const rawConfidence = data["confidence"];
  const num = typeof rawConfidence === "number" ? rawConfidence : typeof rawConfidence === "string" ? Number(rawConfidence) : NaN;
  if (Number.isFinite(num)) confidence = Math.max(0, Math.min(1, num));

  const lessonShort = data["lesson_short"];

  return {
    record,
    pattern: record ? pattern : null,
    what_worked: strOr(data["what_worked"]),
    what_failed: strOr(data["what_failed"]),
    lesson: strOr(data["lesson"]).slice(0, 300),
    verification: strOr(data["verification"]),
    not_verified: strList(data["not_verified"]),
    lesson_short: lessonShort ? String(lessonShort).slice(0, 200) : null,
    confidence,
    artifacts_used: strList(data["artifacts_used"]),
    artifacts_helpful: strList(data["artifacts_helpful"]),
    artifacts_misfired: misfiredList(data["artifacts_misfired"]),
    rules_relevant: strList(data["rules_relevant"]),
  };
}

function strOr(v: unknown): string {
  return v ? String(v) : "";
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function misfiredList(v: unknown): Array<{ ref: string; reason: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ ref: string; reason: string }> = [];
  for (const item of v) {
    if (item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>)["ref"]) {
      const obj = item as Record<string, unknown>;
      out.push({ ref: String(obj["ref"]), reason: obj["reason"] ? String(obj["reason"]) : "" });
    } else if (typeof item === "string" && item) {
      out.push({ ref: item, reason: "" });
    }
  }
  return out;
}

// --- reflect -------------------------------------------------------------------

export async function reflectSession(entry: QueueEntry, opts: ReflectOptions): Promise<ReflectResult> {
  const chatFn = opts.chat ?? defaultChat;
  const llmCfg = opts.llm ?? loadLlm(opts.world);
  const model = modelFor(llmCfg, "critic", opts.world); // raises on misconfig; enforces locality

  const pack = evidencePack(entry.transcript_path, entry.cwd, { gitHeadAtStart: entry.git_head });
  const existingPatterns = patternCounts(opts.world.name);
  const recentTitles = listReflections(opts.world.name).slice(0, 25).map((r) => r.id);
  const artifacts = installedArtifacts(opts.world, opts.cfg);

  const messages = buildMessages(pack, {
    world: opts.world,
    existingPatterns,
    installedArtifacts: artifacts,
    recentTitles,
  });
  const raw = await chatFn("critic", messages, { world: opts.world, llm: llmCfg, jsonMode: true });
  const answer = parseAnswer(raw);

  if (!answer.record || !answer.pattern) {
    return {
      recorded: false,
      reflection_id: null,
      pattern: null,
      path: null,
      reason: answer.reason || "not-recorded: no reusable lesson found",
    };
  }

  const pattern = answer.pattern;
  const body = renderBody(pattern, answer);
  const headNow = pack.git.head_now;
  const revision = entry.git_head && headNow ? `${entry.git_head}..${headNow}` : null;
  const meta = {
    session_id: entry.session_id,
    cwd: entry.cwd,
    revision,
    model,
    artifacts_used: answer.artifacts_used,
    artifacts_helpful: answer.artifacts_helpful,
    artifacts_misfired: answer.artifacts_misfired.map((m) => m.ref),
    confidence: answer.confidence,
  };
  const path = writeReflection(opts.world.name, meta, body);
  const reflectionId = path.split("/").pop()!.replace(/\.md$/, "");

  const ts = fsx.nowIso();
  appendFeedbackEvents(opts.world.name, reflectionId, answer, ts);

  if (answer.lesson_short && answer.confidence >= 0.5) {
    putLesson({
      id: reflectionId,
      world: opts.world.name,
      pattern,
      text: answer.lesson_short,
      created: ts,
      reflection_id: reflectionId,
      repo: gitToplevel(entry.cwd),
      deliveries: 0,
    });
  }

  return { recorded: true, reflection_id: reflectionId, pattern, path, reason: "" };
}

function renderBody(pattern: string, answer: CriticAnswer): string {
  const today = fsx.today();
  const notVerifiedText = answer.not_verified.length > 0
    ? answer.not_verified.map((x) => `- ${x}`).join("\n")
    : "none, checked scope: transcript evidence pack and repo diff";
  const [worked, failed, lesson, verification, notVerified] = SECTIONS;
  return (
    `Last updated: ${today}\n\n` +
    `Pattern: ${pattern}\n\n` +
    `${worked}\n` +
    `${answer.what_worked || "n/a"}\n` +
    `${failed}\n` +
    `${answer.what_failed || "n/a"}\n` +
    `${lesson}\n` +
    `${answer.lesson || "n/a"}\n` +
    `${verification}\n` +
    `${answer.verification || "n/a"}\n` +
    `${notVerified}\n` +
    `${notVerifiedText}\n`
  );
}

function appendFeedbackEvents(world: string, reflectionId: string, answer: CriticAnswer, ts: string): void {
  const lines: Record<string, unknown>[] = [];
  for (const ref of answer.artifacts_used) lines.push({ ref, verdict: "used", reflection_id: reflectionId, ts, world });
  for (const ref of answer.artifacts_helpful) lines.push({ ref, verdict: "helpful", reflection_id: reflectionId, ts, world });
  for (const m of answer.artifacts_misfired) lines.push({ ref: m.ref, verdict: "misfired", reflection_id: reflectionId, ts, world, reason: m.reason });
  // The model often names a rule by its slug alone; scorecards join on `rule:<slug>`.
  for (const ref of answer.rules_relevant) lines.push({ ref: ref.includes(":") ? ref : `rule:${ref}`, verdict: "relevant", reflection_id: reflectionId, ts, world });
  if (lines.length === 0) return;
  const path = paths.criticFeedbackFile();
  for (const line of lines) fsx.appendJsonl(path, line);
}

/** The main checkout that owns `cwd`, also from inside a linked worktree.
 *
 * A session that entered a worktree ends with cwd under `.claude/worktrees/`.
 * Keying the lesson on that path made the next session in the main checkout
 * never receive it, so resolve through the common git dir instead. */
function gitToplevel(cwd: string): string | null {
  const run = (args: string[]): string | null => {
    try {
      const r = Bun.spawnSync(["git", ...args], { cwd, timeout: 5000, stdout: "pipe", stderr: "pipe" });
      if (!r.success) return null;
      const out = r.stdout.toString("utf8").trim();
      return out || null;
    } catch {
      return null;
    }
  };
  const common = run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common && common.endsWith("/.git")) return common.slice(0, -"/.git".length);
  return run(["rev-parse", "--show-toplevel"]);
}

