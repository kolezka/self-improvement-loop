<script lang="ts">
  import { buildSankey, spreadLabels, type SankeyFlow, type SankeyLink, type SankeyNode } from "../../lib/sankey.ts";
  import { OTHER_PATTERNS } from "../../lib/reflections.ts";

  interface Props {
    flows: SankeyFlow[];
    selectedPattern?: string | null;
    selectedOutcome?: string | null;
    height?: number;
    onSelectPattern?: (pattern: string) => void;
    onSelectOutcome?: (outcome: string) => void;
  }

  let { flows, selectedPattern = null, selectedOutcome = null, height = 280, onSelectPattern, onSelectOutcome }: Props = $props();

  // The viewBox tracks the measured width so one SVG unit is one CSS pixel.
  // A fixed viewBox stretched to a wide pane scaled the labels up to twice
  // their size.
  const FALLBACK_WIDTH = 900;
  const NODE_WIDTH = 10;
  const LEFT_GUTTER = 240;
  const RIGHT_GUTTER = 170;
  // Room above and below the nodes so the first and last label never clip.
  const PAD_Y = 10;
  // Minimum distance between two label centers in one column.
  const LABEL_SPACING = 17;
  const TOOLTIP_WIDTH = 260;
  const TOOLTIP_ROWS = 5;

  let measuredWidth = $state(0);
  const width = $derived(measuredWidth > 0 ? measuredWidth : FALLBACK_WIDTH);
  const innerWidth = $derived(Math.max(width - LEFT_GUTTER - RIGHT_GUTTER, 120));

  // Roughly 7px per character at the 12px label size, minus room for the count.
  const MAX_LABEL = Math.floor((LEFT_GUTTER - 50) / 7);

  function shortLabel(id: string): string {
    return id.length > MAX_LABEL ? `${id.slice(0, MAX_LABEL - 1)}…` : id;
  }

  const sourceCount = $derived(new Set(flows.map((f) => f.source)).size);
  const targetCount = $derived(new Set(flows.map((f) => f.target)).size);
  // Grow past the requested height when a long tail needs more label room.
  const svgHeight = $derived(Math.max(height, Math.max(sourceCount, targetCount) * LABEL_SPACING + 2 * PAD_Y));
  const plotHeight = $derived(svgHeight - 2 * PAD_Y);

  const gap = $derived.by(() => {
    const columnCount = Math.max(sourceCount, targetCount, 1);
    return Math.max(Math.min(14, (plotHeight - columnCount) / columnCount), 2);
  });

  const layout = $derived(buildSankey(flows, { width: innerWidth, height: plotHeight, nodeWidth: NODE_WIDTH, gap }));
  const totalReflections = $derived(flows.reduce((sum, f) => sum + f.value, 0));

  function nodeKey(node: { column: 0 | 1; id: string }): string {
    return `${node.column}:${node.id}`;
  }

  function linkKey(link: { source: string; target: string }): string {
    return `${link.source}\u0000${link.target}`;
  }

  // Label centers, pushed apart where a tail of small nodes would overlap.
  const labelY = $derived.by(() => {
    const ys = new Map<string, number>();
    for (const column of [0, 1] as const) {
      const nodes = layout.nodes.filter((n) => n.column === column);
      const spread = spreadLabels(
        nodes.map((n) => n.y + n.height / 2),
        LABEL_SPACING,
        LABEL_SPACING / 2 - PAD_Y,
        plotHeight + PAD_Y - LABEL_SPACING / 2,
      );
      nodes.forEach((n, i) => ys.set(nodeKey(n), spread[i]!));
    }
    return ys;
  });

  type Hover = { kind: "node"; node: SankeyNode; x: number; y: number } | { kind: "link"; link: SankeyLink; x: number; y: number };
  let hover = $state<Hover | null>(null);
  let plotEl = $state<HTMLDivElement | null>(null);

  function pointerPosition(e: PointerEvent): { x: number; y: number } {
    const rect = plotEl?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 };
  }

  function hoverNode(node: SankeyNode, e: PointerEvent) {
    hover = { kind: "node", node, ...pointerPosition(e) };
  }

  function hoverLink(link: SankeyLink, e: PointerEvent) {
    hover = { kind: "link", link, ...pointerPosition(e) };
  }

  // Keyboard focus shows the same card, anchored beside the node.
  function focusNode(node: SankeyNode) {
    const x = LEFT_GUTTER + node.x + (node.column === 0 ? node.width + 8 : -8);
    hover = { kind: "node", node, x, y: PAD_Y + node.y + node.height / 2 };
  }

  function clearHover() {
    hover = null;
  }

  const tooltipStyle = $derived.by(() => {
    if (!hover) return "";
    const flip = hover.x + 16 + TOOLTIP_WIDTH > width;
    const left = flip ? Math.max(hover.x - 16 - TOOLTIP_WIDTH, 0) : hover.x + 16;
    const top = Math.min(Math.max(hover.y - 20, 0), Math.max(svgHeight - 140, 0));
    return `left:${left}px;top:${top}px;width:${TOOLTIP_WIDTH}px`;
  });

  function isLinkActive(link: SankeyLink): boolean {
    if (!hover) return false;
    if (hover.kind === "link") return linkKey(hover.link) === linkKey(link);
    return hover.node.column === 0 ? link.source === hover.node.id : link.target === hover.node.id;
  }

  function isDimmed(nodeId: string, column: 0 | 1): boolean {
    if (selectedPattern) return column === 0 ? nodeId !== selectedPattern : false;
    if (selectedOutcome) return column === 1 ? nodeId !== selectedOutcome : false;
    return false;
  }

  function linkDimmed(source: string, target: string): boolean {
    if (selectedPattern) return source !== selectedPattern;
    if (selectedOutcome) return target !== selectedOutcome;
    return false;
  }

  function activate(node: { id: string; column: 0 | 1 }) {
    if (node.column === 0) onSelectPattern?.(node.id);
    else onSelectOutcome?.(node.id);
  }

  function plural(n: number): string {
    return `${n} reflection${n === 1 ? "" : "s"}`;
  }

  function percent(part: number, whole: number): string {
    if (whole <= 0) return "0%";
    const p = (part / whole) * 100;
    return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
  }

  // Links touching the hovered node, largest first.
  const hoverBreakdown = $derived.by(() => {
    if (hover?.kind !== "node") return [];
    const node = hover.node;
    return layout.links
      .filter((l) => (node.column === 0 ? l.source === node.id : l.target === node.id))
      .map((l) => ({ id: node.column === 0 ? l.target : l.source, value: l.value }))
      .sort((a, b) => b.value - a.value);
  });
</script>

<figure class="chart sankey" role="img" aria-label={`Reflections by pattern and proposal outcome, ${totalReflections} total`}>
  <figcaption class="chart__title">Pattern to proposal outcome</figcaption>
  {#if flows.length === 0}
    <div class="chart__empty">No reflections yet</div>
  {:else}
    <div class="sankey__plot" bind:this={plotEl} bind:clientWidth={measuredWidth}>
      <svg class="chart__svg sankey__svg" viewBox={`0 0 ${width} ${svgHeight}`} role="presentation" onpointerleave={clearHover}>
        <g transform={`translate(${LEFT_GUTTER}, ${PAD_Y})`}>
          {#each layout.links as link (linkKey(link))}
            <path
              class="sankey__link"
              class:dimmed={linkDimmed(link.source, link.target)}
              class:active={isLinkActive(link)}
              class:faded={hover !== null && !isLinkActive(link)}
              d={link.path}
              role="presentation"
              onpointerenter={(e) => hoverLink(link, e)}
              onpointermove={(e) => hoverLink(link, e)}
            />
          {/each}
          {#each layout.nodes as node (nodeKey(node))}
            {@const y = labelY.get(nodeKey(node)) ?? node.y + node.height / 2}
            <g
              class="sankey__node"
              class:dimmed={isDimmed(node.id, node.column)}
              class:hovered={hover?.kind === "node" && nodeKey(hover.node) === nodeKey(node)}
              role="presentation"
              onpointerenter={(e) => hoverNode(node, e)}
              onpointermove={(e) => hoverNode(node, e)}
              onclick={() => activate(node)}
            >
              <!-- Transparent strip over the label so a thin node is still easy to hit. -->
              <rect class="sankey__hit" x={node.column === 0 ? -LEFT_GUTTER : node.x + node.width} y={y - LABEL_SPACING / 2} width={node.column === 0 ? LEFT_GUTTER : RIGHT_GUTTER} height={LABEL_SPACING} />
              <rect
                class="sankey__bar"
                x={node.x}
                y={node.y}
                width={node.width}
                height={Math.max(node.height, 2)}
                role="button"
                tabindex="0"
                aria-label={`${node.id}: ${plural(node.value)}`}
                onfocus={() => focusNode(node)}
                onblur={clearHover}
                onkeydown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  activate(node);
                }}
              />
              <text x={node.column === 0 ? node.x - 8 : node.x + node.width + 8} {y} text-anchor={node.column === 0 ? "end" : "start"}>
                {shortLabel(node.id)} <tspan class="sankey__count">{node.value}</tspan>
              </text>
            </g>
          {/each}
        </g>
      </svg>

      {#if hover}
        <div class="sankey__tooltip" style={tooltipStyle} aria-hidden="true">
          {#if hover.kind === "node"}
            <div class="sankey__tooltip-title">{hover.node.id}</div>
            <div class="sankey__tooltip-meta">
              <strong>{plural(hover.node.value)}</strong>
              <span>{percent(hover.node.value, totalReflections)} of all</span>
            </div>
            <div class="sankey__tooltip-label">{hover.node.column === 0 ? "Outcome" : "From patterns"}</div>
            <ul>
              {#each hoverBreakdown.slice(0, TOOLTIP_ROWS) as row (row.id)}
                <li><span class="sankey__tooltip-name">{row.id}</span><span class="sankey__tooltip-num">{row.value} ({percent(row.value, hover.node.value)})</span></li>
              {/each}
            </ul>
            {#if hoverBreakdown.length > TOOLTIP_ROWS}
              <div class="sankey__tooltip-more">and {hoverBreakdown.length - TOOLTIP_ROWS} more</div>
            {/if}
            <div class="sankey__tooltip-hint">Click to filter the list</div>
          {:else}
            <div class="sankey__tooltip-title">{hover.link.source}</div>
            <div class="sankey__tooltip-sub">to {hover.link.target}</div>
            <div class="sankey__tooltip-meta">
              <strong>{plural(hover.link.value)}</strong>
              <span>{percent(hover.link.value, totalReflections)} of all</span>
            </div>
          {/if}
        </div>
      {/if}
    </div>
    <p class="sankey__hint muted">Hover for details. Click a pattern or an outcome to filter the list below. {OTHER_PATTERNS} groups everything past the top patterns.</p>
  {/if}
</figure>

<style>
  /* sankey */
  .sankey__plot {
    position: relative;
  }

  .sankey__svg {
    height: auto;
    font-size: 12px;
  }

  .sankey__link {
    fill: var(--accent);
    fill-opacity: 0.28;
    /* A hairline stroke keeps a one-reflection ribbon visible. */
    stroke: var(--accent);
    stroke-opacity: 0.35;
    stroke-width: 0.75;
    transition:
      fill-opacity 0.12s ease,
      stroke-opacity 0.12s ease;
  }

  .sankey__link.dimmed {
    fill-opacity: 0.06;
    stroke-opacity: 0.1;
  }

  .sankey__link.faded {
    fill-opacity: 0.1;
    stroke-opacity: 0.12;
  }

  .sankey__link.active {
    fill-opacity: 0.55;
    stroke-opacity: 0.8;
  }

  .sankey__hit {
    fill: transparent;
    cursor: pointer;
  }

  .sankey__bar {
    fill: var(--accent);
    cursor: pointer;
    transition: opacity 0.12s ease;
  }

  .sankey__node.dimmed .sankey__bar {
    opacity: 0.3;
  }

  .sankey__bar:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .sankey__node text {
    fill: var(--fg-soft);
    dominant-baseline: middle;
    cursor: pointer;
  }

  .sankey__node.dimmed text {
    fill: var(--muted);
  }

  .sankey__node.hovered text {
    fill: var(--fg);
  }

  .sankey__count {
    fill: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .sankey__tooltip {
    position: absolute;
    z-index: 5;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    background: var(--surface);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.3);
    font-size: var(--fs-xs);
    color: var(--fg-soft);
    pointer-events: none;
  }

  .sankey__tooltip-title {
    color: var(--fg);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .sankey__tooltip-sub {
    color: var(--muted);
  }

  .sankey__tooltip-meta {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin-top: 0.3rem;
    font-variant-numeric: tabular-nums;
  }

  .sankey__tooltip-meta strong {
    color: var(--fg);
  }

  .sankey__tooltip-meta span {
    color: var(--muted);
  }

  .sankey__tooltip-label {
    margin-top: 0.45rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.68rem;
  }

  .sankey__tooltip ul {
    margin: 0.2rem 0 0;
    padding: 0;
    list-style: none;
  }

  .sankey__tooltip li {
    display: flex;
    justify-content: space-between;
    gap: 0.6rem;
  }

  .sankey__tooltip-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sankey__tooltip-num {
    flex: none;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .sankey__tooltip-more,
  .sankey__tooltip-hint {
    margin-top: 0.3rem;
    color: var(--muted);
  }

  .sankey__hint {
    margin: 0.6rem 0 0;
    font-size: var(--fs-xs);
  }
</style>
