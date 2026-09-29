<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import type { HistorySeries } from "../lib/api-types.ts";
  import { appState, toast } from "../lib/state.svelte.ts";
  import { formatTime, plural } from "../lib/format.ts";
  import WorkerStatus from "../components/WorkerStatus.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import BarChart from "../components/charts/BarChart.svelte";
  import LineChart from "../components/charts/LineChart.svelte";
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

  /** A loop-band count while it loads, once it settles, or if its call failed.
   * A failed call never falls back to a count, so it can never read as a 0. */
  type Stat = { status: "loading" } | { status: "ok"; value: number } | { status: "error"; error: string };

  const LOADING: Stat = { status: "loading" };

  let health = $state<Health | null>(null);
  let pending = $state<Stat>(LOADING);
  let reflections = $state<Stat>(LOADING);
  let promote = $state<Stat>(LOADING);
  let review = $state<Stat>(LOADING);
  let artifacts = $state<Stat>(LOADING);
  let lessons = $state<Stat>(LOADING);
  let threshold = $state<number | null>(null);
  let lastLoad = $state<string | null>(null);
  let healthError = $state<string | null>(null);
  let busy = $state(false);

  interface HistoryState {
    status: "loading" | "ok" | "error";
    data?: HistorySeries;
    error?: string;
  }

  let history = $state<HistoryState>({ status: "loading" });
  const HISTORY_DAYS = 30;

  // The reflection stage reads a window, not the whole store, so the number
  // below it says which window it is.
  const REFLECTION_WINDOW = 500;

  async function countOf(op: string, payload: Record<string, unknown>): Promise<Stat> {
    try {
      const items = (await call(op, payload)) as unknown[];
      return { status: "ok", value: Array.isArray(items) ? items.length : 0 };
    } catch (e) {
      return { status: "error", error: (e as Error).message };
    }
  }

  async function load() {
    if (busy) return;
    busy = true;
    const world = appState.world;

    try {
      health = (await call("health.report", {})) as Health;
      healthError = null;
    } catch (e) {
      healthError = (e as Error).message;
      toast(`Could not read the health report: ${healthError}`);
    }

    const [pendingStat, reflectionsStat, planResult, reviewStat, artifactsStat, lessonsStat] = await Promise.all([
      (async (): Promise<Stat> => {
        try {
          const q = (await call("queue.list", {})) as { pending: unknown[] };
          return { status: "ok", value: q.pending.length };
        } catch (e) {
          return { status: "error", error: (e as Error).message };
        }
      })(),
      countOf("reflections.list", { world, limit: REFLECTION_WINDOW }),
      (async (): Promise<{ stat: Stat; threshold: number | null }> => {
        try {
          const plan = (await call("curriculum.plan", { world })) as PlanReport;
          return { stat: { status: "ok", value: plan.actions.filter((a) => a.action === "promote").length }, threshold: plan.threshold };
        } catch (e) {
          return { stat: { status: "error", error: (e as Error).message }, threshold: null };
        }
      })(),
      countOf("review.queue", { world }),
      countOf("artifacts.scorecards", { world }),
      countOf("lessons.list", { world }),
    ]);

    pending = pendingStat;
    reflections = reflectionsStat;
    promote = planResult.stat;
    threshold = planResult.threshold;
    review = reviewStat;
    artifacts = artifactsStat;
    lessons = lessonsStat;
    lastLoad = new Date().toISOString();
    busy = false;
  }

  async function loadHistory() {
    history = { status: "loading" };
    try {
      const data = (await call("history.series", { world: appState.world, days: HISTORY_DAYS })) as HistorySeries;
      history = { status: "ok", data };
    } catch (e) {
      history = { status: "error", error: (e as Error).message };
    }
  }

  function refresh() {
    load();
    loadHistory();
  }

  /** "Tracked since 28 Sep 2026", the caveat under the proposals chart when the
   * window is not fully covered by the append-only proposal log. Null means
   * the log has never seen a staged proposal at all. */
  const proposalsSinceNote = $derived.by((): string => {
    if (history.status !== "ok" || !history.data) return "";
    const since = history.data.since.proposals_staged;
    if (!since) return "Tracking starts with this version.";
    const sinceDate = new Date(since);
    if (Number.isNaN(sinceDate.getTime())) return "";
    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - (history.data.days - 1));
    windowStart.setHours(0, 0, 0, 0);
    if (sinceDate <= windowStart) return "";
    const label = sinceDate.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    return `Tracked since ${label}.`;
  });

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

  function reviewHint(stat: Stat): string {
    if (stat.status === "error") return "Status unknown";
    return stat.status === "ok" && stat.value > 0 ? "Your gate, nothing moves without you" : "Nothing needs you";
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

  onMount(refresh);
</script>

{#snippet statValue(stat: Stat)}
  {#if stat.status === "loading"}
    <Skeleton width="3ch" height="1.6em" />
  {:else if stat.status === "error"}
    <span class="chip err stage__err" title={stat.error}>{stat.error}</span>
  {:else}
    {stat.value}
  {/if}
{/snippet}

<div class="toolbar">
  <button onclick={refresh} disabled={busy}>Refresh</button>
  <button class="primary" onclick={runWorker}>Run worker</button>
  <button onclick={runCurriculum}>Run curriculum</button>
  <span class="toolbar__spacer"></span>
  <span class="meta">Read {formatTime(lastLoad)}</span>
</div>

<section class="loopband" aria-label="Loop stages">
  <ol class="loopband__track">
    <li class="stage">
      <a class="stage__link" href="#/queue">
        <span class="stage__value">{@render statValue(pending)}</span>
        <span class="stage__label">Sessions waiting</span>
        <span class="stage__hint">Queued by the hook</span>
      </a>
    </li>
    <li class="stage">
      <a class="stage__link" href="#/reflections">
        <span class="stage__value">{@render statValue(reflections)}</span>
        <span class="stage__label">Reflections</span>
        <span class="stage__hint">Last {REFLECTION_WINDOW} in this world</span>
      </a>
    </li>
    <li class="stage">
      <a class="stage__link" href="#/loop">
        <span class="stage__value">{@render statValue(promote)}</span>
        <span class="stage__label">Patterns ready</span>
        <span class="stage__hint">{threshold === null ? "Threshold unknown" : `Seen ${threshold} times or more`}</span>
      </a>
    </li>
    <li class="stage" class:is-gate={review.status === "ok" && review.value > 0}>
      <a class="stage__link" href="#/review">
        <span class="stage__value">{@render statValue(review)}</span>
        <span class="stage__label">Waiting for review</span>
        <span class="stage__hint">{reviewHint(review)}</span>
      </a>
    </li>
    <li class="stage">
      <a class="stage__link" href="#/artifacts">
        <span class="stage__value">{@render statValue(artifacts)}</span>
        <span class="stage__label">Live artifacts</span>
        <span class="stage__hint">Accepted and tracked</span>
      </a>
    </li>
  </ol>
  <div class="loopband__return">
    <span>{@render statValue(lessons)} lessons queued for your next session</span>
  </div>
</section>

{#if healthError}
  <p class="notice error">Could not read the health report: {healthError}. Check that the loop is installed and that config.yaml exists.</p>
{/if}

<section class="history-section" aria-label="Last 30 days">
  <div class="section-title">Last {HISTORY_DAYS} days</div>
  {#if history.status === "loading"}
    <div class="grid">
      <Skeleton height="120px" />
      <Skeleton height="120px" />
      <Skeleton height="120px" />
    </div>
  {:else if history.status === "error"}
    <p class="notice error">Could not load the history charts: {history.error}</p>
  {:else if history.data}
    <div class="grid">
      <BarChart
        title="Sessions"
        stacked
        series={[
          { label: "Done", tone: "ok", points: history.data.series.sessions_done },
          { label: "Failed", tone: "err", points: history.data.series.sessions_failed },
        ]}
      />
      <LineChart title="Reflections" series={[{ label: "Reflections", tone: "accent", points: history.data.series.reflections }]} />
      <div class="history__proposals">
        <LineChart
          title="Proposals"
          series={[
            { label: "Staged", tone: "muted", points: history.data.series.proposals_staged },
            { label: "Accepted", tone: "ok", points: history.data.series.proposals_accepted },
            { label: "Rejected", tone: "err", points: history.data.series.proposals_rejected },
          ]}
        />
        {#if proposalsSinceNote}
          <p class="meta">{proposalsSinceNote}</p>
        {/if}
      </div>
    </div>
  {/if}
</section>

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
    display: flex;
    align-items: center;
    font-size: var(--fs-xl);
    font-weight: 600;
    line-height: 1.1;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
  }

  .stage__err {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-xs);
    font-weight: 500;
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
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0 0.6rem;
    background: var(--bg);
    color: var(--muted);
    font-size: var(--fs-xs);
    white-space: nowrap;
  }

  .history-section {
    margin-bottom: 1.6rem;
  }

  .history__proposals {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .kv dd {
    overflow-wrap: anywhere;
  }
</style>
