# Native `/sil` Console Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the native `/sil` pane a padded card layout, Activity sub-tabs, slash-command action buttons and per-artifact votes.

**Architecture:** The pure view model in `views.ts` gains a `card` block that wraps other blocks; `render.tsx` draws a card as a round-bordered `Box`. Console state (`state.ts`) gains the Activity sub-tab and one command note. Buttons that run plugin commands go through `consoleAct` in `register.ts`, which calls `$.command.run` and records only "queued" or the rejection.

**Tech Stack:** Bun 1.4.2 (pinned in `.bun-version`), TypeScript, Claude Code Mods hooks module (`apps/hook-module`), host types 2.1.308.

**Spec:** `docs/superpowers/specs/2026-10-24-sil-console-layout-design.md`

## Global Constraints

- Draw only with host elements: `Box` (`padding*`, `margin*`, `gap`, `borderStyle`, `borderColor`), `Text`, `Button` (`variant`, `dimColor`, `plain`, Text children), `Select`, `Code`. A card title is the first line inside the card.
- Narrow layout: under `NARROW_COLUMNS` (44) body columns cards have no border and keep the gap; existing Selects stay.
- `finishView` and `enforceDisplayBudget` stay the single boundary for drawn text; `DISPLAY_BUDGET` stays 90000 and counts card titles and meta.
- No change to `consoleReads`: the pane reads exactly what it reads today.
- Review stays read only. No accept, reject, revise or settings controls.
- Commands run only through `$.command.run`; the pane says "queued", never "done".
- World-scoped actions (votes, Preview promotion) only when the pane shows the session's world (`ConsoleBootstrap.selectedWorld`, no `resolutionError`).
- Bundle under `MAX_HOOK_MODULE_BYTES` (320 KiB); no `node:` imports in the module.
- No em or en dashes anywhere (`bun run lint:dashes`). `Object.hasOwn`, never `in`, for keyed lookups.
- Every message drawn today is still drawn somewhere after the change.

## Review Focus

1. A v1.2.9 saved console state (no `activityTab`, no `commandNote`) restored after upgrade or hot reload: the person keeps world, section and proposal, with no "unreadable and was reset" error. Pinned in Task 3.
2. An artifact row whose `artifact_type` or `pattern` holds spaces, uppercase or control characters: no vote buttons, and no command string is ever built from it. Pinned in Task 4.
3. `$.command.run` that rejects, or never settles: the pane stays usable, a rejection shows in red, a pending run keeps "queued". Pinned in Task 4.
4. A display-budget cut that lands inside a card: the notice is kept and nothing is cut silently. Pinned in Task 1.
5. A narrow pane (40 columns) on every tab: no card border, no button row wider than the pane. Pinned in Task 1 (cards) and Task 2 (header).

---

## File Structure

- `apps/hook-module/src/ui/views.ts`: `card` block, `shortTime`, section cards, header and footer, Activity sub-tabs, Actions card, vote buttons.
- `apps/hook-module/src/ui/state.ts`: `activityTab`, `commandNote`, their transitions and the saved-state migration.
- `apps/hook-module/src/ui/render.tsx`: draws cards, header tabs, footer; draws Lessons only under the Lessons sub-tab.
- `apps/hook-module/src/ui/register.ts`: `consoleAct` cases `activity-tab` and `command`.
- `apps/hook-module/test/fake-engine.ts`: `command.run`.
- Tests: `apps/hook-module/test/ui-views.test.ts`, `ui-state.test.ts`, new `ui-actions.test.ts`; native kit `native-test/views.native.tsx`, `pane.native.tsx`.
- Docs: `docs/INSTALL.md` (Native console section).

---

### Task 1: Card blocks and the drawing frame

**Files:**
- Modify: `apps/hook-module/src/ui/views.ts` (`ConsoleBlock`, `blockChars`, `enforceDisplayBudget`, `finishView`)
- Modify: `apps/hook-module/src/ui/render.tsx` (`blockOf`, outer `Box`)
- Test: `apps/hook-module/test/ui-views.test.ts`, `apps/hook-module/native-test/views.native.tsx`

**Interfaces:**
- Produces:
  ```ts
  // views.ts
  export type ConsoleBlock =
    | ...existing kinds
    | { kind: "card"; key: string; title: string; meta?: string; blocks: ConsoleBlock[] };
  export function card(key: string, title: string, blocks: ConsoleBlock[], meta?: string): ConsoleBlock;
  /** Every block of the tree, cards opened, in drawing order. */
  export function flattenBlocks(blocks: ConsoleBlock[]): ConsoleBlock[];
  ```
- `blockChars` of a card is `title.length + (meta?.length ?? 0)` plus its children's.

- [ ] **Step 1: Write failing tests** in a new `describe("cards")` block of `ui-views.test.ts`:
  - `"a card counts its title, meta and children toward the budget"`: `blockChars(card("k", "Worker", [{ kind: "line", line: { text: "abc", tone: "plain" } }], "global"))` equals `6 + 6 + 3`.
  - `"finishView makes card titles and children printable"`: a card titled `"a\u001bb"` with a child line `"x\u0007"` comes out as `"a␛b"` and `"x␇"`, and the `"2 control characters are shown as symbols."` note is present.
  - `"a budget cut inside a card keeps the notice"`: `enforceDisplayBudget([card("big", "List", 50 lines of 2000 chars)], 30000)` returns blocks whose `flattenBlocks` ends with a line matching `/more items are not shown: the pane's display budget is full\.$/`, and whose total `blockChars` is at most 30000.
  - `"a cut card keeps its title"`: in the same case the first block is still a card titled `"List"`.
- [ ] **Step 2: Run** `bun test apps/hook-module/test/ui-views.test.ts`. Expected: FAIL, `card` is not exported.
- [ ] **Step 3: Implement** `card`, `flattenBlocks`, the `card` case in `blockChars` and `finishView`, and card-aware `enforceDisplayBudget`: walk blocks in order, descend into cards, keep a card with the children that fit, drop the rest, append the existing notice once at top level. The code-page replacement rule applies inside cards too.
- [ ] **Step 4: Draw cards in `render.tsx`.** `blockOf` for a card returns a column `Box` with `borderStyle="round"`, `paddingX={1}` when `bodyColumns(e.props) >= NARROW_COLUMNS`, and no border below that. Its first child is a row `Box` with `<Text bold>{title}</Text>` and, when `meta` is set, `<Text dimColor>{meta}</Text>`, `justifyContent="space-between"`. The outer `Box` becomes `flexDirection="column" paddingX={1} gap={1}`.
- [ ] **Step 5: Native test** in `views.native.tsx`: render a tree with one card at 80 and at 40 columns; assert the 80-column frame contains `╭` and the card title, and the 40-column frame contains the title and no `╭`.
- [ ] **Step 6: Run** `bun test apps/hook-module/test/ui-views.test.ts` and `bun run scripts/test-native.ts`. Expected: PASS, exit 0.
- [ ] **Step 7: Commit** `feat: draw console blocks inside cards`.

### Task 2: Header, footer, short times and section cards

**Files:**
- Modify: `apps/hook-module/src/ui/views.ts` (`consoleLines`, `navigation`, `consoleView`, `overview`/`review`/`artifacts`/`settings` builders, `ConsoleLayout`)
- Modify: `apps/hook-module/src/ui/render.tsx` (tab buttons)
- Test: `apps/hook-module/test/ui-views.test.ts`, `native-test/views.native.tsx`

**Interfaces:**
- Consumes: `card`, `flattenBlocks` (Task 1).
- Produces:
  ```ts
  export interface ConsoleLayout { columns: number; canSelect: boolean; now: Date }
  /** "15:33" when `iso` is on `now`'s local day, "Oct 22 15:33" otherwise, `iso` unchanged when unparseable. */
  export function shortTime(iso: string, now: Date): string;
  export interface ConsoleControl { key: string; label: string; action: ConsoleAction; isCurrent: boolean; tone?: "primary" | "dim" }
  ```
- `render.tsx` passes `now: new Date()`.

- [ ] **Step 1: Write failing tests**:
  - `"shortTime"`: with `now = new Date(2026, 9, 24, 17, 0)`, a local 15:33 that day gives `"15:33"`, Oct 22 15:33 gives `"Oct 22 15:33"`, and `"not a date"` stays `"not a date"`.
  - `"the header is title and world, then tabs; no World or Section lines"`: `flattenBlocks(consoleView(state, wide))` has no line starting `"World: "` or `"Section: "`; the tab controls carry `tone: "primary"` on the current section and `"dim"` on the rest, and no label ends with `CURRENT_MARK`.
  - `"Refresh and Close are the last controls, after a line with the refresh time"`: the last block is `controls` with keys `["refresh", "close"]`; the line before it reads `"refreshed 15:36 · every 10 s"` for `lastSuccessAt` at local 15:36 that day.
  - `"each section's content is in cards"`: Overview has cards titled `"Worker"` and `"Review"`; Review has `"Staged proposals"` and, with a proposal open, a card titled with its pattern; Artifacts has `"Artifacts"`; Settings has `"Settings"`.
  - `"no message is lost"`: for each fixture state already used in this file (stale error, unread lists, odd shapes, oversized line, changed proposal), the set of line texts in `flattenBlocks` of the new view contains every line text the old view produced except `"World: ..."`, `"Section: ..."` and `"Last complete refresh: ..."`, which the header and footer replace. Build the expected sets from the current `consoleView` output before changing it and keep them as literals in the test.
  - `"narrow keeps the Selects"`: at 40 columns with `canSelect`, the section and world Selects are still present.
- [ ] **Step 2: Run** `bun test apps/hook-module/test/ui-views.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Title row: `"Self-improvement loop"` and the world control (Select narrow, buttons wide). Tab row from `consoleControls().sections` with `tone`. Status lines (`Refreshing...`, errors, stale, world-list and resolution errors) stay right under the header, ungrouped. Overview's worker and review lines move into cards titled `"Worker"` (meta `"global, all worlds"`) and `"Review"` (meta the world). Footer: the refresh-time line, then `controls("actions", [refresh, close])`. Every timestamp the pane draws goes through `shortTime`: worker `last run`, the footer, reflection `created`, queue `last stop`. Add a `"timestamps are short everywhere"` assertion: no drawn line matches `/\d{4}-\d{2}-\d{2}T/` for fixtures whose times parse.
- [ ] **Step 4: Render tones.** `buttonOf` draws `tone: "primary"` as `variant="primary"`, `tone: "dim"` as `dimColor`, and drops the `CURRENT_MARK` suffix when `tone` is set. Keep `CURRENT_MARK` for controls without a tone.
- [ ] **Step 5: Native test**: wide pane frame shows the title and `Overview` on different lines and `Refresh` below the last card.
- [ ] **Step 6: Run** the view tests, `bun run typecheck`, `bun run scripts/test-native.ts`. Expected: PASS.
- [ ] **Step 7: Commit** `feat: give the console a header, footer and section cards`.

### Task 3: Activity sub-tabs

**Files:**
- Modify: `apps/hook-module/src/ui/state.ts`, `views.ts` (`activitySection`, `ConsoleAction`), `register.ts` (`consoleAct`), `render.tsx` (Lessons)
- Modify: `types/index.d.ts` only if it types the saved console state
- Test: `apps/hook-module/test/ui-state.test.ts`, `ui-views.test.ts`, `native-test/pane.native.tsx`

**Interfaces:**
- Consumes: `card` (Task 1), section layout (Task 2).
- Produces:
  ```ts
  // state.ts
  export const ACTIVITY_TABS = ["queue", "reflections", "lessons", "log"] as const;
  export type ActivityTab = (typeof ACTIVITY_TABS)[number];
  // ConsoleUiState gains: activityTab: ActivityTab  (initial "queue")
  export function setActivityTab(state: ConsoleUiState, tab: ActivityTab): ConsoleUiState; // no rescope, no read
  // views.ts
  // ConsoleAction gains: | { kind: "activity-tab"; tab: ActivityTab }
  ```
- `commandNote` (Task 4) joins `STATE_KEYS` there; this task adds only `activityTab`.

- [ ] **Step 1: Write failing tests** in `ui-state.test.ts`:
  - `"the v1.2.9 saved shape migrates with Queue chosen"`: a valid object with exactly today's `STATE_KEYS` parses with `reset: "migrated"`, the same world, section, selection and offsets, and `activityTab: "queue"`.
  - `"a saved activityTab outside ACTIVITY_TABS resets as corrupt"`.
  - `"setActivityTab keeps generation and results"`.
- [ ] **Step 2: Write failing view tests**: Activity draws the `"Worker"` card, then a `controls` block keyed `"activity-tabs"` with `Queue`, `Reflections`, `Lessons`, `Log` (current one `tone: "primary"`), then only the chosen part's card: `"Queue"`, `"Reflections"`, `"Lesson inbox"` (the existing `lessons` list) or `"Worker log"`. Every line the old Activity drew for a part appears under that part's tab.
- [ ] **Step 3: Run** `bun test apps/hook-module/test/ui-state.test.ts apps/hook-module/test/ui-views.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the state field, migration branch (today's key set, add `activityTab: "queue"`, keep results), `setActivityTab`, the `activity-tab` case in `consoleAct` (a write through `writeIfCurrent` with no read, like `worlds`), and the view.
- [ ] **Step 5: Lessons only under its tab.** In `render.tsx`, call `drawLessons` only when `state.section === "activity" && state.activityTab === "lessons"`, and wrap its element in the same card frame as Task 1, titled `"Curated lessons"` (drop the `"Curated lessons"` title line at `lessons-view.tsx:100` so it is not drawn twice).
- [ ] **Step 6: Native test** in `pane.native.tsx`: press the `Lessons` sub-tab and assert the Lessons view's `Capture` control appears; press `Log` and assert it is gone.
- [ ] **Step 7: Run** the hook-module tests (`bun test apps/hook-module`), `bun run typecheck`, the native kit. Expected: PASS, including every existing `ui-lessons.test.ts` case.
- [ ] **Step 8: Commit** `feat: split console Activity into sub-tabs`.

### Task 4: Action buttons and artifact votes

**Files:**
- Modify: `apps/hook-module/src/ui/state.ts`, `views.ts`, `register.ts`, `render.tsx`
- Modify: `apps/hook-module/test/fake-engine.ts`
- Create: `apps/hook-module/test/ui-actions.test.ts`
- Modify: `docs/INSTALL.md` (Native console section), the header comment of `views.ts`
- Test: also `native-test/pane.native.tsx`

**Interfaces:**
- Consumes: `card`, `ConsoleControl.tone` (Tasks 1-2), `STATE_KEYS` with `activityTab` (Task 3).
- Produces:
  ```ts
  // state.ts
  export interface CommandNote { command: string; args: string; target: string | null; error: string | null }
  // ConsoleUiState gains: commandNote: CommandNote | null  (initial null; cleared by selectConsoleSection and switchConsoleWorld)
  export function noteCommand(state: ConsoleUiState, note: CommandNote | null): ConsoleUiState;
  /** The session's own world, or why there is none. */
  export function sessionWorld(state: ConsoleUiState): { ok: true; world: string } | { ok: false; reason: string };
  // views.ts
  export const PLUGIN = "self-improvement-loop";
  export const PANE_ACTIONS: readonly { key: string; label: string; command: string; args: string; scope: "session" | "world" }[];
  // ConsoleAction gains: | { kind: "command"; command: string; args: string; target: string | null }
  ```
- `PANE_ACTIONS`, in this order: `learn` "Lesson from a mistake" `self-improvement-loop:learn` `""` session; `toolify` "Skill from last answer" `self-improvement-loop:toolify` `""` session; `reflect` "Reflect on this session" `self-improvement-loop:reflect` `""` session; `curriculum` "Preview promotion" `self-improvement-loop:curriculum` `""` world; `run` "Run worker now" `self-improvement-loop:loop` `"run"` session; `web` "Open web console" `self-improvement-loop:loop` `"web"` session.
- A vote is `{ kind: "command", command: "self-improvement-loop:feedback", args: "<type>:<pattern> good|bad", target: "<pattern>" }`, drawn only when `type` matches `/^[a-z]{1,32}$/` and `pattern` matches the existing `SLUG`.

- [ ] **Step 1: Fake engine.** Add `command.run(input: { command: string; args?: string })` that records `command.run <command> <args>` in the call log and resolves `{}`; `options.fail.commandRun` rejects with `"fake command.run refusal"`; `options.hold.commandRun` returns a promise that never settles.
- [ ] **Step 2: Write failing tests** in `ui-actions.test.ts`:
  - `"each Actions button queues its exact command"`: for every `PANE_ACTIONS` entry, pressing it records exactly `command.run <command> <args>` once and the Actions card then holds the line ``Queued /<command> <args>. It runs in the chat once Claude is idle.`` (args part omitted when empty).
  - `"a vote queues feedback for the session world's artifact"`: on the session world, pressing `good` on `{ pattern: "verify-callsites", artifact_type: "skill" }` records `command.run self-improvement-loop:feedback skill:verify-callsites good`, and that row shows `"vote queued"` instead of the buttons.
  - `"a malformed row gets no vote"`: rows with `pattern: "Bad Name"`, `pattern: "x\u001b"`, `artifact_type: "Skill"`, `artifact_type: "a b"` draw no `good`/`bad` controls, and no `command.run` is ever recorded for them.
  - `"another world hides votes and Preview promotion"`: with the pane on `inkitt` and the session world `default`, no vote controls and no `curriculum` button are drawn, the line ``Votes and promotion apply to this session's world (default). Switch to it to use them.`` is, and the five session actions are drawn.
  - `"an unresolved session world hides them with the reason"`: bootstrap `selectedWorld: null`, `resolutionError: "no world matches /tmp/x"`: same hiding, and a dim line containing `no world matches /tmp/x`.
  - `"a refused run shows the error and keeps the pane usable"`: with `fail.commandRun`, the Actions card shows ``/self-improvement-loop:learn could not be queued: fake command.run refusal`` in the error tone, and a following section press still reads that section.
  - `"a run that never settles keeps queued"`: with `hold.commandRun`, the note stays the queued line and Refresh still reads.
  - `"the note clears on a section or world change"`.
  - `ui-state.test.ts`: `"a saved commandNote round-trips; a malformed one resets as corrupt"`, and the Task 3 migration test now also expects `commandNote: null`. The Task 3 shape (with `activityTab`, without `commandNote`) never ships on its own, so only the v1.2.9 shape needs a migration branch.
- [ ] **Step 3: Run** `bun test apps/hook-module/test/ui-actions.test.ts apps/hook-module/test/ui-state.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** `consoleAct` case `command`: write `noteCommand(s, { command, args, target, error: null })` through `writeIfCurrent`, then call `$.command.run({ command, args })` without awaiting it in the press; on rejection write `noteCommand` with `error: boundedErrorText(message)` if the note still names the same command, args and target. No read follows. Views: an `"Actions"` card on Overview (meta `"runs when the session is idle"`) with one `column` controls block of the allowed actions, each label `"<label>"` and the note line under it; vote controls appended to each Artifacts row through a `controls` block keyed `vote-<pattern>`.
- [ ] **Step 5: Docs.** `views.ts` header: replace "nothing here can change loop state" with a sentence saying the pane changes loop state only through the plugin's own slash commands, pressed by the person and shown in the chat. `docs/INSTALL.md` Native console: replace "a read-only console pane" and "It never starts the worker and never calls a model" with the same rule, naming `/learn`, `/toolify` and `/curriculum` as model turns in the session.
- [ ] **Step 6: Native test** in `pane.native.tsx`: press `Reflect on this session` and assert the engine recorded a `command.run` for `self-improvement-loop:reflect` (or, if the native kit has no `command.run`, assert the queued line and note the gap in the report).
- [ ] **Step 7: Run** `bun test apps/hook-module`, `bun run typecheck`, `bun run lint:dashes`, the native kit. Expected: PASS.
- [ ] **Step 8: Commit** `feat: add command buttons and artifact votes to the console`.

---

## Final verification (after Task 4)

Run the CI set in order and read each result: `bun install`, `git diff --exit-code -- bun.lock`, `bun run lint:dashes`, `bun run typecheck`, `bun run check:web`, `bun run build`, `bun test`. Then `bun run scripts/test-native.ts`. Report the bundle size printed by the build against the 320 KiB budget.

Not covered by automated checks, for the attended run in a real session: borders and spacing in a real terminal at a wide and a narrow pane, the exact plugin command names resolving in `$.command.run` (`self-improvement-loop:learn` and the rest), and a vote reaching `sil feedback` in the session's world.
