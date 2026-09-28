<!-- Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first. -->
<!--
  Native select, styled to match the other controls. A native option renders
  plain text only, so `suffix` is appended after a separator; the muted look is
  the disabled colour, which is what a suffix almost always explains.
-->
<script lang="ts">
  import type { SelectOption } from "./types.ts";

  interface Props {
    options: SelectOption[];
    value?: string;
    id?: string;
    disabled?: boolean;
    invalid?: boolean;
    ariaLabel?: string;
    describedBy?: string;
    onchange?: (value: string) => void;
  }

  let {
    options,
    value = $bindable(""),
    id,
    disabled = false,
    invalid = false,
    ariaLabel,
    describedBy,
    onchange,
  }: Props = $props();

  function handleChange(event: Event) {
    onchange?.((event.currentTarget as HTMLSelectElement).value);
  }

  function textOf(option: SelectOption): string {
    return option.suffix ? `${option.label} · ${option.suffix}` : option.label;
  }
</script>

<select
  class="select"
  class:invalid
  {id}
  {disabled}
  aria-label={ariaLabel}
  aria-describedby={describedBy}
  aria-invalid={invalid ? "true" : undefined}
  bind:value
  onchange={handleChange}
>
  {#each options as option (option.value)}
    <option value={option.value} disabled={option.disabled}>{textOf(option)}</option>
  {/each}
</select>

<style>
  .select {
    width: 100%;
    height: 30px;
    padding: 0 var(--lv-space-6) 0 var(--lv-space-2);
    border: 1px solid var(--lv-border-strong);
    border-radius: var(--lv-radius-md);
    background: var(--lv-surface-page);
    color: var(--lv-text-primary);
    font-size: var(--lv-text-13);
    appearance: none;
    background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
      linear-gradient(135deg, currentColor 50%, transparent 50%);
    background-position:
      calc(100% - 14px) 13px,
      calc(100% - 9px) 13px;
    background-size:
      5px 5px,
      5px 5px;
    background-repeat: no-repeat;
    cursor: pointer;
  }

  .select:hover:not(:disabled) {
    border-color: var(--lv-text-muted);
  }

  .select:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .select option:disabled {
    color: var(--lv-text-muted);
  }

  .invalid {
    border-color: var(--lv-danger);
  }
</style>
