<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";
  import WorkerStatus from "../components/WorkerStatus.svelte";

  interface RunReport {
    world: string;
    dry_run: boolean;
    staged: string[];
    merged: string[];
    gated_out: Record<string, string>;
    dropped: Record<string, number>;
    started: string;
    finished: string | null;
    error: string | null;
  }

  interface RunSummary {
    reflected: string[];
    failed: string[];
    skipped: string[];
    curriculum: Record<string, RunReport>;
    duration_s: number;
    locked?: boolean;
  }

  interface WorkerStatusData {
    lock_held: boolean;
    lock_pid: number | null;
    pending: number;
    done: number;
    failed: number;
    last_run: string | null;
    last_summary: RunSummary | null;
    last_curriculum: Record<string, string>;
  }

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

  const ACTION_ORDER = ["promote", "refine", "retire-candidate", "over-cap", "below-threshold", "done"];

  let status = $state<WorkerStatusData | null>(null);
  let plan = $state<PlanReport | null>(null);

  const grouped = $derived.by((): PlanGroup[] => {
    if (!plan) return [];
    const byKind = new Map<string, PlanAction[]>();
    for (const action of plan.actions) {
      const bucket = byKind.get(action.action) ?? [];
      bucket.push(action);
      byKind.set(action.action, bucket);
    }
    return ACTION_ORDER.filter((kind) => byKind.has(kind)).map((kind) => ({ kind, actions: byKind.get(kind)! }));
  });

  async function refresh() {
    try {
      status = (await call("worker.status", {})) as WorkerStatusData;
    } catch (e) {
      status = null;
      toast(`could not load worker status: ${(e as Error).message}`);
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

  async function showPlan() {
    try {
      plan = (await call("curriculum.plan", { world: appState.world })) as PlanReport;
    } catch (e) {
      toast(`could not load plan: ${(e as Error).message}`);
    }
  }

  onMount(refresh);
</script>

<h2>Loop</h2>
<div class="card">
  <h3>Worker status</h3>
  <WorkerStatus {status} />
</div>

<div class="card">
  <h3>Curriculum plan (dry run)</h3>
  {#if plan}
    <p class="muted">threshold: {plan.threshold}</p>
    {#if plan.actions.length === 0}
      <p class="muted">nothing to plan</p>
    {/if}
    {#each grouped as group}
      <h4>{group.kind} ({group.actions.length})</h4>
      <ul class="list">
        {#each group.actions as a}
          <li>
            <strong>{a.pattern}</strong>
            <span class="muted">count {a.count}, watermark {a.watermark}</span>
            {#if a.reason}<div class="muted">{a.reason}</div>{/if}
          </li>
        {/each}
      </ul>
    {/each}
  {:else}
    <p class="muted">not loaded yet</p>
  {/if}
</div>

<div class="actions">
  <button onclick={refresh}>Refresh</button>
  <button class="primary" onclick={runWorker}>Run worker now</button>
  <button onclick={runCurriculum}>Run curriculum</button>
  <button onclick={showPlan}>Show plan</button>
</div>
