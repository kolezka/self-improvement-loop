<script lang="ts">
  import { formatTime, plural } from "../lib/format.ts";

  interface QueueEntry {
    session_id: string;
    world: string;
    cwd: string;
    stops: number;
    tool_uses: number;
    last_stop: string;
    result: string | null;
  }

  let {
    name,
    entries,
    skippable = false,
    onSkip,
  }: {
    name: string;
    entries: QueueEntry[];
    skippable?: boolean;
    onSkip?: (sessionId: string) => void;
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
  </div>
  <div class="panel__body">
    {#if entries.length === 0}
      <div class="empty">
        <strong>{empty.title}</strong>
        {empty.body}
      </div>
    {:else}
      <ul class="list scroll-list">
        {#each entries as e (e.session_id)}
          <li>
            <div class="entry-head">
              <span class="mono">{e.session_id}</span>
              <span class="chip">{e.world}</span>
              {#if skippable}
                <button class="small" onclick={() => onSkip?.(e.session_id)}>Skip session</button>
              {/if}
            </div>
            <div class="entry-cwd muted">{e.cwd}</div>
            <div class="meta">
              <span>{plural(e.stops, "stop")}</span>
              <span>{plural(e.tool_uses, "tool use")}</span>
              <span>last stop {formatTime(e.last_stop)}</span>
            </div>
            {#if e.result}
              <div class="error-text">{e.result}</div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .entry-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .entry-head button {
    margin-left: auto;
  }

  .entry-cwd {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin: 0.15rem 0;
  }
</style>
