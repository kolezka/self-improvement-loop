// Shared helpers: world resolution, the top level error mapper, git init for
// the learned/ target repo.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import {
  ConfigError,
  fsx,
  GitError,
  LockHeld,
  ProviderError,
  ReviewError,
  type Config,
  type World,
  ValidationError,
  worldForCwd,
  worldNamed,
} from "@sil/core";

/** `--world <name>` when given, else the world that owns the current cwd. */
export function resolveWorld(cfg: Config, name: string | undefined): World {
  if (name) return worldNamed(cfg, name);
  return worldForCwd(cfg, process.cwd());
}

/** `["worlds", 0, "name"]` as `worlds[0].name`. */
function zodField(path: readonly PropertyKey[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out === "" ? String(seg) : `.${String(seg)}`;
  }
  return out || "(root)";
}

function zodDetail(err: ZodError): string {
  return err.issues.map((i) => `${zodField(i.path)}: ${i.message}`).join("; ");
}

/** Maps a thrown error to (stderr line, exit code). Returns null when the
 * error is not one of the mapped domain errors: the caller should rethrow so
 * an unexpected bug still shows a stack trace instead of being swallowed. */
export function mapKnownError(err: unknown): number | null {
  // A ZodError's stack is just the class name, so the default branch in run()
  // used to print the bare word "ZodError".
  if (err instanceof ZodError) {
    console.error(`config error: ${zodDetail(err)}`);
    return 1;
  }
  if (err instanceof LockHeld) {
    console.error(`error: ${err.message}`);
    return 2;
  }
  if (err instanceof ConfigError) {
    console.error(`error: ${err.message}`);
    return 2;
  }
  if (err instanceof ReviewError || err instanceof GitError || err instanceof ProviderError || err instanceof ValidationError) {
    console.error(`error: ${err.message}`);
    return 1;
  }
  return null;
}

/** Make sure a world's built-in `learned/` target repo exists and has at
 * least one commit, so git operations that assume a `main` ref (fast-forward
 * merge, rev-parse) never fail on a freshly created repo. */
export function ensureLearnedRepo(path: string): void {
  fsx.ensureDir(path);
  if (!existsSync(join(path, ".git"))) {
    execFileSync("git", ["init", "-b", "main", path], { stdio: "ignore" });
  }
  const hasHead = trySpawn(() => execFileSync("git", ["-C", path, "rev-parse", "--verify", "HEAD"], { stdio: "ignore" }));
  if (!hasHead) {
    execFileSync(
      "git",
      ["-C", path, "-c", "user.name=self-improvement-loop", "-c", "user.email=sil@local", "commit", "--allow-empty", "-m", "init"],
      { stdio: "ignore" },
    );
  }
}

function trySpawn(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}
