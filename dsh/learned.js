// Skills and agents the loop accepted, offered to DeepSeek Harness.
// Claude Code finds them through symlinks in ~/.claude; DSH does not read that
// directory, so this provider reads the world's own directories instead.
import { existsSync, readdirSync, realpathSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { kebab, parseFrontMatter, readText } from 'claude-plugin-dsh'

export const PROVIDER = 'self-improvement-loop-learned'
// Same rank claude-plugin-dsh gives plugin skills: above ~/.agents/skills.
export const RANK = 450

function envDir(env, name, fallback) {
  const raw = env[name]
  if (!raw) return fallback
  return raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
}

/** Same precedence as packages/core/src/layout.ts: SIL_STATE_DIR, else XDG_STATE_HOME. */
export function snapshotFile(env = process.env) {
  const xdg = envDir(env, 'XDG_STATE_HOME', join(homedir(), '.local', 'state'))
  return join(envDir(env, 'SIL_STATE_DIR', join(xdg, 'self-improvement-loop')), 'hook-config.json')
}

function readSnapshot(file) {
  const text = readText(file)
  if (text === undefined) return null
  try {
    const obj = JSON.parse(text)
    return obj && Array.isArray(obj.worlds) ? obj : null
  } catch {
    return null
  }
}

function real(p) {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

/** The hook's world rule: longest matching repo, else the first world with no repos. */
export function worldFor(snapshot, cwd) {
  const worlds = snapshot.worlds.filter((w) => w && typeof w.name === 'string' && w.name)
  const target = real(cwd || process.cwd())
  let best = null
  for (const w of worlds) {
    for (const repo of Array.isArray(w.repos) ? w.repos : []) {
      if (typeof repo !== 'string' || !repo) continue
      const r = real(repo)
      if (within(target, r) && (!best || r.length > best.len)) best = { len: r.length, world: w }
    }
  }
  return best?.world ?? worlds.find((w) => !Array.isArray(w.repos) || w.repos.length === 0) ?? null
}

/** Snapshots written before skills_dir existed sit next to RULES.md in the default layout. */
function dirsOf(world) {
  const base = typeof world.rules_file === 'string' && world.rules_file ? dirname(world.rules_file) : null
  const pick = (key, name) => (typeof world[key] === 'string' && world[key] ? world[key] : base ? join(base, name) : null)
  return { skills: pick('skills_dir', 'skills'), agents: pick('agents_dir', 'agents') }
}

function entries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

export function learnedCandidates(world) {
  const { skills, agents } = dirsOf(world)
  const out = []
  if (skills) {
    for (const entry of entries(skills)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const path = join(skills, entry.name, 'SKILL.md')
      // Retiring a skill deletes SKILL.md, so a leftover directory is not live.
      const text = readText(path)
      if (text === undefined) continue
      const { meta } = parseFrontMatter(text)
      const name = kebab(meta.name || entry.name)
      if (!name || !meta.description) continue
      out.push({
        name,
        description: meta.description,
        invocation: { modelInvocable: meta['disable-model-invocation'] !== 'true', userInvocable: meta['user-invocable'] !== 'false' },
        provider: PROVIDER,
        source: 'custom',
        path,
        resourceBase: { kind: 'directory', path: dirname(path) },
        rank: RANK,
        locator: { kind: 'skill', path, world: world.name },
      })
    }
  }
  if (agents) {
    for (const entry of entries(agents)) {
      if (!entry.name.endsWith('.md')) continue
      const path = join(agents, entry.name)
      const text = readText(path)
      if (text === undefined) continue
      const { meta } = parseFrontMatter(text)
      const agent = kebab(meta.name || entry.name.slice(0, -3))
      if (!agent || !meta.description) continue
      out.push({
        name: `self-improvement-loop-agent-${agent}`,
        description: `Role brief for a delegated worker (agent "${agent}" learned by the self-improvement loop). ${meta.description}`,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: PROVIDER,
        source: 'custom',
        path,
        resourceBase: { kind: 'directory', path: agents },
        rank: RANK,
        locator: { kind: 'agent', path, agent, tools: meta.tools || '', world: world.name },
      })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function learnedDefinition(candidate) {
  const locator = candidate.locator
  const text = readText(locator.path)
  if (text === undefined) return undefined
  const { body } = parseFrontMatter(text)
  const note = `> Learned by the self-improvement loop (world ${locator.world}).`
  let content
  if (locator.kind === 'skill') {
    content = `${note}\n> Relative paths in this skill resolve from \`${dirname(locator.path)}\`.\n\n${body}`
  } else {
    const tools = locator.tools ? `\nOriginal tool allowlist: ${locator.tools}. Respect it: do not use tools outside that list.` : ''
    content = [
      `# Delegated role: ${locator.agent}`,
      '',
      note,
      'This is a Claude Code agent definition. DSH has no agent types, so use it as a brief:',
      '- To run this role, call `subagent` (or `spawn_teammate` for a durable teammate) with a prompt made of the role text below, then the concrete task, exact files, and the check that proves it done.',
      '- Pick the provider and model yourself; the original pin does not apply in DSH.' + tools,
      '',
      '## Role text',
      '',
      body,
    ].join('\n')
  }
  const definition = {
    name: candidate.name,
    description: candidate.description,
    invocation: candidate.invocation,
    provider: PROVIDER,
    source: 'custom',
    path: locator.path,
    content,
  }
  if (candidate.resourceBase) definition.resourceBase = candidate.resourceBase
  return definition
}

/** Watch what decides the catalog: the snapshot and every world's directories.
 * Accept, reject and retire add or remove entries there; re-arms when the
 * snapshot names new directories. */
function watchCatalog(file, invalidate, signal) {
  const watchers = new Map()
  const arm = () => {
    const wanted = new Set([dirname(file)])
    for (const w of readSnapshot(file)?.worlds ?? []) {
      const { skills, agents } = dirsOf(w ?? {})
      for (const d of [skills, agents]) if (d && existsSync(d)) wanted.add(d)
    }
    for (const [dir, w] of watchers) {
      if (!wanted.has(dir)) {
        w.close()
        watchers.delete(dir)
      }
    }
    for (const dir of wanted) {
      if (watchers.has(dir)) continue
      try {
        // Recursive for world dirs: retiring deletes skills/<name>/SKILL.md, one level down.
        const w = watch(dir, { persistent: false, recursive: dir !== dirname(file) }, (_event, name) => {
          if (dir === dirname(file) && name && name !== 'hook-config.json') return
          if (dir === dirname(file)) arm()
          invalidate()
        })
        w.on('error', () => {
          w.close()
          watchers.delete(dir)
        })
        watchers.set(dir, w)
      } catch {
        // A directory that does not exist yet is picked up on the next snapshot change.
      }
    }
  }
  arm()
  signal.addEventListener('abort', () => {
    for (const w of watchers.values()) w.close()
    watchers.clear()
  })
}

/** Register the provider. Reads disk on every list(); the watcher only tells
 * DSH to drop its cached catalog. */
export function serveLearned(ctx, env = process.env) {
  const file = snapshotFile(env)
  ctx.inject(['skills'], (sub) => {
    if (!sub.skills?.registerProvider) return (sub.logger ?? console).warn(`[${PROVIDER}] skills service missing`)
    sub.skills.registerProvider((control) => {
      watchCatalog(file, control.invalidate, control.signal)
      return {
        name: PROVIDER,
        async list(options = {}) {
          const snapshot = readSnapshot(file)
          if (!snapshot) return []
          const world = worldFor(snapshot, options.cwd)
          return world ? learnedCandidates(world) : []
        },
        async get(candidate) {
          return learnedDefinition(candidate)
        },
      }
    })
  })
}
