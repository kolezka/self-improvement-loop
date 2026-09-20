// Where each artifact type lives in a world's target repo, and how it is written.
//
// Disk only: no git, no network. The caller decides what gets committed, which is
// what lets `run()` and `review.accept()` write into a scratch worktree instead of
// the operator's checkout.
//
// Every path comes from `world.layout`, so the built-in `learned/` repo and the V1
// dotfiles layout (`claude/skills`, `claude/hooks/nudges`, `claude/agents`,
// `global.CLAUDE.md`) are the same code with different config.

import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type ArtifactType,
  fsx,
  isSlug,
  paths,
  RULE_END,
  RULE_START,
  ruleTag,
  targetRoot,
  ValidationError,
  type World,
} from "@sil/core";

export { RULE_END, RULE_START, ruleTag };

export const TYPES = ["skill", "hook", "rule", "agent"] as const;

// The only keys a nudge document may carry. Anything else the drafter invented
// would be persisted forever and read by nobody.
export const HOOK_KEYS = ["pattern", "event", "matcher", "gate", "once_per", "text"] as const;

// The opening of a per-pattern rule tag, used to spot one inside a bullet.
export const RULE_TAG_OPEN = ruleTag("").replace("-->", "");

const strip = (p: string): string => p.replace(/^\/+/, "").replace(/\/+$/, "");

/** Target-repo-relative path for this artifact, or "" when the type has no file.
 *
 * The slug is validated here, at the one choke point, for every type and not
 * only the ones that currently build a path. A pattern comes out of
 * model-authored reflection text and then becomes both a path component and a
 * git branch name; a future artifact type must not reopen traversal by skipping
 * a check that lived in a caller. */
export function artifactRel(world: World, artifactType: ArtifactType | string, pattern: string): string {
  if (!isSlug(pattern)) throw new ValidationError(`unsafe pattern slug ${JSON.stringify(pattern)}`);
  const layout = world.layout;
  switch (artifactType) {
    case "skill":
      return `${strip(layout.skills_dir)}/${pattern}/SKILL.md`;
    case "hook":
      return `${strip(layout.nudges_dir)}/${pattern}.json`;
    case "agent":
      return `${strip(layout.agents_dir)}/${pattern}.md`;
    case "rule":
      return strip(layout.rules_file);
    case "none":
      return "";
    default:
      throw new ValidationError(`unknown artifact type ${JSON.stringify(artifactType)}`);
  }
}

/** Every path a routed artifact of this world can land under, plus the ledger.
 *
 * Used as the pathspec of the repo-integrity gate, so a dirty file anywhere
 * else in the target does not block a promotion. */
export function artifactPrefixes(world: World): string[] {
  const layout = world.layout;
  return [...new Set([
    strip(layout.skills_dir),
    strip(layout.nudges_dir),
    strip(layout.agents_dir),
    strip(layout.rules_file),
    strip(layout.ledger),
  ])].sort();
}

/** The only files a curriculum branch for `pattern` may change.
 *
 * Every type, not just the current one: a re-home touches the path it leaves as
 * well as the one it arrives at, and refusing that would make a migrated pattern
 * permanently unacceptable. */
export function allowedPaths(world: World, pattern: string): Set<string> {
  const out = new Set<string>([strip(world.layout.ledger)]);
  for (const t of TYPES) {
    const rel = artifactRel(world, t, pattern);
    if (rel) out.add(rel);
  }
  return out;
}

function rootFor(world: World, root?: string | null): string {
  return root != null ? root : targetRoot(world);
}

/** This pattern's artifact text. For "rule", only its own bullet and without the
 * `<!--rule:...-->` tag, never the whole shared file.
 *
 * The one caller hands this to the drafter as the body to refine, and a tag in
 * that body comes straight back in the redraft. */
export function readArtifact(
  world: World,
  artifactType: ArtifactType | string,
  pattern: string,
  root?: string | null,
): string {
  const rel = artifactRel(world, artifactType, pattern);
  if (!rel) return "";
  const path = join(rootFor(world, root), rel);
  if (!existsSync(path)) return "";
  const text = fsx.readText(path);
  return artifactType === "rule" ? stripRuleTag(ruleBulletInText(text, pattern), pattern) : text;
}

/** Write one artifact. Returns the path written, or null for type "none".
 *
 * `root` overrides the world's target repo so a caller can write into a scratch
 * worktree; the layout inside it is identical. */
export function writeArtifact(
  world: World,
  artifactType: ArtifactType | string,
  pattern: string,
  payload: unknown,
  root?: string | null,
): string | null {
  const rel = artifactRel(world, artifactType, pattern);
  if (!rel) return null;
  const path = join(rootFor(world, root), rel);
  if (artifactType === "rule") {
    writeRule(path, pattern, String(payload).trim());
    return path;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (artifactType === "hook") {
    writeFileSync(path, JSON.stringify(hookPayload(payload), null, 2) + "\n", "utf8");
  } else {
    writeFileSync(path, String(payload), "utf8");
  }
  return path;
}

/** A nudge document cut down to the keys the dispatcher reads.
 *
 * The drafter is free to invent keys, and nothing downstream would ever look at
 * them. Dropping them at the write is what keeps an unreviewed field out of a
 * file a human is asked to approve. A non-object payload passes through so the
 * lint's own "must be a JSON object" stays the message the operator sees. */
function hookPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const src = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of HOOK_KEYS) {
    if (key in src) out[key] = src[key];
  }
  return out;
}

/** Undo `writeArtifact`: delete the file, or for "rule" drop just this pattern's
 * tagged bullet from the shared managed block.
 *
 * Never unlinks the rule file itself. Every pattern's rule lives in it, and for
 * a V1-layout world that file is the operator's live boot contract.
 *
 * Returns the repo-relative path touched, or "" when there was nothing to remove. */
export function removeArtifact(
  world: World,
  artifactType: ArtifactType | string,
  pattern: string,
  root?: string | null,
): string {
  const rel = artifactRel(world, artifactType, pattern);
  if (!rel) return "";
  const path = join(rootFor(world, root), rel);
  if (artifactType === "rule") return removeRuleBullet(path, pattern) ? rel : "";
  if (!existsSync(path)) return "";
  unlinkSync(path);
  const parent = dirname(path);
  if (artifactType === "skill") {
    try {
      if (statSync(parent).isDirectory() && readdirSync(parent).length === 0) rmdirSync(parent);
    } catch {
      // the directory is gone or not ours to reap
    }
  }
  return rel;
}

// --- rules: one managed block, one tagged bullet per pattern -----------------

// A per-pattern rule tag as it appears inside a line of diff output.
const RULE_TAG_RE = /<!--rule:([A-Za-z0-9][A-Za-z0-9-]*)-->/g;

/** Other patterns' rule tags a rules-file diff adds or removes.
 *
 * `rule` is the only type where every pattern shares one file, so somebody
 * else's bullet rides along invisibly: the branch's ledger names only this
 * pattern, and the change is merged with nobody having read it.
 *
 * Takes the diff text rather than running git, so the staging path (working tree
 * against the default branch) and the review path (base commit against branch
 * commit) judge it with one function instead of two near-copies. */
export function foreignRuleTags(diffText: string, pattern: string): string[] {
  const tags = new Set<string>();
  for (const line of diffText.split("\n")) {
    if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
      for (const m of line.matchAll(RULE_TAG_RE)) tags.add(m[1]!);
    }
  }
  tags.delete(pattern);
  return [...tags].sort();
}

/** Whether a rules-file diff changes nothing but `pattern`'s own tagged bullet.
 *
 * Migrating a pattern off `rule` legitimately touches the shared file from a
 * branch routed to another type: it drops the old bullet. That is the only edit
 * such a branch may make there, and an untagged line is not it. */
export function rulesDiffOwnedBy(diffText: string, pattern: string): boolean {
  const tag = ruleTag(pattern);
  for (const line of diffText.split("\n")) {
    if (!(line.startsWith("+") || line.startsWith("-")) || line.startsWith("+++") || line.startsWith("---")) continue;
    const body = line.slice(1).trim();
    if (body !== "" && !body.endsWith(tag)) return false;
  }
  return true;
}

/** A rule bullet without the machine-owned `<!--rule:pattern-->` tag.
 *
 * The tag is metadata the writer appends, never part of a body. Handing a
 * tagged bullet to the drafter as "the existing artifact to refine" taught it to
 * copy the tag, and the lint then refused the redraft on every single run: the
 * pattern was stuck with no way out but a hand edit.
 *
 * Only a trailing tag for this pattern goes. A tag mid-line, or another
 * pattern's tag, is still the wedge the lint exists to catch. The loop strips
 * repeats because a doubled tag already reached a live rules file. */
export function stripRuleTag(bullet: string, pattern: string): string {
  const tag = ruleTag(pattern);
  let out = (bullet ?? "").replace(/\s+$/, "");
  while (out.endsWith(tag)) out = out.slice(0, -tag.length).replace(/\s+$/, "");
  return out;
}

/** This pattern's tagged bullet inside `text`, or "" when it has none. */
export function ruleBulletInText(text: string, pattern: string): string {
  const tag = ruleTag(pattern);
  for (const line of text.split("\n")) {
    if (line.replace(/\s+$/, "").endsWith(tag)) return line;
  }
  return "";
}

/** Why a rule write into this world would refuse, checked read-only.
 *
 * Mirrors `writeRule`'s three guards exactly. Running the writer itself to find
 * out would mutate the operator's file before the scratch worktree exists. */
export function rulesProblem(world: World, root?: string | null): string | null {
  const path = join(rootFor(world, root), strip(world.layout.rules_file));
  let text: string;
  try {
    text = existsSync(path) ? fsx.readText(path) : "";
  } catch (e) {
    return `${path} is unreadable: ${(e as Error).message}`;
  }
  return markerProblem(path, text);
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function markerProblem(path: string, text: string): string | null {
  const starts = count(text, RULE_START);
  const ends = count(text, RULE_END);
  if (starts === 0 || ends === 0) {
    return `${path} has no ${RULE_START} / ${RULE_END} marker pair; refusing to append blind to a hand-maintained file`;
  }
  if (starts > 1 || ends > 1) {
    // A docs example of the marker syntax produces a second pair. Taking the
    // first as live would be a guess about a file a human maintains.
    return `${path} has ${starts} start and ${ends} end marker(s); ambiguous which pair is live, refusing to guess`;
  }
  if (text.indexOf(RULE_START) > text.indexOf(RULE_END)) {
    return `${path} has ${RULE_END} before ${RULE_START}; malformed marker order, refusing to guess the managed region`;
  }
  return null;
}

/** Whether the loop may create this world's rules file.
 *
 * True only for the built-in `learned/` repo. A world pointing at a repo the
 * operator maintains opts in by placing the markers itself; writing them there
 * would be this code deciding that someone else's CLAUDE.md is ours to append to. */
export function ownsRulesFile(world: World): boolean {
  return resolve(targetRoot(world)) === resolve(paths.defaultTarget(world.name));
}

/** Create the rules file with an empty marker pair, for the built-in target only.
 *
 * `root` points the write at a scratch worktree. Ownership is still decided by
 * the world's real target, never by the directory being written into. */
export function ensureRulesFile(world: World, root?: string | null): string | null {
  if (!ownsRulesFile(world)) return null;
  const path = join(rootFor(world, root), strip(world.layout.rules_file));
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `# Learned rules\n\nPromoted by the loop. Edit outside the markers only.\n\n${RULE_START}\n${RULE_END}\n`,
    "utf8",
  );
  return path;
}

/** Replace this pattern's tagged bullet inside the managed block, or add it.
 *
 * By tag, never by position: without the tag, refining a rule appends a second
 * near-identical bullet on every run. Text outside the markers is never touched. */
function writeRule(path: string, pattern: string, bullet: string): void {
  // Before anything is read or written. A bullet carrying the block's own
  // syntax adds a second marker pair or a second tag, and from then on every
  // write is ambiguous and retire throws on a file it can no longer parse.
  for (const marker of [RULE_START, RULE_END, RULE_TAG_OPEN]) {
    if (bullet.includes(marker)) {
      throw new ValidationError(
        `refusing to write a rule bullet containing ${JSON.stringify(marker)}: it would wedge ${path} for every later write and for retire`,
      );
    }
  }
  const text = existsSync(path) ? fsx.readText(path) : "";
  const problem = markerProblem(path, text);
  if (problem) throw new ValidationError(problem);
  const [head, block, tail] = splitManagedBlock(text);
  const tag = ruleTag(pattern);
  const kept = block.split("\n").filter((line) => line.trim() && !line.replace(/\s+$/, "").endsWith(tag));
  kept.push(`${bullet} ${tag}`);
  writeFileSync(path, `${head}${RULE_START}\n${kept.join("\n")}\n${RULE_END}${tail}`, "utf8");
}

function removeRuleBullet(path: string, pattern: string): boolean {
  if (!existsSync(path)) return false;
  const text = fsx.readText(path);
  const tag = ruleTag(pattern);
  if (!text.includes(tag)) return false;
  const problem = markerProblem(path, text);
  if (problem) throw new ValidationError(problem);
  const [head, block, tail] = splitManagedBlock(text);
  const kept = block.split("\n").filter((line) => line.trim() && !line.replace(/\s+$/, "").endsWith(tag));
  const body = kept.length > 0 ? `\n${kept.join("\n")}\n` : "\n";
  writeFileSync(path, `${head}${RULE_START}${body}${RULE_END}${tail}`, "utf8");
  return true;
}

/** [before the start marker, between the markers, after the end marker]. */
function splitManagedBlock(text: string): [string, string, string] {
  const startAt = text.indexOf(RULE_START);
  const head = startAt === -1 ? text : text.slice(0, startAt);
  const rest = startAt === -1 ? "" : text.slice(startAt + RULE_START.length);
  const endAt = rest.indexOf(RULE_END);
  const block = endAt === -1 ? rest : rest.slice(0, endAt);
  const tail = endAt === -1 ? "" : rest.slice(endAt + RULE_END.length);
  return [head, block, tail];
}

// --- rehome placeholders -----------------------------------------------------

const PLACEHOLDER_NOTE = /re-homed from '[a-z]+', awaiting a real draft/;

/** A schema-valid stub for a freshly re-homed artifact.
 *
 * Rehome runs no drafter: the human's override is an input to the next draft,
 * not a body. The stub exists so the ledger has something to point at, and
 * `isPlaceholderBody` is what stops it being accepted as a real one. */
export function placeholderBody(
  pattern: string,
  artifactType: ArtifactType | string,
  oldType: string,
): string | Record<string, unknown> {
  const note = `re-homed from '${oldType}', awaiting a real draft`;
  if (artifactType === "none") return "";
  if (artifactType === "hook") {
    return {
      pattern,
      event: "PreToolUse",
      gate: { always: true },
      once_per: "session",
      text: `TODO: ${note}`.slice(0, 400),
    };
  }
  if (artifactType === "rule") return `- TODO: ${note} (${pattern})`;
  return `---\nname: ${pattern}\ndescription: Use when TODO -- ${note}\n---\n\n## TODO\n\n${note}.\n`;
}

/** True when `body` is `placeholderBody`'s stub, not a real draft.
 *
 * Structural, never a bare "TODO" substring: a real artifact is free to discuss
 * TODOs, and a naive check would flag it as unfinished forever. */
export function isPlaceholderBody(artifactType: ArtifactType | string, body: string): boolean {
  if (!body) return false;
  if (artifactType === "hook") {
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return false;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
    const p = payload as Record<string, unknown>;
    const gate = p["gate"];
    const gateIsAlwaysTrue =
      gate !== null &&
      typeof gate === "object" &&
      !Array.isArray(gate) &&
      Object.keys(gate as object).length === 1 &&
      (gate as Record<string, unknown>)["always"] === true;
    return (
      p["event"] === "PreToolUse" &&
      gateIsAlwaysTrue &&
      p["once_per"] === "session" &&
      PLACEHOLDER_NOTE.test(String(p["text"] ?? ""))
    );
  }
  if (artifactType === "skill" || artifactType === "agent") {
    return body.includes("description: Use when TODO -- ") && body.includes("\n## TODO\n") && PLACEHOLDER_NOTE.test(body);
  }
  if (artifactType === "rule") {
    return body.replace(/^\s+/, "").startsWith("- TODO: ") && PLACEHOLDER_NOTE.test(body);
  }
  return false;
}
