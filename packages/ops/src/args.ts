// Argument schemas for every op. Same regexes as the Python port (sil/ops.py).
// A pattern or reflection id becomes a filesystem path or a git ref elsewhere
// in the engine; validated here too, at the boundary, rather than trusted
// from callers.

import { z } from "zod";
import { ARTIFACT_REF_RE, LOG_NAMES, ROLES, SLUG_RE, slug, WORLD_NAME_RE } from "@sil/core";
import { CURATION_MAX_SEARCH_CHARS } from "@sil/core/curation-read";
import {
  CURATION_REQUEST_ID_RE,
  MAX_ENCODED_KEY_CHARS,
  PROJECT_ID_RE,
  decodeLessonKey,
  type LessonKey,
  type ProjectScope,
  type StoreBinding,
} from "@sil/core/lesson-curation";

export const REVIEWED_STATE_RE = /^[0-9a-f]{64}$/;
// The same regex the config schema uses. A second copy here once let a world
// pass `sil worlds add` and then 400 on every op the web UI called for it.
export const WORLD_RE = WORLD_NAME_RE;
export const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export const NoArgs = z.object({});
export type NoArgs = z.infer<typeof NoArgs>;

export const WorldArgs = z.object({ world: z.string().regex(WORLD_RE).max(64) });
export type WorldArgs = z.infer<typeof WorldArgs>;

export const PatternArgs = WorldArgs.extend({ pattern: slug });
export type PatternArgs = z.infer<typeof PatternArgs>;

export const AcceptArgs = PatternArgs.extend({ reviewed_state: z.string().regex(REVIEWED_STATE_RE) });
export type AcceptArgs = z.infer<typeof AcceptArgs>;

// `none` is not a re-home, it is a retirement proposal: it drops the artifact
// from the ledger's service. Same confirmation the retire op asks for, because
// the two do the same thing to the operator's artifact.
export const RehomeArgs = PatternArgs.extend({
  artifact_type: z.enum(["skill", "hook", "rule", "agent", "none"]),
  confirm: z.boolean().default(false),
}).refine((a) => a.artifact_type !== "none" || a.confirm === true, {
  message: "artifact_type \"none\" removes the artifact: pass confirm: true",
  path: ["confirm"],
});
export type RehomeArgs = z.infer<typeof RehomeArgs>;

export const RetireArgs = PatternArgs.extend({ confirm: z.literal(true) });
export type RetireArgs = z.infer<typeof RetireArgs>;

export const DeleteArgs = PatternArgs.extend({ confirm: z.literal(true) });
export type DeleteArgs = z.infer<typeof DeleteArgs>;

export const SessionArgs = z.object({ session_id: z.string().regex(SESSION_ID_RE) });
export type SessionArgs = z.infer<typeof SessionArgs>;

// web console: history and queue ops
export const ClearArgs = z.object({ bucket: z.enum(["done", "failed"]) });
export type ClearArgs = z.infer<typeof ClearArgs>;
export const HistoryArgs = WorldArgs.extend({ days: z.coerce.number().int().min(1).max(90).default(30) });
export type HistoryArgs = z.infer<typeof HistoryArgs>;
// end: web console: history and queue ops

export const FeedbackArgs = z.object({
  world: z.string().regex(WORLD_RE).max(64),
  ref: z.string().regex(ARTIFACT_REF_RE),
  vote: z.enum(["good", "bad"]),
  note: z.string().default(""),
});
export type FeedbackArgs = z.infer<typeof FeedbackArgs>;

export const LogArgs = z.object({
  name: z.enum(LOG_NAMES),
  lines: z.coerce.number().int().min(1).max(2000).default(200),
});
export type LogArgs = z.infer<typeof LogArgs>;

export const LlmArgs = z.object({ llm: z.record(z.string(), z.unknown()) });
export type LlmArgs = z.infer<typeof LlmArgs>;

export const LlmUseArgs = z.object({ endpoint: z.string().min(1).max(64), role: z.enum(ROLES).optional() });
export type LlmUseArgs = z.infer<typeof LlmUseArgs>;

export const ConfigArgs = z.object({ config: z.record(z.string(), z.unknown()) });
export type ConfigArgs = z.infer<typeof ConfigArgs>;

export const AliasArgs = z.object({
  world: z.string().regex(WORLD_RE).max(64),
  aliases: z.record(z.string(), z.string()).refine(
    (m) => Object.entries(m).every(([k, v]) => SLUG_RE.test(k) && SLUG_RE.test(v)),
    { message: "alias entries must be slugs" },
  ),
});
export type AliasArgs = z.infer<typeof AliasArgs>;

export const ReflectionArgs = WorldArgs.extend({ id: z.string().regex(SLUG_RE).max(128) });
export type ReflectionArgs = z.infer<typeof ReflectionArgs>;

export const ReflectionListArgs = WorldArgs.extend({
  pattern: z.string().regex(SLUG_RE).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(200),
});
export type ReflectionListArgs = z.infer<typeof ReflectionListArgs>;

// web console: live logs and revise
export const ReviseArgs = AcceptArgs.extend({ instruction: z.string().trim().min(1).max(4000) });
export type ReviseArgs = z.infer<typeof ReviseArgs>;

// web console: refine and escalated review
// Both bounds match ReviseArgs.instruction, verified against the live schema
// above. `instruction` is optional: a Refine click may carry no human text at
// all, grounded instead in new evidence. `reason` is the server's own current
// escalation reason (curriculum.plan's action.reason), sent by the Escalated
// section so it reaches the drafter even when the operator typed nothing;
// bounding and validating it here, not trusting whatever a client sends,
// is what keeps the drafter's context to this server's own current read.
export const RefineArgs = PatternArgs.extend({
  instruction: z.string().trim().min(1).max(4000).optional(),
  reason: z.string().trim().min(1).max(4000).optional(),
});
export type RefineArgs = z.infer<typeof RefineArgs>;

// Lesson curation reads. Flat string args, one schema for HTTP query strings
// and control reads, so both transports decode the same way.
const FLAT_BINDING_RE = /^(installation):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$|^(location):([0-9a-f]{64})$/;
const FLAT_LIMIT_RE = /^[1-9][0-9]{0,2}$/;

const flatBinding = z.string().regex(FLAT_BINDING_RE).transform((value): StoreBinding => {
  const at = value.indexOf(":");
  return { kind: value.slice(0, at) as StoreBinding["kind"], id: value.slice(at + 1) };
});
const flatProject = z
  .union([z.literal("world"), z.literal("unresolved"), z.string().regex(PROJECT_ID_RE)])
  .transform((value): ProjectScope => (value === "world" || value === "unresolved" ? { kind: value } : { kind: "project", id: value }));
const flatKey = z
  .string()
  .min(1)
  .max(MAX_ENCODED_KEY_CHARS)
  .transform((value, ctx): LessonKey => {
    try {
      return decodeLessonKey(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid lesson key" });
      return z.NEVER;
    }
  });
// Exactly "true" or "false". z.coerce.boolean would read "false" as true.
const flatBoolean = z.enum(["true", "false"]).transform((value) => value === "true");
const flatLimit = z.string().regex(FLAT_LIMIT_RE).transform(Number);
const flatCursor = z.string().min(1).max(4096);

export const LessonsProjectsArgs = z.strictObject({ world: z.string().regex(WORLD_RE).max(64), binding: flatBinding });
export type LessonsProjectsArgs = z.infer<typeof LessonsProjectsArgs>;

export const LessonsContextArgs = z.strictObject({ world: z.string().regex(WORLD_RE).max(64), cwd: z.string().min(1).max(4096) });
export type LessonsContextArgs = z.infer<typeof LessonsContextArgs>;

export const LessonsBrowseArgs = z.strictObject({
  world: z.string().regex(WORLD_RE).max(64),
  project: flatProject,
  binding: flatBinding,
  collection: z.enum(["saved", "inbox", "archived", "all"]),
  important: flatBoolean.optional(),
  search: z.string().max(CURATION_MAX_SEARCH_CHARS).optional(),
  cursor: flatCursor.optional(),
  limit: flatLimit.optional(),
});
export type LessonsBrowseArgs = z.infer<typeof LessonsBrowseArgs>;

export const LessonsRecordArgs = z.strictObject({ key: flatKey, project: flatProject, binding: flatBinding });
export type LessonsRecordArgs = z.infer<typeof LessonsRecordArgs>;

export const LessonsLocateArgs = z.strictObject({ key: flatKey, binding: flatBinding });
export type LessonsLocateArgs = z.infer<typeof LessonsLocateArgs>;

export const LessonsHistoryArgs = LessonsRecordArgs.extend({ cursor: flatCursor.optional(), limit: flatLimit.optional() }).strict();
export type LessonsHistoryArgs = z.infer<typeof LessonsHistoryArgs>;

export const LessonsReceiptArgs = LessonsRecordArgs.extend({ requestId: z.string().regex(CURATION_REQUEST_ID_RE) }).strict();
export type LessonsReceiptArgs = z.infer<typeof LessonsReceiptArgs>;

export const LessonsStoreArgs = z.strictObject({});
export type LessonsStoreArgs = z.infer<typeof LessonsStoreArgs>;

// Curation mutations never parse through the registry: the mutation
// dispatcher owns their validation, so this refuses any direct invoke.
export const CurationMutationOpArgs = z.never();
