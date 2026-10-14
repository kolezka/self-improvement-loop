// Read-only inspection of one artifact as it stands on the live target repo.
//
// Two operations, both writing nothing:
//
// * `previewArtifact` reads the artifact's current body, exactly as it is
//   live (the default branch of the target repo, never a staged review
//   branch), plus whether it is actually active.
// * `verifyArtifact` runs the offline checks (exists, live, lint, and for a
//   hook, its gate against the real payload corpus) and, unless the row is
//   inline or has no reflections, asks the drafter one re-route question: on
//   today's evidence, would the router pick a different type? It never
//   writes a ledger row, a branch or a proposal event; the human rehomes by
//   hand if they agree with the verdict.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ArtifactType, type Config, fsx, type Ledger, type Reflection, ReviewError, servedType, targetRoot, type World } from "@sil/core";
import type { ChatFn } from "@sil/providers";
import * as providers from "@sil/providers";
import * as artifacts from "./artifacts.ts";
import * as context from "./context.ts";
import type { GateRunner } from "./deps.ts";
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
  /** Human-readable verdict: either "gate fires on N of M recorded
   * payload(s)" or the reason it does not route to hook. */
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
 * through the ordinary artifact reader. */
function readLiveBody(world: World, pattern: string, artifactType: ArtifactType, externalPath: string | null): { path: string; body: string } {
  if (externalPath) {
    return { path: externalPath, body: existsSync(externalPath) ? fsx.readText(externalPath) : "" };
  }
  return { path: artifacts.artifactRel(world, artifactType, pattern), body: artifacts.readArtifact(world, artifactType, pattern) };
}

/** Whether this artifact is actually active, not just present on disk.
 *
 * An inline row with an `external_path` is the human's own file; the loop
 * never wires it up, so liveness there is just "the file exists". Everything
 * else is checked the way the loop itself would make it live: a skill or
 * agent by its symlink into the Claude config dir, a hook by its file being
 * present and passing the nudge lint, a rule by its tagged bullet being
 * inside the managed block. */
export function checkLive(world: World, artifactType: ArtifactType, pattern: string, externalPath: string | null = null): LiveCheck {
  if (externalPath) {
    return existsSync(externalPath)
      ? { live: true, detail: `inline artifact present at ${externalPath}` }
      : { live: false, detail: `inline artifact file ${externalPath} does not exist` };
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
    if (!existsSync(path)) return { live: false, detail: `${rel} does not exist` };
    const text = fsx.readText(path);
    const [, block] = artifacts.splitManagedBlock(text);
    const tag = artifacts.ruleTag(pattern);
    return block.includes(tag)
      ? { live: true, detail: `bullet present inside the managed block of ${rel}` }
      : { live: false, detail: `no bullet tagged ${tag} inside the managed block of ${rel}` };
  }
  return { live: false, detail: `unknown artifact type ${JSON.stringify(artifactType)}` };
}

/** A hook body's own trigger and gate, run through the exact corpus check
 * `route()` uses, so "would this still fire today" is tested, not guessed. */
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
  const answer = RouteAnswer.parse({ trigger_event: trigger, gate: obj["gate"] ?? null });
  const verdict = hookVerdict(answer, payloads, { gateRunner });
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

/** The artifact's current body, as it is live. Throws for a retired or
 * missing artifact rather than returning an empty body. */
export function previewArtifact(world: World, _cfg: Config, pattern: string): PreviewResult {
  const { artifactType, externalPath } = liveEntry(world, pattern, "preview");
  const { path, body } = readLiveBody(world, pattern, artifactType, externalPath);
  if (!body) throw new ReviewError(`${JSON.stringify(pattern)} (${artifactType}) has no readable artifact at ${path}; nothing to preview`);
  const { live } = checkLive(world, artifactType, pattern, externalPath);
  return { pattern, artifact_type: artifactType, path, body, live };
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
    summary: await context.clusterSummary(world, pattern, items, chat),
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
 * proposal event, no scorecard. A missing drafter role (`ModelNotConfigured`)
 * or any other provider failure surfaces in `type_check.error`, with the
 * offline results still present; it is never masked by a default answer. */
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
