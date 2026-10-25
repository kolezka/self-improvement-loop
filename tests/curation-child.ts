// Test-only child process for curation lifecycle fixtures.
// argv: <fixture root> <command> [args]. All paths come from the explicit env.
//   inspect                 print inspectCurationStore() as JSON
//   open <binding-kind> <binding-id>   open with initialize, print the installation id
//   race <barrier-file> <ready-file>   signal ready, wait for the barrier, then initialize
//   crash-after <step>      initialize and SIGKILL this process after that step
//   pause-at <step> <paused-file> <barrier-file>   initialize, pausing after that step until the barrier exists
//   open-expect <plan-json> [race]   open under an expected precondition, optionally racing a second initializer
//   apply <plan-file>       open the ready store and apply one mutation, optionally pausing or dying before commit

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { paths } from "@sil/core";
import type { CurationMutation, CurationPrecondition, StoreBinding } from "@sil/core/lesson-curation";
import { applyCurationMutationWith } from "../packages/store/src/curation/mutations.ts";
import type { LegacySourceSnapshot } from "../packages/store/src/curation/source.ts";
import {
  curationLocationId,
  inspectCurationStore,
  openCurationStore,
  openCurationStoreWith,
  probeFilesystem,
} from "../packages/store/src/curation/database.ts";
import type { InitStep } from "../packages/store/src/curation/database.ts";

const [root, command, ...args] = process.argv.slice(2);
if (!root || !command) {
  console.error("usage: curation-child <root> <command> [args]");
  process.exit(2);
}
// Refuse to run against anything outside the fixture root, such as a real HOME.
const realRoot = realpathSync(root);
for (const dir of [paths.dataDir(), paths.stateDir(), paths.configDir(), process.env["HOME"] ?? ""]) {
  if (!dir.startsWith(`${realRoot}/`)) {
    console.error("child env escapes the fixture root");
    process.exit(3);
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function report(error: unknown): never {
  const e = error as { code?: unknown; problem?: unknown; message?: unknown };
  print({ error: { code: e.code ?? null, problem: e.problem ?? null, message: String(e.message) } });
  process.exit(1);
}

const location: StoreBinding = { kind: "location", id: curationLocationId() };

try {
  if (command === "inspect") {
    print(inspectCurationStore());
  } else if (command === "open") {
    const binding: StoreBinding = args[0] ? { kind: args[0] as StoreBinding["kind"], id: args[1] ?? "" } : location;
    const db = openCurationStore(binding, { initialize: true });
    print({ installationId: db.installationId });
    db.close();
  } else if (command === "race") {
    const [barrier, ready] = args;
    if (!barrier || !ready) throw new Error("race needs barrier and ready files");
    writeFileSync(ready, "");
    const deadline = Date.now() + 10_000;
    while (!existsSync(barrier)) {
      if (Date.now() > deadline) throw new Error("barrier timeout");
      Bun.sleepSync(1);
    }
    const db = openCurationStore(location, { initialize: true });
    print({ installationId: db.installationId });
    db.close();
  } else if (command === "crash-after") {
    const step = args[0] as InitStep;
    openCurationStoreWith(location, { initialize: true }, {
      probeFilesystem,
      onInitStep: (done) => {
        if (done === step) process.kill(process.pid, "SIGKILL");
      },
    });
    print({ survived: true });
  } else if (command === "pause-at") {
    const [step, paused, barrier] = args;
    if (!step || !paused || !barrier) throw new Error("pause-at needs step, paused and barrier files");
    const db = openCurationStoreWith(location, { initialize: true }, {
      probeFilesystem,
      onInitStep: (done) => {
        if (done !== step) return;
        writeFileSync(paused, "");
        const deadline = Date.now() + 10_000;
        while (!existsSync(barrier)) {
          if (Date.now() > deadline) throw new Error("barrier timeout");
          Bun.sleepSync(1);
        }
      },
    });
    print({ installationId: db.installationId });
    db.close();
  } else if (command === "open-expect") {
    // args[0]: JSON {binding, precondition}; args[1] "race": after this process's first
    // directory look, another child fully initializes the store and releases its guard,
    // so the store appears between our inspection and our guard acquisition.
    const plan = JSON.parse(args[0] ?? "") as { binding: StoreBinding; precondition: CurationPrecondition };
    let raced = args[1] !== "race";
    const db = openCurationStoreWith(plan.binding, { initialize: plan.precondition.kind === "uninitialized", expect: plan.precondition }, {
      probeFilesystem,
      onInitStep: () => {},
      onProbe: () => {
        if (raced) return;
        raced = true;
        const other = Bun.spawnSync([process.execPath, import.meta.path, root, "open"], { env: process.env, stdout: "pipe", stderr: "pipe" });
        if (other.exitCode !== 0) throw new Error(`racer failed: ${other.stdout.toString()}`);
      },
    });
    print({ installationId: db.installationId, locationId: db.locationId, raced });
    db.close();
  } else if (command === "apply") {
    // args[0]: JSON file {mutation, source, ready?, pause?: {paused, barrier}, crash?}
    const plan = JSON.parse(readFileSync(args[0] ?? "", "utf8")) as {
      mutation: CurationMutation;
      source: LegacySourceSnapshot | null;
      ready?: string;
      pause?: { paused: string; barrier: string };
      crash?: boolean;
    };
    const db = openCurationStore(plan.mutation.binding, { initialize: false });
    if (plan.ready) writeFileSync(plan.ready, "");
    try {
      const receipt = applyCurationMutationWith(db, plan.mutation, plan.source, {
        beforeCommit: () => {
          if (plan.crash) process.kill(process.pid, "SIGKILL");
          if (!plan.pause) return;
          writeFileSync(plan.pause.paused, "");
          const deadline = Date.now() + 10_000;
          while (!existsSync(plan.pause.barrier)) {
            if (Date.now() > deadline) throw new Error("barrier timeout");
            Bun.sleepSync(1);
          }
        },
      });
      print({ receipt });
    } catch (error) {
      const current = (error as { current?: unknown }).current ?? null;
      const e = error as { code?: unknown; fields?: unknown; message?: unknown };
      print({ error: { code: e.code ?? null, fields: e.fields ?? null, current, message: String(e.message) } });
      process.exit(1);
    } finally {
      db.close();
    }
  } else {
    console.error("unknown command");
    process.exit(2);
  }
} catch (error) {
  report(error);
}
