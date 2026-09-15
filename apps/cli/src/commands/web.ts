// sil web: start the review UI HTTP server and keep it running.
//
// `serve()` starts listening and returns right away; it does not block. This
// command waits forever afterward so the process (and the server) stays up
// until the user interrupts it, the same shape as the old Python
// `serve_forever()` call.

import { loadConfig } from "@sil/core";
// apps/server/package.json has no "exports" field yet, so the bare
// "@sil/server" specifier does not resolve. Import the entry file directly
// until that lands; switch to the package specifier once it does.
import { serve, urlHost } from "../../../server/src/main.ts";

export interface WebOptions {
  port?: number;
  token?: boolean;
  open?: boolean;
  host?: string;
}

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // no opener available: the URL is already printed by serve()
  }
}

export async function cmdWeb(opts: WebOptions): Promise<number> {
  const cfg = loadConfig();
  const port = opts.port ?? cfg.web.port;
  const host = opts.host ?? cfg.web.host;
  const server = serve({ host, port, token: opts.token, allowedHosts: cfg.web.allowed_hosts });
  if (opts.open) openBrowser(`http://${urlHost(host)}:${server.port}/`);
  return new Promise<number>(() => {});
}
