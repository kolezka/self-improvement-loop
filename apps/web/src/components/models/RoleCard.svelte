<script lang="ts">
  import Skeleton from "../Skeleton.svelte";
  import { reachOf, type EndpointCfg, type EndpointStatus, type Role } from "./types.ts";

  interface Props {
    role: Role;
    label: string;
    endpoints: EndpointCfg[];
    activeName: string | null;
    selected: string;
    status: EndpointStatus | null;
    model: string | null;
    local: boolean | null;
    loading: boolean;
    onApply: (value: string) => void;
  }

  let { role, label, endpoints, activeName, selected, status, model, local, loading, onApply }: Props = $props();

  let draftValue = $state(selected);
  $effect(() => {
    draftValue = selected;
  });

  const reach = $derived(status ? reachOf(status.reachable) : null);
</script>

<div class="panel role-card">
  <div class="panel__head">
    <h4>{label}</h4>
    <span class="spacer"></span>
    {#if loading}
      <Skeleton width="4.5rem" height="1rem" />
    {:else if reach}
      <span class="reach">
        <span class="dot {reach.dot}"></span>
        <span class={reach.tone}>{reach.text}</span>
      </span>
    {/if}
  </div>
  <div class="panel__body">
    {#if loading}
      <Skeleton height="1rem" width="80%" />
      <div style:margin-top="0.4rem"><Skeleton height="1rem" width="55%" /></div>
    {:else if status}
      <p class="meta role-card__meta">
        <span class="mono">{status.name}</span>
        {#if model}<span class="mono">{model}</span>{/if}
        {#if local !== null}
          <span class="chip {local ? 'ok' : ''}">{local ? "local" : "hosted"}</span>
        {/if}
      </p>
      {#if status.error}
        <p class="notice {status.reachable === false ? 'error' : 'warn'}">{status.error}</p>
      {/if}
    {:else}
      <p class="muted">No endpoint serves {label.toLowerCase()} yet.</p>
    {/if}

    <label class="control role-card__switch" for={`role-card-${role}`}>
      <span>Endpoint</span>
      <select id={`role-card-${role}`} bind:value={draftValue}>
        <option value="">Follow the active endpoint ({activeName ?? "none"})</option>
        {#each endpoints as ep (ep.name)}
          <option value={ep.name}>{ep.name}</option>
        {/each}
      </select>
    </label>
    <button disabled={draftValue === selected} onclick={() => onApply(draftValue)}>Apply</button>
  </div>
</div>

<style>
  /* models */
  .role-card__meta {
    margin-bottom: 0.5rem;
  }

  .role-card__switch {
    max-width: none;
    margin: 0.6rem 0 0.5rem;
  }
</style>
