# self-improvement-loop v2 (TypeScript + Bun): build plan

Design: `docs/ARCHITECTURE.md`. The interim Python V2 was the port source and is
gone from the tree (last Python commit 97d8b42). Default branch is `main`
(fast-forwarded from `feat/loop-v2`), repo is private, license is proprietary.

## Phase 0: contracts
- [x] monorepo: workspaces, tsconfig, bunfig, scripts/build.ts (committed dist/ + srchash), scripts/lint-dashes.ts
- [x] @sil/core, @sil/store with tests; typed stubs for the rest; apps/web skeleton

## Phase 1: parallel port
- [x] A @sil/nudges + apps/hook (bundle, exit 0 always, 14 ms p50)
- [x] B @sil/transcript, providers, critic, feedback, worker (+ outline export)
- [x] C @sil/curriculum (git, artifacts, lint, router, prompts, plan, run) + @sil/review
- [x] D @sil/ops + apps/server (Bun.serve) + apps/web (Svelte 5, 9 panes)
- [x] E apps/cli (commander), schedule, importer, hooks.json -> dist/hook.js, commands, docs, scripts/sil

## Phase 2: integration
- [x] bun install, typecheck, bun test green (699 pass, 51 files)
- [x] bun run build; dist drift test; hooks.json points at dist/hook.js
- [x] tests/e2e.test.ts: hook bundle -> queue -> worker (fake chat) -> reflection -> inbox -> SessionStart; reflections -> run -> review -> accept -> relink; HTTP API
- [x] browser smoke of the Svelte UI (Overview, Review detail + diff, Accept)
- [x] independent review (hook, curriculum/review, web security); all blockers fixed in a7d0e41
- [x] Python tree removed, docs updated
- [x] commits on feat/loop-v2

## Phase 3: repository decisions (done 2026-09-14)
- [x] repo set to private
- [x] `main` created from `feat/loop-v2` (c01128d), pushed, set as default branch
- [x] license switched to proprietary (LICENSE, plugin.json, package.json, README)
- [ ] delete `feat/loop-v2` on origin and the stale local `master` (cc10ccb) once nothing references them
- [ ] decide whether the MIT commit in history matters; the repo was public for about 5 hours

## Phase 4: release (operator)
- [ ] `scripts/register-marketplace.sh`, push its branch, open the PR to kolezka/marketplace
- [ ] `claude plugin marketplace update kolezka` and `claude plugin install self-improvement-loop@kolezka`
- [ ] confirm the installed plugin carries dist/ and that dist/hook.js runs in a real session (logs/hook.log)

## Phase 5: first run (operator)
- [ ] `sil init`; set LiteLLM base_url, LITELLM_API_KEY and the critic/drafter/judge models in llm.yaml
- [ ] optional dotfiles-next world: `sil worlds add ... --layout v1 --target ~/Development/dotfiles-next`, then `sil import reflections`, `sil import ledger`, `sil worlds import-kb`
- [ ] `sil schedule install --systemd --web`; check `sil status` and the Queue pane after an hour
- [ ] disable the old nudge-dispatch hooks in dotfiles-next so only one dispatcher runs

## Phase 6: engineering follow-ups
- [x] `sil web` picks up a plugin update by itself: it polls the install path and dist/.srchash, exits 0, and systemd (Restart=always) or launchd restarts it on the new version; the web token is now stored so open tabs survive the restart
- [ ] live model run of critic, drafter and judge; prompts are unverified beyond fake chat
- [ ] exercise `remote: pr` against GitHub and the Outline export against a live server
- [ ] worker lock is a pid file with a 60 ms reclaim window; consider flock via FFI
- [ ] a lint-clean regex gate is bounded only by JavaScriptCore's backtracking cap inside one hook call
- [x] release workflow: manual bump, build, tag + `release` branch + zip asset (`.github/workflows/release.yml`)
- [x] CI workflow on push/PR: `.github/workflows/ci.yml`. It now builds before the tests, because `dist/` is untracked and the drift test skips without a build.
- [ ] second review by another model family (Codex) before use on employer repos
- [ ] Codex and OpenCode have no hook equivalent; V1 had a parity build, V2 has none

## Web UI version badge (done 2026-09-19)
- [x] inject the root package.json version into the Svelte bundle via a vite `define`
- [x] show it as `v<version>` in the web UI footer next to the worker badge
- [x] test locks the define to the root package.json version, verified failing without it

## Phase 7: System One endpoints (Jev / Laya)

Jev (TypeSafe AI) and Laya (Convai, Apache-2.0 open weights) answer typed
decisions, not text: one `POST /v1/systemone` call returns a calibrated
probability per question. Laya servers (arbiter, lajev, laya-rs) speak the same
API, so one endpoint kind covers both. `judge` is the only role in this loop
whose answer is a decision, so it is the only role a System One endpoint serves.

- [x] `Endpoint.kind` gains `system-one`; `decision_threshold` field (default 0.5)
- [x] `useEndpoint` refuses a System One endpoint for critic, drafter or `active`
- [x] `@sil/providers`: `decide()` transport, `chat()` refusal, `systemOneEndpoint()`, reachability probe
- [x] curriculum: `judgeQuestions()` (five reject rules as nouls) + `verdictFromNouls()`
- [x] `run.ts` judge gate takes the typed path when the judge endpoint is System One
- [x] tests: providers transport, config guard, curriculum verdict mapping (845 pass, 0 fail)
- [x] docs: README, ARCHITECTURE, OPERATIONS, including the Laya zero-shot warning
- [x] smoke run against a stand-in `/v1/systemone` server: probe, `sil llm use` guards, five nouls in one call
- [ ] run the judge against a real Laya server or a Jev key and measure it against the chat judge

## Semantic alias review (2026-09-21, branch semantic-alias-review-typesafe-decision)

`sil aliases suggest` compares slug tokens, so it misses a pair that shares a
mechanism but no words, and it fires on pairs that only share vocabulary. The
opt-in pass asks the System One judge one Choice question per candidate pair and
prints the verdict under the candidate. Off by default. It proposes, like the
deterministic pass; `sil aliases set` stays the only thing that writes.

- [x] `AliasSemanticConfig` in `config.yaml`: enabled, max_candidates,
      max_reflections_per_pattern, max_excerpt_chars, timeout_s, concurrency,
      min_confidence
- [x] `@sil/providers`: `decideChoice()` on the existing `postSystemOne` transport,
      with `readChoices` validating the pick against the question's own options
- [x] `@sil/curriculum/alias-semantic.ts`: evidence selection (world scoped,
      alias resolved, capped), bounded concurrency, confidence gate to `unsure`,
      per-pair failure isolation. No new package, no new role, no new service.
- [x] CLI: verdict, confidence, model and the evidence ids under each candidate;
      disabled output is byte-identical to before
- [x] tests with a fake decision provider (30 in `packages/curriculum/test/alias-semantic.test.ts`,
      44 in the providers `system-one kind` block, 8 in the CLI `semantic pass`
      block); full suite 1188 pass, 0 fail, measured with `bun test`
- [x] `scripts/eval-alias-semantic.ts` + `scripts/fixtures/alias-semantic-pairs.json`:
      six hand-labelled pairs, disagreement report, live provider only
- [x] independent review; fixed: model text echoed into error lines, a per-pair
      failure hidden behind the report-level reason, probability keys outside the
      question, a contract-breaking transport taking the whole report down
- [x] second review round (pr-review-toolkit), fixed: report status split into
      `preflight_failed` and `none_assessed` so the CLI stops guessing from the
      suggestion shape; an answer with no confidence signal is `unavailable`,
      not `unsure`; the credential and `base_url` are checked before the first
      request; the confidence gate is one exported `verdictFor` shared with the
      evaluation script; `PAIR_CRITERIA` is typed by the option union; the
      evaluation script validates its fixture and exits 1 when it measured
      nothing; three false claims corrected in `docs/OPERATIONS.md`
- [ ] run the live evaluation against a real Jev key or a Laya server. Nothing in
      this branch has been exercised against a real provider.

## Small
- [ ] decide whether `.ai/` stays in the repo
- [ ] revisit command texts and `argument-hint` after first real use

## Artifact type coverage (2026-09-20, branch verify-agents-skills-rules-hooks-created)

Question: does curriculum produce skills, hooks, rules and agents, or one of them?
Measured on the live world before any change: 20 `feat(rule)` and 8 `feat(hook)`
commits since the V2 migration, 0 skills, 0 agents (every skill and the one agent
in the ledger are V1 imports). Drafter replay on 5 real clusters, 11 runs: 8 replies
asked for a hook and the router downgraded 6 to rule because the 20 synthetic
fixtures never match a narrow gate, 1 more for the `ToolSearch` matcher; no
lesson-only run asked for a skill or agent because the drafter only saw the
300-char lesson line. No run drafted an agent; that path is covered by tests only.

- [x] record `routed[pattern] = {drafted, type, reason}` in the run report; print in `sil curriculum run`, show in the web worker status
- [x] hook records PreToolUse payload samples (allowlisted keys, rotated) into `usage/payloads/<world>.jsonl`; the router corpus includes them
- [x] drafter and judge read the whole reflection body; prompt names what buys a skill (a procedure that does not fit one bullet) and an agent (an investigation across files, logs, outputs)
- [x] ToolSearch, WebFetch, WebSearch, NotebookEdit accepted as nudge matchers, plus a ToolSearch fixture
- [x] agent staging test, route record tests, sample and corpus tests (red on `main` checked out into a temp dir with the new test files copied over: 15 fail, and plan.test.ts does not load there); agent accept-and-relink test is coverage only, it passes on the old code too
- [x] relinked the migrated `outward-facing-artifacts` agent into `~/.claude/agents` (operator state, not repo)
- [x] review fixes: `appendLine` rotation bounded by bytes as well as lines; samples keep only `command` and `file_path` with credential values blanked; `Not verified` cut from the drafter's view and the router's quote haystack; judge keeps reading lesson lines; `MAX_SOURCE_CHARS` 120k; broadcast ceiling at half the corpus with hit counts in the route reason
- [x] `sil import payloads --days 30`: backfill the corpus from `~/.claude/projects` transcripts (same record shape and redaction as the hook, via `@sil/core/samples`); on this machine 34k tool calls, 2162 distinct samples kept, 34 with `--no-verify`
- [x] end-to-end proof with the real drafter and judge (claude-cli, opus) on copies of the live data, corpus backfilled from real transcripts, six rule promotions forgotten so they re-route, cap 12: drafted 10 hook / 2 rule, routed 9 hook / 3 rule, staged 6 hook + 3 rule (1 judge reject, 2 hook texts over 400 chars). Before the change every one of those clusters had been promoted as a rule.
- [x] agent path, real data: 3 V1 reflections of `outward-facing-artifacts` (the pattern V1 promoted as an agent) -> drafted agent, routed agent ("own-context need quoted verbatim"), lint and judge pass, `feat(agent)` branch with `agents/outward-facing-artifacts.md`
- [x] skill path, real data: 3 V1 reflections of `controlled-cohort-comparison` -> drafted skill, routed skill, `feat(skill)` branch with a five-step `SKILL.md`
- [ ] after the plugin picks up a build with this change: run `sil import payloads --days 30` once, then watch `routed:` in curriculum.log

## Rule cap as config (2026-09-20, branch curriculum-artifact-lint-cap-300)
Trigger: a live run gated `evidence-level-overclaim` at "316 chars; the cap is 300" and
six patterns "over the per-run cap of 2". Two of the three causes were already on main
(prompt states the cap net of the tag, b802fe3; a gated-out pattern frees its slot,
c39d937). The third, the 300 itself, was a constant.
- [x] `promotion.max_rule_chars` (default 500) replaces the hardcoded 300; `ruleBudget()`
      in lint.ts is the one arithmetic both the drafter prompt and the lint use
- [x] tests: configurable lint cap, prompt budget for a custom cap, config cap through
      `run()` to both the drafter and the lint, core default
- [ ] operator: raise `promotion.per_run_cap` in config.yaml if two slots a tick is too few;
      staged-but-unreviewed patterns re-spend a slot every tick until accepted or rejected

Review: the corpus test still cannot see prompts (`prompt_matches` gates only have the
fixture), by design: prompts are free text. The gate runner deadline stays 250 ms;
measured about 10 ms median with 2020 payloads (52 ms in an earlier run). Routing is
now corpus-dependent: the same drafter answer can be a hook on a machine with samples
and a rule on a fresh install; the route reason carries the hit count so that is visible.

## Logs console polish (branch polish-ui-ux-logs-console-view)
- [x] `apps/web/src/lib/logs.ts`: pure parse of worker JSON lines and `ISO msg` lines, level detection, filter match, highlight split, size text
- [x] `apps/web/test/logs.test.ts`: unit tests for the parser, level rules, filter and highlight
- [x] `apps/web/src/panes/Logs.svelte`: console view (toolbar, line meta, level colours, filter, wrap toggle, copy, download, smart autoscroll with jump-to-latest)
- [x] verify: bun test, typecheck, check:web, lint:dashes, bun run build (dist drift), browser smoke on the running web UI

### Review pass
An independent reviewer found and this branch fixed: filter matched the raw JSON
while the console showed `key=value`, a late tail response could overwrite the
pane after a log switch, `highlight` built a node per segment with no cap,
`levelOf` painted `errors=0` red, wrap toggling stranded a pinned view, and a
failed first load left the pane on "loading" for ever.

## UI and UX overhaul (branch polish-ui-ux-logs-console-view)
- [x] `.ai/design-plan.md`: palette, type scale, layout wireframes and principles written before any code
- [x] `apps/web/src/app.css`: rewritten as a single design system (tokens, panels, tables, chips, dots, empty states, notices, toasts, responsive rail, reduced motion)
- [x] `apps/web/src/App.svelte`: rail plus topbar shell, panes grouped Watch / Decide / Configure, pane title and blurb centralised, live worker light and staged count in the rail
- [x] `apps/web/src/panes/Overview.svelte`: loop band with the five stages and the return path, worker, provider and install panels
- [x] Queue, Reflections, Review, Artifacts, Loop, Models, Worlds, Logs: rebuilt on the shared classes, every empty state says what to do next, every button names its effect
- [x] `apps/web/src/lib/api.ts`: a deep link such as `#/logs` is no longer swallowed as if the fragment were a token
- [x] `apps/web/src/panes/Review.svelte`: the proposal is shown verbatim as the file it is, with its repo path, instead of being rendered as prose markdown
- [x] `apps/web/src/lib/format.ts`: `plural()` so counts read "1 stop", not "1 stops"
- [x] rail counts refresh the moment a proposal is accepted, through `appState.statusSeq`
- [x] verify: bun test (842 pass), typecheck, check:web (0 errors), lint:dashes, bun run build, browser smoke of all nine panes against a seeded temp state dir

### Review pass
Browser smoke on http://127.0.0.1:7788 with a seeded fixture found three defects,
all fixed here: the worker badge in the rail kept a stale count after an accept,
"1 worlds" and "1 stops" printed the plural form for a single item, and the
staged proposal was rendered as markdown, which dropped the frontmatter and the
line breaks a reviewer needs to judge the file. Dark mode was checked by
injecting the built stylesheet's own dark block, and the narrow layout by
rendering the app in a 420 px frame.

## Phase 7: system holes (2026-09-19)

Each item was checked against `origin/main`, not against a local worktree.

- [x] No CI at all: `.github` was absent on `origin/main`. Added
      `.github/workflows/ci.yml`: install, lint:dashes, typecheck, check:web, `bun
      test`, and a build that must leave `dist/` byte-identical.
- [x] `propose()` in `@sil/feedback` judged a never-used artifact stale from a null
      `last_used`, so `retire_after_days` never applied to it: it flipped to
      `retire-candidate` on day 8 and the reason string claimed an age it had not
      checked. Now measured from `entry.last_updated`, reason names its basis.
- [x] Pattern fragmentation had no terminal path and no detector. Added `sil aliases
      list|set|rm|suggest`, a deterministic token-overlap suggester in `@sil/store`,
      and the `aliases.suggest` read op. A human applies every merge.

### Checked and NOT a hole
- `dist/` drift: `git archive origin/main` plus `tests/dist.test.ts` gives 6 pass, 0
  fail. Main is in sync. The drift was local to a stale worktree.
- Untimed nudge gate regex in the hook: `packages/nudges/src/gates.ts:58-79` caps
  every subject at `MAX_MATCH_LEN = 4000` and rejects the exponential shapes at load.
- Worker lock reclaim window: `packages/worker/src/index.ts:91-107` uses an atomic
  exclusive create; the 60 ms settle only covers reclaiming after a crash and
  resolves last-write-wins.

### Review pass
An independent reviewer (Fable) read the branch against `origin/main` and found
four defects in the fixes themselves. All four are fixed here.

- [x] The two-hop guard in `sil aliases set` covered one direction only: it rejected
      a canonical that was already an alias key, but accepted an alias key that was
      already another entry's canonical, which formed the chain and split the cluster
      the command exists to merge. The invariant now lives in `saveAliases`, so the
      ops handler and the web pane get it too, and `set` re-points the dependent
      entries instead of refusing. Smoke: 3 + 5 reflections merge to one count of 8,
      where the old code left 6 + 2.
- [x] `propose()` measured "never used" staleness from `last_updated`, which reject,
      re-home and retire all bump. A refused redraft restarted the retire clock and
      the reason string printed the rejection date as the promotion date. Added
      `promoted_at` to the ledger row, set by accept and by an auto-merge only, with
      a fallback to `last_updated` for rows written before the field existed.
- [x] `x in obj` in `aliases set` and `rm`: `constructor` is a valid slug, so `rm`
      reported a removal it never made. Now `Object.hasOwn`. This trap is already in
      `.ai/lessons.md` from 2026-09-14.
- [x] Smaller: `set foo foo` is refused, the subset rule in the suggester no longer
      fires on single-token slugs, `tests/lockfile.test.ts` no longer claims to prove
      the lockfile is current (only that a version bump did not leave it behind), the
      CI dist check uses `git status` so a new untracked file cannot pass, the
      workflow declares `permissions: contents: read`, and the bun version moved into
      `.bun-version` so a contributor builds `dist/` on the version CI verifies it on.

### First CI run (2026-09-19)

The workflow this branch added ran for the first time on PR #18 and went red on
one e2e test, which turned out to be a real hole rather than a CI quirk.

- [x] `sil init` created the built-in `learned/` repo with no `user.name` and no
      `user.email` of its own and gave an identity only to the initial empty
      commit, so every later commit ran as whatever git could resolve globally.
      On a machine with no global identity (CI, a container, a per-repo identity
      setup) staging and accept both fail with "Author identity unknown", and the
      curriculum run folds that into one `gated_out` string nobody prints: the
      install looks alive and promotes nothing. The CLI helper and
      `git.ensureRepo` are one path now, and `ensureRepo` fills in a missing
      identity on a repo an older install already created. An identity git can
      resolve is never overwritten.

### Retire then accept left the artifact serving (2026-09-21)

- [x] `acceptInner` stamped `status: "promoted"` on every row it merged, so an
      accepted retirement landed in the ledger as a promotion. The file was
      deleted and the symlink reaped, but the inventory still counted the pattern
      as serving and `plan()` read `status === "promoted"` plus the scorecard that
      caused the retirement and proposed `refine`, which drafts the artifact back
      into existence. Accept now carries the branch row's `retired` status and
      `served_by: null` through the merge, `AcceptResult.status` is
      `"promoted" | "retired"`, and the commit subject says `retire`. Regression
      tests cover skill, rule and hook retirements plus the "never refined back"
      invariant (`packages/review/test/review.test.ts`).
- [x] `sil review retire` printed "retired <pattern>" for an action that only
      stages a branch, and the web UI toast said the same. Both now say the
      retirement is staged and needs an accept.

### End-to-end audit of the same path (2026-09-21)

Fixed here:

- [x] A curriculum tick destroyed a retirement waiting for review.
      `stageOne` force-resets the pattern's branch onto the default branch
      (`packages/curriculum/src/run.ts`) unless `migrating()` says a type change
      is in flight, and `migrating()` cannot see a retirement: `served_by` is
      null, so `rowType()` falls back to `artifact_type` and both sides read the
      same type. `servedBy()` then recovers the old `served_by` from the default
      branch and redrafts the artifact in its old shape. A single tick between
      retire and accept was enough, and a tick is as cheap as opening a session.
      `stageOne` now gates the pattern out while its branch row says `retired`.
- [x] Retiring left the watermark where the promotion put it, so the reflections
      already on disk counted as new evidence and the next tick staged the
      artifact again. Retire now stamps `rejected_at_count`, exactly as reject
      does; the pattern needs `threshold` new reflections to come back.
- [x] Accept relinked only the type being accepted, and a hook or rule links
      nowhere, so a skill re-homed to either kept a dangling
      `~/.claude/skills/<pattern>`. Accept now passes every linkable type through
      `relink`.
- [x] `relink` read liveness off the skill directory. Retiring deletes SKILL.md
      and reaps the directory only when it is empty, so one other committed file
      kept the link alive. Liveness is now the artifact file itself.
- [x] `rehome --type none` wrote no file, so the placeholder guard had nothing to
      refuse and accept stamped a promotion of an artifact that does not exist.
      It is now run as a retirement.
- [x] A retirement's pull request announced a promotion (`remote.ts`), and
      `io.hasGh()` sat outside the try that keeps every post-merge step from
      hard-failing.
- [x] `sil review rehome` and the web rehome button said "rehomed" for an action
      that only stages a branch.

Found in the audit, all fixed now. Every fix ships a regression test that was
run red against the old code first:

- [x] MEDIUM `ReviewItem` / `ReviewDetail` carried no status, so a staged
      retirement rendered in the queue and the detail pane exactly like a
      promotion. Fixed in 5cf2937 with the rest of that commit: `status` is on
      `ReviewItem` and both the queue row and the detail pane name a retirement.
- [x] MEDIUM A re-home placeholder was only redrafted when the pattern earned
      `threshold` new reflections (`plan()` returned `done` otherwise), so the
      staged re-home could not be accepted and the old artifact kept serving.
      `plan()` now returns `promote` for a `staged` row whose branch still holds
      only the stub. A re-home writes that row and that stub into a scratch
      worktree of the branch, never into the live tree, so `placeholderPatterns()`
      reads both off the branch. `branchName()` moved from `run.ts` to `git.ts`
      so `plan.ts` can use it without an import cycle.
- [x] MEDIUM `handleSessionEnd` wrote the session file without `sessionLock`
      (`apps/hook/src/handlers.ts`), so a concurrent Stop write lost the `stops`
      counter or the `ended` flag. It now takes the same lock Stop takes, and
      waits 4 s for it: the default 2 s can run out while a Stop scans a large
      transcript, and a lost `ended` flag holds the session out of the queue for
      the full `idle_minutes`.
- [x] MEDIUM The worker wrote a reflection and then moved the queue entry to a
      terminal state with no guard between the two, so a re-queued or replayed
      session got a second reflection and inflated the count `plan()` compares to
      the watermark. `reflectedSessions()` (`@sil/store`) maps each session id to
      the time of its newest reflection, and the worker skips an entry only when
      that reflection is not older than the entry's own `first_stop`. A resumed
      session keeps its id, so the time is what keeps its new work.
- [x] LOW `AliasArgs.world` and `FeedbackArgs.world` skipped `WORLD_NAME_RE`, and
      `aliases.*`, `reflections.*`, `lessons.list` and `feedback.add` skipped
      `cfgWorld()`, so an unknown world wrote or returned empty instead of a 503.
      Both schemas hold the world to the same shape now and every one of those
      handlers resolves the world first.
- [x] LOW A reflection id collision threw `reflection already exists`, and
      `isTransient` does not match it, so finished critic work went to `failed`.
      A generated id now retries up to 16 times; an id the caller named still
      throws, because writing that body to another file would be a silent rename.
- [x] LOW `router.rehome` had no confirm gate while `router.retire` does, so
      re-homing to `none` (a retirement) staged a deletion without one. The op
      wants `confirm: true` for `none`, the CLI wants `--yes`, and the web pane
      sends the confirmation it already asked the operator for.

### Still open, by design not by accident
- [ ] No cross-artifact consistency check: the judge sees one draft against its own
      sources only (`packages/curriculum/src/prompts.ts:263-283`), so a new artifact
      can contradict an accepted rule and nothing notices.
- [ ] No offline evaluation: every critic/drafter/judge test uses a fake chat, so a
      prompt regression ships unseen. This is the "replay" half of the dreaming design.
- [x] `bun.lock` carried the workspace versions from before the 0.2.3 to 0.2.6 bumps,
      so a plain `bun install` on untouched `origin/main` rewrote it, and because
      `bun.lock` is a `sourceHash()` input (`scripts/build.ts:23`) that rewrite failed
      `tests/dist.test.ts`. Reproduced on a `git archive origin/main` tree: 5 pass, 1
      fail. `bun install --frozen-lockfile` does not catch it, it exits 0. Fixed at the
      root in `scripts/bump-version.sh`, guarded by `tests/lockfile.test.ts` and by a
      `git diff --exit-code -- bun.lock` step in CI.
