<script lang="ts">
  import type { Component } from "svelte";
  import { onMount } from "svelte";
  import { captureToken, call } from "./lib/api.ts";
  import { appState, toast } from "./lib/state.svelte.ts";
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

  function currentHash(): string {
    const raw = window.location.hash.replace(/^#\/?/, "");
    const name = raw.split("/")[0] || "overview";
    return PANES[name] ? name : "overview";
  }

  let hash = $state(currentHash());
  let workerDot = $state("");
  let workerText = $state("Checking the worker");
  let stagedCount = $state(0);
  let statusPending = false;

  function onHashChange() {
    hash = currentHash();
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

  onMount(() => {
    captureToken();
    window.addEventListener("hashchange", onHashChange);
    loadWorlds().then(refreshStatus);
    const timer = setInterval(refreshStatus, STATUS_INTERVAL_MS);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      clearInterval(timer);
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

<div class="app">
  <aside class="rail">
    <div class="brand">
      <p class="brand__name">sil <span>console</span></p>
    </div>
    <p class="brand__state">
      <span class={`dot ${workerDot}`}></span>{workerText}
      <span class="brand__version" title="self-improvement-loop version">v{__SIL_VERSION__}</span>
    </p>

    <nav aria-label="Panes">
      {#each GROUPS as group}
        <div class="rail__group">
          <p class="rail__label">{group.label}</p>
          {#each group.names as name}
            <a
              href={`#/${name}`}
              class="rail__link"
              class:is-active={name === hash}
              aria-current={name === hash ? "page" : undefined}
            >
              <span>{PANES[name]!.title}</span>
              {#if name === "review" && stagedCount > 0}
                <span class="rail__count">{stagedCount}</span>
              {/if}
            </a>
          {/each}
        </div>
      {/each}
    </nav>

    <p class="rail__foot">Local console. Nothing here leaves this machine until you push a branch.</p>
  </aside>

  <div class="column">
    <header class="topbar">
      <div>
        <h1>{pane.title}</h1>
        <p>{pane.blurb}</p>
      </div>
      <div class="topbar__tools">
        <label class="control" for="world-select">World</label>
        <select id="world-select" bind:value={appState.world}>
          {#each appState.worldNames as name}
            <option value={name}>{name}</option>
          {/each}
        </select>
      </div>
    </header>

    <main>
      {#key `${hash}:${appState.world}`}
        <ActivePane />
      {/key}
    </main>
  </div>
</div>

<Toast />
