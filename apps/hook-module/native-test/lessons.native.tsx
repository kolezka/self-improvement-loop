// Native engine tests for the Lessons view inside Activity: a real Input change
// and submit, the selection read before the pane opens, one Important write,
// a confirmed purge and a refused secret. Run by `claude plugin test`
// (scripts/test-native.ts copies this file as lessons.test.tsx), never by
// `bun test`. It does not prove terminal paint, focus or clipboard selection:
// those stay for the attended check.
//
// The bridge is answered beneath the plugin by a small stand-in for `sil ops`
// with one in-memory record table. Model, prompt, tool and filesystem calls and
// any other process are recorded and refused; every test asserts none happened.

import type { On, PluginState } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const W = 'world-a'
const I = '5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716'
const L = 'd'.repeat(64)
const P = `p1_${'b'.repeat(64)}`
const STAMP = '2026-10-24T10:00:00.000Z'
const HASH = 'a'.repeat(64)
const SECRET = 'api_key=ABCDEFGHIJKLMNOPQRSTUVWX'
const DENIED = 'denied by the native test'
const INERT_ENV = {
  HOME: '/nonexistent/sil-native-test/home',
  SIL_STATE_DIR: '/nonexistent/sil-native-test/state',
  SIL_DATA_DIR: '/nonexistent/sil-native-test/data',
  SIL_CONFIG_DIR: '/nonexistent/sil-native-test/config',
}
const PANE = {
  plugin: 'self-improvement-loop',
  component: 'Pane',
  requestId: 'sil-console',
  props: { title: 'Self-improvement loop', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

type Rec = Record<string, any>
type SilLessons = PluginState['self-improvement-loop']['lessons']

function engine(on: On, selection: { text: string; requestId?: string } | undefined) {
  const clock = mock.clock(on, { now: Date.parse(STAMP) })
  const seen = {
    clock,
    forbidden: [] as string[],
    mutations: [] as Rec[],
    reads: [] as Rec[],
    order: [] as string[],
    opens: [] as Rec[],
    lessonStates: [] as string[],
    selection,
  }
  const records = new Map<string, Rec>()
  const store = { locationId: L, installationId: I }
  const ok = (value: unknown) => ({ ok: true, value })
  const view = (r: Rec) => ({ key: r.key, scope: r.scope, revision: r.revision, important: r.important, effectiveText: r.text, originalText: null, source: r.source, sourceStatus: r.status, sourceDigest: null, baselineDigest: null, relatedPattern: null, created: STAMP, updated: STAMP })
  const read = (op: string, a: Rec): unknown => {
    seen.reads.push({ op, args: a })
    if (op === 'console.bootstrap') return ok({ worlds: [W], selectedWorld: W, resolutionError: null, initialized: true })
    if (op === 'worker.status') return ok({ pending: 0, done: 0, failed: 0, lock_held: false, last_run: STAMP })
    if (op === 'queue.list') return ok({ pending: [], done: [], failed: [], hidden: { done: 0, failed: 0 }, cleared: { done: null, failed: null } })
    if (op === 'logs.tail') return ok({ name: 'worker', path: '/x', exists: false, size: 0, lines: [] })
    if (op === 'console.page') return ok({ world: a.world, total: 0, offset: a.offset, limit: a.limit, items: [] })
    if (op === 'lessons.store') return ok({ state: 'ready', binding: { kind: 'installation', id: I } })
    if (op === 'lessons.projects') return ok({ store, value: [{ scope: { world: W, project: { kind: 'project', id: P } }, label: 'repo', root: '/work/repo', available: true, origins: ['configured'] }] })
    if (op === 'lessons.context') return ok({ state: 'resolved', scope: { world: W, project: { kind: 'project', id: P } }, project: { world: W, projectId: P, root: '/work/repo' }, worldMatch: 'configured', requiresConfirmation: false })
    if (op === 'lessons.browse') {
      let items = [...records.values()]
      if (typeof a.search === 'string') items = items.filter((r) => String(r.text).includes(a.search))
      return ok({ store, value: { items: items.map(view), nextCursor: null, total: items.length, sourceProblems: [], sourceProblemsTotal: 0 } })
    }
    const r = records.get(String(a.key))
    if (op === 'lessons.get') return ok({ store, value: r === undefined ? null : { lesson: view(r), provenance: r.status === 'purged' ? { kind: 'purged' } : { kind: 'capture', source: r.source }, diagnostics: [] } })
    if (op === 'lessons.history') return ok({ store, value: { items: [], nextCursor: null, total: 0 } })
    return { ok: false, error: { code: 'OpNotAllowed', message: 'not in this test', retryable: false } }
  }
  const mutate = (env: Rec): Rec => {
    seen.mutations.push(env)
    const m = env.mutation.args.mutation
    const id = Object.keys(Object.fromEntries(records)).find((k) => records.get(k)!.key.id === m.key.id)
    let r = id === undefined ? undefined : records.get(id)
    if (m.change.kind === 'capture') {
      r = { key: m.key, scope: m.scope, revision: 0, important: false, text: null, source: m.change.source, status: 'saved' }
      // The bridge keys records by the encoded key it is sent on reads.
      records.set(encodeKey(m.key), r)
    }
    if (m.change.kind === 'purge') {
      r!.status = 'purged'
      r!.text = null
      r!.source = null
      return { version: 1, requestId: env.requestId, receipt: { requestId: env.requestId, payloadHash: null, state: 'purged', result: null, error: null, startedAt: STAMP, finishedAt: STAMP }, store }
    }
    r!.revision += 1
    if (m.change.kind === 'capture' || m.change.kind === 'edit') r!.text = m.change.text
    if (m.change.kind === 'important') r!.important = m.change.value
    return { version: 1, requestId: env.requestId, receipt: { requestId: env.requestId, payloadHash: HASH, state: 'completed', result: { key: m.key, revision: r!.revision, changed: true }, error: null, startedAt: STAMP, finishedAt: STAMP }, store }
  }

  mock.env(on, INERT_ENV)
  on('state.set', { plugin: 'self-improvement-loop', key: 'lessons' }, (_, e, next) => {
    seen.lessonStates.push(JSON.stringify(e.value as SilLessons))
    return next(e)
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  let panes: Rec[] = []
  on('ui.selection', () => {
    seen.order.push('ui.selection')
    return { value: seen.selection }
  })
  on('ui.open', (_, e) => {
    seen.order.push('ui.open')
    seen.opens.push({ ...e })
    if (!panes.some((p) => p.id === e.id)) panes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true })
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({ value: panes.map((p) => ({ ...p })) as never }))
  on('ui.close', (_, e) => {
    panes = panes.filter((p) => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.id', () => ({ value: 'sess-native' }))
  on('command.run', (_, e) => ({ text: `core ran ${e.command}` }))
  on('process.run', async (_, e) => {
    const argv = [...e.argv]
    const isBridge = argv.length === 3 && argv[0] === '/bin/sh' && String(argv[1]).endsWith('/scripts/sil') && argv[2] === 'ops'
    if (!isBridge) {
      seen.forbidden.push(`process.run ${argv.join(' ')}`)
      return { deny: DENIED }
    }
    const body = JSON.parse(e.init?.stdin ?? 'null') as Rec
    let out: unknown
    if (Object.hasOwn(body, 'mutation')) out = mutate(body)
    else {
      const results: Rec = {}
      for (const r of body.reads) results[r.id] = read(r.op, r.args)
      out = { version: 1, requestId: body.requestId, results }
    }
    return { value: { exitCode: 0, stdout: `${JSON.stringify(out)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', () => {
    seen.forbidden.push('model.complete')
    return { deny: DENIED } as never
  })
  on('prompt.submit', (_, e) => {
    seen.forbidden.push('prompt.submit')
    return e as never
  })
  on('tool.call', () => {
    seen.forbidden.push('tool.call')
    return { result: {} } as never
  })
  for (const op of ['fs.read', 'fs.write', 'fs.list', 'fs.exists', 'fs.stat'] as const) {
    on(op, () => {
      seen.forbidden.push(op)
      return { deny: DENIED } as never
    })
  }
  on('store.set', () => {
    seen.forbidden.push('store.set')
    return { deny: DENIED } as never
  })
  on('store.get', () => {
    seen.forbidden.push('store.get')
    return { deny: DENIED } as never
  })
  return seen
}

/** The bridge's own key encoding (base64url of the JSON triple), for the fixture's table. */
function encodeKey(key: { world: string; kind: string; id: string }): string {
  const bytes = new TextEncoder().encode(JSON.stringify([key.world, key.kind, key.id]))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function openLessons($: Engine, seen: { clock: { settle: () => Promise<void> } }) {
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'sil', args: '', ...TYPED })
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'section-activity' })
  await seen.clock.settle()
  await ui.press({ key: 'activity-tab-lessons' })
  await seen.clock.settle()
  await ui.press({ key: 'lessons-open' })
  await seen.clock.settle()
  return ui
}

test('a capture typed through native Inputs saves the exact wording and keeps the selection as an unverified quote', async ($, on) => {
  const seen = engine(on, { text: 'Selected passage', requestId: 'toolu_native' })
  const ui = await openLessons($, seen)
  expect(await ui.find({ key: 'lessons-search' })).toBeDefined()
  await ui.press({ key: 'lesson-capture' })
  await seen.clock.settle()
  expect((await ui.find({ key: 'lesson-text' }))?.props.value).toBe('Selected passage')
  const changed = await ui.input({ key: 'lesson-text', text: 'Write the failing test first.', kind: 'change' })
  await seen.clock.settle()
  expect(changed?.value).toBe('Write the failing test first.')
  expect((await ui.find({ key: 'lesson-text' }))?.props.value).toBe('Write the failing test first.')
  await ui.press({ key: 'lesson-save' })
  await seen.clock.settle()
  expect(seen.mutations).toHaveLength(1)
  const m = seen.mutations[0]!.mutation
  expect(m.op).toBe('lessons.capture')
  expect(m.args.mutation.change.text).toBe('Write the failing test first.')
  expect(m.args.mutation.change.source).toEqual({ kind: 'native_selection', quote: 'Selected passage', reference: null, quoteRedacted: false, captureSessionId: 'sess-native', sourceConversationId: 'sess-native', sourceRowId: 'toolu_native', sourceAgentId: null })
  expect(await ui.find({ type: 'Text', text: /Saved locally\. Not installed or queued for learning\./ })).toBeDefined()
  // Search runs on Enter, through the Input's submit.
  const submitted = await ui.input({ key: 'lessons-search', text: 'failing', kind: 'submit' })
  await seen.clock.settle()
  expect(submitted?.value).toBe('failing')
  expect(seen.reads.filter((r) => r.op === 'lessons.browse').at(-1)?.args.search).toBe('failing')
  await ui.unmount()
  expect(seen.forbidden).toEqual([])
})

test('/sil capture reads the selection before the pane opens, opens it with focus, and an empty selection gives quote and reference fields', async ($, on) => {
  const seen = engine(on, undefined)
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  const out = await $.command.run({ command: 'sil', args: 'capture', ...TYPED })
  await seen.clock.settle()
  expect(seen.order.indexOf('ui.selection')).toBeGreaterThanOrEqual(0)
  expect(seen.order.indexOf('ui.selection')).toBeLessThan(seen.order.indexOf('ui.open'))
  expect(seen.opens.at(-1)?.focus).toBe(true)
  expect(JSON.stringify(out)).toContain('lesson capture')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Selection unavailable/ })).toBeDefined()
  expect((await ui.find({ key: 'lesson-quote' }))?.type).toBe('Input')
  expect((await ui.find({ key: 'lesson-reference' }))?.type).toBe('Input')
  await ui.input({ key: 'lesson-quote', text: 'pasted passage', kind: 'change' })
  await seen.clock.settle()
  await ui.input({ key: 'lesson-text', text: 'my wording', kind: 'submit' })
  await seen.clock.settle()
  await ui.press({ key: 'lesson-save' })
  await seen.clock.settle()
  expect(seen.mutations[0]?.mutation.args.mutation.change.source).toMatchObject({ kind: 'explicit_quote', quote: 'pasted passage', sourceRowId: null, sourceConversationId: null })
  await ui.unmount()
  expect(seen.forbidden).toEqual([])
})

test('Important is one write without a question, purge waits for its confirmation', async ($, on) => {
  const seen = engine(on, { text: 'Bookmark me', requestId: 'toolu_1' })
  const ui = await openLessons($, seen)
  await ui.press({ key: 'lesson-capture' })
  await seen.clock.settle()
  await ui.press({ key: 'lesson-save' })
  await seen.clock.settle()
  await ui.press({ key: 'lesson-important' })
  await seen.clock.settle()
  expect(seen.mutations.map((x) => x.mutation.op)).toEqual(['lessons.capture', 'lessons.setImportant'])
  expect(seen.mutations[1]!.mutation.args.mutation.change).toEqual({ kind: 'important', value: true })
  await ui.press({ key: 'lesson-purge' })
  await seen.clock.settle()
  expect(seen.mutations).toHaveLength(2)
  expect(await ui.find({ key: 'lesson-purge-confirm' })).toBeDefined()
  await ui.press({ key: 'lesson-purge-confirm' })
  await seen.clock.settle()
  expect(seen.mutations.at(-1)?.mutation).toMatchObject({ op: 'lessons.purge', confirmed: true })
  expect(await ui.find({ type: 'Text', text: /A fresh read confirmed the purge/ })).toBeDefined()
  expect(await ui.find({ key: 'lesson-text' })).toBeUndefined()
  await ui.unmount()
  expect(seen.forbidden).toEqual([])
})

test('wording that looks like a secret is refused before sending and never reaches session state', async ($, on) => {
  const seen = engine(on, undefined)
  const ui = await openLessons($, seen)
  await ui.press({ key: 'lesson-capture' })
  await seen.clock.settle()
  await ui.input({ key: 'lesson-quote', text: 'quote', kind: 'change' })
  await seen.clock.settle()
  await ui.input({ key: 'lesson-text', text: 'SENTINEL-native plain', kind: 'change' })
  await seen.clock.settle()
  expect(seen.lessonStates.some((s) => s.includes('SENTINEL-native plain'))).toBe(true)
  const before = seen.lessonStates.length
  await ui.input({ key: 'lesson-text', text: `SENTINEL-native ${SECRET}`, kind: 'change' })
  await seen.clock.settle()
  await ui.press({ key: 'lesson-save' })
  await seen.clock.settle()
  expect(seen.mutations).toEqual([])
  expect(await ui.find({ type: 'Text', text: /looks like a secret in wording/ })).toBeDefined()
  expect(seen.lessonStates.slice(before).some((s) => s.includes(SECRET) || s.includes('SENTINEL-native'))).toBe(false)
  await ui.unmount()
  expect(seen.forbidden).toEqual([])
})
