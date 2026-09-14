<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";

  let editorText = $state("");
  let aliases = $state<Record<string, string>>({});
  let newAlias = $state("");
  let newCanonical = $state("");

  async function loadConfig() {
    try {
      const cfg = await call("config.get", {});
      editorText = JSON.stringify(cfg, null, 2);
    } catch (e) {
      toast(`could not load config.yaml: ${(e as Error).message}`);
    }
  }

  async function saveConfig() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(editorText);
    } catch (e) {
      toast(`not valid JSON: ${(e as Error).message}`);
      return;
    }
    try {
      await call("config.set", { config: parsed });
      toast("config.yaml saved", "ok");
      await loadConfig();
    } catch (e) {
      toast(`could not save: ${(e as Error).message}`);
    }
  }

  async function loadAliases() {
    try {
      aliases = (await call("aliases.get", { world: appState.world })) as Record<string, string>;
    } catch (e) {
      toast(`could not load aliases: ${(e as Error).message}`);
    }
  }

  async function removeAlias(alias: string) {
    const rest = { ...aliases };
    delete rest[alias];
    try {
      await call("aliases.set", { world: appState.world, aliases: rest });
      await loadAliases();
    } catch (e) {
      toast(`could not remove alias: ${(e as Error).message}`);
    }
  }

  async function addAlias() {
    const alias = newAlias.trim();
    const canonical = newCanonical.trim();
    if (!alias || !canonical) {
      toast("alias and canonical are both required");
      return;
    }
    const merged = { ...aliases, [alias]: canonical };
    try {
      await call("aliases.set", { world: appState.world, aliases: merged });
      newAlias = "";
      newCanonical = "";
      await loadAliases();
    } catch (e) {
      toast(`could not save alias: ${(e as Error).message}`);
    }
  }

  onMount(() => {
    loadConfig();
    loadAliases();
  });
</script>

<h2>Worlds</h2>

<div class="field">
  <label for="config-editor">config.yaml</label>
  <textarea id="config-editor" rows="18" style="width:100%;font:12px monospace" bind:value={editorText}></textarea>
</div>
<div class="actions">
  <button onclick={loadConfig}>Reload</button>
  <button class="primary" onclick={saveConfig}>Save</button>
</div>

<h3>Pattern aliases for {appState.world}</h3>
<table>
  <thead>
    <tr><th>alias</th><th>canonical</th><th></th></tr>
  </thead>
  <tbody>
    {#each Object.entries(aliases) as [alias, canonical]}
      <tr>
        <td>{alias}</td>
        <td>{canonical}</td>
        <td><button class="danger" onclick={() => removeAlias(alias)}>Remove</button></td>
      </tr>
    {/each}
  </tbody>
</table>
<div class="actions">
  <input placeholder="alias" bind:value={newAlias} />
  <input placeholder="canonical" bind:value={newCanonical} />
  <button onclick={addAlias}>Add</button>
</div>
