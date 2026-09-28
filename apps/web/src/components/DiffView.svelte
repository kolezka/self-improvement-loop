<script lang="ts">
  import { parseDiff } from "../lib/markdown.ts";

  let { text = "" }: { text?: string } = $props();
  const lines = $derived(parseDiff(text));
  let wrap = $state(true);
</script>

<div class="diff-view">
  <div class="diff-view__bar">
    <label class="control">
      <input type="checkbox" bind:checked={wrap} />
      <span>Wrap lines</span>
    </label>
  </div>
  <pre class="diff" class:nowrap={!wrap}>{#each lines as line}<span class={line.cls}>{line.text + "\n"}</span>{/each}</pre>
</div>

<style>
  .diff-view__bar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 0.35rem;
  }

  .diff-view__bar .control {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--fs-xs);
    color: var(--muted);
  }

  .diff.nowrap {
    white-space: pre;
    overflow-x: auto;
  }

  /* Same colours as the shared pre.diff rule, plus a dimmed hunk header: a
     line of @@ markers reads as structure, not content, and full accent
     colour competed with the add/remove lines for attention. */
  .add {
    color: var(--ok);
  }

  .del {
    color: var(--err);
  }

  .hunk {
    color: var(--muted);
    opacity: 0.85;
  }
</style>
