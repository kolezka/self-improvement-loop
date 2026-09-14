<script lang="ts">
  import { onMount } from "svelte";
  import { call } from "../lib/api.ts";
  import { appState, toast } from "../lib/state.svelte.ts";

  type Role = "critic" | "drafter" | "judge";
  const ROLES: Role[] = ["critic", "drafter", "judge"];

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
  }

  interface WorldStatus {
    world: string;
    text: string;
  }

  let llm = $state<LlmCfg | null>(null);
  let providerStatus = $state<ProviderStatus | null>(null);
  let editorText = $state("");
  let statuses = $state<WorldStatus[]>([]);
  let dirty = $state(false);

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
      toast(`could not load llm.yaml: ${(e as Error).message}`);
      return;
    }
    await checkEndpoints();
  }

  async function checkEndpoints() {
    try {
      providerStatus = (await call("llm.status", { world: appState.world })) as ProviderStatus;
    } catch (e) {
      providerStatus = null;
      toast(`could not check endpoints: ${(e as Error).message}`);
    }
  }

  function statusOf(name: string): EndpointStatus | null {
    return providerStatus?.endpoints.find((e) => e.name === name) ?? null;
  }

  function reachText(name: string): string {
    const s = statusOf(name);
    if (!s) return "not checked";
    if (s.reachable === null) return s.error ?? "unknown";
    return s.reachable ? "reachable" : `unreachable: ${s.error ?? "no detail"}`;
  }

  function reachClass(name: string): string {
    const s = statusOf(name);
    if (!s || s.reachable === null) return "muted";
    return s.reachable ? "ok-text" : "error-text";
  }

  /** What the engine would actually call for a role, straight from llm.status. */
  function resolvedFor(role: Role): string {
    if (!providerStatus) return "";
    const owner = providerStatus.endpoints.find((e) => e.roles.includes(role));
    const model = providerStatus.models[role];
    if (!owner || !model) return "not resolved";
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
      toast(`could not save: ${(e as Error).message}`);
    }
  }

  async function saveEndpoints() {
    if (!llm) return;
    await saveLlm(llm, "endpoint models saved");
  }

  async function useForAllRoles(name: string) {
    try {
      await call("llm.use", { endpoint: name });
      toast(`every role now uses ${name}`, "ok");
      await load();
    } catch (e) {
      toast(`could not switch: ${(e as Error).message}`);
    }
  }

  async function setRoleEndpoint(role: Role, value: string) {
    if (!llm) return;
    const role_endpoints = { ...llm.role_endpoints };
    if (value === "") delete role_endpoints[role];
    else role_endpoints[role] = value;
    await saveLlm({ ...llm, role_endpoints }, value === "" ? `${role} follows the active endpoint` : `${role} routed to ${value}`);
  }

  async function saveRaw() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(editorText);
    } catch (e) {
      toast(`not valid JSON: ${(e as Error).message}`);
      return;
    }
    try {
      await call("llm.set", { llm: parsed });
      toast("llm.yaml saved", "ok");
      await load();
    } catch (e) {
      toast(`could not save: ${(e as Error).message}`);
    }
  }

  async function checkAllWorlds() {
    const results: WorldStatus[] = [];
    for (const world of appState.worldNames) {
      try {
        const s = await call("llm.status", { world });
        results.push({ world, text: JSON.stringify(s, null, 2) });
      } catch (e) {
        results.push({ world, text: JSON.stringify({ error: (e as Error).message }, null, 2) });
      }
    }
    statuses = results;
  }

  onMount(load);
</script>

<h2>Models</h2>
<p class="muted">
  Each endpoint carries its own model names, so switching provider never rewrites them. llm.yaml never
  holds a secret value here, only the env var name it reads from.
</p>

<div class="actions">
  <button onclick={load}>Reload</button>
  <button onclick={checkEndpoints}>Check endpoints</button>
  <button class="primary" onclick={saveEndpoints} disabled={!dirty}>Save endpoint models</button>
</div>

<h3>Endpoints</h3>
{#each endpoints as ep (ep.name)}
  <div class="card">
    <div class="ep-head">
      <strong>{ep.name}</strong>
      <span class="chip">{ep.kind}</span>
      {#if ep.name === activeName}<span class="badge">active</span>{/if}
      <span class={reachClass(ep.name)}>{reachText(ep.name)}</span>
    </div>
    <div class="muted">
      {ep.kind === "claude-cli" ? "claude -p" : (ep.base_url ?? "(no base_url)")}
      {#if ep.api_key_env}&middot; key from {ep.api_key_env}{/if}
      &middot; timeout {ep.timeout_s}s
    </div>
    <div class="models">
      {#each ROLES as role (role)}
        <div class="field">
          <label for={`model-${ep.name}-${role}`}>{role}</label>
          <input
            id={`model-${ep.name}-${role}`}
            value={ep.models[role] ?? ""}
            placeholder="no model set"
            onchange={(e) => setModel(ep.name, role, e.currentTarget.value)}
          />
        </div>
      {/each}
    </div>
    <div class="actions">
      <button onclick={() => useForAllRoles(ep.name)}>Use for all roles</button>
    </div>
  </div>
{:else}
  <p class="muted">llm.yaml defines no endpoints. Run <code>sil init</code>.</p>
{/each}

<h3>Roles</h3>
<div class="card">
  {#each ROLES as role (role)}
    <div class="role-row">
      <label for={`role-${role}`}>{role}</label>
      <select id={`role-${role}`} value={roleEndpoints[role] ?? ""} onchange={(e) => setRoleEndpoint(role, e.currentTarget.value)}>
        <option value="">follow active ({activeName ?? "none"})</option>
        {#each endpoints as ep (ep.name)}
          <option value={ep.name}>{ep.name}</option>
        {/each}
      </select>
      <span class="muted">{resolvedFor(role)}</span>
    </div>
  {/each}
</div>

<h3>Raw llm.yaml</h3>
<div class="field">
  <label for="llm-editor">llm.yaml</label>
  <textarea id="llm-editor" rows="16" style="width:100%;font:12px monospace" bind:value={editorText}></textarea>
</div>
<div class="actions">
  <button class="primary" onclick={saveRaw}>Save raw</button>
</div>

<h3>Provider status by world</h3>
<div class="actions"><button onclick={checkAllWorlds}>Check all worlds</button></div>
<div>
  {#each statuses as s (s.world)}
    <div class="card">
      <strong>{s.world}</strong>
      <pre>{s.text}</pre>
    </div>
  {/each}
</div>

<style>
  .ep-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.2rem;
  }

  .models {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-top: 0.6rem;
  }

  .models .field {
    max-width: 16rem;
    margin-bottom: 0;
  }

  .role-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.3rem 0;
  }

  .role-row label {
    min-width: 5rem;
    color: var(--muted);
    font-size: 0.8rem;
  }
</style>
