<script lang="ts">
  import { addressOf, reachOf, ROLE_LABEL, type EndpointCfg, type EndpointStatus } from "./types.ts";

  interface Props {
    ep: EndpointCfg;
    status: EndpointStatus | null;
    activeName: string | null;
    probing: boolean;
    onProbe: () => void;
  }

  let { ep, status, activeName, probing, onProbe }: Props = $props();

  const reach = $derived(status ? reachOf(status.reachable) : null);
</script>

<tr>
  <td>
    {ep.name}
    {#if ep.name === activeName}<span class="badge accent">active</span>{/if}
  </td>
  <td>{ep.kind}</td>
  <td class="mono">{addressOf(ep)}</td>
  <td>
    {#if ep.api_key_env}
      <span class="mono">{ep.api_key_env}</span>
    {:else}
      <span class="muted">no key needed</span>
    {/if}
  </td>
  <td>
    {#if status && status.roles.length > 0}
      {#each status.roles as role (role)}<span class="chip">{ROLE_LABEL[role]}</span>{/each}
    {:else}
      <span class="muted">none</span>
    {/if}
  </td>
  <td>
    {#if probing}
      <span class="reach"><span class="dot busy"></span><span class="muted">Probing&hellip;</span></span>
    {:else if reach}
      <span class="reach">
        <span class="dot {reach.dot}"></span>
        <span class={reach.tone}>{reach.text}</span>
      </span>
      {#if status?.error}<p class="endpoint-row__error">{status.error}</p>{/if}
    {:else}
      <span class="muted">Not checked yet</span>
    {/if}
  </td>
  <td>
    <button onclick={onProbe} disabled={probing}>Probe</button>
  </td>
</tr>

<style>
  /* models */
  .endpoint-row__error {
    margin: 0.25rem 0 0;
    color: var(--err);
    font-size: var(--fs-xs);
  }

  /* Scoped styles do not reach here from Models.svelte; without this the dot
     is a zero-width inline span. Same fix as RoleCard. */
  .reach {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--fs-xs);
  }
</style>
