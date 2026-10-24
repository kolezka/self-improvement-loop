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
  /** The engine's own flags for output past 4 MiB. A canned result that leaves
   * them out answers false, as an uncut stream does. */
  isStdoutTruncated?: boolean;
  isStderrTruncated?: boolean;
}

/** What `$.process.run` resolves with here: the canned or real result with both
 * truncation flags always present, the shape the 2.1.308 engine returns. */
export type FakeRunAnswer = Required<FakeRunResult>;

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
  /** Absent when `reject` is set. */
  result?: FakeRunResult;
  /** The call rejects with this message instead, as the engine's does when the
   * command cannot start or is still running at its timeout. */
  reject?: string;
  /** Answers from the call itself, possibly late: a promise the test holds is
   * how a slow bridge is driven. Takes precedence over `result`. */
  respond?: (init: FakeRunInit | undefined) => FakeRunResult | Promise<FakeRunResult>;
}

/** Runs every `$.process.run` for real, with an environment built only from
 * `env` plus the call's own `init.env`, never from this process's. */
export interface FakeRealRun {
  env: Record<string, string>;
}

/** Which calls reject instead of answering, for the "an internal step throws"
 * tests. `read` and `env` are the two levers that matter: a rejected read is
 * swallowed by the module's own wrappers and must only cost that one step,
 * while a rejected env.get takes the whole session state down. */
export interface FakeFailures {
  read?: boolean;
  write?: boolean;
  env?: boolean;
  /** `$.command.register` rejects, as a refused registration does. */
  commandRegister?: boolean;
  /** `$.ui.open` rejects. */
  uiOpen?: boolean;
  /** `$.session.cwd` rejects. */
  sessionCwd?: boolean;
  /** `$.state.get` and `$.state.set` reject. */
  state?: boolean;
  /** `$.state.get` alone rejects, with this message. */
  stateGetMessage?: string;
}

/** One pane as the fake `$.ui.panes()` lists it, the 2.1.308 UiPane shape. */
export interface FakePane {
  id: string;
  title: string;
  isShown: boolean;
  isFocused: boolean;
  isPlaced: boolean;
}

/** A `$.clock.every` or `$.clock.after` timer. Nothing fires on its own: a
 * test calls `tick()` to run every live periodic timer once. */
export interface FakeTimer {
  kind: "every" | "after";
  ms: number;
  fn: () => void;
  cancelled: boolean;
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
  /** Set, every process call spawns for real; `runs` and `realCommands` are
   * not consulted. */
  realRun?: FakeRealRun;
  fail?: FakeFailures;
  /** What `$.ui.open` answers: placed (default) or open but undrawn. */
  openPlaced?: boolean;
}

/** What `$.ui.selection()` answers: the 2.1.308 UiSelection, nothing, or a rejection. */
export type FakeSelection = { text: string; requestId?: string } | undefined | { reject: string };

type Handler = ($: unknown, e: unknown, next: unknown) => unknown;

/** One `on(...)` call as the module made it, matcher included. */
export interface FakeRegistration {
  event: string;
  matcher: Record<string, unknown> | undefined;
}

/** What the fake `$.ui.resolve(e)` constructors build: the same plain-data
 * shape the engine's do, `{ type, props }`, children among the props. */
export interface FakeElement {
  type: string;
  props: Record<string, unknown>;
}

/** The JSX factory the engine gives a hooks module, as a global: classic
 * runtime, `h(tag, props, ...children)`, children flattened onto the props
 * and the element built by the surface's constructor. Installed once, here,
 * because the module's TSX compiles to bare `h(...)` calls. */
function fakeH(tag: unknown, props: Record<string, unknown> | null | undefined, ...children: unknown[]): unknown {
  const flat = (children as unknown[]).flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true);
  const all: Record<string, unknown> = { ...(props ?? {}) };
  if (flat.length > 0) all.children = flat.length === 1 ? flat[0] : flat;
  if (typeof tag !== "function") throw new Error("fake h: a tag must be an element constructor");
  return (tag as (p: Record<string, unknown>) => unknown)(all);
}
const jsxGlobals = globalThis as unknown as Record<string, unknown>;
jsxGlobals.h ??= fakeH;
jsxGlobals.Fragment ??= (props: Record<string, unknown>) => ({ type: "Box", props: { flexDirection: "column", ...props } });

const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_RUN_OUTPUT_BYTES = 4 * 1024 * 1024;

function withFlags(result: FakeRunResult): FakeRunAnswer {
  return { isStdoutTruncated: false, isStderrTruncated: false, ...result };
}

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
  readonly registrations: FakeRegistration[] = [];
  /** Values written through `$.state.set`, keyed `plugin/key`. */
  readonly state = new Map<string, { value: unknown; version: number }>();
  /** Runs before each `$.state.set` lands, so a test can slip a competing
   * write in between a read and its compare-and-set. */
  beforeStateSet: ((id: string) => void) | null = null;
  /** Decides one `$.state.set` by its `plugin/key`: "throw" rejects as a
   * refused write does, "unset" answers `isSet: false`, null writes. */
  stateSetOutcome: ((id: string) => "throw" | "unset" | null) | null = null;
  /** While set, every `$.state` call waits for it: a stalled state store. */
  stateGate: Promise<void> | null = null;
  /** While true, each `$.clock.now()` waits in `heldClock` until a test calls it. */
  holdClock = false;
  readonly heldClock: Array<() => void> = [];
  /** Every `$.clock.every`/`after` the module asked for, cancelled or not. */
  readonly timers: FakeTimer[] = [];
  /** This plugin's open panes, as `$.ui.panes()` answers them. */
  panes: FakePane[] = [];
  /** What the next `$.ui.selection()` answers. */
  selection: FakeSelection = undefined;
  /** Every `$.store.set` value, so a test can prove none was made. */
  readonly storeWrites: Array<{ key: string; value: unknown }> = [];
  private readonly chains = new Map<string, Handler[]>();
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
          if (options.fail?.sessionCwd) this.reject("session.cwd", "fake session.cwd failure at /private/fake/path");
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
        run: async (argv: readonly string[], init?: FakeRunInit): Promise<FakeRunAnswer> => {
          const call = `process.run ${argv.join(" ")}`;
          this.calls.push(call);
          this.runCalls.push({ argv: [...argv], ...(init === undefined ? {} : { init }) });
          if (options.realRun) return this.spawnReal(argv, init, options.realRun);
          const answer = this.answerRun(argv, init);
          if ("reject" in answer) this.reject(call, answer.reject);
          if ("pending" in answer) return withFlags(await answer.pending);
          return answer;
        },
      },
      clock: {
        now: async (): Promise<number> => {
          this.calls.push("clock.now");
          if (this.holdClock) await new Promise<void>((resolve) => this.heldClock.push(resolve));
          return Date.now();
        },
        every: (ms: number, fn: () => void): { cancel: () => void } => {
          this.calls.push(`clock.every ${ms}`);
          const timer: FakeTimer = { kind: "every", ms, fn, cancelled: false };
          this.timers.push(timer);
          return { cancel: () => void (timer.cancelled = true) };
        },
        after: (ms: number, fn: () => void): { cancel: () => void } => {
          this.calls.push(`clock.after ${ms}`);
          const timer: FakeTimer = { kind: "after", ms, fn, cancelled: false };
          this.timers.push(timer);
          return { cancel: () => void (timer.cancelled = true) };
        },
      },
      command: {
        register: async (spec: { name: string; description: string }): Promise<{ command: string }> => {
          const call = `command.register ${spec.name}`;
          this.calls.push(call);
          if (options.fail?.commandRegister) this.reject(call, "fake command.register refusal");
          return { command: spec.name };
        },
      },
      ui: {
        open: async (pane: { id: string; title?: string }): Promise<{ isPlaced: boolean }> => {
          const call = `ui.open ${pane.id}`;
          this.calls.push(call);
          if (options.fail?.uiOpen) this.reject(call, "fake ui.open refusal");
          const isPlaced = options.openPlaced ?? true;
          const open = this.panes.find((p) => p.id === pane.id);
          if (open) open.title = pane.title ?? open.title;
          else this.panes.push({ id: pane.id, title: pane.title ?? pane.id, isShown: isPlaced, isFocused: false, isPlaced });
          return isPlaced ? { isPlaced: true } : ({ isPlaced: false, reason: "fake: no surface places panes" } as never);
        },
        panes: async (): Promise<FakePane[]> => {
          this.calls.push("ui.panes");
          return this.panes.map((p) => ({ ...p }));
        },
        log: (text: string): void => {
          this.calls.push(`ui.log ${text}`);
        },
        selection: async (): Promise<{ text: string; requestId?: string } | undefined> => {
          this.calls.push("ui.selection");
          const s = this.selection;
          if (s !== undefined && "reject" in s) this.reject("ui.selection", s.reject);
          return s === undefined ? undefined : { ...(s as { text: string; requestId?: string }) };
        },
        resolve: (e: { surface: string }): Record<string, (props: Record<string, unknown>) => FakeElement> => {
          this.calls.push(`ui.resolve ${e.surface}`);
          const element = (type: string) => (props: Record<string, unknown>) => ({ type, props: { ...props } });
          const table: Record<string, (props: Record<string, unknown>) => FakeElement> = {
            Box: element("Box"),
            Text: element("Text"),
            Button: element("Button"),
            Code: element("Code"),
          };
          // As the real tables: every surface but mobile has a Select.
          if (e.surface !== "mobile") table.Select = element("Select");
          // Input likewise (terminal, desktop and VS Code in 2.1.308).
          if (e.surface !== "mobile") table.Input = element("Input");
          return table;
        },
      },
      store: {
        get: async (key: string): Promise<unknown> => {
          this.calls.push(`store.get ${key}`);
          return undefined;
        },
        set: async (key: string, value: unknown): Promise<void> => {
          this.calls.push(`store.set ${key}`);
          this.storeWrites.push({ key, value: JSON.parse(JSON.stringify(value)) });
        },
      },
      state: {
        get: async (ref: { plugin: string; key: string }): Promise<{ value: unknown; version: number }> => {
          this.calls.push(`state.get ${ref.plugin}/${ref.key}`);
          if (this.stateGate) await this.stateGate;
          if (this.options.fail?.state) this.reject(`state.get ${ref.plugin}/${ref.key}`, "fake state.get failure");
          if (this.options.fail?.stateGetMessage !== undefined) this.reject(`state.get ${ref.plugin}/${ref.key}`, this.options.fail.stateGetMessage);
          return this.state.get(`${ref.plugin}/${ref.key}`) ?? { value: undefined, version: 0 };
        },
        set: async (
          ref: { plugin: string; key: string },
          value: unknown,
          options?: { ifVersion?: number },
        ): Promise<{ isSet: boolean; version: number }> => {
          const id = `${ref.plugin}/${ref.key}`;
          this.calls.push(`state.set ${id}`);
          if (this.stateGate) await this.stateGate;
          if (this.options.fail?.state) this.reject(`state.set ${id}`, "fake state.set failure");
          this.beforeStateSet?.(id);
          const outcome = this.stateSetOutcome?.(id) ?? null;
          if (outcome === "throw") this.reject(`state.set ${id}`, "fake state.set refusal");
          if (outcome === "unset") return { isSet: false, version: this.state.get(id)?.version ?? 0 };
          const current = this.state.get(id)?.version ?? 0;
          if (options?.ifVersion !== undefined && options.ifVersion !== current) return { isSet: false, version: current };
          // JSON data only, read back as the engine does.
          this.state.set(id, { value: JSON.parse(JSON.stringify(value)), version: current + 1 });
          return { isSet: true, version: current + 1 };
        },
      },
    };
    this.$ = engine;

    // `on(event, hook)` or `on(event, matcher, hook)`, as the engine takes it.
    this.on = (event: string, matcherOrHandler: unknown, maybeHandler?: Handler): unknown => {
      const handler = (typeof matcherOrHandler === "function" ? matcherOrHandler : maybeHandler) as Handler;
      const matcher = typeof matcherOrHandler === "function" ? undefined : (matcherOrHandler as Record<string, unknown>);
      this.registrations.push({ event, matcher });
      this.handlers.set(event, handler);
      this.chains.set(event, [...(this.chains.get(event) ?? []), handler]);
      return { catch: () => undefined };
    };
  }

  /** Every hook registered for `event`, composed in registration order: each
   * one's `next` runs the one registered after it, the last one's the core. */
  private chained(event: string): Handler | undefined {
    const chain = this.chains.get(event) ?? [];
    if (chain.length === 0) return undefined;
    return chain.reduceRight<Handler>(
      (inner, hook) => ($, e, next) => {
        const down = (arg: unknown) => inner($, arg, next) as Promise<unknown>;
        Object.defineProperty(down, "signal", { value: (next as { signal: AbortSignal }).signal });
        return hook($, e, down);
      },
      (_$, e, next) => (next as (arg: unknown) => unknown)(e),
    );
  }

  /** Runs every live `$.clock.every` timer once, as one period passing. */
  tick(): void {
    for (const timer of this.timers) if (timer.kind === "every" && !timer.cancelled) timer.fn();
  }

  /** The periodic timers not cancelled. */
  liveTimers(): FakeTimer[] {
    return this.timers.filter((t) => t.kind === "every" && !t.cancelled);
  }

  /** Records a call the engine refuses, then rejects the way it does. */
  private reject(call: string, message: string): never {
    this.rejectedCalls.push(call);
    throw new Error(message);
  }

  private answerRun(
    argv: readonly string[],
    init?: FakeRunInit,
  ): FakeRunAnswer | { reject: string } | { pending: Promise<FakeRunResult> } {
    for (const canned of this.options.runs ?? []) {
      if (!canned.match(argv)) continue;
      if (canned.reject !== undefined) return { reject: canned.reject };
      if (canned.respond) return { pending: Promise.resolve(canned.respond(init)) };
      if (!canned.result) throw new Error("fake-engine: a canned run needs a result or a reject");
      return withFlags(canned.result);
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
      return withFlags({
        exitCode: spawned.exitCode ?? 1,
        stdout: spawned.stdout.toString(),
        stderr: spawned.stderr.toString(),
      });
    }
    // Unmatched: a non-zero exit with nothing on stdout, which every caller in
    // the module treats as "could not answer" and falls back from.
    return withFlags({ exitCode: 127, stdout: "", stderr: `fake-engine: no canned result for ${program}` });
  }

  /** A real child under the engine's rules: argv only, stdin written then
   * closed, the call's env over the given base, killed and rejected at its
   * timeout (30 s default), each stream cut at 4 MiB with its flag set. */
  private async spawnReal(argv: readonly string[], init: FakeRunInit | undefined, real: FakeRealRun): Promise<FakeRunAnswer> {
    const call = `process.run ${argv.join(" ")}`;
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([...argv], {
        cwd: init?.cwd ?? this.options.cwd,
        env: { ...real.env, ...(init?.env ?? {}) },
        stdin: init?.stdin === undefined ? "ignore" : new TextEncoder().encode(init.stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      this.reject(call, `could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    const timeoutMs = init?.timeoutMs ?? 30_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout as ReadableStream<Uint8Array>).arrayBuffer(),
        new Response(child.stderr as ReadableStream<Uint8Array>).arrayBuffer(),
        child.exited,
      ]);
      if (timedOut) this.reject(call, `timed out after ${timeoutMs} ms`);
      const cut = (bytes: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(bytes).subarray(0, MAX_RUN_OUTPUT_BYTES));
      return {
        exitCode: exitCode === null || child.signalCode ? 1 : exitCode,
        stdout: cut(stdout),
        stderr: cut(stderr),
        isStdoutTruncated: stdout.byteLength > MAX_RUN_OUTPUT_BYTES,
        isStderrTruncated: stderr.byteLength > MAX_RUN_OUTPUT_BYTES,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs the handler registered for `event`, with a `next` that resolves to
   * `coreResult`, and asserts next was called exactly once. `onNext` runs at the
   * moment the handler calls next, which is how a test sees what the module did
   * before handing the event on. Returning a promise from it holds the chain
   * open, which is how two overlapping events are driven. */
  async fire<T>(event: string, e: unknown, coreResult: T, onNext?: () => void | Promise<void>): Promise<T> {
    const handler = this.chained(event);
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

  /** Runs the handler registered for `event` for a hook that answers for
   * itself, and asserts it never called next: a command the module owns has
   * nothing beneath it to run. */
  async answer<T>(event: string, e: unknown): Promise<T> {
    const handler = this.chained(event);
    if (!handler) throw new Error(`fake-engine: nothing registered for ${event}`);
    let calls = 0;
    const next = (arg: unknown): Promise<unknown> => {
      calls++;
      this.nextArgs.push(arg);
      return Promise.resolve({});
    };
    Object.defineProperty(next, "signal", { value: new AbortController().signal });
    const result = (await handler(this.$, e, next)) as T;
    if (calls !== 0) throw new Error(`fake-engine: ${event} called next ${calls} times, expected none`);
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
