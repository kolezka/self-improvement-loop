<script lang="ts">
  import { toastState } from "../lib/state.svelte.ts";

  const cls = $derived(toastState.current ? `toast ${toastState.current.kind} show` : "toast");
</script>

<div id="toast" class={cls}>{toastState.current?.message ?? ""}</div>
