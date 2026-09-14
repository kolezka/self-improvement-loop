// World resolution: which world's nudges/rules apply to a cwd. Ported from
// sil/hook.py's _resolve_world, _cwd_under, _git_head. Mirrors
// packages/core/src/config.ts's worldForCwd without importing config.ts
// (that module pulls in yaml/zod, banned at hook runtime).

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** cwd is the repo itself, or under it. Malformed input is not-under, never
 * an exception: a bad path in an inbox lesson must not break delivery. */
export function cwdUnder(cwd: string, repo: string): boolean {
  try {
    return isWithin(realOrResolve(cwd), realOrResolve(repo));
  } catch {
    return false;
  }
}

/** Longest `repos` prefix match on cwd; the first world with an empty
 * `repos` list is the catch-all; no match at all falls back to the built-in
 * default world. */
export function resolveWorld(snapshot: HookSnapshot, cwd: string): HookWorld {
  const worlds = snapshot.worlds ?? [];
  const target = realOrResolve(cwd);

  let best: { score: number; world: HookWorld } | null = null;
  let fallback: HookWorld | null = null;
  for (const w of worlds) {
    if (!w || typeof w !== "object") continue;
    const repos = w.repos ?? [];
    if (repos.length === 0 && fallback === null) fallback = w;
    for (const repo of repos) {
      const r = realOrResolve(repo);
      if (isWithin(target, r)) {
        const score = r.split("/").length;
        if (!best || score > best.score) best = { score, world: w };
      }
    }
  }
  if (best) return best.world;
  if (fallback) return fallback;
  return defaultWorld();
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
