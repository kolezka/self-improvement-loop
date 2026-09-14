// Talks to the ops registry over /api/<area>/<verb>. The token lives in the
// URL fragment (never sent to a server, never logged), mirrored into
// sessionStorage so a reload does not lose it.

const STORAGE_KEY = "sil-token";
let token = "";
let opsMeta = null;

export function captureToken() {
  const fromHash = window.location.hash.replace(/^#/, "");
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
    token = sessionStorage.getItem(STORAGE_KEY) || "";
  } catch {
    token = "";
  }
  return token;
}

async function loadOpsMeta() {
  if (opsMeta) return opsMeta;
  const res = await fetch("/api/ops", {
    headers: { "X-SIL-Local": "1", "X-SIL-Token": token },
  });
  if (!res.ok) throw new Error(`could not load /api/ops: HTTP ${res.status}`);
  const list = await res.json();
  opsMeta = new Map(list.map((op) => [op.name, op]));
  return opsMeta;
}

function pathFor(name) {
  return "/api/" + name.replace(/\./g, "/");
}

// call("review.detail", {world, pattern}) picks GET or POST based on the
// op's tier: READ ops are GET with a query string, everything else is a
// JSON POST body.
export async function call(name, payload = {}) {
  const meta = await loadOpsMeta();
  const op = meta.get(name);
  if (!op) throw new Error(`unknown op: ${name}`);

  const headers = { "X-SIL-Local": "1", "X-SIL-Token": token };
  let res;
  if (op.tier === "read") {
    const url = new URL(pathFor(name), window.location.origin);
    for (const [k, v] of Object.entries(payload)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
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
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function opsList() {
  const meta = await loadOpsMeta();
  return [...meta.values()];
}
