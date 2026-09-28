<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";
  import { formatTime, plural } from "../lib/format.ts";
  import { groupByDay, patternCounts } from "../lib/reflections.ts";
  import MarkdownBody from "../components/MarkdownBody.svelte";
  import Skeleton from "../components/Skeleton.svelte";

  const LIST_LIMIT = 500;
  const TOP_CHIPS = 12;

  interface ReflectionSummary {
    id: string;
    pattern: string;
    created: string;
    lesson?: string;
    artifacts_used?: string[];
    artifacts_helpful?: string[];
    artifacts_misfired?: string[];
  }

  interface ReflectionDetail extends ReflectionSummary {
    session_id?: string | null;
    body: string;
  }

  let allItems = $state<ReflectionSummary[]>([]);
  let loading = $state(true);
  let searchQuery = $state("");
  let patternChip = $state<string | null>(null);
  let selectedId = $state<string | null>(null);
  let selected = $state<ReflectionDetail | null>(null);
  let selectedLoading = $state(false);
  // Patterns with a proposal currently staged, so the reader's pattern chip
  // can link to Review only when there is somewhere for it to go.
  let stagedPatterns = $state<Set<string>>(new Set());

  const chips = $derived(patternCounts(allItems).slice(0, TOP_CHIPS));

  const filtered = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    return allItems.filter((r) => {
      if (patternChip && r.pattern !== patternChip) return false;
      if (!q) return true;
      return r.pattern.toLowerCase().includes(q) || (r.lesson ?? "").toLowerCase().includes(q);
    });
  });

  const groups = $derived(groupByDay(filtered));

  function firstLine(text: string | undefined): string {
    return (text ?? "").split("\n")[0]!.trim();
  }

  interface CountBadge {
    label: string;
    cls: string;
  }

  // Counts, not a chip per artifact ref: a reflection touching 40 artifacts
  // must not repeat Review's wall-of-ids mistake in the list.
  function countBadges(r: ReflectionSummary): CountBadge[] {
    const out: CountBadge[] = [];
    if (r.artifacts_used?.length) out.push({ label: `Used ${r.artifacts_used.length}`, cls: "" });
    if (r.artifacts_helpful?.length) out.push({ label: `Helpful ${r.artifacts_helpful.length}`, cls: "ok" });
    if (r.artifacts_misfired?.length) out.push({ label: `Misfired ${r.artifacts_misfired.length}`, cls: "err" });
    return out;
  }

  function togglePatternChip(pattern: string) {
    patternChip = patternChip === pattern ? null : pattern;
  }

  async function load() {
    loading = true;
    try {
      allItems = (await call("reflections.list", { world: appState.world, limit: LIST_LIMIT })) as ReflectionSummary[];
    } catch (e) {
      toast(`could not load reflections: ${(e as Error).message}`);
    } finally {
      loading = false;
    }
  }

  async function loadStaged() {
    try {
      const q = (await call("review.queue", { world: appState.world })) as { pattern: string }[];
      stagedPatterns = new Set(q.map((i) => i.pattern));
    } catch {
      // Decorative only: a failed fetch just means the reader's pattern chip
      // does not link out. The reflections list above still loads and toasts
      // its own failure independently.
      stagedPatterns = new Set();
    }
  }

  async function open(id: string) {
    selectedId = id;
    selected = null;
    selectedLoading = true;
    try {
      selected = (await call("reflections.get", { world: appState.world, id })) as ReflectionDetail;
    } catch (e) {
      toast(`could not load reflection: ${(e as Error).message}`);
    } finally {
      selectedLoading = false;
    }
  }

  function deepLinkId(): string | null {
    const raw = window.location.hash.replace(/^#\/?/, "");
    const parts = raw.split("/");
    return parts[0] === "reflections" && parts[1] ? decodeURIComponent(parts[1]) : null;
  }

  function onHashChange() {
    const id = deepLinkId();
    if (id && id !== selectedId) void open(id);
  }

  onMount(() => {
    void load().then(() => {
      const id = deepLinkId();
      if (id) void open(id);
    });
    void loadStaged();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  });
</script>

<div class="toolbar">
  <input type="search" placeholder="Search pattern or lesson" aria-label="Search reflections" bind:value={searchQuery} class="reflections-search" />
  <button onclick={load}>Refresh</button>
</div>

{#if chips.length > 0}
  <div class="chips reflections-chips">
    {#each chips as c (c.pattern)}
      <button type="button" class="chip" class:accent={patternChip === c.pattern} onclick={() => togglePatternChip(c.pattern)}>
        {c.pattern} <strong>{c.count}</strong>
      </button>
    {/each}
    {#if patternChip}
      <button type="button" class="chip" onclick={() => (patternChip = null)}>Clear filter</button>
    {/if}
  </div>
{/if}

<div class="reflections-split">
  <div class="panel">
    <div class="panel__head">
      <h3>Reflections</h3>
      <span class="badge">{filtered.length}</span>
    </div>
    <div class="panel__body">
      {#if loading}
        <ul class="list">
          {#each Array.from({ length: 6 }) as _}
            <li><Skeleton height="2.6rem" /></li>
          {/each}
        </ul>
      {:else if allItems.length === 0}
        <div class="empty">
          <strong>No reflections yet</strong>
          They appear once the worker finishes reflecting on a session.
        </div>
      {:else if filtered.length === 0}
        <div class="empty">
          <strong>No reflections match this filter</strong>
          Clear the search or the pattern chip to see all reflections.
        </div>
      {:else}
        <div class="scroll-list">
          {#each groups as group (group.day)}
            <h4 class="day-heading">{group.label} <span class="muted">({plural(group.items.length, "reflection")})</span></h4>
            <ul class="list">
              {#each group.items as r (r.id)}
                <li>
                  <button class="row" class:selected={r.id === selectedId} onclick={() => open(r.id)}>
                    <div class="row__title"><span class="grow">{r.pattern}</span></div>
                    {#if firstLine(r.lesson)}
                      <p class="reflections-lesson">{firstLine(r.lesson)}</p>
                    {/if}
                    <div class="meta">
                      <span>{formatTime(r.created)}</span>
                      {#each countBadges(r) as b}<span class="chip {b.cls}">{b.label}</span>{/each}
                    </div>
                  </button>
                </li>
              {/each}
            </ul>
          {/each}
        </div>
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
      {#if selectedLoading}
        <Skeleton height="1.2rem" width="12rem" />
        <div style:margin-top="0.6rem"><Skeleton height="10rem" /></div>
      {:else if selected}
        <div class="meta">
          <span class="mono">{selected.id}</span>
          <span>{formatTime(selected.created)}</span>
          {#if selected.session_id}<span class="mono">{selected.session_id}</span>{/if}
          {#if stagedPatterns.has(selected.pattern)}
            <a class="chip accent" href="#/review">{selected.pattern}, in review</a>
          {/if}
        </div>
        {#if countBadges(selected).length > 0}
          <div class="chips">
            {#each countBadges(selected) as b}<span class="chip {b.cls}">{b.label}</span>{/each}
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
  /* reflections */
  .reflections-search {
    min-width: 16rem;
  }

  .reflections-chips {
    margin: 0 0 0.9rem;
  }

  .reflections-split {
    display: grid;
    grid-template-columns: minmax(16rem, 24rem) minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
  }

  .reflections-split > * {
    min-width: 0;
  }

  .day-heading {
    margin: 0.9rem 0 0.3rem;
    padding: 0 0.75rem;
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .day-heading:first-child {
    margin-top: 0;
  }

  .reflections-lesson {
    margin: 0.2rem 0 0;
    color: var(--muted);
    font-size: var(--fs-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 45rem) {
    .reflections-split {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
