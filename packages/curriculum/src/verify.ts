// Read-only inspection of one artifact as it stands on the live target repo.
//
// Two operations, both writing nothing:
//
// * `previewArtifact` reads the artifact's current body, exactly as it is on
//   the target repo's checked-out working tree (never a staged review
//   branch). That tree is normally the default branch, but it can carry
//   local uncommitted edits; `matches_default_branch` says whether it does.
// * `verifyArtifact` runs the offline checks (exists, live, lint, and for a
//   hook, its gate against the real payload corpus) and, unless the row is
//   inline or has no reflections, asks the drafter one re-route question: on
//   today's evidence, would the router pick a different type? It never
//   writes a ledger row, a branch or a proposal event; the human rehomes by
//   hand if they agree with the verdict.

import { existsSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type ArtifactType, type Config, fsx, type Ledger, type Reflection, ReviewError, servedType, targetRoot, type World, worldClaudeConfigDir } from "@sil/core";
import { MAX_RULES_BYTES, rulesInjectable } from "@sil/core/lessons";
import type { ChatFn } from "@sil/providers";
import * as providers from "@sil/providers";
import * as artifacts from "./artifacts.ts";
import * as context from "./context.ts";
import type { GateRunner } from "./deps.ts";
import * as git from "./git.ts";
import { lint, lintHook } from "./lint.ts";
import { draftingTexts, loadLedger, loadPayloadCorpus, reflections, sourcesText } from "./plan.ts";
import * as prompts from "./prompts.ts";
import { draftCaps, UPGRADE_TYPES } from "./run.ts";
import { hookVerdict, route, RouteAnswer } from "./router.ts";

export interface LiveCheck {
  live: boolean;
  detail: string;
}

export interface GateCheck {
  /** Human-readable verdict: "gate fires on N of M recorded payload(s)", the
   * reason it does not route to hook, or "malformed gate" for a gate shape
   * that cannot even be parsed. */
  verdict: string;
  fires: boolean;
  hits: number;
  total: number;
}

export type TypeCheck =
  | { current_type: ArtifactType; router_type: string; reason: string; upgrade: boolean }
  | { skipped: string }
  | { error: string };

export interface VerifyOffline {
  exists: boolean;
  live: LiveCheck;
  lint: string[];
  /** Only for a hook; null for every other type. */
  gate: GateCheck | null;
}

export interface VerifyResult {
  pattern: string;
  artifact_type: ArtifactType;
  offline: VerifyOffline;
  type_check: TypeCheck;
}

export interface PreviewResult {
  pattern: string;
  artifact_type: ArtifactType;
  path: string;
  body: string;
  live: boolean;
  /** Whether this body is byte-identical to what is committed on the target
   * repo's default branch. False means there are local uncommitted changes:
   * this is what the engine is actually serving right now, but it was never
   * accepted through review. Always true for an inline artifact, which lives
   * outside the target repo's own history. */
  matches_default_branch: boolean;
}

export interface VerifyOptions {
  chat?: ChatFn;
  gateRunner?: GateRunner;
}

/** The artifact type a ledger row serves, refusing the states neither preview
 * nor verify can do anything with. Shared so the two report the same error
 * for the same row. */
function liveEntry(world: World, pattern: string, verb: string): { ledger: Ledger; artifactType: ArtifactType; externalPath: string | null } {
  const ledger = loadLedger(world);
  const entry = ledger.entries[pattern];
  if (!entry) throw new ReviewError(`${JSON.stringify(pattern)} is not in the ledger; nothing to ${verb}`);
  if (entry.status === "retired") throw new ReviewError(`${JSON.stringify(pattern)} is retired; nothing to ${verb}`);
  const atype = servedType(entry);
  if (atype === "none") throw new ReviewError(`${JSON.stringify(pattern)} has no artifact type; nothing to ${verb}`);
  const externalPath = entry.origin === "inline" ? (entry.external_path ?? null) : null;
  return { ledger, artifactType: atype as ArtifactType, externalPath };
}

/** The live body and the path it came from. An inline row with an
 * `external_path` reads that file directly; everything else, including an
 * inline hook (copied into the repo's own nudges dir at registration), reads
 * through the ordinary artifact reader.
 *
 * A rule reads only its own bullet from inside the managed block, same as
 * `checkLive` below: a stray or stale tag outside the block (left behind by a
 * hand edit) must never surface as this pattern's live text. */
export function readLiveBody(world: World, pattern: string, artifactType: ArtifactType, externalPath: string | null): { path: string; body: string } {
  if (externalPath) {
    return { path: externalPath, body: existsSync(externalPath) ? fsx.readText(externalPath) : "" };
  }
  const rel = artifacts.artifactRel(world, artifactType, pattern);
  if (artifactType === "rule") {
    return { path: rel, body: artifacts.ruleBulletInManagedBlock(world, pattern) };
  }
  return { path: rel, body: artifacts.readArtifact(world, artifactType, pattern) };
}

/** Whether `link` is a symlink that resolves to `target`. Used for the one
 * case a hand-made symlink (not the loop's own) can make an inline skill or
 * agent genuinely loadable. */
function symlinkResolvesTo(link: string, target: string): boolean {
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
    return resolve(dirname(link), readlinkSync(link)) === resolve(target);
  } catch {
    return false;
  }
}

/** Whether an inline artifact's own file sits where Claude Code would
 * actually load it from.
 *
 * `register()` only checks that the path is an absolute, existing regular
 * file; it never checks that Claude Code reads it from anywhere. A skill or
 * agent registered at an arbitrary path (`/tmp/custom/SKILL.md`) is real on
 * disk and never loaded by anything. Loadable means: the global Claude config
 * location, a project `.claude/<skills|agents>/...` location (recognised by
 * path suffix, since verify has no cwd to resolve "the project" against), or
 * the global location being a hand-made symlink that resolves to this file.
 * A rule is loadable only as a CLAUDE.md memory file. */
function inlineLoadLocation(world: World, artifactType: ArtifactType, pattern: string, externalPath: string): boolean {
  const resolved = resolve(externalPath);
  const claudeDir = worldClaudeConfigDir(world);
  if (artifactType === "skill") {
    if (basename(resolved) !== "SKILL.md") return false;
    const globalDir = join(claudeDir, "skills", pattern);
    if (resolve(globalDir, "SKILL.md") === resolved) return true;
    if (resolved.endsWith(join(".claude", "skills", pattern, "SKILL.md"))) return true;
    return symlinkResolvesTo(globalDir, dirname(resolved));
  }
  if (artifactType === "agent") {
    const globalFile = join(claudeDir, "agents", `${pattern}.md`);
    if (resolved === resolve(globalFile)) return true;
    if (resolved.endsWith(join(".claude", "agents", `${pattern}.md`))) return true;
    return symlinkResolvesTo(globalFile, resolved);
  }
  if (artifactType === "rule") return basename(resolved) === "CLAUDE.md";
  return false;
}

/** Whether this artifact is actually active, not just present on disk.
 *
 * An inline row with an `external_path` is the human's own file; the loop
 * never wires it up, so liveness there is whether that file is somewhere
 * Claude Code actually loads, never just "the file exists" (see
 * `inlineLoadLocation`). Everything else is checked the way the loop itself
 * would make it live: a skill or agent by its symlink into the Claude config
 * directory, a hook by its file being present and passing the nudge lint, a
 * rule by `rules_inject` and the size cap both allowing injection and its
 * tagged bullet being inside the managed block. */
export function checkLive(world: World, artifactType: ArtifactType, pattern: string, externalPath: string | null = null): LiveCheck {
  if (externalPath) {
    if (!existsSync(externalPath)) {
      return { live: false, detail: `inline artifact file ${externalPath} does not exist` };
    }
    return inlineLoadLocation(world, artifactType, pattern, externalPath)
      ? { live: true, detail: `inline artifact present at ${externalPath}` }
      : { live: false, detail: "file exists but is not in a location Claude Code loads" };
  }
  if (artifactType === "skill" || artifactType === "agent") {
    const linked = artifacts.isLinked(world, artifactType, pattern);
    return {
      live: linked,
      detail: linked ? "symlinked into the Claude config directory" : "not symlinked into the Claude config directory",
    };
  }
  if (artifactType === "hook") {
    const rel = artifacts.artifactRel(world, "hook", pattern);
    const path = join(targetRoot(world), rel);
    if (!existsSync(path)) return { live: false, detail: `${rel} does not exist` };
    let payload: unknown;
    try {
      payload = JSON.parse(fsx.readText(path));
    } catch (e) {
      return { live: false, detail: `${rel} is not valid JSON: ${(e as Error).message}` };
    }
    const problems = lintHook(payload);
    return problems.length === 0
      ? { live: true, detail: `${rel} present and passes the nudge lint` }
      : { live: false, detail: `${rel} fails the nudge lint: ${problems.join("; ")}` };
  }
  if (artifactType === "rule") {
    const rel = artifacts.artifactRel(world, "rule", pattern);
    const path = join(targetRoot(world), rel);
    let stat: { isFile: boolean; size: number } | null;
    try {
      const st = statSync(path);
      stat = { isFile: st.isFile(), size: st.size };
    } catch {
      stat = null;
    }
    if (!stat) return { live: false, detail: `${rel} does not exist` };
    const ruleCfg = { rules_inject: world.rules_inject, rules_file: world.layout.rules_file };
    if (!rulesInjectable(ruleCfg, stat)) {
      const reason = world.rules_inject === false
        ? "rules_inject is false for this world"
        : `the file is ${stat.size} bytes, over the ${MAX_RULES_BYTES} byte injection cap`;
      return { live: false, detail: `${rel} exists but the hook would never inject it: ${reason}` };
    }
    const bullet = artifacts.ruleBulletInManagedBlock(world, pattern);
    return bullet
      ? { live: true, detail: `bullet present inside the managed block of ${rel}` }
      : { live: false, detail: `no bullet tagged ${artifacts.ruleTag(pattern)} inside the managed block of ${rel}` };
  }
  return { live: false, detail: `unknown artifact type ${JSON.stringify(artifactType)}` };
}

/** A hook body's own trigger and gate, run through the exact corpus check
 * `route()` uses, so "would this still fire today" is tested, not guessed.
 * `RouteAnswer.safeParse` never throws: a gate shape the schema rejects
 * (a string instead of an object, say) is reported as a failed check, not a
 * crash that would also lose the offline results computed alongside it. */
function checkHookGate(world: World, rawBody: string, gateRunner?: GateRunner): GateCheck {
  const payloads = loadPayloadCorpus(world);
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return { verdict: `hook body is not valid JSON: ${(e as Error).message}`, fires: false, hits: 0, total: payloads.length };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { verdict: "hook artifact must be a JSON object", fires: false, hits: 0, total: payloads.length };
  }
  const obj = payload as Record<string, unknown>;
  const event = typeof obj["event"] === "string" ? obj["event"] : "";
  const matcher = typeof obj["matcher"] === "string" && obj["matcher"] ? obj["matcher"] : "";
  const trigger = event ? `${event}${matcher ? `:${matcher}` : ""}` : "none";
  const parsed = RouteAnswer.safeParse({ trigger_event: trigger, gate: obj["gate"] ?? null });
  if (!parsed.success) {
    return { verdict: "malformed gate", fires: false, hits: 0, total: payloads.length };
  }
  const verdict = hookVerdict(parsed.data, payloads, { gateRunner });
  if (typeof verdict === "string") return { verdict, fires: false, hits: 0, total: payloads.length };
  return {
    verdict: `gate fires on ${verdict.hits} of ${verdict.total} recorded payload(s)`,
    fires: true,
    hits: verdict.hits,
    total: verdict.total,
  };
}

/** The artifact body as the lint expects it: parsed JSON for a hook, the raw
 * text for everything else. A hook body that fails to parse is handed back
 * as the raw string, so `lint()` reports "must be a JSON object" instead of
 * this function masking the real problem. */
function payloadForLint(artifactType: ArtifactType, raw: string): unknown {
  if (artifactType !== "hook") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Whether `liveBody` (already extracted the same way `readLiveBody` would)
 * is byte-identical to what the target repo's default branch commits at
 * `rel`. An inline artifact lives outside the target repo entirely, so there
 * is nothing to compare and this reports true (nothing to warn about). A rule
 * compares bullet to bullet, not the whole shared file, for the same reason
 * `readLiveBody` only ever reads this pattern's own bullet. */
function matchesDefaultBranch(
  world: World,
  pattern: string,
  artifactType: ArtifactType,
  externalPath: string | null,
  rel: string,
  liveBody: string,
): boolean {
  if (externalPath) return true;
  const repo = targetRoot(world);
  if (!git.isRepo(repo)) return true;
  const defaultRef = git.defaultBranch(repo);
  const shown = git.show(repo, defaultRef, rel);
  if (!shown.found) return liveBody === "";
  if (artifactType === "rule") {
    const [, block] = artifacts.splitManagedBlock(shown.text);
    const committedBullet = artifacts.stripRuleTag(artifacts.ruleBulletInText(block, pattern), pattern);
    return committedBullet === liveBody;
  }
  return shown.text === liveBody;
}

/** The artifact's current body, as it is on the target checkout. Throws for
 * a retired or missing artifact rather than returning an empty body. */
export function previewArtifact(world: World, _cfg: Config, pattern: string): PreviewResult {
  const { artifactType, externalPath } = liveEntry(world, pattern, "preview");
  const { path, body } = readLiveBody(world, pattern, artifactType, externalPath);
  if (!body) throw new ReviewError(`${JSON.stringify(pattern)} (${artifactType}) has no readable artifact at ${path}; nothing to preview`);
  const { live } = checkLive(world, artifactType, pattern, externalPath);
  const matchesDefault = matchesDefaultBranch(world, pattern, artifactType, externalPath, path, body);
  return { pattern, artifact_type: artifactType, path, body, live, matches_default_branch: matchesDefault };
}

/** The cluster summary only when it is already cached and already covers
 * every reflection in `items`. Never calls the drafter and never writes
 * `digests/<pattern>.json`: verify is read-only, and the ordinary
 * `context.clusterSummary` does both whenever the cache is missing or stale.
 * Null falls back to the raw lessons, exactly like a cluster below the
 * summary threshold does, so the probe still has grounding text. */
function cachedSummaryOnly(world: World, pattern: string, items: Reflection[]): string | null {
  if (items.length < context.SUMMARY_MIN_LESSONS) return null;
  const cached = context.loadSummary(world.name, pattern);
  if (!cached) return null;
  const covered = new Set(cached.covered);
  return items.every((r) => covered.has(r.id)) ? cached.summary : null;
}

/** One re-route probe, built exactly like `stageOne`'s in run.ts: a forced
 * draft that also asks for the routing fields, then `route()` on the answer.
 * Writes nothing; the caller decides whether to act on the verdict. */
async function probeType(
  world: World,
  pattern: string,
  currentType: ArtifactType,
  items: Reflection[],
  allItems: Reflection[],
  ledger: Ledger,
  sources: string,
  caps: { maxRuleChars: number },
  opts: VerifyOptions,
): Promise<TypeCheck> {
  const chat: ChatFn = opts.chat ?? providers.chat;
  const drafting = draftingTexts(items);
  let existing: string | null = artifacts.readArtifact(world, currentType, pattern) || null;
  if (existing && artifacts.isPlaceholderBody(currentType, existing)) existing = null;
  const knowledgeRows = context.worldKnowledge(world, allItems, ledger);
  const draftOpts: prompts.DraftOptions = {
    ...caps,
    summary: cachedSummaryOnly(world, pattern, items),
    knowledge: context.renderKnowledge(knowledgeRows, pattern),
  };
  const raw = await chat(
    "drafter",
    prompts.draftMessages(pattern, drafting, existing, currentType, { ...draftOpts, wantRouteAnswer: true }),
    { world, jsonMode: true },
  );
  const [, answer] = prompts.parseDraft(raw, { forcedType: currentType, keepRouteAnswer: true });
  const payloads = loadPayloadCorpus(world);
  const probe = route(answer, sources, payloads, { gateRunner: opts.gateRunner });
  const upgrade = UPGRADE_TYPES.has(probe.artifact_type) && probe.artifact_type !== currentType;
  return { current_type: currentType, router_type: probe.artifact_type, reason: probe.reason, upgrade };
}

/** Offline checks plus one re-route probe, for the pattern the artifact
 * already serves. Writes nothing at all: no ledger row, no branch, no
 * proposal event, no scorecard, no cluster-summary digest. A missing drafter
 * role (`ModelNotConfigured`) or any other provider failure surfaces in
 * `type_check.error`, with the offline results still present; it is never
 * masked by a default answer. */
export async function verifyArtifact(world: World, cfg: Config, pattern: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const { ledger, artifactType, externalPath } = liveEntry(world, pattern, "verify");
  const entry = ledger.entries[pattern]!;

  const { body } = readLiveBody(world, pattern, artifactType, externalPath);
  const exists = body !== "";
  const live = checkLive(world, artifactType, pattern, externalPath);

  const allItems = reflections(world);
  const items = allItems.filter((r) => r.pattern === pattern);
  const sources = sourcesText(items);
  const caps = draftCaps(cfg);
  const lintProblems = exists ? lint(artifactType, payloadForLint(artifactType, body), pattern, sources, caps) : ["no artifact body to lint"];

  let gate: GateCheck | null = null;
  if (artifactType === "hook") {
    gate = exists ? checkHookGate(world, body, opts.gateRunner) : { verdict: "no hook body to check", fires: false, hits: 0, total: 0 };
  }

  const offline: VerifyOffline = { exists, live, lint: lintProblems, gate };

  let type_check: TypeCheck;
  if (entry.origin === "inline") {
    type_check = { skipped: "an inline artifact is edited by hand; rehome refuses it, so no type check is run" };
  } else if (items.length === 0) {
    type_check = { skipped: "no reflections recorded for this pattern; nothing to route from" };
  } else {
    try {
      type_check = await probeType(world, pattern, artifactType, items, allItems, ledger, sources, caps, opts);
    } catch (e) {
      type_check = { error: `${(e as Error).name || "Error"}: ${(e as Error).message}` };
    }
  }

  return { pattern, artifact_type: artifactType, offline, type_check };
}
