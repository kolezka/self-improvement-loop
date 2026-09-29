// Version and changelog for the release workflow.
//
//   bun scripts/release-notes.ts version <patch|minor|major>   prints the next version
//   bun scripts/release-notes.ts changelog <version>           prints markdown since the last v* tag
//
// The workflow calls this instead of inline shell so the bump rule and the
// changelog grouping are tested.

export type Bump = "patch" | "minor" | "major";

export interface Commit {
  sha: string;
  subject: string;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;
// Release bookkeeping the workflow itself writes, and merge commits, which
// repeat what their branch already lists.
const SKIP = [/^Merge /, /^chore: bump version to /, /^chore\(release\):/];

/** The version one step above `current`. Only the three bump kinds are accepted. */
export function nextVersion(current: string, bump: string): string {
  const match = SEMVER.exec(current);
  if (!match) throw new Error(`current version ${JSON.stringify(current)} is not x.y.z`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`bump must be patch, minor or major, got ${JSON.stringify(bump)}`);
}

function entry(c: Commit, scope: string | undefined, text: string): string {
  return scope ? `- **${scope}:** ${text} (${c.sha})` : `- ${text} (${c.sha})`;
}

export function renderChangelog(previousTag: string | null, version: string, commits: Commit[]): string {
  const groups: Record<"Breaking" | "Features" | "Fixes" | "Other", string[]> = {
    Breaking: [],
    Features: [],
    Fixes: [],
    Other: [],
  };
  for (const c of commits) {
    if (SKIP.some((re) => re.test(c.subject))) continue;
    const m = CONVENTIONAL.exec(c.subject);
    if (!m) {
      groups.Other.push(`- ${c.subject} (${c.sha})`);
      continue;
    }
    const [, type, scope, bang, text] = m;
    if (bang) groups.Breaking.push(entry(c, scope, text!));
    else if (type === "feat") groups.Features.push(entry(c, scope, text!));
    else if (type === "fix" || type === "perf") groups.Fixes.push(entry(c, scope, text!));
    else groups.Other.push(`- ${c.subject} (${c.sha})`);
  }

  const heading = previousTag ? `## Changes since ${previousTag}` : `## Changes in ${version}`;
  const sections = Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([title, items]) => `### ${title}\n\n${items.join("\n")}`);
  if (sections.length === 0) {
    return `${heading}\n\n${previousTag ? `No changes since ${previousTag}.` : "No changes."}\n`;
  }
  return `${heading}\n\n${sections.join("\n\n")}\n`;
}

function git(args: string[]): string {
  const out = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString().trim()}`);
  return out.stdout.toString().trim();
}

/** Highest v<x.y.z> tag by version, not by date. Tags sit on release commits
 * off main, so `git describe` from main would not see them. */
function previousTag(): string | null {
  const tags = git(["tag", "--list", "v*", "--sort=-v:refname"]).split("\n").filter((t) => SEMVER.test(t.slice(1)));
  return tags[0] ?? null;
}

function commitsSince(tag: string | null): Commit[] {
  const range = tag ? [`${tag}..HEAD`] : ["HEAD"];
  const raw = git(["log", "--no-merges", "--format=%h%x09%s", ...range]);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split("\t");
      return { sha: sha!, subject: rest.join("\t") };
    });
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "version" && arg) {
    const current = (await Bun.file(new URL("../package.json", import.meta.url)).json()).version as string;
    console.log(nextVersion(current, arg));
  } else if (cmd === "changelog" && arg) {
    const tag = previousTag();
    process.stdout.write(renderChangelog(tag, arg, commitsSince(tag)));
  } else {
    console.error("usage: release-notes.ts version <patch|minor|major> | changelog <version>");
    process.exit(2);
  }
}
