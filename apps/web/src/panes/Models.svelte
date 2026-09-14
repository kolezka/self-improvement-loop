<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";

  interface WorldStatus {
    world: string;
    text: string;
  }

  let editorText = $state("");
  let statuses = $state<WorldStatus[]>([]);

  async function load() {
    try {
      const llm = await call("llm.get", {});
      editorText = JSON.stringify(llm, null, 2);
    } catch (e) {
      toast(`could not load llm.yaml: ${(e as Error).message}`);
    }
  }

  async function save() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(editorText);
    } catch (e) {
      toast(`not valid JSON: ${(e as Error).message}`);
      return;
    }
    try {
      await call("llm.set", { llm: parsed });
      toast("llm.yaml saved", "ok");
      await load();
    } catch (e) {
      toast(`could not save: ${(e as Error).message}`);
    }
  }

  async function checkAllWorlds() {
    const results: WorldStatus[] = [];
    for (const world of appState.worldNames) {
      try {
        const s = await call("llm.status", { world });
        results.push({ world, text: JSON.stringify(s, null, 2) });
      } catch (e) {
        results.push({ world, text: JSON.stringify({ error: (e as Error).message }, null, 2) });
      }
    }
    statuses = results;
  }

  onMount(load);
</script>

<h2>Models</h2>
<p class="muted">llm.yaml never carries a secret value here, only the env var name it reads from.</p>

<div class="field">
  <label for="llm-editor">llm.yaml</label>
  <textarea id="llm-editor" rows="16" style="width:100%;font:12px monospace" bind:value={editorText}></textarea>
</div>
<div class="actions">
  <button onclick={load}>Reload</button>
  <button class="primary" onclick={save}>Save</button>
</div>

<h3>Provider status by world</h3>
<div class="actions"><button onclick={checkAllWorlds}>Check all worlds</button></div>
<div>
  {#each statuses as s}
    <div class="card">
      <strong>{s.world}</strong>
      <pre>{s.text}</pre>
    </div>
  {/each}
</div>
