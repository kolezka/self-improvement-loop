<!-- Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first. -->
<!-- A keyboard key in running text: <Kbd>Ctrl</Kbd>. -->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<kbd>{@render children()}</kbd>

<style>
  kbd {
    display: inline-block;
    min-width: 18px;
    padding: 1px var(--lv-space-1);
    border: 1px solid var(--lv-border-strong);
    border-bottom-width: 2px;
    border-radius: var(--lv-radius-sm);
    background: var(--lv-surface-raised);
    color: var(--lv-text-secondary);
    font-size: 11px;
    line-height: 16px;
    text-align: center;
  }
</style>
