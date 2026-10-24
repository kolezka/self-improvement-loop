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
// Verified against the contract written by Claude Code 2.1.278. The native
// console subset (session.start, session.end, command.run, ui.render,
// ui.close, $.command, $.ui, $.clock, $.state, and the Lessons view's Input
// and $.ui.selection) was checked against the one 2.1.308 writes:
// `bun run scripts/test-native.ts --types <generated claude-code.d.ts>` runs
// that second typecheck through apps/hook-module/tsconfig.native.json.

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
    /** True when stdout passed 4 MiB and `stdout` holds only the first part. */
    isStdoutTruncated: boolean;
    /** True when stderr passed 4 MiB and `stderr` holds only the first part. */
    isStderrTruncated: boolean;
  };

  /** `$`, the first parameter of every hook. The real interface carries every
   * noun the engine and the loaded plugins define; only the nouns this module
   * calls are declared. The classic hooks take timestamps from `Date`; only the
   * console's refresh uses `$.clock`. `$.fs.read` and `$.fs.stat` are
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
    command: {
      /** Adds `/<name>` for the session; answered by a `command.run` hook. */
      register: (command: CommandSpec) => Promise<unknown>;
    };
    /** Time and timers through the host. The console's refresh is the only
     * user: a timer's callback runs in the module, and a hot reload of the
     * module cancels its timers. */
    clock: {
      /** Milliseconds since the epoch. */
      now: () => Promise<number>;
      /** Calls `fn` every `ms` milliseconds until `cancel()`. */
      every: (ms: number, fn: () => void) => Timer;
    };
    ui: {
      /** Opens (or retitles) the pane `id`; its `ui.render` hook draws it. */
      open: (pane: PaneOpenArgs) => Promise<UiOpenResult>;
      /** This plugin's open panes, the engine's record (a reloaded module
       * finds its pane here). */
      panes: () => Promise<readonly UiPane[]>;
      /** Closes the pane `id`, raising `ui.close` (origin `plugin`). */
      close: (pane: { id: string }) => Promise<void>;
      /** The drawing surface's element table. The real one has many more. */
      resolve: (e: { surface: RenderSurface }) => Elements;
      /** One dim transcript line, not sent to the model. */
      log: (text: string, options?: { to?: "transcript" | "debug" }) => void;
      /** What the person last selected with the mouse; `undefined` with nothing
       * selected, or where none is seen (fullscreen off, -p, a surface that
       * answers none). Checked against the 2.1.308 contract. */
      selection: () => Promise<UiSelection | undefined>;
    };
    state: {
      /** A value never written reads `undefined` at version 0. `plugin` and
       * `key` must be literals in source. */
      get: <P extends keyof PluginState & string, K extends keyof PluginState[P] & string>(ref: {
        readonly plugin: P;
        readonly key: K;
      }) => Promise<{ value: PluginState[P][K] | undefined; version: number }>;
      /** Refused while a `ui.render` hook draws, and for another plugin's key. */
      set: <P extends keyof PluginState & string, K extends keyof PluginState[P] & string>(
        ref: { readonly plugin: P; readonly key: K },
        value: PluginState[P][K],
        options?: { ifVersion?: number },
      ) => Promise<{ isSet: boolean; version: number }>;
    };
  }

  /** Session values by plugin, then key. Empty here: the plugin's own contract
   * (types/index.d.ts at the repo root) merges its keys in. */
  export interface PluginState {}

  /** `$.command.register`'s argument. */
  export type CommandSpec = {
    name: string;
    description: string;
    argumentHint?: string;
    immediate?: true;
  };

  /** `$.ui.open`'s argument. */
  export type PaneOpenArgs = {
    id: string;
    title?: string;
    focus?: true;
  };

  /** Whether a surface draws the pane now, and if not, why it waits. */
  export type UiOpenResult = { isPlaced: true } | { isPlaced: false; reason: string };

  /** One open pane as `$.ui.panes()` lists it. `isPlaced` is false while it
   * waits undrawn; `isShown` is true for the one in front. */
  export type UiPane = {
    id: string;
    title: string;
    isShown: boolean;
    isFocused: boolean;
    isPlaced: boolean;
  };

  /** `$.ui.selection()`'s answer: the selected text as a copy would take it,
   * and the transcript row it lies in. `requestId` is absent when the
   * selection spans rows, lies outside the transcript (the prompt, a pane), or
   * has scrolled out of the rows the transcript keeps drawn. */
  export type UiSelection = {
    text: string;
    requestId?: string;
  };

  /** What `ui.input` hands an Input's handlers. The real argument carries the
   * plugin, element, component, request id and surface; the console reads none. */
  export type UiInputArgument = { readonly surface?: RenderSurface };

  /** A `$.clock` timer; a cancelled one never fires again. */
  export type Timer = { cancel: () => void };

  /** `ui.close`: which pane, and who closes it. Hooks do not run for an
   * `unload` close. */
  export type PaneCloseInput = {
    id: string;
    origin: { kind: "plugin" | "person" | "unload" };
  };

  /** What a `ui.close` hook's `next(e)` resolves to: `{ value }` once the
   * close went through, `{ deny }` when the chain beneath refused it. */
  export type CloseResult = { value: undefined; deny?: undefined } | { deny: string; value?: undefined };

  /** What `ui.press` hands a Button's `onPress`. The real argument carries
   * more; the console reads none of it. */
  export type UiPressArgument = { readonly surface?: RenderSurface };

  export type RenderSurface = "terminal" | "desktop" | "vscode" | "mobile";

  /** A drawn element, plain data. The real type is a union per element. */
  export type RenderElement = { readonly type: string; readonly props: Readonly<Record<string, unknown>> };
  export type RenderNode = RenderElement | string;
  export type RenderChildren = RenderNode | number | boolean | null | undefined | readonly RenderChildren[];

  /** The elements the console draws with, and only the props it sets.
   * `color` is a theme key (`"error"`) or a color string in the real type. */
  export type Elements = {
    Box: (props: {
      flexDirection?: "row" | "column";
      gap?: number;
      justifyContent?: "flex-start" | "center" | "flex-end" | "space-between" | "space-around" | "space-evenly";
      paddingX?: number;
      borderStyle?: string;
      children?: RenderChildren;
    }) => RenderElement;
    Text: (props: { bold?: boolean; dimColor?: boolean; color?: string; children?: RenderChildren }) => RenderElement;
    Button: (props: { key?: string; label?: string; variant?: "primary" | "secondary"; dimColor?: boolean; onPress: (e: UiPressArgument) => void }) => RenderElement;
    /** Source text the engine's highlighter draws; `format: "diff"` reads it
     * as unified-diff hunks. Tab and newline its only control characters. */
    Code: (props: { source: string; format?: "source" | "diff" }) => RenderElement;
    /** A text field, one line or `rows` lines. Terminal, desktop and VS Code
     * have it; mobile does not. Enter raises `onSubmit` with the whole text;
     * every change raises `onInput`. While focused it takes printable keys. */
    Input?: (props: {
      key: string;
      label?: string;
      placeholder?: string;
      value?: string;
      submitLabel?: string;
      rows?: number;
      autoFocus?: true;
      onInput?: (value: string, e: UiInputArgument) => void;
      onSubmit: (value: string, e: UiInputArgument) => void;
    }) => RenderElement;
    /** A one-of-several picker. Every surface but mobile has it. */
    Select?: (props: {
      key: string;
      label?: string;
      options: readonly { value: string; label?: string }[];
      value?: string;
      onSelect: (value: string, e: unknown) => void;
    }) => RenderElement;
  };

  /** The engine's own session start. */
  export type SessionStartInput = {
    cwd: string;
    surface: RenderSurface | null;
    isInteractive: boolean;
  };

  export type SessionStartResult = { cwd: string };

  /** One slash command about to run. The real input adds `origin` and
   * `presentation`, which the console never reads. */
  export type CommandRunInput = {
    command: string;
    args: string;
  };

  export type CommandRunResult = {
    text?: string;
    context?: readonly string[];
  };

  /** `ui.render` for a pane. The real input is a union per component. */
  export type PaneRenderInput = {
    surface: RenderSurface;
    component: "Pane";
    requestId: string;
    props: unknown;
    viewport?: { columns: number; rows: number };
  };

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

  /** What `on(...)` returns: the real type adds `.to`, `.is` and more, but the
   * module only ever calls `.catch`, the last-resort handler for a hook promise
   * that rejected (an unhandled `next(e)` rejection, since nothing inside the
   * handler itself may throw by this module's own convention). */
  export interface Registration {
    catch(handler: (error: unknown) => void): void;
  }

  /** Registration. The real `On` is generic over every event name, glob and
   * matcher and returns a `Registration` that takes one `.catch`; this lists
   * the six events the module registers. */
  export type On = {
    (event: "classic.SessionStart", hook: Hook<SessionStartHookInput, ClassicContextResult>): Registration;
    (event: "classic.UserPromptSubmit", hook: Hook<UserPromptSubmitHookInput, ClassicContextResult>): Registration;
    (event: "classic.PreToolUse", hook: Hook<ToolCallEnvelope, PreToolUseResult>): Registration;
    (event: "classic.PostToolUse", hook: Hook<PostToolUseHookInput, ClassicContextResult>): Registration;
    (event: "classic.Stop", hook: Hook<StopHookInput, ClassicContextResult>): Registration;
    (event: "classic.SessionEnd", hook: Hook<SessionEndHookInput, ClassicPlainResult>): Registration;
    (event: "session.end", hook: Hook<SessionEndInput, SessionEndResult>): unknown;
    (event: "ui.close", matcher: { readonly id: string }, hook: Hook<PaneCloseInput, CloseResult>): Registration;
    (event: "session.start", hook: Hook<SessionStartInput, SessionStartResult>): Registration;
    (event: "command.run", matcher: { readonly command: string }, hook: Hook<CommandRunInput, CommandRunResult>): Registration;
    (
      event: "ui.render",
      matcher: { readonly component: "Pane"; readonly requestId: string },
      hook: Hook<PaneRenderInput, RenderNode | null | undefined>,
    ): Registration;
  };

  /** The hooks module's entry point: `export const register: Register = ...`. */
  export type Register = (on: On, options: PluginOptions) => unknown;
}

// The globals a hooks module's JSX compiles against (classic runtime, factory
// `h`). The real contract declares them in `declare global`; the engine
// supplies them at run time, and test/fake-engine.ts stands in under Bun.
declare const h: (
  tag: (props: never) => import("claude-code").RenderNode | null | undefined,
  props: Record<string, unknown> | null | undefined,
  ...children: unknown[]
) => import("claude-code").RenderNode | null | undefined;
declare const Fragment: (props: { children?: import("claude-code").RenderNode[] }) => import("claude-code").RenderElement;
declare namespace JSX {
  type Element = import("claude-code").RenderElement;
  type ElementType = (props: never) => import("claude-code").RenderNode | null | undefined;
  interface IntrinsicElements {}
  interface ElementChildrenAttribute {
    children: unknown;
  }
  interface IntrinsicAttributes {
    key?: string;
  }
}
