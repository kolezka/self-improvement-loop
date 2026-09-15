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

  // worker.log is the first log that exists on any machine that has run the
  // worker once; hook.log only appears once the hook has something to log.
  let name = $state<string>("worker");
  let lines = $state(200);
  let path = $state("");
  let exists = $state(true);
  let size = $state(0);
  let output = $state("");
  let follow = $state(false);
  let loaded = $state(false);
  let preEl = $state<HTMLPreElement | null>(null);

  async function load() {
    try {
      const result = (await call("logs.tail", { name, lines })) as TailResult;
      path = result.path;
      exists = result.exists;
      size = result.size;
      output = result.lines.join("\n");
      loaded = true;
    } catch (e) {
      if (follow) {
        // A failing poll every 3s would otherwise toast forever; show it once
        // and stop following instead.
        follow = false;
        toast(`log polling failed, follow turned off: ${(e as Error).message}`);
      } else {
        toast(`could not load log: ${(e as Error).message}`);
      }
    }
  }

  function sizeText(bytes: number): string {
    return bytes > 10_000 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} bytes`;
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
<p class="muted">{path}{#if loaded && exists} <span class="muted">({sizeText(size)})</span>{/if}</p>
{#if !loaded}
  <p class="muted">loading&hellip;</p>
{:else if !exists}
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
