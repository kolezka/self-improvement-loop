# self-improvement-loop v2: build plan

Source of truth for design: `docs/ARCHITECTURE.md`. V1 lives in
`/home/me/Development/dotfiles-next` (kb/, claude/hooks/, claude/agents/).

## Phase 0: contracts (main context)
- [x] docs/ARCHITECTURE.md
- [x] pyproject.toml, sil/paths.py, sil/models.py, sil/config.py, sil/store.py, sil/consts.py
- [x] fixtures: tests/fixtures/hook-payloads (20 V1 payloads)

## Phase 1: parallel implementation (subagents)
- [ ] A hooks: sil/hook.py (stdlib), sil/nudge.py (port), sil/usage.py, nudges/ builtin, tests
- [ ] B reflect: sil/transcript.py, sil/providers.py, sil/critic.py, sil/worker.py, sil/feedback.py, sil/outline.py, tests
- [ ] C curriculum: sil/curriculum.py, sil/router.py, sil/lint.py, sil/artifacts.py, sil/run.py, sil/review.py, sil/gitutil.py, tests
- [ ] D web: sil/ops.py, sil/web/server.py, sil/web/static/*, tests
- [ ] E packaging: .claude-plugin/plugin.json, hooks/hooks.json, commands/, skills/, sil/cli.py, sil/schedule.py, scripts/, README, docs/V1-PARITY.md, docs/INSTALL.md

## Phase 2: integration (main context)
- [ ] uv run pytest green
- [ ] end-to-end: fixture transcript -> queue -> worker (fake provider) -> reflection -> inbox -> SessionStart injection
- [ ] end-to-end: 3 reflections -> curriculum dry-run -> staged branch -> web review -> accept (local) -> relink
- [ ] hook latency check (<100 ms per event with python3 stdlib)
- [ ] independent review (cross-family) of hook path + accept path
- [ ] commit history: conventional commits on feat/loop-v2

## Phase 3: hand-off
- [ ] marketplace entry snippet + scripts/register-marketplace.sh (not pushed; needs user)
- [ ] Recap with how-to-test

## Review notes
(filled at the end)
