# self-improvement-loop v2: build plan

Source of truth for design: `docs/ARCHITECTURE.md`. V1 lives in
`/home/me/Development/dotfiles-next` (kb/, claude/hooks/, claude/agents/).

## Phase 0: contracts (main context)
- [x] docs/ARCHITECTURE.md
- [x] pyproject.toml, sil/paths.py, sil/models.py, sil/config.py, sil/store.py, sil/consts.py
- [x] fixtures: tests/fixtures/hook-payloads (20 V1 payloads)

## Phase 1: parallel implementation (subagents)
- [x] A hooks: sil/hook.py (stdlib), sil/nudge.py (port), sil/usage.py, nudges/ builtin, tests
- [x] B reflect: sil/transcript.py, sil/providers.py, sil/critic.py, sil/worker.py, sil/feedback.py, sil/outline.py, tests
- [x] C curriculum: sil/curriculum.py, sil/router.py, sil/lint.py, sil/artifacts.py, sil/run.py, sil/review.py, sil/gitutil.py, tests
- [x] D web: sil/ops.py, sil/web/server.py, sil/web/static/*, tests
- [x] E packaging: .claude-plugin/plugin.json, hooks/hooks.json, commands/, skills/, sil/cli.py, sil/schedule.py, scripts/, README, docs/V1-PARITY.md, docs/INSTALL.md

## Phase 2: integration (main context)
- [x] uv run pytest green (499 passed, 21 skipped)
- [x] end-to-end: fixture transcript -> queue -> worker (fake provider) -> reflection -> inbox -> SessionStart injection (tests/test_e2e.py)
- [x] end-to-end: 3 reflections -> curriculum -> staged branch -> review -> accept (local) -> relink (tests/test_e2e.py)
- [x] hook latency check: p50 34 ms, p95 38 ms with /usr/bin/python3 (reviewer measurement)
- [x] independent review: hook path, accept path, web security, plugin structure; all blockers fixed (commit 3af97c1)
- [x] browser smoke: Overview, Review detail, Accept through the UI merged and relinked in a temp target
- [x] commit history: conventional commits on feat/loop-v2

## Phase 3: hand-off
- [x] marketplace entry script scripts/register-marketplace.sh (prints push and PR commands, never pushes)
- [ ] operator: create the GitHub repo kolezka/self-improvement-loop, push feat/loop-v2, open the marketplace PR
- [ ] operator: `sil init`, point llm.yaml at the LiteLLM proxy, optionally `sil worlds add ... --layout v1 --target ~/Development/dotfiles-next`

## Review notes
- Cross-family review was not possible in this session (only Claude models available); reviews ran on Opus and Sonnet.
- `remote: pr` path is implemented but not exercised against a real `gh`.
- No Outline read path by design; `sil.outline.export_new` is best effort and untested against a live Outline.
