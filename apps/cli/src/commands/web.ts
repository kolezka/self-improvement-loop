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
//
// The port being taken is the normal case, not a crash: the scheduled web job
// keeps one instance up, and `/loop web` from any Claude session (any config
// dir, any world) runs `sil web` again. One SIL config serves every world, so
// that instance is the one to use. After a failed bind this asks whoever holds
// the port whether it is the SIL web UI and prints its URL when it is.

import { readFileSync } from "node:fs";
import { fsx, loadConfig, paths } from "@sil/core";
import { opPath } from "@sil/ops";
import { LOCAL_HEADER, TOKEN_HEADER } from "../../../server/src/guard.ts";
// apps/server/package.json has no "exports" field yet, so the bare
// "@sil/server" specifier does not resolve. Import the entry file directly
// until that lands; switch to the package specifier once it does.
import { isLoopbackHost, serve, urlHost } from "../../../server/src/main.ts";
import { watchForUpdates } from "../webUpdate.ts";

export interface WebOptions {
  port?: number;
  token?: boolean;
  open?: boolean;
  host?: string;
  watch?: boolean;
}

/** What a running SIL web UI says about itself on health.build. */
export interface RunningWeb {
  version: string;
  server_started: string | null;
  plugin_root: string | null;
}

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // no opener available: the URL is already printed by serve()
  }
}

/** The stored web token, or null. Read only: a probe must not mint one. */
function storedToken(): string | null {
  try {
    return readFileSync(paths.webTokenFile(), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Asks whoever listens on host:port whether it is the SIL web UI. Only a
 * decoded health.build answer with a version counts; any other status, body
 * or a connection failure means something else holds the port. */
export async function probeRunningWeb(host: string, port: number, timeoutMs = 2000): Promise<RunningWeb | null> {
  const headers: Record<string, string> = { [LOCAL_HEADER]: "1" };
  const token = storedToken();
  if (token) headers[TOKEN_HEADER] = token;
  try {
    const res = await fetch(`http://${urlHost(host)}:${port}${opPath("health.build")}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body["version"] !== "string") return null;
    return {
      version: body["version"],
      server_started: typeof body["server_started"] === "string" ? body["server_started"] : null,
      plugin_root: typeof body["plugin_root"] === "string" ? body["plugin_root"] : null,
    };
  } catch {
    return null;
  }
}

export async function cmdWeb(opts: WebOptions): Promise<number> {
  const cfg = loadConfig();
  const port = opts.port ?? cfg.web.port;
  const host = opts.host ?? cfg.web.host;
  let server: ReturnType<typeof serve>;
  try {
    server = serve({ host, port, token: opts.token, allowedHosts: cfg.web.allowed_hosts });
  } catch (err) {
    if (fsx.errnoCode(err) !== "EADDRINUSE") throw err;
    const running = await probeRunningWeb(host, port);
    if (!running) {
      console.error(
        `sil web: port ${port} on ${host} is taken by something that is not the SIL web UI. Stop it, or pick another port with sil web --port <n> or web.port in config.yaml.`,
      );
      return 1;
    }
    // Same URL shape serve() prints: the stored token in the fragment only
    // off loopback, where the running instance requires it.
    const token = isLoopbackHost(host) ? null : storedToken();
    const url = `http://${urlHost(host)}:${port}/${token ? `#${token}` : ""}`;
    console.log(`web UI already running: ${url}`);
    const since = running.server_started ? `, started ${running.server_started}` : "";
    const from = running.plugin_root ? `, from ${running.plugin_root}` : "";
    console.log(`sil ${running.version}${since}${from}`);
    if (opts.open) openBrowser(url);
    return 0;
  }
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
