// Contract stub: replaced by the port. Signatures are the interface other packages code against.
const notImplemented = (name: string): never => { throw new Error(`${name} is not implemented yet`); };

import type { Config, LlmConfig, QueueEntry, World } from "@sil/core";
import type { ChatFn, ChatMessage } from "@sil/providers";
import type { EvidencePack } from "@sil/transcript";

export interface CriticAnswer {
  record: boolean; pattern: string | null; what_worked: string; what_failed: string; lesson: string; verification: string;
  not_verified: string[]; lesson_short: string | null; confidence: number; artifacts_used: string[]; artifacts_helpful: string[];
  artifacts_misfired: Array<{ ref: string; reason: string }>; rules_relevant: string[]; reason?: string;
}
export interface ReflectResult { recorded: boolean; reflection_id: string | null; pattern: string | null; path: string | null; reason: string }
export interface BuildOptions { world: World; existingPatterns: Record<string, number>; installedArtifacts: string[]; recentTitles: string[] }
export interface ReflectOptions { cfg: Config; world: World; llm?: LlmConfig; chat?: ChatFn }

export const CLOSED_PATTERNS: ReadonlySet<string> = new Set(["evidence-level-overclaim"]);
export function installedArtifacts(_world: World, _cfg: Config): string[] { return notImplemented("installedArtifacts"); }
export function buildMessages(_pack: EvidencePack, _opts: BuildOptions): ChatMessage[] { return notImplemented("buildMessages"); }
export function parseAnswer(_text: string): CriticAnswer { return notImplemented("parseAnswer"); }
export async function reflectSession(_entry: QueueEntry, _opts: ReflectOptions): Promise<ReflectResult> { return notImplemented("reflectSession"); }
