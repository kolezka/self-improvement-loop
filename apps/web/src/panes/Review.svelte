<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";
  import MarkdownBody from "../components/MarkdownBody.svelte";
  import DiffView from "../components/DiffView.svelte";

  const ARTIFACT_TYPES = ["skill", "hook", "rule", "agent", "none"] as const;

  interface QueueItem {
    pattern: string;
    artifact_type: string;
    staged_at?: string | null;
  }

  interface Detail {
    pattern: string;
    artifact_type: string;
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
  async function act(fn: (digest: string | null) => Promise<unknown>, verb: string) {
    const digest = reviewedState;
    reviewedState = null;
    try {
      await fn(digest);
      toast(`${selectedPattern} ${verb}`, "ok");
    } catch (e) {
      toast(`could not act on ${selectedPattern}: ${(e as Error).message}`);
    }
    selectedPattern = null;
    detail = null;
    await loadQueue();
  }

  function accept() {
    const pattern = selectedPattern;
    if (!pattern) return;
    void act((digest) => call("skill.accept", { world: appState.world, pattern, reviewed_state: digest }), "accepted");
  }

  function reject() {
    const pattern = selectedPattern;
    if (!pattern) return;
    void act(() => call("skill.reject", { world: appState.world, pattern }), "rejected");
  }

  function rehome() {
    const pattern = selectedPattern;
    if (!pattern) return;
    void act(() => call("router.rehome", { world: appState.world, pattern, artifact_type: rehomeType }), "rehomed");
  }

  const canAccept = $derived(reviewedState !== null && !detail?.accept_blocked);

  onMount(loadQueue);
</script>

<h2>Review</h2>
<div class="actions"><button onclick={loadQueue}>Refresh</button></div>

<div class="split">
  <ul class="list">
    {#if items.length === 0}
      <li class="muted">nothing staged</li>
    {/if}
    {#each items as item}
      <li>
        <button class="row {item.pattern === selectedPattern ? 'selected' : ''}" onclick={() => openPattern(item.pattern)}>
          <strong>{item.pattern}</strong> <span class="badge">{item.artifact_type}</span>
          <span class="muted">{item.staged_at ?? ""}</span>
        </button>
      </li>
    {/each}
  </ul>

  <div class="card">
    {#if detail}
      <h3>{detail.pattern} <span class="badge">{detail.artifact_type}</span></h3>
      {#if detail.accept_blocked}
        <p class="error-text">accept blocked: {detail.accept_blocked}</p>
      {/if}
      {#if statesMismatch}
        <p class="error-text">detail and diff disagree on reviewed_state; reload before acting</p>
      {/if}
      {#if detail.sources?.length}
        <p class="muted">sources: {detail.sources.join(", ")}</p>
      {/if}
      <MarkdownBody text={detail.body} />
      <h4>Diff</h4>
      <DiffView text={diffText} />

      <div class="actions">
        <button class="primary" disabled={!canAccept} onclick={accept}>Accept</button>
        <button class="danger" onclick={reject}>Reject</button>
        <select bind:value={rehomeType}>
          {#each ARTIFACT_TYPES as t}
            <option value={t}>{t}</option>
          {/each}
        </select>
        <button onclick={rehome}>Rehome</button>
      </div>
    {:else}
      <p class="muted">Select a staged proposal.</p>
    {/if}
  </div>
</div>
