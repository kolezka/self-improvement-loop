<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";

  type Role = "critic" | "drafter" | "judge";
  const ROLES: Role[] = ["critic", "drafter", "judge"];
  const ROLE_LABEL: Record<Role, string> = { critic: "Critic", drafter: "Drafter", judge: "Judge" };

  interface EndpointCfg {
    name: string;
    kind: string;
    base_url: string | null;
    api_key_env: string | null;
    timeout_s: number;
    models: Partial<Record<Role, string>>;
    extra_body: Record<string, unknown>;
  }

  interface LlmCfg {
    endpoints: EndpointCfg[];
    active: string | null;
    role_endpoints: Partial<Record<Role, string>>;
    local_models: string[];
    models: Partial<Record<Role, string>>;
  }

  interface EndpointStatus {
    name: string;
    kind: string;
    base_url: string | null;
    active: boolean;
    roles: Role[];
    models: Partial<Record<Role, string>>;
    reachable: boolean | null;
    error: string | null;
  }

  interface ProviderStatus {
    endpoint: string | null;
    models: Record<string, string | null>;
    endpoints: EndpointStatus[];
    error: string | null;
  }

  interface WorldStatus {
    world: string;
    status: ProviderStatus | null;
    error: string | null;
  }

  /** One reachability reading rendered three ways: dot, text colour, wording. */
  interface Reach {
    dot: string;
    tone: string;
    text: string;
  }

  let llm = $state<LlmCfg | null>(null);
  let providerStatus = $state<ProviderStatus | null>(null);
  let editorText = $state("");
  let statuses = $state<WorldStatus[]>([]);
  let dirty = $state(false);
  let checkingAll = $state(false);

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
    try {
      const raw = (await call("llm.get", {})) as LlmCfg;
      llm = normalize(raw);
      editorText = JSON.stringify(raw, null, 2);
      dirty = false;
    } catch (e) {
      toast(`Could not load llm.yaml: ${(e as Error).message}`);
      return;
    }
    await checkEndpoints();
  }

  async function checkEndpoints() {
    try {
      providerStatus = (await call("llm.status", { world: appState.world })) as ProviderStatus;
    } catch (e) {
      providerStatus = null;
      toast(`Could not check the endpoints: ${(e as Error).message}`);
    }
  }

  function statusOf(name: string): EndpointStatus | null {
    return providerStatus?.endpoints.find((e) => e.name === name) ?? null;
  }

  function reachOf(reachable: boolean | null): Reach {
    if (reachable === null) return { dot: "warn", tone: "warn-text", text: "Unknown" };
    if (reachable) return { dot: "ok", tone: "ok-text", text: "Reachable" };
    return { dot: "err", tone: "error-text", text: "Unreachable" };
  }

  /** Same reading as reachOf, plus the not yet checked case. The failure detail
   *  stays out of this text so a long error cannot stretch the panel head. */
  function endpointReach(name: string): Reach {
    const s = statusOf(name);
    if (!s) return { dot: "", tone: "muted", text: "Not checked yet" };
    return reachOf(s.reachable);
  }

  /** What the engine would actually call for a role, straight from llm.status. */
  function resolvedFor(role: Role): string | null {
    if (!providerStatus) return null;
    const owner = providerStatus.endpoints.find((e) => e.roles.includes(role));
    const model = providerStatus.models[role];
    if (!owner || !model) return null;
    return `${owner.name}: ${model}`;
  }

  function setModel(name: string, role: Role, value: string) {
    const endpoint = llm?.endpoints.find((e) => e.name === name);
    if (!endpoint) return;
    const models = { ...endpoint.models };
    if (value.trim() === "") delete models[role];
    else models[role] = value.trim();
    endpoint.models = models;
    dirty = true;
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

  async function saveEndpoints() {
    if (!llm) return;
    await saveLlm(llm, "Models saved");
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

  async function setRoleEndpoint(role: Role, value: string) {
    if (!llm) return;
    const role_endpoints = { ...llm.role_endpoints };
    if (value === "") delete role_endpoints[role];
    else role_endpoints[role] = value;
    const message = value === "" ? `${ROLE_LABEL[role]} follows the active endpoint` : `${ROLE_LABEL[role]} now routes to ${value}`;
    await saveLlm({ ...llm, role_endpoints }, message);
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

  function addressOf(ep: { kind: string; base_url: string | null }): string {
    return ep.kind === "claude-cli" ? "claude -p" : (ep.base_url ?? "no base_url set");
  }

  onMount(load);
</script>

<div class="toolbar">
  <button onclick={load}>Reload</button>
  <button onclick={checkEndpoints}>Check endpoints</button>
  <button class="primary" onclick={saveEndpoints} disabled={!dirty}>Save models</button>
  {#if dirty}<span class="chip warn">Unsaved model names</span>{/if}
</div>

<p class="section-note">
  Each endpoint carries its own model names, so switching provider never rewrites them. llm.yaml stores
  only the name of the environment variable that holds a key, never the key value itself.
</p>

<h3 class="section-title">Endpoints</h3>

{#each endpoints as ep (ep.name)}
  {@const reach = endpointReach(ep.name)}
  {@const checked = statusOf(ep.name)}
  <div class="panel">
    <div class="panel__head">
      <h4>{ep.name}</h4>
      <span class="chip">{ep.kind}</span>
      {#if ep.name === activeName}<span class="badge accent">active</span>{/if}
      <span class="spacer"></span>
      <span class="reach">
        <span class="dot {reach.dot}"></span>
        <span class={reach.tone}>{reach.text}</span>
      </span>
    </div>
    <div class="panel__body">
      {#if checked?.error}
        <p class="notice {checked.reachable === false ? 'error' : 'warn'}">Last check: {checked.error}</p>
      {/if}
      <p class="meta">
        <span class="mono">{addressOf(ep)}</span>
        {#if ep.api_key_env}
          <span>Key from <span class="mono">{ep.api_key_env}</span></span>
        {:else}
          <span>No key needed</span>
        {/if}
        <span>Timeout {ep.timeout_s} s</span>
      </p>
      <div class="grid models">
        {#each ROLES as role (role)}
          <div class="field">
            <label for={`model-${ep.name}-${role}`}>{ROLE_LABEL[role]} model</label>
            <input
              id={`model-${ep.name}-${role}`}
              class="mono"
              value={ep.models[role] ?? ""}
              placeholder="No model set"
              onchange={(e) => setModel(ep.name, role, e.currentTarget.value)}
            />
          </div>
        {/each}
      </div>
      <div class="toolbar">
        <button onclick={() => useForAllRoles(ep.name)}>Use for every role</button>
      </div>
    </div>
  </div>
{:else}
  <div class="empty">
    <strong>llm.yaml defines no endpoints.</strong>
    Run <code>sil init</code> to write a starter file, then reload this pane.
  </div>
{/each}

<h3 class="section-title">Role routing</h3>
<div class="panel">
  <div class="panel__head">
    <h4>Which endpoint serves each role</h4>
    <span class="spacer"></span>
    <span class="muted">Active endpoint: {activeName ?? "none"}</span>
  </div>
  <div class="panel__body">
    {#each ROLES as role (role)}
      {@const target = resolvedFor(role)}
      <div class="role-row">
        <label for={`role-${role}`}>{ROLE_LABEL[role]}</label>
        <select id={`role-${role}`} value={roleEndpoints[role] ?? ""} onchange={(e) => setRoleEndpoint(role, e.currentTarget.value)}>
          <option value="">Follow the active endpoint ({activeName ?? "none"})</option>
          {#each endpoints as ep (ep.name)}
            <option value={ep.name}>{ep.name}</option>
          {/each}
        </select>
        {#if target}
          <span class="muted mono">{target}</span>
        {:else}
          <span class="muted">Not resolved, check the endpoints first</span>
        {/if}
      </div>
    {/each}
  </div>
</div>

<h3 class="section-title">Raw llm.yaml</h3>
<div class="panel">
  <div class="panel__head">
    <h4>llm.yaml</h4>
    <span class="spacer"></span>
    <span class="muted">Applies to every world</span>
  </div>
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
</div>

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
            Add one in the raw editor above, then check again.
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
                  <th scope="col">Critic</th>
                  <th scope="col">Drafter</th>
                  <th scope="col">Judge</th>
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
                    {#each ROLES as role (role)}
                      <td class="mono">
                        {#if ep.models[role]}{ep.models[role]}{:else}<span class="muted">-</span>{/if}
                      </td>
                    {/each}
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

<style>
  .reach {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--fs-xs);
  }

  /* Three short model names fit far tighter than the shared card grid. */
  .grid.models {
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    gap: 0.75rem;
    margin-top: 0.7rem;
  }

  .grid.models .field {
    max-width: none;
    margin-bottom: 0;
  }

  .role-row {
    display: grid;
    grid-template-columns: 5rem minmax(10rem, 15rem) minmax(0, 1fr);
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--border);
  }

  .role-row:last-child {
    border-bottom: none;
  }

  .role-row label {
    color: var(--muted);
    font-size: var(--fs-xs);
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

  @media (max-width: 40rem) {
    .role-row {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.3rem;
    }
  }
</style>
