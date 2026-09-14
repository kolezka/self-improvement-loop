// Contract stub: replaced by the port. Signatures are the interface other packages code against.
const notImplemented = (name: string): never => { throw new Error(`${name} is not implemented yet`); };

import type { ArtifactType, Config, Ledger, PlanReport, Reflection, RunReport, Scorecard, World } from "@sil/core";
import type { ChatFn } from "@sil/providers";

// Submodules land as: git.ts, artifacts.ts, lint.ts, router.ts, prompts.ts, plan.ts, run.ts.
export interface RunOptions { apply: boolean; chat?: ChatFn; extraDirs?: string[]; cards?: Scorecard[] }
export interface PlanOptions { extraDirs?: string[]; cards?: Scorecard[]; items?: Reflection[] }
export interface Cluster { pattern: string; items: Reflection[] }

export function branchName(_world: string, _pattern: string): string { return notImplemented("branchName"); }
export function reflections(_world: World, _extraDirs?: string[]): Reflection[] { return notImplemented("reflections"); }
export function cluster(_items: Reflection[]): Cluster[] { return notImplemented("cluster"); }
export function sourcesText(_items: Reflection[]): string { return notImplemented("sourcesText"); }
export function lessonTexts(_items: Reflection[]): string[] { return notImplemented("lessonTexts"); }
export function loadLedger(_world: World): Ledger { return notImplemented("loadLedger"); }
export function watermark(_ledger: Ledger, _pattern: string): number { return notImplemented("watermark"); }
export function loadPayloadCorpus(_world?: World): Record<string, unknown>[] { return notImplemented("loadPayloadCorpus"); }
export function plan(_world: World, _cfg: Config, _opts?: PlanOptions): PlanReport { return notImplemented("plan"); }
export async function run(_world: World, _cfg: Config, _opts: RunOptions): Promise<RunReport> { return notImplemented("run"); }
export function artifactRel(_world: World, _type: ArtifactType, _pattern: string): string { return notImplemented("artifactRel"); }
