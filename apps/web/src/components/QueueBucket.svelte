<script lang="ts">
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
</script>

<div class="card">
  <h3>{name} ({entries.length})</h3>
  <ul class="list">
    {#if entries.length === 0}
      <li class="muted">empty</li>
    {/if}
    {#each entries as e}
      <li>
        <div>{e.session_id}, {e.world}, {e.cwd}</div>
        <div class="muted">
          stops: {e.stops} tool_uses: {e.tool_uses} last_stop: {e.last_stop}{e.result ? `  result: ${e.result}` : ""}
        </div>
        {#if skippable}
          <button onclick={() => onSkip?.(e.session_id)}>Skip</button>
        {/if}
      </li>
    {/each}
  </ul>
</div>
