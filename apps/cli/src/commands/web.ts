// sil web: start the review UI HTTP server and keep it running.
//
// `serve()` starts listening and returns right away; it does not block. This
// command waits forever afterward so the process (and the server) stays up
// until the user interrupts it, the same shape as the old Python
// `serve_forever()` call.
//
// It also watches for a plugin update. A running server keeps serving the
// bundle of the version it started on, so on an update it stops and exits 0;
// the systemd unit (Restart=always) or launchd agent (KeepAlive) then starts
// it again, and the shim resolves the new install. `--no-watch` turns that
// off for a foreground run that should outlive an update.

import { loadConfig } from "@sil/core";
// apps/server/package.json has no "exports" field yet, so the bare
// "@sil/server" specifier does not resolve. Import the entry file directly
// until that lands; switch to the package specifier once it does.
import { serve, urlHost } from "../../../server/src/main.ts";
import { watchForUpdates } from "../webUpdate.ts";

export interface WebOptions {
  port?: number;
  token?: boolean;
  open?: boolean;
  host?: string;
  watch?: boolean;
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
  if (opts.watch ?? true) {
    watchForUpdates(() => {
      console.log("plugin updated: stopping the web UI so the supervisor starts the new version");
      // Drain in flight requests, then leave. Exit 0 on purpose: this is a
      // planned restart, not a crash.
      void server.stop(false).then(() => process.exit(0));
    });
  }
  return new Promise<number>(() => {});
}
