<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";
  import Skeleton from "../components/Skeleton.svelte";
  import RoleCard from "../components/models/RoleCard.svelte";
  import EndpointRow from "../components/models/EndpointRow.svelte";
  import { addressOf, reachOf, ROLE_LABEL, ROLES, type EndpointStatus, type LlmCfg, type ProviderStatus, type Role } from "../components/models/types.ts";

  interface WorldStatus {
    world: string;
    status: ProviderStatus | null;
    error: string | null;
  }

  let llm = $state<LlmCfg | null>(null);
  let providerStatus = $state<ProviderStatus | null>(null);
  let loading = $state(true);
  let editorText = $state("");
  let statuses = $state<WorldStatus[]>([]);
  let checkingAll = $state(false);
  let probingNames = $state<Set<string>>(new Set());

  const endpoints = $derived(llm?.endpoints ?? []);
  const activeName = $derived(llm?.active ?? null);
  const roleEndpoints = $derived<Partial<Record<Role, string>>>(llm?.role_endpoints ?? {});

  /** An llm.yaml written before per endpoint models may be missing fields. */
  function normalize(raw: LlmCfg): LlmCfg {
    return {
      endpoints: (raw.endpoints ?? []).map((e) => ({ ...e, models: e.models ?? {} })),
      active: raw.active ?? null,
      role_endpoints: raw.role_endpoints ?? {},
      local_models: raw.local_models ?? [],
      models: raw.models ?? {},
    };
  }

  async function load() {
    loading = true;
    try {
      const raw = (await call("llm.get", {})) as LlmCfg;
      llm = normalize(raw);
      editorText = JSON.stringify(raw, null, 2);
    } catch (e) {
      toast(`Could not load llm.yaml: ${(e as Error).message}`);
      loading = false;
      return;
    }
    await checkEndpoints();
    loading = false;
  }

  async function checkEndpoints() {
    try {
      providerStatus = (await call("llm.status", { world: appState.world })) as ProviderStatus;
    } catch (e) {
      providerStatus = null;
      toast(`Could not check the endpoints: ${(e as Error).message}`);
    }
  }

  /** Re-probes every endpoint (there is no single-endpoint probe op) but
   * tracks which row asked for it, so only that row's button shows the
   * spinner while the shared request is in flight. */
  async function probe(name: string) {
    probingNames = new Set(probingNames).add(name);
    try {
      await checkEndpoints();
    } finally {
      const next = new Set(probingNames);
      next.delete(name);
      probingNames = next;
    }
  }

  function statusOf(name: string): EndpointStatus | null {
    return providerStatus?.endpoints.find((e) => e.name === name) ?? null;
  }

  /** The endpoint status that actually serves a role, straight from
   * llm.status, so the role card agrees with the endpoint table. */
  function ownerFor(role: Role): EndpointStatus | null {
    return providerStatus?.endpoints.find((e) => e.roles.includes(role)) ?? null;
  }

  function modelFor(role: Role): string | null {
    return providerStatus?.models[role] ?? null;
  }

  /** Local vs hosted per the same rule the engine enforces: the resolved
   * model name must appear in llm.yaml's local_models list. Null while the
   * model or the config has not loaded yet. */
  function localFor(role: Role): boolean | null {
    const model = modelFor(role);
    if (!model || !llm) return null;
    return llm.local_models.includes(model);
  }

  async function saveLlm(next: LlmCfg, message: string) {
    try {
      await call("llm.set", { llm: next });
      toast(message, "ok");
      await load();
    } catch (e) {
      toast(`Could not save llm.yaml: ${(e as Error).message}`);
    }
  }

  async function useForAllRoles(name: string) {
    try {
      await call("llm.use", { endpoint: name });
      toast(`Every role now uses ${name}`, "ok");
      await load();
    } catch (e) {
      toast(`Could not switch to ${name}: ${(e as Error).message}`);
    }
  }

  /** "Follow the active endpoint" has no llm.use spelling (it takes a
   * mandatory endpoint name), so clearing the override still goes through
   * llm.set. Picking a real endpoint goes through llm.use, which also runs
   * the kind guard (a system-one endpoint cannot serve critic or drafter). */
  async function applyRoleEndpoint(role: Role, value: string) {
    if (value === "") {
      if (!llm) return;
      const role_endpoints = { ...llm.role_endpoints };
      delete role_endpoints[role];
      await saveLlm({ ...llm, role_endpoints }, `${ROLE_LABEL[role]} follows the active endpoint`);
      return;
    }
    try {
      await call("llm.use", { endpoint: value, role });
      toast(`${ROLE_LABEL[role]} now routes to ${value}`, "ok");
      await load();
    } catch (e) {
      toast(`Could not switch ${ROLE_LABEL[role]} to ${value}: ${(e as Error).message}`);
    }
  }

  async function saveRaw() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(editorText);
    } catch (e) {
      toast(`This is not valid JSON, fix it and save again: ${(e as Error).message}`);
      return;
    }
    try {
      await call("llm.set", { llm: parsed });
      toast("llm.yaml saved", "ok");
      await load();
    } catch (e) {
      toast(`Could not save llm.yaml: ${(e as Error).message}`);
    }
  }

  async function checkAllWorlds() {
    checkingAll = true;
    const results: WorldStatus[] = [];
    try {
      for (const world of appState.worldNames) {
        try {
          const s = (await call("llm.status", { world })) as ProviderStatus;
          results.push({ world, status: s, error: null });
        } catch (e) {
          results.push({ world, status: null, error: (e as Error).message });
        }
      }
      statuses = results;
    } finally {
      checkingAll = false;
    }
  }

  /** The active endpoint carries the summary fields (kind, base_url, reachable) for the card head. */
  function activeEndpointOf(status: ProviderStatus): EndpointStatus | null {
    return status.endpoints.find((e) => e.active) ?? status.endpoints.find((e) => e.name === status.endpoint) ?? null;
  }

  onMount(load);
</script>

<div class="toolbar">
  <button onclick={load}>Reload</button>
  <button onclick={checkEndpoints}>Check endpoints</button>
</div>

<p class="section-note">
  Each endpoint carries its own model names, so switching provider never rewrites them. llm.yaml stores
  only the name of the environment variable that holds a key, never the key value itself.
</p>

<h3 class="section-title">Roles</h3>
<div class="grid role-cards">
  {#each ROLES as role (role)}
    <RoleCard
      {role}
      label={ROLE_LABEL[role]}
      {endpoints}
      {activeName}
      selected={roleEndpoints[role] ?? ""}
      status={ownerFor(role)}
      model={modelFor(role)}
      local={localFor(role)}
      {loading}
      onApply={(value) => applyRoleEndpoint(role, value)}
    />
  {/each}
</div>

<h3 class="section-title">Endpoints</h3>
{#if loading}
  <Skeleton height="10rem" />
{:else if endpoints.length === 0}
  <div class="empty">
    <strong>llm.yaml defines no endpoints.</strong>
    Run <code>sil init</code> to write a starter file, then reload this pane.
  </div>
{:else}
  <div class="panel">
    <div class="panel__body table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Endpoint</th>
            <th scope="col">Kind</th>
            <th scope="col">Base URL</th>
            <th scope="col">Key</th>
            <th scope="col">Roles</th>
            <th scope="col">Reachable</th>
            <th scope="col">Probe</th>
          </tr>
        </thead>
        <tbody>
          {#each endpoints as ep (ep.name)}
            <EndpointRow {ep} status={statusOf(ep.name)} {activeName} probing={probingNames.has(ep.name)} onProbe={() => probe(ep.name)} />
          {/each}
        </tbody>
      </table>
    </div>
    <div class="panel__body endpoint-actions">
      {#each endpoints as ep (ep.name)}
        <button onclick={() => useForAllRoles(ep.name)}>Use {ep.name} for every role</button>
      {/each}
    </div>
  </div>
{/if}

<h3 class="section-title">Provider status by world</h3>
<div class="toolbar">
  <button onclick={checkAllWorlds} disabled={checkingAll}>Check all worlds</button>
  {#if checkingAll}<span class="control">Checking every world now</span>{/if}
</div>

{#if statuses.length === 0}
  <div class="empty">
    <strong>No world checked yet.</strong>
    Use Check all worlds to ask every world which endpoint it would pick and whether that endpoint answers.
  </div>
{/if}

{#each statuses as s (s.world)}
  <div class="panel">
    <div class="panel__head">
      <h4>{s.world}</h4>
      {#if s.status}
        {@const active = activeEndpointOf(s.status)}
        {#if active}
          {@const reach = reachOf(active.reachable)}
          <span class="chip accent">{active.name}</span>
          <span class="chip">{active.kind}</span>
          <span class="mono muted">{addressOf(active)}</span>
          <span class="spacer"></span>
          <span class="reach">
            <span class="dot {reach.dot}"></span>
            <span class={reach.tone}>{reach.text}</span>
          </span>
        {:else}
          <span class="muted">No active endpoint</span>
        {/if}
      {/if}
    </div>
    <div class="panel__body">
      {#if s.error}
        <p class="notice error">Could not read this world: {s.error}</p>
      {:else if s.status}
        {@const active = activeEndpointOf(s.status)}
        {#if s.status.error}<p class="notice error">{s.status.error}</p>{/if}
        {#if active?.error}<p class="notice warn">{active.name}: {active.error}</p>{/if}
        {#if s.status.endpoints.length === 0}
          <div class="empty">
            <strong>This world has no endpoints.</strong>
            Add one in the advanced editor below, then check again.
          </div>
        {:else}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Endpoint</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Address</th>
                  <th scope="col">Roles</th>
                  <th scope="col">Reachable</th>
                </tr>
              </thead>
              <tbody>
                {#each s.status.endpoints as ep (ep.name)}
                  {@const reach = reachOf(ep.reachable)}
                  <tr>
                    <td>
                      {ep.name}
                      {#if ep.active}<span class="badge accent">active</span>{/if}
                    </td>
                    <td>{ep.kind}</td>
                    <td class="mono">{addressOf(ep)}</td>
                    <td>
                      {#each ep.roles as role (role)}<span class="chip">{ROLE_LABEL[role]}</span>{:else}<span class="muted">none</span>{/each}
                    </td>
                    <td>
                      <span class="reach">
                        <span class="dot {reach.dot}"></span>
                        <span class={reach.tone}>{reach.text}</span>
                      </span>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/each}

<details class="panel advanced-editor">
  <summary>Advanced: edit llm.yaml</summary>
  <div class="panel__body">
    <div class="field editor">
      <label for="llm-editor">Endpoints and routing, JSON view</label>
      <textarea id="llm-editor" spellcheck="false" bind:value={editorText}></textarea>
      <span class="hint">Edited as JSON. It is parsed and validated before it is written back to llm.yaml.</span>
    </div>
    <div class="toolbar">
      <button onclick={load}>Reload</button>
      <button class="primary" onclick={saveRaw}>Save raw llm.yaml</button>
    </div>
  </div>
</details>

<style>
  /* models */
  .reach {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--fs-xs);
  }

  .role-cards {
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    margin-bottom: 1.1rem;
  }

  .endpoint-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    border-top: 1px solid var(--border);
  }

  .advanced-editor {
    margin-top: 1.1rem;
  }

  .advanced-editor summary {
    cursor: pointer;
    padding: 0.6rem 0.9rem;
    font-weight: 600;
  }

  /* The editor is the content of its panel, so it drops the .field measure. */
  .field.editor {
    max-width: none;
  }

  .field.editor textarea {
    width: 100%;
    min-height: 22rem;
    resize: vertical;
  }
</style>
