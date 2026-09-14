<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { toast } from "../lib/state.svelte.ts";

  const LOG_NAMES = ["hook", "worker", "web", "curriculum"] as const;

  let name = $state<string>(LOG_NAMES[0]);
  let lines = $state(200);
  let path = $state("");
  let output = $state("");

  async function load() {
    try {
      const result = (await call("logs.tail", { name, lines })) as { path: string; lines: string[] };
      path = result.path;
      output = result.lines.join("\n");
    } catch (e) {
      toast(`could not load log: ${(e as Error).message}`);
    }
  }

  onMount(load);
</script>

<h2>Logs</h2>
<div class="actions">
  <select bind:value={name}>
    {#each LOG_NAMES as n}
      <option value={n}>{n}</option>
    {/each}
  </select>
  <input type="number" style="width:6rem" bind:value={lines} />
  <button onclick={load}>Tail</button>
</div>
<p class="muted">{path}</p>
<pre>{output}</pre>
