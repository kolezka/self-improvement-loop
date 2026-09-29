<script lang="ts">
  import { parseMarkdown, splitFrontMatter } from "../lib/markdown.ts";

  let { text = "" }: { text?: string } = $props();
  const split = $derived(splitFrontMatter(text));
  const blocks = $derived(parseMarkdown(split.body));
</script>

<div class="body-doc">
  {#if split.frontMatter !== null}
    <pre class="front-matter"><code>{split.frontMatter}</code></pre>
  {/if}
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

<style>
  /* body-doc lands inside a panel__body or a card with its own top/bottom
     margin trim; without this, the first heading still carries its 1rem
     top margin and looks like a gap above the content. */
  .body-doc > :first-child {
    margin-top: 0;
  }

  .body-doc > :last-child {
    margin-bottom: 0;
  }

  .front-matter {
    margin: 0 0 1rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--panel);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>

