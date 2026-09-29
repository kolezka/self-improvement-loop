<script lang="ts">
  import { dayLabel, niceMax, scaleY, total, yTicks, type ChartSeries, type ChartTone } from "../../lib/chart.ts";

  interface Props {
    series: ChartSeries[];
    height?: number;
    stacked?: boolean;
    title: string;
  }

  let { series, height = 120, stacked = false, title }: Props = $props();

  const TONE_VAR: Record<ChartTone, string> = {
    accent: "var(--accent)",
    ok: "var(--ok)",
    warn: "var(--warn)",
    err: "var(--err)",
    muted: "var(--muted)",
  };

  const days = $derived(series[0]?.points.map((p) => p.day) ?? []);
  const viewBoxWidth = $derived(Math.max(days.length * 10, 10));

  const max = $derived.by(() => {
    if (stacked) {
      const dayTotals = days.map((_, i) => series.reduce((sum, s) => sum + (s.points[i]?.count ?? 0), 0));
      return niceMax(dayTotals);
    }
    return niceMax(series.flatMap((s) => s.points.map((p) => p.count)));
  });

  const hasActivity = $derived(series.some((s) => total(s.points) > 0));
  const summary = $derived(series.map((s) => `${s.label} ${total(s.points)}`).join(", "));

  const TICK_COUNT = 4;
  const ticks = $derived(yTicks(max, TICK_COUNT));
  const yLabels = $derived([...ticks].reverse());

  interface XAxisLabels {
    first: string;
    middle: string | null;
    last: string;
  }

  const xAxisLabels = $derived.by((): XAxisLabels | null => {
    if (days.length === 0) return null;
    const first = dayLabel(days[0]);
    const last = dayLabel(days[days.length - 1]);
    if (days.length <= 2) return { first, middle: null, last };
    const mid = Math.floor((days.length - 1) / 2);
    return { first, middle: dayLabel(days[mid]), last };
  });

  interface Segment {
    x: number;
    y: number;
    width: number;
    height: number;
    tone: ChartTone;
    label: string;
  }

  interface Group {
    day: string;
    segments: Segment[];
  }

  const groups = $derived.by((): Group[] => {
    return days.map((day, i) => {
      if (stacked) {
        let cumulative = 0;
        const segments: Segment[] = series.map((s) => {
          const count = s.points[i]?.count ?? 0;
          const yTop = scaleY(cumulative + count, max, height);
          const yBottom = scaleY(cumulative, max, height);
          cumulative += count;
          return { x: i * 10 + 1, y: yTop, width: 8, height: Math.max(yBottom - yTop, 0), tone: s.tone, label: `${dayLabel(day)}: ${count}` };
        });
        return { day, segments };
      }
      const barWidth = 8 / Math.max(series.length, 1);
      const segments: Segment[] = series.map((s, si) => {
        const count = s.points[i]?.count ?? 0;
        const yTop = scaleY(count, max, height);
        return { x: i * 10 + 1 + si * barWidth, y: yTop, width: barWidth, height: Math.max(height - yTop, 0), tone: s.tone, label: `${dayLabel(day)}: ${count}` };
      });
      return { day, segments };
    });
  });
</script>

<figure class="chart" role="img" aria-label={`${title}: ${summary}`}>
  <figcaption class="chart__title">{title}</figcaption>
  {#if !hasActivity}
    <div class="chart__empty">No activity in this window</div>
  {:else}
    <div class="chart__plot">
      <div class="chart__yaxis" style={`height: ${height}px`}>
        {#each yLabels as tick (tick)}
          <span>{Math.round(tick)}</span>
        {/each}
      </div>
      <svg class="chart__svg" viewBox={`0 0 ${viewBoxWidth} ${height}`} preserveAspectRatio="none" height={height} width="100%">
        {#each ticks as tick (tick)}
          <line
            x1="0"
            x2={viewBoxWidth}
            y1={scaleY(tick, max, height)}
            y2={scaleY(tick, max, height)}
            class={tick === 0 ? "chart__baseline" : "chart__gridline"}
            vector-effect="non-scaling-stroke"
          />
        {/each}
        {#each groups as group (group.day)}
          {#each group.segments as segment, si (si)}
            {#if segment.height > 0}
              <rect x={segment.x} y={segment.y} width={segment.width} height={segment.height} fill={TONE_VAR[segment.tone]}>
                <title>{segment.label}</title>
              </rect>
            {/if}
          {/each}
        {/each}
      </svg>
    </div>
    {#if xAxisLabels}
      <div class="chart__xaxis">
        <span>{xAxisLabels.first}</span>
        {#if xAxisLabels.middle}<span>{xAxisLabels.middle}</span>{/if}
        <span>{xAxisLabels.last}</span>
      </div>
    {/if}
  {/if}
  <ul class="chart__legend">
    {#each series as s (s.label)}
      <li><span class="chart__swatch" style:background={TONE_VAR[s.tone]}></span>{s.label} <strong>{total(s.points)}</strong></li>
    {/each}
  </ul>
</figure>
