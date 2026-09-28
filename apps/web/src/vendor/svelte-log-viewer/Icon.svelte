<!-- Vendored from github.com/kolezka/svelte-log-viewer@ef28afc (private, same author). Edit upstream first. -->
<script lang="ts">
  import { ICON_PATHS, type IconName } from "./icons.ts";

  interface Props {
    name: IconName;
    size?: number;
  }

  let { name, size = 24 }: Props = $props();
  const paths = $derived(ICON_PATHS[name]);
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each paths as d}
    <path {d}></path>
  {/each}
</svg>
