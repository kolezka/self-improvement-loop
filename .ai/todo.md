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

## Small
- [ ] decide whether `.ai/` stays in the repo
- [ ] revisit command texts and `argument-hint` after first real use

## Artifact type coverage (2026-09-20, branch verify-agents-skills-rules-hooks-created)

Question: does curriculum produce skills, hooks, rules and agents, or one of them?
Measured on the live world before any change: 20 `feat(rule)` and 8 `feat(hook)`
commits since the V2 migration, 0 skills, 0 agents (every skill and the one agent
in the ledger are V1 imports). Drafter replay on 5 real clusters: 7 of 9 replies
asked for a hook and the router downgraded 6 to rule because the 20 synthetic
fixtures never match a narrow gate; 0 of 9 asked for a skill or agent because the
drafter only saw the 300-char lesson line.

- [x] record `routed[pattern] = {drafted, type, reason}` in the run report; print in `sil curriculum run`, show in the web worker status
- [x] hook records PreToolUse payload samples (allowlisted keys, rotated) into `usage/payloads/<world>.jsonl`; the router corpus includes them
- [x] drafter and judge read the whole reflection body; prompt names what buys a skill (a procedure that does not fit one bullet) and an agent (an investigation across files, logs, outputs)
- [x] ToolSearch, WebFetch, WebSearch, NotebookEdit accepted as nudge matchers, plus a ToolSearch fixture
- [x] agent staging test, route record tests, sample and corpus tests (red on the old code: 11 failures in a temp copy of HEAD); agent accept-and-relink test is coverage only, it passes on the old code too
- [x] relinked the migrated `outward-facing-artifacts` agent into `~/.claude/agents` (operator state, not repo)
- [x] review fixes: `appendLine` rotation bounded by bytes as well as lines; samples keep only `command` and `file_path` with credential values blanked; `Not verified` cut from the drafter's view and the router's quote haystack; judge keeps reading lesson lines; `MAX_SOURCE_CHARS` 120k; broadcast ceiling at half the corpus with hit counts in the route reason
- [ ] after the plugin picks up the new dist: watch `routed:` in curriculum.log for the first hook that survives on recorded samples, and the first skill or agent

Review: the corpus test still cannot see prompts (`prompt_matches` gates only have the
fixture), by design: prompts are free text. The gate runner deadline stays 250 ms;
measured 52 ms median with 2020 payloads. Routing is now corpus-dependent: the same
drafter answer can be a hook on a machine with samples and a rule on a fresh install;
the route reason carries the hit count so that is visible.
