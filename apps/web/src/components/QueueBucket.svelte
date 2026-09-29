<script lang="ts">
  import { formatTime, plural } from "../lib/format.ts";
  import { resultTextClass } from "../lib/queue.ts";
  import type { QueueEntry } from "../lib/api-types.ts";

  let {
    name,
    entries,
    skippable = false,
    onSkip,
    onOpen,
    onClear,
    hiddenCount = 0,
    onShowHidden,
  }: {
    name: string;
    entries: QueueEntry[];
    skippable?: boolean;
    onSkip?: (sessionId: string) => void;
    onOpen?: (entry: QueueEntry) => void;
    onClear?: () => void;
    hiddenCount?: number;
    onShowHidden?: () => void;
  } = $props();

  const label = $derived(name.charAt(0).toUpperCase() + name.slice(1));

  const EMPTY_COPY: Record<string, { title: string; body: string }> = {
    pending: {
      title: "No sessions waiting.",
      body: "The hook queues a session when it ends or goes idle.",
    },
    done: {
      title: "No sessions reflected yet.",
      body: "Sessions land here once the worker finishes reflecting on them.",
    },
    failed: {
      title: "No failed sessions.",
      body: "A session lands here if reflection errors out.",
    },
  };

  const empty = $derived(EMPTY_COPY[name] ?? { title: "Nothing here.", body: "" });
</script>

<div class="panel">
  <div class="panel__head">
    <h3>{label}</h3>
    <span class={name === "failed" && entries.length > 0 ? "chip err" : "chip"}>
      <strong>{entries.length}</strong>
    </span>
    <span class="spacer"></span>
    {#if hiddenCount > 0}
      <button class="small" onclick={onShowHidden}>Show hidden ({hiddenCount})</button>
    {/if}
    {#if onClear}
      <button class="small" onclick={onClear} disabled={entries.length === 0}>Clear</button>
    {/if}
  </div>
  <div class="panel__body">
    {#if entries.length === 0}
      <div class="empty">
        <strong>{empty.title}</strong>
        {empty.body}
      </div>
    {:else}
      <ul class="list scroll-list queue-list">
        {#each entries as entry (entry.session_id)}
          <li>
            <button class="queue-row" type="button" onclick={() => onOpen?.(entry)}>
              <div class="row__title">
                <span class="mono">{entry.session_id}</span>
                <span class="chip">{entry.world}</span>
              </div>
              <div class="queue-entry-cwd muted">{entry.cwd}</div>
              <div class="meta">
                <span>{plural(entry.stops, "stop")}</span>
                <span>{plural(entry.tool_uses, "tool use")}</span>
                <span>last stop {formatTime(entry.last_stop)}</span>
              </div>
              {#if entry.result}
                <div class={resultTextClass(name)}>{entry.result}</div>
              {/if}
            </button>
            {#if skippable}
              <div class="queue-row-actions">
                <button class="small" onclick={() => onSkip?.(entry.session_id)}>Skip session</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
