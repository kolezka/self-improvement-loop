<script lang="ts">
  import { parseDiff } from "../lib/markdown.ts";

  let { text = "" }: { text?: string } = $props();
  const lines = $derived(parseDiff(text));
</script>

<pre class="diff">{#each lines as line}<span class={line.cls}>{line.text + "\n"}</span>{/each}</pre>
