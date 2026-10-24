// The plugin's state contract, named in .claude-plugin/plugin.json as "types".
// `claude plugin validate` holds every $.state key the hooks module names to
// what is declared here. Self-contained on purpose: no import, no reference.
// apps/hook-module/src/ui/state.ts keeps its ConsoleUiState to this same shape,
// and a test fails to compile if the two drift apart.

/** One read's outcome, as the control bridge answers it. */
export type SilControlResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

/** The native console's view, under the stable key `console`. Written only
 * by the console's handlers and timer, never while it draws. */
export type SilConsoleState = {
  /** The world shown, or null while none is chosen. */
  world: string | null;
  section: "overview" | "review" | "artifacts" | "activity" | "settings";
  /** Moves on every change of what is read (world, section, list page,
   * proposal and its page), close, session end and reload; a reply tagged
   * with an older one is dropped. */
  generation: number;
  selectedPattern: string | null;
  loading: boolean;
  /** When a read last came back with every result ok; ISO 8601. */
  lastSuccessAt: string | null;
  /** The latest result per read id. */
  results: Record<string, SilControlResult>;
  /** Shown as an error; set, the results may be stale. */
  error: string | null;
  /** First item of the section's list page. */
  listOffset: number;
  /** The open proposal, set exactly when `selectedPattern` is. */
  proposal: SilProposalView | null;
  /** First item of the Activity section's lessons page. */
  lessonsOffset: number;
  /** First world the world switcher offers; moving it reads nothing. */
  worldOffset: number;
};

/** Which part and page of the open proposal is shown, the pages before it,
 * and the reviewed_state (64 hex) its first page was read at; every later
 * page is asked for at that digest. */
export type SilProposalView = {
  part: "body" | "diff";
  offset: number;
  back: number[];
  reviewedState: string | null;
};

/** The Lessons view inside Activity, under the key `lessons`. View settings,
 * the editor's opaque snapshot, and its trimmed restore export only when its
 * text passed the secret screen and the save limits. Never authority: a reload
 * imports it through the editor's own restore and reads the store again. */
export type SilLessonsState = {
  version: 1;
  /** Moves on every write, so a drawn pane redraws. */
  rev: number;
  open: boolean;
  world: string | null;
  filter: "saved" | "inbox" | "archived" | "important";
  /** Flat project value (`world`, `unresolved` or a `p1_` id), or null. */
  project: string | null;
  search: string;
  /** Opaque to every reader but the editor's own restore. */
  restore: { [key: string]: unknown } | null;
  /** Why `restore` is null although a draft exists. */
  withheld: "sensitive" | "size" | null;
  /** Opaque ids only, for the editor's own hydrate. */
  snapshot: { [key: string]: unknown } | null;
};

declare module "claude-code" {
  interface PluginState {
    "self-improvement-loop": { console: SilConsoleState; lessons: SilLessonsState };
  }
}
