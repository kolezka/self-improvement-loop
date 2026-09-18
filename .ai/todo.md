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

## Web UI version badge (done 2026-09-19)
- [x] inject the root package.json version into the Svelte bundle via a vite `define`
- [x] show it as `v<version>` in the web UI footer next to the worker badge
- [x] test locks the define to the root package.json version, verified failing without it

## Small
- [ ] decide whether `.ai/` stays in the repo
- [ ] revisit command texts and `argument-hint` after first real use

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
