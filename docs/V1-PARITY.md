# V1 parity

Every V1 (`dotfiles-next`) behaviour worth keeping, and where it lives now. Source
for the V1 side: `docs/self-improvement-loop/INVARIANTS.md`, `CONTRACTS.md`,
`DECISIONS.md` in `dotfiles-next`. Status is `kept`, `changed` or `dropped`.
The "V2 location" column points at the current TypeScript/Bun implementation
(this repo ported off an interim Python V2, itself since retired).

| V1 behaviour | V2 location | Status | Note |
|---|---|---|---|
| Invariant 1: nothing reaches a shared remote without a human | `packages/curriculum/src/run.ts`, `packages/review/src/index.ts` | kept | Curriculum stages branches only; accept merges locally, `remote: push\|pr` is an explicit per-world opt-in. |
| Invariant 2: promotion and rejection share one watermark scheme | `PromotionEntry.promoted_at_count` / `rejected_at_count` in `packages/core/src/schemas.ts` | kept | Same fields, same symmetry. |
| Invariant 3: an already-served pattern is never re-routed | `packages/curriculum/src/router.ts` (branch `served_by` before ledger `served_by`) | kept | Same branch-first lookup order. |
| Invariant 4: `route()` is total, never raises | `packages/curriculum/src/router.ts` | kept | Gate evaluation still wrapped so one bad answer cannot take a run down. |
| Invariant 5: evidence must be verbatim | `packages/curriculum/src/router.ts` | kept | Same normalised-substring check before granting `agent`/`skill`. |
| Invariant 6: a proposed hook's gate is executed against a real payload corpus | `packages/curriculum/src/router.ts`, `packages/curriculum/src/run.ts` | kept | Same deadline-guarded `evaluate()` call, run out of process via `@sil/nudges`' gate runner. |
| Invariant 7: a rule write refuses rather than appending blind | `packages/curriculum/src/artifacts.ts` | kept | Same marker-pair precondition, same `RULE_START`/`RULE_END`. |
| Invariant 8: refinement replaces by tag, never by position | `packages/curriculum/src/artifacts.ts`, `packages/core/src/consts.ts` (`RULE_TAG`) | kept | Same `<!--rule:{pattern}-->` tag match. |
| Invariant 9: the artifact and its ledger entry land in one commit | `packages/curriculum/src/run.ts` | kept | Same single-commit-per-pattern shape. |
| Invariant 10: accept is bound to what the human actually saw | `packages/review/src/index.ts`, `ReviewDetail.reviewed_state` in `packages/core/src/schemas.ts` | kept | Same hash-then-recheck pattern around the remote steps. |
| Invariant 11: accept judges paths, not commit counts | `packages/review/src/index.ts` | kept | Allowed-paths check, not a commit count check. |
| Invariant 12: git state is restored in a `finally` that never raises | `packages/curriculum/src/git.ts`, `packages/curriculum/src/run.ts` | kept | Recovery failure returns a reason string instead of raising. |
| Invariant 13: provider failure is isolated per pattern | `packages/curriculum/src/run.ts` | kept | One slow or failing draft call cannot discard the rest of the run. |
| Invariant 14: the loop reads the offline mirror, never a wiki API | `packages/store/src/reflections.ts` reads local reflection files only | kept | Outline is an export target (`packages/worker/src/outline.ts`), never a read dependency at query time. |
| Invariant 15: a critic never starts from a Stop without fresh explicit consent | was `claude/hooks/reflect_gate.py` | **changed** | The Stop-hook consent question is gone. Reflection now runs in the background worker, gated by config (`world.rules_inject`, `worker.idle_minutes`) rather than a per-session prompt, because the worker never blocks the session and nothing reaches a shared artifact without a human review at accept time. |
| In-session `critic` subagent (`claude/agents/critic.md`) | `packages/critic/src/index.ts` (`reflectSession`), called once by `@sil/worker` | **changed** | One critic implementation, run out of session by the worker, not an in-session subagent. Design rule 2 in `docs/ARCHITECTURE.md` states this directly: V1 had two divergent drafting paths, V2 has one. |
| `claude/commands/reflect.md` | `commands/reflect.md` | kept | Same intent (queue a reflection); the mechanism is now "mark the queue entry ended, worker picks it up" instead of the consent-gated Stop hook. |
| `claude/commands/curriculum.md` | `commands/curriculum.md` | kept | Same dry-run/apply split. |
| Router determinism (same input, same route) | `packages/curriculum/src/router.ts` | kept | No model call inside `route()` itself. |
| Artifact lint (frontmatter shape, description prefix) | `packages/curriculum/src/lint.ts` | kept | Same fixed-phrase description check that pinned temperature to 0 in V1. |
| Ledger schema (`claude/skills/promotions.json`) | `packages/core/src/schemas.ts` (`Ledger`, `PromotionEntry`), `packages/store/src/ledger.ts::loadLedger` | kept | `loadLedger` reads both the V1 bare-list shape and the V2 `{entries: {...}}` shape. |
| Accept digest (`reviewed_state`) | `packages/review/src/index.ts`, `ReviewDetail.reviewed_state` | kept | Same 64-hex-char hash, recomputed and re-checked around the remote steps. |
| Relink skills into the world's Claude config dir on accept | `packages/review/src/index.ts` (`relink`, calls into `packages/curriculum/src/git.ts`) | kept | Same relink step after a fast-forward merge. |
| Nudge dispatcher (sorted `*.json`, one winner, once-per-session, fire log) | `packages/nudges/src/dispatch.ts` | kept | Same contract: PreToolUse/PostToolUse/UserPromptSubmit dispatch, never blocks. |
| Nudge fire log (`usage/nudge-fires.jsonl`) | `packages/core/src/paths.ts::nudgeFiresFile`, `packages/nudges/src/firelog.ts` | kept | Same JSONL shape. |
| `llm.yaml` model roles (critic, drafter, judge) | `packages/core/src/schemas.ts` (`LlmConfig.models`), `packages/core/src/config.ts::modelFor` | kept | Same three roles, same "never defaults, raise `ModelNotConfigured`" rule. |
| Locality (`llm: local` worlds restricted to `local_models`) | `packages/core/src/config.ts::modelFor` (`LocalityViolation`) | kept | Same allowlist check. |
| Temperature 0 on every drafter/judge/critic call | `packages/providers/src/index.ts` | kept | Same rationale: router determinism and format-constrained output. |
| Wrapper re-exec on every spawn (credential freshness) | `scripts/sil` shim, `apps/cli/src/schedule.ts` (`ExecStart=<shim> ...`) | kept | Every scheduled worker/web invocation execs `bun dist/cli.js ...` fresh through the shim, so an API key rotation cannot leave a long-lived process holding a stale key. Not independently re-verified here for `sil web`'s own in-process request handlers, which are owned by another module. |
| Worlds manifest (`kb list`, `worlds.yaml`) | `sil worlds import-kb`, `apps/cli/src/importer.ts` | kept | One-time import, not a live dependency; V2 keeps its own `config.yaml`. |
