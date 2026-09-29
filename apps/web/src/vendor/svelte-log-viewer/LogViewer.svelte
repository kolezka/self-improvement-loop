<!-- Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first. -->
<!--
  Virtualised log viewer.

  Only the visible rows plus an overscan are in the DOM, so a 50k line buffer
  scrolls as fast as a 50 line one. Unwrapped rows are a fixed 20px; wrapping
  splits a line into fixed width chunks itself instead of letting the browser
  decide, which keeps the scroller's height maths exact.
-->
<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import Icon from "./Icon.svelte";
  import type { LogLine } from "./types.ts";
  import EmptyState from "./internal/ui/EmptyState.svelte";
  import IconButton from "./internal/ui/IconButton.svelte";
  import Kbd from "./internal/ui/Kbd.svelte";
  import ProgressBar from "./internal/ui/ProgressBar.svelte";
  import Select from "./internal/ui/Select.svelte";
  import Switch from "./internal/ui/Switch.svelte";
  import TextField from "./internal/ui/TextField.svelte";
  import { formatNumber } from "./internal/format.ts";
  import {
    filterLines,
    formatClock,
    longestLine,
    shortSourceId,
    toPlainText,
    toneOf,
    wrapText,
    type StreamFilter,
  } from "./lines.ts";
  import {
    buildOffsets,
    computeVariableWindow,
    computeWindow,
    DEFAULT_OVERSCAN,
    ROW_HEIGHT,
  } from "./virtual.ts";
  import { DEFAULT_LABELS, type LogViewerLabels } from "./labels.ts";

  interface Props {
    /** Oldest first. The component never mutates it. */
    lines: LogLine[];
    /** The source is still producing lines, so follow mode is meaningful. */
    live: boolean;
    /** Auto scroll to the newest line. Turns itself off when the user scrolls up. */
    follow?: boolean;
    /** Prefix each row with its source label, for a view mixing several sources. */
    showSource?: boolean;
    /** Label for the source column. Only read when `showSource` is on. */
    labelOf?: (source: string) => string;
    /** Full log download, offered in the toolbar. */
    downloadUrl?: string;
    /** Freeze what is on screen. The caller keeps collecting into `lines`. */
    paused?: boolean;
    /** Height of the scroll area. */
    height?: string;
    /** Always take the full height. Off means short logs shrink to fit. */
    fill?: boolean;
    /** History is still paging in. */
    loading?: boolean;
    /** The in memory buffer dropped older lines. */
    capped?: boolean;
    emptyTitle?: string;
    emptyDescription?: string;
    /** Overrides for the toolbar, footer and notice strings. Merged over the defaults. */
    labels?: Partial<LogViewerLabels>;
    /** Source side filters, drawn in the toolbar before the line filter. */
    filters?: Snippet;
    /** Extra controls, drawn at the right of the toolbar. */
    actions?: Snippet;
  }

  let {
    lines,
    live,
    follow = $bindable(true),
    showSource = false,
    labelOf,
    downloadUrl,
    paused = false,
    height = "min(64vh, 720px)",
    fill = false,
    loading = false,
    capped = false,
    emptyTitle = "No output yet",
    emptyDescription = "Lines appear here as soon as the source writes them.",
    labels,
    filters,
    actions,
  }: Props = $props();

  const L = $derived({ ...DEFAULT_LABELS, ...labels });

  const STREAM_OPTIONS = $derived([
    { value: "all", label: L.allStreams },
    { value: "stdout", label: "stdout" },
    { value: "stderr", label: "stderr" },
    { value: "system", label: "system" },
  ]);

  /** A scroll that ends this close to the bottom counts as "at the bottom". */
  const BOTTOM_EPSILON = 4;
  /** Never wrap narrower than this, however small the pane gets. */
  const MIN_COLUMNS = 20;

  const filterId = $props.id();

  let container = $state<HTMLDivElement | null>(null);
  let ruler = $state<HTMLSpanElement | null>(null);

  let streamValue = $state("all");
  let query = $state("");
  let wrap = $state(false);
  let timestamps = $state(true);
  let lineNumbers = $state(true);
  let copied = $state(false);

  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  let viewportWidth = $state(0);
  /** Width of one monospace character, measured once against the real font. */
  let charWidth = $state(7.2);
  /** Snapshot taken when the view is frozen, so new lines do not move it. */
  let frozen = $state<LogLine[] | null>(null);

  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  const streamFilter = $derived(streamValue as StreamFilter);
  const source = $derived(paused && frozen !== null ? frozen : lines);
  const rows = $derived(filterLines(source, streamFilter, query));
  const filtering = $derived(streamFilter !== "all" || query.trim().length > 0);

  const seqDigits = $derived(Math.max(3, String(rows.length > 0 ? rows[rows.length - 1].seq : 0).length));
  const seqWidth = $derived(lineNumbers ? Math.ceil(seqDigits * charWidth) + 14 : 0);
  const timeWidth = $derived(timestamps ? Math.ceil(12 * charWidth) + 12 : 0);
  const sourceWidth = $derived(showSource ? Math.ceil(18 * charWidth) + 12 : 0);
  /** Pixels left for the text after the gutters and the row padding. */
  const textWidth = $derived(Math.max(0, viewportWidth - seqWidth - timeWidth - sourceWidth - 28));
  // One column of slack: the gutter widths are estimates, and an over estimate
  // here would push a wrapped chunk past the right edge.
  const columns = $derived(Math.max(MIN_COLUMNS, Math.floor(textWidth / charWidth) - 1));

  const offsets = $derived.by(() => {
    if (!wrap || rows.length === 0) return null;
    const lengths = new Int32Array(rows.length);
    for (let index = 0; index < rows.length; index += 1) lengths[index] = rows[index].text.length;
    return buildOffsets(lengths, columns, ROW_HEIGHT);
  });

  // A number, not an object: the follow effect reads it and must not re-run on
  // every scroll, or it would fight the user for the scroll position.
  const totalHeight = $derived(
    offsets === null ? rows.length * ROW_HEIGHT : offsets[offsets.length - 1],
  );

  const view = $derived(
    offsets === null
      ? computeWindow({
          scrollTop,
          viewportHeight,
          rowHeight: ROW_HEIGHT,
          count: rows.length,
          overscan: DEFAULT_OVERSCAN,
        })
      : computeVariableWindow({ scrollTop, viewportHeight, offsets, overscan: DEFAULT_OVERSCAN }),
  );

  const slice = $derived(rows.slice(view.start, view.end));
  /** Widest line, so the horizontal scrollbar does not jump as rows recycle. */
  const contentWidth = $derived(
    wrap ? 0 : seqWidth + timeWidth + sourceWidth + 28 + Math.ceil((longestLine(rows) + 2) * charWidth),
  );

  $effect(() => {
    frozen = paused ? untrack(() => lines) : null;
  });

  $effect(() => {
    if (ruler === null) return;
    const measured = ruler.getBoundingClientRect().width / 100;
    if (measured > 0) charWidth = measured;
  });

  $effect(() => {
    const element = container;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      viewportHeight = element.clientHeight;
      viewportWidth = element.clientWidth;
    });
    observer.observe(element);
    viewportHeight = element.clientHeight;
    viewportWidth = element.clientWidth;
    return () => observer.disconnect();
  });

  // Keeps the tail pinned. Depends on plain numbers only, so it runs when rows
  // arrive or the layout changes and not when the user scrolls.
  $effect(() => {
    const count = rows.length;
    const total = totalHeight;
    if (paused || !follow || container === null) return;
    void count;
    void total;
    container.scrollTop = container.scrollHeight;
    scrollTop = container.scrollTop;
  });

  function handleScroll(): void {
    if (container === null) return;
    scrollTop = container.scrollTop;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distance <= BOTTOM_EPSILON;
    // Scrolling up leaves the tail; scrolling back to the bottom rejoins it.
    if (follow !== atBottom) follow = atBottom;
  }

  function jumpToLatest(): void {
    follow = true;
    if (container === null) return;
    container.scrollTop = container.scrollHeight;
    scrollTop = container.scrollTop;
  }

  function jumpToTop(): void {
    follow = false;
    if (container === null) return;
    container.scrollTop = 0;
    scrollTop = 0;
  }

  function clearFilter(): void {
    streamValue = "all";
    query = "";
  }

  async function copyVisible(): Promise<void> {
    try {
      await navigator.clipboard.writeText(toPlainText(rows, { timestamps, seq: lineNumbers }));
      copied = true;
      if (copyTimer !== null) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }

  function isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const typing = isTyping(event.target);
    if (event.key === "/" && !typing) {
      event.preventDefault();
      const input = document.getElementById(filterId);
      if (input instanceof HTMLInputElement) {
        input.focus();
        input.select();
      }
      return;
    }
    if (event.key === "Escape" && typing && filtering) {
      clearFilter();
      return;
    }
    if (typing) return;
    if (event.key === "End") {
      event.preventDefault();
      jumpToLatest();
    } else if (event.key === "Home") {
      event.preventDefault();
      jumpToTop();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="log-viewer">
  <div class="toolbar">
    <Switch bind:checked={follow} label={L.follow} ariaLabel={L.followAria} />

    <div class="stream">
      <Select options={STREAM_OPTIONS} bind:value={streamValue} ariaLabel={L.streamAria} />
    </div>

    {#if filters}<div class="filters">{@render filters()}</div>{/if}

    <div class="filter">
      <TextField
        id={filterId}
        type="search"
        bind:value={query}
        placeholder={L.filterPlaceholder}
        ariaLabel={L.filterPlaceholder}
        mono
      />
    </div>

    {#if filtering}
      <span class="matched">{formatNumber(rows.length)} of {formatNumber(source.length)}</span>
      <IconButton size="sm" label={L.clearFilter} onclick={clearFilter}>
        <Icon name="FilterX" size={13} />
      </IconButton>
    {:else}
      <span class="matched">{formatNumber(rows.length)} {L.lines}</span>
    {/if}

    <div class="spacer"></div>

    <div class="toggles">
      <IconButton
        size="sm"
        label={wrap ? L.wrapOff : L.wrapOn}
        active={wrap}
        onclick={() => (wrap = !wrap)}
      >
        <Icon name="WrapText" size={13} />
      </IconButton>
      <IconButton
        size="sm"
        label={timestamps ? L.timestampsOff : L.timestampsOn}
        active={timestamps}
        onclick={() => (timestamps = !timestamps)}
      >
        <Icon name="Timer" size={13} />
      </IconButton>
      <IconButton
        size="sm"
        label={lineNumbers ? L.lineNumbersOff : L.lineNumbersOn}
        active={lineNumbers}
        onclick={() => (lineNumbers = !lineNumbers)}
      >
        <Icon name="Hash" size={13} />
      </IconButton>
      <IconButton size="sm" label={copied ? L.copied : L.copy} onclick={copyVisible}>
        {#if copied}<Icon name="Check" size={13} />{:else}<Icon name="Copy" size={13} />{/if}
      </IconButton>
      {#if downloadUrl}
        <IconButton size="sm" label={L.download} href={downloadUrl} download>
          <Icon name="Download" size={13} />
        </IconButton>
      {/if}
    </div>

    {#if actions}<div class="extra">{@render actions()}</div>{/if}
  </div>

  {#if loading}
    <div class="notice">
      <ProgressBar indeterminate label={L.loadingHistory} height={2} />
      <span>{L.loadingHistory}</span>
    </div>
  {:else if capped}
    <div class="notice static">
      <span>{L.cappedNotice}</span>
    </div>
  {/if}

  <div
    class="viewport"
    bind:this={container}
    onscroll={handleScroll}
    style={fill ? `height: ${height}` : `max-height: ${height}`}
  >
    {#if rows.length === 0}
      <div class="blank">
        {#if source.length === 0}
          <EmptyState title={emptyTitle} description={emptyDescription} compact>
            {#snippet icon()}
              <Icon name="ScrollText" size={24} />
            {/snippet}
          </EmptyState>
        {:else}
          <EmptyState
            title={L.noMatchTitle}
            description={L.noMatchDescription(source.length)}
            compact
          />
        {/if}
      </div>
    {:else}
      <div
        class="canvas"
        style="height: {totalHeight}px"
        style:min-width={contentWidth > 0 ? `${contentWidth}px` : undefined}
      >
        <div class="slice" style="transform: translateY({view.offsetTop}px)">
          {#each slice as line (`${line.source ?? ""}:${line.seq}`)}
            <div class="row {toneOf(line)}" class:wrapped={wrap}>
              {#if lineNumbers}
                <span class="seq" style="width: {seqWidth}px">{line.seq}</span>
              {/if}
              {#if timestamps}
                <span class="time" style="width: {timeWidth}px">{formatClock(line.ts)}</span>
              {/if}
              {#if showSource}
                <span class="source" style="width: {sourceWidth}px" title={line.source}>
                  {labelOf ? labelOf(line.source ?? "") : shortSourceId(line.source ?? "")}
                </span>
              {/if}
              <span class="text">
                {#if wrap}
                  {#each wrapText(line.text, columns) as chunk, index (index)}
                    <span class="chunk">{chunk}</span>
                  {/each}
                {:else}
                  {line.text}
                {/if}
              </span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <span class="ruler" bind:this={ruler} aria-hidden="true"
      >0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000</span
    >
  </div>

  <div class="footer">
    <span class="hint">
      <Kbd>End</Kbd> latest <Kbd>Home</Kbd> top <Kbd>/</Kbd> filter
    </span>
    {#if !follow}
      <button class="jump" type="button" onclick={jumpToLatest}>
        <Icon name="ArrowDownToLine" size={13} />
        {L.jumpToLatest}{live ? "" : " line"}
      </button>
    {:else if live}
      <span class="tailing">{L.following}</span>
    {/if}
  </div>
</div>

<style>
  /*
    No overflow clipping here: the toolbar tooltips open above the box and a
    clip would cut them off. The toolbar and footer round their own corners.
  */
  .log-viewer {
    /*
      Design tokens. Each falls back to the host's own token (--border etc.),
      then to the dark theme default, so the component renders with no host
      CSS at all. Every rule below reads --lv-*; override either level.
    */
    --lv-surface-page: var(--surface-page, #0d0f13);
    --lv-surface-panel: var(--surface-panel, #14171d);
    --lv-surface-raised: var(--surface-raised, #1b1f27);
    --lv-surface-hover: var(--surface-hover, #212632);
    --lv-border: var(--border, #262b35);
    --lv-border-strong: var(--border-strong, #363d4a);
    --lv-text-primary: var(--text-primary, #e6e9ef);
    --lv-text-secondary: var(--text-secondary, #a3acbd);
    --lv-text-muted: var(--text-muted, #6f7889);
    --lv-accent: var(--accent, #4c8dff);
    --lv-accent-subtle: var(--accent-subtle, #17243d);
    --lv-accent-text: var(--accent-text, #8fb8ff);
    --lv-on-accent: var(--on-accent, #0b1220);
    --lv-success: var(--success, #3fb950);
    --lv-warning: var(--warning, #d29922);
    --lv-danger: var(--danger, #f4574c);
    --lv-danger-subtle: var(--danger-subtle, #2d1516);
    --lv-info: var(--info, #58a6ff);
    --lv-radius-sm: var(--radius-sm, 4px);
    --lv-radius-md: var(--radius-md, 6px);
    --lv-radius-lg: var(--radius-lg, 8px);
    --lv-space-1: var(--space-1, 4px);
    --lv-space-2: var(--space-2, 8px);
    --lv-space-3: var(--space-3, 12px);
    --lv-space-6: var(--space-6, 24px);
    --lv-space-12: var(--space-12, 48px);
    --lv-font-sans: var(--font-sans, Inter, system-ui, -apple-system, "Segoe UI", sans-serif);
    --lv-font-mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
    --lv-text-12: var(--text-12, 12px);
    --lv-text-13: var(--text-13, 13px);
    --lv-text-14: var(--text-14, 14px);
    --lv-shadow-sm: var(--shadow-sm, 0 1px 2px rgb(0 0 0 / 0.3));

    display: flex;
    flex-direction: column;
    border: 1px solid var(--lv-border);
    border-radius: var(--lv-radius-lg);
    background: var(--lv-surface-page);
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--lv-space-2);
    padding: var(--lv-space-2) var(--lv-space-3);
    border-bottom: 1px solid var(--lv-border);
    border-radius: calc(var(--lv-radius-lg) - 1px) calc(var(--lv-radius-lg) - 1px) 0 0;
    background: var(--lv-surface-panel);
    flex-wrap: wrap;
  }

  .stream {
    width: 132px;
    flex: none;
  }

  .filters {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--lv-space-2);
    flex: none;
  }

  .filter {
    width: 220px;
    flex: none;
  }

  .matched {
    color: var(--lv-text-secondary);
    font-size: var(--lv-text-12);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
    min-width: var(--lv-space-2);
  }

  .toggles,
  .extra {
    display: flex;
    align-items: center;
    gap: var(--lv-space-1);
    flex: none;
  }

  .extra {
    gap: var(--lv-space-2);
    padding-left: var(--lv-space-2);
    border-left: 1px solid var(--lv-border);
  }

  .notice {
    display: flex;
    flex-direction: column;
    gap: var(--lv-space-1);
    padding: var(--lv-space-2) var(--lv-space-3);
    border-bottom: 1px solid var(--lv-border);
    background: var(--lv-surface-panel);
    color: var(--lv-text-secondary);
    font-size: var(--lv-text-12);
  }

  .notice.static {
    color: var(--lv-warning);
  }

  .viewport {
    position: relative;
    overflow: auto;
    overflow-anchor: none;
    contain: layout paint;
    font-family: var(--lv-font-mono);
    font-size: var(--lv-text-12);
    line-height: 20px;
  }

  .canvas {
    position: relative;
    width: 100%;
  }

  .slice {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    will-change: transform;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: var(--lv-space-2);
    height: 20px;
    padding: 0 var(--lv-space-3) 0 var(--lv-space-2);
    border-left: 2px solid transparent;
    white-space: pre;
  }

  .row.wrapped {
    height: auto;
  }

  .row:hover {
    background: var(--lv-surface-hover);
  }

  .seq,
  .time,
  .source {
    flex: none;
    color: var(--lv-text-muted);
    text-align: right;
    user-select: none;
    font-variant-numeric: tabular-nums;
    overflow: hidden;
  }

  .time,
  .source {
    text-align: left;
  }

  .source {
    display: flex;
    gap: var(--lv-space-1);
    white-space: nowrap;
  }

  .text {
    flex: 1;
    min-width: 0;
    color: var(--lv-text-primary);
  }

  .chunk {
    display: block;
    height: 20px;
  }

  /* Stream and verdict tints. The left bar is the stream marker. */
  .row.stderr {
    border-left-color: var(--lv-warning);
  }

  .row.stderr .text {
    color: var(--lv-warning);
  }

  .row.system .text {
    color: var(--lv-text-muted);
    font-style: italic;
  }

  .row.command {
    border-left-color: var(--lv-accent);
    background: var(--lv-accent-subtle);
  }

  .row.command .text {
    color: var(--lv-accent-text);
  }

  .row.pass {
    border-left-color: var(--lv-success);
  }

  .row.pass .text {
    color: var(--lv-success);
  }

  .row.fail {
    border-left-color: var(--lv-danger);
  }

  .row.fail .text {
    color: var(--lv-danger);
  }

  .blank {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 160px;
    /* The viewport is monospace for the rows; the empty state is prose. */
    font-family: var(--lv-font-sans);
    font-size: var(--lv-text-14);
    line-height: 1.5;
  }

  /* Off screen 100 character strip, measured to get the real character width. */
  .ruler {
    position: absolute;
    top: 0;
    left: 0;
    visibility: hidden;
    pointer-events: none;
    white-space: pre;
  }

  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--lv-space-3);
    padding: var(--lv-space-1) var(--lv-space-3);
    border-top: 1px solid var(--lv-border);
    border-radius: 0 0 calc(var(--lv-radius-lg) - 1px) calc(var(--lv-radius-lg) - 1px);
    background: var(--lv-surface-panel);
    min-height: 28px;
  }

  .hint {
    display: flex;
    align-items: center;
    gap: var(--lv-space-1);
    color: var(--lv-text-muted);
    font-size: var(--lv-text-12);
  }

  .tailing {
    color: var(--lv-accent-text);
    font-size: var(--lv-text-12);
  }

  .jump {
    display: inline-flex;
    align-items: center;
    gap: var(--lv-space-1);
    height: 22px;
    padding: 0 var(--lv-space-2);
    border: 1px solid var(--lv-accent);
    border-radius: 999px;
    background: var(--lv-accent-subtle);
    color: var(--lv-accent-text);
    font-size: var(--lv-text-12);
    cursor: pointer;
  }

  .jump:hover {
    background: var(--lv-accent);
    color: var(--lv-on-accent);
  }

  @media (max-width: 899px) {
    .filter {
      width: 160px;
    }

    .hint {
      display: none;
    }
  }
</style>
