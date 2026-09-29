<script lang="ts">
  import { tick, type Snippet } from "svelte";

  interface Props {
    open: boolean;
    title: string;
    width?: string;
    children: Snippet;
    onclose?: () => void;
  }

  let { open = $bindable(), title, width = "min(44rem, 100vw)", children, onclose }: Props = $props();

  let panel = $state<HTMLElement | null>(null);
  let opener: Element | null = null;

  function close() {
    open = false;
    onclose?.();
  }

  // The pane content has `view-transition-name` set for the pane-switch
  // animation, which makes it a stacking context. A `position: fixed`
  // drawer nested inside it stays trapped under that context no matter how
  // high its own z-index goes, so the top bar (a sibling stacking context)
  // paints over it. Move the drawer to `body` so it stacks at the page root.
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  function onKeydown(event: KeyboardEvent) {
    if (open && event.key === "Escape") close();
  }

  $effect(() => {
    if (open) {
      opener = document.activeElement;
      tick().then(() => panel?.focus());
    } else if (opener instanceof HTMLElement) {
      opener.focus();
      opener = null;
    }
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div use:portal>
    <div class="drawer-scrim" onclick={close} aria-hidden="true"></div>
    <div class="drawer" style:width role="dialog" aria-modal="true" aria-label={title} tabindex="-1" bind:this={panel}>
      <header class="drawer__head">
        <h2>{title}</h2>
        <button class="ghost" onclick={close} aria-label="Close">Close</button>
      </header>
      <div class="drawer__body">
        {@render children()}
      </div>
    </div>
  </div>
{/if}
