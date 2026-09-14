// The immutable revisions behind one rendered review, and the digest that binds
// accept to them.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ArtifactType, PromotionEntry, World } from "@sil/core";
import { artifacts, branchName, git } from "@sil/curriculum";
import { parseLedger } from "@sil/store";

// A digest of the rendered review. The prefix keeps the hash domain-separated:
// nothing else in this project hashes the same JSON for a different purpose.
export const DIGEST_PREFIX = "sil.accept.review-state\n";

export interface Snapshot {
  world: string;
  repo: string;
  pattern: string;
  branch: string;
  branch_sha: string;
  base_ref: string;
  base_sha: string;
  reviewed_state: string;
}

export function ledgerRel(world: World): string {
  return world.layout.ledger.replace(/^\/+|\/+$/g, "");
}

/** Resolve the moving refs once and bind their commits together.
 *
 * Everything downstream reads through the commit, never the branch name. A
 * caller that hashed the branch and then read the body through the moving ref
 * could describe one revision while rendering another. */
export function snapshot(world: World, repo: string, defaultRef: string, pattern: string): Snapshot {
  const branch = branchName(world.name, pattern);
  const branchSha = git.git(repo, ["rev-parse", "--verify", `${branch}^{commit}`], { check: false });
  const baseSha = git.git(repo, ["rev-parse", "--verify", `${defaultRef}^{commit}`], { check: false });
  let digest = "";
  if (branchSha && baseSha) {
    // Keys inserted in sorted order and no separator whitespace, so the digest
    // matches the canonical form byte for byte across implementations.
    const canonical = JSON.stringify({
      base_ref: defaultRef,
      base_sha: baseSha,
      branch,
      branch_sha: branchSha,
      pattern,
      repo: resolve(repo),
      version: 1,
      world: world.name,
    });
    digest = createHash("sha256").update(DIGEST_PREFIX + canonical, "utf8").digest("hex");
  }
  return {
    world: world.name,
    repo,
    pattern,
    branch,
    branch_sha: branchSha,
    base_ref: defaultRef,
    base_sha: baseSha,
    reviewed_state: digest,
  };
}

/** This pattern's ledger row as committed at `ref`, or null when unreadable. */
export function branchEntry(world: World, repo: string, ref: string, pattern: string): PromotionEntry | null {
  const { found, text } = git.show(repo, ref, ledgerRel(world));
  if (!found) return null;
  try {
    return parseLedger(text, ref).entries[pattern] ?? null;
  } catch {
    // A malformed ledger is an unknown ledger.
    return null;
  }
}

/** The type a branch's row actually describes, served_by first.
 *
 * They disagree in exactly the re-home case, where `served_by` is the new type
 * and `artifact_type` may still be the old one. */
export function entryType(entry: PromotionEntry | null): ArtifactType {
  if (!entry) return "skill";
  if (entry.served_by && entry.served_by.type !== "none") return entry.served_by.type;
  return entry.artifact_type;
}

/** (found, body) for this pattern's artifact at `ref`.
 *
 * For "rule" only the pattern's own tagged bullet, never the whole shared file:
 * every pattern's rule lives in it, and returning it whole would render another
 * world's boot contract as this pattern's body. */
export function artifactBody(
  world: World,
  repo: string,
  ref: string,
  artifactType: ArtifactType,
  pattern: string,
): { found: boolean; body: string } {
  const rel = artifacts.artifactRel(world, artifactType, pattern);
  if (!rel) return { found: artifactType === "none", body: "" };
  const { found, text } = git.show(repo, ref, rel);
  if (artifactType === "rule") {
    return { found, body: text ? artifacts.ruleBulletInText(text, pattern) : "" };
  }
  return { found, body: text };
}

/** Files this branch changes that do not belong to `pattern`.
 *
 * Judged by path, never by commit count. A re-homed pattern legitimately carries
 * several commits (each landing on top so the operator's override is not
 * orphaned), and a count-based guard refused every migration while still letting
 * two unrelated commits ride into a pull request because the shape it saw most
 * often was one commit. */
export function foreignPaths(world: World, repo: string, snap: Snapshot, pattern: string): string[] {
  const allowed = artifacts.allowedPaths(world, pattern);
  const touched = git.commitPaths(repo, snap.base_sha, snap.branch_sha);
  return touched.filter((p) => !allowed.has(p)).sort();
}
