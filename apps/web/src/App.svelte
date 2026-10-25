<script lang="ts">
  import type { Component } from "svelte";
  import { onMount, tick } from "svelte";
  import { captureToken, call, dropReloadParam, reloadForBuild } from "./lib/api.ts";
  import { appState, leaveGuards, toast } from "./lib/state.svelte.ts";
  import { applyTheme, loadThemeMode, saveThemeMode, THEME_MODES, watchSystemTheme, type ThemeMode } from "./lib/theme.ts";
  import { resolvedPendingCount } from "./lib/overview.ts";
  import { finishPoll, INITIAL_FORCE_POLL_STATE, requestPoll, type ForcePollState } from "./lib/poll.ts";
  import Icon, { type IconName } from "./components/Icon.svelte";
  import Toast from "./components/Toast.svelte";
  import Overview from "./panes/Overview.svelte";
  import Queue from "./panes/Queue.svelte";
  import Reflections from "./panes/Reflections.svelte";
  import Review from "./panes/Review.svelte";
  import Artifacts from "./panes/Artifacts.svelte";
  import Loop from "./panes/Loop.svelte";
  import Models from "./panes/Models.svelte";
  import Worlds from "./panes/Worlds.svelte";
  import Logs from "./panes/Logs.svelte";

  interface PaneMeta {
    title: string;
    blurb: string;
    component: Component;
  }

  // Title and blurb live here, not in the panes, so every screen gets the same
  // head treatment and the copy can be read in one place.
  const PANES: Record<string, PaneMeta> = {
    overview: { title: "Overview", blurb: "Where the loop stands right now, and what waits for you.", component: Overview },
    queue: { title: "Queue", blurb: "Sessions the hook recorded, waiting for the worker to reflect on them.", component: Queue },
    reflections: { title: "Reflections", blurb: "What the loop learned from each session, grouped by pattern.", component: Reflections },
    review: { title: "Review", blurb: "Accept, reject or rehome the proposals staged for this world.", component: Review },
    artifacts: { title: "Artifacts", blurb: "Promoted skills, hooks, rules and agents, with how they perform.", component: Artifacts },
    loop: { title: "Loop", blurb: "Run the worker or the curriculum, and read the dry-run plan first.", component: Loop },
    models: { title: "Models", blurb: "Endpoints and the model each role calls. Keys stay in your environment.", component: Models },
    worlds: { title: "Worlds", blurb: "Edit config.yaml and the pattern aliases for this world.", component: Worlds },
    logs: { title: "Logs", blurb: "Live tail of the hook, worker, web and curriculum logs.", component: Logs },
  };

  const GROUPS: { label: string; names: string[] }[] = [
    { label: "Watch", names: ["overview", "queue", "reflections", "logs"] },
    { label: "Decide", names: ["review", "artifacts"] },
    { label: "Configure", names: ["loop", "models", "worlds"] },
  ];

  const STATUS_INTERVAL_MS = 10_000;
  // Slower than the status poll: a plugin update is rarer than a worker tick.
  const BUILD_INTERVAL_MS = 30_000;

  function currentHash(): string {
    const raw = window.location.hash.replace(/^#\/?/, "");
    const name = raw.split("/")[0] || "overview";
    return PANES[name] ? name : "overview";
  }


  let hash = $state(currentHash());
  // Only matters under 45rem, where the rail becomes an overlay.
  let navOpen = $state(false);
  let rail = $state<HTMLElement>();
  let menuButton = $state<HTMLButtonElement>();

  // Move focus into the overlay on open, and back to the menu button on close.
  $effect(() => {
    if (navOpen) rail?.querySelector<HTMLElement>(".rail__link")?.focus();
  });

  async function closeNav() {
    if (!navOpen) return;
    navOpen = false;
    await tick(); // the menu button sits in the inert column until this flush
    menuButton?.focus();
  }
  let themeMode = $state<ThemeMode>(loadThemeMode());
  const THEME_LABELS: Record<ThemeMode, string> = { light: "Light theme", dark: "Dark theme", system: "Follow the system theme" };

  function chooseTheme(mode: ThemeMode) {
    themeMode = mode;
    saveThemeMode(mode);
  }
  let workerDot = $state("");
  let workerText = $state("Checking the worker");
  // Staged proposals plus escalated patterns, each counted once: both wait
  // on the same human decision in Review, and a pattern that is both must
  // not count twice. null means unknown (nothing successfully loaded yet).
  let pendingCount = $state<number | null>(null);
  // Tracks whether a poll is already running, and whether a forced one
  // arrived while it was: an unforced tick is simply skipped while busy
  // (the routine poll's own backoff), but a forced one (a world switch, or
  // an action that bumped statusSeq) must not be dropped, or the Review
  // badge can show a stale escalation count until the plan cache expires on
  // its own.
  let pollState: ForcePollState = INITIAL_FORCE_POLL_STATE;
  // curriculum.plan scans every reflection and recomputes scorecards, so it
  // is not cheap to call every 10s from every open tab. Cached and reused
  // until it goes stale or a caller forces a fresh read (a world switch, or
  // an action that bumps statusSeq); review.queue still polls every tick.
  const PLAN_POLL_INTERVAL_MS = 60_000;
  let cachedEscalatedPatterns: string[] | null = null;
  let cachedPlanWorld: string | null = null;
  let lastPlanFetchAt = 0;
  let lastStatusSeq = -1;
  // The build this page was served from, and the build on disk now. They differ
  // after a plugin update, which is what the reload button is for.
  let loadedBuild = $state<string | null>(null);
  let diskBuild = $state<string | null>(null);
  let serverStale = $state(false);
  const newBuild = $derived(diskBuild !== null && diskBuild !== loadedBuild);

  function onHashChange(event: HashChangeEvent) {
    const next = currentHash();
    // A same-pane change (an exact lesson link) stays inside the pane: no remount.
    if (next === hash) return;
    // Ask the open pane first. The URL goes back until it agrees.
    const target = window.location.href;
    history.replaceState(null, "", event.oldURL);
    leaveGuards.request(() => {
      history.replaceState(null, "", target);
      applyHash(next);
    });
  }

  function applyHash(next: string) {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced && typeof document.startViewTransition === "function") {
      document.startViewTransition(() => {
        hash = next;
        return tick();
      });
    } else {
      hash = next;
    }
    navOpen = false;
  }

  function onWorldChange(event: Event & { currentTarget: HTMLSelectElement }) {
    const next = event.currentTarget.value;
    // Keep showing the current world until the pane agrees to be replaced.
    event.currentTarget.value = appState.world;
    leaveGuards.request(() => {
      appState.world = next;
    });
  }

  async function loadWorlds() {
    try {
      const list = (await call("worlds.list", {})) as { name: string }[];
      appState.worldNames = list.map((w) => w.name);
      if (!appState.worldNames.includes(appState.world)) {
        appState.world = appState.worldNames[0] ?? "default";
      }
    } catch (e) {
      toast(`Could not load the world list: ${(e as Error).message}`);
    }
  }

  /** Feeds the state light in the rail and the count next to Review. Both
   * read-only, so a failure downgrades the light instead of toasting on a
   * timer. `review.queue` and `curriculum.plan` are resolved independently:
   * a plan failure must never erase an already-successful staged count down
   * to zero. `forcePlan` skips the 60s throttle for a caller that knows
   * something actually changed (a world switch, or an action that bumped
   * statusSeq); the plain 10s interval tick never forces it. */
  async function refreshStatus(forcePlan = false) {
    const { run, next } = requestPoll(pollState, forcePlan);
    pollState = next;
    if (!run) return;
    const requestWorld = appState.world;
    try {
      try {
        const status = (await call("worker.status", {})) as { lock_held: boolean; lock_pid: number | null; pending: number };
        workerDot = status.lock_held ? "busy" : "ok";
        workerText = status.lock_held
          ? `Worker running${status.lock_pid !== null ? `, pid ${status.lock_pid}` : ""}`
          : `Worker idle, ${status.pending} queued`;
      } catch {
        workerDot = "err";
        workerText = "Worker state unknown";
      }

      let stagedPatterns: string[] | null = null;
      try {
        const items = (await call("review.queue", { world: requestWorld })) as { pattern: string }[];
        stagedPatterns = items.map((i) => i.pattern);
      } catch {
        stagedPatterns = null;
      }

      // A world switch invalidates the cache built for the old one: never
      // show the new world's badge with the previous world's escalations.
      if (requestWorld !== cachedPlanWorld) {
        cachedEscalatedPatterns = null;
        cachedPlanWorld = requestWorld;
      }
      const now = Date.now();
      const planCacheStale = cachedEscalatedPatterns === null || now - lastPlanFetchAt >= PLAN_POLL_INTERVAL_MS;
      if (forcePlan || planCacheStale) {
        try {
          const plan = (await call("curriculum.plan", { world: requestWorld })) as { actions: { pattern: string; action: string }[] };
          cachedEscalatedPatterns = plan.actions.filter((a) => a.action === "escalate").map((a) => a.pattern);
          lastPlanFetchAt = now;
        } catch {
          // Keep whatever was last cached for this world (null if nothing
          // ever succeeded): resolvedPendingCount() below falls back to the
          // staged count alone rather than reading this as "zero".
        }
      }

      // A slow response for a world the operator has since left must not
      // overwrite the badge now showing the world they are actually on.
      if (requestWorld === appState.world) {
        pendingCount = resolvedPendingCount(stagedPatterns, cachedEscalatedPatterns);
      }
    } finally {
      const { rerun, next: afterFinish } = finishPoll(pollState);
      pollState = afterFinish;
      // A forced request queued while this poll ran: honor it right away
      // instead of waiting for the next tick or the cache to expire.
      if (rerun) void refreshStatus(true);
    }
  }

  // A plugin update rewrites dist/ under a page that already holds the old JS.
  // Static files are read from disk per request, so a reload gives the UI the new
  // build. The server process keeps running the bundle it started with until it
  // is restarted, and that is what server_stale reports.
  async function checkBuild() {
    try {
      const info = (await call("health.build", {})) as { build: string | null; server_stale: boolean };
      // The first answer defines what "loaded" means: nothing in the page says
      // which build produced it, and this poll runs seconds after it was served.
      loadedBuild ??= info.build;
      diskBuild = info.build;
      serverStale = info.server_stale;
    } catch {
      // A failed poll says nothing about the build on disk. Keep the last answer.
    }
  }

  onMount(() => {
    captureToken();
    dropReloadParam();
    window.addEventListener("hashchange", onHashChange);
    loadWorlds().then(() => refreshStatus(true));
    checkBuild();
    const stopThemeWatch = watchSystemTheme(() => applyTheme(themeMode));
    // Growing past the overlay width must not leave the page inert.
    const wide = matchMedia("(min-width: 45.0625rem)");
    const onWide = () => wide.matches && (navOpen = false);
    wide.addEventListener("change", onWide);
    const timer = setInterval(refreshStatus, STATUS_INTERVAL_MS);
    const buildTimer = setInterval(checkBuild, BUILD_INTERVAL_MS);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      stopThemeWatch();
      wide.removeEventListener("change", onWide);
      clearInterval(timer);
      clearInterval(buildTimer);
    };
  });

  // Navigating or switching world reloads the panes, so the rail refreshes
  // with them and never shows a count from the world you just left.
  $effect(() => {
    void hash;
    void appState.world;
    const seq = appState.statusSeq;
    // statusSeq is bumped after an action that can change what is escalated
    // (accept, reject, a create-proposal): force a fresh plan read instead
    // of waiting out the 60s cache. A bare pane or world navigation (seq
    // unchanged) still refreshes review.queue but respects the plan cache.
    const forcePlan = seq !== lastStatusSeq;
    lastStatusSeq = seq;
    refreshStatus(forcePlan);
  });

  const pane = $derived(PANES[hash]!);
  const ActivePane = $derived(pane.component);
  // null (nothing successfully loaded yet) reads as 0 in the rail badge,
  // same as before this was nullable: a badge that cannot yet say a real
  // number just stays hidden rather than show "0" as if it were known.
  const pendingBadge = $derived(pendingCount ?? 0);
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && closeNav()} />

<div class="app" class:nav-open={navOpen}>
  <aside class="rail" id="rail" bind:this={rail}>
    <div class="brand">
      <span class="brand__mark" aria-hidden="true">sil</span>
      <span class="brand__text">
        <span class="brand__name">Self-improvement loop</span>
        <span class="brand__version" title="self-improvement-loop version">v{__SIL_VERSION__}</span>
      </span>
    </div>

    <nav class="rail__nav" aria-label="Panes">
      {#each GROUPS as group}
        <div class="rail__group">
          <p class="rail__label">{group.label}</p>
          {#each group.names as name}
            <a
              href={`#/${name}`}
              class="rail__link"
              class:is-active={name === hash}
              aria-current={name === hash ? "page" : undefined}
              title={PANES[name]!.title}
              aria-label={name === "review" && pendingBadge > 0 ? `${PANES[name]!.title}, ${pendingBadge} waiting` : PANES[name]!.title}
            >
              <Icon name={name as IconName} />
              <span class="rail__text">{PANES[name]!.title}</span>
              {#if name === "review" && pendingBadge > 0}
                <span class="rail__count" aria-label={`${pendingBadge} waiting`}>{pendingBadge}</span>
              {/if}
            </a>
          {/each}
        </div>
      {/each}
    </nav>

    <div class="rail__foot">
      <p class="status-line" title={workerText}>
        <span class={`dot ${workerDot}`}></span>
        <span>{workerText}</span>
      </p>
      <div class="segmented" role="group" aria-label="Theme">
        {#each THEME_MODES as mode}
          <button
            type="button"
            aria-pressed={themeMode === mode}
            aria-label={THEME_LABELS[mode]}
            title={THEME_LABELS[mode]}
            onclick={() => chooseTheme(mode)}
          >
            <Icon name={mode} size={14} />
          </button>
        {/each}
      </div>
      <p class="rail__note">Local console. Nothing here leaves this machine until you push a branch.</p>
    </div>
  </aside>
  <button class="scrim" type="button" aria-label="Close navigation" tabindex="-1" onclick={closeNav}></button>

  <div class="column" inert={navOpen}>
    <header class="topbar">
      <button
        class="icon-button ghost menu-button"
        type="button"
        aria-label="Open navigation"
        aria-controls="rail"
        aria-expanded={navOpen}
        bind:this={menuButton}
        onclick={() => (navOpen = true)}
      >
        <Icon name="menu" />
      </button>
      <p class="crumbs">
        <span class="crumbs__world">{appState.world}</span>
        <span class="crumbs__world" aria-hidden="true">/</span>
        <strong>{pane.title}</strong>
      </p>
      <div class="topbar__tools">
        {#if serverStale}
          <span class="chip warn" title="A reload cannot fix this: the process runs the bundle it started with. Restart `sil web`.">Server older than build</span>
        {/if}
        <label class="visually-hidden" for="world-select">World</label>
        <select id="world-select" value={appState.world} onchange={onWorldChange} title="World">
          {#each appState.worldNames as name}
            <option value={name}>{name}</option>
          {/each}
        </select>
        {#if newBuild}
          <button class="primary small" title="A newer plugin build is on disk. Reload to run it." onclick={() => reloadForBuild(diskBuild)}>
            <Icon name="reload" size={13} />New build: reload
          </button>
        {:else}
          <button class="icon-button ghost" aria-label="Reload UI" title="Reload the UI from disk." onclick={() => reloadForBuild(diskBuild)}>
            <Icon name="reload" />
          </button>
        {/if}
      </div>
    </header>

    <main>
      <div class="page-head">
        <h1>{pane.title}</h1>
        <p>{pane.blurb}</p>
      </div>
      <div class="pane-transition">
        {#key `${hash}:${appState.world}`}
          <ActivePane />
        {/key}
      </div>
    </main>
  </div>
</div>

<Toast />
