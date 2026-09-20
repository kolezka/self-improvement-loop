<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";
  import WorkerStatus from "../components/WorkerStatus.svelte";
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

<div class="toolbar">
  <button class="primary" onclick={runWorker}>Run worker</button>
  <button onclick={runCurriculum}>Run curriculum</button>
  <button onclick={showPlan}>Show plan</button>
  <button onclick={refresh}>Refresh</button>
</div>

<WorkerStatus {status} />

<div class="panel">
  <div class="panel__head">
    <h3>Curriculum plan</h3>
    {#if plan}
      <span class="chip">threshold <strong>{plan.threshold}</strong></span>
    {/if}
  </div>
  <div class="panel__body">
    {#if !plan}
      <div class="empty">
        <strong>Plan not loaded.</strong>
        The curriculum plan is a dry run: it shows what would be promoted, refined or retired without changing anything.
        Press "Show plan" to load it.
      </div>
    {:else if plan.actions.length === 0}
      <div class="empty">
        <strong>Nothing to plan.</strong>
        No pattern crossed a curriculum threshold this pass.
      </div>
    {:else}
      {#each grouped as group}
        <div class="section-title">
          {actionLabel(group.kind)} <span class="chip"><strong>{group.actions.length}</strong></span>
        </div>
        <ul class="list">
          {#each group.actions as a}
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
