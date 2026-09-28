# Web Console UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the twelve `sil web` console improvements in the spec: skeletons, history charts, queue hide and preview, live logs, AI revision of proposals, pane UX passes and view transitions.

**Architecture:** Server work adds five ops (`history.series`, `queue.clear`, `queue.unclear`, `queue.detail`, `review.revise`), one non-op streaming route (`GET /api/logs/stream`) and two append-only records (`proposal-events.jsonl`, a `run` line in `worker.log`). Web work adds shared components (Skeleton, Drawer, charts, stream reader), vendors `svelte-log-viewer`, and reworks eight panes. The lead writes the shared web contract (Task 0) before any teammate starts, so no two teammates write the same file.

**Tech Stack:** Bun (version in `.bun-version`), TypeScript, zod, Svelte 5 runes, Vite, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-28-web-console-ux-design.md`

## Global Constraints

- No em or en dashes in any file, comment or commit (`bun run lint:dashes`).
- Hooks untouched. No new model role. Only `drafter` is called, only from `review.revise`.
- Fail loud: no `catch {}` that returns empty data on a read failure; unparseable lines are counted as `skipped`.
- Worlds filter before counting or alias resolution.
- `Object.hasOwn`, never `x in obj`, for lookups keyed by untrusted strings.
- Tests that touch disk set `SIL_CONFIG_DIR`, `SIL_STATE_DIR`, `SIL_DATA_DIR`, `CLAUDE_PLUGIN_ROOT` to tmp dirs in `beforeEach` and restore in `afterEach` (pattern: `packages/ops/test/handlers.test.ts:16-31`). Spawned processes get `env` explicitly.
- No new runtime dependency. `@lucide/svelte` is NOT added; the vendored viewer uses inline SVG icons.
- Every bug-shaped behavior gets a test that fails first. Run the red, then the green.
- Conventional Commits, subject at most 72 chars.
- Done means the full CI set passes in the worktree: `bun install && git diff --exit-code -- bun.lock && bun run lint:dashes && bun run typecheck && bun run check:web && bun run build && bun test`.

## Review Focus

1. A log file rotated or truncated while a stream is open: the stream restarts from byte 0 and keeps going, no duplicate or lost tail, no server exception.
2. A revise instruction that the drafter ignores, or a reply that fails lint: the branch and `reviewed_state` stay unchanged and the user sees the lint message with their text still in the box.
3. A stale `reviewed_state` on revise (someone else revised or restaged): 409, nothing committed.
4. Queue "Clear done" clicked, then new sessions finish: new entries (later `last_stop`) stay visible; hidden count is right; "Show hidden" restores all.
5. History with a malformed JSONL line or a record from another world: the line is counted in `skipped`, other-world records are excluded, days with no records are zeros, not missing.

Each line above has its test in the owning task (Tasks 6, 7, 4, 3).

---

## Team and ownership

| Teammate | Agent type | Tasks | Write scope |
| --- | --- | --- | --- |
| lead | main session | 0, 17 | `apps/web/src/lib/api-types.ts`, `apps/web/src/lib/stream.ts`, `apps/web/src/components/{Skeleton,Drawer}.svelte`, `app.css` shared block |
| server-data | `route-sonnet` | 1, 2, 3, 4, 5 | `packages/store`, `packages/worker`, `packages/curriculum/src/run.ts` (event call only), `packages/review/src/index.ts` (event calls only), `packages/ops` (history/queue), their tests |
| server-live | `route-sonnet` | 6, 7 | `apps/server`, `packages/review/src/revise.ts`, `packages/ops` (review.revise registration and args), their tests |
| web-shell | `route-sonnet` | 8, 9, 10 | `apps/web/src/App.svelte`, `apps/web/src/components/charts/*`, `apps/web/src/lib/chart.ts`, `Overview.svelte`, `Loop.svelte` |
| web-panes-a | `route-gpt-terra` | 11, 12, 13 | `Queue.svelte`, `QueueBucket.svelte`, `Logs.svelte`, `lib/logs.ts`, `apps/web/src/vendor/**`, `Artifacts.svelte` |
| web-panes-b | `route-sonnet` | 14, 15b, 16 | `Review.svelte`, `DiffView.svelte`, `Reflections.svelte`, `Models.svelte` |
| reviewer | `route-gpt-sol` | 17 | read-only |

Shared-file rule: `packages/ops/src/index.ts` and `packages/ops/src/args.ts` are touched by both server teammates. server-data adds its lines first; server-live rebases onto that commit before registering `review.revise`. Each adds lines only in its own marked block.

All teammates share one worktree, `/Users/me/Development/sil-web-console-ux`, on branch `feat/web-console-ux`. Commit only your own paths (`git add <paths>`, never `-A`, never `git stash`, never `git checkout -- <other paths>`). Before committing, run the CI subset for your scope. A test failure in a path you do not own is reported to the lead, not fixed.

---

### Task 0 (lead): Shared web contract

**Files:**
- Create: `apps/web/src/lib/api-types.ts`
- Create: `apps/web/src/lib/stream.ts`
- Create: `apps/web/src/components/Skeleton.svelte`
- Create: `apps/web/src/components/Drawer.svelte`
- Modify: `apps/web/src/app.css` (append `/* shared: skeleton, drawer */` block)
- Test: `apps/web/test/stream.test.ts`

**Produces:**

```ts
// apps/web/src/lib/api-types.ts
export interface SeriesPoint { day: string; count: number }
export type SeriesName =
  | "reflections" | "sessions_done" | "sessions_failed"
  | "votes_good" | "votes_bad" | "critic_verdicts" | "artifact_uses"
  | "worker_runs" | "proposals_staged" | "proposals_revised"
  | "proposals_accepted" | "proposals_rejected";
export interface HistorySeries {
  world: string;
  days: number;
  since: Record<SeriesName, string | null>; // first record ts seen, null when none
  skipped: Record<SeriesName, number>;
  series: Record<SeriesName, SeriesPoint[]>;
}
export interface QueueEntry {
  session_id: string; transcript_path: string; cwd: string; world: string;
  git_head: string | null; first_stop: string; last_stop: string; stops: number;
  ended: boolean; tool_uses: number; attempts: number; result: string | null;
}
export interface QueueList {
  pending: QueueEntry[]; done: QueueEntry[]; failed: QueueEntry[];
  hidden: { done: number; failed: number };
  cleared: { done: string | null; failed: string | null };
}
export interface TranscriptMessage { role: string; text: string; ts: string | null }
export interface QueueDetail {
  bucket: "pending" | "done" | "failed";
  entry: QueueEntry;
  reflection_ids: string[];
  transcript: TranscriptMessage[] | null;
  transcript_reason: string | null;
}
export interface ReviewDetail {
  world: string; pattern: string; branch: string; artifact_type: string;
  status: string; artifact_path: string | null; count: number;
  staged_at: string | null; commit: string | null; body: string;
  sources: string[]; reviewed_state: string; accept_blocked: string | null;
}
export interface ReviseResult { detail: ReviewDetail; diff: string; reviewed_state: string }
export interface WorkerRun { ts: string; reflected: number; failed: number; skipped: number }
```

```ts
// apps/web/src/lib/stream.ts
export interface StreamLine { name: string; line: string }
/** Parses an SSE body into events. Pure: feed chunks, get complete events. */
export function createSseParser(onEvent: (event: string, data: string) => void): (chunk: string) => void;
/** Opens GET /api/logs/stream?name=... with the console headers and calls
 * onLine per log line. Resolves when the stream ends; rejects on HTTP error.
 * Abort with the signal. */
export function streamLog(name: string, onLine: (line: string) => void, signal: AbortSignal): Promise<void>;
```

`Skeleton.svelte` props: `{ width?: string = "100%"; height?: string = "1em"; radius?: string = "var(--r-sm)" }`, renders `<span class="skeleton" aria-hidden="true">` with a shimmer that stops under `prefers-reduced-motion`.

`Drawer.svelte` props: `{ open: boolean (bindable); title: string; width?: string = "min(44rem, 100vw)"; children: Snippet; onclose?: () => void }`. Fixed right panel with scrim, Escape closes, focus moves into the panel on open and back to the opener on close.

`api.ts` gains `export function authHeaders(): Record<string, string>` returning `{ "X-SIL-Local": "1", "X-SIL-Token": token }`, used by `call` and `streamLog`.

- [ ] **Step 1: Write the failing SSE parser test**

```ts
import { describe, expect, test } from "bun:test";
import { createSseParser } from "../src/lib/stream.ts";

describe("createSseParser", () => {
  test("emits events split across chunks and ignores comments", () => {
    const got: [string, string][] = [];
    const feed = createSseParser((e, d) => got.push([e, d]));
    feed(": heartbeat\n\nevent: line\ndata: {\"line\":\"a\"}\n");
    feed("\nevent: line\ndata: {\"line\":\"b\"}\n\n");
    expect(got).toEqual([["line", "{\"line\":\"a\"}"], ["line", "{\"line\":\"b\"}"]]);
  });
  test("joins multi-line data with newlines and defaults event to message", () => {
    const got: [string, string][] = [];
    const feed = createSseParser((e, d) => got.push([e, d]));
    feed("data: x\ndata: y\n\n");
    expect(got).toEqual([["message", "x\ny"]]);
  });
});
```

- [ ] **Step 2: Run** `bun test apps/web/test/stream.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `stream.ts`**

```ts
import { authHeaders } from "./api.ts";

export function createSseParser(onEvent: (event: string, data: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length > 0) onEvent(event, data.join("\n"));
    }
  };
}

export async function streamLog(name: string, onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
  const url = new URL("/api/logs/stream", window.location.origin);
  url.searchParams.set("name", name);
  const res = await fetch(url, { headers: authHeaders(), signal });
  if (!res.ok || !res.body) throw new Error(`log stream: HTTP ${res.status}`);
  const feed = createSseParser((event, data) => {
    if (event === "line") onLine((JSON.parse(data) as { line: string }).line);
  });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    feed(value);
  }
}
```

- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5:** Write `api-types.ts`, `Skeleton.svelte`, `Drawer.svelte`, the `authHeaders` export and the app.css block. Run `bun run check:web`. Expected: 0 errors.
- [ ] **Step 6: Commit** `feat(web): add shared api types, SSE reader, skeleton and drawer`.

---

### Task 1 (server-data): Proposal events log

**Files:**
- Create: `packages/store/src/proposal-events.ts`, export from `packages/store/src/index.ts`
- Modify: `packages/core/src/paths.ts` (add `proposalEventsFile`)
- Modify: `packages/curriculum/src/run.ts` (after the `withScratchWorktree` commit at ~545 succeeds)
- Modify: `packages/review/src/index.ts` (after each successful `acceptInner`, `rejectInner`, `rehomeInner`, `retireInner`)
- Test: `packages/store/test/proposal-events.test.ts`, extend `packages/review/test/*.test.ts` and `packages/curriculum/test/run.test.ts`

**Produces:**

```ts
export type ProposalEventKind = "staged" | "revised" | "accepted" | "rejected" | "retired" | "rehomed";
export interface ProposalEvent { ts: string; world: string; pattern: string; event: ProposalEventKind }
export function appendProposalEvent(world: string, pattern: string, event: ProposalEventKind): void;
export function readProposalEvents(): { events: ProposalEvent[]; skipped: number };
// packages/core/src/paths.ts
export const proposalEventsFile = (): string => join(stateDir(), "curriculum", "proposal-events.jsonl");
```

Why not inside `saveLedger`: it runs on a tree copy inside scratch worktrees and does not know which transition happened. Five explicit call sites, each tested.

- [ ] **Step 1: Failing store test**

```ts
test("append then read round-trips and counts a bad line as skipped", () => {
  appendProposalEvent("default", "p-one", "staged");
  appendFileSync(paths.proposalEventsFile(), "not json\n");
  appendProposalEvent("default", "p-one", "accepted");
  const { events, skipped } = readProposalEvents();
  expect(events.map((e) => e.event)).toEqual(["staged", "accepted"]);
  expect(skipped).toBe(1);
});
```

- [ ] **Step 2:** Run `bun test packages/store/test/proposal-events.test.ts`. Expected: FAIL (not exported).
- [ ] **Step 3: Implement** with `fsx.appendJsonl(paths.proposalEventsFile(), { ts: fsx.nowIso(), world, pattern, event })`; reader splits lines, `JSON.parse` in try, validates with a zod schema, counts failures in `skipped`. Missing file returns `{ events: [], skipped: 0 }`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Failing integration tests**: in the curriculum run test that stages a skill with `FakeChat`, assert `readProposalEvents().events` ends with `{ pattern, event: "staged" }`; in review tests for accept, reject, rehome, retire, assert the matching event. Also assert a gated-out pattern writes NO event.
- [ ] **Step 6:** Run them. Expected: FAIL. Add one `appendProposalEvent` call after each successful commit. Run. Expected: PASS.
- [ ] **Step 7: Commit** `feat(store): record proposal transitions in an append-only log`.

---

### Task 2 (server-data): Worker run marker

**Files:**
- Modify: `packages/worker/src/index.ts:377` (next to the `worker-status.json` write)
- Test: `packages/worker/test/*.test.ts` (the test that drives `runOnce`)

**Produces:** one `worker.log` line per `runOnce` pass: `{"ts": ..., "action": "run", "reflected": n, "failed": n, "skipped": n}`, counts taken from the same `summary` written to `worker-status.json`.

- [ ] **Step 1:** Failing test: after one `runOnce` with auto_kick disabled, `worker.log` has exactly one line with `action === "run"` and counts equal to `worker-status.json.last_summary` lengths.
- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Add `log({ action: "run", reflected: ..., failed: ..., skipped: ... })`. **Step 4:** Run, expect PASS.
- [ ] **Step 5: Commit** `feat(worker): log one run marker per worker pass`.

---

### Task 3 (server-data): `history.series` op

**Files:**
- Create: `packages/ops/src/handlers/history.ts`
- Modify: `packages/ops/src/args.ts` (add `HistoryArgs`), `packages/ops/src/index.ts` (register)
- Test: `packages/ops/test/history.test.ts`

**Consumes:** `readProposalEvents` (Task 1), `listReflections(world)` (`packages/store/src/reflections.ts:120`), `listQueue` with the Task 4 visibility filter, `paths.humanFeedbackFile`, `paths.criticFeedbackFile`, `paths.usageEventsFile`, `paths.logFile("worker")`.

**Produces:** `HistoryArgs = WorldArgs.extend({ days: z.coerce.number().int().min(1).max(90).default(30) })`; return type `HistorySeries` from Task 0.

Sources and filters:

| Series | Source | ts field | World filter |
| --- | --- | --- | --- |
| reflections | `listReflections(world.name)` | `created` | implicit |
| sessions_done / sessions_failed | `listQueue("done"/"failed")` visible entries | `last_stop` | `entry.world === world.name` |
| votes_good / votes_bad | human.jsonl | `ts` | `world` field |
| critic_verdicts | critic.jsonl | `ts` | `world` field |
| artifact_uses | usage/events.jsonl | `ts` | `world` field |
| worker_runs | worker.log lines with `action === "run"` | `ts` | none (worker is global; documented in `doc`) |
| proposals_* | proposal events | `ts` | `world` field |

Nudge fires are NOT a series: the fire record has no `world` field.

Bucketing: local calendar day via `new Date(ts)` and `getFullYear/Month/Date`, zero-padded. Dense: every day from `today - days + 1` to today, zeros included. A record older than the window is ignored. Unparseable line or invalid date: `skipped[name] += 1`.

- [ ] **Step 1: Failing tests**

```ts
test("dense days, world filter and skipped count", async () => {
  // fixture: human.jsonl with 2 good today (world default), 1 good today (world other),
  // 1 bad two days ago (default), one "garbage" line
  const out = (await invoke("history.series", { world: "default", days: 3 })) as HistorySeries;
  expect(out.series.votes_good.map((p) => p.count)).toEqual([0, 0, 2]);
  expect(out.series.votes_bad.map((p) => p.count)).toEqual([1, 0, 0]);
  expect(out.skipped.votes_good + out.skipped.votes_bad).toBeGreaterThanOrEqual(1);
  expect(out.series.reflections).toHaveLength(3);
});
test("rejects days out of range", async () => {
  await expect(invoke("history.series", { world: "default", days: 91 })).rejects.toThrow();
});
```

- [ ] **Step 2:** Run, expect FAIL. **Step 3:** Implement a `bucket(points: string[], days: number): SeriesPoint[]` helper and a `readJsonl(path, world | null): { records, skipped }` helper in `history.ts`. **Step 4:** Run, expect PASS.
- [ ] **Step 5: Commit** `feat(ops): add history.series for console charts`.

---

### Task 4 (server-data): Queue hide and unhide

**Files:**
- Create: `packages/store/src/queue-cleared.ts` (export from index)
- Modify: `packages/ops/src/handlers/queue.ts`, `args.ts`, `index.ts`
- Test: `packages/ops/test/queue-clear.test.ts`

**Produces:**

```ts
export interface QueueCleared { done: string | null; failed: string | null }
export function loadQueueCleared(): QueueCleared;          // state/queue/cleared.json, default both null
export function setQueueCleared(bucket: "done" | "failed", iso: string | null): QueueCleared;
export function isHidden(entry: { last_stop: string }, clearedBefore: string | null): boolean; // last_stop <= clearedBefore
// ops
export const ClearArgs = z.object({ bucket: z.enum(["done", "failed"]) });
// queue.clear  (local): sets cleared[bucket] = now, returns QueueCleared
// queue.unclear (local): sets cleared[bucket] = null, returns QueueCleared
// queue.list now returns QueueList (Task 0): visible entries only, plus hidden counts and cleared
```

Compare timestamps with `Date.parse`, not string compare (offsets differ). The cap of 200 applies after hiding.

- [ ] **Step 1: Failing test** (Review Focus 4): write done entries at t-2h and t-1h; `queue.clear {bucket:"done"}`; write one at t+1s; `queue.list` shows only the new one, `hidden.done === 2`; `queue.unclear` shows all three; queue files still exist on disk after clear.
- [ ] **Step 2:** Run, FAIL. **Step 3:** Implement. **Step 4:** Run, PASS.
- [ ] **Step 5: Commit** `feat(queue): hide cleared done and failed sessions reversibly`.

---

### Task 5 (server-data): `queue.detail` op

**Files:**
- Modify: `packages/ops/src/handlers/queue.ts`, `index.ts`
- Test: `packages/ops/test/queue-detail.test.ts`

**Produces:** `queue.detail` (read, `SessionArgs`) returning `QueueDetail` (Task 0). Finds the entry across buckets (pending, done, failed; unknown id raises `ValidationError`). `reflection_ids`: `listReflections(entry.world)` whose id or front-matter references `session_id` (check how reflections store the session id and use that field; if none exists, return `[]` and note it in the op doc). `transcript`: last 40 messages from `iterEvidenceRecords(entry.transcript_path)` mapped to `{ role, text, ts }`, text truncated to 2000 chars; missing file gives `transcript: null, transcript_reason: "transcript not persisted"`.

- [ ] **Step 1: Failing tests**: entry with a fixture JSONL transcript of 50 user/assistant records returns 40 messages, last one matches; entry with missing path returns `null` and the reason; unknown session id rejects with 400-class `ValidationError`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(queue): add queue.detail with transcript excerpt`.

---

### Task 6 (server-live): Live log stream route

**Files:**
- Create: `apps/server/src/log-stream.ts`
- Modify: `apps/server/src/main.ts` (branch before the `/api/` 404 catch-all)
- Test: `apps/server/test/log-stream.test.ts`

**Produces:**

```ts
/** Pure follower: given the previous offset and the current file size, what to read. */
export function nextRange(prevOffset: number, size: number): { from: number; to: number; reset: boolean };
// reset = size < prevOffset (truncation or rotation): read from 0.
export function handleLogStream(request: Request, url: URL, opts: { pollMs?: number; heartbeatMs?: number; initialLines?: number }): Response;
```

Route in `main.ts`:

```ts
if (pathname === "/api/logs/stream") {
  const denied = guard(request, { port: server.port ?? opts.port, token: opts.token, allowedHosts: opts.allowedHosts });
  if (denied) return denied;
  if (request.method !== "GET") return new Response(JSON.stringify({ detail: "method not allowed" }), { status: 405 });
  return handleLogStream(request, url, {});
}
```

Behaviour: `name` validated with `LOG_NAMES` (400 otherwise). Response `content-type: text/event-stream`, `cache-control: no-store`. On start emit the last 500 lines via `tailLines` (from `packages/ops/src/handlers/logs.ts`, export it through `@sil/ops` if not already) as `event: line\ndata: {"line": ...}\n\n`. Then every 500 ms `statSync`; read `[from, to)`; keep an incomplete trailing line in a buffer until its newline arrives; on `reset` emit `event: reset\ndata: {}\n\n` then lines from 0. Missing file: emit `event: missing` once, keep polling. Heartbeat `: hb\n\n` every 15 s. Stop timers on `request.signal` abort and on stream cancel.

- [ ] **Step 1: Failing unit tests for `nextRange`**: `(0, 10) -> {0,10,false}`, `(10, 10) -> {10,10,false}`, `(10, 4) -> {0,4,true}`.
- [ ] **Step 2: Failing integration tests** (server started as in `apps/server/test/server.test.ts:13-48`, `pollMs: 20`):
  - without headers: 401.
  - with headers: first events contain the pre-existing lines; append `"new line\n"` to the log; next `line` event is `new line`.
  - Review Focus 1: truncate the file to empty then write `"after\n"`; stream emits `reset` then `after`; no exception logged to `web.log`.
  - Partial line: append `"half"` then `" done\n"`; exactly one event `half done`.
- [ ] **Step 3:** FAIL. **Step 4:** Implement with a `ReadableStream` whose `start` sets an interval and whose `cancel` clears it. **Step 5:** PASS.
- [ ] **Step 6: Commit** `feat(server): stream engine logs over server-sent events`.

---

### Task 7 (server-live): `review.revise`

**Files:**
- Create: `packages/review/src/revise.ts`, export `revise` from `packages/review/src/index.ts`
- Modify: `packages/ops/src/args.ts` (`ReviseArgs`), `packages/ops/src/handlers/review.ts`, `packages/ops/src/index.ts`
- Test: `packages/review/test/revise.test.ts`, one case in `packages/ops/test/handlers.test.ts`

**Consumes:** `snapshot` (`packages/review/src/snapshot.ts:34`), `detail`/`diff` (`packages/review/src/index.ts:208,246`), `prompts.draftMessages` (`prompts.ts:314`), `prompts.parseDraft` (`prompts.ts:528`), `lint` (`lint.ts:286`), `artifacts.stripRuleTag`, `artifacts.writeArtifact`, `artifacts.foreignRuleTags`, `artifacts.ensureRulesFile`, `git.withScratchWorktree` (`git.ts:201`), `listReflections`, `appendProposalEvent` (Task 1), `providers.chat`.

**Produces:**

```ts
export interface ReviseOptions { chat?: ChatFn }
export async function revise(
  world: World, cfg: Config, pattern: string, reviewedState: string, instruction: string, opts?: ReviseOptions,
): Promise<{ detail: ReviewDetail; diff: string; reviewed_state: string }>;
// ops
export const ReviseArgs = AcceptArgs.extend({ instruction: z.string().trim().min(1).max(4000) });
// register({ name: "review.revise", tier: "local", gate: "reviewed_state", args: ReviseArgs, fn: review.reviewRevise,
//   doc: "Ask the drafter to revise a staged proposal from a human instruction; reviewed_state must match." })
```

Note: the registry refuses names containing `accept` or `push` outside the remote tier; `review.revise` is fine as local.

Algorithm:
1. `snapshot` for the pattern; if `reviewedState !== snap.reviewed_state` throw `ReviewError("proposal changed since you opened it; reload")`.
2. `current = detail(...)`; `artifactType = current.artifact_type`; `existing = artifactType === "rule" ? artifacts.stripRuleTag(current.body, pattern) : current.body`.
3. `lessons = listReflections(world.name).filter((r) => r.pattern === pattern).map((r) => r.lesson)`.
4. `messages = prompts.draftMessages(pattern, lessons, existing, artifactType, caps)` then push `{ role: "user", content: HUMAN_BLOCK }` where

```ts
const HUMAN_BLOCK = (instruction: string) =>
  "A human reviewer asked for changes to the artifact above. Apply this request. " +
  "It takes precedence over earlier drafting choices, but keep the same artifact type, " +
  "keep everything the request does not touch, and stay within the same format and limits.\n\n" +
  "Reviewer request:\n<<<\n" + instruction + "\n>>>";
```

5. `raw = await (opts.chat ?? providers.chat)("drafter", messages, { world, jsonMode: true })`; provider errors propagate (mapped to 502/504 by `mapError`).
6. `[body] = prompts.parseDraft(raw)`; strip rule tag for rules; `problems = lint(artifactType, body, pattern, [...lessons, instruction].join("\n\n"), caps)`. The instruction is part of the grounding text: the human is evidence. If problems, throw `ReviewError("revision failed lint: " + problems.join("; "))`. If body equals `existing` (same compare as `sameArtifact` in run.ts; export it if private), throw `ReviewError("the drafter returned the proposal unchanged")`.
7. `withScratchWorktree(target, branch, branch, (tree) => { ensureRulesFile for rules; writeArtifact(...); foreignRuleTags guard for rules; git add rel; git commit -q -m "revise(<type>): <pattern>: <first line of instruction, max 60 chars>" })`. Base is the branch itself so the revision stacks on the staged commit. Ledger is not touched.
8. `appendProposalEvent(world.name, pattern, "revised")`; return fresh `detail`, `diff`, `reviewed_state`.

Get `caps` the way `run.ts` builds them for this world (find the `caps` construction in run.ts and extract a small exported helper if it is inline).

- [ ] **Step 1: Failing tests** in `revise.test.ts`, using the curriculum test fixtures for a staged skill and a `FakeChat`-style fn:
  - stale digest (Review Focus 3): throws `ReviewError`, branch sha unchanged, FakeChat not called.
  - instruction reaches the drafter: last message content contains the instruction verbatim and the existing body appears in the messages.
  - lint failure (Review Focus 2): FakeChat returns an empty body; throws `ReviewError` matching `/lint/`; branch sha unchanged; no `revised` event.
  - unchanged reply: throws `/unchanged/`.
  - success: branch sha moves by exactly one commit touching only the artifact path; returned `reviewed_state` differs from the old one and equals a fresh `snapshot`; `skill.accept` with the OLD digest now fails and with the NEW digest succeeds.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(review): revise a staged proposal from a human instruction`.

---

### Task 8 (web-shell): Chart helpers and components

**Files:**
- Create: `apps/web/src/lib/chart.ts`, `apps/web/src/components/charts/BarChart.svelte`, `apps/web/src/components/charts/LineChart.svelte`
- Test: `apps/web/test/chart.test.ts`

**Produces:**

```ts
export interface ChartSeries { label: string; tone: "accent" | "ok" | "warn" | "err" | "muted"; points: SeriesPoint[] }
export function niceMax(values: number[]): number;            // 0 -> 1, 7 -> 10, 23 -> 25, 101 -> 150
export function scaleY(value: number, max: number, height: number): number;
export function dayLabel(day: string): string;                // "2026-09-28" -> "28 Sep"
export function total(points: SeriesPoint[]): number;
```

`BarChart` props `{ series: ChartSeries[]; height?: number = 120; stacked?: boolean = false; title: string }`. `LineChart` props `{ series: ChartSeries[]; height?: number = 120; title: string }`. Both: inline SVG, `viewBox` width = points count * 10, `preserveAspectRatio="none"`, colours from CSS tokens (`var(--accent)` etc), a legend with totals, `<title>` per bar/point for hover (`28 Sep: 4`), an empty state "No activity in this window" when every count is 0, `role="img"` and `aria-label` summarising totals.

- [ ] **Step 1:** Failing tests for `niceMax`, `scaleY` (0 maps to height, max maps to 0), `dayLabel`, `total`. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, then `bun run check:web`.
- [ ] **Step 5: Commit** `feat(web): add inline svg bar and line charts`.

---

### Task 9 (web-shell): View transitions, Overview skeletons and history

**Files:** Modify `apps/web/src/App.svelte`, `apps/web/src/panes/Overview.svelte`, `apps/web/src/app.css` (a `/* view transitions */` block).

- View transitions: in `App.svelte`, wrap the hash change in `document.startViewTransition(() => { hash = next; return tick(); })` when `"startViewTransition" in document` and `!matchMedia("(prefers-reduced-motion: reduce)").matches`; else assign directly. Give `.page-head` `view-transition-name: page-head` and the pane wrapper `view-transition-name: pane`. CSS: 160 ms fade plus 6 px rise for `::view-transition-new(pane)`, 120 ms fade out for old.
- Overview: each count in the loop band renders `<Skeleton width="3ch" height="1.6em" />` while its call is pending; a failed call shows an inline error chip with the message, never `0`. Track per-source state `{ status: "loading" | "ok" | "error"; value?; error? }`.
- New "Last 30 days" section below the band, calling `history.series { world, days: 30 }`: `BarChart` stacked of `sessions_done` (ok) vs `sessions_failed` (err); `LineChart` of `reflections`; `LineChart` of `proposals_staged`, `proposals_accepted`, `proposals_rejected`; `BarChart` of `votes_good` vs `votes_bad`. Under the proposals chart, when `since.proposals_staged` is null or within the window, show "Tracked since <date>" (or "Tracking starts with this version"). Chart skeletons are `<Skeleton height="120px" />`.

- [ ] **Step 1:** Implement. **Step 2:** `bun run check:web` 0 errors. **Step 3:** Manual check in browser (lead verifies in Task 17). **Step 4: Commit** `feat(web): overview skeletons, history charts and view transitions`.

---

### Task 10 (web-shell): Loop pane with data

**Files:** Modify `apps/web/src/panes/Loop.svelte`.

- Load `curriculum.plan` on mount (remove the "Show plan" gate), with skeleton rows while loading.
- "Recent runs": last 10 `worker.log` lines with `action === "run"` via `logs.tail { name: "worker", lines: 2000 }` filtered client-side and parsed into `WorkerRun`; table of time, reflected, failed, skipped. Empty: "No worker run recorded yet."
- 14-day mini charts from `history.series { days: 14 }`: `worker_runs`, `reflections`, `sessions_failed`.
- When `worker.status` has no `last_run`: a call-to-action card "The worker has not run yet" with a "Run once now" button calling `loop.run { world }`, then polling `worker.status` every 3 s for up to 60 s.
- [ ] **Step 1:** Implement. **Step 2:** `bun run check:web`. **Step 3: Commit** `feat(web): show plan, recent runs and trends in loop pane`.

---

### Task 11 (web-panes-a): Queue pane

**Files:** Modify `apps/web/src/panes/Queue.svelte`, `apps/web/src/components/QueueBucket.svelte`.

- Use `QueueList` from `api-types.ts`.
- Toolbar: "Clear done" and "Clear failed" (each `confirm("Hide N done sessions? You can show them again.")`, then `queue.clear`), and when `hidden.done + hidden.failed > 0` a "Show hidden (N)" button that calls `queue.unclear` for each bucket with hidden entries.
- Refresh lists every 10 s (worker status keeps 5 s). Remove the manual Refresh button only if both polls exist; keep a small "Updated hh:mm:ss" label.
- `QueueBucket` gets `onOpen?: (entry: QueueEntry) => void`; each row is a button. Clicking opens `Drawer` with `queue.detail`: header (session id, world, cwd, stops, tool uses, attempts, first/last stop, result), links to reflections by id (navigate to `#/reflections/<id>`), transcript excerpt as a message list (role badge, text in `pre-wrap`), or the `transcript_reason`.
- [ ] **Step 1:** Implement. **Step 2:** `bun run check:web`. **Step 3: Commit** `feat(web): queue clear, show hidden and session preview`.

---

### Task 12 (web-panes-a): Vendored log viewer and live Logs pane

**Files:**
- Create: `apps/web/src/vendor/svelte-log-viewer/**` copied from `kolezka/svelte-log-viewer@ef28afca51287cd9d631662ef7d522c9953ae69a` `src/lib` (skip `virtual.test.ts`; move it to `apps/web/test/vendor-virtual.test.ts` with imports fixed so it runs under `bun test`)
- Create: `apps/web/src/vendor/svelte-log-viewer/icons.ts` (inline SVG paths for ArrowDownToLine, Check, Copy, Download, FilterX, Hash, ScrollText, Timer, WrapText, Lucide ISC licence note)
- Modify: `LogViewer.svelte` import of `@lucide/svelte` to local icon components
- Modify: `apps/web/src/lib/logs.ts` (add mapper), `apps/web/src/panes/Logs.svelte`, `apps/web/src/app.css` (`--lv-*` alias block)
- Test: `apps/web/test/logs.test.ts` (extend)

Fetch files with `gh api repos/kolezka/svelte-log-viewer/contents/<path>?ref=ef28afca51287cd9d631662ef7d522c9953ae69a | jq -r .content | base64 -d`. Every vendored file starts with a comment: `// Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first.` (HTML comment in `.svelte`). Replace any en or em dash in the copied text so `lint:dashes` passes.

**Produces:**

```ts
// lib/logs.ts
import type { LogLine as ViewerLine } from "../vendor/svelte-log-viewer/index.ts";
export function toViewerLine(raw: string, seq: number, source: string): ViewerLine;
// parseLogLine(raw) for ts and level; stream: level "error" -> "stderr", else "stdout"; ts falls back to "" when absent
```

`--lv-*` alias block in `app.css` maps to existing tokens: `--lv-accent: var(--accent)`, `--lv-border: var(--border)`, `--lv-surface-panel: var(--surface)`, `--lv-text-primary: var(--fg)`, `--lv-text-muted: var(--muted)`, `--lv-danger: var(--err)`, `--lv-warning: var(--warn)`, `--lv-success: var(--ok)`, `--lv-font-mono: var(--font-mono)`, and so on for all 32 names listed in the vendored component.

Logs pane: segmented control for `LOG_NAMES` (hook, worker, web, curriculum); on select, abort the previous stream and start `streamLog(name, onLine, signal)`; append mapped lines, cap at 20 000 (drop oldest, set `capped`); `live` true while the stream is open; on error or end, `live = false` and retry with backoff 1 s, 2 s, 5 s, 10 s (max), showing "Reconnecting". On `reset` clear lines. Remove the Refresh button. Keep the level colouring through the viewer's stream field.

For `reset` events `streamLog` must surface them: extend `streamLog` with an optional `onReset?: () => void` fourth parameter (coordinate: this is the only change to `stream.ts` outside Task 0, owned here).

- [ ] **Step 1:** Failing test for `toViewerLine` (JSON worker line with `errors=1` becomes `stderr`, ts preserved; plain `"<iso> msg"` keeps ts; no-ts line has `ts: ""`). **Step 2:** FAIL. **Step 3:** Implement mapper, vendor files, pane. **Step 4:** PASS; `bun test apps/web/test/vendor-virtual.test.ts` PASS; `bun run check:web` 0 errors; `bun run lint:dashes`.
- [ ] **Step 5: Commit** `feat(web): live logs with vendored svelte-log-viewer`.

---

### Task 13 (web-panes-a): Artifacts lessons card

**Files:** Modify `apps/web/src/panes/Artifacts.svelte` (card at lines 192-214); create `apps/web/src/lib/lessons.ts`; test `apps/web/test/lessons.test.ts`.

**Produces:** `export function filterLessons<T extends { pattern: string; text: string }>(items: T[], query: string): T[]` (case-insensitive over pattern and text, trimmed query, empty query returns all) and `export function groupByPattern<T extends { pattern: string }>(items: T[]): { pattern: string; items: T[] }[]` (sorted by count desc, then name).

Card: header count chip; a search box; grouped by pattern, each group collapsed to a row `pattern  ·  N lessons` with the newest lesson text clamped to 2 lines; first 8 groups shown; "Show all N" opens a `Drawer` with the full grouped list and the same search. Card max-height with internal scroll as a fallback.

- [ ] **Step 1:** Failing tests for both helpers. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, `check:web`. **Step 5: Commit** `feat(web): compact grouped lessons card with search`.

---

### Task 14 (web-panes-b): Review pane

**Files:** Modify `apps/web/src/panes/Review.svelte`, `apps/web/src/components/DiffView.svelte`; create `apps/web/src/lib/review.ts`; test `apps/web/test/review.test.ts`.

**Produces:** `export function summariseSources(ids: string[]): { count: number; days: { day: string; count: number }[]; preview: string[] }` (ids look like `2026-09-28-<slug>-<hex>`; day from the prefix; preview = first 3 ids) and `export function instructionTitle(text: string): string` (first line, trimmed, max 60 chars).

UI (fixes from the screenshot):
- List: each item shows pattern, type chip, count chip, relative age, and a status dot; keyboard up/down moves selection.
- Detail header: pattern, type, path, status badge, "N sources" button that expands a compact list grouped by day (from `summariseSources`) instead of the comma wall.
- Tabs: "Proposal" (MarkdownBody or monospace for rules) and "Diff" (DiffView with add/remove line colours, hunk headers dimmed, line wrap toggle).
- Action bar: sticky at the bottom of the detail column, content gets `padding-bottom` equal to the bar height so nothing is covered. Buttons: Accept, Request changes, Reject, then "Move to" select + Apply on the right.
- Request changes: opens an inline panel above the bar with a textarea (placeholder "Describe what should change. The drafter will rewrite the proposal and keep the rest."), character counter (max 4000), Submit and Cancel. Submit calls `review.revise { world, pattern, reviewed_state, instruction }`, disables the bar and shows "Drafter is revising..." with elapsed seconds. Success: replace detail and diff with the result, toast "Revised: <instructionTitle>", switch to the Diff tab, clear the textarea. Error: toast the server `detail`, keep the textarea text.
- [ ] **Step 1:** Failing tests for the two helpers. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, `check:web`. **Step 5: Commit** `feat(web): review pane layout and request changes`.

---

### Task 15b (web-panes-b): Reflections pane

**Files:** Modify `apps/web/src/panes/Reflections.svelte`; create `apps/web/src/lib/reflections.ts`; test `apps/web/test/reflections.test.ts`.

**Produces:** `export function groupByDay<T extends { created: string }>(items: T[]): { day: string; label: string; items: T[] }[]` (label "Today", "Yesterday", else `28 Sep`) and `export function patternCounts<T extends { pattern: string }>(items: T[]): { pattern: string; count: number }[]`.

UI: two columns (list, reader) collapsing to one under 45rem. List: search box, pattern chips (top 12 by count, click to filter, `reflections.list` already accepts a pattern filter), items grouped by day with pattern, first line of lesson, and used/helpful/misfired counts as small badges. Reader: `reflections.get` rendered with `MarkdownBody`, header with id, created, pattern chip linking to Review when a proposal exists. Deep link `#/reflections/<id>` selects that reflection (used by Task 11). Skeleton rows while loading; empty state per filter.

- [ ] Steps: failing helper tests, FAIL, implement, PASS + `check:web`, commit `feat(web): reflections search, grouping and reader`.

---

### Task 16 (web-panes-b): Models pane

**Files:** Modify `apps/web/src/panes/Models.svelte` (487 lines; split into `apps/web/src/components/models/RoleCard.svelte` and `EndpointRow.svelte` if it helps readability).

UI: top row of three role cards (critic, drafter, judge) from `llm.status`: endpoint name, model, locality badge (local/hosted), reachability dot and last error inline in the card. Below, endpoints table: name, kind, base URL (no secrets, only env var names as `llm.get` already returns), roles served as chips, "Probe" button per row showing an inline spinner and the result text. The role-to-endpoint switch (`llm.use`) is a select on each role card with Apply. The raw `llm.yaml` editor stays but moves into a collapsed "Advanced: edit llm.yaml" section. Skeletons while loading.

- [ ] Steps: implement, `check:web`, commit `feat(web): models role cards and endpoint table`.

---

### Task 17 (reviewer + lead): Review and end-to-end verification

- [ ] **Step 1 (reviewer, route-gpt-sol):** Review `git diff origin/main...feat/web-console-ux`. Focus: the Review Focus list, guard bypass on the stream route, prompt injection surface of the instruction block, secrets in `queue.detail` transcript output, timer leaks in the stream, dash lint. Report findings with file:line; do not edit.
- [ ] **Step 2 (lead):** Fix or assign each confirmed finding to the owning teammate.
- [ ] **Step 3 (lead):** Full CI set from Global Constraints. All green.
- [ ] **Step 4 (lead):** Browser check on `sil web` against a tmp home seeded with fixtures (queue entries, reflections, a staged proposal, feedback lines): every pane loads; skeletons appear on a throttled load; charts render; Clear done then Show hidden round-trips; a queue row opens the drawer; appending to `worker.log` shows the line live without refresh; Request changes with a fake drafter endpoint changes the diff and accept works with the new digest; view transition runs on pane switch.
- [ ] **Step 5 (lead):** Update `.ai/todo.md` and `.ai/lessons.md`, checkpoint Outline, ask the user before opening the PR.
