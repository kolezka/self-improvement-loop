// Domain schemas. zod is the single source of truth; types are inferred.

import { z } from "zod";
import { ROLES, SLUG_RE, WORLD_NAME_RE } from "./consts.ts";

export const slug = z.string().regex(SLUG_RE).max(64);
export const isoTs = z.string();

// --- config -------------------------------------------------------------

/** Paths inside a world's target repo. Defaults match the built-in `learned/`
 * repo; the V1 dotfiles layout is `claude/skills`, `claude/hooks/nudges`,
 * `claude/agents`, `global.CLAUDE.md`, `claude/skills/promotions.json`. */
export const Layout = z.object({
  skills_dir: z.string().default("skills"),
  nudges_dir: z.string().default("nudges"),
  agents_dir: z.string().default("agents"),
  rules_file: z.string().default("RULES.md"),
  ledger: z.string().default("promotions.json"),
});
export type Layout = z.infer<typeof Layout>;

export const V1_LAYOUT: Layout = {
  skills_dir: "claude/skills",
  nudges_dir: "claude/hooks/nudges",
  agents_dir: "claude/agents",
  rules_file: "global.CLAUDE.md",
  ledger: "claude/skills/promotions.json",
};

export const OutlineExport = z.object({
  base_url: z.string(),
  api_key_env: z.string().default("OUTLINE_API_KEY"),
  collection_id: z.string(),
  parent_document_id: z.string().nullable().default(null),
});
export type OutlineExport = z.infer<typeof OutlineExport>;

export const World = z.object({
  name: z.string().regex(WORLD_NAME_RE),
  llm: z.enum(["local", "cloud"]).default("cloud"),
  repos: z.array(z.string()).default([]),
  target: z.string().nullable().default(null),
  layout: Layout.default(() => Layout.parse({})),
  remote: z.enum(["none", "push", "pr"]).default("none"),
  rules_inject: z.boolean().default(true),
  outline: OutlineExport.nullable().default(null),
  llm_config: z.string().nullable().default(null),
});
export type World = z.infer<typeof World>;

export const Promotion = z.object({
  threshold: z.number().int().min(1).default(3),
  per_run_cap: z.number().int().min(1).default(3),
  auto_merge: z.boolean().default(false),
  retire_after_days: z.number().int().min(1).default(45),
});

export const WorkerConfig = z.object({
  idle_minutes: z.number().int().min(0).default(10),
  curriculum_interval_minutes: z.number().int().min(1).default(60),
  min_tool_uses: z.number().int().min(0).default(6),
  auto_kick: z.boolean().default(true),
});
export type WorkerConfig = z.infer<typeof WorkerConfig>;

export const WebConfig = z.object({ port: z.number().int().default(8766) });

export const Config = z.object({
  version: z.number().int().default(1),
  worlds: z.array(World).default(() => [World.parse({ name: "default" })]),
  promotion: Promotion.default(() => Promotion.parse({})),
  worker: WorkerConfig.default(() => WorkerConfig.parse({})),
  web: WebConfig.default(() => WebConfig.parse({})),
});
export type Config = z.infer<typeof Config>;

// --- llm ----------------------------------------------------------------

export const Endpoint = z.object({
  name: z.string().min(1),
  kind: z.enum(["openai", "claude-cli"]).default("openai"),
  base_url: z.string().nullable().default(null),
  api_key_env: z.string().nullable().default(null),
  timeout_s: z.number().int().min(1).default(240),
  // Model names are per endpoint: LiteLLM wants zai/glm-5.3-flash where
  // claude-cli wants sonnet, so switching provider must not rewrite them.
  models: z.partialRecord(z.enum(ROLES), z.string()).default({}),
  // Merged into every chat request body last, so it can override max_tokens or
  // add provider knobs such as reasoning_effort or thinking.
  extra_body: z.record(z.string(), z.unknown()).default({}),
});
export type Endpoint = z.infer<typeof Endpoint>;

export const LlmConfig = z.object({
  endpoints: z.array(Endpoint).default([]),
  active: z.string().nullable().default(null),
  // Per role override of `active`, so the critic can run on one endpoint while
  // the drafter and judge run on another.
  role_endpoints: z.partialRecord(z.enum(ROLES), z.string()).default({}),
  local_models: z.array(z.string()).default([]),
  // Fallback for a role an endpoint does not name. Pre-switching llm.yaml
  // files carry their models only here.
  models: z.partialRecord(z.enum(ROLES), z.string()).default({}),
});
export type LlmConfig = z.infer<typeof LlmConfig>;

// --- queue --------------------------------------------------------------

export const QueueEntry = z.object({
  session_id: z.string().min(1),
  transcript_path: z.string(),
  cwd: z.string(),
  world: z.string(),
  git_head: z.string().nullable().default(null),
  first_stop: isoTs,
  last_stop: isoTs,
  stops: z.number().int().default(1),
  ended: z.boolean().default(false),
  tool_uses: z.number().int().default(0),
  attempts: z.number().int().default(0),
  result: z.string().nullable().default(null),
});
export type QueueEntry = z.infer<typeof QueueEntry>;

// --- usage / feedback ---------------------------------------------------

/** One line of usage/events.jsonl. kind: skill | agent | agent_stop | hook_run.
 * ref: `<type>:<name>`, e.g. skill:verify-callsites, agent:explorer, hook:PreToolUse:Bash. */
export const UsageEvent = z.object({
  ts: isoTs,
  session_id: z.string(),
  world: z.string(),
  kind: z.string(),
  ref: z.string(),
  detail: z.record(z.string(), z.unknown()).default({}),
});
export type UsageEvent = z.infer<typeof UsageEvent>;

export const ARTIFACT_REF_RE = /^(skill|hook|rule|agent):[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const HumanFeedback = z.object({
  ts: isoTs,
  world: z.string(),
  ref: z.string().regex(ARTIFACT_REF_RE),
  vote: z.enum(["good", "bad"]),
  note: z.string().default(""),
  session_id: z.string().nullable().default(null),
});
export type HumanFeedback = z.infer<typeof HumanFeedback>;

export const Proposal = z.enum(["keep", "refine", "retire-candidate", "new"]);
export type Proposal = z.infer<typeof Proposal>;

export const Scorecard = z.object({
  ref: z.string(),
  type: z.string(),
  name: z.string(),
  uses_30d: z.number().int().default(0),
  fires_30d: z.number().int().default(0),
  helpful: z.number().int().default(0),
  misfired: z.number().int().default(0),
  human_good: z.number().int().default(0),
  human_bad: z.number().int().default(0),
  last_used: isoTs.nullable().default(null),
  proposal: Proposal.default("keep"),
  reason: z.string().default(""),
});
export type Scorecard = z.infer<typeof Scorecard>;

// --- reflections --------------------------------------------------------

export const Reflection = z.object({
  id: z.string(),
  world: z.string(),
  pattern: slug,
  path: z.string(),
  created: z.string(),
  session_id: z.string().nullable().default(null),
  cwd: z.string().nullable().default(null),
  revision: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  artifacts_used: z.array(z.string()).default([]),
  artifacts_helpful: z.array(z.string()).default([]),
  artifacts_misfired: z.array(z.string()).default([]),
  lesson: z.string().default(""),
  body: z.string().default(""),
});
export type Reflection = z.infer<typeof Reflection>;

/** Inbox item delivered to a later session as additionalContext. */
export const Lesson = z.object({
  id: z.string(),
  world: z.string(),
  pattern: slug,
  text: z.string().min(1),
  created: isoTs,
  reflection_id: z.string().nullable().default(null),
  repo: z.string().nullable().default(null),
  deliveries: z.number().int().default(0),
});
export type Lesson = z.infer<typeof Lesson>;

// --- ledger -------------------------------------------------------------

export const ArtifactType = z.enum(["skill", "hook", "rule", "agent", "none"]);
export type ArtifactType = z.infer<typeof ArtifactType>;

export const ArtifactRef = z.object({ type: ArtifactType, path: z.string().nullable().default(null) });
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const PromotionStatus = z.enum(["staged", "promoted", "rejected", "retired"]);
export type PromotionStatus = z.infer<typeof PromotionStatus>;

export const PromotionEntry = z.object({
  pattern: slug,
  promoted_at_count: z.number().int().default(0),
  rejected_at_count: z.number().int().default(0),
  status: PromotionStatus.default("staged"),
  artifact_type: ArtifactType.default("none"),
  served_by: ArtifactRef.nullable().default(null),
  // V1 rows predate this field. Dated now rather than rejected: one old row
  // without it used to make the whole ledger unreadable.
  last_updated: isoTs.default(() => new Date().toISOString()),
  commit: z.string().nullable().default(null),
  feedback: Scorecard.nullable().default(null),
});
export type PromotionEntry = z.infer<typeof PromotionEntry>;

export const Ledger = z.object({
  version: z.number().int().default(1),
  entries: z.record(z.string(), PromotionEntry).default({}),
});
export type Ledger = z.infer<typeof Ledger>;

// --- curriculum reports -------------------------------------------------

export const PlanActionKind = z.enum(["promote", "refine", "over-cap", "below-threshold", "done", "retire-candidate"]);
export type PlanActionKind = z.infer<typeof PlanActionKind>;

export const PlanAction = z.object({
  pattern: slug,
  count: z.number().int(),
  watermark: z.number().int(),
  action: PlanActionKind,
  sources: z.array(z.string()).default([]),
  reason: z.string().default(""),
});
export type PlanAction = z.infer<typeof PlanAction>;

export const PlanReport = z.object({ world: z.string(), threshold: z.number().int(), actions: z.array(PlanAction).default([]) });
export type PlanReport = z.infer<typeof PlanReport>;

export const RunReport = z.object({
  world: z.string(),
  dry_run: z.boolean().default(true),
  staged: z.array(z.string()).default([]),
  merged: z.array(z.string()).default([]),
  gated_out: z.record(z.string(), z.string()).default({}),
  dropped: z.record(z.string(), z.number().int()).default({}),
  started: isoTs,
  finished: isoTs.nullable().default(null),
  error: z.string().nullable().default(null),
});
export type RunReport = z.infer<typeof RunReport>;

// --- review -------------------------------------------------------------

export const ReviewItem = z.object({
  world: z.string(),
  pattern: slug,
  branch: z.string(),
  artifact_type: ArtifactType,
  artifact_path: z.string().nullable().default(null),
  count: z.number().int().default(0),
  staged_at: z.string().nullable().default(null),
  commit: z.string().nullable().default(null),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

export const ReviewDetail = ReviewItem.extend({
  body: z.string().default(""),
  sources: z.array(z.string()).default([]),
  reviewed_state: z.string().regex(/^[0-9a-f]{64}$/),
  accept_blocked: z.string().nullable().default(null),
});
export type ReviewDetail = z.infer<typeof ReviewDetail>;

export const ReviewDiff = z.object({
  world: z.string(),
  pattern: slug,
  diff: z.string(),
  reviewed_state: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ReviewDiff = z.infer<typeof ReviewDiff>;

export const RouterRow = z.object({
  pattern: slug,
  artifact_type: ArtifactType,
  served_by: z.string().nullable().default(null),
  status: z.string(),
  reflections: z.number().int().default(0),
  scorecard: Scorecard.nullable().default(null),
});
export type RouterRow = z.infer<typeof RouterRow>;

// --- hook snapshot ------------------------------------------------------

export const HookWorld = z.object({
  name: z.string(),
  repos: z.array(z.string()),
  nudges_dir: z.string(),
  rules_file: z.string(),
  rules_inject: z.boolean(),
});
export const HookSnapshot = z.object({
  version: z.number().int(),
  worlds: z.array(HookWorld),
  worker: WorkerConfig,
  plugin_root: z.string(),
});
export type HookSnapshot = z.infer<typeof HookSnapshot>;
