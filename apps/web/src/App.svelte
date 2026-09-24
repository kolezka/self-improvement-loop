<script lang="ts">
  import type { Component } from "svelte";
  import { onMount, tick } from "svelte";
  import { captureToken, call, dropReloadParam, reloadForBuild } from "./lib/api.ts";
  import { appState, toast } from "./lib/state.svelte.ts";
  import { applyTheme, loadThemeMode, saveThemeMode, THEME_MODES, watchSystemTheme, type ThemeMode } from "./lib/theme.ts";
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
  let stagedCount = $state(0);
  let statusPending = false;
  // The build this page was served from, and the build on disk now. They differ
  // after a plugin update, which is what the reload button is for.
  let loadedBuild = $state<string | null>(null);
  let diskBuild = $state<string | null>(null);
  let serverStale = $state(false);
  const newBuild = $derived(diskBuild !== null && diskBuild !== loadedBuild);

  function onHashChange() {
    hash = currentHash();
    navOpen = false;
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
   * timer. */
  async function refreshStatus() {
    if (statusPending) return;
    statusPending = true;
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

      try {
        const items = (await call("review.queue", { world: appState.world })) as unknown[];
        stagedCount = items.length;
      } catch {
        stagedCount = 0;
      }
    } finally {
      statusPending = false;
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
    loadWorlds().then(refreshStatus);
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
    void appState.statusSeq;
    refreshStatus();
  });

  const pane = $derived(PANES[hash]!);
  const ActivePane = $derived(pane.component);
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
              aria-label={name === "review" && stagedCount > 0 ? `${PANES[name]!.title}, ${stagedCount} staged` : PANES[name]!.title}
            >
              <Icon name={name as IconName} />
              <span class="rail__text">{PANES[name]!.title}</span>
              {#if name === "review" && stagedCount > 0}
                <span class="rail__count" aria-label={`${stagedCount} staged`}>{stagedCount}</span>
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
        <select id="world-select" bind:value={appState.world} title="World">
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
      {#key `${hash}:${appState.world}`}
        <ActivePane />
      {/key}
    </main>
  </div>
</div>

<Toast />
