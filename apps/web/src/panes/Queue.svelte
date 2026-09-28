<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import Drawer from "../components/Drawer.svelte";
  import QueueBucket from "../components/QueueBucket.svelte";
  import WorkerStatus from "../components/WorkerStatus.svelte";
  import { call } from "../lib/api.ts";
  import type { QueueDetail, QueueEntry, QueueList } from "../lib/api-types.ts";
  import { formatTime } from "../lib/format.ts";
  import { toast } from "../lib/state.svelte.ts";
  import type { WorkerStatusData } from "../lib/worker-types.ts";

  type ClearableBucket = "done" | "failed";

  const EMPTY_QUEUE: QueueList = {
    pending: [],
    done: [],
    failed: [],
    hidden: { done: 0, failed: 0 },
    cleared: { done: null, failed: null },
  };

  let workerStatus = $state<WorkerStatusData | null>(null);
  let workerError = $state<string | null>(null);
  let queue = $state<QueueList>(EMPTY_QUEUE);
  let queueError = $state<string | null>(null);
  let queueUpdatedAt = $state<string | null>(null);
  let workerTimer: ReturnType<typeof setInterval> | null = null;
  let queueTimer: ReturnType<typeof setInterval> | null = null;
  let drawerOpen = $state(false);
  let selected = $state<QueueEntry | null>(null);
  let detail = $state<QueueDetail | null>(null);
  let detailLoading = $state(false);
  let detailError = $state<string | null>(null);

  const hiddenCount = $derived(queue.hidden.done + queue.hidden.failed);
  const drawerTitle = $derived(selected ? `Session ${selected.session_id}` : "Session preview");

  async function refreshWorker() {
    try {
      workerStatus = (await call("worker.status", {})) as WorkerStatusData;
      workerError = null;
    } catch (e) {
      workerError = (e as Error).message;
    }
  }

  async function refreshLists() {
    try {
      queue = (await call("queue.list", {})) as QueueList;
      queueUpdatedAt = new Date().toISOString();
      queueError = null;
    } catch (e) {
      queueError = (e as Error).message;
    }
  }

  async function refreshAll() {
    await Promise.all([refreshWorker(), refreshLists()]);
  }

  async function skip(sessionId: string) {
    try {
      await call("queue.skip", { session_id: sessionId });
      toast(`Skipped ${sessionId}`, "ok");
      await refreshLists();
    } catch (e) {
      toast(`Could not skip: ${(e as Error).message}`);
    }
  }

  async function clear(bucket: ClearableBucket) {
    const count = queue[bucket].length;
    if (!window.confirm(`Hide ${count} ${bucket} sessions? You can show them again.`)) return;
    try {
      await call("queue.clear", { bucket });
      toast(`${bucket} sessions hidden`, "ok");
      await refreshLists();
    } catch (e) {
      toast(`Could not clear ${bucket}: ${(e as Error).message}`);
    }
  }

  async function showHidden() {
    const buckets: ClearableBucket[] = [];
    if (queue.hidden.done > 0) buckets.push("done");
    if (queue.hidden.failed > 0) buckets.push("failed");
    try {
      await Promise.all(buckets.map((bucket) => call("queue.unclear", { bucket })));
      toast("Hidden sessions restored", "ok");
      await refreshLists();
    } catch (e) {
      toast(`Could not restore hidden sessions: ${(e as Error).message}`);
    }
  }

  async function openDetail(entry: QueueEntry) {
    selected = entry;
    detail = null;
    detailError = null;
    detailLoading = true;
    drawerOpen = true;
    try {
      const loaded = (await call("queue.detail", { session_id: entry.session_id })) as QueueDetail;
      if (selected?.session_id === entry.session_id) detail = loaded;
    } catch (e) {
      if (selected?.session_id === entry.session_id) detailError = (e as Error).message;
    } finally {
      if (selected?.session_id === entry.session_id) detailLoading = false;
    }
  }

  onMount(() => {
    void refreshAll();
    workerTimer = setInterval(refreshWorker, 5000);
    queueTimer = setInterval(refreshLists, 10_000);
  });

  onDestroy(() => {
    if (workerTimer) clearInterval(workerTimer);
    if (queueTimer) clearInterval(queueTimer);
  });
</script>

<div class="toolbar queue-toolbar">
  <button onclick={() => clear("done")} disabled={queue.done.length === 0}>Clear done</button>
  <button onclick={() => clear("failed")} disabled={queue.failed.length === 0}>Clear failed</button>
  {#if hiddenCount > 0}
    <button onclick={showHidden}>Show hidden ({hiddenCount})</button>
  {/if}
  <span class="toolbar__spacer"></span>
  <span class="queue-updated">Updated {queueUpdatedAt ? new Date(queueUpdatedAt).toLocaleTimeString() : "not yet"}</span>
</div>

<div class="card">
  <WorkerStatus status={workerStatus} compact={true} />
  {#if workerError}<p class="error-text queue-status-error">Could not load worker status: {workerError}</p>{/if}
</div>

{#if queueError}<p class="error-text">Could not load queue: {queueError}</p>{/if}

<QueueBucket name="pending" entries={queue.pending} skippable={true} onSkip={skip} onOpen={openDetail} />

<div class="grid">
  <QueueBucket name="done" entries={queue.done} onOpen={openDetail} />
  <QueueBucket name="failed" entries={queue.failed} onOpen={openDetail} />
</div>

<Drawer bind:open={drawerOpen} title={drawerTitle}>
  {#if detailLoading}
    <p class="muted">Loading session preview.</p>
  {:else if detailError}
    <p class="error-text">Could not load this session: {detailError}</p>
  {:else if detail}
    <dl class="kv queue-detail">
      <dt>Session id</dt><dd>{detail.entry.session_id}</dd>
      <dt>World</dt><dd>{detail.entry.world}</dd>
      <dt>Directory</dt><dd>{detail.entry.cwd}</dd>
      <dt>Stops</dt><dd>{detail.entry.stops}</dd>
      <dt>Tool uses</dt><dd>{detail.entry.tool_uses}</dd>
      <dt>Attempts</dt><dd>{detail.entry.attempts}</dd>
      <dt>First stop</dt><dd>{formatTime(detail.entry.first_stop)}</dd>
      <dt>Last stop</dt><dd>{formatTime(detail.entry.last_stop)}</dd>
      <dt>Result</dt><dd>{detail.entry.result ?? "None"}</dd>
    </dl>

    <section class="queue-preview-section">
      <h3>Reflections</h3>
      {#if detail.reflection_ids.length === 0}
        <p class="muted">No reflection links found.</p>
      {:else}
        <ul class="list">
          {#each detail.reflection_ids as id (id)}
            <li><a href={`#/reflections/${id}`} class="mono">{id}</a></li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="queue-preview-section">
      <h3>Transcript excerpt</h3>
      {#if detail.transcript === null}
        <p class="muted">{detail.transcript_reason ?? "Transcript unavailable."}</p>
      {:else if detail.transcript.length === 0}
        <p class="muted">No transcript messages found.</p>
      {:else}
        <ul class="list transcript-list">
          {#each detail.transcript as message, index (`${message.ts ?? index}:${message.role}`)}
            <li>
              <div class="meta">
                <span class="chip">{message.role}</span>
                {#if message.ts}<span>{formatTime(message.ts)}</span>{/if}
              </div>
              <pre>{message.text}</pre>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {:else}
    <p class="muted">Choose a queue entry to inspect it.</p>
  {/if}
</Drawer>
