<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";
  import { formatTime, plural } from "../lib/format.ts";
  import {
    buildPatternOutcomeFlows,
    groupByDay,
    OTHER_PATTERNS,
    patternCounts,
    reflectionOutcome,
    reflectionSections,
    topPatternIds,
    type CurriculumPlanAction,
    type RouterStatusRow,
  } from "../lib/reflections.ts";
  import MarkdownBody from "../components/MarkdownBody.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Sankey from "../components/charts/Sankey.svelte";

  const LIST_LIMIT = 500;
  const TOP_PATTERNS = 10;
  const SANKEY_HEIGHT = 280;

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
  let routerRows = $state<RouterStatusRow[]>([]);
  let planActions = $state<CurriculumPlanAction[]>([]);
  let searchQuery = $state("");
  // Exactly one of these three is active at a time: an exact pattern (from
  // the select or a top-N Sankey node), the "Other patterns" bucket, or an
  // outcome (from a Sankey outcome node).
  let patternFilter = $state<string | null>(null);
  let otherSelected = $state(false);
  let outcomeFilter = $state<string | null>(null);
  let selectedId = $state<string | null>(null);
  let selected = $state<ReflectionDetail | null>(null);
  let selectedLoading = $state(false);
  // Patterns with a proposal currently staged, so the reader's pattern chip
  // can link to Review only when there is somewhere for it to go.
  let stagedPatterns = $state<Set<string>>(new Set());

  const patternOptions = $derived(patternCounts(allItems));
  const topIds = $derived(topPatternIds(allItems, TOP_PATTERNS));
  const flows = $derived(buildPatternOutcomeFlows(allItems, routerRows, planActions, TOP_PATTERNS));

  const activeFilterLabel = $derived.by(() => {
    if (patternFilter) return `Pattern: ${patternFilter}`;
    if (otherSelected) return OTHER_PATTERNS;
    if (outcomeFilter) return `Outcome: ${outcomeFilter}`;
    return null;
  });

  const filtered = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    return allItems.filter((r) => {
      if (patternFilter && r.pattern !== patternFilter) return false;
      if (otherSelected && topIds.has(r.pattern)) return false;
      if (outcomeFilter && reflectionOutcome(r.pattern, routerRows, planActions) !== outcomeFilter) return false;
      if (!q) return true;
      return r.pattern.toLowerCase().includes(q) || (r.lesson ?? "").toLowerCase().includes(q);
    });
  });

  const groups = $derived(groupByDay(filtered));

  const sections = $derived(selected ? reflectionSections(selected.body) : []);

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

  function selectPatternOption(value: string) {
    patternFilter = value || null;
    otherSelected = false;
    outcomeFilter = null;
  }

  function selectSankeyPattern(id: string) {
    if (id === OTHER_PATTERNS) {
      const next = !otherSelected;
      otherSelected = next;
      patternFilter = null;
      outcomeFilter = null;
      return;
    }
    patternFilter = patternFilter === id ? null : id;
    otherSelected = false;
    outcomeFilter = null;
  }

  function selectSankeyOutcome(outcome: string) {
    outcomeFilter = outcomeFilter === outcome ? null : outcome;
    patternFilter = null;
    otherSelected = false;
  }

  function clearFilter() {
    patternFilter = null;
    otherSelected = false;
    outcomeFilter = null;
  }

  /** "Not verified" reads as a checklist: one claim per line, any leading
   * bullet marker stripped since the drafted body sometimes already has one. */
  function checklistItems(text: string): string[] {
    return text
      .split("\n")
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);
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

  async function loadOutcomes() {
    try {
      const [rows, plan] = await Promise.all([
        call("router.inventory", { world: appState.world }) as Promise<RouterStatusRow[]>,
        call("curriculum.plan", { world: appState.world }) as Promise<{ threshold: number; actions: CurriculumPlanAction[] }>,
      ]);
      routerRows = rows;
      planActions = plan.actions;
    } catch (e) {
      // Decorative only, same as loadStaged: the Sankey still renders with
      // whatever it has, every pattern just reads as "Below threshold".
      toast(`could not load proposal outcomes: ${(e as Error).message}`);
      routerRows = [];
      planActions = [];
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
    void loadOutcomes();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  });
</script>

<div class="panel reflections-sankey-panel">
  <div class="panel__body">
    {#if loading}
      <Skeleton height={`${SANKEY_HEIGHT}px`} />
    {:else}
      <Sankey {flows} selectedPattern={patternFilter} selectedOutcome={outcomeFilter} height={SANKEY_HEIGHT} onSelectPattern={selectSankeyPattern} onSelectOutcome={selectSankeyOutcome} />
    {/if}
  </div>
</div>

<div class="toolbar">
  <input type="search" placeholder="Search pattern or lesson" aria-label="Search reflections" bind:value={searchQuery} class="reflections-search" />
  <select aria-label="Filter by pattern" class="reflections-pattern-select" value={patternFilter ?? ""} onchange={(e) => selectPatternOption((e.target as HTMLSelectElement).value)}>
    <option value="">All patterns ({allItems.length})</option>
    {#each patternOptions as c (c.pattern)}
      <option value={c.pattern}>{c.pattern} ({c.count})</option>
    {/each}
  </select>
  <button onclick={load}>Refresh</button>
</div>

{#if activeFilterLabel}
  <div class="chips reflections-chips">
    <span class="chip accent">{activeFilterLabel}</span>
    <button type="button" class="chip" onclick={clearFilter}>Clear filter</button>
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
          Clear the search or the pattern filter to see all reflections.
        </div>
      {:else}
        <div class="scroll-list">
          {#each groups as group (group.day)}
            <h4 class="day-heading">{group.label} <span class="muted">({plural(group.items.length, "reflection")})</span></h4>
            <ul class="list">
              {#each group.items as r (r.id)}
                <li>
                  <button class="row reflections-row" class:selected={r.id === selectedId} onclick={() => open(r.id)}>
                    <div class="row__title">
                      <span class="grow">{r.pattern}</span>
                      <span class="reflections-row__date muted">{formatTime(r.created)}</span>
                    </div>
                    {#if firstLine(r.lesson)}
                      <p class="reflections-lesson">{firstLine(r.lesson)}</p>
                    {/if}
                    {#if countBadges(r).length > 0}
                      <div class="meta">
                        {#each countBadges(r) as b}<span class="chip {b.cls}">{b.label}</span>{/each}
                      </div>
                    {/if}
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
        {#if sections.length > 0}
          <div class="reflection-sections">
            {#each sections as section (section.heading)}
              <section
                class="reflection-section"
                class:reflection-section--lesson={section.heading === "Reusable lesson"}
                class:reflection-section--unverified={section.heading === "Not verified"}
              >
                <h4 class="reflection-section__heading">{section.heading}</h4>
                {#if section.heading === "Not verified"}
                  {#if checklistItems(section.text).length === 0}
                    <p class="muted">Nothing flagged as unverified.</p>
                  {:else}
                    <ul class="reflection-checklist">
                      {#each checklistItems(section.text) as item}<li>{item}</li>{/each}
                    </ul>
                  {/if}
                {:else if section.text}
                  <MarkdownBody text={section.text} />
                {:else}
                  <p class="muted">Empty.</p>
                {/if}
              </section>
            {/each}
          </div>
        {:else}
          <MarkdownBody text={selected.body} />
        {/if}
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
  .reflections-sankey-panel .panel__body {
    padding: 1rem 1rem 0.5rem;
  }

  .reflections-search {
    min-width: 14rem;
  }

  .reflections-pattern-select {
    min-width: 12rem;
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

  .reflections-row {
    padding-top: 0.4rem;
    padding-bottom: 0.4rem;
  }

  .reflections-row__date {
    flex: none;
    font-size: var(--fs-xs);
    font-weight: 400;
  }

  .reflections-lesson {
    margin: 0.15rem 0 0;
    color: var(--muted);
    font-size: var(--fs-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .reflection-sections {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .reflection-section {
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--panel);
  }

  .reflection-section__heading {
    margin: 0 0 0.35rem;
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--fg-soft);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .reflection-section :global(.body-doc) {
    font-size: var(--fs-sm);
  }

  .reflection-section--lesson {
    background: var(--accent-soft);
    border-color: transparent;
    border-left: 3px solid var(--accent);
  }

  .reflection-section--lesson .reflection-section__heading {
    color: var(--accent);
  }

  .reflection-section--unverified {
    background: transparent;
    border-style: dashed;
  }

  .reflection-checklist {
    margin: 0;
    padding-left: 1.1rem;
    color: var(--muted);
    font-size: var(--fs-sm);
  }

  .reflection-checklist li {
    margin: 0.15rem 0;
  }

  @media (max-width: 45rem) {
    .reflections-split {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
