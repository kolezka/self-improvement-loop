<script lang="ts">
  import { parseMarkdown } from "../lib/markdown.ts";

  let { text = "" }: { text?: string } = $props();
  const blocks = $derived(parseMarkdown(text));
</script>

<div class="body-doc">
  {#each blocks as block}
    {#if block.type === "heading"}
      {#if block.level === 1}
        <h1>{block.text}</h1>
      {:else if block.level === 2}
        <h2>{block.text}</h2>
      {:else}
        <h3>{block.text}</h3>
      {/if}
    {:else if block.type === "code"}
      <pre><code>{block.text}</code></pre>
    {:else if block.type === "list"}
      <ul>
        {#each block.items as item}
          <li>{item}</li>
        {/each}
      </ul>
    {:else}
      <p>{block.text}</p>
    {/if}
  {/each}
</div>
