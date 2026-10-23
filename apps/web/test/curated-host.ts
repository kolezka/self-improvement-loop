// Test-only in-memory curation host for CuratedSession tests. It answers the
// same HTTP shapes as the real server and enforces the parts of the host
// contract the session relies on: binding refusal on reads, precondition
// refusal on writes, expected-revision conflicts, CAPTURE_EXISTS and purge.
// Requests can be held so tests control completion order.

export const LOCATION = "d".repeat(64);
export const I = "11111111-1111-4111-8111-111111111111";
export const J = "22222222-2222-4222-8222-222222222222";
export const WORLD = "curation-test";
export const STAMP = "2026-10-22T10:00:00.000Z";
export const PROJECT_B = `p1_${"b".repeat(64)}`;

type Scope = { world: string; project: { kind: "world" } | { kind: "unresolved" } | { kind: "project"; id: string } };
type Key = { world: string; kind: "capture" | "inbox"; id: string };
type Source = Record<string, unknown>;
export interface Rec {
  key: Key;
  scope: Scope;
  revision: number;
  important: boolean;
  text: string | null;
  source: Source | null;
  purged: boolean;
  history: Array<{ revision: number; kind: string; at: string; text: string | null; important: boolean | null; oldSourceDigest: null; newSourceDigest: null }>;
}
export interface StoreData {
  installationId: string;
  records: Map<string, Rec>;
  receipts: Map<string, { key: Key; revision: number; payloadHash: string; purged: boolean }>;
}

export const quoteSource = (quote: string): Source => ({
  kind: "explicit_quote",
  quote,
  reference: null,
  quoteRedacted: false,
  captureSessionId: null,
  sourceConversationId: null,
  sourceRowId: null,
  sourceAgentId: null,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const keyId = (k: Key) => `${k.kind}:${k.id}`;
const sameScope = (a: Scope, b: Scope) => a.world === b.world && a.project.kind === b.project.kind && (a.project.kind !== "project" || a.project.id === (b.project as { id: string }).id);

function decodeKeyArg(encoded: string): Key {
  const text = Buffer.from(encoded, "base64url").toString("utf8");
  const [world, kind, id] = JSON.parse(text) as [string, "capture" | "inbox", string];
  return { world, kind, id };
}
function projectArg(value: string): Scope["project"] {
  return value === "world" || value === "unresolved" ? { kind: value } : { kind: "project", id: value };
}

export class FakeHost {
  stores = new Map<string, StoreData>();
  /** Installation at the data location now, or null when uninitialized. */
  current: string | null = null;
  calls: Array<{ method: string; path: string; query: Record<string, string>; body?: unknown }> = [];
  /** Reads of this path answer 503 STORAGE_BUSY until cleared. */
  failPath: string | null = null;
  #holds: Array<{ match: (method: string, path: string) => boolean; release: Promise<void>; respondFirst: boolean }> = [];
  /** Project choices per installation; absent means both default choices. */
  choicesFor = new Map<string, Array<"world" | "b">>();
  /** The next detail read answers for this key instead of the requested one. */
  wrongKeyOnce: Key | null = null;

  addStore(installationId: string): StoreData {
    const store: StoreData = { installationId, records: new Map(), receipts: new Map() };
    this.stores.set(installationId, store);
    return store;
  }

  seed(installationId: string, rec: Partial<Rec> & { key: Key; text: string }): Rec {
    const store = this.stores.get(installationId)!;
    const full: Rec = {
      scope: { world: WORLD, project: { kind: "world" } },
      revision: 1,
      important: false,
      source: quoteSource("seeded quote"),
      purged: false,
      history: [{ revision: 1, kind: "capture", at: STAMP, text: rec.text, important: null, oldSourceDigest: null, newSourceDigest: null }],
      ...rec,
    };
    store.records.set(keyId(full.key), full);
    return full;
  }

  /**
   * The next matching request waits until the returned function is called.
   * With respondFirst the host answers from its state now and only delivery waits.
   */
  hold(match: (method: string, path: string) => boolean, options: { respondFirst?: boolean } = {}): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.#holds.push({ match, release: gate, respondFirst: options.respondFirst ?? false });
    return release;
  }

  writes(method = "POST"): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://host");
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path, query, body });
    const index = this.#holds.findIndex((h) => h.match(method, path));
    const answer = () => (method === "POST" ? this.#mutate(path, body) : this.#read(path, query));
    if (index >= 0) {
      const [held] = this.#holds.splice(index, 1);
      if (held!.respondFirst) {
        const response = answer();
        await held!.release;
        return response;
      }
      await held!.release;
    }
    return answer();
  }) as typeof fetch;

  #identity() {
    return { locationId: LOCATION, installationId: this.current };
  }

  #readStore(binding: string): StoreData | null | Response {
    const [kind, id] = binding.split(":") as [string, string];
    if (kind === "installation") {
      if (this.current !== id) return json(409, { detail: "different SIL installation", code: "INSTALLATION_MISMATCH" });
    } else if (id !== LOCATION) return json(409, { detail: "different SIL installation", code: "INSTALLATION_MISMATCH" });
    return this.current === null ? null : this.stores.get(this.current)!;
  }

  #view(rec: Rec) {
    return {
      key: rec.key,
      scope: rec.scope,
      revision: rec.revision,
      important: rec.purged ? false : rec.important,
      effectiveText: rec.purged ? null : rec.text,
      originalText: null,
      source: rec.purged ? null : rec.source,
      sourceStatus: rec.purged ? "purged" : "saved",
      sourceDigest: null,
      baselineDigest: null,
      relatedPattern: null,
      created: STAMP,
      updated: STAMP,
    };
  }

  #read(path: string, q: Record<string, string>): Response {
    if (path === this.failPath) return json(503, { detail: "curation storage busy", code: "STORAGE_BUSY" });
    if (path === "/api/lessons/store") {
      return json(200, this.current === null ? { state: "uninitialized", binding: { kind: "location", id: LOCATION } } : { state: "ready", binding: { kind: "installation", id: this.current }, schemaVersion: 1 });
    }
    const store = this.#readStore(q["binding"]!);
    if (store instanceof Response) return store;
    const result = (value: unknown) => json(200, { store: this.#identity(), value });
    if (path === "/api/lessons/projects") {
      const all = {
        world: { scope: { world: WORLD, project: { kind: "world" } }, label: "World-wide", root: null, available: true, origins: ["configured"] },
        b: { scope: { world: WORLD, project: { kind: "project", id: PROJECT_B } }, label: "Project B", root: "/fixture/project-b", available: true, origins: ["configured"] },
      };
      const names = (this.current !== null && this.choicesFor.get(this.current)) || (["world", "b"] as const);
      return result(names.map((n) => all[n]));
    }
    if (path === "/api/lessons/browse") {
      const scope: Scope = { world: q["world"]!, project: projectArg(q["project"]!) };
      const items = store === null ? [] : [...store.records.values()].filter((r) => !r.purged && sameScope(r.scope, scope)).map((r) => this.#view(r));
      return result({ items, nextCursor: null, total: items.length, sourceProblems: [], sourceProblemsTotal: 0 });
    }
    let key = decodeKeyArg(q["key"]!);
    if (path === "/api/lessons/get" && this.wrongKeyOnce !== null) {
      key = this.wrongKeyOnce;
      this.wrongKeyOnce = null;
    }
    const rec = store?.records.get(keyId(key)) ?? null;
    if (path === "/api/lessons/locate") return result(rec === null ? null : rec.scope);
    if (path === "/api/lessons/get") {
      if (rec === null) return result(null);
      if (!sameScope(rec.scope, { world: key.world, project: projectArg(q["project"]!) })) return json(409, { detail: "scope", code: "SCOPE_CONFLICT" });
      return result({ lesson: this.#view(rec), provenance: rec.purged ? { kind: "purged" } : { kind: "capture", source: rec.source }, diagnostics: [] });
    }
    if (path === "/api/lessons/history") {
      const all = rec === null ? [] : [...rec.history].reverse();
      const start = q["cursor"] ? Number(q["cursor"]) : 0;
      const limit = q["limit"] ? Number(q["limit"]) : 25;
      const items = all.slice(start, start + limit);
      return result({ items, nextCursor: start + limit < all.length ? String(start + limit) : null, total: all.length });
    }
    if (path === "/api/lessons/receipt") {
      const r = store?.receipts.get(q["requestId"]!);
      if (!r) return result({ state: "unknown", requestId: q["requestId"] });
      return result(r.purged
        ? { state: "purged", requestId: q["requestId"], key: r.key, startedAt: STAMP, finishedAt: STAMP }
        : { state: "committed", requestId: q["requestId"], payloadHash: r.payloadHash, key: r.key, revision: r.revision, changed: true, startedAt: STAMP, finishedAt: STAMP });
    }
    return json(404, { detail: "no route" });
  }

  #mutate(path: string, envelope: { requestId: string; mutation: { args: { mutation: Record<string, unknown>; precondition: { kind: string; id?: string; locationId?: string } } } }): Response {
    const requestId = envelope.requestId;
    const { mutation, precondition } = envelope.mutation.args;
    const fail = (code: string, revision: number | null = null) =>
      json(409, { version: 1, requestId, error: { code, message: code, retryable: false }, conflict: revision === null ? null : { revision } });
    if (precondition.kind === "installation" ? this.current !== precondition.id : this.current !== null || precondition.locationId !== LOCATION) {
      return fail("INSTALLATION_MISMATCH");
    }
    if (this.current === null) this.current = this.addStore(crypto.randomUUID()).installationId;
    const store = this.stores.get(this.current)!;
    const prior = store.receipts.get(requestId);
    const ok = (key: Key, revision: number, purged: boolean) => {
      store.receipts.set(requestId, { key, revision, payloadHash: "c".repeat(64), purged });
      return json(200, {
        version: 1,
        requestId,
        receipt: purged
          ? { requestId, payloadHash: null, state: "purged", result: null, error: null, startedAt: STAMP, finishedAt: STAMP }
          : { requestId, payloadHash: "c".repeat(64), state: "completed", result: { key, revision, changed: true }, error: null, startedAt: STAMP, finishedAt: STAMP },
        store: { locationId: LOCATION, installationId: store.installationId },
      });
    };
    const key = mutation["key"] as Key;
    if (prior) return ok(prior.key, prior.revision, prior.purged);
    const change = mutation["change"] as { kind: string; text?: string; value?: boolean; source?: Source };
    const rec = store.records.get(keyId(key));
    const at = STAMP;
    if (change.kind === "capture") {
      if (rec) return fail("CAPTURE_EXISTS", rec.revision);
      const created: Rec = { key, scope: mutation["scope"] as Scope, revision: 1, important: false, text: change.text!, source: change.source!, purged: false, history: [] };
      created.history.push({ revision: 1, kind: "capture", at, text: change.text!, important: null, oldSourceDigest: null, newSourceDigest: null });
      store.records.set(keyId(key), created);
      return ok(key, 1, false);
    }
    if (!rec) return fail("INVALID_INPUT");
    if (rec.purged) return fail("PURGED");
    if (mutation["expectedRevision"] !== rec.revision) return fail("CURATION_CONFLICT", rec.revision);
    rec.revision += 1;
    if (change.kind === "purge") {
      rec.purged = true;
      rec.text = null;
      rec.source = null;
      rec.history = [{ revision: rec.revision, kind: "purge", at, text: null, important: null, oldSourceDigest: null, newSourceDigest: null }];
      return ok(key, rec.revision, true);
    }
    if (change.kind === "edit") rec.text = change.text!;
    if (change.kind === "important") rec.important = change.value!;
    rec.history.push({ revision: rec.revision, kind: change.kind, at, text: change.kind === "edit" ? change.text! : null, important: change.kind === "important" ? change.value! : null, oldSourceDigest: null, newSourceDigest: null });
    return ok(key, rec.revision, false);
  }
}
