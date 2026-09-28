// Ask the drafter to revise a staged proposal from a human instruction.
//
// Runs the same lint and rule-tag checks staging does, then commits the new
// body on top of the staged branch in a scratch worktree. The base for that
// worktree is the branch itself, so the revision stacks on the commit already
// staged rather than resetting it: unlike an ordinary redraft, a human is
// looking at this branch and a reset would throw away nothing they asked for,
// but would also silently drop any earlier revision. The ledger is never
// touched; only the artifact commit moves.

import { type Config, ReviewError, type ReviewDetail, targetRoot, type World } from "@sil/core";
import { artifacts, draftCaps, git, lint, prompts, sameArtifact } from "@sil/curriculum";
import * as providers from "@sil/providers";
import type { ChatFn } from "@sil/providers";
import { listReflections, recordProposalEvent } from "@sil/store";
import { detail, diff, withTree, withWorkerLock } from "./index.ts";
import { snapshot } from "./snapshot.ts";

export interface ReviseOptions {
  chat?: ChatFn;
}

export interface ReviseResult {
  detail: ReviewDetail;
  diff: string;
  reviewed_state: string;
}

const INSTRUCTION_TITLE_MAX = 60;

function humanBlock(instruction: string): string {
  return (
    "A human reviewer asked for changes to the artifact above. Apply this request. " +
    "It takes precedence over earlier drafting choices, but keep the same artifact type, " +
    "keep everything the request does not touch, and stay within the same format and limits.\n\n" +
    "Reviewer request:\n<<<\n" +
    instruction +
    "\n>>>"
  );
}

export async function revise(
  world: World,
  cfg: Config,
  pattern: string,
  reviewedState: string,
  instruction: string,
  opts: ReviseOptions = {},
): Promise<ReviseResult> {
  const repo = targetRoot(world);
  const defaultRef = git.defaultBranch(repo);
  const snap = snapshot(world, repo, defaultRef, pattern);
  if (reviewedState !== snap.reviewed_state) {
    throw new ReviewError("proposal changed since you opened it; reload");
  }

  const current = detail(world, cfg, pattern);
  if (current.status === "retired") {
    // A staged retirement's branch deletes the artifact; its body is empty.
    // Revising it asks the drafter for a fresh one and commits that onto the
    // retirement branch, so accepting it recreates and relinks a file the
    // human meant to remove.
    throw new ReviewError("a retirement has no artifact to revise; reject it or rehome instead");
  }
  const artifactType = current.artifact_type;
  const existing = artifactType === "rule" ? artifacts.stripRuleTag(current.body, pattern) : current.body;

  const lessons = listReflections(world.name)
    .filter((r) => r.pattern === pattern)
    .map((r) => r.lesson);

  const caps = draftCaps(cfg);
  const messages = prompts.draftMessages(pattern, lessons, existing, artifactType, caps);
  messages.push({ role: "user", content: humanBlock(instruction) });

  const chat = opts.chat ?? providers.chat;
  const raw = await chat("drafter", messages, { world, jsonMode: true });

  let [body] = prompts.parseDraft(raw, { forcedType: artifactType });
  if (artifactType === "rule" && typeof body === "string") body = artifacts.stripRuleTag(body, pattern);

  const groundingText = [...lessons, instruction].join("\n\n");
  const problems = lint(artifactType, body, pattern, groundingText, caps);
  if (problems.length > 0) {
    throw new ReviewError("revision failed lint: " + problems.join("; "));
  }
  if (sameArtifact(body, existing)) {
    throw new ReviewError("the drafter returned the proposal unchanged");
  }

  const rel = artifacts.artifactRel(world, artifactType, pattern);
  if (!rel) throw new ReviewError(`${pattern} (${artifactType}) has no artifact path to write`);
  const branch = snap.branch;
  const firstLine = instruction.split("\n")[0]!.trim().slice(0, INSTRUCTION_TITLE_MAX);
  const message = `revise(${artifactType}): ${pattern}: ${firstLine}`;

  // The digest check above ran before the drafter call, which can take
  // seconds. Another revise, a restage or a rehome can move this branch in
  // that window, so the write half takes the same lock accept uses and
  // rechecks the digest before touching anything: fail fast, then anchor the
  // worktree to the exact commit that check just verified, not the branch
  // name, so a move landing between the recheck and the checkout itself is
  // still caught rather than silently building on top of it.
  withWorkerLock(() => {
    const recheck = snapshot(world, repo, defaultRef, pattern);
    if (recheck.reviewed_state !== reviewedState) {
      throw new ReviewError("proposal changed while the drafter was working; reload and retry");
    }

    withTree(repo, branch, branch, (tree) => {
      const checkedOut = git.git(tree, ["rev-parse", "HEAD"], { check: false });
      if (checkedOut !== recheck.branch_sha) {
        throw new ReviewError(
          `${branch} moved from ${recheck.branch_sha.slice(0, 12)} to ${checkedOut.slice(0, 12) || "an unreadable commit"} ` +
            "while the drafter was working; reload and retry. Nothing was written.",
        );
      }
      if (artifactType === "rule") artifacts.ensureRulesFile(world, tree);
      artifacts.writeArtifact(world, artifactType, pattern, body, tree);
      if (artifactType === "rule") {
        // Diffed against HEAD (the branch's own tip), not the default branch:
        // the branch already carries the staged commit, and comparing to the
        // default branch would flag that whole prior diff as foreign.
        const rulesDiff = git.git(tree, ["diff", "HEAD", "--", rel], { check: false });
        const foreign = artifacts.foreignRuleTags(rulesDiff, pattern);
        if (foreign.length > 0) throw new Error(`${rel} also changes rule(s) for ${foreign.join(", ")}`);
      }
      git.git(tree, ["add", "--", rel]);
      git.git(tree, ["commit", "-q", "-m", message]);
    });

    recordProposalEvent(world.name, pattern, "revised");
  });

  const freshDetail = detail(world, cfg, pattern);
  const freshDiff = diff(world, cfg, pattern);
  return { detail: freshDetail, diff: freshDiff.diff, reviewed_state: freshDetail.reviewed_state };
}
