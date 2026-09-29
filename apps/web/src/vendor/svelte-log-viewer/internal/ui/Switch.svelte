<!-- Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first. -->
<!-- On/off toggle for a setting that applies immediately. -->
<script lang="ts">
  interface Props {
    checked?: boolean;
    /** Text to the right of the track. */
    label?: string;
    /** Accessible name when no visible label is given. */
    ariaLabel?: string;
    id?: string;
    disabled?: boolean;
    onchange?: (checked: boolean) => void;
  }

  let {
    checked = $bindable(false),
    label,
    ariaLabel,
    id,
    disabled = false,
    onchange,
  }: Props = $props();

  function toggle() {
    if (disabled) return;
    checked = !checked;
    onchange?.(checked);
  }
</script>

<div class="switch-row" class:disabled>
  <button
    {id}
    type="button"
    role="switch"
    class="track"
    class:on={checked}
    aria-checked={checked}
    aria-label={ariaLabel ?? label}
    {disabled}
    onclick={toggle}
  >
    <span class="thumb"></span>
  </button>
  {#if label}
    <button type="button" class="label" {disabled} onclick={toggle} tabindex="-1">{label}</button>
  {/if}
</div>

<style>
  .switch-row {
    display: inline-flex;
    align-items: center;
    gap: var(--lv-space-2);
  }

  .switch-row.disabled {
    opacity: 0.55;
  }

  .track {
    position: relative;
    width: 30px;
    height: 18px;
    /* The host app's global `button` rule sets min-height: var(--control-height)
       (2rem), which otherwise stretches this pill to a near-circle. */
    min-height: 0;
    padding: 0;
    border: 1px solid var(--lv-border-strong);
    border-radius: 999px;
    background: var(--lv-surface-raised);
    cursor: pointer;
    flex: none;
    transition: background-color 0.15s ease;
  }

  .track.on {
    background: var(--lv-accent);
    border-color: var(--lv-accent);
  }

  .track:disabled {
    cursor: not-allowed;
  }

  .thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--lv-text-secondary);
    transition: transform 0.15s ease;
  }

  .track.on .thumb {
    background: var(--lv-on-accent);
    transform: translateX(12px);
  }

  .label {
    border: 0;
    background: none;
    padding: 0;
    font-size: var(--lv-text-13);
    color: var(--lv-text-primary);
    cursor: pointer;
  }
</style>
