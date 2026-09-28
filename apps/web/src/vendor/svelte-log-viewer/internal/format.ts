// Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first.
/** Display helper shared by the toolbar counts. */

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

/** Thousands separators: 12000 becomes "12,000". */
export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value);
}
