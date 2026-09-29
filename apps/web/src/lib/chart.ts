// Pure helpers for the inline SVG bar and line charts. No Svelte imports here
// so the scale math stays trivial to unit test.

import type { SeriesPoint } from "./api-types.ts";

export type ChartTone = "accent" | "ok" | "warn" | "err" | "muted";

export interface ChartSeries {
  label: string;
  tone: ChartTone;
  points: SeriesPoint[];
}

/** Pixel y for a count: 0 maps to the bottom (height), max maps to the top (0). */
export function scaleY(value: number, max: number, height: number): number {
  if (max <= 0) return height;
  const ratio = Math.min(Math.max(value / max, 0), 1);
  return height * (1 - ratio);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-28" -> "28 Sep". String split, not Date, so it never shifts a day
 * to the local or UTC offset. */
export function dayLabel(day: string): string {
  const [, month, date] = day.split("-");
  const monthName = MONTHS[Number(month) - 1] ?? month;
  return `${Number(date)} ${monthName}`;
}

/** Sum of counts across a series window. */
export function total(points: SeriesPoint[]): number {
  return points.reduce((sum, p) => sum + p.count, 0);
}

/** At most `count` whole-number ticks from 0; the last one is the top of the chart. */
export function yTicks(max: number, count: number): number[] {
  if (max <= 0) return [0, 1];
  const intervals = Math.max(count - 1, 1);
  // Whole steps only: the values are counts, and a fractional step rounded
  // for display printed the same label twice.
  let step = 1;
  for (let magnitude = 1; ; magnitude *= 10) {
    const found = [1, 2, 5].map((m) => m * magnitude).find((s) => Math.ceil(max / s) <= intervals);
    if (found !== undefined) {
      step = found;
      break;
    }
  }
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}
