<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";
  import { formatTime, plural } from "../lib/format.ts";
  import {
    actionTarget,
    escalationInstructionFor,
    escalationRows,
    instructionTitle,
    summariseSources,
    type EscalationRow,
    type PlanActionLike,
  } from "../lib/review.ts";
  import type { RefineResult, ReviewDetail, ReviseResult } from "../lib/api-types.ts";
  import DiffView from "../components/DiffView.svelte";
  import MarkdownBody from "../components/MarkdownBody.svelte";
  import Skeleton from "../components/Skeleton.svelte";

  const ARTIFACT_TYPES = ["skill", "hook", "rule", "agent", "none"] as const;
  const MAX_INSTRUCTION = 4000;

  interface QueueItem {
    pattern: string;
    artifact_type: string;
    // What the branch proposes. "retired" means accepting it deletes the
    // artifact, which otherwise looks like a promotion with an empty body.
    status?: string;
    staged_at?: string | null;
    count?: number;
  }

  interface Diff {
    reviewed_state: string;
    diff: string;
  }

  let items = $state<QueueItem[]>([]);
  // Raw curriculum.plan actions; escalationRows (joined with `items` below)
  // is what the Escalated section actually renders, recomputed whenever
  // either changes so accepting or rejecting a staged proposal updates which
  // escalated rows already have one.
  let escalateActions = $state<PlanActionLike[]>([]);
  const escalations = $derived<EscalationRow[]>(escalationRows(escalateActions, items.map((i) => i.pattern)));
  // Per-pattern optional instruction for Create proposal, and which patterns
  // currently have a create request in flight (disables that row's button
  // without disabling the whole section). A Map, not a plain object: a
  // pattern named "constructor" is a valid slug, and `{}[pattern]` for that
  // key returns Object.prototype's own constructor function instead of
  // undefined, which then throws the moment something calls .trim() on it.
  // SvelteMap, not a plain Map wrapped in $state: $state does not deep-track
  // mutation of a Map instance it merely holds, so `.set()` on a plain Map
  // never re-rendered the input (it kept showing the old text after a
  // successful create, and the next submit silently sent "" instead).
  // SvelteMap tracks its own `.get()`/`.set()` reads and writes directly.
  let escalationInstructions = new SvelteMap<string, string>();
  let escalationBusy = $state<Set<string>>(new Set());
  let detail = $state<ReviewDetail | null>(null);
  let diffText = $state("");
  let selectedPattern = $state<string | null>(null);
  // The digest of the proposal actually shown below. Any reload (queue
  // refresh, opening another pattern) clears it, so Accept can never fire
  // against a state the operator has not seen.
  let reviewedState = $state<string | null>(null);
  let statesMismatch = $state(false);
  let rehomeType = $state<string>("skill");
  // Loading covers the window between picking a pattern and its detail
  // landing; loadError is the pattern the load failed for, so a failure on
  // one selection does not stick around once another is opened.
  let loadingDetail = $state(false);
  let loadError = $state<{ pattern: string; message: string } | null>(null);
  // The full instruction from the last successful revise, shown as a note
  // until the operator dismisses it, opens another proposal, or acts again.
  let reviseNote = $state<string | null>(null);
  // Guards against a slow response landing after the operator has already
  // moved on to a different pattern.
  let seq = 0;

  let activeTab = $state<"proposal" | "diff">("proposal");
  let sourcesOpen = $state(false);

  let showRevise = $state(false);
  let instruction = $state("");
  let revising = $state(false);
  let reviseStartedAt = $state<number | null>(null);
  let elapsedSeconds = $state(0);
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  // Bound to the sticky footer's rendered height, so the scrollable proposal
  // body gets exactly enough bottom padding to clear it: the screenshot bug
  // was the action bar covering the last lines of the diff.
  let footerHeight = $state(64);

  function startElapsedTimer() {
    reviseStartedAt = Date.now();
    elapsedSeconds = 0;
    elapsedTimer = setInterval(() => {
      elapsedSeconds = Math.floor((Date.now() - (reviseStartedAt ?? Date.now())) / 1000);
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) clearInterval(elapsedTimer);
    elapsedTimer = null;
    reviseStartedAt = null;
  }

  onDestroy(stopElapsedTimer);

  async function loadQueue() {
    reviewedState = null;
    try {
      items = (await call("review.queue", { world: appState.world })) as QueueItem[];
    } catch (e) {
      toast(`could not load review queue: ${(e as Error).message}`);
    }
  }

  // Escalations come from curriculum.plan, not a separate review op: an
  // escalated pattern is never staged by the planner itself, only ever by a
  // human choosing to Create proposal for it.
  async function loadEscalations() {
    try {
      const plan = (await call("curriculum.plan", { world: appState.world })) as { actions: PlanActionLike[] };
      escalateActions = plan.actions;
    } catch (e) {
      toast(`could not load escalations: ${(e as Error).message}`);
    }
  }

  async function refresh() {
    await Promise.all([loadQueue(), loadEscalations()]);
  }

  async function openPattern(pattern: string) {
    if (revising) return;
    // Clear the old proposal immediately: leaving it on screen while the new
    // one loads let the operator reject or rehome the wrong pattern.
    selectedPattern = pattern;
    detail = null;
    diffText = "";
    reviewedState = null;
    loadError = null;
    loadingDetail = true;
    activeTab = "proposal";
    sourcesOpen = false;
    showRevise = false;
    reviseNote = null;
    const mySeq = ++seq;

    let d: ReviewDetail;
    let df: Diff;
    try {
      [d, df] = (await Promise.all([
        call("review.detail", { world: appState.world, pattern }),
        call("review.diff", { world: appState.world, pattern }),
      ])) as [ReviewDetail, Diff];
    } catch (e) {
      // A failure for a proposal the operator already left is not news.
      if (mySeq === seq) {
        loadError = { pattern, message: (e as Error).message };
        loadingDetail = false;
        toast(`could not load proposal: ${(e as Error).message}`);
      }
      return;
    }
    if (mySeq !== seq) return;

    const matches = d.reviewed_state === df.reviewed_state;
    statesMismatch = !matches;
    reviewedState = matches ? d.reviewed_state : null;
    detail = d;
    diffText = df.diff;
    rehomeType = d.artifact_type;
    loadingDetail = false;
  }

  function selectByIndex(index: number) {
    if (index < 0 || index >= items.length) return;
    void openPattern(items[index]!.pattern);
  }

  // Up/down moves the selection without leaving the list, so reviewing a
  // long queue does not need a pointer for every item.
  function onListKeydown(event: KeyboardEvent) {
    if (revising || items.length === 0) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = items.findIndex((i) => i.pattern === selectedPattern);
    if (event.key === "ArrowDown") selectByIndex(index === -1 ? 0 : Math.min(index + 1, items.length - 1));
    else selectByIndex(index === -1 ? 0 : Math.max(index - 1, 0));
  }

  // Captures the reviewed_state digest before clearing it, so the accept
  // call always carries the value that matched what was shown, never a
  // value read after the state has already been nulled out.
  // `fn` may return the verb to report, for a call whose outcome is only known
  // from its result (an accepted retirement is not an accepted promotion).
  async function act(fn: (digest: string | null) => Promise<unknown>, verb: string) {
    const digest = reviewedState;
    reviewedState = null;
    try {
      const said = await fn(digest);
      toast(`${selectedPattern} ${typeof said === "string" ? said : verb}`, "ok");
    } catch (e) {
      toast(`could not act on ${selectedPattern}: ${(e as Error).message}`);
    }
    selectedPattern = null;
    detail = null;
    showRevise = false;
    reviseNote = null;
    // Accepting or rejecting can change a scorecard's recurrence rate, so an
    // escalated row can stop (or start) qualifying; refresh both lists.
    await refresh();
    appState.statusSeq += 1;
  }

  function accept() {
    const pattern = actionTarget(selectedPattern, detail);
    if (!pattern) return;
    // Accepting a retirement is an accept as well, and saying "accepted" for it
    // read as "the artifact is live now", which is the opposite of what landed.
    void act(async (digest) => {
      const res = (await call("skill.accept", { world: appState.world, pattern, reviewed_state: digest })) as {
        status?: string;
      };
      return res?.status === "retired" ? "retired" : "accepted";
    }, "accepted");
  }

  function reject() {
    const pattern = actionTarget(selectedPattern, detail);
    if (!pattern) return;
    void act(() => call("skill.reject", { world: appState.world, pattern }), "rejected");
  }

  function rehome() {
    const pattern = actionTarget(selectedPattern, detail);
    if (!pattern) return;
    // Staged only, exactly like retire: the old artifact keeps serving until
    // the branch is accepted.
    const verb = rehomeType === "none" ? "retirement staged. Accept it to remove the artifact." : `re-home to ${rehomeType} staged. Accept it to apply the move.`;
    // The op asks for confirm on "none", because that type takes the artifact
    // out of service. The operator already picked it in the select here.
    const confirm = rehomeType === "none";
    void act(() => call("router.rehome", { world: appState.world, pattern, artifact_type: rehomeType, confirm }), verb);
  }

  function openRevise() {
    showRevise = true;
  }

  function dismissReviseNote() {
    reviseNote = null;
  }

  function cancelRevise() {
    showRevise = false;
    instruction = "";
  }

  async function submitRevise() {
    const pattern = selectedPattern;
    const text = instruction.trim();
    if (!pattern || !detail || reviewedState === null || text.length === 0) return;
    revising = true;
    startElapsedTimer();
    try {
      const res = (await call("review.revise", {
        world: appState.world,
        pattern,
        reviewed_state: reviewedState,
        instruction: text,
      })) as ReviseResult;
      if (selectedPattern === pattern) {
        detail = res.detail;
        diffText = res.diff;
        reviewedState = res.reviewed_state;
        statesMismatch = false;
        activeTab = "diff";
        showRevise = false;
        instruction = "";
        reviseNote = text;
      }
      toast(`Revised: ${instructionTitle(text)}`, "ok");
    } catch (e) {
      toast(`could not revise ${pattern}: ${(e as Error).message}`);
      // The instruction stays in the box: a failed revise (stale lint, a
      // timeout) must not cost the operator their typing.
    } finally {
      revising = false;
      stopElapsedTimer();
    }
  }

  function setEscalationInstruction(pattern: string, value: string): void {
    escalationInstructions.set(pattern, value);
  }

  /** Create proposal on an escalated row, or just open it if one is already
   * staged (artifacts.refine decides which; a row's own `hasProposal` only
   * changes the button label). Reuses the same detail/diff/Accept/Reject
   * controls every other staged proposal uses: the result is just another
   * pattern to openPattern.
   *
   * Captures the world and the shared `seq` generation at dispatch. `seq` is
   * bumped by `openPattern`, so if the operator selects a different staged
   * proposal while this request is in flight, the comparison below catches
   * it; a world switch remounts this whole pane, but the dead instance's
   * closure still reads the live, shared `appState.world`, which is how it
   * notices too. Either way, a stale completion still gets a toast, just
   * never a refresh, a selection or a navigation nobody asked for any more. */
  async function createOrOpenEscalation(pattern: string) {
    if (escalationBusy.has(pattern) || revising) return;
    escalationBusy = new Set(escalationBusy).add(pattern);
    const row = escalations.find((r) => r.pattern === pattern);
    const text = escalationInstructionFor(escalationInstructions, pattern).trim();
    const requestWorld = appState.world;
    const mySeq = seq;
    try {
      const result = (await call("artifacts.refine", {
        world: requestWorld,
        pattern,
        ...(row?.reason ? { reason: row.reason } : {}),
        ...(text.length > 0 ? { instruction: text } : {}),
      })) as RefineResult;
      if (mySeq !== seq || appState.world !== requestWorld) {
        toast(`${pattern}: proposal ${result.created ? "staged" : "already staged"} in ${requestWorld}.`, "ok");
        return;
      }
      toast(result.created ? `${pattern}: proposal staged.` : `${pattern}: a proposal was already staged.`, "ok");
      setEscalationInstruction(pattern, "");
      await refresh();
      // The operator may have selected a different proposal, or switched
      // world, while refresh() itself was in flight: recheck before
      // yanking them into this pattern's detail view.
      if (mySeq !== seq || appState.world !== requestWorld) return;
      await openPattern(pattern);
      appState.statusSeq += 1;
    } catch (e) {
      const stale = mySeq !== seq || appState.world !== requestWorld;
      const message = (e as Error).message;
      toast(stale ? `could not create a proposal for ${pattern} in ${requestWorld}: ${message}` : `could not create a proposal for ${pattern}: ${message}`);
    } finally {
      const next = new Set(escalationBusy);
      next.delete(pattern);
      escalationBusy = next;
    }
  }

  // The pattern Accept, Reject, Apply and Request changes may act on. Null
  // while the detail is still loading, failed to load, or is stale for the
  // current selection.
  const target = $derived(actionTarget(selectedPattern, detail));

  // Whether the proposal is ready to accept, independent of a revise in
  // flight: revising disables the button but must not make the state chip
  // read as "Loading" when nothing is loading.
  const readyToAccept = $derived(target !== null && reviewedState !== null && !detail?.accept_blocked);
  const canAccept = $derived(readyToAccept && !revising);

  const stateInfo = $derived.by((): { cls: string; label: string } => {
    if (!detail) return { cls: "", label: "" };
    if (detail.accept_blocked) return { cls: "err", label: "Accept blocked" };
    if (statesMismatch) return { cls: "warn", label: "Out of sync" };
    if (readyToAccept) return { cls: "ok", label: "Ready to accept" };
    return { cls: "warn", label: "Loading" };
  });

  // Explains a disabled Accept button. Display only, never read by accept().
  const acceptDisabledReason = $derived.by((): string => {
    if (canAccept) return "";
    if (revising) return "Wait for the revision to finish.";
    if (detail?.accept_blocked) return `Accept is blocked: ${detail.accept_blocked}`;
    if (statesMismatch) return "This proposal changed after it was opened. Press Refresh, then open it again.";
    return "Loading the proposal, one moment.";
  });

  const sourcesSummary = $derived(summariseSources(detail?.sources ?? []));

  onMount(async () => {
    await refresh();
    // Artifacts' Refine button sets this just before navigating here, so the
    // generated (or reopened) proposal opens in this same detail view
    // instead of leaving the operator to find it in the list themselves.
    const pending = appState.openReviewPattern;
    if (pending !== null) {
      appState.openReviewPattern = null;
      await openPattern(pending);
    }
  });
</script>

<div class="toolbar">
  <button onclick={refresh} disabled={revising}>Refresh</button>
</div>

<div class="split">
  <div class="panel">
    <div class="panel__head">
      <h3>Staged proposals</h3>
      <span class="badge accent">{items.length}</span>
    </div>
    <div class="panel__body">
      {#if items.length === 0}
        <div class="empty">
          <strong>Nothing is staged</strong>
          Run curriculum from the Loop pane to look for patterns that reached the threshold.
        </div>
      {:else}
        <ul class="list scroll-list" role="listbox" aria-label="Staged proposals" onkeydown={onListKeydown}>
          {#each items as item (item.pattern)}
            <li>
              <button
                class="row"
                role="option"
                aria-selected={item.pattern === selectedPattern}
                class:selected={item.pattern === selectedPattern}
                disabled={revising}
                onclick={() => openPattern(item.pattern)}
              >
                <div class="row__title">
                  <span class="dot {item.status === 'retired' ? 'warn' : 'ok'}" aria-hidden="true"></span>
                  <span class="grow">{item.pattern}</span>
                </div>
                <div class="meta">
                  <span class="chip">{item.artifact_type}</span>
                  {#if item.status === "retired"}
                    <span class="chip warn">retirement</span>
                  {/if}
                  <span class="chip">{plural(item.count ?? 0, "source")}</span>
                  <span>{formatTime(item.staged_at ?? null)}</span>
                </div>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>

  <div class="detail">
    {#if loadingDetail}
      <div class="panel">
        <div class="panel__body">
          <div class="skeleton-stack">
            <Skeleton width="40%" height="1.4rem" />
            <Skeleton height="1rem" />
            <Skeleton height="1rem" />
            <Skeleton width="70%" height="1rem" />
          </div>
        </div>
      </div>
    {:else if loadError}
      <div class="panel">
        <div class="panel__body">
          <div class="notice error">Could not load {loadError.pattern}: {loadError.message}</div>
        </div>
      </div>
    {:else if detail}
      <div class="panel">
        <div class="panel__head">
          <h3>{detail.pattern}</h3>
          <span class="chip">{detail.artifact_type}</span>
          {#if detail.artifact_path}
            <span class="badge mono">{detail.artifact_path}</span>
          {/if}
          <span class="spacer"></span>
          <span class="chip {stateInfo.cls}">{stateInfo.label}</span>
        </div>
        <div class="panel__body detail-scroll" style:padding-bottom={`${footerHeight}px`}>
          {#if detail.status === "retired"}
            <div class="notice">
              This branch retires {detail.pattern}. Accepting it deletes the {detail.artifact_type} and records the pattern as
              retired, so the body below is empty on purpose. Read the diff.
            </div>
          {/if}
          {#if detail.accept_blocked}
            <div class="notice error">Accept is blocked: {detail.accept_blocked}</div>
          {/if}
          {#if statesMismatch}
            <div class="notice error">
              This proposal changed after it was opened. Press Refresh, then open it again before acting.
            </div>
          {/if}
          {#if sourcesSummary.count > 0}
            <div class="sources">
              <button class="ghost sources__toggle" aria-expanded={sourcesOpen} onclick={() => (sourcesOpen = !sourcesOpen)}>
                {sourcesOpen ? "Hide" : "Show"} {plural(sourcesSummary.count, "source")}
              </button>
              {#if sourcesOpen}
                <div class="sources__panel">
                  {#each sourcesSummary.days as d (d.day)}
                    <div class="sources__day">
                      <span class="chip">{d.day}</span>
                      <span class="muted">{plural(d.count, "reflection")}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

          {#if reviseNote}
            <div class="notice revise-note">
              <span class="grow">Requested: {reviseNote}</span>
              <button class="ghost" onclick={dismissReviseNote} aria-label="Dismiss requested-changes note">Dismiss</button>
            </div>
          {/if}

          <div class="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={activeTab === "proposal"} class:active={activeTab === "proposal"} onclick={() => (activeTab = "proposal")}>
              Proposal
            </button>
            <button type="button" role="tab" aria-selected={activeTab === "diff"} class:active={activeTab === "diff"} onclick={() => (activeTab = "diff")}>
              Diff
            </button>
          </div>

          {#if activeTab === "proposal"}
            {#if detail.artifact_type === "rule"}
              <!-- Shown verbatim, not as rendered markdown: a rule bullet's line
                   breaks and its rule tag are part of what the reviewer judges. -->
              <pre class="file">{detail.body}</pre>
            {:else}
              <MarkdownBody text={detail.body} />
            {/if}
          {:else}
            <DiffView text={diffText} />
          {/if}
        </div>
      </div>

      <div class="detail-footer" bind:clientHeight={footerHeight}>
        {#if showRevise}
          <div class="revise-panel">
            <label for="revise-instruction">Request changes</label>
            <textarea
              id="revise-instruction"
              maxlength={MAX_INSTRUCTION}
              placeholder="Describe what should change. The drafter will rewrite the proposal and keep the rest."
              bind:value={instruction}
              disabled={revising}
            ></textarea>
            <div class="revise-panel__foot">
              <span class="muted">{instruction.length} / {MAX_INSTRUCTION}</span>
              <span class="spacer"></span>
              {#if revising}
                <span class="muted">Drafter is revising... {elapsedSeconds}s</span>
              {:else}
                <button onclick={cancelRevise}>Cancel</button>
                <button class="primary" disabled={instruction.trim().length === 0} onclick={submitRevise}>Submit</button>
              {/if}
            </div>
          </div>
        {/if}
        <div class="action-bar">
          <button class="primary" disabled={!canAccept} title={canAccept ? undefined : acceptDisabledReason} onclick={accept}>
            {detail.status === "retired" ? "Accept retirement" : "Accept proposal"}
          </button>
          <button
            disabled={revising || reviewedState === null || target === null || detail.status === "retired"}
            title={detail.status === "retired"
              ? "A retirement has no artifact to revise; reject it or rehome instead."
              : reviewedState === null
                ? "Refresh this proposal before requesting changes."
                : undefined}
            onclick={openRevise}
          >
            Request changes
          </button>
          <button class="danger" disabled={revising || target === null} onclick={reject}>Reject proposal</button>
          <span class="toolbar__spacer"></span>
          <label class="control">
            <span>Move to</span>
            <select bind:value={rehomeType} disabled={revising}>
              {#each ARTIFACT_TYPES as t}
                <option value={t}>{t}</option>
              {/each}
            </select>
          </label>
          <button disabled={revising || target === null} onclick={rehome}>Apply</button>
        </div>
      </div>
    {:else}
      <div class="panel">
        <div class="panel__body">
          <div class="empty">
            <strong>No proposal selected</strong>
            Pick a staged proposal from the list to review its diff and decide.
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<div class="panel escalated">
  <div class="panel__head">
    <h3>Escalated</h3>
    <span class="badge warn">{escalations.length}</span>
    <span class="spacer"></span>
    <span class="meta">Recurring almost as often as before a redraft. Try one more redraft, or change the type or split the pattern yourself.</span>
  </div>
  <div class="panel__body">
    {#if escalations.length === 0}
      <div class="empty">
        <strong>Nothing escalated.</strong>
        An artifact lands here when it keeps recurring at nearly its pre-redraft rate after using up its redraft budget.
      </div>
    {:else}
      <p class="meta escalated__hint">
        Create proposal always keeps the current artifact type and sends this row's reason to the drafter. For a type change, use Move to on the
        proposal once it opens here, or Rehome from Artifacts.
      </p>
      <ul class="list">
        {#each escalations as row (row.pattern)}
          <li class="escalated__row">
            <div class="row__title">
              <span class="grow mono">{row.pattern}</span>
              <span class="chip">{plural(row.evidenceCount, "reflection")}</span>
              {#if row.hasProposal}
                <span class="chip accent">proposal staged</span>
              {/if}
            </div>
            <p class="meta">{row.reason}</p>
            <div class="escalated__action">
              <input
                type="text"
                maxlength={MAX_INSTRUCTION}
                placeholder="Optional instruction for the redraft"
                value={escalationInstructionFor(escalationInstructions, row.pattern)}
                oninput={(e) => setEscalationInstruction(row.pattern, (e.currentTarget as HTMLInputElement).value)}
                disabled={escalationBusy.has(row.pattern)}
              />
              <button disabled={escalationBusy.has(row.pattern) || revising} onclick={() => createOrOpenEscalation(row.pattern)}>
                {#if escalationBusy.has(row.pattern)}
                  Working...
                {:else if row.hasProposal}
                  Open proposal
                {:else}
                  Create proposal
                {/if}
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  /* review */
  .file {
    max-height: 26rem;
    margin: 0;
    overflow: auto;
    padding: 0.75rem 0.85rem;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--panel);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .detail {
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  .skeleton-stack {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .revise-note {
    align-items: center;
    background: var(--panel);
  }

  .detail-scroll {
    scroll-margin-bottom: 1rem;
  }

  .sources {
    margin: 0 0 0.9rem;
  }

  .sources__toggle {
    font-size: var(--fs-xs);
    padding: 0.2rem 0.5rem;
  }

  .sources__panel {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 0.6rem;
    margin-top: 0.5rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--panel);
  }

  .sources__day {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--fs-xs);
  }

  .tabs {
    display: flex;
    gap: 0.3rem;
    margin: 0 0 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .tabs button {
    background: none;
    border: none;
    border-radius: 0;
    border-bottom: 2px solid transparent;
    padding: 0.4rem 0.2rem;
    margin-right: 0.9rem;
    color: var(--muted);
    font-weight: 500;
  }

  .tabs button.active {
    color: var(--fg);
    border-bottom-color: var(--accent);
  }

  /* The footer (revise panel plus action bar) sticks as one unit; the panel
     body above gets padding-bottom bound to this element's rendered height,
     so the sticky footer never covers the last lines of the proposal. */
  .detail-footer {
    position: sticky;
    bottom: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-top: 1px solid var(--border);
    /* Lets .action-bar query its own rendered width below, since the detail
       column's width depends on the rail and list panel next to it, not the
       viewport. */
    container-type: inline-size;
  }

  .action-bar {
    display: grid;
    grid-template-columns: auto auto auto 1fr auto auto;
    align-items: center;
    gap: 0.6rem;
    padding: 0.75rem 0.9rem;
  }

  /* Below this width the six-item row no longer fits. Wrapping each item on
     its own stranded Apply alone on its own line. Put Move to and Apply on
     one grid row instead, so they always wrap or stay together as a pair. */
  @container (max-width: 34rem) {
    .action-bar {
      grid-template-columns: 1fr 1fr;
      row-gap: 0.5rem;
    }

    .action-bar > :nth-child(1) {
      grid-column: 1 / -1;
    }

    .action-bar > :nth-child(2) {
      grid-column: 1;
    }

    .action-bar > :nth-child(3) {
      grid-column: 2;
    }

    .action-bar > :nth-child(4) {
      display: none;
    }

    .action-bar > :nth-child(5) {
      grid-column: 1;
    }

    .action-bar > :nth-child(6) {
      grid-column: 2;
    }

    .action-bar .control {
      min-width: 0;
    }

    .action-bar select {
      min-width: 0;
      width: 100%;
    }
  }

  .revise-panel {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.75rem 0.9rem;
    border-bottom: 1px solid var(--border);
  }

  .revise-panel label {
    font-size: var(--fs-sm);
    font-weight: 600;
  }

  .revise-panel textarea {
    min-height: 5.5rem;
    resize: vertical;
  }

  .revise-panel__foot {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--fs-xs);
  }

  .escalated {
    margin-top: 1.1rem;
  }

  .escalated__hint {
    margin: 0 0 0.75rem;
  }

  .escalated__row {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .escalated__action {
    display: flex;
    gap: 0.5rem;
  }

  .escalated__action input {
    flex: 1;
    min-width: 0;
  }
</style>
