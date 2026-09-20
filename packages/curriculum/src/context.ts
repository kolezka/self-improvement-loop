// What a world already learned, in a form the drafting prompt can carry.
//
// Two pieces, for two different failures:
//
// * A mature pattern carries dozens of reflections and one artifact body of a
//   few hundred characters. Handed the raw pile on every run, the drafter
//   rewrote the line from whichever recent sessions read loudest, so it churned
//   without covering more evidence. `evidence-level-overclaim` reached 66
//   reflections and a rule that changed wording every few runs. The rolling
//   summary is recomputed only when new reflections arrive and reused
//   otherwise, so the drafting input barely moves between runs.
// * A drafter that only ever sees one cluster cannot know the world already
//   promoted a near-identical artifact under a different pattern. The knowledge
//   map lists every promoted artifact and every other pattern's weight, so the
//   drafter can narrow or decline instead of restating a neighbour.
//
// The summary is an input to a prompt, never a gate: lint and the judge keep
// reading the full source text. A provider failure here falls back to the
// cached summary, or to the raw lessons, and never blocks a promotion.

import { join } from "node:path";
import { fsx, isSlug, type Ledger, paths, type Reflection, ValidationError, type World } from "@sil/core";
import type { ChatFn } from "@sil/providers";
import * as artifacts from "./artifacts.ts";
import { loadLedger } from "./plan.ts";
import { parseSummary, summaryMessages } from "./prompts.ts";

/** Under this many lessons a cluster is small enough to draft from in full. */
export const SUMMARY_MIN_LESSONS = 8;
export const MAX_SUMMARY_CHARS = 2000;
export const MAX_KNOWLEDGE_ROWS = 40;
const MAX_GIST_CHARS = 180;
const SUMMARY_VERSION = 1;

export interface ClusterSummary {
  version: number;
  pattern: string;
  summary: string;
  /** Reflection ids the summary was built from. The cache key. */
  covered: string[];
  updated: string;
}

/** One row of the world's knowledge map: a pattern, its weight, its artifact. */
export interface KnowledgeRow {
  pattern: string;
  /** Artifact type serving it, or "none" when nothing is promoted yet. */
  type: string;
  gist: string;
  count: number;
}

export function digestPath(world: string, pattern: string): string {
  if (!isSlug(pattern)) throw new ValidationError(`unsafe pattern slug ${JSON.stringify(pattern)}`);
  return join(paths.worldDir(world), "digests", `${pattern}.json`);
}

/** The cached summary, or null when there is none and when one is unreadable.
 *
 * A corrupt cache is a missing cache: the next run pays one model call and
 * overwrites it. Throwing here would take down a run over a file nothing
 * depends on. */
export function loadSummary(world: string, pattern: string): ClusterSummary | null {
  const raw = fsx.readJsonOr<unknown>(digestPath(world, pattern), null);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== SUMMARY_VERSION) return null;
  const summary = typeof obj["summary"] === "string" ? obj["summary"] : "";
  if (!summary.trim()) return null;
  const covered = Array.isArray(obj["covered"]) ? obj["covered"].map(String) : [];
  return {
    version: SUMMARY_VERSION,
    pattern,
    summary,
    covered,
    updated: typeof obj["updated"] === "string" ? obj["updated"] : "",
  };
}

export function saveSummary(world: string, value: ClusterSummary): void {
  fsx.writeJson(digestPath(world, value.pattern), value);
}

/** A rolling summary of every lesson in this cluster, or null.
 *
 * null means "draft from the raw lessons": the cluster is small, or the model
 * call failed and nothing was cached. Exactly one model call, and only when
 * reflections arrived that the cached summary does not cover. */
export async function clusterSummary(
  world: World,
  pattern: string,
  items: Reflection[],
  chat: ChatFn,
): Promise<string | null> {
  if (items.length < SUMMARY_MIN_LESSONS) return null;

  const cached = loadSummary(world.name, pattern);
  const covered = new Set(cached ? cached.covered : []);
  const fresh = items.filter((r) => !covered.has(r.id));
  if (cached && fresh.length === 0) return cached.summary;

  const lessons = fresh.map((r) => (r.lesson || r.body || "").trim()).filter(Boolean);
  if (lessons.length === 0) return cached ? cached.summary : null;

  let raw: string;
  try {
    raw = await chat("drafter", summaryMessages(pattern, lessons, cached ? cached.summary : null, covered.size), {
      world,
      jsonMode: true,
    });
  } catch {
    // The drafting call right after this one reports a provider failure loudly.
    // Losing the summary only costs prompt quality, so keep what we have.
    return cached ? cached.summary : null;
  }

  const text = parseSummary(raw).slice(0, MAX_SUMMARY_CHARS).trim();
  if (!text) return cached ? cached.summary : null;

  saveSummary(world.name, {
    version: SUMMARY_VERSION,
    pattern,
    summary: text,
    covered: items.map((r) => r.id),
    updated: fsx.nowIso(),
  });
  return text;
}

/** Every pattern this world has evidence or an artifact for, heaviest first.
 *
 * Read once per run and rendered per pattern, because the map is a property of
 * the world and not of the cluster being drafted. */
export function worldKnowledge(world: World, items: Reflection[], ledger?: Ledger): KnowledgeRow[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.pattern, (counts.get(item.pattern) ?? 0) + 1);

  const entries = (ledger ?? loadLedger(world)).entries;
  const patterns = new Set<string>([...counts.keys(), ...Object.keys(entries)]);

  const rows: KnowledgeRow[] = [];
  for (const pattern of patterns) {
    const entry = entries[pattern];
    const live = entry && (entry.status === "promoted" || entry.status === "staged");
    const type = live ? (entry.served_by ? entry.served_by.type : entry.artifact_type) : "none";
    rows.push({
      pattern,
      type,
      gist: type === "none" ? "" : artifactGist(world, type, pattern),
      count: counts.get(pattern) ?? 0,
    });
  }
  rows.sort((a, b) => (a.count === b.count ? (a.pattern < b.pattern ? -1 : 1) : b.count - a.count));
  return rows;
}

/** The knowledge map as prompt text, without the pattern being drafted. */
export function renderKnowledge(rows: KnowledgeRow[], current: string, max = MAX_KNOWLEDGE_ROWS): string | null {
  const others = rows.filter((r) => r.pattern !== current);
  if (others.length === 0) return null;
  const kept = others.slice(0, max);
  const lines = kept.map((r) => {
    const head = r.type === "none" ? `${r.count} reflection(s), no artifact yet` : `${r.type}, ${r.count} reflection(s)`;
    return r.gist ? `- ${r.pattern} (${head}): ${r.gist}` : `- ${r.pattern} (${head})`;
  });
  if (others.length > kept.length) lines.push(`- [${others.length - kept.length} lighter pattern(s) omitted]`);
  return lines.join("\n");
}

/** One line describing what an artifact currently tells the agent to do.
 *
 * Best effort: an unreadable or oddly shaped artifact contributes no line
 * rather than failing the run it was only meant to inform. */
export function artifactGist(world: World, artifactType: string, pattern: string): string {
  let text: string;
  try {
    text = artifacts.readArtifact(world, artifactType, pattern);
  } catch {
    return "";
  }
  if (!text.trim()) return "";

  let gist = "";
  if (artifactType === "rule") {
    gist = artifacts.untaggedRuleBullet(text, pattern).replace(/^-\s*/, "");
  } else if (artifactType === "hook") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        gist = String((parsed as Record<string, unknown>)["text"] ?? "");
      }
    } catch {
      gist = "";
    }
  } else {
    for (const line of text.split("\n")) {
      if (line.toLowerCase().startsWith("description:")) {
        gist = line.slice(line.indexOf(":") + 1).trim();
        break;
      }
    }
  }
  if (!gist) gist = text.split("\n").find((l) => l.trim()) ?? "";
  gist = gist.replace(/\s+/g, " ").trim();
  return gist.length > MAX_GIST_CHARS ? `${gist.slice(0, MAX_GIST_CHARS - 3)}...` : gist;
}
