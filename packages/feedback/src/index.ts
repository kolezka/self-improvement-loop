// Contract stub: replaced by the port. Signatures are the interface other packages code against.
const notImplemented = (name: string): never => { throw new Error(`${name} is not implemented yet`); };

import type { Config, HumanFeedback, Scorecard, UsageEvent, World } from "@sil/core";

export interface ScorecardOptions { now?: Date; windowDays?: number }
export function appendUsage(_event: UsageEvent): void { notImplemented("appendUsage"); }
export function recordHuman(_fb: HumanFeedback): string { return notImplemented("recordHuman"); }
export function listHuman(_world?: string): HumanFeedback[] { return notImplemented("listHuman"); }
export function scorecards(_world: World, _cfg: Config, _opts?: ScorecardOptions): Scorecard[] { return notImplemented("scorecards"); }
export function rebuild(_world: World, _cfg: Config): string { return notImplemented("rebuild"); }
export function load(_world: World): Scorecard[] { return notImplemented("load"); }
