<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";
  import { formatTime } from "../lib/format.ts";
  import DiffView from "../components/DiffView.svelte";

  const ARTIFACT_TYPES = ["skill", "hook", "rule", "agent", "none"] as const;

  interface QueueItem {
    pattern: string;
    artifact_type: string;
    // What the branch proposes. "retired" means accepting it deletes the
    // artifact, which otherwise looks like a promotion with an empty body.
    status?: string;
    staged_at?: string | null;
  }

  interface Detail {
    pattern: string;
    artifact_type: string;
    status?: string;
    artifact_path?: string | null;
    reviewed_state: string;
    accept_blocked?: string | null;
    sources?: string[];
    body: string;
  }

  interface Diff {
    reviewed_state: string;
    diff: string;
  }

  let items = $state<QueueItem[]>([]);
  let detail = $state<Detail | null>(null);
  let diffText = $state("");
  let selectedPattern = $state<string | null>(null);
  // The digest of the proposal actually shown below. Any reload (queue
  // refresh, opening another pattern) clears it, so Accept can never fire
  // against a state the operator has not seen.
  let reviewedState = $state<string | null>(null);
  let statesMismatch = $state(false);
  let rehomeType = $state<string>("skill");
  // Guards against a slow response landing after the operator has already
  // moved on to a different pattern.
  let seq = 0;

  async function loadQueue() {
    reviewedState = null;
    try {
      items = (await call("review.queue", { world: appState.world })) as QueueItem[];
    } catch (e) {
      toast(`could not load review queue: ${(e as Error).message}`);
    }
  }

  async function openPattern(pattern: string) {
    selectedPattern = pattern;
    reviewedState = null;
    const mySeq = ++seq;

    let d: Detail;
    let df: Diff;
    try {
      [d, df] = (await Promise.all([
        call("review.detail", { world: appState.world, pattern }),
        call("review.diff", { world: appState.world, pattern }),
      ])) as [Detail, Diff];
    } catch (e) {
      toast(`could not load proposal: ${(e as Error).message}`);
      return;
    }
    if (mySeq !== seq) return;

    const matches = d.reviewed_state === df.reviewed_state;
    statesMismatch = !matches;
    reviewedState = matches ? d.reviewed_state : null;
    detail = d;
    diffText = df.diff;
    rehomeType = d.artifact_type;
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
    await loadQueue();
    appState.statusSeq += 1;
  }

  function accept() {
    const pattern = selectedPattern;
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
    const pattern = selectedPattern;
    if (!pattern) return;
    void act(() => call("skill.reject", { world: appState.world, pattern }), "rejected");
  }

  function rehome() {
    const pattern = selectedPattern;
    if (!pattern) return;
    // Staged only, exactly like retire: the old artifact keeps serving until
    // the branch is accepted.
    const verb = rehomeType === "none" ? "retirement staged. Accept it to remove the artifact." : `re-home to ${rehomeType} staged. Accept it to apply the move.`;
    void act(() => call("router.rehome", { world: appState.world, pattern, artifact_type: rehomeType }), verb);
  }

  const canAccept = $derived(reviewedState !== null && !detail?.accept_blocked);

  // Display-only summary of where the proposal stands, derived from the same
  // signals canAccept already uses. Never consulted by act()/accept().
  const stateInfo = $derived.by((): { cls: string; label: string } => {
    if (!detail) return { cls: "", label: "" };
    if (detail.accept_blocked) return { cls: "err", label: "Accept blocked" };
    if (statesMismatch) return { cls: "warn", label: "Out of sync" };
    if (canAccept) return { cls: "ok", label: "Ready to accept" };
    return { cls: "warn", label: "Loading" };
  });

  // Explains a disabled Accept button. Display only, never read by accept().
  const acceptDisabledReason = $derived.by((): string => {
    if (canAccept) return "";
    if (detail?.accept_blocked) return `Accept is blocked: ${detail.accept_blocked}`;
    if (statesMismatch) return "This proposal changed after it was opened. Press Refresh, then open it again.";
    return "Loading the proposal, one moment.";
  });

  onMount(loadQueue);
</script>

<div class="toolbar">
  <button onclick={loadQueue}>Refresh</button>
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
        <ul class="list scroll-list">
          {#each items as item (item.pattern)}
            <li>
              <button class="row" class:selected={item.pattern === selectedPattern} onclick={() => openPattern(item.pattern)}>
                <div class="row__title"><span class="grow">{item.pattern}</span></div>
                <div class="meta">
                  <span class="badge">{item.artifact_type}</span>
                  {#if item.status === "retired"}
                    <span class="badge">retirement</span>
                  {/if}
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
    {#if detail}
      <div class="panel">
        <div class="panel__head">
          <h3>{detail.pattern}</h3>
          <span class="badge">{detail.artifact_type}</span>
          {#if detail.artifact_path}
            <span class="badge">{detail.artifact_path}</span>
          {/if}
          <span class="spacer"></span>
          <span class="chip {stateInfo.cls}">{stateInfo.label}</span>
        </div>
        <div class="panel__body">
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
          {#if detail.sources?.length}
            <div class="meta">Sources: {detail.sources.join(", ")}</div>
          {/if}
          <!-- Shown verbatim, not as rendered markdown: this is the file that
               gets committed, and frontmatter and line breaks are part of what
               the reviewer has to judge. -->
          <pre class="file">{detail.body}</pre>
        </div>
      </div>

      <div class="panel">
        <div class="panel__head">
          <h3>Diff</h3>
        </div>
        <div class="panel__body">
          <DiffView text={diffText} />
        </div>
      </div>

      <div class="action-bar">
        <button class="primary" disabled={!canAccept} title={canAccept ? undefined : acceptDisabledReason} onclick={accept}>
          {detail.status === "retired" ? "Accept retirement" : "Accept proposal"}
        </button>
        <button class="danger" onclick={reject}>Reject proposal</button>
        <span class="toolbar__spacer"></span>
        <label class="control">
          <span>Move to</span>
          <select bind:value={rehomeType}>
            {#each ARTIFACT_TYPES as t}
              <option value={t}>{t}</option>
            {/each}
          </select>
        </label>
        <button onclick={rehome}>Apply</button>
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

<style>
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

  .action-bar {
    position: sticky;
    bottom: 0;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    padding: 0.75rem 0.9rem;
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
</style>
