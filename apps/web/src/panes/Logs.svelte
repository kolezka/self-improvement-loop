<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { toast } from "../lib/state.svelte.ts";

  const LOG_NAMES = ["hook", "worker", "web", "curriculum"] as const;
  const FOLLOW_INTERVAL_MS = 3000;

  interface TailResult {
    name: string;
    path: string;
    exists: boolean;
    size: number;
    lines: string[];
  }

  // worker.log is the one log guaranteed to exist on a fresh machine (see brief);
  // defaulting to it avoids opening on the empty-file explainer for hook.
  let name = $state<string>("worker");
  let lines = $state(200);
  let path = $state("");
  let exists = $state(true);
  let output = $state("");
  let follow = $state(false);
  let preEl = $state<HTMLPreElement | null>(null);

  async function load() {
    try {
      const result = (await call("logs.tail", { name, lines })) as TailResult;
      path = result.path;
      exists = result.exists;
      output = result.lines.join("\n");
    } catch (e) {
      toast(`could not load log: ${(e as Error).message}`);
    }
  }

  $effect(() => {
    if (!follow) return;
    const timer = setInterval(load, FOLLOW_INTERVAL_MS);
    return () => clearInterval(timer);
  });

  // Runs after the <pre> has re-rendered with the new output, so scrollHeight
  // already reflects the latest lines.
  $effect(() => {
    if (preEl && output) preEl.scrollTop = preEl.scrollHeight;
  });

  onMount(load);
</script>

<h2>Logs</h2>
<div class="actions">
  <select bind:value={name}>
    {#each LOG_NAMES as n}
      <option value={n}>{n}</option>
    {/each}
  </select>
  <input type="number" style="width:6rem" bind:value={lines} />
  <button onclick={load}>Tail</button>
  <label class="follow-label">
    <input type="checkbox" bind:checked={follow} />
    Follow
  </label>
</div>
<p class="muted">{path}</p>
{#if !exists}
  <p class="muted">
    This log has not been written yet.
    {#if name === "hook"}The hook writes it on the first session event.{/if}
  </p>
{:else if output === ""}
  <p class="muted">log is empty</p>
{:else}
  <pre bind:this={preEl}>{output}</pre>
{/if}

<style>
  .follow-label {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--muted);
    font-size: 0.85rem;
  }
</style>
