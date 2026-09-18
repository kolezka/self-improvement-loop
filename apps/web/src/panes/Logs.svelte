<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { toast } from "../lib/state.svelte.ts";
  import { formatTime } from "../lib/format.ts";
  import { highlight, matchesFilter, parseLogLines, sizeText, type LogLine } from "../lib/logs.ts";

  const LOG_NAMES = ["hook", "worker", "web", "curriculum"] as const;
  const LINE_CHOICES = [100, 200, 500, 1000, 2000] as const;
  const FOLLOW_INTERVAL_MS = 3000;
  // Re-rendering 2000 rows on every keystroke is visible; one short pause is not.
  const FILTER_DEBOUNCE_MS = 120;
  // Treat anything within this many pixels of the end as "at the bottom", so a
  // sub-pixel scroll height does not unpin the view.
  const BOTTOM_SLACK_PX = 24;

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
  // Raw state: the array is always replaced whole, never mutated, so the deep
  // proxy would build thousands of sources per poll for nothing.
  let rows = $state.raw<LogLine[]>([]);
  let typedFilter = $state("");
  let filter = $state("");
  let follow = $state(false);
  let wrap = $state(true);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let lastLoad = $state<string | null>(null);
  let pinned = $state(true);
  let consoleEl = $state<HTMLDivElement | null>(null);
  let loading = false;

  const visible = $derived(rows.filter((row) => matchesFilter(row, filter)));

  async function load() {
    // A tail slower than the follow interval would otherwise stack requests
    // that can resolve out of order and paint an older tail.
    if (loading) return;
    loading = true;
    const wanted = name;
    try {
      const result = (await call("logs.tail", { name: wanted, lines })) as TailResult;
      // The user may have switched logs while this was in flight.
      if (result.name !== name) return;
      path = result.path;
      exists = result.exists;
      size = result.size;
      rows = parseLogLines(result.lines);
      lastLoad = new Date().toISOString();
      loadError = null;
      loaded = true;
    } catch (e) {
      const message = (e as Error).message;
      loadError = message;
      loaded = true;
      if (follow) {
        // A failing poll every 3s would otherwise toast forever; show it once
        // and stop following instead.
        follow = false;
        toast(`log polling failed, follow turned off: ${message}`);
      } else {
        toast(`could not load log: ${message}`);
      }
    } finally {
      loading = false;
    }
  }

  /** A different log or tail size is a fresh read; start at the newest line. */
  function reload() {
    pinned = true;
    load();
  }

  function onScroll() {
    if (!consoleEl) return;
    pinned = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < BOTTOM_SLACK_PX;
  }

  function scrollToLatest() {
    if (!consoleEl) return;
    consoleEl.scrollTop = consoleEl.scrollHeight;
    pinned = true;
  }

  function visibleText(): string {
    return visible.map((row) => row.raw).join("\n");
  }

  async function copyVisible() {
    try {
      await navigator.clipboard.writeText(visibleText());
      toast(`copied ${visible.length} lines`, "ok");
    } catch {
      // http on a LAN address is not a secure context, so there is no
      // clipboard API there; the download button still works.
      toast("clipboard is not available here, use Download");
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([visibleText()], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.log`;
    document.body.append(link);
    link.click();
    link.remove();
    // Revoking in the same task can cancel the download outside Chrome.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  $effect(() => {
    const next = typedFilter;
    const timer = setTimeout(() => {
      filter = next;
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!follow) return;
    const timer = setInterval(load, FOLLOW_INTERVAL_MS);
    return () => clearInterval(timer);
  });

  // Runs after the console has re-rendered with the new lines, so scrollHeight
  // already reflects them. Only follows the tail while the view is pinned to
  // the bottom, so reading older lines is not interrupted by a poll. Wrap is a
  // dependency because turning it on makes the content taller without firing a
  // scroll event, which would strand a pinned view above the tail.
  $effect(() => {
    void visible;
    void wrap;
    if (consoleEl && pinned) consoleEl.scrollTop = consoleEl.scrollHeight;
  });

  onMount(load);
</script>

<h2>Logs</h2>

<div class="actions">
  <label class="control">
    <span>log</span>
    <select bind:value={name} onchange={reload}>
      {#each LOG_NAMES as n}
        <option value={n}>{n}</option>
      {/each}
    </select>
  </label>
  <label class="control">
    <span>lines</span>
    <select bind:value={lines} onchange={reload}>
      {#each LINE_CHOICES as n}
        <option value={n}>{n}</option>
      {/each}
    </select>
  </label>
  <input class="filter" type="search" placeholder="filter lines" bind:value={typedFilter} aria-label="filter lines" />
  <button onclick={load}>Refresh</button>
  <label class="control toggle">
    <input type="checkbox" bind:checked={follow} />
    <span>Follow</span>
  </label>
  <label class="control toggle">
    <input type="checkbox" bind:checked={wrap} />
    <span>Wrap</span>
  </label>
  <button onclick={copyVisible} disabled={visible.length === 0}>Copy</button>
  <button onclick={download} disabled={visible.length === 0}>Download</button>
</div>

<p class="meta muted">
  <code>{path}</code>
  {#if loaded && exists && !loadError}
    <span>{sizeText(size)}</span>
    <span>{filter.trim() ? `${visible.length} of ${rows.length} lines` : `${rows.length} lines`}</span>
    <span>read {formatTime(lastLoad)}</span>
    {#if follow}<span class="live">live</span>{/if}
  {/if}
</p>

{#if loadError}
  <p class="error-text">could not load this log: {loadError}</p>
{:else if !loaded}
  <p class="muted">loading&hellip;</p>
{:else if !exists}
  <p class="muted">
    This log has not been written yet.
    {#if name === "hook"}The hook writes it on the first session event.{/if}
  </p>
{:else if rows.length === 0}
  <p class="muted">log is empty</p>
{:else}
  <div class="console-wrap">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- tabindex keeps the log scrollable from the keyboard: Firefox and
         Safari do not focus a scroll container on their own. -->
    <div
      class="console"
      class:nowrap={!wrap}
      bind:this={consoleEl}
      onscroll={onScroll}
      role="log"
      aria-live="off"
      aria-label={`${name} log`}
      tabindex="0"
    >
      {#if visible.length === 0}
        <p class="empty muted">no line matches "{filter.trim()}"</p>
      {:else}
        {#each visible as row}
          <div class={`line ${row.level}`}>
            <span class="gutter">{row.index}</span>
            <span class="time" title={row.iso}>{row.time}</span>
            <span class="msg"
              >{#each highlight(row.text, filter) as seg}{#if seg.hit}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}</span
            >
          </div>
        {/each}
      {/if}
    </div>
    {#if !pinned}
      <button class="jump" onclick={scrollToLatest}>Jump to latest</button>
    {/if}
  </div>
{/if}

<style>
  .control {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--muted);
    font-size: 0.85rem;
  }

  .filter {
    min-width: 14rem;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    font-size: 0.8rem;
    margin: 0 0 0.5rem;
  }

  .meta code {
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }

  .live {
    color: var(--ok);
  }

  .live::before {
    content: "";
    display: inline-block;
    width: 0.45rem;
    height: 0.45rem;
    margin-right: 0.3rem;
    border-radius: 999px;
    background: var(--ok);
  }

  .console-wrap {
    position: relative;
  }

  .console {
    /* Fills what the header, toolbar and status line leave, so the console
       scrolls instead of pushing the page into a second scrollbar. */
    height: clamp(16rem, calc(100vh - 17rem), 60rem);
    resize: vertical;
    overflow: auto;
    padding: 0.4rem 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    font: 12px/1.6 ui-monospace, monospace;
  }

  .line {
    display: grid;
    grid-template-columns: 3.5rem 5.5rem minmax(0, 1fr);
    gap: 0.6rem;
    padding: 0 0.7rem;
    border-left: 2px solid transparent;
  }

  .line:hover {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }

  .console.nowrap .line {
    width: max-content;
    min-width: 100%;
  }

  .console.nowrap .msg {
    white-space: pre;
    overflow-wrap: normal;
  }

  .gutter {
    text-align: right;
    color: var(--muted);
    opacity: 0.6;
    user-select: none;
  }

  .time {
    color: var(--muted);
    white-space: nowrap;
  }

  .msg {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .line.error {
    border-left-color: var(--err);
  }

  .line.error .msg {
    color: var(--err);
  }

  .line.warn {
    border-left-color: var(--warn);
  }

  .line.warn .msg {
    color: var(--warn);
  }

  mark {
    background: var(--accent);
    color: var(--bg);
    border-radius: 3px;
  }

  .empty {
    padding: 0.6rem 0.7rem;
  }

  .jump {
    position: absolute;
    right: 1rem;
    bottom: 1rem;
    font-size: 0.8rem;
    box-shadow: 0 1px 6px rgb(0 0 0 / 0.25);
  }
</style>
