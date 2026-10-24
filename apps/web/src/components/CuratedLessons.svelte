<script lang="ts">
  // Curated lessons: a view over one CuratedSession. The session owns reads,
  // writes, routes and snapshots; this file owns markup, focus and timers.
  import { onMount, tick } from "svelte";
  import type { CaptureSource, LessonView } from "@sil/core/lesson-curation";
  import { authHeaders } from "../lib/api.ts";
  import { appState, leaveGuards, toast } from "../lib/state.svelte.ts";
  import * as cl from "../lib/curated-lessons.ts";
  import { CuratedSession, errorText, sameKey, sameProject, type SessionView } from "../lib/curated-session.ts";

  // Fixed for this instance: a world change remounts the pane.
  const world = appState.world;
  const session = new CuratedSession({
    world,
    fetch: ((input, init) => window.fetch(input, init)) as typeof fetch,
    headers: authHeaders,
    origin: window.location.origin,
    storage: () => window.sessionStorage,
    hash: () => window.location.hash,
    replaceHash: (hash) => history.replaceState(null, "", hash),
    toast,
    requestLeave: (proceed) => leaveGuards.request(proceed),
    setWorld: (next) => {
      appState.world = next;
    },
    openReview: (pattern) => {
      appState.openReviewPattern = pattern;
      window.location.hash = "#/review";
    },
    uuid: () => crypto.randomUUID(),
    timeoutMs: cl.MUTATION_TIMEOUT_MS,
    now: () => Date.now(),
  });
  let v = $state<SessionView>(session.view);
  session.subscribe(() => {
    v = session.view;
  });

  let purgeConfirm = $state(false);
  let leaveDialog = $state<HTMLElement | null>(null);
  let editorTextarea = $state<HTMLTextAreaElement | null>(null);
  let editorSection = $state<HTMLElement | null>(null);

  const editor = $derived(v.editor);
  const installationId = $derived(v.store?.state === "ready" ? v.store.installationId : null);
  const selectedChoice = $derived(v.project === null ? null : (v.choices.find((c) => sameProject(c.scope.project, v.project!)) ?? null));
  const loaded = $derived(editor.gate === "ready" ? editor.loaded : null);
  const showExtras = $derived(v.extras !== null && loaded !== null && sameKey(v.extras.key, loaded.key) && editor.gate === "ready");
  const stale = $derived(editor.loaded !== null && editor.base !== null && editor.loaded.revision > editor.base.revision);

  $effect(() => {
    if (v.leavePrompt !== null) void tick().then(() => leaveDialog?.querySelector<HTMLElement>("button")?.focus());
  });

  /** Runs an action, then puts focus back if the pressed control vanished or was disabled. */
  async function act(action: () => unknown): Promise<void> {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await action();
    await restoreFocus(returnTo);
  }

  async function restoreFocus(returnTo: HTMLElement | null): Promise<void> {
    await tick();
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (!lost) return;
    const usable = (el: HTMLElement | null | undefined) => el && el.isConnected && !(el as HTMLButtonElement).disabled;
    const next = usable(returnTo) ? returnTo : usable(editorTextarea) ? editorTextarea : editorSection?.querySelector<HTMLElement>("button:not(:disabled)");
    next?.focus();
  }

  function stay(): void {
    session.stay();
    editorTextarea?.focus();
  }

  function startCapture(): void {
    session.startCapture();
    void tick().then(() => editorTextarea?.focus());
  }

  function rebase(): void {
    session.rebase();
    // The button that was pressed is gone now; keep the person in the editor.
    void tick().then(() => editorTextarea?.focus());
  }

  function purge(): void {
    purgeConfirm = false;
    void act(() => session.submit({ kind: "purge", confirmed: true }));
  }

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  function onSearchInput(event: Event & { currentTarget: HTMLInputElement }): void {
    session.setSearch(event.currentTarget.value);
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void session.reloadList(), 250);
  }

  function onProjectSelect(event: Event & { currentTarget: HTMLSelectElement }): void {
    const next = event.currentTarget.value;
    // Keep showing the current project until the session accepts the change.
    event.currentTarget.value = v.project === null ? "" : cl.flatProject(v.project);
    session.selectProject(next);
  }

  const clockTime = (ms: number): string => new Date(ms).toLocaleTimeString();
  function freshness(at: number | null, stale: boolean): string {
    if (at === null) return stale ? "Could not load yet." : "";
    return stale ? `Showing what was loaded at ${clockTime(at)}. The last refresh failed.` : `Loaded at ${clockTime(at)}.`;
  }

  /** Escape inside the editor or the leave prompt: back out one step, never past a dirty draft. */
  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const inside = (el: HTMLElement | null) => el !== null && event.target instanceof Node && el.contains(event.target);
    if (v.leavePrompt !== null && (inside(leaveDialog) || inside(editorSection))) {
      event.preventDefault();
      stay();
    } else if (inside(editorSection)) {
      event.preventDefault();
      if (purgeConfirm) purgeConfirm = false;
      else session.closeEditor();
    }
  }

  const optionalText = (value: string): string | null => (value === "" ? null : value);

  onMount(() => {
    const owner = leaveGuards.register((proceed) => session.guardLeave(proceed));
    void session.mount();
    const onRoute = (event: HashChangeEvent) => session.onRouteChange(new URL(event.oldURL).hash);
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (session.dirty) event.preventDefault();
    };
    const onFocus = () => void session.refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void session.refresh();
    }, cl.REFRESH_INTERVAL_MS);
    window.addEventListener("hashchange", onRoute);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      if (searchTimer) clearTimeout(searchTimer);
      window.removeEventListener("hashchange", onRoute);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("focus", onFocus);
      session.dispose();
      leaveGuards.unregister(owner);
    };
  });

  // --- display ------------------------------------------------------------------

  function statusLine(): { tone: "ok" | "warn" | "err" | "info"; text: string } | null {
    const e = editor;
    if (e.target === null) return null;
    if (e.gate === "mismatch") return { tone: "err", text: errorText("INSTALLATION_MISMATCH") };
    switch (e.phase) {
      case "saving":
        return { tone: "info", text: "Saving." };
      case "unknown":
        return { tone: "warn", text: `Save outcome unknown. Request ${e.pending?.requestId ?? ""} may or may not have been saved.` };
      case "conflict":
        return { tone: "warn", text: errorText(e.error?.code ?? "CURATION_CONFLICT") };
      case "purged":
        if (v.purgeCheck === "verified") return { tone: "ok", text: "Purged. Its curated wording, quotes and history are gone from this installation." };
        if (v.purgeCheck === "unavailable") return { tone: "warn", text: "Purge recorded, but the stored copy could not be checked. Its content stays hidden here." };
        return { tone: "info", text: "Purged. Checking the stored copy." };
      case "error":
        return e.error ? { tone: "err", text: errorText(e.error.code, e.error.fields) } : null;
      case "saved":
        return v.confirmed ? { tone: "ok", text: v.confirmed } : { tone: "info", text: "Saved. Checking the stored copy." };
      default:
        if (e.error) return { tone: "err", text: errorText(e.error.code, e.error.fields) };
        if (e.gate !== "ready") return { tone: "info", text: "Loading the stored copy." };
        return null;
    }
  }

  function statusChip(view: LessonView): { text: string; tone: string } {
    switch (view.sourceStatus) {
      case "saved":
        return { text: "saved", tone: "ok" };
      case "queued":
        return { text: "in delivery inbox", tone: "" };
      case "archived":
        return { text: "delivered (archived)", tone: "" };
      case "changed":
        return { text: "source changed", tone: "warn" };
      case "missing":
        return { text: "source missing", tone: "warn" };
      case "conflict":
        return { text: "source conflict", tone: "err" };
      case "invalid":
        return { text: "source unreadable", tone: "err" };
      case "purged":
        return { text: "purged", tone: "" };
    }
  }

  function assurance(source: CaptureSource): string {
    const base = source.kind === "explicit_quote" ? "Quote pasted by you. Not checked against a transcript." : "Selected in the console. Not verified against a transcript.";
    return source.quoteRedacted ? `${base} Redacted by you.` : base;
  }

  const excerpt = (view: LessonView): string => view.effectiveText ?? view.originalText ?? "(no text)";
  const status = $derived(statusLine());
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="panel curated">
  <div class="panel__head">
    <h3 id="curated-heading">Curated lessons</h3>
    {#if installationId}
      <span class="badge mono curated__installation" title="SIL installation">installation {installationId}</span>
    {:else if v.store?.state === "uninitialized"}
      <span class="badge">no saved lessons yet</span>
    {/if}
  </div>
  <div class="panel__body">
    {#if v.handshakeError}
      <div class="notice error" role="alert">{v.handshakeError} <button class="small" onclick={() => void session.handshake()}>Try again</button></div>
    {/if}
    {#if !v.storageWorks}
      <p class="muted small-note">This tab cannot remember pending saves across a reload. Unsaved wording is never kept on reload.</p>
    {/if}
    {#if v.foreignWorld}
      <div class="notice warn" role="status">
        This lesson link belongs to world <strong>{v.foreignWorld}</strong>, not {world}.
        {#if appState.worldNames.includes(v.foreignWorld)}
          <button class="small" onclick={() => session.switchWorld()}>Switch to world {v.foreignWorld}</button>
        {:else}
          That world is not configured here.
        {/if}
      </div>
    {/if}
    {#if v.routeError}
      <div class="notice error" role="alert">{v.routeError}</div>
    {/if}
    {#if v.block}
      <div class="notice error curated__block" role="alert">
        <p>
          {#if v.block.reason === "unknown-origin"}
            An earlier save was sent before this installation existed, and it is not known whether it created it. Nothing from installation {v.block.current} is shown as that save until it is checked.
          {:else if v.block.current === null}
            Different SIL installation. The server refused a read for installation {v.block.expected}. Nothing is shown or saved until it is checked again.
          {:else}
            Different SIL installation. This pane holds work for installation {v.block.expected}, but the server now has {v.block.current}. Nothing from {v.block.current} is shown, and nothing is saved.
          {/if}
        </p>
        <div class="actions">
          <button onclick={() => void session.refresh()}>Check again</button>
          {#if v.block.reason === "unknown-origin" && editor.pending}
            <button onclick={() => void act(() => session.checkOutcome())}>Check the earlier save</button>
          {/if}
          {#if v.block.current !== null}
            <button class="danger" onclick={() => session.browseCurrentInstead()}>Browse installation {v.block.current} instead</button>
          {/if}
        </div>
        {#if v.block.current !== null}
          <p class="small-note">Browsing the other installation keeps the earlier request IDs for later checks. Unsent wording is dropped after you confirm.</p>
        {/if}
      </div>
    {/if}

    <div class="curated__controls">
      <div class="field">
        <label for="curated-project">Project</label>
        <select id="curated-project" value={v.project === null ? "" : cl.flatProject(v.project)} onchange={onProjectSelect} disabled={v.choices.length === 0}>
          <option value="">Choose a project</option>
          {#each v.choices as choice (cl.flatProject(choice.scope.project))}
            <option value={cl.flatProject(choice.scope.project)}>{choice.label}{choice.available ? "" : " (not on this machine)"}</option>
          {/each}
        </select>
      </div>
      <div class="field">
        <label for="curated-search">Search curated lessons</label>
        <input id="curated-search" type="search" value={v.search} oninput={onSearchInput} placeholder="Text in the lesson" disabled={v.project === null || v.block !== null} />
      </div>
    </div>

    <div class="curated__filters" role="group" aria-label="Show">
      <button aria-pressed={v.filter === "saved"} onclick={() => session.setFilter("saved")} disabled={v.project === null || v.block !== null}>Saved</button>
      <button aria-pressed={v.filter === "inbox"} onclick={() => session.setFilter("inbox")} disabled={v.project === null || v.block !== null}>Delivery inbox</button>
      <button aria-pressed={v.filter === "archived"} onclick={() => session.setFilter("archived")} disabled={v.project === null || v.block !== null}>Archived</button>
      <button aria-pressed={v.filter === "important"} onclick={() => session.setFilter("important")} disabled={v.project === null || v.block !== null}>Important</button>
    </div>
    {#if v.filter === "archived"}
      <p class="muted small-note">Archived lessons were already delivered. Archiving is not deletion or retirement.</p>
    {/if}

    <div class="actions">
      <button class="primary" onclick={startCapture} disabled={v.project === null || session.binding === null || (selectedChoice !== null && selectedChoice.scope.project.kind === "project" && selectedChoice.root === null)}>
        New lesson
      </button>
      <button onclick={() => void session.refresh()} disabled={v.project === null && v.block === null}>Refresh</button>
      {#if v.listLoading}<span class="muted" aria-live="polite">Loading</span>{/if}
    </div>

    {#if v.block}
      <!-- The identity question above replaces the list; nothing here claims a browse. -->
    {:else if v.project === null}
      <p class="muted">Choose a project to see its curated lessons.</p>
    {:else}
      {#if v.listError}
        <div class="notice warn" role="status">Showing the last loaded list. {v.listError}</div>
      {/if}
      {#if v.listReadAt !== null || v.listStale}
        <p class="muted small-note" aria-live="polite">{freshness(v.listReadAt, v.listStale)}</p>
      {/if}
      {#if v.items.length === 0 && !v.listLoading}
        <p class="muted">No lessons here.</p>
      {:else}
        <ul class="list curated__list" aria-label="Curated lessons, {v.total} total">
          {#each v.items as item (`${item.key.kind}:${item.key.id}`)}
            <li>
              <button class="curated__item" aria-current={editor.target !== null && sameKey(editor.target.key, item.key) ? "true" : undefined} onclick={() => session.openLesson(item)}>
                <span class="row__title">
                  {#if item.important}<span class="chip warn">important</span>{/if}
                  <span class={`chip ${statusChip(item).tone}`}>{statusChip(item).text}</span>
                  <span class="muted">revision {item.revision}</span>
                </span>
                <span class="lesson-text lesson-text--clamped">{excerpt(item)}</span>
              </button>
            </li>
          {/each}
        </ul>
        {#if v.nextCursor !== null}
          <div class="actions"><button onclick={() => void session.reloadList(true)}>Load more</button></div>
        {/if}
      {/if}
    {/if}

    {#if v.leavePrompt}
      <div class="notice warn curated__prompt" role="alertdialog" aria-labelledby="curated-leave-text" bind:this={leaveDialog}>
        <p id="curated-leave-text">
          {#if v.leavePrompt.quarantined}
            This lesson's store changed. Leaving keeps the pending request ID so it can be checked later, and drops the unsent wording. A request already sent is not undone.
          {:else if v.sending || editor.phase === "unknown"}
            You have unsaved wording. A request already sent is not undone; its result will be checked by ID.
          {:else}
            You have unsaved wording.
          {/if}
        </p>
        <div class="actions">
          <button onclick={stay}>Stay</button>
          <button class="danger" onclick={() => session.discardAndGo()}>{v.leavePrompt.quarantined ? "Leave" : "Discard"}</button>
        </div>
      </div>
    {/if}

    {#if editor.target}
      <section class="curated__editor" aria-labelledby="curated-editor-heading" bind:this={editorSection}>
        <h4 id="curated-editor-heading">
          {editor.mode === "capture" ? "New lesson" : "Lesson"}
          <span class="muted mono">{editor.target.key.kind}:{editor.target.key.id}</span>
        </h4>

        {#if status}
          <p class={`curated__status ${status.tone === "err" ? "error" : status.tone}-text`} role="status" aria-live="polite">{status.text}</p>
        {/if}
        {#if v.detailError}
          <p class="warn-text" role="status">Could not refresh this lesson: {v.detailError}</p>
        {/if}
        {#if editor.mode === "existing" && (v.detailReadAt !== null || v.detailStale)}
          <p class="muted small-note">{freshness(v.detailReadAt, v.detailStale)}</p>
        {/if}
        {#if v.captureExists}
          <div class="actions">
            <button onclick={() => session.openExisting()}>Open the existing lesson</button>
          </div>
        {/if}

        {#if editor.phase === "unknown" && editor.pending}
          <div class="actions">
            <button onclick={() => void act(() => session.checkOutcome())}>Check outcome</button>
            {#if v.canRetry}<button onclick={() => void act(() => session.retry())}>Retry same request</button>{/if}
          </div>
        {/if}

        {#if editor.draft && editor.phase !== "purged"}
          {#if editor.mode === "capture"}
            <p class="notice">Review the exact text below. It is saved as written, stays on this machine, and is not installed or queued for learning.</p>
          {/if}
          <div class="field">
            <label for="curated-text">Lesson wording</label>
            <textarea
              id="curated-text"
              rows="5"
              bind:this={editorTextarea}
              value={editor.draft.text}
              oninput={(e) => session.editText(e.currentTarget.value)}
              disabled={editor.pending !== null}
            ></textarea>
          </div>
          {#if editor.mode === "capture" && editor.draft.source}
            <div class="field">
              <label for="curated-quote">Quote from the session</label>
              <textarea id="curated-quote" rows="3" value={editor.draft.source.quote ?? ""} oninput={(e) => session.editSource({ quote: optionalText(e.currentTarget.value) })} disabled={editor.pending !== null}></textarea>
              <span class="hint">{assurance(editor.draft.source)}</span>
            </div>
            <div class="field">
              <label for="curated-reference">Reference (optional)</label>
              <input id="curated-reference" value={editor.draft.source.reference ?? ""} oninput={(e) => session.editSource({ reference: optionalText(e.currentTarget.value) })} disabled={editor.pending !== null} />
              <span class="hint">A quote or a reference is required.</span>
            </div>
          {/if}
          {#if stale}
            <div class="notice warn" role="status">
              A newer version (revision {editor.loaded?.revision}) is stored. Your wording is kept.
              {#if editor.loaded}
                <span class="curated__stored">Stored wording: <span class="lesson-text">{editor.loaded.effectiveText ?? editor.loaded.originalText ?? ""}</span></span>
              {/if}
              <button class="small" onclick={rebase} disabled={editor.pending !== null}>Edit on top of the current version</button>
            </div>
          {/if}
          <div class="actions">
            <button class="primary" onclick={() => void act(() => session.submit({ kind: "save" }))} disabled={editor.pending !== null || !v.dirty}>Save</button>
            <button onclick={() => session.cancelEdit()} disabled={editor.pending !== null}>Cancel</button>
            {#if editor.mode === "existing" && loaded}
              <button aria-pressed={loaded.important} onclick={() => void act(() => session.submit({ kind: "important", value: !loaded!.important }))} disabled={editor.pending !== null}>
                {loaded.important ? "Important (click to unmark)" : "Mark important"}
              </button>
              <button class="danger" onclick={() => (purgeConfirm = true)} disabled={editor.pending !== null}>Purge</button>
            {/if}
          </div>
          {#if purgeConfirm && loaded}
            <div class="notice error" role="alertdialog" aria-labelledby="curated-purge-text">
              <p id="curated-purge-text">
                Purge lesson <span class="mono">{loaded.key.kind}:{loaded.key.id}</span> in world {loaded.key.world}? This removes its curated wording, quote, reference and change history from this installation's curation store, and cannot be undone. Original conversations, reflections, delivery inbox files, backups and other installations are not changed.
              </p>
              <div class="actions">
                <button onclick={() => (purgeConfirm = false)}>Keep</button>
                <button class="danger" onclick={purge}>Purge permanently</button>
              </div>
            </div>
          {/if}
        {/if}

        {#if loaded && showExtras && v.extras}
          <dl class="kv curated__meta">
            <dt>Revision</dt>
            <dd>{loaded.revision}</dd>
            <dt>Scope</dt>
            <dd>{session.scopeLabel(loaded.scope)}</dd>
            {#if loaded.originalText !== null && loaded.originalText !== loaded.effectiveText}
              <dt>Delivery text</dt>
              <dd class="lesson-text">{loaded.originalText}</dd>
            {/if}
          </dl>
          <h5>Source</h5>
          {#if v.extras.provenance.kind === "capture"}
            <p class="muted">{assurance(v.extras.provenance.source)}</p>
            {#if v.extras.provenance.source.quote}<blockquote class="lesson-text">{v.extras.provenance.source.quote}</blockquote>{/if}
            {#if v.extras.provenance.source.reference}<p class="mono">{v.extras.provenance.source.reference}</p>{/if}
          {:else if v.extras.provenance.kind === "existing_lesson" && v.extras.provenance.state === "available"}
            <p class="muted">
              From the delivery inbox ({v.extras.provenance.location === "active" ? "waiting" : v.extras.provenance.location === "archive" ? "already delivered" : "in both inbox and archive"}), pattern
              <span class="mono">{v.extras.provenance.pattern}</span>{#if v.extras.provenance.repo}, repo <span class="mono">{v.extras.provenance.repo}</span>{/if}.
            </p>
            <p class="muted">
              {#if v.extras.provenance.reflectionId}Source reflection <span class="mono">{v.extras.provenance.reflectionId}</span>.{:else}No source reflection recorded.{/if}
            </p>
          {:else if v.extras.provenance.kind === "existing_lesson" && v.extras.provenance.state === "conflict"}
            <p class="warn-text">The inbox and archive copies disagree. Nothing is changed until you choose.</p>
            {#each v.extras.provenance.copies as copy}
              <p class="muted">
                {copy.location}{#if copy.reflectionId}, reflection <span class="mono">{copy.reflectionId}</span>{/if}: <span class="lesson-text">{copy.text}</span>
              </p>
            {/each}
          {:else if v.extras.provenance.kind === "existing_lesson"}
            <p class="warn-text">The delivery source is {v.extras.provenance.problem === "missing" ? "gone" : "unreadable"}. The saved wording is kept.</p>
          {/if}
          {#if loaded.sourceStatus === "changed" && loaded.sourceDigest}
            <div class="actions"><button onclick={() => void act(() => session.submit({ kind: "acknowledge-source", digest: loaded!.sourceDigest! }))} disabled={editor.pending !== null}>Accept the current source</button></div>
          {/if}
          {#if loaded.relatedPattern}
            <div class="actions"><button onclick={() => session.openReview(loaded!.relatedPattern!)}>Open pattern {loaded.relatedPattern} in Review</button></div>
          {/if}
          <h5>History{#if v.extras.historyTotal !== null} <span class="muted">({v.extras.history?.length ?? 0} of {v.extras.historyTotal})</span>{/if}</h5>
          {#if v.extras.history === null && v.extras.historyError}
            <p class="warn-text">Could not load the history.</p>
          {:else if v.extras.history === null}
            <p class="muted">Loading history.</p>
          {:else if v.extras.history.length === 0}
            <p class="muted">No changes yet.</p>
          {:else}
            <ol class="curated__history">
              {#each v.extras.history as entry (entry.revision)}
                <li>
                  <span class="mono">r{entry.revision}</span> {entry.kind} <span class="muted">{entry.at}</span>
                  {#if entry.important !== null}<span class="muted">{entry.important ? "marked important" : "unmarked"}</span>{/if}
                  {#if entry.text !== null}<span class="lesson-text">{entry.text}</span>{/if}
                </li>
              {/each}
            </ol>
            {#if v.extras.historyCursor !== null}
              <div class="actions"><button onclick={() => void session.loadMoreHistory()}>Load older changes</button></div>
            {/if}
            {#if v.extras.historyError}
              <p class="warn-text">Could not load more history.</p>
            {/if}
          {/if}
        {/if}

        <div class="actions">
          <button onclick={() => session.closeEditor()}>Back to the list</button>
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  /* Shared warn and ok tints fall just under 4.5:1 in light: keep the tint, use body text. */
  .curated :global(.notice.warn),
  .curated :global(.chip.ok),
  .curated :global(.chip.warn) {
    color: var(--fg);
  }
  .curated .panel__head {
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .curated__installation {
    height: auto;
    max-width: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .curated__controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0 1rem;
  }
  .curated__controls .field {
    flex: 1 1 14rem;
    min-width: 0;
  }
  .curated__filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
  }
  .curated__filters button {
    color: var(--fg-soft);
  }
  .curated__filters button[aria-pressed="true"] {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
  }
  /* Control edges at 3:1 or better in both themes; the shared border token is lighter. */
  .curated textarea,
  .curated input,
  .curated select,
  .curated button:not(.primary, .danger, .curated__item) {
    border-color: var(--muted);
  }
  .curated button.danger {
    border-color: var(--err);
  }
  .small-note {
    font-size: var(--fs-xs);
  }
  .curated__list li {
    padding: 0;
  }
  .curated__item {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.3rem;
    width: 100%;
    min-height: 0;
    padding: 0.5rem 0.6rem;
    text-align: left;
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    white-space: normal;
  }
  .curated__item[aria-current="true"] {
    border-color: var(--accent);
  }
  .curated__item .row__title {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
  }
  .curated__editor {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
    min-width: 0;
  }
  .curated__editor h4 {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0 0 0.5rem;
    overflow-wrap: anywhere;
  }
  .curated__editor h5 {
    margin: 1rem 0 0.4rem;
  }
  .curated__editor textarea,
  .curated__editor input {
    width: 100%;
    box-sizing: border-box;
  }
  .curated__status {
    font-weight: 500;
  }
  .info-text {
    color: var(--fg-soft);
  }
  .curated__stored {
    display: block;
    margin: 0.4rem 0;
    overflow-wrap: anywhere;
  }
  .curated__prompt {
    margin: 1rem 0;
  }
  .curated__history {
    margin: 0;
    padding-left: 1.2rem;
  }
  .curated__history li {
    margin-bottom: 0.4rem;
    overflow-wrap: anywhere;
  }
  .curated__meta dd,
  blockquote {
    overflow-wrap: anywhere;
  }
  blockquote {
    margin: 0.4rem 0;
    padding-left: 0.8rem;
    border-left: 3px solid var(--border-strong);
  }
</style>
