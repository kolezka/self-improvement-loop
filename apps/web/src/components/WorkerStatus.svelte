<script lang="ts">
  import { formatDuration, formatTime } from "../lib/format.ts";
  import { normalizeCurriculum, type RunReport, type WorkerStatusData } from "../lib/worker-types.ts";

  let { status, compact = false }: { status: WorkerStatusData | null; compact?: boolean } = $props();

  function runningLabel(s: WorkerStatusData): string {
    if (!s.lock_held) return "Idle";
    return s.lock_pid !== null ? `Running, pid ${s.lock_pid}` : "Running";
  }

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

  function gatedOutTitle(report: RunReport): string {
    const entries = Object.entries(report.gated_out);
    return entries.length === 0 ? "none" : entries.map(([pattern, reason]) => `${pattern}: ${reason}`).join(", ");
  }
</script>

{#if !status}
  {#if compact}
    <p class="muted">No worker status yet.</p>
  {:else}
    <div class="empty">
      <strong>No worker status yet.</strong>
      Run the worker once to populate this pane.
    </div>
  {/if}
{:else if compact}
  <div class="meta">
    <span class={status.lock_held ? "dot busy" : "dot ok"}></span>
    <span>{runningLabel(status)}</span>
    <span class="chip">pending <strong>{status.pending}</strong></span>
    <span class="chip">done <strong>{status.done}</strong></span>
    <span class={status.failed > 0 ? "chip err" : "chip"}>failed <strong>{status.failed}</strong></span>
    <span class="chip">last run {formatTime(status.last_run)}</span>
  </div>
{:else}
  <div class="panel">
    <div class="panel__head">
      <span class={status.lock_held ? "dot busy" : "dot ok"}></span>
      <h3>{runningLabel(status)}</h3>
      <span class="spacer"></span>
      <span class="chip">pending <strong>{status.pending}</strong></span>
      <span class="chip">done <strong>{status.done}</strong></span>
      <span class={status.failed > 0 ? "chip err" : "chip"}>failed <strong>{status.failed}</strong></span>
      <span class="chip">last run {formatTime(status.last_run)}</span>
    </div>
  </div>

  <div class="panel">
    <div class="panel__head"><h3>Last run</h3></div>
    <div class="panel__body">
      {#if status.last_summary}
        {@const summary = status.last_summary}
        <div class="meta"><span class="chip">duration {formatDuration(summary.duration_s)}</span></div>
        <div class="run-lists">
          <div>
            <div class="muted">Reflected</div>
            {#if summary.reflected.length === 0}
              <p class="muted">Nothing reflected.</p>
            {:else}
              <ul class="list">
                {#each summary.reflected as id (id)}<li class="mono">{id}</li>{/each}
              </ul>
            {/if}
          </div>
          <div>
            <div class="muted">Failed</div>
            {#if summary.failed.length === 0}
              <p class="muted">Nothing failed.</p>
            {:else}
              <ul class="list">
                {#each summary.failed as id (id)}<li class="mono">{id}</li>{/each}
              </ul>
            {/if}
          </div>
          <div>
            <div class="muted">Skipped</div>
            {#if summary.skipped.length === 0}
              <p class="muted">Nothing skipped.</p>
            {:else}
              <ul class="list">
                {#each summary.skipped as id (id)}<li class="mono">{id}</li>{/each}
              </ul>
            {/if}
          </div>
        </div>
      {:else}
        <div class="empty">
          <strong>No run recorded yet.</strong>
          Run the worker to reflect on queued sessions.
        </div>
      {/if}
    </div>
  </div>

  <div class="panel">
    <div class="panel__head"><h3>Curriculum</h3></div>
    <div class="panel__body">
      {#if status.last_summary && Object.keys(status.last_summary.curriculum).length > 0}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">world</th>
                <th scope="col" class="num">staged</th>
                <th scope="col" class="num">merged</th>
                <th scope="col" class="num">gated out</th>
                <th scope="col" class="num">dropped</th>
                <th scope="col">started</th>
                <th scope="col">duration</th>
                <th scope="col">error</th>
              </tr>
            </thead>
            <tbody>
              {#each normalizeCurriculum(status.last_summary.curriculum) as entry (entry.world)}
                <tr>
                  {#if entry.report}
                    {@const report = entry.report}
                    <td>
                      {entry.world}
                      {#if report.dry_run}<span class="chip">dry run</span>{/if}
                    </td>
                    <td class="num" title={report.staged.join(", ") || "none"}>
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
                    <td class="num">{report.merged.length}</td>
                    <td class="num" title={gatedOutTitle(report)}>{Object.keys(report.gated_out).length}</td>
                    <td class="num" title={droppedTitle(report)}>{droppedTotal(report)}</td>
                    <td>{formatTime(report.started)}</td>
                    <td>{runDuration(report)}</td>
                    <td class={report.error ? "error-text" : ""}>{report.error ?? ""}</td>
                  {:else}
                    <td>{entry.world}</td>
                    <td colspan="7" class="error-text">{entry.error ?? "Unknown error."}</td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="empty">
          <strong>No curriculum data yet.</strong>
          Run the curriculum to see staged, merged and gated patterns per world.
        </div>
      {/if}
    </div>
  </div>

  <div class="panel">
    <div class="panel__head"><h3>Last curriculum pass per world</h3></div>
    <div class="panel__body">
      {#if Object.keys(status.last_curriculum).length > 0}
        <div class="table-wrap">
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
        </div>
      {:else}
        <div class="empty">
          <strong>No curriculum runs recorded.</strong>
          Run the curriculum for a world to see its last pass time here.
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .run-lists {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    margin-top: 0.5rem;
  }

  .run-lists > div {
    min-width: 10rem;
  }
</style>
