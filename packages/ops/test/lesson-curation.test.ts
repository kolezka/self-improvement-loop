// The one guarded curation mutation path in @sil/ops. Common gates refuse
// before any owner or store is touched; the curation owner runs the real
// store; anything after dispatch that is not a proven rollback is an unknown
// outcome, never a refusal.

import "@sil/ops";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Lesson, paths } from "@sil/core";
import { ControlProtocolError } from "@sil/core/control-protocol";
import {
  MutationOutcomeUnknown,
  MutationPurged,
  MutationRefused,
  classifyMutationFailure,
  mutationRequestOf,
  type CurationMutationResponse,
  type MutationRequestEnvelope,
} from "@sil/core/control-mutation";
import { CurationError, encodeLessonKey, type CurationChange, type CurationMutation, type CurationPrecondition, type LessonKey } from "@sil/core/lesson-curation";
import { toCurationMutationEnvelope } from "@sil/core/lesson-curation-wire";
import { curationDir, curationLocationId, inspectCurationStore, openCurationStore } from "@sil/store";
import { executeControlRead } from "@sil/ops/control";
import {
  MUTATION_OWNERS,
  decodeMutationRequestBytes,
  dispatchMutation,
  dispatchMutationWith,
  executeMutation,
  type MutationOwner,
  type MutationOwners,
} from "@sil/ops/mutation";
import { CONTROL_READ_OPS } from "@sil/ops/control";
import { invoke, REGISTRY } from "@sil/ops";
import { createCurationFixture, useFixtureEnv, type CurationFixture } from "../../../tests/curation-fixture.ts";

let fx: CurationFixture;
let restoreEnv: () => void;

beforeEach(() => {
  fx = createCurationFixture();
  restoreEnv = useFixtureEnv(fx);
});

afterEach(() => {
  restoreEnv();
  fx.cleanup();
});

const rid = (): string => `lc_${crypto.randomUUID()}`;
const location = () => ({ kind: "location" as const, id: curationLocationId() });
const bootstrap = (): CurationPrecondition => ({ kind: "uninitialized", locationId: curationLocationId() });

function captureMutation(requestId = rid(), id: string = crypto.randomUUID(), text = "Prefer rg over grep."): CurationMutation {
  return {
    requestId,
    binding: location(),
    scope: { world: fx.world, project: { kind: "world" } },
    key: { world: fx.world, kind: "capture", id },
    expectedRevision: 0,
    change: {
      kind: "capture",
      text,
      source: { kind: "explicit_quote", quote: "a quoted line", reference: null, quoteRedacted: false, captureSessionId: null, sourceConversationId: null, sourceRowId: null, sourceAgentId: null },
    },
  };
}

function follow(prior: CurationMutation, installationId: string, change: CurationChange, expectedRevision: number, requestId = rid()): CurationMutation {
  return { ...prior, requestId, binding: { kind: "installation", id: installationId }, expectedRevision, change };
}

function env(m: CurationMutation, precondition: CurationPrecondition): MutationRequestEnvelope {
  return toCurationMutationEnvelope({ mutation: m, precondition }, null);
}

function spyOwners(): { owners: MutationOwners; calls: { curation: number; generic: number } } {
  const calls = { curation: 0, generic: 0 };
  const owners: MutationOwners = {
    curation: { execute: async () => { calls.curation += 1; throw new Error("owner must not run"); } },
    generic: { execute: async () => { calls.generic += 1; throw new Error("generic owner must not run"); } },
  };
  return { owners, calls };
}

function failureOf(r: CurationMutationResponse): { code: string; conflict: { revision: number } | null } {
  if (!("error" in r)) throw new Error(`expected failure, got ${JSON.stringify(r)}`);
  return { code: r.error.code, conflict: r.conflict };
}

function successOf(r: CurationMutationResponse) {
  if (!("receipt" in r)) throw new Error(`expected success, got ${JSON.stringify(r)}`);
  return r;
}

function writeInbox(id: string, text = "legacy inbox text"): void {
  const dir = paths.inboxDir(fx.world);
  mkdirSync(dir, { recursive: true });
  const lesson = Lesson.parse({ id, world: fx.world, pattern: "legacy-pattern", text, created: "2026-10-01T00:00:00.000Z" });
  writeFileSync(join(dir, `${paths.safeComponent(id)}.json`), JSON.stringify(lesson));
}

describe("common gates", () => {
  const cases: Array<[string, () => unknown, string]> = [
    ["an unregistered op", () => ({ ...env(captureMutation(), bootstrap()), mutation: { ...env(captureMutation(), bootstrap()).mutation, op: "nope.op" } }), "OpNotAllowed"],
    ["a read op", () => ({ ...env(captureMutation(), bootstrap()), mutation: { op: "lessons.get", args: {}, confirmed: false } }), "OpNotAllowed"],
    ["a generic job op", () => ({ version: 1, requestId: "job-1", mutation: { op: "loop.run", args: { world: "curation-test" }, confirmed: false } }), "UNSUPPORTED_OPERATION"],
    ["an lc_ id on a generic op", () => ({ version: 1, requestId: rid(), mutation: { op: "queue.skip", args: { session_id: "s" }, confirmed: false } }), "INVALID_INPUT"],
    ["an unnamespaced id on a curation op", () => {
      const e = env(captureMutation(), bootstrap());
      const args = e.mutation.args as { mutation: CurationMutation };
      return { ...e, requestId: "req-1", mutation: { ...e.mutation, args: { ...args, mutation: { ...args.mutation, requestId: "req-1" } } } };
    }, "INVALID_INPUT"],
    ["an inner id that disagrees with the outer id", () => ({ ...env(captureMutation(), bootstrap()), requestId: rid() }), "INVALID_INPUT"],
    ["an expectedState on a curation op", () => {
      const e = env(captureMutation(), bootstrap());
      return { ...e, mutation: { ...e.mutation, expectedState: "x" } };
    }, "InvalidArgs"],
    ["an unknown args key", () => {
      const e = env(captureMutation(), bootstrap());
      return { ...e, mutation: { ...e.mutation, args: { ...e.mutation.args, extra: 1 } } };
    }, "INVALID_INPUT"],
    ["a prototype key in args", () => {
      const e = env(captureMutation(), bootstrap());
      return { ...e, mutation: { ...e.mutation, args: JSON.parse(JSON.stringify(e.mutation.args).replace(/^\{/, '{"__proto__":{"v":1},')) } };
    }, "INVALID_INPUT"],
    ["a purge body under lessons.setImportant", () => {
      const m = { ...captureMutation(), expectedRevision: 1, change: { kind: "purge", confirmed: true } as CurationChange };
      const e = env(m, bootstrap());
      return { ...e, mutation: { ...e.mutation, op: "lessons.setImportant", confirmed: false } };
    }, "INVALID_INPUT"],
    ["a purge without outer confirmation", () => {
      const m = { ...captureMutation(), expectedRevision: 1, change: { kind: "purge", confirmed: true } as CurationChange };
      const e = env(m, bootstrap());
      return { ...e, mutation: { ...e.mutation, confirmed: false } };
    }, "INVALID_INPUT"],
    ["an outer confirmation on a non-purge op", () => {
      const e = env(captureMutation(), bootstrap());
      return { ...e, mutation: { ...e.mutation, confirmed: true } };
    }, "INVALID_INPUT"],
    ["a key world outside its scope", () => env({ ...captureMutation(), scope: { world: "other-world", project: { kind: "world" } } }, bootstrap()), "SCOPE_CONFLICT"],
    ["a world that is not configured", () => {
      const m = captureMutation();
      return env({ ...m, scope: { world: "ghost", project: { kind: "world" } }, key: { ...m.key, world: "ghost" } }, bootstrap());
    }, "INVALID_INPUT"],
    ["possible secret text", () => env(captureMutation(rid(), crypto.randomUUID(), "token: sk-abcdefghijklmnop1234"), bootstrap()), "SENSITIVE_CONTENT"],
  ];

  test.each(cases)("refuses %s before any owner or store", async (_name, make, code) => {
    const { owners, calls } = spyOwners();
    const r = await dispatchMutationWith(make(), owners);
    const f = failureOf(r);
    expect(f.code).toBe(code);
    expect(classifyMutationFailure((r as { error: { code: string; message: string; retryable: boolean } }).error)).toBe("refused");
    expect(calls).toEqual({ curation: 0, generic: 0 });
    expect(existsSync(curationDir())).toBe(false);
  });

  test("a structurally invalid envelope is a protocol error, not a response", async () => {
    await expect(dispatchMutation({ version: 1, requestId: rid() })).rejects.toBeInstanceOf(ControlProtocolError);
    expect(existsSync(curationDir())).toBe(false);
  });

  test("the request byte bound applies before parsing: 16385 bytes is refused", () => {
    const e = env(captureMutation(), bootstrap());
    const base = JSON.stringify(e);
    const padded = base.replace('"text":"Prefer rg over grep."', `"text":"${"x".repeat(16384 - base.length + "Prefer rg over grep.".length)}"`);
    expect(new TextEncoder().encode(padded).length).toBe(16384);
    expect(decodeMutationRequestBytes(new TextEncoder().encode(padded)).requestId).toBe(e.requestId);
    const over = padded.replace('"text":"x', '"text":"xx');
    expect(() => decodeMutationRequestBytes(new TextEncoder().encode(over))).toThrow(ControlProtocolError);
  });

  // A structurally valid envelope of an exact UTF-8 size whose domain mutation alone fits 16384.
  function sizedEnvelope(totalBytes: number): { envelope: MutationRequestEnvelope; domainBytes: number } {
    const requestId = rid();
    const key: LessonKey = { world: fx.world, kind: "inbox", id: "x" };
    const m: CurationMutation = { requestId, binding: location(), scope: { world: fx.world, project: { kind: "world" } }, key, expectedRevision: 0, change: { kind: "important", value: true } };
    const envelope: MutationRequestEnvelope = { version: 1, requestId, mutation: { op: "lessons.setImportant", args: { v: 1, mutation: m, precondition: bootstrap(), projectRoot: null }, confirmed: false } };
    const bytes = () => new TextEncoder().encode(JSON.stringify(envelope)).length;
    key.id = "x".repeat(1 + totalBytes - bytes());
    if (bytes() !== totalBytes) throw new Error("setup: size");
    return { envelope, domainBytes: new TextEncoder().encode(JSON.stringify(m)).length };
  }

  test("dispatchMutation refuses a 16385-byte envelope before gates, owner or storage", async () => {
    const { envelope, domainBytes } = sizedEnvelope(16385);
    expect(domainBytes).toBeLessThanOrEqual(16384);
    const { owners, calls } = spyOwners();
    await expect(dispatchMutationWith(envelope, owners)).rejects.toBeInstanceOf(ControlProtocolError);
    await expect(dispatchMutation(envelope)).rejects.toBeInstanceOf(ControlProtocolError);
    expect(calls).toEqual({ curation: 0, generic: 0 });
    expect(existsSync(curationDir())).toBe(false);
  });

  test("executeMutation refuses the same 16385-byte envelope before storage", async () => {
    const { envelope } = sizedEnvelope(16385);
    await expect(executeMutation(mutationRequestOf(envelope))).rejects.toBeInstanceOf(ControlProtocolError);
    expect(existsSync(curationDir())).toBe(false);
  });

  test("a 16384-byte envelope passes the byte gate and reaches the owner", async () => {
    const { envelope } = sizedEnvelope(16384);
    const r = await dispatchMutation(envelope);
    // The inbox source does not exist, so the real owner refuses inside the transaction.
    expect(failureOf(r).code).toBe("SOURCE_CONFLICT");
    expect(existsSync(curationDir())).toBe(true);
  });

  test("an unserializable envelope is refused without echoing content or reaching an owner", async () => {
    const { owners, calls } = spyOwners();
    // Each one passes the structural envelope parser: only the serialization gate sees it.
    const base = () => env(captureMutation(), bootstrap());
    const cyclic = base();
    (cyclic.mutation.args as Record<string, unknown>)["self"] = cyclic.mutation.args;
    const withBigInt = base();
    (withBigInt.mutation.args["mutation"] as Record<string, unknown>)["expectedRevision"] = 1n;
    const throwing = base();
    (throwing.mutation.args as Record<string, unknown>)["x"] = { toJSON: () => { throw new Error("Prefer rg secret body"); } };
    for (const input of [cyclic, withBigInt, throwing]) {
      let thrown: unknown;
      try {
        await dispatchMutationWith(input, owners);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ControlProtocolError);
      expect((thrown as Error).message).not.toContain("Prefer rg");
    }
    expect(calls).toEqual({ curation: 0, generic: 0 });
    expect(existsSync(curationDir())).toBe(false);
  });

  test("the generic invoke shortcut cannot run a curation mutation", async () => {
    const e = env(captureMutation(), bootstrap());
    await expect(invoke("lessons.capture", e.mutation.args)).rejects.toThrow();
    expect(existsSync(curationDir())).toBe(false);
  });

  test("production owners hold only curation", () => {
    expect(Object.keys(MUTATION_OWNERS)).toEqual(["curation"]);
  });
});

describe("the curation owner on the real store", () => {
  test("a bootstrap capture commits and reports the handle that executed it", async () => {
    const m = captureMutation();
    const r = successOf(await dispatchMutation(env(m, bootstrap())));
    const status = inspectCurationStore();
    if (status.state !== "ready") throw new Error("store not ready");
    expect(r.store).toEqual({ locationId: curationLocationId(), installationId: status.binding.id });
    expect(r.receipt).toMatchObject({ requestId: m.requestId, state: "completed", error: null, result: { key: m.key, revision: 1, changed: true } });
    expect(r.receipt.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an identical retry replays the same receipt; a pinned location retry too", async () => {
    const m = captureMutation();
    const first = successOf(await dispatchMutation(env(m, bootstrap())));
    const again = successOf(await dispatchMutation(env(m, { kind: "installation", id: first.store.installationId })));
    expect(again).toEqual(first);
  });

  test("a stale edit is a definite refusal with a conflict hint, and changes nothing", async () => {
    const m = captureMutation();
    const first = successOf(await dispatchMutation(env(m, bootstrap())));
    const id = first.store.installationId;
    const pinned: CurationPrecondition = { kind: "installation", id };
    successOf(await dispatchMutation(env(follow(m, id, { kind: "edit", text: "Edited once." }, 1), pinned)));
    const db = openCurationStore({ kind: "installation", id }, { initialize: false });
    const before = db.sqlite.query("SELECT * FROM records").all();
    const beforeReq = db.sqlite.query("SELECT * FROM requests ORDER BY request_id").all();
    db.close();
    const stale = await dispatchMutation(env(follow(m, id, { kind: "edit", text: "Stale." }, 1), pinned));
    expect(failureOf(stale)).toEqual({ code: "CURATION_CONFLICT", conflict: { revision: 2 } });
    const after = openCurationStore({ kind: "installation", id }, { initialize: false });
    expect(after.sqlite.query("SELECT * FROM records").all()).toEqual(before);
    expect(after.sqlite.query("SELECT * FROM requests ORDER BY request_id").all()).toEqual(beforeReq);
    after.close();
  });

  test("a store replaced between inspection and open projects as a definite INSTALLATION_MISMATCH", async () => {
    // Pinned store I here, store J in a second owned fixture.
    const m = captureMutation();
    const first = successOf(await dispatchMutation(env(m, bootstrap())));
    const pinnedDir = curationDir();
    const second = createCurationFixture();
    restoreEnv();
    let restoreSecond = useFixtureEnv(second);
    let secondDir: string;
    try {
      successOf(await dispatchMutation(env(captureMutation(), bootstrap())));
      secondDir = curationDir();
    } finally {
      restoreSecond();
      restoreEnv = useFixtureEnv(fx);
    }
    try {
      let swapped = false;
      const precondition = {
        kind: "installation" as const,
        get id() {
          if (!swapped) {
            swapped = true;
            renameSync(pinnedDir, join(fx.root, "original-curation"));
            renameSync(secondDir, pinnedDir);
          }
          return first.store.installationId;
        },
      };
      // The real owner and dispatcher; only the precondition object carries the test seam.
      const owner: MutationOwner = { execute: (requestId, args) => MUTATION_OWNERS.curation.execute(requestId, { ...args, precondition }) };
      const edit = follow(m, first.store.installationId, { kind: "edit", text: "Edited." }, 1);
      const r = await dispatchMutationWith(env(edit, { kind: "installation", id: first.store.installationId }), { curation: owner });
      expect(swapped).toBe(true);
      expect(failureOf(r)).toEqual({ code: "INSTALLATION_MISMATCH", conflict: null });
      expect(classifyMutationFailure((r as { error: { code: string; message: string; retryable: boolean } }).error)).toBe("refused");
    } finally {
      second.cleanup();
    }
  });

  test("an installation mismatch is refused before any write", async () => {
    const r = await dispatchMutation(env(follow(captureMutation(), "8c4f2f9e-3b1a-4d6c-9e8f-7a6b5c4d3e2f", captureMutation().change, 0), { kind: "installation", id: "8c4f2f9e-3b1a-4d6c-9e8f-7a6b5c4d3e2f" }));
    expect(failureOf(r).code).toBe("INSTALLATION_MISMATCH");
    expect(existsSync(curationDir())).toBe(false);
  });

  test("purge returns the purged arm with identity and null data; later writes are PURGED", async () => {
    const m = captureMutation();
    const first = successOf(await dispatchMutation(env(m, bootstrap())));
    const pinned: CurationPrecondition = { kind: "installation", id: first.store.installationId };
    const purge = follow(m, first.store.installationId, { kind: "purge", confirmed: true }, 1);
    const r = successOf(await dispatchMutation(env(purge, pinned)));
    expect(r.receipt).toEqual({ requestId: purge.requestId, state: "purged", payloadHash: null, result: null, error: null, startedAt: expect.any(String), finishedAt: expect.any(String) });
    expect(r.store).toEqual(first.store);
    const replayOriginal = successOf(await dispatchMutation(env(m, pinned)));
    expect(replayOriginal.receipt.state).toBe("purged");
    const late = await dispatchMutation(env(follow(m, first.store.installationId, { kind: "edit", text: "Late." }, 2), pinned));
    expect(failureOf(late).code).toBe("PURGED");
  });

  test("a first inbox annotation reads the source after replay checks, and a replay survives a deleted source", async () => {
    writeInbox("legacy-1");
    const key: LessonKey = { world: fx.world, kind: "inbox", id: "legacy-1" };
    const seed = successOf(await dispatchMutation(env(captureMutation(), bootstrap())));
    const id = seed.store.installationId;
    const m: CurationMutation = { requestId: rid(), binding: { kind: "installation", id }, scope: { world: fx.world, project: { kind: "world" } }, key, expectedRevision: 0, change: { kind: "important", value: true } };
    const first = successOf(await dispatchMutation(env(m, { kind: "installation", id })));
    expect(first.receipt).toMatchObject({ state: "completed", result: { key, revision: 1, changed: true } });
    const file = join(paths.inboxDir(fx.world), `${paths.safeComponent("legacy-1")}.json`);
    writeFileSync(file, "{not json");
    const again = successOf(await dispatchMutation(env(m, { kind: "installation", id })));
    expect(again).toEqual(first);
  });
});

describe("refusal versus unknown outcome", () => {
  function committingThenThrowing(error: () => Error): MutationOwner {
    return {
      execute: async (requestId, args) => {
        const out = await MUTATION_OWNERS.curation.execute(requestId, args);
        if (out.state !== "receipt") throw new Error("setup: expected a commit");
        throw error();
      },
    };
  }

  test.each([
    ["an unexpected error", () => new Error("boom sk-should-not-leak")],
    ["a normally eligible code", () => new CurationError("CURATION_CONFLICT", ["late"])],
  ])("%s after commit is OUTCOME_UNKNOWN and the receipt reconciles", async (_name, error) => {
    const m = captureMutation();
    const r = await dispatchMutationWith(env(m, bootstrap()), { curation: committingThenThrowing(error) });
    if (!("error" in r)) throw new Error("expected failure");
    expect(r.error).toEqual({ code: "OUTCOME_UNKNOWN", message: expect.any(String), retryable: false });
    expect(r.error.message).not.toContain("sk-");
    expect(r.conflict).toBeNull();
    expect(classifyMutationFailure(r.error)).toBe("unknown");
    const status = inspectCurationStore();
    if (status.state !== "ready") throw new Error("not ready");
    const receipt = (await invoke("lessons.receipt", {
      key: encodeLessonKey(m.key),
      project: "world",
      binding: `installation:${status.binding.id}`,
      requestId: m.requestId,
    })) as { store: { installationId: string }; value: { state: string; revision?: number } };
    expect(receipt.value).toMatchObject({ state: "committed", revision: 1 });
    expect(receipt.store.installationId).toBe(status.binding.id);
  });

  test("an owner that reports refusal with an ineligible code becomes unknown", async () => {
    const owner: MutationOwner = { execute: async () => ({ state: "refused", error: new CurationError("STORAGE_UNAVAILABLE", ["storage"]) }) };
    const r = await dispatchMutationWith(env(captureMutation(), bootstrap()), { curation: owner });
    expect(failureOf(r).code).toBe("OUTCOME_UNKNOWN");
  });
});

describe("executeMutation (generic receipt-only projection)", () => {
  test("returns a completed OperationReceipt", async () => {
    const m = captureMutation();
    const receipt = await executeMutation(mutationRequestOf(env(m, bootstrap())));
    expect(receipt).toMatchObject({ requestId: m.requestId, state: "completed", result: { key: m.key, revision: 1, changed: true } });
  });

  test("throws MutationPurged for a purge, MutationRefused for a definite refusal", async () => {
    const m = captureMutation();
    const first = successOf(await dispatchMutation(env(m, bootstrap())));
    const pinned: CurationPrecondition = { kind: "installation", id: first.store.installationId };
    const stale = mutationRequestOf(env(follow(m, first.store.installationId, { kind: "edit", text: "x" }, 0), pinned));
    await expect(executeMutation(stale)).rejects.toBeInstanceOf(MutationRefused);
    const purge = mutationRequestOf(env(follow(m, first.store.installationId, { kind: "purge", confirmed: true }, 1), pinned));
    await expect(executeMutation(purge)).rejects.toBeInstanceOf(MutationPurged);
    await expect(executeMutation(purge)).rejects.not.toBeInstanceOf(MutationOutcomeUnknown);
  });
});

describe("lesson read ops", () => {
  test("every lesson read is in the control allowlist; no mutation is", () => {
    for (const op of ["lessons.projects", "lessons.context", "lessons.browse", "lessons.get", "lessons.history", "lessons.receipt", "lessons.store"]) {
      expect(CONTROL_READ_OPS).toContain(op);
      expect(REGISTRY.get(op)?.tier).toBe("read");
    }
    for (const op of ["lessons.capture", "lessons.edit", "lessons.setImportant", "lessons.acknowledgeSource", "lessons.purge"]) {
      expect(CONTROL_READ_OPS).not.toContain(op);
      expect(REGISTRY.get(op)?.tier).toBe("local");
    }
    expect(REGISTRY.get("lessons.purge")?.gate).toBe("confirm");
  });

  test("lessons.store reports an uninitialized store without creating one", async () => {
    const value = (await invoke("lessons.store", {})) as { state: string };
    expect(value.state).toBe("uninitialized");
    expect(existsSync(curationDir())).toBe(false);
  });

  test("lessons.receipt for an absent request is unknown, not failed", async () => {
    const m = captureMutation();
    const r = (await invoke("lessons.receipt", { key: encodeLessonKey(m.key), project: "world", binding: `location:${curationLocationId()}`, requestId: m.requestId })) as {
      store: { installationId: string | null };
      value: { state: string };
    };
    expect(r).toEqual({ store: { locationId: curationLocationId(), installationId: null }, value: { state: "unknown", requestId: m.requestId } } as never);
  });

  test("browse takes exact flat string booleans and refuses anything else", async () => {
    const m = captureMutation();
    const first = successOf(await dispatchMutation(env(m, bootstrap())));
    const base = { world: fx.world, project: "world", binding: `installation:${first.store.installationId}`, collection: "saved" };
    const notImportant = (await invoke("lessons.browse", { ...base, important: "false" })) as { value: { items: Array<{ key: LessonKey }> } };
    expect(notImportant.value.items.map((i) => i.key)).toEqual([m.key]);
    const important = (await invoke("lessons.browse", { ...base, important: "true" })) as { value: { items: unknown[] } };
    expect(important.value.items).toEqual([]);
    for (const bad of ["0", "False", "", "no"]) await expect(invoke("lessons.browse", { ...base, important: bad })).rejects.toThrow();
    await expect(invoke("lessons.browse", { ...base, extra: "1" })).rejects.toThrow();
  });

  test("get reads the committed text through a control read batch", async () => {
    const m = captureMutation();
    const first = successOf(await dispatchMutation(env(m, bootstrap())));
    const res = await executeControlRead({
      version: 1,
      requestId: "read-1",
      reads: [{ id: "g", op: "lessons.get", args: { key: encodeLessonKey(m.key), project: "world", binding: `installation:${first.store.installationId}` } }],
    });
    const g = res.results["g"];
    if (!g?.ok) throw new Error(`read failed: ${JSON.stringify(g)}`);
    const v = g.value as { store: { installationId: string }; value: { lesson: { effectiveText: string; source: { quote: string } } } };
    expect(v.store.installationId).toBe(first.store.installationId);
    expect(v.value.lesson.effectiveText).toBe("Prefer rg over grep.");
    expect(v.value.lesson.source.quote).toBe("a quoted line");
  });

  test("a curation read error keeps its safe code through the control read path", async () => {
    const res = await executeControlRead({
      version: 1,
      requestId: "read-2",
      reads: [{ id: "g", op: "lessons.get", args: { key: encodeLessonKey(captureMutation().key), project: "world", binding: "installation:8c4f2f9e-3b1a-4d6c-9e8f-7a6b5c4d3e2f" } }],
    });
    expect(res.results["g"]).toEqual({ ok: false, error: { code: "INSTALLATION_MISMATCH", message: expect.any(String), retryable: false } });
  });

  test("a curation mutation is not a control read", async () => {
    const res = await executeControlRead({ version: 1, requestId: "read-3", reads: [{ id: "c", op: "lessons.capture", args: {} }] });
    expect(res.results["c"]).toEqual({ ok: false, error: { code: "OpNotAllowed", message: expect.any(String), retryable: false } });
  });
});
