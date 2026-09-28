# Web console UX pass

Date: 2026-09-28. Branch: `feat/web-console-ux`.

Twelve requested improvements to the `sil web` console. Most are pane-local UI
work. Three add server surface: a live log stream, a history series op, and an
AI revision op for staged proposals.

## Goals

1. Overview: skeleton placeholders while numbers load.
2. Overview: simple charts of past activity.
3. Queue: "Clear done" and "Clear failed" buttons.
4. Queue: preview any pending, done or failed session.
5. Reflections: UI and UX pass.
6. Logs: live tail, no Refresh button, rendered with the vendored
   `svelte-log-viewer` component.
7. Review: "Request changes" that asks the drafter to revise a proposal from
   the user's instruction.
8. Review: UI and UX pass.
9. Artifacts: "Lessons waiting for delivery" card stays short at 100+ lessons.
10. Loop: show useful data even before the first worker run.
11. Models: UI and UX pass.
12. View transitions between panes.

## Non-goals

- No new charting library. Charts are inline SVG.
- No new model role. Revision runs on `drafter`.
- No hard delete of queue entries.
- No change to hooks, the critic or the worker pipeline.

## Design rules this touches

- Rule 3 (only critic, drafter, judge reach a model): revision uses `drafter`.
  A missing drafter raises `ModelNotConfigured`, surfaced as 503.
- Rule 4 (accept bound to `reviewed_state`): revision refuses on a stale
  digest and returns the new digest. Accept still needs the digest of what the
  human saw after revision.
- Rule 7 (fail loud): every new op reports errors; no empty-array fallback on a
  read failure.

## Server changes

### `history.series` (read tier)

Args: `{ world, days }`, `days` 1..90, default 30. Returns one array per series,
each point `{ day: "YYYY-MM-DD", count }`, dense (zero days included), local
calendar day.

| Series           | Source                              | Timestamp field |
| ---------------- | ----------------------------------- | --------------- |
| `reflections`    | world reflections dir               | `created`       |
| `sessions_done`  | `queue/done/*.json` (visible only)  | `last_stop`     |
| `sessions_failed`| `queue/failed/*.json` (visible only)| `last_stop`     |
| `votes_good`/`votes_bad` | `feedback/human.jsonl`      | `ts`            |
| `critic_verdicts`| `feedback/critic.jsonl`             | `ts`            |
| `nudge_fires`    | `usage/nudge-fires.jsonl`           | `ts`            |
| `artifact_uses`  | `usage/events.jsonl`                | `ts`            |
| `worker_runs`    | `logs/worker.log` run-summary lines | `ts`            |
| `proposals_staged`/`accepted`/`rejected` | `curriculum/proposal-events.jsonl` (new) | `ts` |

Worlds filter before counting (rule 6). Unparseable lines are counted and
returned as `skipped` per series, not silently dropped.

### `proposal-events.jsonl` (new append-only log)

The ledger keeps only the latest state, so staged/accepted/rejected history
cannot be rebuilt. Append `{ts, world, pattern, event}` with event in
`staged | revised | accepted | rejected | retired | rehomed` at the single
ledger write point used by curriculum and review. History starts empty on
upgrade; the chart says "tracked since <first ts>".

### Queue hide

`queue.clear { bucket: "done" | "failed" }` (local tier) writes
`queue/cleared.json` `{done: iso|null, failed: iso|null}`. `queue.list` hides
entries with `last_stop <= cleared_before`, and returns `hidden` counts.
`queue.unclear { bucket }` resets it. No queue file moves or is deleted.

### `queue.detail` (read tier)

Args `{ session_id }`. Returns the queue entry, its bucket, the reflection id it
produced (if any), and the last 40 transcript messages via `@sil/transcript`,
each truncated to 2000 chars. Missing transcript returns `transcript: null`
with a reason, not an error.

### Live logs: `GET /api/logs/stream?name=<log>`

Server-sent events. On connect: the last 500 lines, then new lines as the file
grows (poll `stat` every 500 ms, read the appended byte range, handle
truncation/rotation by restarting from 0). Same token check as other routes
(`guard.ts`). Heartbeat comment every 15 s. Log name whitelisted against the
names `logs.tail` already accepts.

### `review.revise` (local tier)

Args `{ world, pattern, instruction, reviewed_state }`, instruction 1..4000
chars.

1. Load the snapshot; refuse with `ReviewError` (409) if `reviewed_state`
   differs.
2. Build drafter messages: system prompt from curriculum prompts (same artifact
   rules and body format), then the current artifact body, the source lessons
   summary, and the human's instruction marked as the change request that
   overrides earlier drafting choices.
3. Parse the reply with the existing drafter parser. Run the same lint,
   allowed-path and rule-tag checks as curriculum staging. On failure return
   409 with the lint message; branch untouched.
4. Commit the new body on the proposal branch in a scratch worktree, message
   `revise(<pattern>): <first line of instruction>`.
5. Append a `revised` proposal event. Return the new `reviewed_state`, detail
   and diff.

Timeout: provider timeout maps to 504. The UI keeps the instruction text so a
retry does not lose it.

## Web changes

Shared: a `Skeleton` component, a `Sparkline`/`BarChart` inline-SVG component
(`apps/web/src/components/charts/`), and a `Drawer` component.

- **Overview**: skeleton blocks sized like the final numbers until each call
  settles; an error replaces a skeleton with an inline error, never a zero.
  A "Last 30 days" section: bar chart of sessions done vs failed, line of
  reflections, line of proposals staged/accepted/rejected, votes good vs bad.
- **Queue**: toolbar buttons "Clear done" / "Clear failed" with confirm, and
  "Show hidden (N)" toggle that calls `queue.unclear`. Rows in all three
  buckets open a drawer backed by `queue.detail`. Worker status keeps its 5 s
  poll; lists refresh every 10 s.
- **Reflections**: list with search, pattern filter chips, created-date
  grouping; selecting one renders the markdown with artifacts used / helpful /
  misfired as badges; empty and loading states.
- **Logs**: vendored `LogViewer` (`apps/web/src/vendor/svelte-log-viewer/`,
  header naming upstream commit, lucide icons replaced with inline SVG if the
  set is small, else add `@lucide/svelte`). Log picker on top; one `fetch()` stream
  (SSE body parsed by a small reader in `lib/`) per selected log; `live` reflects connection state; reconnect with backoff.
  `lib/logs.ts` maps engine lines to the viewer's `LogLine` (level to stream:
  error to `stderr`, else `stdout`).
- **Review** (from the screenshot): sources collapse to "N sources" with an
  expander; artifact body and diff in tabs with syntax-coloured diff; action bar
  sticky at the bottom of the detail column without covering content (padding
  equal to bar height); "Request changes" button opens a textarea panel,
  submit shows progress, success swaps in the new diff and digest, failure keeps
  the text. List items show type, age and count.
- **Artifacts**: the lessons card shows 8 rows, a count badge, a search box and
  "Show all" which opens the full list in the Drawer, virtualised past 200.
- **Loop**: plan loads on mount (no button); add recent worker runs from
  `worker_runs` (last 10 summaries from worker.log), 14-day mini charts from
  `history.series`, and a clear "No worker run yet, run once" call to action
  with the existing `loop.run` op when status is missing.
- **Models**: per-role cards (critic, drafter, judge) showing endpoint, model,
  locality and last probe result; endpoints table with which roles each serves;
  probe button per endpoint with inline result; errors inline on the card.
- **View transitions**: pane switch wrapped in `document.startViewTransition`
  when available, else instant. Respect `prefers-reduced-motion`. Named
  transition on the page header.

## Testing

- Server: bun tests for `history.series` (bucketing, dense days, world filter,
  skipped count), queue hide/unhide, `queue.detail` with and without
  transcript, SSE stream (initial tail, append, truncation), `review.revise`
  (stale digest 409, lint failure leaves branch unchanged, success changes
  digest, instruction reaches the drafter prompt) using a fake `chat`.
- Proposal events written at the single ledger write point: test through
  curriculum staging and review accept/reject.
- Web: `bun run check:web`, pure helpers (`lib/logs.ts` mapping, chart scale
  helpers) unit tested.
- One end-to-end check in a real browser against `sil web` on a temp home:
  every pane loads, logs stream a line appended during the test, a revise with
  a fake drafter endpoint round-trips.
- Full CI set: install, lockfile diff, lint:dashes, typecheck, check:web,
  build, test.

## Work split for the team

Disjoint write scopes, cross-module signatures fixed in the plan before
dispatch.

| Worker | Scope |
| --- | --- |
| A (server data) | `history.series`, proposal events, queue hide, `queue.detail` + tests |
| B (server live + revise) | SSE route, `review.revise` + tests |
| C (web shell) | shared components, view transitions, Overview, Loop |
| D (web panes 1) | Queue, Logs (vendor), Artifacts |
| E (web panes 2) | Review, Reflections, Models |
| Reviewer | Independent review of the full diff |

C, D and E start after A and B publish their op signatures (types in
`apps/web/src/lib/`), not after their implementations land.

## Risks

- Revision prompt drift from staging prompt. Mitigation: reuse the curriculum
  prompt builder, add only the instruction block.
- The guard needs `X-SIL-Local` and the token header, which `EventSource`
  cannot send. The client reads the SSE body through `fetch()` streaming with
  the normal headers instead, so the guard stays unchanged. No query-string
  token.
- Proposal history begins at upgrade; older activity will not appear.

## Changes made while planning (2026-09-29)

- `nudge_fires` dropped from `history.series`: the fire record has no `world` field, so it cannot be filtered per world.
- `worker_runs` needs a new `{"action":"run"}` line in `worker.log` per worker pass; none existed.
- The ledger has no single funnel above `saveLedger` (six callers, run on tree copies). Proposal events are appended at five explicit call sites (stage, accept, reject, rehome, retire) plus revise, each tested.
- The stream route sits in `apps/server/src/main.ts` before the `/api/` 404 branch and calls `guard()` itself.
- Revise commits on top of the staged branch (base is the branch) and does not touch the ledger. The human instruction is included in the lint grounding text.
