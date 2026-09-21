// The two operations in this package that reach the network: push, and `gh`.
//
// Everything here runs past the merge boundary, so nothing throws out of
// `publish`: the artifact is already on the default branch and an exception here
// would contradict that. Failures are recorded in the result the caller returns.

import { ReviewError, type World } from "@sil/core";
import { git } from "@sil/curriculum";

export const GH_TIMEOUT_MS = 60_000;
export const NET_TIMEOUT_MS = 120_000;

export interface RemoteOps {
  hasGh(): boolean;
  gh(repo: string, args: string[]): string;
  push(repo: string, args: string[]): void;
  lsRemote(repo: string, ref: string): string;
}

const realOps: RemoteOps = {
  hasGh: () => git.hasGh(),
  gh(repo, args) {
    const exe = Bun.which("gh");
    if (exe === null) throw new ReviewError("gh not found on PATH");
    const proc = Bun.spawnSync([exe, ...args], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      timeout: GH_TIMEOUT_MS,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    if (proc.exitCode !== 0) {
      throw new ReviewError(`gh ${args.join(" ")}: ${proc.stderr.toString().trim() || "failed"}`);
    }
    return proc.stdout.toString().trim();
  },
  push(repo, args) {
    git.git(repo, ["push", ...args], { timeout: NET_TIMEOUT_MS });
  },
  /** What `origin/<ref>` points at on the server right now.
   *
   * `ls-remote` rather than a remote-tracking ref: the tracking ref reports the
   * last fetch, which is the staleness this check exists to catch. */
  lsRemote(repo, ref) {
    const line = git.git(repo, ["ls-remote", "origin", `refs/heads/${ref}`], {
      check: false,
      timeout: NET_TIMEOUT_MS,
    });
    return line ? line.split("\t")[0]!.trim() : "";
  },
};

let override: Partial<RemoteOps> | null = null;

/** Install a stand-in for the network half. Pass null to restore the real one. */
export function setRemoteOps(ops: Partial<RemoteOps> | null): void {
  override = ops;
}

function ops(): RemoteOps {
  return override ? { ...realOps, ...override } : realOps;
}

export interface PublishResult {
  pushed?: boolean;
  pr?: number | null;
  pr_url?: string;
  remote_error?: string;
}

/** Push or open a pull request, per the world's `remote` setting. */
export function publish(
  world: World,
  repo: string,
  defaultRef: string,
  branch: string,
  pattern: string,
  artifactType: string,
  retiring = false,
): PublishResult {
  const out: PublishResult = {};
  if (world.remote === "none") return out;
  const io = ops();

  if (world.remote === "push") {
    try {
      io.push(repo, ["-q", "origin", defaultRef]);
      out.pushed = true;
    } catch (e) {
      out.remote_error = `merged locally, not pushed: ${(e as Error).message}`;
    }
    return out;
  }

  try {
    // Inside the try with the rest of it: accept is already merged by the time
    // publish runs, so every remote step, the probe included, records its own
    // problem instead of throwing back into a caller that cannot unwind.
    if (!io.hasGh()) {
      out.remote_error = "gh not found on PATH; the artifact is merged locally but no pull request was opened";
      return out;
    }
    io.push(repo, ["-q", "-u", "origin", branch]);
    const headAtCreate = git.git(repo, ["rev-parse", branch], { check: false });
    const baseAtCreate = io.lsRemote(repo, defaultRef);
    // A retirement deletes the artifact. Read by a team, a pull request that
    // announces a promotion for it is the same wrong record the ledger kept.
    const title = retiring ? `feat(${artifactType}): retire ${pattern} (reviewed)` : `feat(${artifactType}): ${pattern} (reviewed)`;
    const body = retiring
      ? `Retires \`${pattern}\` in world \`${world.name}\`: the artifact is deleted and nothing serves the pattern. ` +
        "Reviewed in the loop UI: the artifact being removed, its source reflections and the full diff."
      : `Promotes \`${pattern}\` from the curriculum loop in world \`${world.name}\`. ` +
        "Reviewed in the loop UI: the artifact body, its source reflections and the full diff.";
    io.gh(repo, ["pr", "create", "--base", defaultRef, "--head", branch, "--title", title, "--body", body]);
    const listed: unknown = JSON.parse(
      io.gh(repo, ["pr", "list", "--head", branch, "--base", defaultRef, "--state", "open", "--json", "number,url", "--limit", "1"]) || "[]",
    );
    const first = Array.isArray(listed) && listed.length > 0 ? (listed[0] as Record<string, unknown>) : null;
    if (!first) {
      out.remote_error = `opened a pull request for ${branch} but could not read it back`;
      return out;
    }
    out.pr = Number(first["number"]);
    out.pr_url = String(first["url"] ?? "");
    const moved = prMoved(io, repo, defaultRef, out.pr, headAtCreate, baseAtCreate);
    if (moved) {
      out.remote_error = moved;
      return out;
    }
    io.gh(repo, ["pr", "merge", String(out.pr), "--merge"]);
  } catch (e) {
    // Already merged locally; this is a warning.
    out.remote_error = `merged locally, but the pull request step failed: ${(e as Error).message}`;
  }
  return out;
}

/** Why this pull request must not be merged now, or null when nothing moved.
 *
 * Between `pr create` and `pr merge` anyone can push to either side. Merging on
 * the state read at create would publish a head nobody reviewed, or squash it
 * onto a base that changed underneath. Both are recorded and skipped rather than
 * thrown: the artifact is already merged locally by this point. */
function prMoved(
  io: RemoteOps,
  repo: string,
  defaultRef: string,
  number: number,
  headAtCreate: string,
  baseAtCreate: string,
): string | null {
  let headNow: string;
  try {
    const raw: unknown = JSON.parse(io.gh(repo, ["pr", "view", String(number), "--json", "headRefOid"]) || "{}");
    headNow = String((raw as Record<string, unknown>)?.["headRefOid"] ?? "");
  } catch (e) {
    return (
      `could not re-read pull request #${number} before merging it (${(e as Error).message}); ` +
      "merged locally, the pull request is left open"
    );
  }
  if (headNow !== headAtCreate) {
    return (
      `pull request #${number} is at ${headNow.slice(0, 12) || "an unreadable head"}, not the ` +
      `${headAtCreate.slice(0, 12) || "unknown"} commit that was reviewed and pushed; ` +
      "merged locally, the pull request is left open"
    );
  }
  const baseNow = io.lsRemote(repo, defaultRef);
  if (baseNow !== baseAtCreate) {
    return (
      `origin/${defaultRef} moved from ${baseAtCreate.slice(0, 12) || "nothing"} to ` +
      `${baseNow.slice(0, 12) || "nothing"} after the pull request was opened; ` +
      "merged locally, the pull request is left open"
    );
  }
  return null;
}
