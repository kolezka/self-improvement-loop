<!-- Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first. -->
<!-- Shown in place of content when there is nothing to show. -->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    description?: string;
    /** Icon snippet, drawn above the title. */
    icon?: Snippet;
    /** A button or link offering the next step. */
    action?: Snippet;
    /** Tighter version for an empty table body. */
    compact?: boolean;
  }

  let { title, description, icon, action, compact = false }: Props = $props();
</script>

<div class="empty" class:compact>
  {#if icon}<div class="icon">{@render icon()}</div>{/if}
  <p class="title">{title}</p>
  {#if description}<p class="description">{description}</p>{/if}
  {#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--lv-space-2);
    padding: var(--lv-space-12) var(--lv-space-6);
    text-align: center;
  }

  .compact {
    padding: var(--lv-space-6);
  }

  .icon {
    display: flex;
    color: var(--lv-text-muted);
    margin-bottom: var(--lv-space-1);
  }

  .title {
    font-size: var(--lv-text-14);
    font-weight: 600;
  }

  .description {
    color: var(--lv-text-secondary);
    font-size: var(--lv-text-13);
    max-width: 60ch;
  }

  .action {
    margin-top: var(--lv-space-2);
  }
</style>
