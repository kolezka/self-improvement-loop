// Pure two-column Sankey layout. No Svelte or DOM here, so the geometry
// stays trivial to unit test: give it flows and a box, get back positioned
// nodes and ribbon paths.

export interface SankeyFlow {
  source: string;
  target: string;
  value: number;
}

export interface SankeyLayoutOptions {
  width: number;
  height: number;
  nodeWidth: number;
  gap: number;
}

export interface SankeyNode {
  id: string;
  column: 0 | 1;
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
  path: string;
  sourceY0: number;
  sourceY1: number;
  targetY0: number;
  targetY1: number;
}

export interface SankeyLayout {
  nodes: SankeyNode[];
  links: SankeyLink[];
}

/** Column order is first-appearance order in `flows`, not sorted by value.
 * Deterministic and stable across reloads as long as the caller feeds flows
 * in a stable order (patterns are already sorted upstream). */
function columnOrder(flows: SankeyFlow[], key: "source" | "target"): string[] {
  const seen = new Set<string>();
  for (const flow of flows) seen.add(flow[key]);
  return [...seen];
}

function columnValues(flows: SankeyFlow[], ids: string[], key: "source" | "target"): Map<string, number> {
  const totals = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const flow of flows) totals.set(flow[key], (totals.get(flow[key]) ?? 0) + flow.value);
  return totals;
}

/** Merges flows sharing a source and target so one ribbon carries their
 * combined value instead of drawing an overlapping duplicate. */
function mergeFlows(flows: SankeyFlow[]): SankeyFlow[] {
  const order: string[] = [];
  const totals = new Map<string, SankeyFlow>();
  for (const flow of flows) {
    const key = `${flow.source}\u0000${flow.target}`;
    const existing = totals.get(key);
    if (existing) {
      existing.value += flow.value;
    } else {
      totals.set(key, { ...flow });
      order.push(key);
    }
  }
  return order.map((key) => totals.get(key)!);
}

/** A filled ribbon from the source node's right edge to the target node's
 * left edge: a cubic bezier top curve, a straight edge down at the target,
 * a cubic bezier bottom curve back, closed at the source. */
function ribbonPath(x0: number, sy0: number, sy1: number, x1: number, ty0: number, ty1: number): string {
  const xc = (x0 + x1) / 2;
  return `M${x0},${sy0} C${xc},${sy0} ${xc},${ty0} ${x1},${ty0} L${x1},${ty1} C${xc},${ty1} ${xc},${sy1} ${x0},${sy1} Z`;
}

/** Lays out a two-column Sankey: sources on the left, targets on the right,
 * link width proportional to flow value. `ky` (pixels per unit of value) is
 * shared by both columns so a link's ribbon is the same thickness at both
 * ends; whichever column has more nodes (more gaps eating into the height)
 * sets that shared scale, and the other column is left top-aligned with
 * spare room below rather than stretched to fill it. */
export function buildSankey(flows: SankeyFlow[], opts: SankeyLayoutOptions): SankeyLayout {
  if (flows.length === 0) return { nodes: [], links: [] };

  const merged = mergeFlows(flows);
  const sourceIds = columnOrder(merged, "source");
  const targetIds = columnOrder(merged, "target");
  const sourceValues = columnValues(merged, sourceIds, "source");
  const targetValues = columnValues(merged, targetIds, "target");
  const total = merged.reduce((sum, f) => sum + f.value, 0);

  const availableHeight = (count: number) => Math.max(opts.height - opts.gap * Math.max(count - 1, 0), 0);
  const ky = total > 0 ? Math.min(availableHeight(sourceIds.length), availableHeight(targetIds.length)) / total : 0;

  const nodes: SankeyNode[] = [];
  const nodeById = new Map<string, SankeyNode>();

  function layoutColumn(ids: string[], values: Map<string, number>, column: 0 | 1, x: number) {
    let y = 0;
    for (const id of ids) {
      const value = values.get(id) ?? 0;
      const height = value * ky;
      const node: SankeyNode = { id, column, x, y, width: opts.nodeWidth, height, value };
      nodes.push(node);
      nodeById.set(`${column}:${id}`, node);
      y += height + opts.gap;
    }
  }

  layoutColumn(sourceIds, sourceValues, 0, 0);
  layoutColumn(targetIds, targetValues, 1, opts.width - opts.nodeWidth);

  const sourceCursor = new Map<string, number>(sourceIds.map((id) => [id, nodeById.get(`0:${id}`)!.y]));
  const targetCursor = new Map<string, number>(targetIds.map((id) => [id, nodeById.get(`1:${id}`)!.y]));

  const links: SankeyLink[] = merged.map((flow) => {
    const thickness = flow.value * ky;
    const sourceY0 = sourceCursor.get(flow.source) ?? 0;
    const sourceY1 = sourceY0 + thickness;
    sourceCursor.set(flow.source, sourceY1);

    const targetY0 = targetCursor.get(flow.target) ?? 0;
    const targetY1 = targetY0 + thickness;
    targetCursor.set(flow.target, targetY1);

    const x0 = nodeById.get(`0:${flow.source}`)!.x + opts.nodeWidth;
    const x1 = nodeById.get(`1:${flow.target}`)!.x;

    return {
      source: flow.source,
      target: flow.target,
      value: flow.value,
      path: ribbonPath(x0, sourceY0, sourceY1, x1, targetY0, targetY1),
      sourceY0,
      sourceY1,
      targetY0,
      targetY1,
    };
  });

  return { nodes, links };
}
