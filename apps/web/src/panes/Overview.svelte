<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";
  import { formatTime, plural } from "../lib/format.ts";
  import WorkerStatus from "../components/WorkerStatus.svelte";
  import type { WorkerStatusData } from "../lib/worker-types.ts";

  // health.report() catches a throw from deps.worker.status() and reports it
  // as {error} instead, so the field is one or the other, never unknown.
  type WorkerHealth = WorkerStatusData | { error: string };

  interface EndpointStatus {
    name: string;
    active: boolean;
    reachable: boolean | null;
  }

  interface ProviderStatus {
    endpoint: string | null;
    endpoints?: EndpointStatus[];
    error: string | null;
  }

  interface Health {
    config_file: string;
    llm_file: string;
    state_dir: string;
    plugin_root: string;
    worlds: string[];
    providers: Record<string, ProviderStatus | { error: string }>;
    worker: WorkerHealth;
  }

  interface PlanAction {
    action: string;
  }

  interface PlanReport {
    threshold: number;
    actions: PlanAction[];
  }

  /** A stage count the loop has not reported yet prints as a dash, never as a
   * zero that would read like real news. */
  type Count = number | null;

  let health = $state<Health | null>(null);
  let pendingCount = $state<Count>(null);
  let reflectionCount = $state<Count>(null);
  let promoteCount = $state<Count>(null);
  let reviewCount = $state<Count>(null);
  let artifactCount = $state<Count>(null);
  let lessonCount = $state<Count>(null);
  let threshold = $state<number | null>(null);
  let lastLoad = $state<string | null>(null);
  let healthError = $state<string | null>(null);
  let loading = $state(false);

  // The reflection stage reads a window, not the whole store, so the number
  // below it says which window it is.
  const REFLECTION_WINDOW = 500;

  function count(value: Count): string {
    return value === null ? "-" : String(value);
  }

  async function countOf(op: string, payload: Record<string, unknown>): Promise<Count> {
    try {
      const items = (await call(op, payload)) as unknown[];
      return Array.isArray(items) ? items.length : null;
    } catch {
      return null;
    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    const world = appState.world;

    try {
      health = (await call("health.report", {})) as Health;
      healthError = null;
    } catch (e) {
      healthError = (e as Error).message;
      toast(`Could not read the health report: ${healthError}`);
    }

    const [pending, reflections, plan, review, artifacts, lessons] = await Promise.all([
      (async (): Promise<Count> => {
        try {
          const q = (await call("queue.list", {})) as { pending: unknown[] };
          return q.pending.length;
        } catch {
          return null;
        }
      })(),
      countOf("reflections.list", { world, limit: REFLECTION_WINDOW }),
      (async (): Promise<PlanReport | null> => {
        try {
          return (await call("curriculum.plan", { world })) as PlanReport;
        } catch {
          return null;
        }
      })(),
      countOf("review.queue", { world }),
      countOf("artifacts.scorecards", { world }),
      countOf("lessons.list", { world }),
    ]);

    pendingCount = pending;
    reflectionCount = reflections;
    promoteCount = plan ? plan.actions.filter((a) => a.action === "promote").length : null;
    threshold = plan ? plan.threshold : null;
    reviewCount = review;
    artifactCount = artifacts;
    lessonCount = lessons;
    lastLoad = new Date().toISOString();
    loading = false;
  }

  async function runWorker() {
    try {
      const res = (await call("loop.run", { world: appState.world })) as { pid: number };
      toast(`Worker started, pid ${res.pid}`, "ok");
    } catch (e) {
      toast(`Could not start the worker: ${(e as Error).message}`);
    }
  }

  async function runCurriculum() {
    try {
      const res = (await call("curriculum.run", { world: appState.world })) as { pid: number };
      toast(`Curriculum started, pid ${res.pid}`, "ok");
    } catch (e) {
      toast(`Could not start the curriculum: ${(e as Error).message}`);
    }
  }

  interface ProviderRow {
    world: string;
    endpoint: string;
    dot: string;
    text: string;
  }

  const providerRows = $derived.by((): ProviderRow[] => {
    if (!health) return [];
    return Object.entries(health.providers).map(([world, status]) => {
      if ("error" in status && status.error && !("endpoints" in status)) {
        return { world, endpoint: "none", dot: "err", text: status.error };
      }
      const provider = status as ProviderStatus;
      const active = provider.endpoints?.find((e) => e.active) ?? provider.endpoints?.[0] ?? null;
      if (!active) return { world, endpoint: provider.endpoint ?? "none", dot: "", text: "No endpoint configured" };
      if (active.reachable === null) return { world, endpoint: active.name, dot: "warn", text: "Not checked" };
      return { world, endpoint: active.name, dot: active.reachable ? "ok" : "err", text: active.reachable ? "Reachable" : "Unreachable" };
    });
  });

  onMount(load);
</script>

<div class="toolbar">
  <button onclick={load} disabled={loading}>Refresh</button>
  <button class="primary" onclick={runWorker}>Run worker</button>
  <button onclick={runCurriculum}>Run curriculum</button>
  <span class="toolbar__spacer"></span>
  <span class="meta">Read {formatTime(lastLoad)}</span>
</div>

<section class="loopband" aria-label="Loop stages">
  <ol class="loopband__track">
    <li class="stage">
      <a class="stage__link" href="#/queue">
        <span class="stage__value">{count(pendingCount)}</span>
        <span class="stage__label">Sessions waiting</span>
        <span class="stage__hint">Queued by the hook</span>
      </a>
    </li>
    <li class="stage">
      <a class="stage__link" href="#/reflections">
        <span class="stage__value">{count(reflectionCount)}</span>
        <span class="stage__label">Reflections</span>
        <span class="stage__hint">Last {REFLECTION_WINDOW} in this world</span>
      </a>
    </li>
    <li class="stage">
      <a class="stage__link" href="#/loop">
        <span class="stage__value">{count(promoteCount)}</span>
        <span class="stage__label">Patterns ready</span>
        <span class="stage__hint">{threshold === null ? "Threshold unknown" : `Seen ${threshold} times or more`}</span>
      </a>
    </li>
    <li class="stage" class:is-gate={(reviewCount ?? 0) > 0}>
      <a class="stage__link" href="#/review">
        <span class="stage__value">{count(reviewCount)}</span>
        <span class="stage__label">Waiting for review</span>
        <span class="stage__hint">{(reviewCount ?? 0) > 0 ? "Your gate, nothing moves without you" : "Nothing needs you"}</span>
      </a>
    </li>
    <li class="stage">
      <a class="stage__link" href="#/artifacts">
        <span class="stage__value">{count(artifactCount)}</span>
        <span class="stage__label">Live artifacts</span>
        <span class="stage__hint">Accepted and tracked</span>
      </a>
    </li>
  </ol>
  <div class="loopband__return">
    <span>{count(lessonCount)} lessons queued for your next session</span>
  </div>
</section>

{#if healthError}
  <p class="notice error">Could not read the health report: {healthError}. Check that the loop is installed and that config.yaml exists.</p>
{/if}

<div class="grid">
  <section class="panel">
    <div class="panel__head">
      <h3>Worker</h3>
    </div>
    <div class="panel__body">
      {#if !health}
        <p class="muted">Loading the worker state.</p>
      {:else if "error" in health.worker}
        <p class="notice error">{health.worker.error}</p>
      {:else}
        <WorkerStatus status={health.worker} compact={true} />
        <p class="meta">Full history and the curriculum plan live in the Loop pane.</p>
      {/if}
    </div>
  </section>

  <section class="panel">
    <div class="panel__head">
      <h3>Providers</h3>
      <span class="spacer"></span>
      <span class="badge">{plural(health ? health.worlds.length : 0, "world")}</span>
    </div>
    <div class="panel__body">
      {#if !health}
        <p class="muted">Loading the provider state.</p>
      {:else if providerRows.length === 0}
        <div class="empty">
          <strong>No world is configured.</strong>
          Run <code>sil init</code> to write config.yaml and the first world.
        </div>
      {:else}
        <ul class="list">
          {#each providerRows as row (row.world)}
            <li>
              <div class="row__title">
                <span class="grow">{row.world}</span>
                <span class="badge">{row.endpoint}</span>
              </div>
              <p class="meta"><span class={`dot ${row.dot}`}></span>{row.text}</p>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </section>

  <section class="panel">
    <div class="panel__head">
      <h3>This install</h3>
    </div>
    <div class="panel__body">
      {#if health}
        <dl class="kv">
          <dt>Config</dt>
          <dd>{health.config_file}</dd>
          <dt>Models</dt>
          <dd>{health.llm_file}</dd>
          <dt>State</dt>
          <dd>{health.state_dir}</dd>
          <dt>Plugin</dt>
          <dd>{health.plugin_root}</dd>
        </dl>
      {:else}
        <p class="muted">Loading the paths.</p>
      {/if}
    </div>
  </section>
</div>

<style>
  .loopband {
    margin-bottom: 1.6rem;
  }

  .loopband__track {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    background: var(--surface);
    overflow: hidden;
  }

  .stage + .stage {
    border-left: 1px solid var(--border);
  }

  .stage__link {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    height: 100%;
    padding: 0.85rem 0.95rem 0.95rem;
    color: inherit;
    text-decoration: none;
  }

  .stage__link:hover {
    background: var(--panel);
  }

  .stage__value {
    font-size: var(--fs-xl);
    font-weight: 600;
    line-height: 1.1;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
  }

  .stage__label {
    font-size: var(--fs-sm);
    font-weight: 500;
  }

  .stage__hint {
    font-size: var(--fs-xs);
    color: var(--muted);
  }

  /* The review stage is the only place a human is required, so it is the only
     stage that gets tinted, and only while it holds work. */
  .stage.is-gate {
    background: var(--accent-soft);
  }

  .stage.is-gate .stage__value,
  .stage.is-gate .stage__label {
    color: var(--accent);
  }

  /* Draws the return path of the loop: accepted lessons go back into the next
     session, which is what makes this a loop and not a funnel. */
  .loopband__return {
    position: relative;
    height: 2rem;
    margin: 0 2rem;
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 var(--r-lg) var(--r-lg);
  }

  .loopband__return span {
    position: absolute;
    left: 50%;
    bottom: -0.65rem;
    transform: translateX(-50%);
    padding: 0 0.6rem;
    background: var(--bg);
    color: var(--muted);
    font-size: var(--fs-xs);
    white-space: nowrap;
  }

  .kv dd {
    overflow-wrap: anywhere;
  }
</style>
