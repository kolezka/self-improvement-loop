// Mutation-side open and write seams: an explicit precondition decides which
// store handle a mutation may run on, and source/scope checks run inside the
// owning transaction only after replay and tombstone checks had their say.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CurationError } from "@sil/core/lesson-curation";
import type { CurationPrecondition, StoreBinding } from "@sil/core/lesson-curation";
import {
  attemptCurationMutation,
  curationDir,
  curationLocationId,
  openCurationStore,
  openCurationStoreForMutation,
  probeFilesystem,
} from "../src/index.ts";
import { openCurationStoreWith } from "../src/curation/database.ts";
import type { CurationDatabase, CurationWriteContext, LegacySourceSnapshot } from "../src/index.ts";
import { createCurationFixture, runCurationChild, useFixtureEnv } from "../../../tests/curation-fixture.ts";
import { CurationStoreError } from "../src/index.ts";
import type { CurationFixture } from "../../../tests/curation-fixture.ts";
import { captureChange, captureKey, dump, inboxKey, mutation, source } from "./curation-mutation-helpers.ts";

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

const location = (): StoreBinding => ({ kind: "location", id: curationLocationId() });

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CurationError) return error.code;
    throw error;
  }
  throw new Error("expected a CurationError");
}

function freshInstallation(): string {
  const db = openCurationStore(location(), { initialize: true });
  const id = db.installationId;
  db.close();
  return id;
}

describe("openCurationStoreForMutation", () => {
  test("an installation precondition opens that installation, on the handle it verified", () => {
    const id = freshInstallation();
    const db = openCurationStoreForMutation({ kind: "installation", id }, { kind: "installation", id });
    expect(db.installationId).toBe(id);
    expect(db.locationId).toBe(curationLocationId());
    db.close();
  });

  test("a pinned location retry opens only the pinned installation", () => {
    const id = freshInstallation();
    const db = openCurationStoreForMutation(location(), { kind: "installation", id });
    expect(db.installationId).toBe(id);
    db.close();
  });

  test("a pinned retry against a replaced store is INSTALLATION_MISMATCH and writes nothing", () => {
    const pinned = freshInstallation();
    rmSync(curationDir(), { recursive: true, force: true });
    const replacement = freshInstallation();
    expect(replacement).not.toBe(pinned);
    expect(code(() => openCurationStoreForMutation(location(), { kind: "installation", id: pinned }))).toBe("INSTALLATION_MISMATCH");
    const db = openCurationStore({ kind: "installation", id: replacement }, { initialize: false });
    expect(dump(db).records).toEqual([]);
    expect(dump(db).requests).toEqual([]);
    db.close();
  });

  test("an installation precondition never initializes an absent store", () => {
    const precondition: CurationPrecondition = { kind: "installation", id: "8c4f2f9e-3b1a-4d6c-9e8f-7a6b5c4d3e2f" };
    expect(code(() => openCurationStoreForMutation(location(), precondition))).toBe("INSTALLATION_MISMATCH");
    expect(existsSync(curationDir())).toBe(false);
  });

  test("an uninitialized precondition bootstraps an absent store", () => {
    const db = openCurationStoreForMutation(location(), { kind: "uninitialized", locationId: curationLocationId() });
    expect(db.installationId).toMatch(/^[0-9a-f-]{36}$/);
    db.close();
  });

  test("an uninitialized precondition refuses a store that already exists", () => {
    const id = freshInstallation();
    expect(code(() => openCurationStoreForMutation(location(), { kind: "uninitialized", locationId: curationLocationId() }))).toBe("INSTALLATION_MISMATCH");
    const db = openCurationStore({ kind: "installation", id }, { initialize: false });
    expect(dump(db).records).toEqual([]);
    db.close();
  });

  test("an uninitialized precondition refuses a store that appeared during contention", async () => {
    const plan = JSON.stringify({ binding: location(), precondition: { kind: "uninitialized", locationId: curationLocationId() } });
    const result = await runCurationChild(fx, ["open-expect", plan, "race"]);
    const out = JSON.parse(result.stdout.trim());
    // Positive control: the racer did create a store while we were opening.
    const status = await runCurationChild(fx, ["inspect"]);
    expect(JSON.parse(status.stdout.trim()).state).toBe("ready");
    expect(out.error?.code).toBe("INSTALLATION_MISMATCH");
    expect(result.exitCode).toBe(1);
  });

  /** File name to content hash, so "unchanged" means bytes, not a count. */
  function snapshot(dir: string): Record<string, string> {
    return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")]));
  }

  /**
   * Two owned stores: I in this fixture, J in a second one. The returned swap
   * moves J into I's curation path, the way a second local actor could
   * between this process's inspection and its database open.
   */
  function twoStores(): { pinned: string; replacement: string; swap: () => void; replacementFiles: () => Record<string, string>; cleanup: () => void } {
    const pinned = freshInstallation();
    const pinnedDir = curationDir();
    const second = createCurationFixture();
    restoreEnv();
    let restoreSecond = useFixtureEnv(second);
    let replacement: string;
    let secondDir: string;
    try {
      replacement = freshInstallation();
      secondDir = curationDir();
    } finally {
      restoreSecond();
      restoreEnv = useFixtureEnv(fx);
    }
    let swapped = false;
    return {
      pinned,
      replacement,
      swap: () => {
        if (swapped) return;
        swapped = true;
        renameSync(pinnedDir, join(fx.root, "original-curation"));
        renameSync(secondDir, pinnedDir);
      },
      replacementFiles: () => snapshot(swapped ? pinnedDir : secondDir),
      cleanup: () => second.cleanup(),
    };
  }

  test("an installation precondition refuses a store replaced after inspection, on the opened handle", () => {
    const stores = twoStores();
    try {
      const before = stores.replacementFiles();
      let reads = 0;
      // The first read of the expected id comes after inspection, before the open.
      const precondition = {
        kind: "installation" as const,
        get id() {
          reads += 1;
          stores.swap();
          return stores.pinned;
        },
      };
      let error: unknown;
      try {
        openCurationStoreForMutation({ kind: "installation", id: stores.pinned }, precondition).close();
      } catch (e) {
        error = e;
      }
      expect(reads).toBeGreaterThan(0);
      expect(error).toBeInstanceOf(CurationStoreError);
      expect((error as CurationStoreError).code).toBe("INSTALLATION_MISMATCH");
      expect((error as CurationStoreError).problem).toBe("identity_mismatch");
      // The replacement J now sits at the pinned path, untouched.
      expect(stores.replacementFiles()).toEqual(before);
      const j = openCurationStore({ kind: "installation", id: stores.replacement }, { initialize: false });
      expect(dump(j).records).toEqual([]);
      expect(dump(j).requests).toEqual([]);
      j.close();
    } finally {
      stores.cleanup();
    }
  });

  test("without an expected installation the same replacement keeps its storage error", () => {
    const stores = twoStores();
    try {
      // No precondition: the swap rides on the binding read that follows inspection.
      const binding = {
        kind: "installation" as const,
        get id() {
          stores.swap();
          return stores.pinned;
        },
      };
      let error: unknown;
      try {
        openCurationStoreWith(binding, { initialize: false }, { probeFilesystem, onInitStep: () => {} }).close();
      } catch (e) {
        error = e;
      }
      expect((error as CurationStoreError).code).toBe("STORAGE_UNAVAILABLE");
      expect((error as CurationStoreError).problem).toBe("identity_mismatch");
    } finally {
      stores.cleanup();
    }
  });

  test("control: the same two stores without a swap open the pinned installation", () => {
    const stores = twoStores();
    try {
      const db = openCurationStoreForMutation({ kind: "installation", id: stores.pinned }, { kind: "installation", id: stores.pinned });
      expect(db.installationId).toBe(stores.pinned);
      db.close();
    } finally {
      stores.cleanup();
    }
  });

  test("no-expect callers keep their behavior: location open with initialize joins an existing store", () => {
    const id = freshInstallation();
    const db = openCurationStore(location(), { initialize: true });
    expect(db.installationId).toBe(id);
    db.close();
  });
});

describe("attemptCurationMutation", () => {
  let db: CurationDatabase;
  beforeEach(() => {
    db = openCurationStore(location(), { initialize: true });
  });
  afterEach(() => db.close());

  function spyContext(snapshot: LegacySourceSnapshot | null, onScope: (s: LegacySourceSnapshot | null) => void = () => {}) {
    const calls = { source: 0, scope: 0 };
    const context: CurationWriteContext = {
      resolveSource: () => {
        calls.source += 1;
        return snapshot;
      },
      validateScope: (s) => {
        calls.scope += 1;
        onScope(s);
      },
    };
    return { calls, context };
  }

  test("a first inbox annotation resolves the source once and validates scope with it", () => {
    const key = inboxKey(fx.world, "legacy-1");
    const snap = source(fx.world, "legacy-1");
    let seen: LegacySourceSnapshot | null = null;
    const { calls, context } = spyContext(snap, (s) => (seen = s));
    const out = attemptCurationMutation(db, mutation(db, key, { kind: "important", value: true }, 0), context);
    expect(out.state).toBe("receipt");
    expect(calls).toEqual({ source: 1, scope: 1 });
    expect(seen as LegacySourceSnapshot | null).toEqual(snap);
  });

  test("a capture validates scope without reading any source", () => {
    const { calls, context } = spyContext(null);
    const out = attemptCurationMutation(db, mutation(db, captureKey(fx.world), captureChange("Prefer rg."), 0), context);
    expect(out.state).toBe("receipt");
    expect(calls).toEqual({ source: 0, scope: 1 });
  });

  test("a replay returns the committed receipt without touching the source", () => {
    const key = inboxKey(fx.world, "legacy-2");
    const input = mutation(db, key, { kind: "edit", text: "Curated." }, 0);
    const first = attemptCurationMutation(db, input, spyContext(source(fx.world, "legacy-2")).context);
    if (first.state !== "receipt") throw new Error("setup");
    const missing = spyContext(null, () => {
      throw new CurationError("SCOPE_CONFLICT", ["scope"]);
    });
    missing.context.resolveSource = () => {
      missing.calls.source += 1;
      throw new CurationError("SOURCE_CONFLICT", ["source"]);
    };
    const again = attemptCurationMutation(db, input, missing.context);
    expect(again).toEqual(first);
    expect(missing.calls).toEqual({ source: 0, scope: 0 });
  });

  test("a tombstoned key refuses without touching source or scope", () => {
    const key = inboxKey(fx.world, "legacy-3");
    attemptCurationMutation(db, mutation(db, key, { kind: "edit", text: "Curated." }, 0), spyContext(source(fx.world, "legacy-3")).context);
    attemptCurationMutation(db, mutation(db, key, { kind: "purge", confirmed: true }, 1), spyContext(null).context);
    const { calls, context } = spyContext(source(fx.world, "legacy-3"));
    const out = attemptCurationMutation(db, mutation(db, key, { kind: "edit", text: "Again." }, 2), context);
    expect(out.state).toBe("rolled-back");
    if (out.state !== "rolled-back") throw new Error("narrow");
    expect((out.error as CurationError).code).toBe("PURGED");
    expect(calls).toEqual({ source: 0, scope: 0 });
  });

  test("a scope refusal inside the transaction rolls back and reports rolled-back", () => {
    const before = dump(db);
    const { context } = spyContext(null, () => {
      throw new CurationError("SCOPE_CONFLICT", ["scope"]);
    });
    const out = attemptCurationMutation(db, mutation(db, captureKey(fx.world), captureChange("Prefer rg."), 0), context);
    expect(out.state).toBe("rolled-back");
    expect(dump(db)).toEqual(before);
  });

  test("a failure after COMMIT is unknown, and the receipt is there", () => {
    const input = mutation(db, captureKey(fx.world), captureChange("Prefer rg."), 0);
    const out = attemptCurationMutation(db, input, spyContext(null).context, {
      beforeCommit: () => {},
      afterCommit: () => {
        throw new CurationError("CURATION_CONFLICT", ["late"]);
      },
    });
    expect(out.state).toBe("unknown");
    expect(dump(db)["requests"]?.length).toBe(1);
  });

  test("a parse refusal before BEGIN is rolled-back with nothing written", () => {
    const before = dump(db);
    const bad = { ...mutation(db, captureKey(fx.world), captureChange("Prefer rg."), 0), requestId: "nope" };
    const out = attemptCurationMutation(db, bad, spyContext(null).context);
    expect(out.state).toBe("rolled-back");
    expect(dump(db)).toEqual(before);
  });
});
