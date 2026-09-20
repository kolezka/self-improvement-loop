// Deterministic lint for a self-authored artifact. Pure, no git, no network.
//
// An empty array means clean. This is the cheap gate before the model judge; it
// never passes an artifact that is malformed, mis-slugged, trivially short,
// secret bearing, an echo of the drafting prompt, or ungrounded in its own
// sources.
//
// Ported from V1's skilllint + artifactlint, merged because the split only ever
// existed to keep two sets of callers apart.

import { DEFAULT_MAX_RULE_CHARS, RULE_END, RULE_START, ruleTag, SECTIONS } from "@sil/core";
import { nudges } from "./deps.ts";

export const MAX_DESCRIPTION = 500;
export const MAX_SENTENCES = 2;
/** Default for `promotion.max_rule_chars`: one bullet, its tag included. */
export const MAX_RULE_CHARS = DEFAULT_MAX_RULE_CHARS;
export const MIN_BODY_CHARS = 80;
export const MIN_SHARED_TERMS = 4;

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
const TRIGGER_RE = /(use when|trigger)/i;

// Coarse secret sniff. High-signal tokens only.
export const SECRET_RE =
  /(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9/+_-]{16,})/i;

// An unreplaced placeholder from the drafting template. A staged skill once
// shipped `description: Use when <the situation that should trigger this skill>`
// and both the lint and the judge accepted it, producing a skill that can never
// fire. Multi-word angle brackets only, so `git log -- <file>` and `Vec<String>`
// survive.
const PLACEHOLDER_RE = /<[A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*)+>/g;

// Prompt echo. A staged skill once carried the drafting prompt's worked example
// as its body, with valid frontmatter and a matching name. Keep in lockstep with
// prompts.ts.
const SCAFFOLD_MARKERS = [
  "source reflections:",
  "now write the real one",
  "both '---' delimiter lines",
  "must begin with 'use when'",
  "existing skill to refine:",
  "existing artifact to refine:",
  "lessons to generalise:",
  "decide what kind of claude code artifact",
  "copy the structure, never the wording",
  "write the first one that applies",
] as const;

const SENTENCE_END = /[.!?](?:\s|$)/g;
// `e.g.` and `i.e.` end in a period plus a space, which looks exactly like a
// sentence end. Blank them before counting: a false "3 sentences" does not
// shorten a draft, it drops the pattern out of the loop.
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|cf|al)\./gi;

const WORD_RE = /[a-z][a-z0-9_-]{4,}/g;
// Words carrying no topic signal, so sharing them proves nothing about grounding.
const GENERIC = new Set(
  `about above after again against always because before being below between both
check checks claim could doing during evidence every first further given having
however itself might other properly should since their there these things think
those through under until using verify whether which while would your result
results ensure ensures never making makes made`
    .split(/\s+/)
    .filter(Boolean),
);

// The opening of a per-pattern rule tag. A bullet carrying one would be written
// into the managed block with two tags, and the second is what removal misses.
const RULE_TAG_OPEN = ruleTag("").replace("-->", "");

let headingWords: Set<string> | null = null;

/** Words from the reflection template's own section headings.
 *
 * Every reflection carries them, so a body that echoes "worked", "failed",
 * "reusable lesson", "verification" shares them with its sources while saying
 * nothing about them. Counted as grounding, five of those headings alone clear
 * the bar and vacuous filler passes.
 *
 * Read from `core.SECTIONS` rather than copied, so editing the template moves
 * both. */
function templateWords(): Set<string> {
  if (headingWords === null) {
    headingWords = new Set<string>();
    for (const heading of SECTIONS) {
      for (const word of heading.toLowerCase().match(WORD_RE) ?? []) headingWords.add(word);
    }
  }
  return headingWords;
}

/** One string to sniff for secrets, whatever shape the artifact is. */
function payloadText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, sortedReplacer(payload)) ?? String(payload);
  } catch {
    return String(payload);
  }
}

function sortedReplacer(_root: unknown) {
  return (_key: string, value: unknown): unknown => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(value as object).sort()) out[k] = (value as Record<string, unknown>)[k];
      return out;
    }
    return value;
  };
}

function field(name: string, frontMatter: string): string | null {
  for (const line of frontMatter.split("\n")) {
    if (line.toLowerCase().startsWith(name + ":")) return line.slice(line.indexOf(":") + 1).trim();
  }
  return null;
}

function countSentences(desc: string): number {
  return (desc.trim().replace(ABBREVIATION, "").match(SENTENCE_END) ?? []).length;
}

/** Bound the one field that decides whether a skill ever triggers.
 *
 * One V1 description grew to a single ~300-word sentence carrying twenty
 * disjunctive triggers, one appended per refine cycle. A description that long
 * is less likely to fire, so the growth the loop called refinement was making
 * the skill worse on the only axis that matters. */
export function lintDescriptionCap(desc: string): string[] {
  const problems: string[] = [];
  if (desc.length > MAX_DESCRIPTION) {
    problems.push(
      `\`description\` is ${desc.length} chars; the cap is ${MAX_DESCRIPTION}. A trigger is one situation, not a disjunction of twenty.`,
    );
  }
  const n = countSentences(desc);
  if (n > MAX_SENTENCES) problems.push(`\`description\` has ${n} sentences; the cap is ${MAX_SENTENCES}`);
  return problems;
}

/** Topic-carrying words in `text`, deduplicated.
 *
 * Words shorter than five characters, the GENERIC list and the reflection
 * template's own heading words are dropped: every reflection contains them, so
 * they measure nothing. The router reuses this to tell a real quote from one
 * assembled out of template scaffolding. */
export function distinctiveTerms(text: string): Set<string> {
  const excluded = new Set([...GENERIC, ...templateWords()]);
  const out = new Set<string>();
  for (const w of (text ?? "").toLowerCase().match(WORD_RE) ?? []) if (!excluded.has(w)) out.add(w);
  return out;
}

/** Flag a body that does not reuse its sources' distinctive vocabulary.
 *
 * Vacuous filler ("be careful, verify things properly") is the one failure the
 * model judge does not catch: measured, it credited the sources' specificity to
 * the artifact. A real artifact names the metrics, commands and fields its
 * sources name, so shared distinctive terms separate the two mechanically. */
export function lintGrounding(body: string, sourcesText: string, minShared = MIN_SHARED_TERMS): string[] {
  const bodyTerms = distinctiveTerms(body);
  const shared = [...distinctiveTerms(sourcesText)].filter((w) => bodyTerms.has(w)).sort();
  if (shared.length < minShared) {
    return [
      `body not grounded in its sources: only ${shared.length} distinctive term(s) shared (${JSON.stringify(shared)}); reads as generic filler`,
    ];
  }
  return [];
}

/** Structural lint for a SKILL.md or an agent definition (same file shape). */
export function lintSkill(text: string, pattern: string, minBodyChars = MIN_BODY_CHARS): string[] {
  const problems: string[] = [];
  const match = FRONTMATTER.exec(text ?? "");
  if (!match) return ["missing or malformed frontmatter (--- ... --- at top of file)"];
  const frontMatter = match[1]!;
  const body = match[2]!;

  const name = field("name", frontMatter);
  if (!name) problems.push("frontmatter missing non-empty `name`");
  else if (name !== pattern) {
    problems.push(`frontmatter \`name\` (${JSON.stringify(name)}) must equal the pattern (${JSON.stringify(pattern)})`);
  }

  const desc = field("description", frontMatter);
  if (!desc) problems.push("frontmatter missing non-empty `description`");
  else if (!TRIGGER_RE.test(desc)) {
    problems.push("`description` must read as a trigger (contain 'Use when' or 'Trigger')");
  } else {
    problems.push(...lintDescriptionCap(desc));
  }

  if (body.trim().length < minBodyChars) problems.push(`body too short (< ${minBodyChars} non-whitespace chars)`);

  for (const placeholder of [...new Set(text.match(PLACEHOLDER_RE) ?? [])]) {
    problems.push(`unreplaced template placeholder: ${placeholder}`);
  }

  const low = text.toLowerCase();
  for (const marker of SCAFFOLD_MARKERS) {
    if (low.includes(marker)) problems.push(`drafting-prompt scaffolding echoed into the artifact: ${JSON.stringify(marker)}`);
  }

  return problems;
}

/** Characters the bare bullet may use so that bullet, space and tag fit `maxChars`.
 *
 * The drafter is told this number and the lint checks the sum, so the two
 * cannot drift: a prompt naming one cap against a lint measuring another was a
 * compliant draft refused on every run. */
export function ruleBudget(pattern: string, maxChars = MAX_RULE_CHARS): number {
  return maxChars - 1 - ruleTag(pattern).length;
}

/** A rule is exactly one bullet with a bounded length and no block markers.
 *
 * `pattern` is what the writer will tag the bullet with. Without it the cap is
 * measured against a shorter line than the one that reaches disk. */
export function lintRule(text: string, pattern: string | null = null, maxChars = MAX_RULE_CHARS): string[] {
  const lines = (text ?? "").trim().split("\n").filter((line) => line.trim());
  if (lines.length !== 1) return [`a rule is exactly one bullet; got ${lines.length} line(s)`];
  const line = lines[0]!.trim();
  const problems: string[] = [];
  if (!line.startsWith("- ")) problems.push("a rule must start with '- '");

  // A bullet carrying the block's own syntax wedges the rules file for good:
  // a second marker pair makes every later write and every retire ambiguous,
  // and a second tag survives the removal that matches only the last one.
  for (const marker of [RULE_START, RULE_END, RULE_TAG_OPEN]) {
    if (line.includes(marker)) {
      problems.push(
        `rule contains the managed-block marker ${JSON.stringify(marker)}; writing it would make the rules file unreadable and unretireable`,
      );
    }
  }

  // The writer appends " <!--rule:pattern-->", so the cap covers it.
  const tag = pattern ? ruleTag(pattern) : "";
  const total = line.length + (tag ? 1 + tag.length : 0);
  if (total > maxChars) {
    const detail = tag ? ` once its ${tag} tag is appended` : "";
    problems.push(`rule is ${total} chars${detail}; the cap is ${maxChars}`);
  }
  return problems;
}

/** Delegate to the nudge dispatcher's own file-format lint.
 *
 * Resolved through the adapter so this module stays usable before the hook half
 * of the plugin is present, and so a test can inject a fake dispatcher. */
export function lintHook(payload: unknown): string[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return ["hook artifact must be a JSON object"];
  }
  const fn = nudges().lintNudge;
  if (!fn) return ["nudge dispatcher unavailable, cannot lint a hook"];
  try {
    return [...fn(payload)];
  } catch (e) {
    return [`nudge dispatcher unavailable, cannot lint a hook: ${(e as Error).message}`];
  }
}

export interface LintOptions {
  /** `promotion.max_rule_chars`; MAX_RULE_CHARS when absent. */
  maxRuleChars?: number;
}

const typeName = (v: unknown): string => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v === "object" ? "dict" : typeof v);

/** Empty array means clean. `payload` is an object for hooks, text for the rest.
 *
 * Grounding and the secret sniff apply to every type: vacuous filler and a
 * leaked token are both type-independent.
 *
 * A payload shaped for one type can reach another type's path for real, not just
 * in a fixture: a served_by suppression forces the ledger's type onto whatever
 * the drafter returned. So each branch checks the shape it needs before touching
 * it. */
export function lint(
  artifactType: string,
  payload: unknown,
  pattern: string,
  sourcesText: string,
  opts: LintOptions = {},
): string[] {
  if (artifactType === "none") return [];

  let problems: string[];
  let body: string;

  if (artifactType === "hook") {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return ["hook artifact must be a JSON object"];
    }
    const obj = payload as Record<string, unknown>;
    problems = lintHook(obj);
    // The dispatcher keys its once-per-session marker and its fire log on the
    // payload's own `pattern`. Unbound, a hook logs its fires under another
    // artifact's name and burns that artifact's marker for the session.
    if (obj["pattern"] !== pattern) {
      problems.push(
        `hook \`pattern\` (${JSON.stringify(obj["pattern"] ?? null)}) must equal the artifact's pattern (${JSON.stringify(pattern)})`,
      );
    }
    body = String(obj["text"] ?? "");
  } else if (artifactType === "rule") {
    if (typeof payload !== "string") return [`rule artifact must be text, not ${typeName(payload)}`];
    problems = lintRule(payload, pattern, opts.maxRuleChars);
    body = payload;
  } else if (artifactType === "skill" || artifactType === "agent") {
    if (typeof payload !== "string") return [`${artifactType} artifact must be text, not ${typeName(payload)}`];
    problems = lintSkill(payload, pattern);
    body = payload;
  } else {
    return [`unknown artifact type ${JSON.stringify(artifactType)}`];
  }

  // Every type, against the whole serialised artifact. Run only on the skill
  // path, this missed a token in a rule bullet and in any hook field.
  if (SECRET_RE.test(payloadText(payload))) {
    problems.push("possible secret or token detected; refusing to promote");
  }

  problems.push(...lintGrounding(body, sourcesText));
  return problems;
}
