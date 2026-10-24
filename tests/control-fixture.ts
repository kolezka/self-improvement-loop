// Inert, synthetic state for tests that spawn `sil ops`. Every root lives in
// one temp dir, the child env is built from an allowlist (never a spread of
// process.env), and the config disables auto_kick so nothing starts a worker.

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface ControlFixture {
  root: string;
  env: Record<string, string>;
  cleanup(): void;
}

// Known seeded values, so a test can tell a real decode from an empty one.
export const FIXTURE_WORLD = "fixture";
export const FIXTURE_LAST_RUN = "2026-10-21T09:30:00.000Z";
export const FIXTURE_QUEUE = { pending: 2, done: 1, failed: 1 } as const;
export const FIXTURE_LOG_LINE = "fixture worker log line 7f3a";
// A fake `claude` on PATH appends here, so any model call through the
// claude-cli provider leaves a trace.
export const FIXTURE_CLAUDE_MARKER = "claude-calls.log";
export const FIXTURE_CLAUDE_MARKER_ENV = "SIL_FIXTURE_CLAUDE_MARKER";
const FAKE_CLAUDE_SCRIPT = [
  "#!/bin/sh",
  `marker="\${${FIXTURE_CLAUDE_MARKER_ENV}:-$(dirname "$0")/../${FIXTURE_CLAUDE_MARKER}}"`,
  'printf \'%s\\n\' "$*" >> "$marker"',
  "echo fixture",
  "",
].join("\n");

function queueEntry(sessionId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    transcript_path: `/nonexistent/${sessionId}.jsonl`,
    cwd: "/nonexistent",
    world: FIXTURE_WORLD,
    git_head: null,
    first_stop: "2026-10-21T09:00:00Z",
    last_stop: "2026-10-21T09:05:00Z",
    stops: 1,
    ended: true,
    tool_uses: 9,
    attempts: 0,
    result: null,
  };
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export interface ControlFixtureOptions {
  /** mkdtemp prefix. Tests use it to put shell-hostile characters in the root. */
  rootPrefix?: string;
  /** Seed this dir instead of a new tmp dir. It must be an existing, empty,
   * canonical directory: absolute, and no symlink at it or above it. Cleanup
   * then empties it and leaves the dir itself. */
  root?: string;
}

/** Throws unless `root` is an existing, empty directory named by its canonical
 * path. Checked before anything is written, so a refused root is untouched. */
export function assertEmptyCanonicalRoot(root: string): void {
  if (!isAbsolute(root)) throw new Error(`fixture root must be an absolute path: ${root}`);
  const info = lstatSync(root);
  if (info.isSymbolicLink()) throw new Error(`fixture root must be a canonical path, not a symlink: ${root}`);
  if (!info.isDirectory()) throw new Error(`fixture root must be a directory: ${root}`);
  const canonical = realpathSync(root);
  if (canonical !== resolve(root)) {
    throw new Error(`fixture root must be a canonical path (no symlink above it): ${root} resolves to ${canonical}`);
  }
  if (readdirSync(root).length > 0) throw new Error(`fixture root is not empty: ${root}`);
}

export function createControlFixture(options: ControlFixtureOptions = {}): ControlFixture {
  const owned = options.root === undefined;
  if (!owned && options.rootPrefix !== undefined) throw new Error("fixture takes root or rootPrefix, not both");
  if (!owned) assertEmptyCanonicalRoot(options.root!);
  // Canonical root: on macOS the temp dir is a symlink, and curation code
  // compares real paths.
  const root = owned ? realpathSync(mkdtempSync(join(tmpdir(), options.rootPrefix ?? "sil-control-"))) : options.root!;
  const home = join(root, "home");
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  const dataDir = join(root, "data");
  const claudeDir = join(root, "claude");
  const binDir = join(root, "bin");
  const gitConfig = join(root, "gitconfig");
  for (const dir of [home, configDir, stateDir, dataDir, claudeDir, binDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(gitConfig, "", "utf8");

  writeText(
    join(configDir, "config.yaml"),
    [
      "version: 1",
      "worlds:",
      `  - name: ${FIXTURE_WORLD}`,
      `    target: ${join(root, "target")}`,
      "worker:",
      "  auto_kick: false",
      "",
    ].join("\n"),
  );
  // An endpoint that would be the model path if anything reached for one. The
  // key env name is never set in the child env.
  writeText(
    join(configDir, "llm.yaml"),
    [
      "endpoints:",
      "  - name: fixture-cli",
      "    kind: claude-cli",
      "    models:",
      "      critic: fixture-model",
      "      drafter: fixture-model",
      "      judge: fixture-model",
      "active: fixture-cli",
      "",
    ].join("\n"),
  );

  const buckets: [keyof typeof FIXTURE_QUEUE, string[]][] = [
    ["pending", ["fixture-pending-1", "fixture-pending-2"]],
    ["done", ["fixture-done-1"]],
    ["failed", ["fixture-failed-1"]],
  ];
  for (const [bucket, ids] of buckets) {
    for (const id of ids) {
      writeText(join(stateDir, "queue", bucket, `${id}.json`), JSON.stringify(queueEntry(id), null, 2));
    }
  }
  writeText(
    join(stateDir, "worker-status.json"),
    JSON.stringify({
      last_run: FIXTURE_LAST_RUN,
      last_summary: { reflected: ["fixture-done-1"], failed: ["fixture-failed-1"], skipped: [], curriculum: {}, duration_s: 4.2 },
    }),
  );
  writeText(join(stateDir, "logs", "worker.log"), `first line\n${FIXTURE_LOG_LINE}\n`);

  const marker = join(root, FIXTURE_CLAUDE_MARKER);
  // Constant script text: no fixture path is ever interpolated into shell
  // syntax, so a root containing a quote cannot break it. The marker path
  // comes from the env; a provider that strips the env still lands in the
  // same file, found from the script's own location.
  writeText(join(binDir, "claude"), FAKE_CLAUDE_SCRIPT);
  chmodSync(join(binDir, "claude"), 0o755);

  const env: Record<string, string> = {
    HOME: home,
    PATH: [binDir, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    SIL_CONFIG_DIR: configDir,
    SIL_STATE_DIR: stateDir,
    SIL_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: claudeDir,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_SYSTEM: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    TMPDIR: join(root, "tmp"),
    [FIXTURE_CLAUDE_MARKER_ENV]: marker,
    NO_COLOR: "1",
    // Bun otherwise writes its transpiler cache under HOME, which would hide
    // a real write in a before/after inventory of the fixture root.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  mkdirSync(env["TMPDIR"]!, { recursive: true });

  return {
    root,
    env,
    cleanup: () => {
      if (owned) {
        rmSync(root, { recursive: true, force: true });
        return;
      }
      for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
    },
  };
}
