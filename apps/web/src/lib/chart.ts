// Pure helpers for the inline SVG bar and line charts. No Svelte imports here
// so the scale math stays trivial to unit test.

import type { SeriesPoint } from "./api-types.ts";

export type ChartTone = "accent" | "ok" | "warn" | "err" | "muted";

export interface ChartSeries {
  label: string;
  tone: ChartTone;
  points: SeriesPoint[];
}

const NICE_STEPS = [1, 1.5, 2, 2.5, 5, 10];

/** Smallest "nice" axis ceiling at or above the window's max value.
 * 0 -> 1, 7 -> 10, 23 -> 25, 101 -> 150. */
export function niceMax(values: number[]): number {
  const max = values.length > 0 ? Math.max(0, ...values) : 0;
  if (max <= 0) return 1;

  let exponent = Math.floor(Math.log10(max));
  let magnitude = 10 ** exponent;
  // Guards against float error at decade boundaries (log10(100) can land
  // fractionally under 2).
  if (max / magnitude >= 10) {
    exponent += 1;
    magnitude *= 10;
  }

  const fraction = max / magnitude;
  const niceFraction = NICE_STEPS.find((step) => step >= fraction) ?? 10;
  return niceFraction * magnitude;
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
