# V1 parity

Every V1 (`dotfiles-next`) behaviour worth keeping, and where it lives now. Source
for the V1 side: `docs/self-improvement-loop/INVARIANTS.md`, `CONTRACTS.md`,
`DECISIONS.md` in `dotfiles-next`. Status is `kept`, `changed` or `dropped`.

| V1 behaviour | V2 location | Status | Note |
|---|---|---|---|
| Invariant 1: nothing reaches a shared remote without a human | `sil/run.py`, `sil/review.py` | kept | Curriculum stages branches only; accept merges locally, `remote: push\|pr` is an explicit per-world opt-in. |
| Invariant 2: promotion and rejection share one watermark scheme | `PromotionEntry.promoted_at_count` / `rejected_at_count` in `sil/models.py` | kept | Same fields, same symmetry. |
| Invariant 3: an already-served pattern is never re-routed | `sil/router.py` (branch `served_by` before ledger `served_by`) | kept | Same branch-first lookup order. |
| Invariant 4: `route()` is total, never raises | `sil/router.py` | kept | Gate evaluation still wrapped so one bad answer cannot take a run down. |
| Invariant 5: evidence must be verbatim | `sil/router.py` | kept | Same normalised-substring check before granting `agent`/`skill`. |
| Invariant 6: a proposed hook's gate is executed against a real payload corpus | `sil/router.py`, `sil/curriculum.py` | kept | Same deadline-guarded `evaluate()` call. |
| Invariant 7: a rule write refuses rather than appending blind | `sil/artifacts.py` | kept | Same marker-pair precondition, same `RULE_START`/`RULE_END`. |
| Invariant 8: refinement replaces by tag, never by position | `sil/artifacts.py`, `sil/consts.py` (`RULE_TAG`) | kept | Same `<!--rule:{pattern}-->` tag match. |
| Invariant 9: the artifact and its ledger entry land in one commit | `sil/run.py` | kept | Same single-commit-per-pattern shape. |
| Invariant 10: accept is bound to what the human actually saw | `sil/review.py`, `ReviewDetail.reviewed_state` in `sil/models.py` | kept | Same hash-then-recheck pattern around the remote steps. |
| Invariant 11: accept judges paths, not commit counts | `sil/review.py` | kept | Allowed-paths check, not a commit count check. |
| Invariant 12: git state is restored in a `finally` that never raises | `sil/gitutil.py`, `sil/run.py` | kept | Recovery failure returns a reason string instead of raising. |
| Invariant 13: provider failure is isolated per pattern | `sil/run.py` | kept | One slow or failing draft call cannot discard the rest of the run. |
| Invariant 14: the loop reads the offline mirror, never a wiki API | `sil/store.py` reads local reflection files only | kept | Outline is an export target (`sil.outline`), never a read dependency at query time. |
| Invariant 15: a critic never starts from a Stop without fresh explicit consent | was `claude/hooks/reflect_gate.py` | **changed** | The Stop-hook consent question is gone. Reflection now runs in the background worker, gated by config (`world.rules_inject`, `worker.idle_minutes`) rather than a per-session prompt, because the worker never blocks the session and nothing reaches a shared artifact without a human review at accept time. |
| In-session `critic` subagent (`claude/agents/critic.md`) | `sil/critic.py` (`reflect_session`), called once by the worker | **changed** | One critic implementation, run out of session by the worker, not an in-session subagent. Design rule 2 in `docs/ARCHITECTURE.md` states this directly: V1 had two divergent drafting paths, V2 has one. |
| `claude/commands/reflect.md` | `commands/reflect.md` | kept | Same intent (queue a reflection); the mechanism is now "mark the queue entry ended, worker picks it up" instead of the consent-gated Stop hook. |
| `claude/commands/curriculum.md` | `commands/curriculum.md` | kept | Same dry-run/apply split. |
| Router determinism (same input, same route) | `sil/router.py` | kept | No model call inside `route()` itself. |
| Artifact lint (frontmatter shape, description prefix) | `sil/lint.py` | kept | Same fixed-phrase description check that pinned temperature to 0 in V1. |
| Ledger schema (`claude/skills/promotions.json`) | `sil/models.py` (`Ledger`, `PromotionEntry`), `sil/store.py::load_ledger` | kept | `load_ledger` reads both the V1 bare-list shape and the V2 `{entries: {...}}` shape. |
| Accept digest (`reviewed_state`) | `sil/review.py`, `ReviewDetail.reviewed_state` | kept | Same 64-hex-char hash, recomputed and re-checked around the remote steps. |
| Relink skills into the world's Claude config dir on accept | `sil/review.py` (calls into `sil/gitutil.py`) | kept | Same relink step after a fast-forward merge. |
| Nudge dispatcher (sorted `*.json`, one winner, once-per-session, fire log) | `sil/nudge.py` | kept | Same contract: PreToolUse/PostToolUse/UserPromptSubmit dispatch, never blocks. |
| Nudge fire log (`usage/nudge-fires.jsonl`) | `sil/paths.py::nudge_fires_file`, `sil/nudge.py` | kept | Same JSONL shape. |
| `llm.yaml` model roles (critic, drafter, judge) | `sil/models.py` (`LlmConfig.models`), `sil/config.py::model_for` | kept | Same three roles, same "never defaults, raise `ModelNotConfigured`" rule. |
| Locality (`llm: local` worlds restricted to `local_models`) | `sil/config.py::model_for` (`LocalityViolation`) | kept | Same allowlist check. |
| Temperature 0 on every drafter/judge/critic call | `sil/providers.py` | kept | Same rationale: router determinism and format-constrained output. |
| Wrapper re-exec on every spawn (credential freshness) | `scripts/sil` shim, `sil/schedule.py` (`ExecStart=<shim> ...`) | kept | Every scheduled worker/web invocation execs `uv run --project <root> sil ...` fresh, so an API key rotation cannot leave a long-lived process holding a stale key. Not independently re-verified here for `sil web`'s own in-process request handlers, which are owned by another module. |
| Worlds manifest (`kb list`, `worlds.yaml`) | `sil worlds import-kb`, `sil/importer.py` | kept | One-time import, not a live dependency; V2 keeps its own `config.yaml`. |
