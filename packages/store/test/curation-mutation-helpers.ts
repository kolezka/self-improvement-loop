// Shared helpers for the curation mutation and purge tests. Thin wrappers over
// the real functions and SQL, no production behavior of their own.

import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Lesson } from "@sil/core";
import { CurationError } from "@sil/core/lesson-curation";
import type { CurationChange, CurationMutation, CurationReceipt, LessonKey, LessonScope } from "@sil/core/lesson-curation";
import { applyCurationMutation, curationLocationId, encodeRecordId, legacySourceDigestV1, openCurationStore } from "../src/index.ts";
import type { CurationDatabase, LegacySourceSnapshot } from "../src/index.ts";
import { runCurationChild, spawnCurationChild } from "../../../tests/curation-fixture.ts";
import type { ChildResult, CurationFixture } from "../../../tests/curation-fixture.ts";

export const PROJECT_A = `p1_${"a".repeat(64)}`;
export const PROJECT_B = `p1_${"b".repeat(64)}`;

export const newRequestId = (): string => `lc_${randomUUID()}`;

export function openStore(): CurationDatabase {
  return openCurationStore({ kind: "location", id: curationLocationId() }, { initialize: true });
}

export function worldScope(world: string): LessonScope {
  return { world, project: { kind: "world" } };
}

export function captureKey(world: string, id: string = randomUUID()): LessonKey {
  return { world, kind: "capture", id };
}

export function inboxKey(world: string, id: string): LessonKey {
  return { world, kind: "inbox", id };
}

export function captureChange(text: string, quote = "a quoted line"): CurationChange {
  return {
    kind: "capture",
    text,
    source: {
      kind: "explicit_quote",
      quote,
      reference: null,
      quoteRedacted: false,
      captureSessionId: null,
      sourceConversationId: null,
      sourceRowId: null,
      sourceAgentId: null,
    },
  };
}

export function mutation(
  db: CurationDatabase,
  key: LessonKey,
  change: CurationChange,
  expectedRevision: number,
  extra: { requestId?: string; scope?: LessonScope } = {},
): CurationMutation {
  return {
    requestId: extra.requestId ?? newRequestId(),
    binding: { kind: "installation", id: db.installationId },
    scope: extra.scope ?? worldScope(key.world),
    key,
    expectedRevision,
    change,
  };
}

export function source(world: string, id: string, text = "legacy lesson text", location: LegacySourceSnapshot["location"] = "active"): LegacySourceSnapshot {
  const lesson = Lesson.parse({ id, world, pattern: "legacy-pattern", text, created: "2026-10-01T00:00:00.000Z" });
  return { lesson, digest: legacySourceDigestV1(lesson), location };
}

/** Run apply and return the thrown CurationError, failing if none was thrown. */
export function rejection(run: () => unknown): CurationError {
  try {
    run();
  } catch (error) {
    if (error instanceof CurationError) return error;
    throw error;
  }
  throw new Error("expected a CurationError");
}

/**
 * applyCurationMutation, with a CurationError rethrown as `<code>: <message>`
 * so `toThrow(/CODE/)` can match it. The production message stays code-free.
 */
export function apply(db: CurationDatabase, input: CurationMutation, snapshot: LegacySourceSnapshot | null = null): CurationReceipt {
  try {
    return applyCurationMutation(db, input, snapshot);
  } catch (error) {
    if (error instanceof CurationError) throw Object.assign(new Error(`${error.code}: ${error.message}`), { cause: error });
    throw error;
  }
}

export function readRevisionNumbers(db: CurationDatabase, key: LessonKey): number[] {
  return (
    db.sqlite
      .query("SELECT revision FROM revisions WHERE world = ? AND kind = ? AND id_json = ? ORDER BY revision")
      .all(key.world, key.kind, encodeRecordId(key.id)) as Array<{ revision: number }>
  ).map((row) => row.revision);
}

export function readRecord(db: CurationDatabase, key: LessonKey): Record<string, unknown> | null {
  return (
    (db.sqlite
      .query("SELECT * FROM records WHERE world = ? AND kind = ? AND id_json = ?")
      .get(key.world, key.kind, encodeRecordId(key.id)) as Record<string, unknown> | null) ?? null
  );
}

/** Every row of every curation table, in a stable order. */
export function dump(db: CurationDatabase): Record<string, unknown[]> {
  const all = (sql: string) => db.sqlite.query(sql).all();
  return {
    records: all("SELECT * FROM records ORDER BY world, kind, id_json"),
    revisions: all("SELECT * FROM revisions ORDER BY world, kind, id_json, revision"),
    requests: all("SELECT * FROM requests ORDER BY request_id"),
    meta: all("SELECT * FROM meta ORDER BY key"),
  };
}

// --- child processes -----------------------------------------------------

export interface ApplyPlan {
  mutation: CurationMutation;
  source: LegacySourceSnapshot | null;
  ready?: string;
  pause?: { paused: string; barrier: string };
  crash?: boolean;
}

let planCounter = 0;

function writePlan(fx: CurationFixture, plan: ApplyPlan): string {
  const file = join(fx.root, `plan-${++planCounter}.json`);
  writeFileSync(file, JSON.stringify(plan));
  return file;
}

export function runApply(fx: CurationFixture, plan: ApplyPlan): Promise<ChildResult> {
  return runCurationChild(fx, ["apply", writePlan(fx, plan)]);
}

export function spawnApply(fx: CurationFixture, plan: ApplyPlan): Promise<ChildResult> {
  const child = spawnCurationChild(fx, ["apply", writePlan(fx, plan)]);
  return (async () => {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    return { exitCode: child.exitCode, signalCode: child.signalCode, stdout, stderr };
  })();
}

export function parseChild(result: ChildResult): { receipt?: CurationReceipt; error?: { code: string; current: unknown } } {
  const line = result.stdout.trim();
  if (line.length === 0) throw new Error(`child printed nothing: exit ${result.exitCode} ${result.signalCode} ${result.stderr}`);
  return JSON.parse(line);
}

export async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(2);
  }
}
