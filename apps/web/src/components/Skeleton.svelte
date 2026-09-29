<script lang="ts">
  interface Props {
    width?: string;
    height?: string;
    radius?: string;
  }

  let { width = "100%", height = "1em", radius = "var(--r-sm)" }: Props = $props();
</script>

<span class="skeleton" aria-hidden="true" style:width style:height style:border-radius={radius}></span>
