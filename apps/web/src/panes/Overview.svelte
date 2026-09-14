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

  // health.report() catches a throw from deps.worker.status() and reports it
  // as {error} instead, so the field is one or the other, never unknown.
  type WorkerHealth = WorkerStatusData | { error: string };

  interface Health {
    config_file: string;
    state_dir: string;
    plugin_root: string;
    worlds: string[];
    providers: Record<string, unknown>;
    worker: WorkerHealth;
  }

  let health = $state<Health | null>(null);
  let pendingCount = $state(0);
  let reviewCount = $state(0);
  let artifactCount = $state(0);

  async function load() {
    try {
      const [h, q] = await Promise.all([call("health.report", {}), call("queue.list", {})]);
      health = h as Health;
      pendingCount = (q as { pending: unknown[] }).pending.length;
    } catch (e) {
      toast(`could not load overview: ${(e as Error).message}`);
      return;
    }

    try {
      const items = (await call("review.queue", { world: appState.world })) as unknown[];
      reviewCount = items.length;
    } catch {
      // world may have nothing staged yet; leave at 0 rather than failing the page
      reviewCount = 0;
    }

    try {
      const cards = (await call("artifacts.scorecards", { world: appState.world })) as unknown[];
      artifactCount = cards.length;
    } catch {
      artifactCount = 0;
    }
  }

  async function runWorker() {
    try {
      const res = (await call("loop.run", { world: appState.world })) as { pid: number };
      toast(`worker started (pid ${res.pid})`, "ok");
    } catch (e) {
      toast(`could not start worker: ${(e as Error).message}`);
    }
  }

  async function runCurriculum() {
    try {
      const res = (await call("curriculum.run", { world: appState.world })) as { pid: number };
      toast(`curriculum started (pid ${res.pid})`, "ok");
    } catch (e) {
      toast(`could not start curriculum: ${(e as Error).message}`);
    }
  }

  function openLogs() {
    window.location.hash = "#/logs";
  }

  onMount(load);
</script>

<h2>Overview</h2>
<div class="actions"><button onclick={load}>Refresh</button></div>

{#if health}
  <div class="card">
    <div>Config: {health.config_file}</div>
    <div>State dir: {health.state_dir}</div>
    <div>Plugin root: {health.plugin_root}</div>
    <div>Worlds: {health.worlds.join(", ")}</div>
  </div>

  <div class="card">
    <div>Pending queue: {pendingCount}</div>
    <div>Staged reviews ({appState.world}): {reviewCount}</div>
    <div>Artifacts tracked ({appState.world}): {artifactCount}</div>
  </div>

  <div class="card">
    <h3>Provider status</h3>
    {#each Object.entries(health.providers) as [world, status]}
      <div>{world}: {JSON.stringify(status)}</div>
    {/each}
  </div>

  <div class="card">
    <h3>Worker</h3>
    {#if "error" in health.worker}
      <p class="error-text">{health.worker.error}</p>
    {:else}
      <WorkerStatus status={health.worker} compact={true} />
    {/if}
  </div>

  <div class="actions">
    <button class="primary" onclick={runWorker}>Run worker now</button>
    <button onclick={runCurriculum}>Run curriculum</button>
    <button onclick={openLogs}>Open logs</button>
  </div>
{/if}
