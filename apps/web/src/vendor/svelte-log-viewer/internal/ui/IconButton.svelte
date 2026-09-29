<!-- Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first. -->
<!-- Square icon-only control. `label` is required: it is the accessible name. -->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    /** Accessible name and tooltip text. */
    label: string;
    variant?: "ghost" | "secondary" | "danger";
    size?: "sm" | "md";
    href?: string;
    target?: string;
    download?: string | boolean;
    disabled?: boolean;
    /** Renders in the accent colour, for a toggled-on state. */
    active?: boolean;
    children: Snippet;
    onclick?: (event: MouseEvent) => void;
  }

  let {
    label,
    variant = "ghost",
    size = "md",
    href,
    target,
    download,
    disabled = false,
    active = false,
    children,
    onclick,
  }: Props = $props();

  // A `disabled` control gets no mouse events, so the browser never shows its
  // title. aria-disabled keeps the tooltip visible and the guard below keeps
  // the click from doing anything.
  function handleClick(event: MouseEvent): void {
    if (disabled) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onclick?.(event);
  }
</script>

{#if href}
  <a
    class="icon-button {variant} {size}"
    class:active
    class:disabled
    href={disabled ? undefined : href}
    {target}
    download={download === true ? "" : download || undefined}
    rel={target === "_blank" ? "noreferrer" : undefined}
    aria-label={label}
    aria-disabled={disabled ? "true" : undefined}
    data-tip={label}
    onclick={handleClick}
  >
    {@render children()}
  </a>
{:else}
  <button
    class="icon-button {variant} {size}"
    class:active
    class:disabled
    type="button"
    aria-label={label}
    aria-disabled={disabled ? "true" : undefined}
    aria-pressed={active ? "true" : undefined}
    data-tip={label}
    onclick={handleClick}
  >
    {@render children()}
  </button>
{/if}

<style>
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: var(--lv-radius-md);
    background: transparent;
    color: var(--lv-text-secondary);
    cursor: pointer;
    flex: none;
    transition:
      background-color 0.12s ease,
      color 0.12s ease;
  }

  .md {
    width: 30px;
    height: 30px;
  }

  .sm {
    width: 24px;
    height: 24px;
  }

  .icon-button:hover:not(:disabled):not(.disabled) {
    background: var(--lv-surface-hover);
    color: var(--lv-text-primary);
  }

  .secondary {
    background: var(--lv-surface-raised);
    border-color: var(--lv-border-strong);
  }

  .danger:hover:not(:disabled):not(.disabled) {
    background: var(--lv-danger-subtle);
    color: var(--lv-danger);
  }

  .active {
    color: var(--lv-accent);
  }

  .icon-button:disabled,
  .icon-button.disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /*
    CSS-only tooltip on the data-tip attribute, ported from the host app's
    global stylesheet so an icon button's tooltip still works standalone.
  */
  [data-tip] {
    position: relative;
  }

  [data-tip]::after {
    content: attr(data-tip);
    position: absolute;
    left: 50%;
    bottom: calc(100% + 6px);
    transform: translateX(-50%);
    z-index: 70;
    padding: 3px var(--lv-space-2);
    border: 1px solid var(--lv-border-strong);
    border-radius: var(--lv-radius-sm);
    background: var(--lv-surface-raised);
    color: var(--lv-text-primary);
    font-family: var(--lv-font-sans);
    font-size: var(--lv-text-12);
    font-weight: 400;
    line-height: 1.4;
    white-space: nowrap;
    box-shadow: var(--lv-shadow-sm);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition:
      opacity 0.12s ease 0.25s,
      visibility 0s linear 0.25s;
  }

  [data-tip]:hover::after,
  [data-tip]:focus-visible::after {
    opacity: 1;
    visibility: visible;
  }

  [data-tip=""]::after {
    content: none;
  }
</style>
