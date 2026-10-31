# OpenClaw SDK plugin for Synergy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synergy (OpenClaw 2026.10.8) sessions of agent `software-factory` feed the sil loop in world `inkitt`, accepted rules and lessons reach every turn through `before_prompt_build`, and the loop console is reachable as a Control UI tab (read only) and a standalone review page (read and write).

**Architecture:** A thin native OpenClaw plugin (plain ESM, no build) spawns `sil` for ingest and usage, reads a delivery cache file on the turn path, and proxies one `auth: "gateway"` prefix route to `sil web` on loopback. sil materializes a session from the OpenClaw SQLite store into an OpenClaw-format JSONL file, so the worker, critic and evidence pack run unchanged. Worker and web run as systemd user units.

**Tech Stack:** Bun 1.4.2 + TypeScript (`bun:sqlite`, `Bun.zstdDecompressSync`), Svelte 5 web, OpenClaw plugin SDK (Node 24 in the gateway), `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-31-openclaw-sdk-plugin-design.md` (approved 2026-10-31, revised while planning: proxy to `sil web`, widget dropped).

## Global Constraints

- No em or en dashes in any tracked file (`bun run lint:dashes`).
- Plugin handlers never block a turn and never call a model. `before_prompt_build` reads one file only: no spawn, no network.
- Fail loud: no silent default, no localhost fallback. A missing or malformed input is an explicit error or an explicit skip reason, never an empty success.
- The OpenClaw store is opened read only (`?mode=ro`), one session at a time, by primary key. Never a full-table read.
- No writes into `synergy-brain`, no writes to Hindsight, no Postgres.
- Tests that spawn processes pass `env` built from tmp dirs; tests that drive the worker disable `worker.auto_kick` after `sil init`.
- `Object.hasOwn`, never `x in obj`, for lookups keyed by untrusted strings.
- Every bug fix and every guard ships a test that fails without it (mutation check: remove the guard, see the target assertion fail).
- Pilot scope: agent allowlist `["software-factory"]`, world `inkitt`. Both are config, not constants.
- Nothing is installed, enabled or restarted on Synergy in Tasks 1 to 7. Task 8 is host work and each step needs the user's approval.

## Review Focus

1. A session that is still growing when it is materialized: a second materialize after more events must replace the file and move the mtime forward, never append duplicates. (Task 2)
2. A store row with `event_zstd` that does not decode or decodes to invalid JSON: the session fails with the session id and seq in the message, not a partial transcript. (Task 1)
3. A delivery cache written while the plugin reads it: the plugin must never see a torn file. Writes are atomic renames. (Task 4)
4. A proxied request path that tries to escape the prefix (`/plugins/self-improvement-loop/../x`, encoded `%2e%2e`): refused with 400, never forwarded. (Task 6)
5. The `sil web` token file missing or unreadable when a request arrives: 503 with a reason, never a request forwarded without the token. (Task 6)

---

### Task 0: Host contract probes (read only)

No code. Results go into the spec's "verified" list before Task 6 starts.

- [ ] **Step 1:** `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://synergy.inkitt.com/plugins/self-improvement-loop/` with no cookies. Pass: 302 or 401 from oauth2-proxy (the path is covered by the proxy). A 404 from the gateway without a redirect means the proxy does not cover it: stop and report.
- [ ] **Step 2:** On the host, grep the installed `dist/` for the plugin entry loader and record whether a plain `export default function register(api)` is still accepted next to `definePluginEntry`. Pass: a code path that calls a default-exported function. Record file and line.
- [ ] **Step 3:** In `dist/`, find where `registerHttpRoute` handlers are invoked and record whether the handler receives anything beyond `(req, res)` (a runtime-scope accessor). Record the answer; Task 6 uses it if present.

### Task 1: SQLite store reader

**Files:**
- Create: `packages/openclaw/src/store.ts`
- Create: `packages/openclaw/test/fixtures/store.ts` (fixture builder)
- Test: `packages/openclaw/test/store.test.ts`
- Modify: `packages/openclaw/src/index.ts` (export)

**Interfaces:**
- Produces:
  - `class TranscriptSchemaError extends Error { table: string; column: string }`
  - `class TranscriptDecodeError extends Error { sessionId: string; seq: number }`
  - `interface StoreWindow { session_id: string; session_key: string; started_at: number | null; ended_at: number | null; status: string | null; transcript_updated_at: number | null }`
  - `type SessionSource = { kind: "events" } | { kind: "cold-archived" } | { kind: "missing" }`
  - `openStore(file: string): Database` (read only; throws on a missing file with the path)
  - `checkSchema(db: Database): void` (required columns: `transcript_events(session_id, seq, event_json, event_zstd)`, `session_windows(session_id, session_key, ended_at, status, transcript_updated_at)`, `session_transcript_active_events(session_id, active_position, event_seq)`, `session_transcript_cold_archives(session_id)`)
  - `listWindows(db: Database, sinceMs: number): StoreWindow[]` (`transcript_updated_at >= sinceMs`, newest first)
  - `sessionSource(db: Database, sessionId: string): SessionSource`
  - `readSessionEvents(db: Database, sessionId: string): Generator<Record<string, unknown>>` (active events by `active_position` when the session has any, else all by `seq`)
  - `agentStoreFile(agentId: string, env?: NodeJS.ProcessEnv): string` = `<openclawDir>/agents/<agentId>/agent/openclaw-agent.sqlite`

- [ ] **Step 1: Fixture builder.** `buildStore(file, sessions: FixtureSession[])` creates only the four tables above with the verified column names (copy types from the spec's schema notes) and inserts rows. `FixtureSession = { id: string; key: string; events: Array<Record<string, unknown>>; zstd?: boolean; active?: number[]; coldOnly?: boolean; endedAt?: number | null; updatedAt: number }`.
- [ ] **Step 2: Write the failing tests.**
  - `reads plain events in seq order`: two events, `readSessionEvents` yields them in order with `type` `session` then `message`.
  - `decodes zstd events`: same events with `zstd: true`, same output.
  - `follows the active branch`: four events, `active: [0, 1, 3]` (seqs), yields exactly those three.
  - `reports a cold-archived session`: `coldOnly: true`, `sessionSource` returns `{ kind: "cold-archived" }`.
  - `reports a missing session`: unknown id returns `{ kind: "missing" }`.
  - `fails loud on a missing column`: build a store without `event_zstd`, `checkSchema` throws `TranscriptSchemaError` with `table === "transcript_events"` and `column === "event_zstd"`.
  - `fails loud on an undecodable row`: `event_zstd` set to random bytes, iterating throws `TranscriptDecodeError` with the session id and seq.
  - `opens read only`: after `openStore`, an `INSERT` throws and the file's bytes are unchanged (compare sha256 before and after).
  - `lists windows since a time`: three windows, `sinceMs` between them, returns the two newer, newest first.
- [ ] **Step 3: Run** `bun test packages/openclaw/test/store.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 4: Implement `store.ts`.** `new Database("file:" + path + "?mode=ro", { readonly: true })`; `PRAGMA table_info(<table>)` for the schema check; decode with `Bun.zstdDecompressSync` then `JSON.parse`, wrapping both in `TranscriptDecodeError`.
- [ ] **Step 5: Run** the same command. Expected: PASS. Then remove the `checkSchema` column loop and confirm `fails loud on a missing column` fails at its assertion; restore.
- [ ] **Step 6: Commit** `feat: read OpenClaw transcripts from the SQLite store`.

### Task 2: Materialize and queue store sessions

**Files:**
- Create: `packages/openclaw/src/materialize.ts`
- Modify: `packages/openclaw/src/queue.ts` (store-backed enqueue and scan)
- Modify: `packages/core/src/consts.ts` (`SKIPPED_COLD_ARCHIVED`, `SKIPPED_TRANSCRIPT_UNAVAILABLE_PREFIX`)
- Modify: `apps/cli/src/commands/openclaw.ts`, `apps/cli/src/main.ts` (flags)
- Test: `packages/openclaw/test/materialize.test.ts`, `apps/cli/test/openclaw.test.ts`

**Interfaces:**
- Consumes: Task 1 (`openStore`, `checkSchema`, `sessionSource`, `readSessionEvents`, `listWindows`, `agentStoreFile`).
- Produces:
  - `SKIPPED_COLD_ARCHIVED = "skipped: transcript cold-archived"`, `SKIPPED_TRANSCRIPT_UNAVAILABLE_PREFIX = "skipped: transcript unavailable: "`
  - `materializedFile(agentId: string, sessionId: string): string` = `<stateDir>/openclaw/transcripts/<agentId>/<sessionId>.jsonl` (each component through `paths.safeComponent`)
  - `materializeSession(db: Database, agentId: string, window: StoreWindow): { file: string; cwd: string; mtime_ms: number } | { skipped: string }`
  - `enqueueStoreSession(cfg: Config, agentId: string, sessionId: string, opts: EnqueueOptions & { unavailable?: string }): EnqueueResult`
  - `scanStore(cfg: Config, opts: { agents: string[]; maxAgeHours: number; world?: string; env?: NodeJS.ProcessEnv }): EnqueueResult[]`
  - CLI: `sil openclaw enqueue --session <id> --agent <id> [--ended] [--unavailable <reason>]`, `sil openclaw scan --agents <a,b> [--max-age-hours N]`. `--agents` is required when the store is used; with no store file for an agent, that agent's result is an error line and the exit code is 1.

- [ ] **Step 1: Write the failing tests** (fixture from Task 1, env from tmp dirs):
  - `materializes a session as OpenClaw JSONL`: the file's lines parse, the first has `type: "session"` and the fixture `cwd`, and `isOpenclawRecord` is true for it.
  - `sets mtime to transcript_updated_at`: `statSync(file).mtimeMs === window.transcript_updated_at`.
  - `rewrites, never appends, on a second run` (Review Focus 1): materialize, add two events, materialize again; line count equals the new event count and mtime moved forward.
  - `cold-archived session is skipped with a reason`: returns `{ skipped: SKIPPED_COLD_ARCHIVED }` and `enqueueStoreSession` writes the entry to bucket `done` with that result.
  - `unavailable reason is recorded`: `enqueueStoreSession(..., { unavailable: "incognito" })` with no events writes `done` with result `SKIPPED_TRANSCRIPT_UNAVAILABLE_PREFIX + "incognito"`; with events present the reason is ignored and the session is queued.
  - `scan only queues allowlisted agents`: two agent stores, `agents: ["software-factory"]`, only that agent's sessions are queued.
  - `queue entry points at the materialized file`: `transcript_path === materializedFile(...)` and `world` is the forced world when given.
  - `worker reads a materialized session end to end`: run `evidencePack(entry.transcript_path, entry.cwd)` and assert `counts.user_prompts >= 1`.
- [ ] **Step 2: Run** `bun test packages/openclaw/test/materialize.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Write to `<file>.tmp` then rename, then `utimesSync` with `transcript_updated_at`. `enqueueStoreSession` reuses `enqueueSession` by building an `OpenclawSession` from the materialized result (`agent_id`, `session_id`, `file`, `cwd`, `mtime_ms`). Skips use `writeEntry("done", ...)` with the result set.
- [ ] **Step 4: Run** the tests. Expected: PASS. Then `bun run test:changed`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: queue OpenClaw store sessions through a materialized transcript`.

### Task 3: Evidence redaction before the critic

**Files:**
- Create: `packages/transcript/src/redact.ts`
- Modify: `packages/transcript/src/index.ts` (export), `packages/critic/src/index.ts:320` (apply)
- Test: `packages/transcript/test/redact.test.ts`, `packages/critic/test/critic.test.ts`

**Interfaces:**
- Produces:
  - `class RedactionConfigError extends Error {}`
  - `interface RedactionPattern { name: string; re: RegExp }`
  - `loadRedactionPatterns(file: string): RedactionPattern[]` (file is a JSON array of `[name, source, flags]`; flags must include `g`; each `source` at most 512 chars; any bad entry throws `RedactionConfigError` naming its index)
  - `redactText(text: string, patterns: RedactionPattern[]): string` (replacement `<REDACTED:<name>>`; also applies `SECRET_RE` from `@sil/core` under name `secret`)
  - `redactEvidencePack(pack: EvidencePack, patterns: RedactionPattern[]): EvidencePack` (every string field, including nested arrays; returns a new object)
  - Env `SIL_REDACTION_PATTERNS=<file>`: when set, the critic loads it once per process and applies it; when set and unloadable, the reflection fails with `RedactionConfigError`. When unset, behaviour is unchanged.

- [ ] **Step 1: Write the failing tests:** a pack with an `sk-ant-...` style key in a prompt, a bash tail and a diff excerpt comes back with `<REDACTED:anthropic_key>` in all three and nothing else changed; a file with `[["x", "(", "g"]]` throws `RedactionConfigError` mentioning index 0; flags without `g` throw; a 513-char source throws; in `critic.test.ts`, with `SIL_REDACTION_PATTERNS` pointing at a missing file, the reflection fails and the fake model is never called.
- [ ] **Step 2: Run** `bun test packages/transcript/test/redact.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** and wire `redactEvidencePack` right after the `evidencePack(...)` call in the critic, before anything is sent.
- [ ] **Step 4: Run** both test files. Expected: PASS. Mutation: skip the call in the critic, see the critic test fail at the "model never called" or redacted-text assertion; restore.
- [ ] **Step 5: Commit** `feat: redact the evidence pack before it reaches the critic`.

### Task 4: Delivery cache and the small CLI verbs

**Files:**
- Create: `packages/openclaw/src/delivery.ts`
- Modify: `apps/cli/src/commands/openclaw.ts`, `apps/cli/src/main.ts`
- Test: `packages/openclaw/test/delivery.test.ts`, `apps/cli/test/openclaw.test.ts`

**Interfaces:**
- Consumes: `rulesText(world)`, `renderBlock` budget `MAX_BLOCK_CHARS` and `DEFAULT_LESSON_LIMIT` from `workspace.ts`; `listLessons`, `markDelivered` from `@sil/store`; `appendUsage` from `@sil/feedback`.
- Produces:
  - `interface DeliveryCache { version: 1; world: string; generated_at: string; rules: string; lessons: Array<{ id: string; text: string }> }`
  - `deliveryCacheFile(world: string): string` = `<stateDir>/openclaw/delivery-<world>.json`
  - `buildDeliveryCache(world: World, limit?: number): DeliveryCache` (pure read; rules trimmed with the existing `(rules trimmed by sil)` marker; lessons while they fit `MAX_BLOCK_CHARS`)
  - `writeDeliveryCache(world: World, limit?: number): string` (atomic: tmp then rename; returns the path)
  - `recordSessionDelivery(worldName: string, sessionId: string, lessonIds: string[]): string[]` (calls `markDelivered` per id; ignores ids already recorded for this session in `<stateDir>/openclaw/delivered/<sessionId>.json`; returns ids counted now)
  - CLI: `sil openclaw deliver --world <w>`, `sil openclaw delivered --world <w> --session <id> --lessons <a,b>`, `sil openclaw usage --world <w> --session <id> --skill <name>` (writes one `kind: "skill"` usage event through `appendUsage`).
  - `sil openclaw sync` (the AGENTS.md writer) prints a deprecation line on stderr for OpenClaw 2026.9.4 or later and keeps working.

- [ ] **Step 1: Write the failing tests:** cache JSON matches `DeliveryCache` and holds the accepted rule text verbatim; two lessons fit, a third over the budget is left out; `buildDeliveryCache` does not change any delivery count; `recordSessionDelivery` called twice for one session counts once, for two sessions counts twice; five sessions archive the lesson (same rule as `markDelivered`); an interrupted write (simulate by writing the tmp file only) leaves the previous cache readable and intact (Review Focus 3).
- [ ] **Step 2: Run** `bun test packages/openclaw/test/delivery.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the module and the three verbs.
- [ ] **Step 4: Run** the tests, then `bun run test:changed`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: write a delivery cache and count deliveries once per session`.

### Task 5: Web console under a prefix and read-only when embedded

**Files:**
- Modify: `apps/web/src/lib/api.ts:84-95`, `apps/web/src/lib/stream.ts:40`, `apps/web/src/lib/curated-lessons.ts:82`
- Create: `apps/web/src/lib/embed.ts`
- Modify: the shell component that renders the header (add "Open review" link)
- Test: `apps/web/test/api.test.ts`, `apps/web/test/embed.test.ts`

**Interfaces:**
- Produces:
  - `apiPath(name: string): string` returns `"api/" + name.replace(/\./g, "/")` (relative to the page). Used by `api.ts` and `curated-lessons.ts`; the duplicate `pathFor` in `curated-lessons.ts` is deleted.
  - stream URL `new URL("api/logs/stream", document.baseURI)`.
  - `isEmbedded(win?: Window): boolean` = `win.self !== win.top` (a thrown cross-origin access also means embedded).
  - `class ReadOnlyError extends Error {}`; `call()` in `api.ts` throws it for any non-GET op when `isEmbedded()`. This is the single write point; buttons hide on top of it, not instead of it.
  - `reviewHref(loc: Location): string` = `loc.origin + loc.pathname + "#/review"`, opened with `target="_blank" rel="noopener"`.

- [ ] **Step 1: Write the failing tests:** `apiPath("review.detail") === "api/review/detail"`; with a page at `/plugins/self-improvement-loop/`, the resolved fetch URL is `/plugins/self-improvement-loop/api/review/detail`; in a fake embedded window, `call("review.accept", ...)` rejects with `ReadOnlyError` and `fetch` is never called; `call("review.detail", ...)` still fetches; `reviewHref` drops any token fragment.
- [ ] **Step 2: Run** `bun test apps/web/test/api.test.ts apps/web/test/embed.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `bun run check:web`. Expected: PASS. Run `sil web` locally and confirm the console still loads at `/` and all panes load data (relative paths resolve the same at the root).
- [ ] **Step 5: Commit** `feat: serve the console under a path prefix and read only in a frame`.

### Task 6: OpenClaw plugin on the SDK

**Files:**
- Modify: `integrations/openclaw/plugin/index.mjs` (rewrite), `integrations/openclaw/plugin/openclaw.plugin.json`
- Create: `integrations/openclaw/plugin/prompt.mjs`, `integrations/openclaw/plugin/proxy.mjs`, `integrations/openclaw/plugin/spawn.mjs`
- Modify: `packages/openclaw/src/install.ts` (copy the new files; write `agents`, `webPort`, `tokenFile`, `cacheFile` into `sil-config.json`)
- Test: `integrations/openclaw/test/plugin.test.ts` (new; fake `api`)

**Interfaces:**
- Consumes: CLI verbs from Tasks 2 and 4; cache format `DeliveryCache` from Task 4; `sil web` API and `X-SIL-Local` / `X-SIL-Token` headers (`apps/server/src/guard.ts`); token file `paths.webTokenFile()`; Task 0 results.
- Produces:
  - Manifest: version `0.3.0`, `uiCapabilities: ["page", "navigation"]`, `configSchema` with `sil`, `world`, `agents` (string array), `cacheFile`, `webPort` (integer), `tokenFile`. Remove `bootstrapFile` and `sync`.
  - `prompt.mjs`: `readDelivery(file, log): { appendSystemContext?: string; prependContext?: string; lessonIds: string[] }`. File size cap 64 KiB; missing file logs once per process and returns `{ lessonIds: [] }`; malformed or wrong `version` logs every call with the error and returns `{ lessonIds: [] }`.
  - `proxy.mjs`: `checkRequest(req, gatewayOrigin): { ok: true; path: string } | { ok: false; status: number; reason: string }` and `forward(req, res, { port, token, path }): Promise<void>` (streams both ways, sets `Host: 127.0.0.1:<port>`, `X-SIL-Local: 1`, `X-SIL-Token`).
  - Route: `registerHttpRoute({ path: "/plugins/self-improvement-loop", match: "prefix", auth: "gateway", handler })`.
  - Tab: `api.session.controls.registerControlUiDescriptor({ surface: "tab", id: "loop", label: "Self-improvement", slug: "self-improvement", group: "control", requiredScopes: ["operator.read"], path: "/plugins/self-improvement-loop/" })`.
  - Hooks: `session_end` (allowlist; `--unavailable <reason>` when `ctx.endedTranscript?.available === false`), `after_tool_call` (skill read, spawns `sil openclaw usage`), `before_prompt_build` (allowlist; returns the cache result; first time per `sessionId` in this process spawns `sil openclaw delivered`; the seen-set is capped at 10000 ids, oldest dropped).

- [ ] **Step 1: Write the failing tests** with a fake `api` that records registrations and a fake `child_process.spawn`:
  - registers exactly the three hooks, one route with `auth: "gateway"` and `match: "prefix"`, and one tab descriptor with the values above.
  - `before_prompt_build`: valid cache returns rules in `appendSystemContext` and lessons in `prependContext`; missing cache returns no context and logs once across two calls; malformed cache logs on both calls; an agent outside `agents` gets nothing and spawns nothing; two turns of one session spawn `delivered` once; the handler never spawns anything except that one call (assert spawn count).
  - `checkRequest`: GET passes; POST with `Sec-Fetch-Dest: iframe` is 403; POST with a foreign `Origin` is 403; POST without `application/json` is 415; POST from the gateway origin with JSON passes; `/plugins/self-improvement-loop/../x` and `%2e%2e` forms are 400 (Review Focus 4).
  - `forward` with the token file missing returns 503 with a reason and opens no connection (Review Focus 5); with a token it sets the three headers (assert on a local `Bun.serve` stub that echoes headers).
  - `session_end` for an allowlisted agent spawns `sil openclaw enqueue --session <id> --agent <id> --ended`, with `--unavailable incognito` when `endedTranscript` says so.
- [ ] **Step 2: Run** `bun test integrations/openclaw/test/plugin.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the plugin dependency free (Node built-ins only). Entry style follows Task 0 Step 2. If Task 0 Step 3 found a scope accessor, also refuse non-GET without `operator.write`, with its own test.
- [ ] **Step 4: Run** the tests. Mutation: remove the `Sec-Fetch-Dest` check, see that test fail; restore. Then `bun test integrations/openclaw` and `bun run lint:dashes`. Expected: PASS. (`integrations/` is not a workspace, so `test:changed` does not cover it: run it by path.)
- [ ] **Step 5: Commit** `feat: rebuild the OpenClaw plugin on the plugin SDK`.

### Task 7: systemd units, docs, end-to-end test

**Files:**
- Create: `integrations/openclaw/systemd/sil-worker.service`, `sil-worker.timer`, `sil-web.service`, `sil-openclaw-scan.timer`, `sil-openclaw-scan.service`, `sil-deliver.timer`, `sil-deliver.service`
- Modify: `docs/OPENCLAW.md` (rewrite), `docs/ARCHITECTURE.md` ("Other hosts" section)
- Test: `tests/openclaw-e2e.test.ts`

**Interfaces:**
- Units use `%h/.bun/bin/bun` and the sil checkout path as `ExecStart`; `EnvironmentFile=%h/.config/sil/env` (mode 600, holds `LITELLM_API_KEY` and `SIL_REDACTION_PATTERNS`); scan every 10 minutes with `--agents software-factory --max-age-hours 24`; deliver every 2 minutes and after each worker run (`ExecStartPost`); web with `--host 127.0.0.1 --port 8768 --token`.

- [ ] **Step 1: Write the failing end-to-end test** through the real modules (tmp HOME, fake model provider, `worker.auto_kick` off): fixture store for `software-factory` -> `scanStore` -> worker pass -> one staged item -> accept through the `sil web` handler with its `reviewed_state` -> `writeDeliveryCache` -> plugin `readDelivery` returns the accepted rule text verbatim.
- [ ] **Step 2: Run** `bun test tests/openclaw-e2e.test.ts`. Expected: FAIL until wiring is complete; fix wiring only, not the earlier tasks' contracts.
- [ ] **Step 3: Write the units and docs.** `docs/OPENCLAW.md` covers: SQLite store and materialization, the plugin's hooks and the two config grants (`allowConversationAccess: true`, prompt injection left on), tab and standalone review page, the proxy guards, units, redaction env, limits (widget not in v1, actor not recorded, Mac and Synergy worlds do not share lessons). The file and AGENTS.md path is marked legacy for OpenClaw before 2026.9.4.
- [ ] **Step 4: Run the CI set in order:** `bun install`, `git diff --exit-code -- bun.lock`, `bun run lint:dashes`, `bun run typecheck`, `bun run check:web`, `bun run build`, `bun test`. Record each command's own exit code.
- [ ] **Step 5: Commit** `docs: document the OpenClaw SDK plugin and its units`.

### Task 8: Pilot on Synergy (host work, each step approved separately)

Not run by an implementer. Each step is proposed to the user with its undo command.

- [ ] Clone the sil release onto the host as user `openclaw`; `bun install`; `bun run build`. Undo: remove the checkout.
- [ ] `sil init`, world `inkitt`; env file at mode 600. Undo: remove the state dir.
- [ ] `sil openclaw scan --agents software-factory --max-age-hours 24 --json` once, timed. Undo: `sil queue clear`.
- [ ] Install and start the units. Undo: `systemctl --user disable --now` each.
- [ ] `sil openclaw install --enable`, then add `allowConversationAccess: true` for the plugin entry (dry run first), then `openclaw plugins reload`. Undo: `openclaw plugins disable self-improvement-loop` and restore `openclaw.json.sil-bak`.
- [ ] Acceptance 1 to 6 from the spec, each checked by reading the system.
