// Contract stub: replaced by the port. Signatures are the interface other packages code against.
const notImplemented = (name: string): never => { throw new Error(`${name} is not implemented yet`); };

import type { ArtifactType, Config, ReviewDetail, ReviewDiff, ReviewItem, RouterRow, World } from "@sil/core";

export interface AcceptResult { merged: boolean; status: "promoted"; pattern: string; commit: string | null; link: string | null; link_error?: string; pushed?: boolean; pr?: number | null; remote_error?: string }
export function queue(_world: World, _cfg: Config): ReviewItem[] { return notImplemented("queue"); }
export function detail(_world: World, _cfg: Config, _pattern: string): ReviewDetail { return notImplemented("detail"); }
export function diff(_world: World, _cfg: Config, _pattern: string): ReviewDiff { return notImplemented("diff"); }
export function inventory(_world: World, _cfg: Config): RouterRow[] { return notImplemented("inventory"); }
export function accept(_world: World, _cfg: Config, _pattern: string, _reviewedState: string): AcceptResult { return notImplemented("accept"); }
export function reject(_world: World, _cfg: Config, _pattern: string): Record<string, unknown> { return notImplemented("reject"); }
export function rehome(_world: World, _cfg: Config, _pattern: string, _artifactType: ArtifactType): Record<string, unknown> { return notImplemented("rehome"); }
export function retire(_world: World, _cfg: Config, _pattern: string): Record<string, unknown> { return notImplemented("retire"); }
export function relink(_world: World, _pattern: string, _artifactType: ArtifactType): string | null { return notImplemented("relink"); }
