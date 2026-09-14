// Optional export of new reflections to Outline. Never a read dependency,
// never raises: a failed export is best effort and reported, not fatal.

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fsx, paths, type Config, type World } from "@sil/core";

export interface ExportResult { skipped?: string; exported?: number; errors?: string[] }

export async function exportNew(world: World, _cfg: Config): Promise<ExportResult> {
  if (world.outline === null) return { skipped: "not configured" };

  const apiKey = process.env[world.outline.api_key_env];
  if (!apiKey) return { exported: 0, errors: [`env var ${world.outline.api_key_env} is not set`] };

  const markerPath = join(paths.stateDir(), `outline-exported-${world.name}.txt`);
  const exportedIds = readMarker(markerPath);

  const errors: string[] = [];
  let exported = 0;

  const dir = paths.reflectionsDir(world.name);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return { exported, errors };
  }

  for (const name of names) {
    const rid = basename(name, ".md");
    if (exportedIds.has(rid)) continue;

    let body: string;
    try {
      body = fsx.readText(join(dir, name));
    } catch (e) {
      errors.push(`${rid}: ${(e as Error).message}`);
      continue;
    }

    const payload: Record<string, unknown> = { title: rid, text: body, collectionId: world.outline.collection_id, publish: true };
    if (world.outline.parent_document_id) payload["parentDocumentId"] = world.outline.parent_document_id;

    try {
      await post(world.outline.base_url, apiKey, payload);
    } catch (e) {
      errors.push(`${rid}: ${(e as Error).constructor.name}: ${(e as Error).message}`);
      continue;
    }

    appendMarker(markerPath, rid);
    exportedIds.add(rid);
    exported += 1;
  }

  return { exported, errors };
}

async function post(baseUrl: string, apiKey: string, payload: Record<string, unknown>): Promise<void> {
  const url = baseUrl.replace(/\/+$/, "") + "/api/documents.create";
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`outline ${resp.status} ${await resp.text()}`);
}

function readMarker(path: string): Set<string> {
  const text = fsx.readTextOr(path, "");
  const ids = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return new Set(ids);
}

function appendMarker(path: string, rid: string): void {
  fsx.appendLine(path, rid);
}
