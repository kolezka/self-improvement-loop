// DeepSeek Harness entry for this Claude Code plugin. The plugin tree is read as is.
// Run `bun install --frozen-lockfile` in this directory before loading it.
import { createPlugin, rootFrom } from 'claude-plugin-dsh'
import { serveConsole } from './console.js'

const root = rootFrom(import.meta.url)
const plugin = createPlugin({ root, commands: { prefix: 'sil' } })

export const name = plugin.name

export function apply(ctx, config) {
  serveConsole(ctx, root)
  return plugin.apply(ctx, config)
}

export default { name, apply }
