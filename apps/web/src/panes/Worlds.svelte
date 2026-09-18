<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";

  let editorText = $state("");
  let aliases = $state<Record<string, string>>({});
  let aliasesLoaded = $state(false);
  let newAlias = $state("");
  let newCanonical = $state("");

  const aliasRows = $derived(Object.entries(aliases));

  async function loadConfig() {
    try {
      const cfg = await call("config.get", {});
      editorText = JSON.stringify(cfg, null, 2);
    } catch (e) {
      toast(`Could not load config.yaml: ${(e as Error).message}`);
    }
  }

  async function saveConfig() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(editorText);
    } catch (e) {
      toast(`This is not valid JSON, fix it and save again: ${(e as Error).message}`);
      return;
    }
    try {
      await call("config.set", { config: parsed });
      toast("config.yaml saved", "ok");
      await loadConfig();
    } catch (e) {
      toast(`Could not save config.yaml: ${(e as Error).message}`);
    }
  }

  async function loadAliases() {
    try {
      aliases = (await call("aliases.get", { world: appState.world })) as Record<string, string>;
    } catch (e) {
      toast(`Could not load the aliases: ${(e as Error).message}`);
    } finally {
      aliasesLoaded = true;
    }
  }

  async function removeAlias(alias: string) {
    const rest = { ...aliases };
    delete rest[alias];
    try {
      await call("aliases.set", { world: appState.world, aliases: rest });
      await loadAliases();
    } catch (e) {
      toast(`Could not remove ${alias}: ${(e as Error).message}`);
    }
  }

  async function addAlias() {
    const alias = newAlias.trim();
    const canonical = newCanonical.trim();
    if (!alias || !canonical) {
      toast("Fill in both the alias and the canonical pattern before adding it");
      return;
    }
    const merged = { ...aliases, [alias]: canonical };
    try {
      await call("aliases.set", { world: appState.world, aliases: merged });
      newAlias = "";
      newCanonical = "";
      await loadAliases();
    } catch (e) {
      toast(`Could not save ${alias}: ${(e as Error).message}`);
    }
  }

  onMount(() => {
    loadConfig();
    loadAliases();
  });
</script>

<div class="panel">
  <div class="panel__head">
    <h3>config.yaml</h3>
    <span class="spacer"></span>
    <span class="muted">Applies to every world</span>
  </div>
  <div class="panel__body">
    <div class="field editor">
      <label for="config-editor">Configuration, JSON view</label>
      <textarea id="config-editor" spellcheck="false" bind:value={editorText}></textarea>
      <span class="hint">Edited as JSON. It is parsed and validated before it is written back to config.yaml.</span>
    </div>
    <div class="toolbar">
      <button onclick={loadConfig}>Reload</button>
      <button class="primary" onclick={saveConfig}>Save config</button>
    </div>
  </div>
</div>

<div class="panel">
  <div class="panel__head">
    <h3>Pattern aliases</h3>
    <span class="badge">{appState.world}</span>
    {#if aliasRows.length > 0}
      <span class="chip"><strong>{aliasRows.length}</strong> in use</span>
    {/if}
  </div>
  <div class="panel__body">
    {#if !aliasesLoaded}
      <p class="muted">Loading the aliases for {appState.world}.</p>
    {:else if aliasRows.length === 0}
      <div class="empty">
        <strong>No aliases yet.</strong>
        An alias folds one pattern name into another, so reflections filed under a near duplicate name count towards the canonical pattern. Add the first pair below.
      </div>
    {:else}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Alias</th>
              <th scope="col">Canonical pattern</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each aliasRows as [alias, canonical] (alias)}
              <tr>
                <td class="mono">{alias}</td>
                <td class="mono">{canonical}</td>
                <td>
                  <button class="small danger" onclick={() => removeAlias(alias)}>Remove</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <div class="alias-add">
      <div class="field">
        <label for="alias-name">Alias</label>
        <input id="alias-name" bind:value={newAlias} />
        <span class="hint">The name to fold away</span>
      </div>
      <div class="field">
        <label for="alias-canonical">Canonical pattern</label>
        <input id="alias-canonical" bind:value={newCanonical} />
        <span class="hint">The name that keeps the count</span>
      </div>
      <button class="primary" onclick={addAlias}>Add alias</button>
    </div>
  </div>
</div>

<style>
  /* The editor is the content of its panel, so it drops the .field measure. */
  .field.editor {
    max-width: none;
  }

  .field.editor textarea {
    width: 100%;
    min-height: 22rem;
    resize: vertical;
  }

  .alias-add {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: 0.9rem;
  }

  .alias-add .field {
    min-width: 13rem;
    max-width: 18rem;
    margin-bottom: 0;
  }

  /* Line the button up with the inputs rather than the labels above them. */
  .alias-add button {
    margin-top: 1.35rem;
  }
</style>
