// Hand-kept SUBSET of the `claude-code` contract that Claude Code's
// `/plugin-types` command writes, narrowed to what apps/hook-module actually
// registers and calls. Function hooks are early access: the real contract is
// 473 KB and changes between releases, so it is not vendored here.
//
// To diff this subset against the real thing: run `/plugin-types` in Claude
// Code (it writes claude-code.d.ts plus claude-code-mcp.d.ts and
// claude-code-plugins.d.ts into .claude/types), then typecheck the module
// against the generated file INSTEAD of this one:
//
//   cat > /tmp/fh-tsconfig.json <<'JSON'
//   { "compilerOptions": { "target": "ESNext", "module": "ESNext",
//       "moduleResolution": "bundler", "lib": ["ESNext", "DOM"], "types": [],
//       "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
//       "skipLibCheck": true, "allowImportingTsExtensions": true,
//       "verbatimModuleSyntax": true, "isolatedModules": true },
//     "files": ["<path to generated>/claude-code.d.ts"],
//     "include": ["<repo>/apps/hook-module/src/**/*.ts"] }
//   JSON
//   bun x tsc -p /tmp/fh-tsconfig.json --noEmit
//
// Both must pass. Anything this file declares more loosely than the real
// contract (an `unknown` where the generated file has a union, a single
// signature where it has overloads) is a place the module could compile here
// and fail there, which is exactly what that second run catches.
//
// Verified against the contract written by Claude Code 2.1.278.

declare module "claude-code" {
  /** A plugin's configuration, fixed for one activation. */
  export type PluginOptions = Readonly<Record<string, string | number | boolean | readonly string[]>>;

  /** `T` read-only to every depth: how a hook's `e` is typed. */
  export type Frozen<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends readonly unknown[]
      ? { [K in keyof T]: Frozen<T[K]> }
      : T extends object
        ? { readonly [K in keyof T]: Frozen<T[K]> }
        : T;

  /** One entry of `$.fs.list`. */
  export type FsEntry = {
    name: string;
    kind: "file" | "dir" | "other";
    size: number;
    isLink: boolean;
  };

  /** What `$.fs.stat` resolves with. The real contract adds an optional
   * `realPath` under `{ resolve: true }`, which this module never asks for. */
  export type FsStat = {
    kind: "file" | "dir" | "other";
    size: number;
    mtimeMs: number;
    isLink: boolean;
  };

  /** Options of `$.process.run`. */
  export type ProcessRunInit = {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
  };

  /** What `$.process.run` resolves with once the child has exited. */
  export type ProcessRunResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
  };

  /** `$`, the first parameter of every hook. The real interface carries every
   * noun the engine and the loaded plugins define; only the five this module
   * calls are declared. Timestamps come from `Date`, a web global the sandbox
   * has, so `$.clock` is not among them. `$.fs.read` and `$.fs.stat` are
   * overloaded there (`{ as: "bytes" }`, `{ resolve: true }`); the plain form is
   * all we use. */
  export interface EngineInterface {
    plugin: {
      name: string;
      root: string;
    };
    session: {
      id: () => Promise<string>;
      cwd: () => Promise<string>;
    };
    env: {
      get: (name: string) => Promise<string | undefined>;
      set: (name: string, value: string | undefined) => Promise<void>;
    };
    fs: {
      /** Rejects when the file is missing or over 4 MiB. */
      read: (path: string) => Promise<string>;
      /** Whole file, parent directories created as needed. */
      write: (path: string, text: string) => Promise<void>;
      /** Rejects when the directory is missing. */
      list: (path?: string) => Promise<FsEntry[]>;
      exists: (path: string) => Promise<boolean>;
      /** Rejects when the path is missing. */
      stat: (path: string) => Promise<FsStat>;
    };
    process: {
      /** argv only, no shell of its own; waits for exit, 30 s by default. */
      run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>;
    };
  }

  /** The fields every classic hook receives on stdin. */
  type BaseHookInput = {
    session_id: string;
    transcript_path: string;
    cwd: string;
    prompt_id?: string;
    permission_mode?: string;
    agent_id?: string;
    agent_type?: string;
  };

  export type SessionStartHookInput = BaseHookInput & {
    hook_event_name: "SessionStart";
    source: "startup" | "resume" | "clear" | "compact" | "fork";
  };

  export type UserPromptSubmitHookInput = BaseHookInput & {
    hook_event_name: "UserPromptSubmit";
    prompt: string;
  };

  export type PostToolUseHookInput = BaseHookInput & {
    hook_event_name: "PostToolUse";
    tool_name: string;
    tool_input: unknown;
    tool_response: unknown;
    tool_use_id: string;
    duration_ms?: number;
  };

  export type StopHookInput = BaseHookInput & {
    hook_event_name: "Stop";
    stop_hook_active: boolean;
    last_assistant_message?: string;
  };

  export type SessionEndHookInput = BaseHookInput & {
    hook_event_name: "SessionEnd";
    reason: string;
  };

  /** The `e` of `classic.PreToolUse`: NOT the stdin payload. The tool call
   * envelope, `tool` plus the tool's own input fields flattened (plus
   * `agentId` inside a subagent). The real contract makes this a union, one
   * variant per declared tool, each with its own argument fields and no index
   * signature; the module reads `tool` and `tool_use_id` by name and the rest
   * through Object.entries, which both shapes allow. */
  export type ToolCallEnvelope = {
    tool: string;
    tool_use_id: string;
    [argument: string]: unknown;
  };

  /** The input of the engine's own `session.end` event. */
  export type SessionEndInput = {
    reason: string;
    sessionId: string;
  };

  /** What a `session.end` hook returns and what `next(e)` resolves to. */
  export type SessionEndResult = {
    sessionId: string;
  };

  /** The subset of a classic result this module reads: what every classic
   * event carries, plus the injected context. The real per-event result types
   * add fields this module never sets (SessionStart's `initialUserMessage`,
   * PostToolUse's `updatedToolOutput`, ...); returning a copy of what `next`
   * resolved to carries them through untouched. */
  export type ClassicContextResult = {
    block?: string;
    preventContinuation?: true;
    stopReason?: string;
    additionalContext?: string[];
  };

  /** SessionEnd reads no `hookSpecificOutput` field at all. */
  export type ClassicPlainResult = {
    block?: string;
    preventContinuation?: true;
    stopReason?: string;
  };

  /** What a `classic.PreToolUse` hook returns. The real contract spells the
   * three decisions as an exclusive union; this flattens them, so a value that
   * compiles here may still be refused there. `next(e)`'s result is returned
   * with only `additionalContext` changed, which holds under either. */
  export type PreToolUseResult = {
    allow?: true;
    ask?: string;
    deny?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string[];
  };

  /** The continuation: the rest of the chain, resolving to the event's result.
   * The real type adds `.to`, `.is`, `.event`, `.origin`, `.trace` and
   * `.budget`; only `signal` is declared, and the module calls `next(e)`. */
  export type Next<E, R> = {
    (e: E): Promise<R>;
    readonly signal: AbortSignal;
  };

  /** A non-streaming hook: `($, e, next) => result`. */
  export type Hook<E, R> = ($: EngineInterface, e: Frozen<E>, next: Next<E, R>) => R | Promise<R>;

  /** Registration. The real `On` is generic over every event name, glob and
   * matcher and returns a `Registration` that takes one `.catch`; this lists
   * the six events the module registers and drops the return value. */
  export type On = {
    (event: "classic.SessionStart", hook: Hook<SessionStartHookInput, ClassicContextResult>): unknown;
    (event: "classic.UserPromptSubmit", hook: Hook<UserPromptSubmitHookInput, ClassicContextResult>): unknown;
    (event: "classic.PreToolUse", hook: Hook<ToolCallEnvelope, PreToolUseResult>): unknown;
    (event: "classic.PostToolUse", hook: Hook<PostToolUseHookInput, ClassicContextResult>): unknown;
    (event: "classic.Stop", hook: Hook<StopHookInput, ClassicContextResult>): unknown;
    (event: "classic.SessionEnd", hook: Hook<SessionEndHookInput, ClassicPlainResult>): unknown;
    (event: "session.end", hook: Hook<SessionEndInput, SessionEndResult>): unknown;
  };

  /** The hooks module's entry point: `export const register: Register = ...`. */
  export type Register = (on: On, options: PluginOptions) => unknown;
}
