# Cumulative learning and repeated artifact generation

- Date: 2026-10-22
- Status: review complete; implementation proposed, not approved
- Reviewed source: `6132ddf1a35e6075768a33f9825c3dca4a9cf172`, version 1.2.6
- Review: independent implementation/evidence-flow and architecture reviews, with lead verification
- Scope: transcript evidence, critic, reflection storage, clustering, summaries, drafting, routing, judging, promotion, review, feedback and lesson delivery
- Publication scope: source findings and synthetic probes only; private operational snapshots, world names and local promotion history are omitted

## Goal

Stop repeatedly recreating or rewording the same artifact without useful new evidence. Learn from multiple historical reflections without growing an unbounded checklist or losing earlier procedures. When recurrence shows that an artifact is too broad or has the wrong form, propose a focused split or type change for human review.

Publishing this task is not approval to implement the proposed changes. Shortening an existing rule can reduce prompt size, but does not by itself fix repeated generation or establish behavioral improvement.

## Executive verdict

Normal curriculum is not based only on the latest reflection. It loads the full canonical pattern cluster, but model-visible history is compressed and selected. Counting every reflection is not the same as preserving every distinct mechanism.

There are four different forms of repetition:

1. The same pending proposal is generated again, even without new evidence.
2. An accepted artifact is rewritten after more reflections.
3. The underlying failure keeps occurring despite the artifact.
4. New short inbox reminders repeat the same pattern independently of artifact changes.

The review reproduced defects in the first two paths and in the measurements used to evaluate the third. A separate selector probe demonstrated same-pattern repetition in the fourth path.

The immediate fix is not another broad verification skill. First repair evidence consumption, proposal preservation and measurement. Then retain source-linked mechanisms and decide deliberately between keeping, refining, splitting, retyping or creating an artifact.

## How evidence currently moves

### Transcript and critic

`packages/transcript/src/index.ts:182` builds evidence from one session. It selects user prompts, recent assistant text, tool-call summaries, Bash output tails, errors, skill/agent uses and Git evidence within bounded budgets.

A controlled probe showed that a successful MCP tool call's name reached this pack but its decoded result did not, while a Bash result did. The critic therefore does not always receive the primary evidence needed to evaluate an assertion.

`packages/critic/src/index.ts:129` adds existing pattern names/counts, installed artifact references and recent reflection IDs. It audits one session, not the complete historical cluster. A normal reflection's reusable lesson is limited to 300 characters; a separate optional inbox lesson is limited to 200.

### Storage and clustering

Reflections are append-only Markdown records. World filtering precedes approved alias resolution. The curriculum groups by canonical pattern slug and sorts reflections chronologically.

Relevant code:

- `packages/store/src/reflections.ts:125`
- `packages/curriculum/src/plan.ts:63`

### Summary and drafting

For clusters of at least eight reflections:

- The rolling summary receives its prior summary and fresh `lesson || body` text. Normal critic records therefore contribute their short lesson field.
- The summary prompt requests fewer than 1,500 characters; storage hard-cuts at 2,000.
- The drafter gets the summary and the latest 12 full reflection bodies, excluding the `Not verified` section.
- Older excerpts are restricted to `What worked` sections with at least two inline code spans, under a 4,000-character budget.
- A knowledge map provides up to 40 other patterns with short artifact descriptions.
- Existing live artifact wording is supplied for refinement.

Without a summary, more raw reflection text is available, subject to the 120,000-character source budget.

Relevant code:

- `packages/curriculum/src/context.ts:89`
- `packages/curriculum/src/prompts.ts:67`
- `packages/curriculum/src/prompts.ts:87`
- `packages/curriculum/src/prompts.ts:333`
- `packages/curriculum/src/prompts.ts:379`

### Router, judge and review

The router can verify a quote against broader source material than the drafter sees. The judge receives lesson lines and feedback; initial skill/agent routing also appends the selected supporting quote.

Lint checks structure, length and grounding vocabulary. The judge checks contradiction, vagueness, unsupported instructions, unsafe instructions and unrelatedness. Neither establishes that the new artifact improves coverage while preserving earlier obligations.

Staging creates a proposal branch. Human acceptance is bound to the `reviewed_state` digest. Original promotion time is preserved and accepted revisions advance revision metadata. These protections should remain.

## Confirmed findings

### F1. Identical evidence can replace a pending human-revised proposal

**Priority:** high. **Evidence:** real pipeline reproduced independently by the lead.

`packages/curriculum/src/run.ts:406` protects an existing staged proposal only when the action is `refine`. The `promote` path reads the live body at line 438, not the pending proposal, and force-resets an existing same-type branch at lines 708-710.

Reproduction:

1. Create three synthetic reflections.
2. Call the real `run()` with literal fake drafter and judge responses.
3. Call `run()` again with exactly the same reflections.
4. Both calls invoke drafter and judge and stage different commits.
5. Add a sentence through real `review.revise()`.
6. Run the automatic pipeline again without new reflections.
7. The automatic prompt does not contain the human sentence; the replacement body loses it.

This proves loss of pending human work. It does not prove that an unreviewed change was activated; acceptance still has its digest guard.

**Required contract:** unchanged evidence and feedback reuse the pending proposal without model calls. Automatic work must preserve human revisions. New evidence must not silently reset a proposal under review.

### F2. Manual refine does not consume the evidence it used

**Priority:** high. **Evidence:** real `refine()` and `accept()` reproduced independently.

`packages/review/src/refine.ts:161` gathers current reflections but sets `action.count` to `prior.promoted_at_count`. `packages/curriculum/src/run.ts:675` then preserves that stale count.

Controlled fixture:

- The current source set is larger than the existing promoted and rejected counts.
- Manual refine uses the current sources and is accepted.
- The accepted promoted count remains unchanged, so the effective watermark is stale.
- Exactly one reflection is added after acceptance.
- The planner counts previously consumed evidence as new and proposes another promotion.

The fixture injected a scorecard to isolate count arithmetic. Its rates were not measured outcomes.

**Required contract:** an accepted refinement records the actual canonical evidence it consumed. Preserve the existing non-decreasing guard for ledger-only or imported histories. Consider source identities as well as counts when designing the durable fingerprint.

### F3. Revision windows count activity before the revision

**Priority:** high. **Evidence:** independently reproduced pure probe.

`packages/feedback/src/rates.ts:48` truncates promotion and revision timestamps to calendar dates. The upstream session rows are also day-only. `packages/curriculum/src/plan.ts:369` uses this count for observation policy.

Controlled fixture:

- Revision at 20:00.
- Twenty session rows from that morning, ten matching the pattern.
- Zero post-revision sessions.
- Computed since-revision result: 20 sessions, ten hits, rate 0.5.
- Policy returned `escalate`.
- Moving the control rows to the previous day returned zero sessions and no rate.

A reflection recorded after acceptance also does not prove that its session received the revised artifact. A long-running session may have started earlier.

**Required contract:** retain exact timestamps, treat old day-only data conservatively, and distinguish unknown exposure from exposure to the new version. Longer term, associate delivery/use events with artifact content identity. Missing exposure must not silently count as new-version exposure.

### F4. Older procedures disappear at the recent-context boundary

**Priority:** high for cumulative learning. **Evidence:** independently reproduced prompt selection with positive controls.

`packages/curriculum/src/context.ts:102` normally summarizes only the short lesson. `packages/curriculum/src/prompts.ts:390` selects the latest 12 full bodies. The older-evidence filter at line 87 requires `What worked` plus two inline code spans.

Verified results:

- A concrete older procedure was present with 12 reflections and absent with 13.
- The router still accepted that procedure's quote against the full source set.
- The summarizer and judge lesson inputs lacked it.
- An older plain-English ordered procedure disappeared.
- A procedure containing two backtick spans survived as the positive control.

**Required contract:** preserve distinct mechanisms and procedures independently of Markdown formatting or section name. Keep source-linked supporting passages available to drafting and judging. More prompt space alone does not establish retention.

### F5. Summary coverage can claim inputs that were never processed

**Priority:** medium to high for large clusters. **Evidence:** independently reproduced.

`summaryMessages()` applies a 120,000-character input budget, but `packages/curriculum/src/context.ts:124` marks every input ID as covered. Line 117 silently truncates an oversized response.

Verified results:

- With 410 approximately 300-character synthetic lessons, 408 reached the summary prompt but all 410 IDs were marked covered.
- A 3,256-character synthetic response became 2,000 characters and lost a required trailing check.
- All eight source IDs in that output-truncation fixture were marked covered.
- A second call reused the clipped summary without another summarizer call.

**Required contract:** process pending evidence in bounded batches and mark only processed inputs covered. Validate output structure and completeness instead of treating a clipped result as complete. Define cache invalidation for source membership, content and schema changes.

### F6. Reword budgets and no-change checks do not enforce useful progress

**Priority:** medium. **Evidence:** independently reproduced policy probes plus source inspection.

`packages/curriculum/src/plan.ts:456` applies `redraftPolicy()` to new-evidence promotion. The scorecard-only `refine` path at line 480 bypasses it.

`sameArtifact()` at `packages/curriculum/src/run.ts:850` normalizes whitespace or JSON structure, not meaning. An unchanged promote outcome leaves the watermark in place, while the retry cache is limited to the refine path.

Verified results:

- With 20 accepted revisions and `max_rewords=2`, a below-threshold complaint produced `refine`; crossing the new-evidence threshold produced `escalate`.
- Reordering the same instruction passed the different-text check.
- An expired low-traffic observation window could return normal-redraft eligibility despite the revision count.

**Required contract:** define one automatic redraft policy, with explicit human override. Cache evaluated no-change outcomes. Require an evidence/coverage delta and preservation of earlier obligations, not merely different wording.

## Additional findings and limits

### A1. Successful non-Bash results can be missing from critic evidence

The lead reproduced an evidence pack containing an MCP call name but not its successful decoded result, while a Bash result survived. This is an information limit, not proof that every reflection from an MCP-heavy session is wrong.

A future fix should select relevant decoded results under a bounded, redacted budget. Do not feed arbitrary full tool output into the critic without a budget and privacy boundary.

### A2. Forced skill/agent refinement loses original supporting proof

Initial routing appends a verified capability/context quote for the judge. Forced-type refinement does not preserve that proof: `packages/curriculum/src/run.ts:421` and `packages/curriculum/src/run.ts:614`.

The lead verified the source path. A reviewer subsequently reproduced `run() -> accept() -> refine()` with a procedure only in `What worked`: the initial judge received the procedure and the refinement judge did not. The lead did not independently rerun that additional fixture. Literal judge responses accepted both drafts, so no real model rejection was established.

Retain supporting provenance for every accepted capability and pass it consistently to later judges.

### A3. Repeated inbox lessons are not repeated artifact creation

The pure lesson selector returned two different IDs with the same pattern in one delivery batch. Selection is by ID and recency, without pattern-level consolidation: `packages/core/src/lessons.ts:77`.

A bounded consolidation step could reduce repeated reminders. Blindly keeping only the newest item of a broad pattern could lose distinct procedures, so this needs a coverage-preserving rule rather than unconditional deletion.

### A4. Helpful votes and failure records require interpretation

A helpful vote and a failure record for the same pattern are not necessarily contradictory. A rule might have helped partially or after an earlier failure. Reflection records are also not interchangeable with distinct sessions.

Treat such overlap as an audit signal. Do not automatically subtract helpful votes or use injection counts as proof of behavioral effectiveness.

## Proposed design

### Retain mechanisms, not an expanding paragraph

For each pattern, keep bounded source-linked records describing:

- The failure mechanism and recognizable conditions.
- Supporting reflection identities and verified passages.
- The procedure or invariant supported by those passages.
- Cases already served by the current artifact.
- Uncovered cases, counterexamples and explicitly superseded obligations.

The next step should first decide an action:

| Action | Reason |
| --- | --- |
| Keep | Another reflection confirms an already covered case |
| Refine | A specific gap in the existing artifact is demonstrated |
| Split | One broad pattern contains different mechanisms |
| Retype | The content is useful, but its delivery form is wrong |
| Create | A distinct need has no suitable artifact |

Only then draft text. Keep/no-change is a successful cached outcome, not an invitation to retry until wording changes.

The representation and selection policy remain design work. Do not impose an arbitrary fixed number of mechanisms if doing so would discard source coverage.

### When a separate skill is justified

A skill should provide a coherent executable procedure with a recognizable invocation moment. Recurrence alone does not identify the right artifact type.

- Rule: a short invariant that always applies.
- Skill: a focused procedure the agent can invoke when needed.
- Hook: a non-blocking reminder at an observable event, with a measured gate.
- Agent: work that benefits from independent context or verification.

Do not turn all verification failures into another large generic skill. Propose focused procedures or delivery changes only where the evidence supports them, and retain human acceptance for split/retype.

Check actual world-specific discovery before declaring a new skill redundant. A related file in one world's learned directory does not prove that another world's sessions can discover it.

### Measure behavior, not label changes

Reducing the percentage of reflections assigned to a broad failure label can be achieved by relabeling failures. It is not evidence of improvement.

Use held-out mechanism cases, preserved coverage, and eventually family-level recurrence tied to actual artifact-version exposure. Keep unknown exposure explicit. Calibrate new thresholds only after measurements are valid.

## Proposed implementation tasks

All unchecked tasks below are proposals. No implementation was approved during the review.

### Phase 1: correctness and proposal stability

- [ ] **T1: Make automatic staging idempotent.** Reuse a pending proposal for unchanged evidence and feedback; protect human revisions. Define how new evidence is shown while review is pending. Covers F1.
- [ ] **T2: Advance manual-refine evidence consumption.** Record the actual canonical sources used, without lowering imported or ledger-only watermarks. Covers F2.
- [ ] **T3: Correct observation boundaries.** Preserve timestamps and conservative legacy handling. Design version-attributed exposure separately from reflection-recording time. Covers F3.
- [ ] **T4: Correct summary accounting.** Batch oversized inputs, record only processed source IDs and reject incomplete output rather than silently treating it as complete. Covers F5.
- [ ] **T5: Unify automatic redraft policy.** Make the budget and no-change cache apply consistently, while keeping an explicit human override. Covers F6.

### Phase 2: cumulative evidence and durable capabilities

- [ ] **T6: Preserve source-linked mechanisms and procedures.** Replace recency/format-only selection with bounded representative coverage. Carry retained evidence to drafter, router and judge. Covers F4 and A2.
- [ ] **T7: Require useful change.** Record the new evidence delta, newly covered cases and retained obligations. Keep semantic no-change outcomes stable until evidence or policy changes.

### Phase 3: classification, delivery and evaluation

- [ ] **T8: Propose human-reviewed split/retype actions.** Preserve original source identity and history. Check existing artifacts in the correct world before proposing a new skill.
- [ ] **T9: Improve critic evidence and ambiguity handling.** Include selected decoded tool results and useful sibling descriptions. Keep unresolved evidence distinguishable from verified facts. Covers A1.
- [ ] **T10: Consolidate repeated inbox reminders without losing distinct cases.** Change the shared pure core, not separate command/module implementations. Covers A3.
- [ ] **T11: Add exposure-aware evaluation and feedback audit views.** Treat helpful/failure overlap as a signal to inspect, not an automatic contradiction. Covers A4.

The first implementation change should be bounded and reviewable, not all phases in one patch. Agree the exact scope before starting it.

## Regression and acceptance checks

### Proposal preservation

- Two real pipeline runs over identical evidence make no model calls on the second run and leave the proposal SHA unchanged.
- A human revision remains in the pending body and evidence after an automatic tick.
- New evidence is visible without silently discarding human work.
- `reviewed_state` remains bound to the exact proposal shown to the reviewer.

### Evidence consumption

- Manual refine records the canonical source set it consumed on acceptance.
- Adding one new record is counted as one rather than including already consumed records.
- Ledger-only and imported histories never move their watermark backward.
- Alias-resolved and raw-source paths follow the same identity contract.

### Revision windows

- A same-day event before revision is excluded from the post-revision window.
- An old-version long-running session is not counted as exposure to new text.
- Unknown exposure stays unknown.
- Existing observing/escalation behavior is tested against valid windows, not tuned to contaminated rates.

### Historical coverage

- A supported procedure survives the transition from 12 to 13 reflections and larger corpora, or is explicitly superseded.
- Plain-English procedures and different factual sections receive the same coverage guarantees as backtick-heavy `What worked` excerpts.
- Every summary-covered ID was actually processed.
- Oversized input and output cannot silently mark unseen or clipped evidence complete.
- Accepted skill/agent evidence survives refinement and reaches the judge again.

### Meaningful change and delivery

- An unchanged answered evidence set does not trigger repeated drafting.
- A paraphrase does not automatically count as increased coverage.
- New versions retain earlier supported obligations unless their removal is explicit and reviewed.
- Rules respect the configured length cap.
- Inbox consolidation does not discard distinct mechanisms under one broad pattern.
- Split proposals preserve source provenance and do not silently rewrite history.
- Held-out cases measure mechanism coverage and behavior, not just a preferred label distribution.

## Reproduction record

The exploratory probes exercised real production functions with literal fake model responses. They were not behavioral evaluations of an LLM. The quantities retained in the findings describe synthetic fixtures, not operational telemetry.

| Probe group | Production paths exercised | Result |
| --- | --- | --- |
| Pure evidence probes | Prompt selection, summary input/cache, router grounding, rate windows, transcript evidence pack | Lead rerun passed |
| Policy probes | `plan`, `redraftPolicy`, `sameArtifact` | Lead rerun passed |
| Pipeline probes | `run`, `review.revise`, `review.refine`, `review.accept`, summary persistence | Lead rerun passed |
| Forced-skill provenance | Initial creation, accept and forced refinement judge inputs | Reviewer passed; lead source-checked only |
| Inbox duplication | Shared `selectLessons` with two IDs for one pattern | Lead probe passed |

Each lead fixture run used a fresh temporary directory, explicit isolated `HOME`, `SIL_CONFIG_DIR`, `SIL_STATE_DIR`, `SIL_DATA_DIR`, `CLAUDE_CONFIG_DIR` and `TMPDIR`, with `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` set to `/dev/null`. Git commits and branch changes occurred only in fixture repositories. Use `Bun.spawn` environment overrides at process creation, not later mutation of the parent environment.

Bun ran with `--no-install`, `--no-env-file` and explicit module mappings to the reviewed source. The pure source mappings used the existing installed `zod` and `yaml` packages. No real model endpoints were called by the probes. Successful probe groups completed their assertions and exited zero.

Two earlier lead launches failed at module resolution before assertions. Those are instrument failures, not product failures. Successful runs also printed a nonfatal Bun tsconfig directory-mismatch diagnostic.

The exploratory scripts were temporary and are not a durable dependency of this task. Their scenarios and observable assertions are recorded above. Implement permanent regression tests in the existing test suites rather than relying on temporary paths.

Relevant existing suites and fixtures:

- `packages/curriculum/test/fixtures.ts`
- `packages/curriculum/test/run.test.ts`
- `packages/curriculum/test/context.test.ts`
- `packages/curriculum/test/plan.test.ts`
- `packages/curriculum/test/prompts.test.ts`
- `packages/review/test/refine.test.ts`
- `packages/review/test/revise.test.ts`
- `packages/feedback/test/rates.test.ts`
- `packages/core/test/lessons.test.ts`

No full application test suite was run as part of the original read-only review. No production implementation was made. This section records that review, not any later PR validation run.

## Reviewer proposals not adopted

The lead challenged the following architecture suggestions, which were withdrawn or narrowed:

- Reject a rule with more than two checks: a valid compact invariant can contain several checks, so this conflicts with retaining supported behavior. Keep the current length lint; do not add that judge rule.
- Automatically discount a helpful vote when the same pattern failed: partial help or later correction is possible. Flag the overlap for audit instead.
- Require a broad failure label's share below a fixed percentage: this rewards taxonomy changes rather than fewer failures. Use stable mechanism cases and exposure-aware outcomes.
- Tune a new escalation floor to a current rate before checking its window: repair measurements before calibration.
- Declare a skill redundant because related files exist in another world: verify discovery in the target configuration first.

Taxonomy drift and an additive drafting tendency remain plausible contributors to long-term growth. The review did not prove that either explains every historical rewrite. The directly reproduced pipeline defects are sufficient to justify the first corrective work.

## Constraints to preserve

- Hooks remain non-blocking, model-free and within their latency budget.
- One critic implementation, owned by the worker.
- World separation before identity/alias resolution.
- Human approval for accepted artifacts and type/split changes.
- Existing `reviewed_state` protection.
- No silent shared-layer fallback that hides failed evidence or validation.
- No automatic relabeling of historical failures to make effectiveness numbers improve.
- No claims of reduced real-world failures from passing mocked pipeline tests alone.

## Next decision

Agree a bounded first implementation scope from T1-T5. Changes need regression tests that fail on the reviewed source and pass on the fix, followed by the repository's normal validation before a PR.
