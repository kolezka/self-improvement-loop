<!-- Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first. -->
<!-- Determinate bar for a 0..1 ratio, or an indeterminate sweep. -->
<script lang="ts">
  import type { Tone } from "./types.ts";

  interface Props {
    /** 0..1. Clamped. Ignored when `indeterminate`. */
    value?: number;
    tone?: Tone;
    indeterminate?: boolean;
    /** Accessible name. */
    label?: string;
    height?: number;
  }

  let { value = 0, tone = "accent", indeterminate = false, label, height = 4 }: Props = $props();

  const ratio = $derived(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)));
</script>

<div
  class="track {tone}"
  style="--bar-height: {height}px"
  role="progressbar"
  aria-label={label}
  aria-valuemin={indeterminate ? undefined : 0}
  aria-valuemax={indeterminate ? undefined : 100}
  aria-valuenow={indeterminate ? undefined : Math.round(ratio * 100)}
>
  <div class="fill" class:indeterminate style={indeterminate ? "" : `width: ${ratio * 100}%`}></div>
</div>

<style>
  .track {
    width: 100%;
    height: var(--bar-height);
    border-radius: 999px;
    background: var(--lv-border);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    border-radius: 999px;
    background: currentColor;
    transition: width 0.2s ease;
  }

  .neutral {
    color: var(--lv-text-muted);
  }
  .accent {
    color: var(--lv-accent);
  }
  .success {
    color: var(--lv-success);
  }
  .warning {
    color: var(--lv-warning);
  }
  .danger {
    color: var(--lv-danger);
  }
  .info {
    color: var(--lv-info);
  }

  .indeterminate {
    width: 35%;
    animation: sweep 1.2s ease-in-out infinite;
  }

  @keyframes sweep {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(340%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .indeterminate {
      animation: none;
      width: 100%;
      opacity: 0.4;
    }
  }
</style>
