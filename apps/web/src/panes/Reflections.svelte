<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";
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
    try {
      selected = (await call("reflections.get", { world: appState.world, id })) as ReflectionDetail;
    } catch (e) {
      toast(`could not load reflection: ${(e as Error).message}`);
    }
  }

  onMount(load);
</script>

<h2>Reflections</h2>
<div class="actions">
  <input placeholder="pattern filter" bind:value={patternFilter} />
  <input type="number" style="width:6rem" bind:value={limit} />
  <button onclick={load}>Refresh</button>
</div>

<div class="split">
  <ul class="list">
    {#if items.length === 0}
      <li class="muted">no reflections</li>
    {/if}
    {#each items as r}
      <li>
        <button class="row" onclick={() => open(r.id)}>
          <strong>{r.pattern}</strong> <span class="muted">{r.created}</span>
          <div>
            {#each r.artifacts_used ?? [] as ref}<span class="chip">used: {ref}</span>{/each}
            {#each r.artifacts_helpful ?? [] as ref}<span class="chip ok-text">helpful: {ref}</span>{/each}
            {#each r.artifacts_misfired ?? [] as ref}<span class="chip error-text">misfired: {ref}</span>{/each}
          </div>
        </button>
      </li>
    {/each}
  </ul>

  <div class="card">
    {#if selected}
      <h3>{selected.pattern}</h3>
      <p class="muted">{selected.id}, {selected.created}, {selected.session_id ?? ""}</p>
      <div>
        {#each selected.artifacts_used ?? [] as ref}<span class="chip">used: {ref}</span>{/each}
        {#each selected.artifacts_helpful ?? [] as ref}<span class="chip ok-text">helpful: {ref}</span>{/each}
        {#each selected.artifacts_misfired ?? [] as ref}<span class="chip error-text">misfired: {ref}</span>{/each}
      </div>
      <MarkdownBody text={selected.body} />
    {:else}
      <p class="muted">Select a reflection.</p>
    {/if}
  </div>
</div>
