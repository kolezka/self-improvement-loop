<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import Drawer from "../components/Drawer.svelte";
  import { canRetire, LIVE_STATUSES } from "../lib/artifact-actions.ts";
  import { filterLessons, groupByPattern } from "../lib/lessons.ts";
  import { appState, toast } from "../lib/state.svelte.ts";
  import type { PreviewResult, VerifyResult } from "../lib/api-types.ts";

  interface RateWindow {
    sessions: number;
    hits: number;
    rate: number | null;
  }

  interface Scorecard {
    uses_30d: number;
    helpful: number;
    misfired: number;
    recurrence_30d?: number;
    human_good: number;
    human_bad: number;
    proposal: string;
    reason: string;
    rate_baseline?: RateWindow | null;
    rate_since_promotion?: RateWindow | null;
    rate_since_revision?: RateWindow | null;
  }

  interface InventoryRow {
    pattern: string;
    artifact_type: string;
    served_by: string | null;
    status: string;
    reflections: number;
    scorecard: Scorecard | null;
    origin?: string;
  }

  interface Lesson {
    pattern: string;
    text: string;
  }

  let rows = $state<InventoryRow[]>([]);
  let lessons = $state<Lesson[]>([]);
  let loaded = $state(false);
  let refInput = $state("");
  let noteInput = $state("");
  let vote = $state<"good" | "bad">("good");
  let lessonQuery = $state("");
  let allLessonsOpen = $state(false);

  const liveCount = $derived(rows.filter((row) => LIVE_STATUSES.includes(row.status)).length);
  const filteredLessons = $derived(filterLessons(lessons, lessonQuery));
  const lessonGroups = $derived(groupByPattern(filteredLessons));
  const visibleLessonGroups = $derived(lessonGroups.slice(0, 8));

  function statusChipClass(status: string): string {
    if (LIVE_STATUSES.includes(status)) return "chip ok";
    if (status === "staged") return "chip accent";
    return "chip";
  }

  function votesText(card: Scorecard): string {
    return `${card.human_good} good, ${card.human_bad} bad`;
  }

  // "12/34 (35%)", or "n/a (<sessions> sessions)" below observe_min_sessions,
  // where rate is null. Missing altogether reads the same as zero sessions.
  function formatRate(w: RateWindow | null | undefined): string {
    if (!w) return "n/a (0 sessions)";
    if (w.rate === null) return `n/a (${w.sessions} sessions)`;
    return `${w.hits}/${w.sessions} (${Math.round(w.rate * 100)}%)`;
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
    } catch (e) {
      toast(`Could not load lessons: ${(e as Error).message}`);
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

  let previewOpen = $state(false);
  let previewLoading = $state(false);
  let previewData = $state<PreviewResult | null>(null);
  let previewError = $state<string | null>(null);

  async function openPreview(pattern: string) {
    previewOpen = true;
    previewLoading = true;
    previewData = null;
    previewError = null;
    try {
      previewData = (await call("artifacts.preview", { world: appState.world, pattern })) as PreviewResult;
    } catch (e) {
      previewError = (e as Error).message;
    } finally {
      previewLoading = false;
    }
  }

  let verifyOpen = $state(false);
  let verifyLoading = $state(false);
  let verifyData = $state<VerifyResult | null>(null);
  let verifyError = $state<string | null>(null);
  // The pattern the open verify result is about, so Rehome never fires
  // against a different row than the one the operator is looking at.
  let verifyPattern = $state<string | null>(null);

  async function openVerify(pattern: string) {
    verifyOpen = true;
    verifyLoading = true;
    verifyData = null;
    verifyError = null;
    verifyPattern = pattern;
    try {
      verifyData = (await call("artifacts.verify", { world: appState.world, pattern })) as VerifyResult;
    } catch (e) {
      verifyError = (e as Error).message;
    } finally {
      verifyLoading = false;
    }
  }

  const verifyUpgradeType = $derived.by((): string | null => {
    const tc = verifyData?.type_check;
    return tc && "upgrade" in tc && tc.upgrade ? tc.router_type : null;
  });

  async function rehomeFromVerify() {
    const pattern = verifyPattern;
    const toType = verifyUpgradeType;
    if (!pattern || !toType) return;
    if (!window.confirm(`Re-home ${pattern} to ${toType}? The move is staged for review, not applied yet.`)) return;
    try {
      await call("router.rehome", { world: appState.world, pattern, artifact_type: toType, confirm: toType === "none" });
      toast(`${pattern}: re-home to ${toType} staged. Accept it in Review to apply the move.`, "ok");
      verifyOpen = false;
      await loadInventory();
    } catch (e) {
      toast(`Could not re-home ${pattern}: ${(e as Error).message}`);
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
              <th scope="col" class="num">Recurred, 30 days</th>
              <th scope="col">Rate, baseline</th>
              <th scope="col">Rate, since promotion</th>
              <th scope="col">Rate, since revision</th>
              <th scope="col">Proposal</th>
              <th scope="col">Reason</th>
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
                  <td class="num">{row.scorecard.recurrence_30d ?? 0}</td>
                  <td class="mono">{formatRate(row.scorecard.rate_baseline)}</td>
                  <td class="mono">{formatRate(row.scorecard.rate_since_promotion)}</td>
                  <td class="mono">{formatRate(row.scorecard.rate_since_revision)}</td>
                  <td>{row.scorecard.proposal}</td>
                  <td>{row.scorecard.reason}</td>
                {:else}
                  <td class="num muted">-</td>
                  <td class="num muted">-</td>
                  <td class="num muted">-</td>
                  <td class="muted">-</td>
                  <td class="num muted">-</td>
                  <td class="muted">-</td>
                  <td class="muted">-</td>
                  <td class="muted">-</td>
                  <td class="muted">-</td>
                  <td class="muted">-</td>
                {/if}
                <td>
                  <div class="row-actions">
                    <button class="small" onclick={() => openPreview(row.pattern)}>Preview</button>
                    {#if LIVE_STATUSES.includes(row.status)}
                      <button class="small" onclick={() => openVerify(row.pattern)}>Verify</button>
                    {/if}
                    {#if canRetire(row)}
                      <button class="small danger" onclick={() => retire(row.pattern)}>Retire</button>
                    {/if}
                  </div>
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
  <div class="panel__body lessons-card__body">
    {#if lessons.length === 0}
      <div class="empty">
        <strong>Nothing waiting.</strong>
        A lesson is queued here when a pattern has advice for you, and it clears once your next session picks it up.
      </div>
    {:else}
      <div class="field lessons-search">
        <label for="lesson-search">Search lessons</label>
        <input id="lesson-search" type="search" placeholder="Pattern or lesson text" bind:value={lessonQuery} />
      </div>
      {#if lessonGroups.length === 0}
        <p class="muted">No lesson matches "{lessonQuery.trim()}".</p>
      {:else}
        <ul class="list">
          {#each visibleLessonGroups as group (group.pattern)}
            <li>
              <div class="row__title">
                <span class="mono">{group.pattern}</span>
                <span class="muted">· {group.items.length} lessons</span>
              </div>
              <p class="lesson-text lesson-text--clamped">{group.items[0]!.text}</p>
            </li>
          {/each}
        </ul>
        {#if lessonGroups.length > visibleLessonGroups.length}
          <div class="actions lessons-actions">
            <button onclick={() => (allLessonsOpen = true)}>Show all {lessonGroups.length}</button>
          </div>
        {/if}
      {/if}
    {/if}
  </div>
</div>

<Drawer bind:open={allLessonsOpen} title="Lessons waiting for delivery">
  <div class="field lessons-search">
    <label for="all-lesson-search">Search lessons</label>
    <input id="all-lesson-search" type="search" placeholder="Pattern or lesson text" bind:value={lessonQuery} />
  </div>
  {#if lessonGroups.length === 0}
    <p class="muted">No lesson matches "{lessonQuery.trim()}".</p>
  {:else}
    <ul class="list">
      {#each lessonGroups as group (group.pattern)}
        <li>
          <div class="row__title">
            <span class="mono">{group.pattern}</span>
            <span class="muted">· {group.items.length} lessons</span>
          </div>
          {#each group.items as lesson}
            <p class="lesson-text">{lesson.text}</p>
          {/each}
        </li>
      {/each}
    </ul>
  {/if}
</Drawer>

<Drawer bind:open={previewOpen} title="Preview">
  {#if previewLoading}
    <p class="muted">Loading the live artifact.</p>
  {:else if previewError}
    <div class="notice error">Could not load the preview: {previewError}</div>
  {:else if previewData}
    <div class="preview-meta">
      <span class="chip">{previewData.artifact_type}</span>
      <span class="badge mono">{previewData.path}</span>
      <span class={previewData.live ? "chip ok" : "chip warn"}>{previewData.live ? "live" : "not active"}</span>
    </div>
    <pre class="file">{previewData.body}</pre>
  {/if}
</Drawer>

<Drawer bind:open={verifyOpen} title="Verify">
  {#if verifyLoading}
    <p class="muted">Running the offline checks and the router probe.</p>
  {:else if verifyError}
    <div class="notice error">Could not verify: {verifyError}</div>
  {:else if verifyData}
    <ul class="check-list">
      <li>
        <span class={verifyData.offline.exists ? "chip ok" : "chip err"}>{verifyData.offline.exists ? "pass" : "fail"}</span>
        <span>Artifact exists</span>
      </li>
      <li>
        <span class={verifyData.offline.live.live ? "chip ok" : "chip err"}>{verifyData.offline.live.live ? "pass" : "fail"}</span>
        <span>Live: {verifyData.offline.live.detail}</span>
      </li>
      <li>
        <span class={verifyData.offline.lint.length === 0 ? "chip ok" : "chip err"}>{verifyData.offline.lint.length === 0 ? "pass" : "fail"}</span>
        <span>Lint: {verifyData.offline.lint.length === 0 ? "clean" : verifyData.offline.lint.join("; ")}</span>
      </li>
      {#if verifyData.offline.gate}
        <li>
          <span class={verifyData.offline.gate.fires ? "chip ok" : "chip err"}>{verifyData.offline.gate.fires ? "pass" : "fail"}</span>
          <span>Gate: {verifyData.offline.gate.verdict}</span>
        </li>
      {/if}
    </ul>
    <div class="panel__head">
      <h3>Router verdict</h3>
    </div>
    {#if "error" in verifyData.type_check}
      <div class="notice error">Type check failed: {verifyData.type_check.error}</div>
    {:else if "skipped" in verifyData.type_check}
      <p class="muted">Skipped: {verifyData.type_check.skipped}</p>
    {:else}
      <p>
        Currently <strong>{verifyData.type_check.current_type}</strong>; the router would pick
        <strong>{verifyData.type_check.router_type}</strong>.
      </p>
      <p class="muted">{verifyData.type_check.reason}</p>
      {#if verifyUpgradeType}
        <div class="toolbar">
          <button class="primary" onclick={rehomeFromVerify}>Rehome to {verifyUpgradeType}</button>
        </div>
      {/if}
    {/if}
  {/if}
</Drawer>

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
  .verdict {
    max-width: 16rem;
  }

  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .preview-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .file {
    max-height: 26rem;
    margin: 0;
    overflow: auto;
    padding: 0.75rem 0.85rem;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--panel);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .check-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0 0 1rem;
    padding: 0;
    list-style: none;
  }

  .check-list li {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
</style>
