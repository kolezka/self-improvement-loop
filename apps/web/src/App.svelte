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

  const PANES: Record<string, Component> = {
    overview: Overview,
    queue: Queue,
    reflections: Reflections,
    review: Review,
    artifacts: Artifacts,
    loop: Loop,
    models: Models,
    worlds: Worlds,
    logs: Logs,
  };
  const PANE_NAMES = Object.keys(PANES);

  function currentHash(): string {
    const raw = window.location.hash.replace(/^#\/?/, "");
    const name = raw.split("/")[0] || "overview";
    return PANES[name] ? name : "overview";
  }

  let hash = $state(currentHash());
  let workerBadge = $state("worker: ...");

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
      toast(`could not load worlds: ${(e as Error).message}`);
    }
  }

  async function refreshWorkerBadge() {
    try {
      const status = (await call("worker.status", {})) as { lock_held: boolean; pending: number };
      workerBadge = `worker: ${status.lock_held ? "running" : "idle"}, pending ${status.pending}`;
    } catch {
      workerBadge = "worker: unknown";
    }
  }

  onMount(() => {
    captureToken();
    window.addEventListener("hashchange", onHashChange);
    loadWorlds().then(refreshWorkerBadge);
    return () => window.removeEventListener("hashchange", onHashChange);
  });

  // Refresh the worker badge on every navigation, same as the status line
  // being rebuilt on each route() call in the original vanilla JS UI.
  $effect(() => {
    void hash;
    refreshWorkerBadge();
  });

  const ActivePane = $derived(PANES[hash]);
</script>

<header>
  <h1>self-improvement-loop</h1>
  <nav>
    {#each PANE_NAMES as name}
      <a href={`#/${name}`} class:active={name === hash}>{name[0]!.toUpperCase() + name.slice(1)}</a>
    {/each}
  </nav>
</header>

<main>
  {#key `${hash}:${appState.world}`}
    {#if ActivePane}
      <ActivePane />
    {/if}
  {/key}
</main>

<footer id="status-line">
  <span class="status-label">world:</span>
  <select bind:value={appState.world}>
    {#each appState.worldNames as name}
      <option value={name}>{name}</option>
    {/each}
  </select>
  <span class="badge">{workerBadge}</span>
  <span class="badge" title="self-improvement-loop version">v{__SIL_VERSION__}</span>
</footer>

<Toast />
