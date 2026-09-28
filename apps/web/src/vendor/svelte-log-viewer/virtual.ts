// Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first.
/**
 * Geometry for the log viewer's virtual scroller. Pure functions, no DOM and no
 * state, so the window maths can be unit tested without a browser.
 *
 * Two modes. Unwrapped rows are all the same height, so the window is plain
 * division. Wrapped rows are taller by whole rows; the face is monospace, so the
 * height of a line is exact once the column count is known, and `buildOffsets`
 * turns those heights into a prefix sum the window binary searches.
 */

/** Height of one unwrapped log row in pixels. */
export const ROW_HEIGHT = 20;

/** Rows kept above and below the viewport so a fast scroll never shows a gap. */
export const DEFAULT_OVERSCAN = 12;

export interface VirtualWindow {
  /** First row index to render. */
  start: number;
  /** One past the last row index to render. */
  end: number;
  /** Pixels the rendered slice is pushed down by. */
  offsetTop: number;
  /** Height of the whole scrollable content. */
  totalHeight: number;
}

export interface WindowInput {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  count: number;
  overscan?: number;
}

export interface VariableWindowInput {
  scrollTop: number;
  viewportHeight: number;
  /** From `buildOffsets`: one entry per row plus the total. */
  offsets: ArrayLike<number>;
  overscan?: number;
}

const EMPTY: VirtualWindow = { start: 0, end: 0, offsetTop: 0, totalHeight: 0 };

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  return value > max ? max : value;
}

/** Which rows to render when every row is the same height. */
export function computeWindow(input: WindowInput): VirtualWindow {
  const rowHeight = Math.max(1, Math.floor(input.rowHeight));
  const count = Math.max(0, Math.floor(input.count));
  if (count === 0) return EMPTY;

  const overscan = Math.max(0, Math.floor(input.overscan ?? DEFAULT_OVERSCAN));
  const viewportHeight = Math.max(0, input.viewportHeight);
  const totalHeight = count * rowHeight;
  const scrollTop = clamp(input.scrollTop, 0, Math.max(0, totalHeight - viewportHeight));

  const firstVisible = Math.floor(scrollTop / rowHeight);
  // The extra row covers a viewport that does not divide evenly into rows.
  const visibleRows = Math.ceil(viewportHeight / rowHeight) + 1;
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(count, firstVisible + visibleRows + overscan);

  return { start, end, offsetTop: start * rowHeight, totalHeight };
}

/** Rows a line of `length` characters takes once wrapped into `columns` columns. */
export function rowSpan(length: number, columns: number): number {
  if (!Number.isFinite(columns) || columns <= 0) return 1;
  return Math.max(1, Math.ceil(length / columns));
}

/**
 * Pixel offset of every row plus the total, so `offsets[i + 1] - offsets[i]` is
 * the height of row i. `lengths` holds the character count of each line.
 */
export function buildOffsets(
  lengths: ArrayLike<number>,
  columns: number,
  rowHeight: number,
): Int32Array {
  const height = Math.max(1, Math.floor(rowHeight));
  const offsets = new Int32Array(lengths.length + 1);
  let top = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    offsets[index] = top;
    top += rowSpan(lengths[index], columns) * height;
  }
  offsets[lengths.length] = top;
  return offsets;
}

/** Index of the row covering pixel `y`. */
export function findRowAt(offsets: ArrayLike<number>, y: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Which rows to render when rows differ in height. */
export function computeVariableWindow(input: VariableWindowInput): VirtualWindow {
  const count = input.offsets.length - 1;
  if (count <= 0) return EMPTY;

  const overscan = Math.max(0, Math.floor(input.overscan ?? DEFAULT_OVERSCAN));
  const viewportHeight = Math.max(0, input.viewportHeight);
  const totalHeight = input.offsets[count];
  const scrollTop = clamp(input.scrollTop, 0, Math.max(0, totalHeight - viewportHeight));

  const firstVisible = findRowAt(input.offsets, scrollTop);
  const lastVisible = findRowAt(input.offsets, scrollTop + viewportHeight);
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(count, lastVisible + 1 + overscan);

  return { start, end, offsetTop: input.offsets[start], totalHeight };
}
