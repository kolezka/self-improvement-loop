# Native `/sil` console: layout and action buttons

Date: 2026-10-24. Status: draft for approval.

## Why

The user opened `/sil` after release v1.2.9 and called it cramped, flat and hard to
read. Today every tab is one column with no padding and no gap
(`apps/hook-module/src/ui/render.tsx`, the outer `Box`). Title, tab buttons, world
buttons, Refresh/Close, a `World:` line, a `Section:` line and the content all sit
on consecutive lines at the left edge. Activity is the worst: worker line, queue,
reflections, lessons with their editor, and the worker log run together in one
stream.

The user also wants buttons for the plugin's other commands, so the common loop
actions (a lesson from this session, a skill from the last answer, a reflection)
are one click from the pane.

## Goals

1. The whole pane breathes: margin around it, one blank line between groups, each
   group in its own bordered card with a title line.
2. A two-row header: title and world on the first row, tabs on the second. The
   current tab is shown by color and weight, not by the `(current)` suffix.
3. Refresh and Close move to a footer, with the last refresh time.
4. Dates drawn short (`15:33` for today, `Oct 22 15:33` otherwise) instead of full
   ISO strings.
5. Activity splits into sub-tabs: Queue, Reflections, Lessons, Log. The worker
   card stays above the sub-tabs.
6. An Actions card on Overview with six buttons that run plugin slash commands.
7. good/bad vote buttons on each Artifacts row.

All five tabs (Overview, Review, Artifacts, Activity, Settings) and the Lessons view
change in one go. The user chose this over a staged rollout.

## Non-goals

- No change to what the pane reads, how often, or the bridge (`sil ops`).
- No accept, reject or revise of proposals in the pane. Review stays read only.
- No settings writes.
- No change to the lesson editor's behavior, only to how it is framed.
- No web console changes.

## Anti-goals (fail even if it technically works)

- Drawing tricks the host does not support, so the terminal looks different from
  the prototype.
- Losing any message the pane shows today: errors, "not read yet", truncation
  notes, page status, the display budget notice. The layout moves them into the
  right card; it does not drop them.
- A button that changes loop state with no visible confirmation.

## Constraints

- Only what the host can draw: `Box` layout, `padding`, `margin`, `gap`,
  `borderStyle`/`borderColor`, `Text` colors and weight, `Button`, `Select`,
  `Code`, `Markdown`. Verified against the 2.1.308 host declarations
  (`BoxProps` include gap, margin*, padding*, borderStyle, borderColor). The border
  cannot carry a title, so a card title is the first line inside the card.
- Narrow layout (under `NARROW_COLUMNS` = 44 body columns) must still work. On
  narrow panes cards drop their border and keep the gap, and tabs and world use
  the existing Selects.
- Mobile surface has no `Select`; existing fallbacks stay.
- The display budget (`DISPLAY_BUDGET`, 90000 characters) and `finishView`
  remain the single boundary for drawn text. Card titles count toward it.
  The one exception is the Curated lessons subtree: `lessons-view.tsx` draws it
  with its own bounds, outside `DISPLAY_BUDGET`, as it already was on `main`.
  A shared end-to-end budget is a follow-up.
- Bundle stays under `MAX_HOOK_MODULE_BYTES` (320 KiB).
- No em or en dashes in code, copy or docs (`lint:dashes`).

## Decisions

Made by the user:

- Change the whole pane at once.
- Card layout as in the prototype.
- The six actions and the per-artifact votes below.
- World-scoped actions act on the session's world only (see "Which world an action
  affects").

My calls, open to correction:

- Activity uses sub-tabs, the prototype's default. The user approved the prototype
  without picking between sub-tabs and one long page.
- The selected Activity sub-tab lives in console state next to `section`, and
  survives a hot reload like the section does.
- Lessons keeps its own paging and editor inside the Lessons sub-tab.

### View model

`ConsoleBlock` gains one kind:

```ts
| { kind: "card"; key: string; title: string; meta?: string; blocks: ConsoleBlock[] }
```

`consoleView` returns header blocks, then cards, then footer blocks. `finishView`
and `enforceDisplayBudget` recurse into cards, so the safety boundary still covers
every string `consoleView` draws (the Curated lessons card is drawn apart, see
Constraints). When the budget cuts, it cuts inside the last cards and keeps
the notice. `render.tsx` draws a card as
`<Box borderStyle="round" paddingX={1} flexDirection="column">` with a bold title
line and a dim meta on the same row. The outer Box gets `paddingX={1}` and `gap={1}`.

### Actions

Buttons run plugin commands through `$.command.run`. The host queues the command
and runs it when the session is idle, as if the person typed it. Each command's
output lands in the chat, not the pane. The pane shows "Queued /<command>. It runs
in the chat once Claude is idle." in the Actions card until the next action or tab
change.

| Button | Command |
| --- | --- |
| Lesson from a mistake | `/self-improvement-loop:learn` |
| Skill from last answer | `/self-improvement-loop:toolify` |
| Reflect on this session | `/self-improvement-loop:reflect` |
| Preview promotion | `/self-improvement-loop:curriculum` |
| Run worker now | `/self-improvement-loop:loop run` |
| Open web console | `/self-improvement-loop:loop web` |

Votes run `/self-improvement-loop:feedback <type>:<pattern> good|bad`, built from
the row's `artifact_type` and `pattern`. A row whose type or pattern fails the
existing slug check gets no vote buttons. After a click the row shows "vote queued"
instead of the buttons until the next action, tab change or world change.

#### Which world an action affects

Decided by the user: actions always act on the session's own world, the one
`console.bootstrap` resolves from the session's cwd (`ConsoleBootstrap.selectedWorld`).
`/feedback` and `/curriculum` resolve the world from `$PWD` and stay unchanged.

- When the pane shows that world, everything is drawn as above.
- When the pane shows another world, the vote buttons and Preview promotion are not
  drawn. In their place: a dim line "Votes and promotion apply to this session's
  world (<name>). Switch to it to use them." The other five actions concern the
  session, not a world, and stay.
- When the session's cwd resolves to no world (`selectedWorld` is null or
  `resolutionError` is set), votes and Preview promotion are not drawn, with a dim
  line naming the resolution error.

#### Failures

If `$.command.run` rejects (unknown command, past a Stop, host limit), the card
shows the error in red. The pane never claims a command ran, only that it was
queued.

This changes the pane's contract. Reads and curated-lesson edits (capture, save,
Important, acknowledge, purge) go through `sil ops`, as before. The new Actions
card and artifact votes queue the plugin's own slash commands, which the person
triggers and sees in the chat. Proposal and settings writes stay out of the pane.
`views.ts`'s header comment and `docs/INSTALL.md` are updated to say so. `/learn`, `/toolify` and `/curriculum` run a model turn in the user's
session, exactly as when typed. Hook design rule 1 is about hooks acting on their
own, not about a button the person presses.

## Tests

- `ui-views.test.ts`: every section returns cards with the expected titles; every
  message that existed before still appears somewhere in the tree (a walk over all
  blocks); the budget notice survives a cut inside a card; narrow layout returns
  cards without borders.
- New: Activity sub-tab state, default `queue`, switching, and the lessons editor
  still reachable only under Lessons.
- New: action and vote buttons call `$.command.run` with the exact command and
  args through the fake engine; a rejected run shows the error; a malformed
  artifact row gets no vote buttons.
- New: with the pane on a world other than the session's, and with an unresolved
  session world, no vote buttons and no Preview promotion are drawn and the note
  names the session world or the error. The five session actions stay.
- Native kit (`views.native.tsx`, `pane.native.tsx`, `lessons.native.tsx`): the
  tree renders under the real engine with borders and gaps, wide and narrow.
- Short-date helper: today, another day, an unparseable string drawn as is.

## Left to the builder

- Exact colors from the host palette (the prototype uses the host's green accent).
- How meta text wraps on a narrow card.
- Splitting `views.ts` (735 lines) per section if the change makes it unwieldy.

## References

- Prototype (throwaway, local, git-ignored): `.superpowers/prototypes/sil-console.html`.
- Host declarations: plugin-authoring types for Claude Code 2.1.308.
