<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import LogViewer from "../vendor/svelte-log-viewer/LogViewer.svelte";
  import type { LogLine as ViewerLine } from "../vendor/svelte-log-viewer/index.ts";
  import { streamLog } from "../lib/stream.ts";
  import { toViewerLine } from "../lib/logs.ts";

  const LOG_NAMES = ["hook", "worker", "web", "curriculum"] as const;
  const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000];
  const MAX_LINES = 20_000;

  type LogName = (typeof LOG_NAMES)[number];

  let name = $state<LogName>("worker");
  let lines = $state.raw<ViewerLine[]>([]);
  let live = $state(false);
  let reconnecting = $state(false);
  let capped = $state(false);
  let missing = $state(false);
  let error = $state<string | null>(null);
  let follow = $state(true);
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryIndex = 0;
  let nextSequence = 1;

  function clearRetryTimer() {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function stopStream() {
    clearRetryTimer();
    controller?.abort();
    controller = null;
    live = false;
    reconnecting = false;
  }

  function appendLine(raw: string, source: LogName) {
    const next = [...lines, toViewerLine(raw, nextSequence, source)];
    nextSequence += 1;
    if (next.length > MAX_LINES) {
      lines = next.slice(next.length - MAX_LINES);
      capped = true;
    } else {
      lines = next;
    }
    retryIndex = 0;
  }

  function scheduleReconnect() {
    const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)]!;
    retryIndex += 1;
    reconnecting = true;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      startStream();
    }, delay);
  }

  function startStream() {
    clearRetryTimer();
    const source = name;
    const active = new AbortController();
    controller = active;
    live = true;
    reconnecting = false;
    error = null;

    void streamLog(
      source,
      {
        onLine: (raw) => {
          if (controller !== active) return;
          missing = false;
          appendLine(raw, source);
        },
        onReset: () => {
          if (controller !== active) return;
          lines = [];
          capped = false;
          nextSequence = 1;
        },
        onMissing: () => {
          if (controller === active) missing = true;
        },
      },
      active.signal,
    )
      .then(() => {
        if (controller !== active || active.signal.aborted) return;
        live = false;
        scheduleReconnect();
      })
      .catch((cause: unknown) => {
        if (controller !== active || active.signal.aborted) return;
        live = false;
        error = cause instanceof Error ? cause.message : String(cause);
        scheduleReconnect();
      });
  }

  function selectLog(next: LogName) {
    if (next === name) return;
    stopStream();
    name = next;
    lines = [];
    capped = false;
    missing = false;
    error = null;
    nextSequence = 1;
    retryIndex = 0;
    startStream();
  }

  onMount(startStream);
  onDestroy(stopStream);
</script>

<div class="toolbar log-toolbar">
  <div class="segmented log-picker" role="group" aria-label="Log source">
    {#each LOG_NAMES as option}
      <button type="button" aria-pressed={name === option} onclick={() => selectLog(option)}>{option}</button>
    {/each}
  </div>
  <span class="toolbar__spacer"></span>
  {#if reconnecting}
    <span class="chip warn">Reconnecting</span>
  {:else if live}
    <span class="chip ok">Live</span>
  {/if}
  {#if missing}
    <span class="muted">Waiting for this log file.</span>
  {/if}
</div>

{#if error}
  <p class="error-text">Log stream error: {error}</p>
{/if}

<LogViewer
  {lines}
  {live}
  bind:follow
  {capped}
  height="min(64vh, 720px)"
  emptyTitle="No output yet"
  emptyDescription="Lines appear here as soon as this log writes them."
/>

<style>
  .log-toolbar {
    margin-bottom: 0.75rem;
  }

  .log-picker button {
    width: auto;
    min-width: 4.5rem;
    padding: 0 0.55rem;
    text-transform: capitalize;
  }
</style>
