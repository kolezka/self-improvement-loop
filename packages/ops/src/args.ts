// Argument schemas for every op. Same regexes as the Python port (sil/ops.py).
// A pattern or reflection id becomes a filesystem path or a git ref elsewhere
// in the engine; validated here too, at the boundary, rather than trusted
// from callers.

import { z } from "zod";
import { ARTIFACT_REF_RE, LOG_NAMES, ROLES, SLUG_RE, slug, WORLD_NAME_RE } from "@sil/core";

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

export const RehomeArgs = PatternArgs.extend({ artifact_type: z.enum(["skill", "hook", "rule", "agent", "none"]) });
export type RehomeArgs = z.infer<typeof RehomeArgs>;

export const RetireArgs = PatternArgs.extend({ confirm: z.literal(true) });
export type RetireArgs = z.infer<typeof RetireArgs>;

export const SessionArgs = z.object({ session_id: z.string().regex(SESSION_ID_RE) });
export type SessionArgs = z.infer<typeof SessionArgs>;

export const FeedbackArgs = z.object({
  world: z.string().min(1),
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
  world: z.string().min(1),
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
