<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";
  import { formatTime } from "../lib/format.ts";
  import MarkdownBody from "../components/MarkdownBody.svelte";

  interface ReflectionSummary {
    id: string;
    pattern: string;
    created: string;
    artifacts_used?: string[];
    artifacts_helpful?: string[];
    artifacts_misfired?: string[];
  }

  interface ReflectionDetail extends ReflectionSummary {
    session_id?: string | null;
    body: string;
  }

  let patternFilter = $state("");
  let limit = $state(100);
  let items = $state<ReflectionSummary[]>([]);
  let selectedId = $state<string | null>(null);
  let selected = $state<ReflectionDetail | null>(null);

  async function load() {
    const payload: Record<string, unknown> = { world: appState.world };
    if (patternFilter.trim()) payload["pattern"] = patternFilter.trim();
    if (limit > 0) payload["limit"] = limit;
    try {
      items = (await call("reflections.list", payload)) as ReflectionSummary[];
    } catch (e) {
      toast(`could not load reflections: ${(e as Error).message}`);
    }
  }

  async function open(id: string) {
    selectedId = id;
    selected = null;
    try {
      selected = (await call("reflections.get", { world: appState.world, id })) as ReflectionDetail;
    } catch (e) {
      toast(`could not load reflection: ${(e as Error).message}`);
    }
  }

  onMount(load);
</script>

<div class="toolbar">
  <input
    type="search"
    placeholder="Filter by pattern"
    aria-label="Filter by pattern"
    bind:value={patternFilter}
    class="pattern-filter"
  />
  <label class="control">
    <span>Show</span>
    <input type="number" min="1" bind:value={limit} class="limit-input" />
  </label>
  <button onclick={load}>Refresh</button>
</div>

<div class="split">
  <div class="panel">
    <div class="panel__head">
      <h3>Reflections</h3>
      <span class="badge">{items.length}</span>
    </div>
    <div class="panel__body">
      {#if items.length === 0}
        <div class="empty">
          {#if patternFilter.trim()}
            <strong>No reflections match "{patternFilter.trim()}"</strong>
            Clear the filter to see all reflections.
          {:else}
            <strong>No reflections yet</strong>
            They appear once the worker finishes reflecting on a session.
          {/if}
        </div>
      {:else}
        <ul class="list scroll-list">
          {#each items as r (r.id)}
            <li>
              <button class="row" class:selected={r.id === selectedId} onclick={() => open(r.id)}>
                <div class="row__title"><span class="grow">{r.pattern}</span></div>
                <div class="meta">{formatTime(r.created)}</div>
                {#if r.artifacts_used?.length || r.artifacts_helpful?.length || r.artifacts_misfired?.length}
                  <div class="chips">
                    {#each r.artifacts_used ?? [] as ref}<span class="chip">Used <strong>{ref}</strong></span>{/each}
                    {#each r.artifacts_helpful ?? [] as ref}<span class="chip ok">Helpful <strong>{ref}</strong></span>{/each}
                    {#each r.artifacts_misfired ?? [] as ref}<span class="chip err">Misfired <strong>{ref}</strong></span>{/each}
                  </div>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>

  <div class="panel">
    {#if selected}
      <div class="panel__head">
        <h3>{selected.pattern}</h3>
      </div>
    {/if}
    <div class="panel__body">
      {#if selected}
        <div class="meta">
          <span class="mono">{selected.id}</span>
          <span>{formatTime(selected.created)}</span>
          {#if selected.session_id}<span class="mono">{selected.session_id}</span>{/if}
        </div>
        {#if selected.artifacts_used?.length || selected.artifacts_helpful?.length || selected.artifacts_misfired?.length}
          <div class="chips">
            {#each selected.artifacts_used ?? [] as ref}<span class="chip">Used <strong>{ref}</strong></span>{/each}
            {#each selected.artifacts_helpful ?? [] as ref}<span class="chip ok">Helpful <strong>{ref}</strong></span>{/each}
            {#each selected.artifacts_misfired ?? [] as ref}<span class="chip err">Misfired <strong>{ref}</strong></span>{/each}
          </div>
        {/if}
        <MarkdownBody text={selected.body} />
      {:else if selectedId}
        <p class="muted">Loading reflection&hellip;</p>
      {:else}
        <div class="empty">
          <strong>No reflection selected</strong>
          Pick a reflection from the list to read what the loop learned.
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .pattern-filter {
    min-width: 16rem;
  }

  .limit-input {
    width: 4.5rem;
  }

  .chips {
    margin: 0.35rem 0 0.15rem;
  }
</style>
