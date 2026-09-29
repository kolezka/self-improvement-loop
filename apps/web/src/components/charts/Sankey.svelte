<script lang="ts">
  import { buildSankey, type SankeyFlow } from "../../lib/sankey.ts";
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

  const WIDTH = 900;
  const NODE_WIDTH = 10;
  // Space reserved inside the viewBox for the pattern labels on the left and
  // the (shorter) outcome labels on the right, so text never spills past the
  // SVG's own coordinate space.
  const LEFT_GUTTER = 230;
  const RIGHT_GUTTER = 170;
  // Pattern slugs run long; past this many characters the label is cut and
  // the full name stays in the node's tooltip.
  const MAX_LABEL = 30;

  function shortLabel(id: string): string {
    return id.length > MAX_LABEL ? `${id.slice(0, MAX_LABEL - 1)}\u2026` : id;
  }
  const INNER_WIDTH = WIDTH - LEFT_GUTTER - RIGHT_GUTTER;

  const gap = $derived.by(() => {
    const columnCount = Math.max(new Set(flows.map((f) => f.source)).size, new Set(flows.map((f) => f.target)).size, 1);
    // Fewer nodes can afford a roomier gap; a long tail of patterns needs it
    // tight so every node still gets a visible sliver.
    return Math.max(Math.min(14, (height - columnCount) / columnCount), 2);
  });

  const layout = $derived(buildSankey(flows, { width: INNER_WIDTH, height, nodeWidth: NODE_WIDTH, gap }));
  const totalReflections = $derived(flows.reduce((sum, f) => sum + f.value, 0));

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
</script>

<figure class="chart sankey" role="img" aria-label={`Reflections by pattern and proposal outcome, ${totalReflections} total`}>
  <figcaption class="chart__title">Pattern to proposal outcome</figcaption>
  {#if flows.length === 0}
    <div class="chart__empty">No reflections yet</div>
  {:else}
    <svg class="chart__svg sankey__svg" viewBox={`0 0 ${WIDTH} ${height}`}>
      <g transform={`translate(${LEFT_GUTTER}, 0)`}>
        {#each layout.links as link (link.source + "\u0000" + link.target)}
          <path class="sankey__link" class:dimmed={linkDimmed(link.source, link.target)} d={link.path}>
            <title>{link.source} to {link.target}: {link.value} reflection{link.value === 1 ? "" : "s"}</title>
          </path>
        {/each}
        {#each layout.nodes as node (node.column + ":" + node.id)}
          <g class="sankey__node" class:dimmed={isDimmed(node.id, node.column)}>
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={Math.max(node.height, 1)}
              role="button"
              tabindex="0"
              aria-label={`${node.id}: ${node.value} reflection${node.value === 1 ? "" : "s"}`}
              onclick={() => activate(node)}
              onkeydown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                activate(node);
              }}
            >
              <title>{node.id}: {node.value} reflection{node.value === 1 ? "" : "s"}</title>
            </rect>
            <text x={node.column === 0 ? node.x - 6 : node.x + node.width + 6} y={node.y + node.height / 2} text-anchor={node.column === 0 ? "end" : "start"}>
              {shortLabel(node.id)} <tspan class="sankey__count">{node.value}</tspan>
            </text>
          </g>
        {/each}
      </g>
    </svg>
    <p class="sankey__hint muted">Click a pattern or an outcome to filter the list below. {OTHER_PATTERNS} groups everything past the top patterns.</p>
  {/if}
</figure>

<style>
  /* sankey */
  /* The SVG scales uniformly with its width, so text is sized in viewBox
     units; a CSS rem size would scale twice. */
  .sankey__svg {
    height: auto;
    font-size: 13px;
  }

  .sankey__link {
    fill: var(--accent);
    opacity: 0.28;
    transition: opacity 0.12s ease;
  }

  .sankey__link.dimmed {
    opacity: 0.06;
  }

  .sankey__node rect {
    fill: var(--accent);
    cursor: pointer;
    transition: opacity 0.12s ease;
  }

  .sankey__node.dimmed rect {
    opacity: 0.3;
  }

  .sankey__node rect:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .sankey__node text {
    fill: var(--fg-soft);
    dominant-baseline: middle;
  }

  .sankey__node.dimmed text {
    fill: var(--muted);
  }

  .sankey__count {
    fill: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .sankey__hint {
    margin: 0.6rem 0 0;
    font-size: var(--fs-xs);
  }
</style>
