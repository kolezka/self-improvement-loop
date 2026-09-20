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
- [ ] live model run of critic, drafter and judge; prompts are unverified beyond fake chat
- [ ] exercise `remote: pr` against GitHub and the Outline export against a live server
- [ ] worker lock is a pid file with a 60 ms reclaim window; consider flock via FFI
- [ ] a lint-clean regex gate is bounded only by JavaScriptCore's backtracking cap inside one hook call
- [ ] CI workflow: bun install, typecheck, bun test, bun run build, dist drift test
- [ ] second review by another model family (Codex) before use on employer repos
- [ ] Codex and OpenCode have no hook equivalent; V1 had a parity build, V2 has none

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

## Small
- [ ] decide whether `.ai/` stays in the repo
- [ ] revisit command texts and `argument-hint` after first real use
