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

/** Reads the token from the URL fragment on first load, or from
 * sessionStorage on a reload. Strips the fragment from the visible URL so
 * the token never lingers in browser history. */
export function captureToken(): string {
  const fromHash = window.location.hash.replace(/^#/, "");
  // A route fragment always starts with a slash ("#/logs"); a token is
  // base64url and never contains one. Without this test a deep link to a pane
  // was swallowed as if it were a token and the pane never opened.
  if (fromHash && !fromHash.startsWith("/")) {
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
