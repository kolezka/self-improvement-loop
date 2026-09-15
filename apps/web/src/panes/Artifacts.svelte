<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";

  interface Scorecard {
    uses_30d: number;
    helpful: number;
    misfired: number;
    human_good: number;
    human_bad: number;
  }

  interface InventoryRow {
    pattern: string;
    artifact_type: string;
    served_by: string | null;
    status: string;
    reflections: number;
    scorecard: Scorecard | null;
  }

  interface Lesson {
    pattern: string;
    text: string;
  }

  let rows = $state<InventoryRow[]>([]);
  let lessons = $state<Lesson[]>([]);
  let refInput = $state("");
  let noteInput = $state("");
  let vote = $state<"good" | "bad">("good");

  async function loadInventory() {
    try {
      rows = (await call("router.inventory", { world: appState.world })) as InventoryRow[];
    } catch (e) {
      toast(`could not load inventory: ${(e as Error).message}`);
      return;
    }
    try {
      lessons = (await call("lessons.list", { world: appState.world })) as Lesson[];
    } catch {
      lessons = [];
    }
  }

  async function rebuild() {
    try {
      const res = (await call("artifacts.rebuild", { world: appState.world })) as { path: string };
      toast(`scorecards rebuilt: ${res.path}`, "ok");
      await loadInventory();
    } catch (e) {
      toast(`could not rebuild: ${(e as Error).message}`);
    }
  }

  async function retire(pattern: string) {
    if (!window.confirm(`Retire ${pattern}? This cannot be undone from the UI.`)) return;
    try {
      await call("router.retire", { world: appState.world, pattern, confirm: true });
      toast(`${pattern} retired`, "ok");
      await loadInventory();
    } catch (e) {
      toast(`could not retire ${pattern}: ${(e as Error).message}`);
    }
  }

  async function recordFeedback() {
    try {
      await call("feedback.add", { world: appState.world, ref: refInput.trim(), vote, note: noteInput });
      toast("feedback recorded", "ok");
      refInput = "";
      noteInput = "";
      await loadInventory();
    } catch (e) {
      toast(`could not record feedback: ${(e as Error).message}`);
    }
  }

  onMount(loadInventory);
</script>

<h2>Artifacts</h2>
<div class="actions">
  <button onclick={loadInventory}>Refresh</button>
  <button onclick={rebuild}>Rebuild scorecards</button>
</div>

<table>
  <thead>
    <tr>
      <th>pattern</th>
      <th>type</th>
      <th>served_by</th>
      <th>status</th>
      <th>reflections</th>
      <th>uses_30d</th>
      <th>helpful/misfired</th>
      <th>human good/bad</th>
      <th>actions</th>
    </tr>
  </thead>
  <tbody>
    {#each rows as row}
      <tr>
        <td>{row.pattern}</td>
        <td>{row.artifact_type}</td>
        <td>{row.served_by ?? "-"}</td>
        <td>{row.status}</td>
        <td>{row.reflections}</td>
        {#if row.scorecard}
          <td>{row.scorecard.uses_30d}</td>
          <td>{row.scorecard.helpful}/{row.scorecard.misfired}</td>
          <td>{row.scorecard.human_good}/{row.scorecard.human_bad}</td>
        {:else}
          <td class="muted">-</td>
          <td class="muted">-</td>
          <td class="muted">-</td>
        {/if}
        <td><button class="danger" onclick={() => retire(row.pattern)}>Retire</button></td>
      </tr>
    {/each}
  </tbody>
</table>

<h3>Lessons in flight</h3>
<ul class="list">
  {#if lessons.length === 0}
    <li class="muted">none pending</li>
  {/if}
  {#each lessons as l}
    <li><strong>{l.pattern}</strong>: {l.text}</li>
  {/each}
</ul>

<h3>Record human feedback</h3>
<div class="actions">
  <input placeholder="skill:my-pattern" bind:value={refInput} />
  <select bind:value={vote}>
    <option value="good">good</option>
    <option value="bad">bad</option>
  </select>
  <input placeholder="note (optional)" bind:value={noteInput} />
  <button onclick={recordFeedback}>Record</button>
</div>
