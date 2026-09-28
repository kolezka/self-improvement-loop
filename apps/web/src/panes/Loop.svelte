<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import type { HistorySeries, WorkerRun } from "../lib/api-types.ts";
  import { appState, toast } from "../lib/state.svelte.ts";
  import { formatTime } from "../lib/format.ts";
  import WorkerStatus from "../components/WorkerStatus.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import LineChart from "../components/charts/LineChart.svelte";
  import type { WorkerStatusData } from "../lib/worker-types.ts";

  interface PlanAction {
    pattern: string;
    count: number;
    watermark: number;
    action: string;
    sources: string[];
    reason: string;
  }

  interface PlanReport {
    world: string;
    threshold: number;
    actions: PlanAction[];
  }

  interface PlanGroup {
    kind: string;
    actions: PlanAction[];
  }

  type PlanState = { status: "loading" } | { status: "ok"; data: PlanReport } | { status: "error"; error: string };
  type RecentRunsState = { status: "loading" } | { status: "ok"; runs: WorkerRun[] } | { status: "error"; error: string };
  type HistoryState = { status: "loading" } | { status: "ok"; data: HistorySeries } | { status: "error"; error: string };

  const ACTION_ORDER = ["promote", "refine", "retire-candidate", "over-cap", "below-threshold", "done"];
  const RUN_TAIL_LINES = 2000;
  const MAX_RECENT_RUNS = 10;
  const MINI_HISTORY_DAYS = 14;
  const POLL_INTERVAL_MS = 3000;
  const POLL_TIMEOUT_MS = 60_000;

  let status = $state<WorkerStatusData | null>(null);
  let plan = $state<PlanState>({ status: "loading" });
  let recentRuns = $state<RecentRunsState>({ status: "loading" });
  let history = $state<HistoryState>({ status: "loading" });
  let runningOnce = $state(false);
  let destroyed = false;

  const grouped = $derived.by((): PlanGroup[] => {
    if (plan.status !== "ok") return [];
    const byKind = new Map<string, PlanAction[]>();
    for (const action of plan.data.actions) {
      const bucket = byKind.get(action.action) ?? [];
      bucket.push(action);
      byKind.set(action.action, bucket);
    }
    return ACTION_ORDER.filter((kind) => byKind.has(kind)).map((kind) => ({ kind, actions: byKind.get(kind)! }));
  });

  // "retire-candidate" -> "Retire candidate": sentence case, no raw hyphenated kind in the UI.
  function actionLabel(kind: string): string {
    const words = kind.replace(/-/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  async function refresh() {
    try {
      status = (await call("worker.status", {})) as WorkerStatusData;
    } catch (e) {
      status = null;
      toast(`could not load worker status: ${(e as Error).message}`);
    }
  }

  async function loadPlan() {
    plan = { status: "loading" };
    try {
      const data = (await call("curriculum.plan", { world: appState.world })) as PlanReport;
      plan = { status: "ok", data };
    } catch (e) {
      plan = { status: "error", error: (e as Error).message };
    }
  }

  /** worker.log is JSON per line; a run marker looks like
   * {"ts":...,"action":"run","reflected":n,"failed":n,"skipped":n}. Any other
   * shape or a broken line is dropped, not counted as a run with zeros. */
  function parseWorkerRunLine(raw: string): WorkerRun | null {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (obj.action !== "run" || typeof obj.ts !== "string") return null;
      if (typeof obj.reflected !== "number" || typeof obj.failed !== "number" || typeof obj.skipped !== "number") return null;
      return { ts: obj.ts, reflected: obj.reflected, failed: obj.failed, skipped: obj.skipped };
    } catch {
      return null;
    }
  }

  async function loadRecentRuns() {
    recentRuns = { status: "loading" };
    try {
      const res = (await call("logs.tail", { name: "worker", lines: RUN_TAIL_LINES })) as { lines: string[] };
      const runs = res.lines.map(parseWorkerRunLine).filter((r): r is WorkerRun => r !== null);
      recentRuns = { status: "ok", runs: runs.slice(-MAX_RECENT_RUNS).reverse() };
    } catch (e) {
      recentRuns = { status: "error", error: (e as Error).message };
    }
  }

  async function loadHistory() {
    history = { status: "loading" };
    try {
      const data = (await call("history.series", { world: appState.world, days: MINI_HISTORY_DAYS })) as HistorySeries;
      history = { status: "ok", data };
    } catch (e) {
      history = { status: "error", error: (e as Error).message };
    }
  }

  async function runWorker() {
    try {
      const res = (await call("loop.run", { world: appState.world })) as { pid: number; log: string };
      toast(`worker started (pid ${res.pid}), log at ${res.log}`, "ok");
    } catch (e) {
      toast(`could not start worker: ${(e as Error).message}`);
    }
  }

  async function runCurriculum() {
    try {
      const res = (await call("curriculum.run", { world: appState.world })) as { pid: number; log: string };
      toast(`curriculum started (pid ${res.pid}), log at ${res.log}`, "ok");
    } catch (e) {
      toast(`could not start curriculum: ${(e as Error).message}`);
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function pollUntilRun(): Promise<void> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline && !destroyed) {
      await sleep(POLL_INTERVAL_MS);
      if (destroyed) return;
      await refresh();
      if (status?.last_run) {
        await Promise.all([loadRecentRuns(), loadHistory()]);
        return;
      }
    }
  }

  async function runOnceNow() {
    runningOnce = true;
    try {
      const res = (await call("loop.run", { world: appState.world })) as { pid: number; log: string };
      toast(`worker started (pid ${res.pid}), log at ${res.log}`, "ok");
      await pollUntilRun();
    } catch (e) {
      toast(`could not start worker: ${(e as Error).message}`);
    } finally {
      runningOnce = false;
    }
  }

  onMount(() => {
    refresh();
    loadPlan();
    loadRecentRuns();
    loadHistory();
  });

  onDestroy(() => {
    destroyed = true;
  });
</script>

<div class="toolbar">
  <button class="primary" onclick={runWorker}>Run worker</button>
  <button onclick={runCurriculum}>Run curriculum</button>
  <button onclick={refresh}>Refresh</button>
</div>

{#if status && !status.last_run}
  <div class="empty cta">
    <strong>The worker has not run yet.</strong>
    Run it once to see reflections, trends and the curriculum plan fill in below.
    <button class="primary" onclick={runOnceNow} disabled={runningOnce}>{runningOnce ? "Starting..." : "Run once now"}</button>
  </div>
{/if}

<WorkerStatus {status} />

<div class="panel">
  <div class="panel__head">
    <h3>Recent runs</h3>
  </div>
  <div class="panel__body">
    {#if recentRuns.status === "loading"}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th class="num">Reflected</th>
              <th class="num">Failed</th>
              <th class="num">Skipped</th>
            </tr>
          </thead>
          <tbody>
            {#each Array.from({ length: 4 }) as _, i (i)}
              <tr>
                <td><Skeleton width="11ch" /></td>
                <td class="num"><Skeleton width="2ch" /></td>
                <td class="num"><Skeleton width="2ch" /></td>
                <td class="num"><Skeleton width="2ch" /></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if recentRuns.status === "error"}
      <p class="notice error">Could not load recent runs: {recentRuns.error}</p>
    {:else if recentRuns.runs.length === 0}
      <div class="empty">
        <strong>No worker run recorded yet.</strong>
      </div>
    {:else}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th class="num">Reflected</th>
              <th class="num">Failed</th>
              <th class="num">Skipped</th>
            </tr>
          </thead>
          <tbody>
            {#each recentRuns.runs as run (run.ts)}
              <tr>
                <td>{formatTime(run.ts)}</td>
                <td class="num">{run.reflected}</td>
                <td class:error-text={run.failed > 0} class="num">{run.failed}</td>
                <td class="num">{run.skipped}</td>
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
    <h3>14-day trend</h3>
  </div>
  <div class="panel__body">
    {#if history.status === "loading"}
      <div class="grid">
        <Skeleton height="80px" />
        <Skeleton height="80px" />
        <Skeleton height="80px" />
      </div>
    {:else if history.status === "error"}
      <p class="notice error">Could not load history: {history.error}</p>
    {:else}
      <div class="grid">
        <LineChart title="Worker runs" height={80} series={[{ label: "Runs", tone: "muted", points: history.data.series.worker_runs }]} />
        <LineChart title="Reflections" height={80} series={[{ label: "Reflections", tone: "accent", points: history.data.series.reflections }]} />
        <LineChart title="Sessions failed" height={80} series={[{ label: "Failed", tone: "err", points: history.data.series.sessions_failed }]} />
      </div>
    {/if}
  </div>
</div>

<div class="panel">
  <div class="panel__head">
    <h3>Curriculum plan</h3>
    {#if plan.status === "ok"}
      <span class="chip">threshold <strong>{plan.data.threshold}</strong></span>
    {/if}
  </div>
  <div class="panel__body">
    {#if plan.status === "loading"}
      <ul class="list">
        {#each Array.from({ length: 3 }) as _, i (i)}
          <li><Skeleton width="60%" /></li>
        {/each}
      </ul>
    {:else if plan.status === "error"}
      <p class="notice error">Could not load the curriculum plan: {plan.error}</p>
    {:else if plan.data.actions.length === 0}
      <div class="empty">
        <strong>Nothing to plan.</strong>
        No pattern crossed a curriculum threshold this pass.
      </div>
    {:else}
      {#each grouped as group (group.kind)}
        <div class="section-title">
          {actionLabel(group.kind)} <span class="chip"><strong>{group.actions.length}</strong></span>
        </div>
        <ul class="list">
          {#each group.actions as a (a.pattern)}
            <li>
              <div class="row__title">
                <span class="mono grow">{a.pattern}</span>
                <span class="chip">count <strong>{a.count}</strong></span>
                <span class="chip">watermark <strong>{a.watermark}</strong></span>
              </div>
              {#if a.reason}<div class="muted">{a.reason}</div>{/if}
            </li>
          {/each}
        </ul>
      {/each}
    {/if}
  </div>
</div>

<style>
  .cta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 1rem;
  }

  .cta strong {
    display: block;
    width: 100%;
  }
</style>
