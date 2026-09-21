// A stand-in for the engine object a hooks module receives, backed by node:fs
// over a temp dir. The module under test runs in a sandbox with no Node; this
// harness does not, which is the whole point: it can watch what the module asks
// for and answer with the same semantics the real engine has (a read that
// rejects on a missing file, a list that rejects on a missing directory).
//
// Every call is recorded in `calls`, so a test can assert on cost as well as on
// effect: "the nudge directory is read once per session" is a claim about the
// call log, not about the output.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface FakeFsEntry {
  name: string;
  kind: "file" | "dir" | "other";
  size: number;
  isLink: boolean;
}

export interface FakeFsStat {
  kind: "file" | "dir" | "other";
  size: number;
  mtimeMs: number;
  isLink: boolean;
}

export interface FakeRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FakeRunInit {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface FakeRunCall {
  argv: string[];
  init?: FakeRunInit;
}

export interface CannedRun {
  match: (argv: readonly string[]) => boolean;
  result: FakeRunResult;
}

/** Which calls reject instead of answering, for the "an internal step throws"
 * tests. `read` and `env` are the two levers that matter: a rejected read is
 * swallowed by the module's own wrappers and must only cost that one step,
 * while a rejected env.get takes the whole session state down. */
export interface FakeFailures {
  read?: boolean;
  write?: boolean;
  env?: boolean;
}

export interface FakeEngineOptions {
  sessionId: string;
  cwd: string;
  pluginRoot: string;
  env?: Record<string, string>;
  /** Commands run for real instead of answered from `runs`. Nothing is real by
   * default: a test that wants a process says so. */
  realCommands?: ReadonlyArray<"realpath" | "git" | "sh" | "kill">;
  runs?: CannedRun[];
  fail?: FakeFailures;
}

type Handler = ($: unknown, e: unknown, next: unknown) => unknown;

const MAX_READ_BYTES = 4 * 1024 * 1024;

function kindOf(path: string): "file" | "dir" | "other" {
  const st = statSync(path);
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "dir";
  return "other";
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export class FakeEngine {
  readonly calls: string[] = [];
  /** Calls that rejected. The real engine logs every one of these as an
   * `[ERROR] ... failed: ENOENT` line in `claude --debug`, so an optional file
   * the module knows might be absent has to be asked about before it is read. */
  readonly rejectedCalls: string[] = [];
  readonly runCalls: FakeRunCall[] = [];
  readonly nextArgs: unknown[] = [];
  readonly env: Record<string, string>;
  readonly handlers = new Map<string, Handler>();
  readonly $: unknown;
  readonly on: unknown;

  private readonly options: FakeEngineOptions;

  constructor(options: FakeEngineOptions) {
    this.options = options;
    this.env = { ...(options.env ?? {}) };

    const engine = {
      plugin: { name: "self-improvement-loop", root: options.pluginRoot },
      session: {
        id: async (): Promise<string> => {
          this.calls.push("session.id");
          return options.sessionId;
        },
        cwd: async (): Promise<string> => {
          this.calls.push("session.cwd");
          return options.cwd;
        },
      },
      env: {
        get: async (name: string): Promise<string | undefined> => {
          const call = `env.get ${name}`;
          this.calls.push(call);
          if (options.fail?.env) this.reject(call, "fake env.get failure");
          return Object.hasOwn(this.env, name) ? this.env[name] : undefined;
        },
        set: async (name: string, value: string | undefined): Promise<void> => {
          const call = `env.set ${name}=${value ?? ""}`;
          this.calls.push(call);
          if (options.fail?.env) this.reject(call, "fake env.set failure");
          if (value === undefined) delete this.env[name];
          else this.env[name] = value;
        },
      },
      fs: {
        read: async (path: string): Promise<string> => {
          const call = `fs.read ${path}`;
          this.calls.push(call);
          if (options.fail?.read) this.reject(call, "fake fs.read failure");
          if (!existsSync(path)) this.reject(call, `ENOENT: ${path}`);
          const st = statSync(path);
          if (st.isDirectory()) this.reject(call, `EISDIR: ${path}`);
          if (st.size > MAX_READ_BYTES) this.reject(call, `too large: ${path}`);
          return readFileSync(path, "utf8");
        },
        write: async (path: string, text: string): Promise<void> => {
          const call = `fs.write ${path}`;
          this.calls.push(call);
          if (options.fail?.write) this.reject(call, "fake fs.write failure");
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, text, "utf8");
        },
        list: async (path?: string): Promise<FakeFsEntry[]> => {
          const target = path ?? options.cwd;
          const call = `fs.list ${target}`;
          this.calls.push(call);
          if (!existsSync(target)) this.reject(call, `ENOENT: ${target}`);
          if (!statSync(target).isDirectory()) this.reject(call, `ENOTDIR: ${target}`);
          return readdirSync(target)
            .sort()
            .map((name) => {
              const child = `${target}/${name}`;
              const linked = isLink(child);
              let kind: "file" | "dir" | "other" = "other";
              let size = 0;
              try {
                kind = linked ? "other" : kindOf(child);
                size = statSync(child).size;
              } catch {
                // a dangling link lists as other with no size, same as the engine
              }
              return { name, kind, size, isLink: linked };
            });
        },
        exists: async (path: string): Promise<boolean> => {
          this.calls.push(`fs.exists ${path}`);
          return existsSync(path);
        },
        stat: async (path: string): Promise<FakeFsStat> => {
          const call = `fs.stat ${path}`;
          this.calls.push(call);
          if (!existsSync(path)) this.reject(call, `ENOENT: ${path}`);
          const st = statSync(path);
          return { kind: kindOf(path), size: st.size, mtimeMs: st.mtimeMs, isLink: isLink(path) };
        },
      },
      process: {
        run: async (argv: readonly string[], init?: FakeRunInit): Promise<FakeRunResult> => {
          this.calls.push(`process.run ${argv.join(" ")}`);
          this.runCalls.push({ argv: [...argv], ...(init === undefined ? {} : { init }) });
          return this.answerRun(argv, init);
        },
      },
      clock: {
        now: async (): Promise<number> => {
          this.calls.push("clock.now");
          return Date.now();
        },
      },
    };
    this.$ = engine;

    this.on = (event: string, handler: Handler): unknown => {
      this.handlers.set(event, handler);
      return { catch: () => undefined };
    };
  }

  /** Records a call the engine refuses, then rejects the way it does. */
  private reject(call: string, message: string): never {
    this.rejectedCalls.push(call);
    throw new Error(message);
  }

  private answerRun(argv: readonly string[], init?: FakeRunInit): FakeRunResult {
    for (const canned of this.options.runs ?? []) {
      if (canned.match(argv)) return canned.result;
    }
    const program = argv[0] ?? "";
    const real = this.options.realCommands ?? [];
    if (program && (real as readonly string[]).includes(program)) {
      const spawned = Bun.spawnSync(argv as string[], {
        ...(init?.cwd === undefined ? {} : { cwd: init.cwd }),
        env: { PATH: process.env["PATH"] ?? "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: spawned.exitCode ?? 1,
        stdout: spawned.stdout.toString(),
        stderr: spawned.stderr.toString(),
      };
    }
    // Unmatched: a non-zero exit with nothing on stdout, which every caller in
    // the module treats as "could not answer" and falls back from.
    return { exitCode: 127, stdout: "", stderr: `fake-engine: no canned result for ${program}` };
  }

  /** Runs the handler registered for `event`, with a `next` that resolves to
   * `coreResult`, and asserts next was called exactly once. `onNext` runs at the
   * moment the handler calls next, which is how a test sees what the module did
   * before handing the event on. Returning a promise from it holds the chain
   * open, which is how two overlapping events are driven. */
  async fire<T>(event: string, e: unknown, coreResult: T, onNext?: () => void | Promise<void>): Promise<T> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`fake-engine: nothing registered for ${event}`);
    let calls = 0;
    const next = (arg: unknown): Promise<T> => {
      calls++;
      this.calls.push(`next ${event}`);
      this.nextArgs.push(arg);
      return Promise.resolve(onNext ? onNext() : undefined).then(() => coreResult);
    };
    Object.defineProperty(next, "signal", { value: new AbortController().signal });
    const result = (await handler(this.$, e, next)) as T;
    if (calls !== 1) throw new Error(`fake-engine: ${event} called next ${calls} times, expected exactly 1`);
    return result;
  }

  /** How many times `needle` appears in the call log, for the once-per-session
   * assertions. */
  countCalls(needle: string): number {
    return this.calls.filter((c) => c.includes(needle)).length;
  }

  indexOfCall(needle: string): number {
    return this.calls.findIndex((c) => c.includes(needle));
  }
}
