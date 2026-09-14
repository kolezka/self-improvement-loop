# self-improvement-loop v2 (TypeScript + Bun): build plan

Design: `docs/ARCHITECTURE.md`. Python V2 (commit 97d8b42) is the port source
until the TS port reaches parity; then the Python tree is deleted.

## Phase 0: contracts (main context)
- [x] monorepo: package.json workspaces, tsconfig, bunfig, scripts/build.ts (committed dist/ bundles + srchash), scripts/lint-dashes.ts
- [x] @sil/core: consts, errors, paths, fsx, zod schemas, config (+tests)
- [x] @sil/store: reflections, aliases, ledger, inbox, queue (+tests)
- [x] typed stubs for nudges, transcript, providers, critic, feedback, curriculum, review, worker, ops; app entries
- [x] apps/web skeleton (Svelte 5 + Vite, outDir dist/web)

## Phase 1: parallel port (subagents)
- [ ] A @sil/nudges + apps/hook (bundle friendly, exit 0 always, <60 ms p95)
- [ ] B @sil/transcript, providers, critic, feedback, worker
- [ ] C @sil/curriculum (git, artifacts, lint, router, prompts, plan, run) + @sil/review
- [ ] D @sil/ops + apps/server (Bun.serve) + apps/web (Svelte panes)
- [ ] E apps/cli (commander), schedule, importer, hooks.json -> dist/hook.js, commands, docs, scripts/sil shim

## Phase 2: integration (main context)
- [ ] bun install, bun run typecheck, bun test all green
- [ ] bun run build; dist drift test; hooks.json points at dist/hook.js
- [ ] tests/e2e.test.ts: hook subprocess -> queue -> worker (fake chat) -> reflection -> inbox -> SessionStart; 3 reflections -> run -> review -> accept -> relink; server API
- [ ] browser smoke of Svelte UI
- [ ] independent review (hook, accept, web)
- [ ] delete Python tree (sil/, tests/*.py, pyproject.toml, uv.lock, Makefile targets), update docs
- [ ] commits

## Phase 3: hand-off
- [ ] operator: push, marketplace PR, `sil init`
