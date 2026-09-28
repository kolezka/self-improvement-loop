// Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first.
/** Shared prop types for the internal ui kit. */

/** Semantic colour of a bar or similar control. */
export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

/** One Select option. */
export interface SelectOption {
  value: string;
  label: string;
  /** Muted note after the label, for example why the option is off. */
  suffix?: string;
  disabled?: boolean;
}
