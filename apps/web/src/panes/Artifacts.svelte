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

  // A promoted artifact is the one the engine actually serves; everything else
  // is either still waiting at the gate or already out of rotation.
  const LIVE_STATUSES = ["promoted", "active", "live"];

  let rows = $state<InventoryRow[]>([]);
  let lessons = $state<Lesson[]>([]);
  let loaded = $state(false);
  let refInput = $state("");
  let noteInput = $state("");
  let vote = $state<"good" | "bad">("good");

  const liveCount = $derived(rows.filter((row) => LIVE_STATUSES.includes(row.status)).length);

  function statusChipClass(status: string): string {
    if (LIVE_STATUSES.includes(status)) return "chip ok";
    if (status === "staged") return "chip accent";
    return "chip";
  }

  function votesText(card: Scorecard): string {
    return `${card.human_good} good, ${card.human_bad} bad`;
  }

  async function loadInventory() {
    try {
      rows = (await call("router.inventory", { world: appState.world })) as InventoryRow[];
    } catch (e) {
      toast(`Could not load the inventory: ${(e as Error).message}`);
      return;
    } finally {
      loaded = true;
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
      toast(`Scorecards rebuilt: ${res.path}`, "ok");
      await loadInventory();
    } catch (e) {
      toast(`Could not rebuild the scorecards: ${(e as Error).message}`);
    }
  }

  async function retire(pattern: string) {
    if (!window.confirm(`Retire ${pattern}? The retirement is staged for review, not applied yet.`)) return;
    try {
      await call("router.retire", { world: appState.world, pattern, confirm: true });
      // Staged only: the artifact keeps serving until the branch is accepted in
      // the review queue.
      toast(`${pattern}: retirement staged. Accept it in Review to remove the artifact.`, "ok");
      await loadInventory();
    } catch (e) {
      toast(`Could not retire ${pattern}: ${(e as Error).message}`);
    }
  }

  async function recordFeedback() {
    try {
      await call("feedback.add", { world: appState.world, ref: refInput.trim(), vote, note: noteInput });
      toast("Feedback recorded", "ok");
      refInput = "";
      noteInput = "";
      await loadInventory();
    } catch (e) {
      toast(`Could not record feedback: ${(e as Error).message}`);
    }
  }

  onMount(loadInventory);
</script>

<div class="toolbar">
  <button onclick={loadInventory}>Refresh</button>
  <button onclick={rebuild}>Rebuild scorecards</button>
</div>

<div class="panel">
  <div class="panel__head">
    <h3>Promoted artifacts</h3>
    {#if loaded && rows.length > 0}
      <span class="chip"><strong>{rows.length}</strong> in the ledger</span>
      <span class="chip ok"><strong>{liveCount}</strong> serving</span>
    {/if}
  </div>
  <div class="panel__body">
    {#if !loaded}
      <p class="muted">Loading the inventory for {appState.world}.</p>
    {:else if rows.length === 0}
      <div class="empty">
        <strong>No artifacts yet.</strong>
        Accept a proposal in Review and it appears here with its scorecard.
      </div>
    {:else}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Pattern</th>
              <th scope="col">Type</th>
              <th scope="col">Served by</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Reflections</th>
              <th scope="col" class="num">Uses, 30 days</th>
              <th scope="col" class="num">Helpful</th>
              <th scope="col" class="num">Misfired</th>
              <th scope="col">Human votes</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.pattern)}
              <tr>
                <td class="mono">{row.pattern}</td>
                <td>{row.artifact_type}</td>
                <td>
                  {#if row.served_by}
                    <span class="mono">{row.served_by}</span>
                  {:else}
                    <span class="muted">no file yet</span>
                  {/if}
                </td>
                <td><span class={statusChipClass(row.status)}>{row.status}</span></td>
                <td class="num">{row.reflections}</td>
                {#if row.scorecard}
                  <td class="num">{row.scorecard.uses_30d}</td>
                  <td class="num">{row.scorecard.helpful}</td>
                  <td class="num">{row.scorecard.misfired}</td>
                  <td>{votesText(row.scorecard)}</td>
                {:else}
                  <td class="num muted">-</td>
                  <td class="num muted">-</td>
                  <td class="num muted">-</td>
                  <td class="muted">-</td>
                {/if}
                <td>
                  <button class="small danger" onclick={() => retire(row.pattern)}>Retire</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>

<div class="panel">
  <div class="panel__head">
    <h3>Lessons waiting for delivery</h3>
    <span class="chip"><strong>{lessons.length}</strong> queued</span>
  </div>
  <div class="panel__body">
    {#if lessons.length === 0}
      <div class="empty">
        <strong>Nothing waiting.</strong>
        A lesson is queued here when a pattern has advice for you, and it clears once your next session picks it up.
      </div>
    {:else}
      <ul class="list">
        {#each lessons as lesson}
          <li>
            <div class="row__title"><span class="mono">{lesson.pattern}</span></div>
            <p class="lesson-text">{lesson.text}</p>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<div class="panel">
  <div class="panel__head">
    <h3>Record your own verdict</h3>
    <span class="spacer"></span>
    <span class="muted">Counts towards the scorecard for {appState.world}</span>
  </div>
  <div class="panel__body">
    <div class="field">
      <label for="feedback-ref">Artifact reference</label>
      <input id="feedback-ref" bind:value={refInput} />
      <span class="hint">for example skill:verify-callsites</span>
    </div>
    <div class="field verdict">
      <label for="feedback-vote">Verdict</label>
      <select id="feedback-vote" bind:value={vote}>
        <option value="good">Good, it helped</option>
        <option value="bad">Bad, it misfired</option>
      </select>
    </div>
    <div class="field">
      <label for="feedback-note">Note, optional</label>
      <input id="feedback-note" bind:value={noteInput} />
      <span class="hint">What happened, in one line. Stored with the vote.</span>
    </div>
    <div class="toolbar">
      <button class="primary" onclick={recordFeedback}>Record feedback</button>
    </div>
  </div>
</div>

<style>
  /* Lesson bodies are prose, so they get a reading measure the tables do not. */
  .lesson-text {
    margin: 0.15rem 0 0;
    max-width: 78ch;
  }

  .verdict {
    max-width: 16rem;
  }
</style>
