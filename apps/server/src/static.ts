// Static UI files. Served from dist/web, built by apps/web's `bun run build`.
// Mounted unguarded (no /api prefix): the browser needs the page before any
// JS can send the token header, and every byte of loop data sits behind
// /api/*, which the guard does cover.

import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { paths } from "@sil/core";

export function staticRoot(): string {
  return join(paths.pluginRoot(), "dist", "web");
}

function hasDotSegment(pathname: string): boolean {
  return pathname.split("/").some((seg) => seg === "." || seg === "..");
}

/** Resolve a request pathname to a file under root. Refuses traversal and
 * dotfiles; the browser URL parser already collapses ".." segments, this is
 * defense in depth against a raw request that skips that step. */
export function resolveStaticPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (hasDotSegment(decoded) || decoded.split("/").some((seg) => seg.startsWith("."))) return null;
  const cleaned = decoded.replace(/^\/+/, "");
  const full = normalize(join(root, cleaned));
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

function fileResponse(path: string): Response {
  return new Response(Bun.file(path));
}

export async function serveStatic(pathname: string): Promise<Response> {
  const root = staticRoot();
  if (!existsSync(root)) return new Response("not found", { status: 404 });

  const wanted = pathname === "/" ? "/index.html" : pathname;
  const target = resolveStaticPath(root, wanted);
  if (target === null) return new Response("not found", { status: 404 });

  let st;
  try {
    st = statSync(target);
  } catch {
    st = null;
  }
  // No directory listing: a directory hit is a miss, not an index.
  if (st && st.isFile()) return fileResponse(target);
  return new Response("not found", { status: 404 });
}
