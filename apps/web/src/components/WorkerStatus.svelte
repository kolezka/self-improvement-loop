<script lang="ts">
  import { formatDuration, formatTime } from "../lib/format.ts";

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

  interface WorkerStatus {
    lock_held: boolean;
    lock_pid: number | null;
    pending: number;
    done: number;
    failed: number;
    last_run: string | null;
    last_summary: RunSummary | null;
    last_curriculum: Record<string, string>;
  }

  let { status, compact = false }: { status: WorkerStatus | null; compact?: boolean } = $props();

  function runDuration(report: RunReport): string {
    if (!report.finished) return "not finished";
    const ms = new Date(report.finished).getTime() - new Date(report.started).getTime();
    return formatDuration(ms / 1000);
  }

  function droppedTotal(report: RunReport): number {
    return Object.values(report.dropped).reduce((sum, n) => sum + n, 0);
  }

  function droppedTitle(report: RunReport): string {
    const entries = Object.entries(report.dropped);
    return entries.length === 0 ? "none" : entries.map(([reason, n]) => `${reason}: ${n}`).join(", ");
  }
</script>

{#if !status}
  <p class="muted">no worker run yet</p>
{:else}
  <div class="ws-head">
    {#if status.lock_held}
      <span class="badge">{status.lock_pid !== null ? `running, pid ${status.lock_pid}` : "running"}</span>
    {:else}
      <span class="chip">idle</span>
    {/if}
    <span class="chip">pending {status.pending}</span>
    <span class="chip">done {status.done}</span>
    <span class={status.failed > 0 ? "chip error-text" : "chip"}>failed {status.failed}</span>
    <span class="chip">last run {formatTime(status.last_run)}</span>
  </div>

  {#if !compact}
    <div class="ws-section">
      <h4>Last run</h4>
      {#if status.last_summary}
        <div class="ws-head">
          <span class="chip">duration {formatDuration(status.last_summary.duration_s)}</span>
          {#if status.last_summary.locked}<span class="chip warn-text">locked</span>{/if}
        </div>
        <div class="ws-lists">
          <div>
            <div class="muted">reflected</div>
            {#if status.last_summary.reflected.length === 0}
              <p class="muted">nothing reflected</p>
            {:else}
              <ul class="list">
                {#each status.last_summary.reflected as name}<li>{name}</li>{/each}
              </ul>
            {/if}
          </div>
          <div>
            <div class="muted">failed</div>
            {#if status.last_summary.failed.length === 0}
              <p class="muted">nothing failed</p>
            {:else}
              <ul class="list">
                {#each status.last_summary.failed as name}<li>{name}</li>{/each}
              </ul>
            {/if}
          </div>
          <div>
            <div class="muted">skipped</div>
            {#if status.last_summary.skipped.length === 0}
              <p class="muted">nothing skipped</p>
            {:else}
              <ul class="list">
                {#each status.last_summary.skipped as name}<li>{name}</li>{/each}
              </ul>
            {/if}
          </div>
        </div>
      {:else}
        <p class="muted">no run recorded yet</p>
      {/if}
    </div>

    <div class="ws-section">
      <h4>Curriculum</h4>
      {#if status.last_summary && Object.keys(status.last_summary.curriculum).length > 0}
        <div class="ws-table-wrap">
          <table>
            <thead>
              <tr>
                <th>world</th>
                <th>staged</th>
                <th>merged</th>
                <th>gated out</th>
                <th>dropped</th>
                <th>started</th>
                <th>duration</th>
                <th>error</th>
              </tr>
            </thead>
            <tbody>
              {#each Object.values(status.last_summary.curriculum) as report (report.world)}
                <tr>
                  <td>
                    {report.world}
                    {#if report.dry_run}<span class="chip">dry run</span>{/if}
                  </td>
                  <td title={report.staged.join(", ") || "none"}>{report.staged.length}</td>
                  <td>{report.merged.length}</td>
                  <td>
                    {Object.keys(report.gated_out).length}
                    {#if Object.keys(report.gated_out).length > 0}
                      <ul class="list muted">
                        {#each Object.entries(report.gated_out) as [pattern, reason] (pattern)}
                          <li>{pattern}: {reason}</li>
                        {/each}
                      </ul>
                    {/if}
                  </td>
                  <td title={droppedTitle(report)}>{droppedTotal(report)}</td>
                  <td>{formatTime(report.started)}</td>
                  <td>{runDuration(report)}</td>
                  <td class={report.error ? "error-text" : ""}>{report.error ?? ""}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="muted">no curriculum data yet</p>
      {/if}
    </div>

    <div class="ws-section">
      <h4>Last curriculum pass per world</h4>
      {#if Object.keys(status.last_curriculum).length > 0}
        <table>
          <thead>
            <tr>
              <th>world</th>
              <th>last pass</th>
            </tr>
          </thead>
          <tbody>
            {#each Object.entries(status.last_curriculum) as [world, iso] (world)}
              <tr>
                <td>{world}</td>
                <td>{formatTime(iso)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="muted">no curriculum runs recorded</p>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .ws-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .ws-section {
    margin-top: 0.9rem;
  }

  .ws-section h4 {
    margin: 0 0 0.4rem;
  }

  .ws-lists {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    margin-top: 0.5rem;
  }

  .ws-lists > div {
    min-width: 10rem;
  }

  .ws-table-wrap {
    overflow-x: auto;
  }
</style>
