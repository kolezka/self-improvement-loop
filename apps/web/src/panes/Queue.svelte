<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { toast } from "../lib/state.svelte.ts";
  import QueueBucket from "../components/QueueBucket.svelte";
  import WorkerStatus from "../components/WorkerStatus.svelte";
  import type { WorkerStatusData } from "../lib/worker-types.ts";

  interface QueueEntry {
    session_id: string;
    world: string;
    cwd: string;
    stops: number;
    tool_uses: number;
    last_stop: string;
    result: string | null;
  }

  interface QueueData {
    pending: QueueEntry[];
    done: QueueEntry[];
    failed: QueueEntry[];
  }

  let workerStatus = $state<WorkerStatusData | null>(null);
  let pending = $state<QueueEntry[]>([]);
  let done = $state<QueueEntry[]>([]);
  let failed = $state<QueueEntry[]>([]);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refreshWorker() {
    try {
      workerStatus = (await call("worker.status", {})) as WorkerStatusData;
    } catch {
      workerStatus = null;
    }
  }

  async function refreshLists() {
    let data: QueueData;
    try {
      data = (await call("queue.list", {})) as QueueData;
    } catch (e) {
      toast(`could not load queue: ${(e as Error).message}`);
      return;
    }
    pending = data.pending;
    done = data.done;
    failed = data.failed;
  }

  async function refreshAll() {
    await Promise.all([refreshWorker(), refreshLists()]);
  }

  async function skip(sessionId: string) {
    try {
      await call("queue.skip", { session_id: sessionId });
      toast(`skipped ${sessionId}`, "ok");
      await refreshLists();
    } catch (e) {
      toast(`could not skip: ${(e as Error).message}`);
    }
  }

  onMount(() => {
    refreshAll();
    // Poll worker status every 5s while this pane stays mounted; the
    // interval is cleared on unmount, so navigating away stops it.
    timer = setInterval(refreshWorker, 5000);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });
</script>

<div class="toolbar">
  <button onclick={refreshAll}>Refresh</button>
</div>

<div class="card">
  <WorkerStatus status={workerStatus} compact={true} />
</div>

<QueueBucket name="pending" entries={pending} skippable={true} onSkip={skip} />

<div class="grid">
  <QueueBucket name="done" entries={done} />
  <QueueBucket name="failed" entries={failed} />
</div>
