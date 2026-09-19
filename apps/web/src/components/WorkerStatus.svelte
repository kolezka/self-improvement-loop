<script lang="ts">
  import { formatDuration, formatTime } from "../lib/format.ts";
  import { normalizeCurriculum, type RunReport, type WorkerStatusData } from "../lib/worker-types.ts";

  let { status, compact = false }: { status: WorkerStatusData | null; compact?: boolean } = $props();

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
                <th scope="col">world</th>
                <th scope="col">staged</th>
                <th scope="col">merged</th>
                <th scope="col">gated out</th>
                <th scope="col">dropped</th>
                <th scope="col">started</th>
                <th scope="col">duration</th>
                <th scope="col">error</th>
              </tr>
            </thead>
            <tbody>
              {#each normalizeCurriculum(status.last_summary.curriculum) as entry (entry.world)}
                <tr>
                  <td>
                    {entry.world}
                    {#if entry.report?.dry_run}<span class="chip">dry run</span>{/if}
                  </td>
                  {#if entry.report}
                    {@const report = entry.report}
                    <td title={report.staged.join(", ") || "none"}>
                      {report.staged.length}
                      {#if report.routed && Object.keys(report.routed).length > 0}
                        <ul class="list muted">
                          {#each Object.entries(report.routed) as [pattern, route] (pattern)}
                            <li title={route.reason}>
                              {pattern}: {route.drafted === route.type ? route.type : `${route.drafted} -> ${route.type}`}{#if !report.staged.includes(pattern)} (not staged){/if}
                            </li>
                          {/each}
                        </ul>
                      {/if}
                    </td>
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
                  {:else}
                    <td colspan="7" class="error-text">{entry.error ?? "unknown error"}</td>
                  {/if}
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
              <th scope="col">world</th>
              <th scope="col">last pass</th>
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
