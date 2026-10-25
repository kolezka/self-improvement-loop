// Curation test fixture, built on the parent control fixture: same inert,
// allowlisted env and fake `claude` marker, plus one curation world whose repo
// is a real directory under a canonical root. The control fixture's seeded
// queue, status and log files stay, so a "nothing else changed" check has
// populated state to compare. Every path in `env` lives under `root`.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Config } from "@sil/core/schemas";
import { createControlFixture, type ControlFixture } from "./control-fixture.ts";

export type { ControlFixture } from "./control-fixture.ts";

export interface CurationFixture extends ControlFixture {
  world: string;
  projectRoot: string;
}

export const CURATION_FIXTURE_WORLD = "curation-test";

export function createCurationFixture(): CurationFixture {
  const base = createControlFixture({ rootPrefix: "sil-curation-" });
  const projectRoot = join(base.root, "project");
  mkdirSync(projectRoot);
  // Replace the control world with the curation world; llm.yaml stays.
  const cfg = Config.parse({
    worlds: [{ name: CURATION_FIXTURE_WORLD, repos: [projectRoot] }],
    worker: { auto_kick: false },
  });
  writeFileSync(join(base.env["SIL_CONFIG_DIR"]!, "config.yaml"), `${JSON.stringify(cfg, null, 2)}\n`);
  return { ...base, world: CURATION_FIXTURE_WORLD, projectRoot };
}

/** Point this process's path roots at the fixture. Returns the restore function. */
export function useFixtureEnv(fixture: ControlFixture): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(fixture.env)) {
    if (key === "PATH" || key === "TMPDIR") continue;
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const CHILD = join(import.meta.dir, "curation-child.ts");

export interface ChildResult {
  exitCode: number | null;
  signalCode: string | null;
  stdout: string;
  stderr: string;
}

/** Spawn the test-only child with the fixture env and nothing else. */
export function spawnCurationChild(fixture: ControlFixture, args: string[]): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn([process.execPath, CHILD, fixture.root, ...args], {
    env: fixture.env,
    cwd: fixture.root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

export async function runCurationChild(fixture: ControlFixture, args: string[]): Promise<ChildResult> {
  const child = spawnCurationChild(fixture, args);
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  return { exitCode: child.exitCode, signalCode: child.signalCode, stdout, stderr };
}
