// World resolution: which world's nudges/rules apply to a cwd. Ported from
// sil/hook.py's _resolve_world, _cwd_under, _git_head. Mirrors
// packages/core/src/config.ts's worldForCwd without importing config.ts
// (that module pulls in yaml/zod, banned at hook runtime). The matching
// itself lives in @sil/core/hook-snapshot; this file supplies realpath.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { cwdUnder as cwdUnderWith, resolveWorld as resolveWorldWith } from "@sil/core/hook-snapshot";
import type { HookSnapshot, HookWorld } from "./snapshot.ts";
import { defaultWorld } from "./snapshot.ts";

function realOrResolve(p: string): string {
  const abs = resolve(expandHome(p));
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function expandHome(p: string): string {
  if (p === "~") return process.env["HOME"] ?? p;
  if (p.startsWith("~/")) return `${process.env["HOME"] ?? ""}${p.slice(1)}`;
  return p;
}

/** cwd is the repo itself, or under it. Malformed input is not-under, never
 * an exception: a bad path in an inbox lesson must not break delivery. */
export function cwdUnder(cwd: string, repo: string): boolean {
  return cwdUnderWith(cwd, repo, realOrResolve);
}

/** Longest `repos` prefix match on cwd; the first world with an empty
 * `repos` list is the catch-all; no match at all falls back to the built-in
 * default world. */
export function resolveWorld(snapshot: HookSnapshot, cwd: string): HookWorld {
  return resolveWorldWith(snapshot, cwd, realOrResolve, defaultWorld());
}

/** `git rev-parse HEAD` in `cwd`, or null on any failure (not a repo, no
 * git, timeout). Bounded to 1s: this runs on the hook's hot path. */
export function gitHead(cwd: string): string | null {
  try {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 1000,
    });
    if (result.status === 0) {
      const head = (result.stdout ?? "").trim();
      return head || null;
    }
  } catch {
    // not a repo, git missing, or timed out
  }
  return null;
}
