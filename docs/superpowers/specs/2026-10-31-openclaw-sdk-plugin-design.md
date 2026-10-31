# OpenClaw SDK plugin for Synergy: design

Status: draft, Q1 to Q4 answered by the user on 2026-10-31 ("Answers" at the end).
Waiting for approval of the design as revised by those answers.
Branch: `feat/openclaw-sdk-plugin`, base `31da0f8` (v1.5.1).

## Why

The current OpenClaw integration (`integrations/openclaw/plugin`, `@sil/openclaw`,
`docs/OPENCLAW.md`, verified on OpenClaw 2026.2.26) cannot work on Synergy:

- It finds sessions as `~/.openclaw/agents/<id>/sessions/*.jsonl`. Synergy has none
  of those files: read on the host on 2026-10-31, the count is 0. Since OpenClaw
  2026.9.4 transcripts live in SQLite.
- It delivers lessons by writing a managed block into the workspace `AGENTS.md`. On
  Synergy the workspace is the `synergy-brain` repo, and a 10 minute cron pushes
  workspace changes to it. A machine-written block would reach a shared remote with
  no human in between, which breaks design rule 4.
- It assumes no per-turn context hook exists. OpenClaw now has one.

The user also wants a view of the loop inside the OpenClaw Control UI.

## What was verified on the host (2026-10-31, read only)

Host `openclaw@10.1.11.52`, nothing changed, no config or secrets read.

- `openclaw --version`: `OpenClaw 2026.10.8 (dc2523e)`.
- These names are present in the installed `dist/` and in the bundled
  `docs/plugins/`: `definePluginEntry`, `before_prompt_build`,
  `appendSystemContext`, `prependContext`, `after_tool_call`, `endedTranscript`,
  `allowConversationAccess`, `registerControlUiDescriptor`, `registerHttpRoute`,
  `registerService`, `registerGatewayMethod`, `registerSessionAction`,
  `uiCapabilities`. Presence in the bundle is not runtime proof; see "Acceptance".
- Transcript stores: `~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite` for
  `software-factory` (6.9 GB), `inkitt` (1.4 GB), `sre` (157 MB), `openclaw`
  (0.7 MB).
- Schema read from the `openclaw` agent store with `mode=ro`:
  - `transcript_events(session_id, seq, event_json, created_at, event_zstd,
    event_utf8_bytes, navigation_json)`, primary key `(session_id, seq)`. Exactly
    one of `event_json` and `event_zstd` is set.
  - `session_windows(session_id, session_key, started_at, ended_at, status,
    transcript_updated_at, model_provider, model, parent_session_key, spawned_by,
    ...)`.
  - `session_transcript_active_events(session_id, active_position, event_seq, ...)`
    holds the active branch after rewind or compaction.
  - `session_transcript_cold_archives(session_id, storage 'file'|'sqlite',
    archive_blob, ...)`: an old session can leave `transcript_events`.
- Bun is installed at `~/.bun/bin/bun` and is not on `PATH`. `bun --version`
  prints `1.4.2`, the same as `.bun-version`, and `Bun.zstdDecompressSync` is a
  function. Node is v24.22.1. There is no `sqlite3` CLI.
- `gateway.auth.mode` is `trusted-proxy` (keys `allowLoopback`, `allowUsers`,
  `deviceAutoApprove`, `requiredHeaders`, `userHeader`; values not read).
  `gateway.controlUi.basePath` is unset.
- From the bundled `architecture-internals/gateway-routes.md`: an `auth:
  "gateway"` route gets `operator.write` for a `trusted-proxy` caller that sends no
  `x-openclaw-scopes`. Inside the sandboxed tab the frame is cross-site, so its
  grant allows only `GET` and `HEAD`; "mutations and WebSocket upgrades stay on
  explicit Gateway-authenticated surfaces".
- From the bundled docs: `session_end` gives `ctx.endedTranscript` as
  `{ available: true, readTail }` or `{ available: false, reason }`. `readTail`
  needs positive `maxMessages` and `maxBytes`, the host caps both, and the result
  carries `truncated`. The reader dies when the handler settles.
- From the bundled docs: a `surface: "tab"` descriptor with `path` under a
  same-plugin `auth: "gateway"` HTTP route renders in a sandboxed frame. The frame
  grant allows only `GET` and `HEAD` with `operator.read`. `requiredScopes` hides
  the tab and never widens the grant. Mutations must use a Gateway-authenticated
  surface. HTTPS is required.

Other context comes from memory and was not re-read on the host: the gateway runs
as a systemd user unit of `openclaw`, it has run out of heap before and restarted,
the `openclaw` user has passwordless sudo, there is no sandbox and
`tools.profile` is `full`. The memory slot is held by `hindsight-openclaw` with bank
`inkitt`.

## Goals

1. Synergy sessions reach the sil reflection queue and are reflected with the same
   worker, critic and evidence pack as Claude Code sessions.
2. Accepted rules and lessons reach Synergy agents every turn, without any file
   write into `synergy-brain`.
3. A Control UI tab shows the loop state for the Synergy world (the widget is
   dropped from v1, see section 3).
4. Review decisions keep the `reviewed_state` digest binding (rule 4).
5. The plugin never blocks or slows a turn beyond a fixed budget and never calls a
   model (rule 1 applies to the plugin as it does to hooks).

## Non-goals

- No Postgres. sil state stays in its SQLite under the sil state dir on the host.
  Revisit only if workers run on more than one machine.
- No writes to the Hindsight bank `inkitt` and no use of the memory slot.
- No lesson retrieval by relevance (variant 3). It may come later through a
  separate Hindsight bank fed only after accept.
- No change to the existing Claude Code paths.
- No deploy in this branch. Installing on Synergy is a separate, approved step.

## Design

### Components

```
OpenClaw gateway (node)                     sil on the host (bun)
+-------------------------------+           +---------------------------+
| plugin "self-improvement-loop"|  spawn    | sil openclaw enqueue      |
|  session_end   ---------------+---------->|   (queue entry, ended)    |
|  after_tool_call --------------+--spawn--->| sil openclaw usage        |
|  before_prompt_build <- cache +<----------+ sil openclaw deliver      |
|  HTTP route (tab, GET only) --+--proxy--->| sil web on 127.0.0.1      |
|  HTTP route (page, POST) -----+--proxy--->|   (token, own guards)     |
|  widget descriptor            |           | sil worker (own unit)     |
+-------------------------------+           +-------------+-------------+
                                                          | read only
                                            openclaw-agent.sqlite files
```

Revision after the user's approval (2026-10-31, while planning): the route
proxies to `sil web` instead of piping to `sil ops`. Reason: `sil ops` dispatches
only curation mutations ("only curation mutations run through this dispatcher",
`packages/ops/src/mutation.ts`), while review accept and reject with
`reviewed_state` are served by the `sil web` HTTP API. Proxying keeps one path for
reads and mutations, with the server's own Host, `X-SIL-Local` and token guards.

The plugin stays thin, as today. All loop logic stays in sil. The plugin is plain
ESM with no build step, as today, and is checked by a contract test against the
SDK names listed above.

### 1. Ingest

- `session_end`: spawn `sil openclaw enqueue --session <id> --agent <agentId>
  --ended`, detached. The plugin does not use `endedTranscript` to read the body:
  the tail is capped and dies with the handler. It reads only
  `endedTranscript.available` and, when false, passes `--unavailable <reason>` so
  the queue entry records why.
- New reader for the SQLite store in `@sil/openclaw`. It materializes the session
  as an OpenClaw-format JSONL file under the sil state dir and sets the queue
  entry's `transcript_path` to it, with the file mtime set to
  `transcript_updated_at`. The worker's idle window, `countToolUses` and
  `evidencePack` then work unchanged. Event records in the store have the same
  shape as the old JSONL lines (probe on the `sre` store, keys only: `session`
  header with `cwd`, `message` with `message.role`); one new type,
  `custom_message`, is already dropped by `adaptOpenclawRecords`.
  - Opens the store with `bun:sqlite` read only (`?mode=ro`), one session at a time,
    by primary key, ordered by `seq`. Never scans the whole table.
  - Decodes `event_zstd` with Bun's zstd. If the installed Bun has no zstd, the
    read fails with an explicit error naming the Bun version. No fallback.
  - Follows `session_transcript_active_events` when it has rows for the session, so
    a rewound branch is not reflected as if it happened.
  - A session found only in `session_transcript_cold_archives` is retired as
    `skipped: transcript cold-archived` in v1, not `failed`.
  - Before reading, checks the columns it needs exist (`PRAGMA table_info`). A
    missing column raises `TranscriptSchemaError` naming the column and the
    OpenClaw version from `meta`. This is an internal schema, so the reader must
    fail loud when it changes.
  - Feeds decoded events through the existing `adaptOpenclawRecords`, so the
    critic sees one format.
- `sil openclaw scan` gains the SQLite source: list `session_windows` rows with
  `transcript_updated_at` newer than the window and enqueue them. This covers
  sessions that never end. The schedule stays as documented today.
- Session id: `session_windows.session_id`. Usage events carry the same id, which
  closes the documented gap where usage events used the session key.

### 2. Delivery

- `sil openclaw deliver --world <w> --out <cache.json>` writes the rules and lessons
  block to a cache file in the sil state dir. It runs after each worker pass and
  after each accept.
- `before_prompt_build` reads that cache file synchronously (one small file, size
  capped) and returns rules in `appendSystemContext` (stable, small) and lessons in
  `prependContext`. No CLI call, no network, no model on the turn path.
- Budget: the handler must finish under 5 ms on the host. A missing cache file
  returns nothing and logs once per gateway start. A malformed cache file returns
  nothing and logs every time with the parse error: that is a defect, not a quiet
  state (rule 7). The widget shows both states.
- Delivery counting: a lesson counts as delivered once per session, not once per
  turn. On the first injection per `session_id` the plugin spawns `sil openclaw
  delivered --session <id> --lessons <ids>`, detached; sil counts through
  `markDelivered`, its single write point. Five sessions archive it, which keeps
  today's meaning. Skill usage goes the same way (`sil openclaw usage`) instead of
  the plugin appending to `usage/events.jsonl` itself.
- Needs `allowConversationAccess: true` and `allowPromptInjection` left at its
  default for this plugin entry. That is a config change on Synergy, applied by
  hand after approval.

### 3. Control UI

- Tab: `registerControlUiDescriptor({ surface: "tab", id: "loop", slug:
  "self-improvement", group: "control", requiredScopes: ["operator.read"] })` with
  `path` under `registerHttpRoute({ auth: "gateway" })`.
- The route (`match: "prefix"`) proxies to `sil web` on `127.0.0.1:<port>`: it
  strips the route prefix, sets `Host` to the loopback address, adds
  `X-SIL-Local` and `X-SIL-Token` from the 0600 token file, and streams the
  response (the log stream is SSE). `sil web` serves the bundle and the API.
- `apps/web` changes: all API URLs relative to the page (today they are absolute
  `/api/...`); an embedded mode, detected from the host, that hides mutation
  buttons and shows "Open review" instead, linking to the standalone page below;
  no token in the fragment when served by the plugin, since gateway auth does it.
- Widget: dropped from v1. The bundled `feature-plugins.md` says "a native view
  renders only when its matching backend descriptor is advertised", so a widget
  needs a native Control UI view, which external plugins cannot ship. The tab's
  first screen shows queue depth, items waiting for review, the last worker pass
  and the delivery cache state instead.
- Route handler signature from the bundled docs: `handler: async (req, res) =>
  boolean`, Node style. The docs do not name an accessor for the runtime scope
  inside the handler. With `trusted-proxy` and no `x-openclaw-scopes`, every
  request that reaches an `auth: "gateway"` route runs with `operator.write`, and
  the frame grant already refuses non-GET at the gateway. The plugin's own Origin
  and `Sec-Fetch-Dest` checks are a second layer, not the only one.

### 4. Review decisions

Decisions happen in the web UI (Q1). The embedded tab cannot POST, so the same
plugin route also serves the console as a standalone, top-level page, for example
`https://synergy.inkitt.com/plugins/self-improvement-loop/review`. A top-level
request goes through oauth2-proxy, the gateway authenticates it as
`trusted-proxy`, and the `auth: "gateway"` route runs with `operator.write`.

- The tab is read only and links to the standalone page in a new browser tab.
- Mutations: any non-GET/HEAD request on the same route and auth level
  (overlapping routes with different auth levels are rejected).
- The proxy forwards a non-GET/HEAD request only when all hold: the runtime scope
  includes `operator.write`; the request is not from the sandboxed frame (`Origin`
  equals the gateway origin and `Sec-Fetch-Dest` is not `iframe`); `Content-Type`
  is `application/json`. Anything else gets a 4xx with a reason and never reaches
  `sil web`. The `reviewed_state` digest is checked by `sil web` as it is today.
- Recording which user made a decision is a follow-up, not v1: the server has
  no actor field today. The plugin never reads `x-forwarded-email` itself.
- Not `auth: "plugin"`: port 18789 also listens on the private address, so a
  plugin that trusted the proxy header itself could be spoofed from the LAN.

Open item for the plan: confirm on the host that oauth2-proxy forwards
`/plugins/...` paths and that the route's runtime scope is visible to the handler.
Until that probe passes, the design is source-reviewed only.

### 5. Worker

A separate systemd user unit `sil-worker.service` for the `openclaw` user (Q2),
with the absolute Bun path and `LITELLM_API_KEY` from an env file at mode 600. Not
`registerService`: the gateway has run out of heap and restarted before, and a
worker inside its cgroup adds memory pressure and dies with it. A second unit,
`sil-web.service`, runs `sil web --host 127.0.0.1 --port <port> --token` (the
token is forced on loopback because agents on the host have no sandbox). The
plugin reads worker state through the proxied API.

### 6. Scope of the pilot

World `inkitt` (Q3) and agent `software-factory` only (Q4, "flash": the Flash
agents were merged into `software-factory`). The plugin takes an `agents`
allowlist; sessions of other agents are ignored at `session_end`, in `scan` and in
`before_prompt_build`. `software-factory` has the largest store (6.9 GB), so the
reader's by-key access and the scan's `transcript_updated_at` window are tested
against a fixture with many sessions, and the first host run is timed.

The sil instance on Synergy is its own install with its own state. World
`inkitt` there is not the `inkitt` world of the sil on the Mac: lessons do not
cross between the two. Sharing them would need a shared store, which is out of
scope (see Non-goals).

### 7. Redaction

Synergy transcripts contain secrets: the Hindsight plugin needs a local redaction
patch for that reason. The critic sends transcript excerpts to a model. Before
this ships to Synergy, the evidence pack must pass through a redaction step with at
least the patterns the host already uses. Scope of that step is its own task in
the plan.

## Failure modes

| Case | Result |
| --- | --- |
| `sil` missing or broken | plugin logs once per handler kind, turns are unaffected |
| `endedTranscript.available` false | queue entry records the reason; scan still finds the session |
| store schema changed | `TranscriptSchemaError`, entry `failed` with the column name |
| session cold-archived | `skipped: transcript cold-archived` |
| Bun without zstd | explicit error at read, worker pass fails loud |
| cache file missing | no injection, logged once, widget shows "no delivery cache" |
| cache file malformed | no injection, logged every time, widget shows the error |
| frame blocked by browser privacy mode | host shows unavailable panel (host behaviour) |

## Tests

- Transcript reader: fixture store built from the verified schema (plain, zstd,
  active branch, cold-archived only, missing column). Each case asserts the decoded
  records or the exact error. The missing-column case must fail on a tolerant
  reader (mutation check).
- Plugin contract: load `index.mjs` with a fake `api` and assert the registered
  hooks, descriptors and route; `before_prompt_build` with valid, missing and
  malformed cache; the route refuses a mutation from the frame (`Sec-Fetch-Dest:
  iframe`), from a foreign `Origin`, without `operator.write`, without JSON, and
  each with its own reason, and forwards a valid one to `sil web` with the token;
  sessions of agents outside the allowlist are ignored.
- Delivery counting: one session, many turns, one count.
- End to end through the real modules: fixture store to queue to worker (fake
  model) to accept via `sil ops` to cache to `before_prompt_build` output.
- `apps/web`: relative URLs and read-only mode.

## Acceptance (on the host, after approval, separate from this branch)

1. Plugin loads on 2026.10.8: `openclaw plugins list` shows it enabled, gateway log
   shows the registrations.
2. One real session ends and its queue entry appears with the right session id.
3. The worker reflects it from the SQLite store.
4. After one accept, a new turn's prompt carries the block (checked with the
   gateway's raw stream or a probe session matching `agent:*:probe-*`, which the
   Hindsight plugin already ignores).
5. The tab renders over `synergy.inkitt.com` and the widget shows real numbers.
6. One accept from the standalone page succeeds with the right digest, and the
   same request replayed from the embedded tab is refused.

## Docs

Rewrite `docs/OPENCLAW.md` for the SDK plugin and the SQLite store, and mark the
file and `AGENTS.md` paths as legacy for OpenClaw before 2026.9.4. Update the
"Other hosts" section of `docs/ARCHITECTURE.md`.

## Answers (user, 2026-10-31)

- Q1. Review decisions in the web UI. Realised as the standalone page in section
  4, since the embedded tab cannot POST by host design.
- Q2. The recommended way: separate systemd user unit.
- Q3. World `inkitt`. Correction to the question as first asked: the sil on
  Synergy has its own state, so this names the world there and does not share
  lessons with the Mac's `inkitt` world.
- Q4. "flash", read as agent `software-factory`.
