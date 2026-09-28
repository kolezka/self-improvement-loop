<script lang="ts">
  import { dayLabel, niceMax, scaleY, total, type ChartSeries, type ChartTone } from "../../lib/chart.ts";

  interface Props {
    series: ChartSeries[];
    height?: number;
    title: string;
  }

  let { series, height = 120, title }: Props = $props();

  const TONE_VAR: Record<ChartTone, string> = {
    accent: "var(--accent)",
    ok: "var(--ok)",
    warn: "var(--warn)",
    err: "var(--err)",
    muted: "var(--muted)",
  };

  const days = $derived(series[0]?.points.map((p) => p.day) ?? []);
  const viewBoxWidth = $derived(Math.max(days.length * 10, 10));
  const max = $derived(niceMax(series.flatMap((s) => s.points.map((p) => p.count))));
  const hasActivity = $derived(series.some((s) => total(s.points) > 0));
  const summary = $derived(series.map((s) => `${s.label} ${total(s.points)}`).join(", "));

  interface LinePoint {
    x: number;
    y: number;
    label: string;
  }

  interface Line {
    label: string;
    tone: ChartTone;
    polyline: string;
    points: LinePoint[];
  }

  const lines = $derived.by((): Line[] =>
    series.map((s) => {
      const points: LinePoint[] = s.points.map((p, i) => ({
        x: i * 10 + 5,
        y: scaleY(p.count, max, height),
        label: `${dayLabel(p.day)}: ${p.count}`,
      }));
      return { label: s.label, tone: s.tone, points, polyline: points.map((p) => `${p.x},${p.y}`).join(" ") };
    })
  );
</script>

<figure class="chart" role="img" aria-label={`${title}: ${summary}`}>
  <figcaption class="chart__title">{title}</figcaption>
  {#if !hasActivity}
    <div class="chart__empty">No activity in this window</div>
  {:else}
    <svg class="chart__svg" viewBox={`0 0 ${viewBoxWidth} ${height}`} preserveAspectRatio="none" height={height} width="100%">
      {#each lines as line (line.label)}
        <polyline points={line.polyline} fill="none" stroke={TONE_VAR[line.tone]} stroke-width="1.5" vector-effect="non-scaling-stroke" />
        {#each line.points as p, i (i)}
          <circle cx={p.x} cy={p.y} r="1.6" fill={TONE_VAR[line.tone]}>
            <title>{p.label}</title>
          </circle>
        {/each}
      {/each}
    </svg>
  {/if}
  <ul class="chart__legend">
    {#each series as s (s.label)}
      <li><span class="chart__swatch" style:background={TONE_VAR[s.tone]}></span>{s.label} <strong>{total(s.points)}</strong></li>
    {/each}
  </ul>
</figure>
