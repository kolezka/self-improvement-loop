// sil review: list, show, accept, reject, rehome, retire staged artifacts.

import type { ArtifactType } from "@sil/core";
import { loadConfig, worldNamed } from "@sil/core";
import { resolveWorld } from "../common.ts";
import { defaultDeps, type Deps } from "../deps.ts";

export interface ReviewListOptions {
  world?: string;
}

export function cmdReviewList(opts: ReviewListOptions, deps: Deps = defaultDeps): number {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const items = deps.review.queue(world, cfg);
  if (items.length === 0) {
    console.log(`no staged reviews for world ${world.name}`);
    return 0;
  }
  for (const it of items) {
    console.log(`${it.pattern.padEnd(30)} ${it.artifact_type.padEnd(6)} count=${String(it.count).padEnd(3)} branch=${it.branch}`);
  }
  return 0;
}

export interface ReviewShowOptions {
  world?: string;
  diff?: boolean;
}

export function cmdReviewShow(pattern: string, opts: ReviewShowOptions, deps: Deps = defaultDeps): number {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  if (opts.diff) {
    const d = deps.review.diff(world, cfg, pattern);
    console.log(d.diff);
    console.log(`\nreviewed_state: ${d.reviewed_state}`);
    return 0;
  }
  const detail = deps.review.detail(world, cfg, pattern);
  console.log(`pattern: ${detail.pattern}`);
  console.log(`type: ${detail.artifact_type}  path: ${detail.artifact_path}`);
  console.log(`branch: ${detail.branch}  count: ${detail.count}`);
  console.log(`reviewed_state: ${detail.reviewed_state}`);
  if (detail.accept_blocked) console.log(`accept blocked: ${detail.accept_blocked}`);
  console.log();
  console.log(detail.body);
  return 0;
}

export interface ReviewAcceptOptions {
  world: string;
  reviewedState: string;
}

export function cmdReviewAccept(pattern: string, opts: ReviewAcceptOptions, deps: Deps = defaultDeps): number {
  const cfg = loadConfig();
  const world = worldNamed(cfg, opts.world);
  const out = deps.review.accept(world, cfg, pattern, opts.reviewedState);
  const what = out.status === "retired" ? "retired" : "accepted";
  console.log(`${what} ${pattern} in world ${world.name}`);
  return 0;
}

export interface ReviewRejectOptions {
  world: string;
}

export function cmdReviewReject(pattern: string, opts: ReviewRejectOptions, deps: Deps = defaultDeps): number {
  const cfg = loadConfig();
  const world = worldNamed(cfg, opts.world);
  deps.review.reject(world, cfg, pattern);
  console.log(`rejected ${pattern} in world ${world.name}`);
  return 0;
}

export interface ReviewRehomeOptions {
  world: string;
  type: ArtifactType;
  yes?: boolean;
}

export function cmdReviewRehome(pattern: string, opts: ReviewRehomeOptions, deps: Deps = defaultDeps): number {
  // `--type none` is a retirement wearing another name: it takes the artifact
  // out of service. Same confirmation as `sil review retire`.
  if (opts.type === "none" && !opts.yes) {
    console.error("error: sil review rehome --type none removes the artifact: pass --yes to confirm");
    return 2;
  }
  const cfg = loadConfig();
  const world = worldNamed(cfg, opts.world);
  // Re-home stages a branch too. "rehomed" read as done, so the old artifact
  // stayed live and the branch sat in the queue with nobody expecting it.
  const out = deps.review.rehome(world, cfg, pattern, opts.type);
  console.log(`staged the re-home of ${pattern} to ${opts.type} on ${out.branch} in world ${world.name}`);
  console.log(`accept it to apply the move: sil review show ${pattern} --world ${world.name}`);
  return 0;
}

export interface ReviewRetireOptions {
  world: string;
  yes?: boolean;
}

export function cmdReviewRetire(pattern: string, opts: ReviewRetireOptions, deps: Deps = defaultDeps): number {
  if (!opts.yes) {
    console.error("error: sil review retire needs --yes to confirm");
    return 2;
  }
  const cfg = loadConfig();
  const world = worldNamed(cfg, opts.world);
  // Retire only stages a branch. Saying "retired" here read as done, so the
  // artifact stayed live until somebody accepted the branch as well.
  const out = deps.review.retire(world, cfg, pattern);
  console.log(`staged the retirement of ${pattern} on ${out.branch} in world ${world.name}`);
  console.log(`accept it to remove the artifact: sil review show ${pattern} --world ${world.name}`);
  return 0;
}
