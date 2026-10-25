// `sil ops` with a mutation envelope on stdin: the same entry as reads, told
// apart by the complete envelope shape. Spawns the real CLI in the inert
// curation fixture.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { decodeControlResponse } from "@sil/core/control-protocol";
import { decodeCurationMutationResponse } from "@sil/core/control-mutation";
import type { CurationMutation } from "@sil/core/lesson-curation";
import { encodeCurationMutationRequest } from "@sil/core/lesson-curation-wire";
import { createCurationFixture, type CurationFixture } from "../../../tests/curation-fixture.ts";

const CLI = join(import.meta.dir, "..", "src", "main.ts");

let fx: CurationFixture;
beforeEach(() => {
  fx = createCurationFixture();
});
afterEach(() => fx.cleanup());

const curationDir = () => join(fx.env["SIL_DATA_DIR"]!, "curation");

async function sil(stdin: string | Uint8Array): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, "ops"], { env: fx.env, cwd: fx.root, stdin: typeof stdin === "string" ? new TextEncoder().encode(stdin) : stdin, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  return { code: child.exitCode, stdout, stderr };
}

async function locationId(): Promise<string> {
  // The location id is a digest of the canonical data dir; ask the host for it.
  const r = await sil(JSON.stringify({ version: 1, requestId: "loc", reads: [{ id: "s", op: "lessons.store", args: {} }] }));
  const res = decodeControlResponse(r.stdout.trim(), "loc").results["s"];
  if (!res?.ok) throw new Error(`lessons.store failed: ${r.stdout} ${r.stderr}`);
  return (res.value as { binding: { id: string } }).binding.id;
}

function capture(location: string, text = "Prefer rg over grep."): CurationMutation {
  return {
    requestId: `lc_${crypto.randomUUID()}`,
    binding: { kind: "location", id: location },
    scope: { world: fx.world, project: { kind: "world" } },
    key: { world: fx.world, kind: "capture", id: crypto.randomUUID() },
    expectedRevision: 0,
    change: {
      kind: "capture",
      text,
      source: { kind: "explicit_quote", quote: "a quoted line", reference: null, quoteRedacted: false, captureSessionId: null, sourceConversationId: null, sourceRowId: null, sourceAgentId: null },
    },
  };
}

describe("sil ops mutation envelopes", () => {
  test("a bootstrap capture on stdin answers one decoded success envelope", async () => {
    const loc = await locationId();
    expect(existsSync(curationDir())).toBe(false);
    const m = capture(loc);
    const r = await sil(encodeCurationMutationRequest({ mutation: m, precondition: { kind: "uninitialized", locationId: loc } }, null));
    expect(r.code).toBe(0);
    const res = decodeCurationMutationResponse(r.stdout.trim(), m.requestId);
    if (!("receipt" in res)) throw new Error(`expected success: ${r.stdout}`);
    expect(res.receipt).toMatchObject({ state: "completed", result: { key: m.key, revision: 1, changed: true } });
    expect(res.store.locationId).toBe(loc);
  });

  test("a refused mutation exits 0 with a failure envelope and touches no store", async () => {
    const loc = await locationId();
    const m = { ...capture(loc), expectedRevision: 1, change: { kind: "purge", confirmed: true } } as CurationMutation;
    const text = encodeCurationMutationRequest({ mutation: m, precondition: { kind: "uninitialized", locationId: loc } }, null).replace('"op":"lessons.purge"', '"op":"lessons.setImportant"').replace('"confirmed":true}}', '"confirmed":false}}');
    const r = await sil(text);
    expect(r.code).toBe(0);
    const res = decodeCurationMutationResponse(r.stdout.trim(), m.requestId);
    expect("error" in res && res.error.code).toBe("INVALID_INPUT");
    expect(existsSync(curationDir())).toBe(false);
  });

  test("a mutation envelope over 16384 bytes exits 2 before dispatch", async () => {
    const loc = await locationId();
    const m = capture(loc);
    const text = encodeCurationMutationRequest({ mutation: m, precondition: { kind: "uninitialized", locationId: loc } }, null);
    const over = text.replace('"text":"Prefer', `"text":"${"x".repeat(16385 - text.length)}Prefer`);
    expect(new TextEncoder().encode(over).length).toBe(16385);
    const r = await sil(over);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(existsSync(curationDir())).toBe(false);
  });

  test("a mixed read and mutation envelope exits 2", async () => {
    const r = await sil(JSON.stringify({ version: 1, requestId: "mixed", reads: [], mutation: { op: "lessons.edit", args: {}, confirmed: false } }));
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
  });

  test("a read envelope keeps the parent read path", async () => {
    const r = await sil(JSON.stringify({ version: 1, requestId: "w", reads: [{ id: "w", op: "worlds.list", args: {} }] }));
    expect(r.code).toBe(0);
    const res = decodeControlResponse(r.stdout.trim(), "w").results["w"];
    expect(res?.ok).toBe(true);
  });
});
