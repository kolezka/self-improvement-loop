import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

/** Where the console is served inside the DSH web app. */
export const CONSOLE_PREFIX = '/self-improvement-loop'

const SERVICES = ['webServer', 'connection']
const CONSOLE_ADDRESS = /http:\/\/127\.0\.0\.1:(\d+)\//
// Request headers the console needs. Cookies and the DSH auth headers stay here.
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'content-length', 'x-sil-local', 'x-sil-token']
const PASSED_HEADERS = ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options']
const IDLE_MS = 5 * 60_000

/**
 * Serves the sil web console under the DSH origin, behind the DSH login.
 * The console stays a loopback-only `sil web` process; this only forwards to it.
 */
export function serveConsole(ctx, pluginRoot) {
  ctx.inject(SERVICES, (sub) => {
    sub.effect(() => {
      const consoles = new ConsoleProcess(pluginRoot)
      const unregister = sub.webServer.register({
        kind: 'prefix',
        path: CONSOLE_PREFIX,
        // A failure here must end this one response, not reach the host as an unhandled rejection.
        handler: (req, res) => respond(sub, consoles, pluginRoot, req, res).catch(() => (res.headersSent ? res.destroy() : end(res, 500))),
      })
      return () => {
        unregister()
        consoles.stop()
      }
    }, 'self-improvement-loop: console route')
  })
}

export async function respond(ctx, consoles, pluginRoot, req, res) {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) return end(res, rejection)

  const url = new URL(String(req.url), 'http://localhost')
  // Relative asset and API paths need the trailing slash to resolve below the prefix.
  if (url.pathname === CONSOLE_PREFIX) return end(res, 308, '', { location: `${CONSOLE_PREFIX}/${url.search}` })
  const path = url.pathname.slice(CONSOLE_PREFIX.length)

  if (!existsSync(join(pluginRoot, 'dist', 'web', 'index.html')) && !path.startsWith('/api/')) {
    if (path !== '/') return end(res, 404, 'not found')
    return end(res, 200, unbuiltPage(pluginRoot), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  }

  let held
  try {
    held = await consoles.use()
  } catch (error) {
    return end(res, 502, `The sil console did not start: ${error.message}`)
  }
  forward(held, path + url.search, req, res)
}

function forward(held, path, req, res) {
  const authority = `127.0.0.1:${held.port}`
  const headers = { host: authority }
  for (const name of FORWARDED_REQUEST_HEADERS) if (req.headers[name] !== undefined) headers[name] = req.headers[name]
  const upstream = request({ host: '127.0.0.1', port: held.port, method: req.method, path, headers }, (reply) => {
    const out = {}
    for (const name of PASSED_HEADERS) if (reply.headers[name] !== undefined) out[name] = reply.headers[name]
    res.writeHead(reply.statusCode ?? 502, out)
    reply.pipe(res)
  })
  upstream.on('error', () => (res.headersSent ? res.destroy() : end(res, 502, 'The sil console is not answering.')))
  res.on('close', () => {
    upstream.destroy()
    held.release()
  })
  req.pipe(upstream)
}

function end(res, status, body = '', headers = { 'content-type': 'text/plain; charset=utf-8' }) {
  res.writeHead(status, headers)
  res.end(body)
}

function unbuiltPage(pluginRoot) {
  const where = pluginRoot.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
  return `<!doctype html><meta charset="utf-8"><title>sil console</title>
<body style="font:14px system-ui;margin:2rem;color-scheme:light dark">
<p>The sil console has no build in this checkout. Build it once, then reopen this tab:</p>
<pre>cd ${where}
bun install
bun run build</pre>
<p>A release install (the <code>release</code> branch or a <code>v</code> tag) already carries the build.</p>`
}

/**
 * One `sil web` on a free loopback port, started on first use and stopped
 * five minutes after the last request ends. `start` is replaceable for tests.
 */
export class ConsoleProcess {
  #root
  #start
  #entry = undefined

  constructor(pluginRoot, start = startSilWeb) {
    this.#root = pluginRoot
    this.#start = start
  }

  async use() {
    const entry = this.#entry ?? this.#launch()
    const port = await entry.port
    clearTimeout(entry.idle)
    entry.clients += 1
    let released = false
    return {
      port,
      release: () => {
        if (released) return
        released = true
        this.#release(entry)
      },
    }
  }

  stop() {
    const entry = this.#entry
    this.#entry = undefined
    if (entry === undefined) return
    clearTimeout(entry.idle)
    entry.child.kill()
  }

  #launch() {
    const child = this.#start(this.#root)
    const forget = () => {
      if (this.#entry === entry) this.#entry = undefined
    }
    const entry = { child, clients: 0, idle: undefined, port: undefined, forget }
    entry.port = new Promise((resolve, reject) => {
      let printed = ''
      let complaint = ''
      child.stdout.on('data', (chunk) => {
        printed += chunk
        const address = CONSOLE_ADDRESS.exec(printed)
        if (address !== null) resolve(Number(address[1]))
      })
      child.stderr.on('data', (chunk) => (complaint += chunk))
      child.on('error', (error) => {
        forget()
        reject(error)
      })
      child.on('exit', (code) => {
        forget()
        reject(new Error(complaint.trim() || `it exited with code ${code}`))
      })
    })
    // A failed start is reported to the request that asked; this keeps it from also crashing the host.
    entry.port.catch(() => {})
    this.#entry = entry
    return entry
  }

  #release(entry) {
    entry.clients -= 1
    if (entry.clients > 0) return
    entry.idle = setTimeout(() => {
      // Forget it first, so a request arriving now starts a fresh console instead of reaching a dying one.
      entry.forget()
      entry.child.kill()
    }, IDLE_MS)
    entry.idle.unref()
  }
}

/** Runs this plugin tree's own `sil`, never another install the shim might find. */
export function startSilWeb(pluginRoot, baseEnv = process.env) {
  const env = { ...baseEnv, SIL_PLUGIN_ROOT: pluginRoot }
  // Port 0 and loopback: never the user's scheduled `sil web` port, never tokenless off loopback.
  const args = [join(pluginRoot, 'scripts', 'sil'), 'web', '--host', '127.0.0.1', '--port', '0', '--no-token']
  return spawn('sh', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
}
