// Talks to the ops registry over /api/<area>/<verb>. The token lives in the
// URL fragment (never sent to a server, never logged), mirrored into
// sessionStorage so a reload does not lose it.

const STORAGE_KEY = "sil-token";
let token = "";

export interface OpMeta {
  name: string;
  tier: "read" | "local" | "remote";
  gate: "none" | "reviewed_state" | "confirm";
  doc: string;
}

let opsMeta: Map<string, OpMeta> | null = null;

/** The token in a URL fragment, or "" when the fragment is a route.
 *
 * The same fragment carries both: the server prints `#<token>` once, and the
 * UI then writes `#/review` into it on every navigation. Reading a route as a
 * token overwrote the stored one with "/review" on any reload, and every call
 * after that was refused by the guard. A token is base64url and never starts
 * with "/". */
export function tokenFromFragment(fragment: string): string {
  const raw = fragment.replace(/^#/, "");
  return raw.startsWith("/") ? "" : raw;
}

/** Reads the token from the URL fragment on first load, or from
 * sessionStorage on a reload. Strips the fragment from the visible URL so
 * the token never lingers in browser history. */
export function captureToken(): string {
  const fromHash = tokenFromFragment(window.location.hash);
  if (fromHash) {
    token = fromHash;
    try {
      sessionStorage.setItem(STORAGE_KEY, token);
    } catch {
      // private browsing: token still works for this page load
    }
    history.replaceState(null, "", window.location.pathname + window.location.search);
    return token;
  }
  try {
    token = sessionStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    token = "";
  }
  return token;
}

const RELOAD_PARAM = "r";

/** Reload the page so a new plugin build is the one that runs.
 *
 * The param is what defeats a browser holding an index.html it cached before
 * the server started sending `cache-control: no-store`. The fragment is kept,
 * so the reload lands on the same pane, and the token rides along in
 * sessionStorage. */
export function reloadForBuild(build: string | null): void {
  const url = new URL(window.location.href);
  url.searchParams.set(RELOAD_PARAM, build ?? String(Date.now()));
  window.location.replace(url.toString());
}

/** Take the cache-busting param back out of the visible URL, so a copied link
 * is the plain one again. */
export function dropReloadParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(RELOAD_PARAM)) return;
  url.searchParams.delete(RELOAD_PARAM);
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}

async function loadOpsMeta(): Promise<Map<string, OpMeta>> {
  if (opsMeta) return opsMeta;
  const res = await fetch("/api/ops", {
    headers: { "X-SIL-Local": "1", "X-SIL-Token": token },
  });
  if (!res.ok) throw new Error(`could not load /api/ops: HTTP ${res.status}`);
  const list = (await res.json()) as OpMeta[];
  opsMeta = new Map(list.map((op) => [op.name, op]));
  return opsMeta;
}

function pathFor(name: string): string {
  return "/api/" + name.replace(/\./g, "/");
}

interface ErrorBody {
  detail?: string;
}

/** call("review.detail", {world, pattern}) picks GET or POST based on the
 * op's tier: read ops are GET with a query string, everything else is a
 * JSON POST body. */
export async function call(name: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const meta = await loadOpsMeta();
  const op = meta.get(name);
  if (!op) throw new Error(`unknown op: ${name}`);

  const headers: Record<string, string> = { "X-SIL-Local": "1", "X-SIL-Token": token };
  let res: Response;
  if (op.tier === "read") {
    const url = new URL(pathFor(name), window.location.origin);
    for (const [k, v] of Object.entries(payload)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    res = await fetch(url, { headers });
  } else {
    res = await fetch(pathFor(name), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  if (!res.ok) {
    const body: ErrorBody = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function opsList(): Promise<OpMeta[]> {
  const meta = await loadOpsMeta();
  return [...meta.values()];
}
