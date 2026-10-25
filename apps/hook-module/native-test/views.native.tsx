// Native engine tests for the console's sections: what each one draws from
// synthetic bridge answers, the review pages bound to one digest, and the
// narrow layout. Run by `claude plugin test` (scripts/test-native.ts copies
// this file as views.test.tsx), never by `bun test`.
//
// The bridge is answered beneath the plugin by a stand-in for `sil ops` that
// pages a fixed multibyte diff the way the host does (whole lines, one
// reviewed_state). Model, prompt, tool and filesystem calls and any other
// process are recorded and refused; every test asserts none happened.

import type { On, PluginState } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PANE = {
  plugin: 'self-improvement-loop',
  component: 'Pane',
  requestId: 'sil-console',
  props: {
    title: 'Self-improvement loop',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const TYPED = {
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const INERT_ENV = {
  HOME: '/nonexistent/sil-native-test/home',
  SIL_STATE_DIR: '/nonexistent/sil-native-test/state',
  SIL_DATA_DIR: '/nonexistent/sil-native-test/data',
  SIL_CONFIG_DIR: '/nonexistent/sil-native-test/config',
}

const DENIED = 'denied by the native test'
const DIGEST = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const NEWER = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'

type SilConsoleState = PluginState['self-improvement-loop']['console']
type Read = { id: string; op: string; args: Record<string, unknown> }
type Request = { version: 1; requestId: string; reads: Read[] }

const BOOT = { worlds: ['world-a', 'world-b'], selectedWorld: 'world-a', resolutionError: null, initialized: true }
const WORKER = { pending: 4, done: 9, failed: 1, lock_held: false, last_run: '2026-10-22T11:00:00.000Z' }

/** 450 lines of a multibyte diff: three pages of up to 200 lines. */
const DIFF = Array.from({ length: 450 }, (_, i) => `+ wiersz ${i}: zażółć gęślą jaźń 😀 ✓\n`).join('')
const BODY = '# Skill: keep tests honest\n\nRun the red test before the fix. 😀\n'

function reviewItem(pattern: string) {
  return { world: 'world-a', pattern, branch: `curriculum/world-a/${pattern}`, artifact_type: 'skill', status: 'staged', artifact_path: null, count: 3, staged_at: null, commit: 'abc1234' }
}

/** Whole lines with their endings, as the host splits them. */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

type Options = {
  /** Digest the proposal answers with; changes mid-test to model a new revision. */
  digest?: () => string
  /** Answer one proposal page with a line too big to show. */
  oversized?: boolean
  /** Answer the list read with this error. */
  listError?: { code: string; message: string }
  /** Answer every proposal page read with this error. */
  proposalError?: { code: string; message: string }
  /** Configured worlds; the first is selected. */
  worlds?: string[]
  /** The proposal body text (default BODY). */
  body?: string
  /** worker.status last_run. */
  lastRun?: string
  /** How many pending, done and failed entries queue.list returns. */
  queue?: [number, number, number]
  /** How many lessons the world has. */
  lessons?: number
}

function engine(on: On, options: Options = {}) {
  mock.env(on, INERT_ENV)
  const clock = mock.clock(on, { now: Date.parse('2026-10-22T12:00:00.000Z') })
  const seen = {
    requests: [] as Request[],
    forbidden: [] as string[],
    held: [] as Array<() => void>,
    hold: false,
    panes: [] as Array<{ id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }>,
    state: undefined as SilConsoleState | undefined,
    clock,
  }
  const digest = options.digest ?? (() => DIGEST)

  const boot = options.worlds ? { ...BOOT, worlds: options.worlds, selectedWorld: options.worlds[0]! } : BOOT
  const answer = (read: Read): unknown => {
    const a = read.args
    if (read.op === 'console.bootstrap') return { ok: true, value: boot }
    if (read.op === 'worker.status') return { ok: true, value: options.lastRun === undefined ? WORKER : { ...WORKER, last_run: options.lastRun } }
    if (read.op === 'queue.list' && options.queue) {
      const make = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ session_id: `${tag}-${i}`, world: 'world-a', last_stop: '2026-10-22T10:00:00.000Z', result: null }))
      const [p, d, f] = options.queue
      return { ok: true, value: { pending: make(p, 'pend'), done: make(d, 'done'), failed: make(f, 'fail'), hidden: { done: 0, failed: 0 }, cleared: { done: null, failed: null } } }
    }
    if (read.op === 'queue.list') {
      return { ok: true, value: { pending: [{ session_id: 'native-s1', world: 'world-b', last_stop: '2026-10-22T10:00:00.000Z', result: null }], done: [], failed: [], hidden: { done: 0, failed: 0 }, cleared: { done: null, failed: null } } }
    }
    if (read.op === 'logs.tail') return { ok: true, value: { name: 'worker', path: '/x/worker.log', exists: true, size: 20, lines: ['worker pass started', 'worker pass done'] } }
    if (read.op === 'console.page') {
      if (options.listError) return { ok: false, error: { ...options.listError, retryable: false } }
      const offset = a.offset as number
      const limit = a.limit as number
      const all =
        a.kind === 'review'
          ? [reviewItem('p-one'), reviewItem('p-two')]
          : a.kind === 'artifacts'
            ? [{ pattern: 'served-skill', artifact_type: 'skill', served_by: 'skills/served-skill/SKILL.md', status: 'active', reflections: 7, scorecard: null }]
            : a.kind === 'reflections'
              ? [{ id: 'r1', pattern: 'p-one', created: '2026-10-21', created_at: null, lesson: 'Reflection from the native fixture', artifacts_used: [], artifacts_helpful: [], artifacts_misfired: [] }]
              : Array.from({ length: options.lessons ?? 1 }, (_, i) => ({ id: `l${i}`, world: 'world-a', pattern: 'p-one', text: i === 0 ? 'Lesson from the native fixture' : `Lesson number ${i + 1}`, created: '2026-10-21T00:00:00Z' }))
      return { ok: true, value: { world: a.world, total: all.length, offset, limit, items: all.slice(offset, offset + limit) } }
    }
    if (read.op === 'console.proposalPage') {
      if (options.proposalError) return { ok: false, error: { ...options.proposalError, retryable: false } }
      const state = digest()
      if (typeof a.expectedState === 'string' && a.expectedState !== state) {
        return { ok: false, error: { code: 'ProposalChanged', message: 'The proposal changed since its first page was read.', retryable: false } }
      }
      const text = a.part === 'diff' ? DIFF : (options.body ?? BODY)
      const all = lines(text)
      const offset = a.offset as number
      const base = { world: a.world, pattern: a.pattern, part: a.part, offset, totalLines: all.length, totalBytes: new TextEncoder().encode(text).length, reviewedState: state }
      if (options.oversized && offset === 200) {
        return { ok: true, value: { ...base, text: '', lineCount: 0, nextOffset: 201, complete: false, oversizedLine: { line: 201, bytes: 90000 } } }
      }
      const end = Math.min(all.length, offset + (a.limit as number))
      const atEnd = end === all.length
      return { ok: true, value: { ...base, text: all.slice(offset, end).join(''), lineCount: end - offset, nextOffset: atEnd ? null : end, complete: atEnd, oversizedLine: null } }
    }
    return { ok: false, error: { code: 'OpNotAllowed', message: 'not in this test', retryable: false } }
  }

  on('state.set', { plugin: 'self-improvement-loop', key: 'console' }, (_, e, next) => {
    seen.state = JSON.parse(JSON.stringify(e.value)) as SilConsoleState
    return next(e)
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => {
    if (!seen.panes.some((p) => p.id === e.id)) seen.panes.push({ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true })
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({ value: seen.panes.map((p) => ({ ...p })) }))
  on('ui.close', (_, e) => {
    seen.panes = seen.panes.filter((p) => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('command.run', (_, e) => ({ text: `core ran ${e.command}` }))
  on('process.run', async (_, e) => {
    const argv = [...e.argv]
    const isBridge = argv.length === 3 && argv[0] === '/bin/sh' && String(argv[1]).endsWith('/scripts/sil') && argv[2] === 'ops'
    if (!isBridge) {
      seen.forbidden.push(`process.run ${argv.join(' ')}`)
      return { deny: DENIED }
    }
    const request = JSON.parse(e.init?.stdin ?? 'null') as Request
    seen.requests.push(request)
    const results: Record<string, unknown> = {}
    for (const read of request.reads) results[read.id] = answer(read)
    const value = { exitCode: 0, stdout: `${JSON.stringify({ version: 1, requestId: request.requestId, results })}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    if (seen.hold) await new Promise<void>((resolve) => seen.held.push(resolve))
    return { value }
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
  return seen
}

type Seen = ReturnType<typeof engine>

async function openConsole($: Engine, seen: Seen) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
}

function lastRead(seen: Seen, id: string): Read | undefined {
  return seen.requests.at(-1)?.reads.find((r) => r.id === id)
}

test('every section is drawn with its label and keyed controls, and no mutating control', async ($, on) => {
  const seen = engine(on)
  await openConsole($, seen)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const [key, label] of [['section-overview', 'Overview'], ['section-review', 'Review'], ['section-artifacts', 'Artifacts'], ['section-activity', 'Activity'], ['section-settings', 'Settings']] as const) {
    await ui.press({ key })
    await seen.clock.settle()
    // The current tab is shown by color, not by a "(current)" suffix.
    const tabs = (await ui.findAll({ type: 'Button' })).filter((t) => t.key?.startsWith('section-'))
    expect(tabs.map((t) => [t.key, t.props.label, t.props.variant ?? null, t.props.dimColor ?? null])).toEqual(
      tabs.map((t) => (t.key === key ? [key, label, 'primary', null] : [t.key, t.props.label, null, true])),
    )
    expect(tabs).toHaveLength(5)
    expect(await ui.findAll({ type: 'Input' })).toEqual([])
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.filter((b) => /accept|reject|revise|save/i.test(`${b.key} ${b.text}`))).toEqual([])
  }
  // Settings is a placeholder, said in words.
  expect((await ui.find({ type: 'Text', text: /read only/i }))).toBeDefined()
  await ui.unmount()
  expect(seen.forbidden).toEqual([])
})

test('synthetic records are drawn: artifacts, and activity with global scope in words', async ($, on) => {
  const seen = engine(on)
  await openConsole($, seen)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'section-artifacts' })
  await seen.clock.settle()
  expect((await ui.find({ type: 'Text', text: /served-skill: skill, active, 7 reflections/ }))?.text).toContain('skills/served-skill/SKILL.md')
  await ui.press({ key: 'section-activity' })
  await seen.clock.settle()
  expect((await ui.find({ type: 'Text', text: /Worker \(global, all worlds\)/ }))?.text).toContain('Pending: 4')
  expect(await ui.find({ type: 'Text', text: /Queue \(global, all worlds\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Pending: 1 newest drawn of 1 returned.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /native-s1 \(world-b\)/ })).toBeDefined()
  await ui.press({ key: 'activity-tab-reflections' })
  await seen.clock.settle()
  expect(await ui.find({ type: 'Text', text: /Reflection from the native fixture/ })).toBeDefined()
  await ui.press({ key: 'activity-tab-lessons' })
  await seen.clock.settle()
  expect(await ui.find({ type: 'Text', text: /Lesson from the native fixture/ })).toBeDefined()
  await ui.press({ key: 'activity-tab-log' })
  await seen.clock.settle()
  expect((await ui.find({ type: 'Text', text: /Worker log \(global/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /worker pass done/ }))).toBeDefined()
  await ui.unmount()
  const ops = [...new Set(seen.requests.flatMap((r) => r.reads.map((x) => x.op)))].sort()
  expect(ops).toEqual(['console.bootstrap', 'console.page', 'logs.tail', 'queue.list', 'worker.status'])
  expect(seen.forbidden).toEqual([])
})

test('a review read page by page keeps one digest and puts the diff back together exactly', async ($, on) => {
  const seen = engine(on)
  await openConsole($, seen)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'section-review' })
  await seen.clock.settle()
  expect((await ui.find({ type: 'Text', text: /Proposals 1-2 of 2 in world-a/ }))).toBeDefined()
  await ui.press({ key: 'proposal-p-one' })
  await seen.clock.settle()
  expect(lastRead(seen, 'proposal')?.args).toEqual({ world: 'world-a', pattern: 'p-one', part: 'body', offset: 0, limit: 200 })
  expect((await ui.find({ type: 'Code' }))?.text).toBe(BODY)
  expect((await ui.find({ type: 'Text', text: `Reviewed state: ${DIGEST}` }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /End of the body/ }))).toBeDefined()

  await ui.press({ key: 'part-diff' })
  await seen.clock.settle()
  const pages: string[] = []
  for (let n = 0; n < 3; n++) {
    const read = lastRead(seen, 'proposal')!
    expect(read.args).toEqual({ world: 'world-a', pattern: 'p-one', part: 'diff', offset: n * 200, limit: 200, expectedState: DIGEST })
    const code = await ui.find({ type: 'Code' })
    pages.push(code!.text)
    // The full digest stays on screen on every page.
    expect((await ui.find({ type: 'Text', text: `Reviewed state: ${DIGEST}` }))).toBeDefined()
    if (n < 2) {
      expect((await ui.find({ type: 'Text', text: /not the whole diff/ }))).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /End of the diff/ })).toBeUndefined()
      await ui.press({ key: 'page-next' })
      await seen.clock.settle()
    }
  }
  expect((await ui.find({ type: 'Text', text: /End of the diff/ }))).toBeDefined()
  expect(await ui.find({ key: 'page-next' })).toBeUndefined()
  expect(pages.join('')).toBe(DIFF)
  expect(seen.state?.proposal).toMatchObject({ part: 'diff', offset: 400, back: [0, 200], reviewedState: DIGEST })

  await ui.press({ key: 'page-prev' })
  await seen.clock.settle()
  expect(lastRead(seen, 'proposal')?.args).toMatchObject({ offset: 200, expectedState: DIGEST })
  await ui.unmount()
  expect(seen.forbidden).toEqual([])
})

test('a proposal that changes between pages is refused visibly and can be read again', async ($, on) => {
  let digest = DIGEST
  const seen = engine(on, { digest: () => digest })
  await openConsole($, seen)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'section-review' })
  await seen.clock.settle()
  await ui.press({ key: 'proposal-p-one' })
  await seen.clock.settle()
  await ui.press({ key: 'part-diff' })
  await seen.clock.settle()
  digest = NEWER
  await ui.press({ key: 'page-next' })
  await seen.clock.settle()
  expect((await ui.find({ type: 'Text', text: /changed while you were reading/ }))?.text).toContain('Error')
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(seen.state?.proposal?.reviewedState).toBe(DIGEST)

  await ui.press({ key: 'proposal-reload' })
  await seen.clock.settle()
  expect(lastRead(seen, 'proposal')?.args).toEqual({ world: 'world-a', pattern: 'p-one', part: 'diff', offset: 0, limit: 200 })
  expect(seen.state?.proposal?.reviewedState).toBe(NEWER)
  expect((await ui.find({ type: 'Text', text: `Reviewed state: ${NEWER}` }))).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  await ui.unmount()
})

test('a line too big for a page is reported and never drawn as the end', async ($, on) => {
  const seen = engine(on, { oversized: true })
  await openConsole($, seen)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'section-review' })
  await seen.clock.settle()
  await ui.press({ key: 'proposal-p-one' })
  await seen.clock.settle()
  await ui.press({ key: 'part-diff' })
  await seen.clock.settle()
  await ui.press({ key: 'page-next' })
  await seen.clock.settle()
  expect((await ui.find({ type: 'Text', text: /Line 201 of 450 is 90000 bytes/ }))?.text).toContain('left out here, not cut')
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /End of the diff/ })).toBeUndefined()
  await ui.press({ key: 'page-next' })
  await seen.clock.settle()
  expect(lastRead(seen, 'proposal')?.args).toMatchObject({ offset: 201, expectedState: DIGEST })
  await ui.unmount()
})

test('a failed list read stays visible as an error, with no made-up rows', async ($, on) => {
  const seen = engine(on, { listError: { code: 'ConfigError', message: 'config.yaml is invalid' } })
  await openConsole($, seen)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'section-review' })
  await seen.clock.settle()
  expect((await ui.find({ type: 'Text', text: /config.yaml is invalid/ }))?.text).toContain('Error: Proposals unavailable')
  expect(await ui.find({ key: 'proposal-p-one' })).toBeUndefined()
  await ui.unmount()
})

test('a proposal page git could not read is an error, never an empty finished diff', async ($, on) => {
  const message = 'git diff failed in the target of world "world-a"'
  const seen = engine(on, { proposalError: { code: 'StateReadError', message } })
  await openConsole($, seen)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'section-review' })
  await seen.clock.settle()
  await ui.press({ key: 'proposal-p-one' })
  await seen.clock.settle()
  await ui.press({ key: 'part-diff' })
  await seen.clock.settle()
  expect((await ui.find({ type: 'Text', text: /git diff failed/ }))?.text).toContain('Error')
  expect(await ui.find({ type: 'Text', text: /End of the diff/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /The diff is empty/ })).toBeUndefined()
  await ui.unmount()
  expect(seen.forbidden).toEqual([])
})

test('a slow overview reply is not drawn under Review', async ($, on) => {
  const seen = engine(on)
  await openConsole($, seen)
  seen.hold = true
  await seen.clock.advance(10000)
  expect(seen.held).toHaveLength(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'section-review' })
  seen.hold = false
  seen.held.shift()!()
  await seen.clock.settle()
  expect(seen.state?.section).toBe('review')
  expect(Object.keys(seen.state?.results ?? {}).sort()).toEqual(['bootstrap', 'list', 'worker'])
  expect(await ui.find({ type: 'Text', text: /staged proposals waiting/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Proposals 1-2 of 2/ }))).toBeDefined()
  await ui.unmount()
})

test('narrow: one section Select and list or detail; mobile, with no Select, gets buttons', async ($, on) => {
  const seen = engine(on)
  await openConsole($, seen)
  const narrow = { ...PANE, props: { ...PANE.props, bodyColumns: 43 } }
  const ui = await $.ui.mount({ ...narrow, surface: 'terminal' })
  expect((await ui.find({ key: 'section-select' }))?.type).toBe('Select')
  expect(await ui.find({ key: 'section-review' })).toBeUndefined()
  await ui.select({ key: 'section-select', value: 'review' })
  await seen.clock.settle()
  expect(seen.state?.section).toBe('review')
  await ui.press({ key: 'proposal-p-one' })
  await seen.clock.settle()
  expect(await ui.find({ key: 'proposal-p-two' })).toBeUndefined()
  expect((await ui.find({ key: 'proposal-back' }))?.props.label).toBe('Back to the list')
  expect((await ui.find({ type: 'Code' }))?.text).toBe(BODY)
  await ui.press({ key: 'proposal-back' })
  await seen.clock.settle()
  expect(await ui.find({ key: 'proposal-p-two' })).toBeDefined()
  await ui.unmount()

  const wide = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 44 }, surface: 'terminal' })
  expect(await wide.drawn()).toMatchObject({ type: 'Box' })
  expect(await wide.find({ key: 'section-select' })).toBeUndefined()
  expect((await wide.find({ key: 'section-review' }))?.type).toBe('Button')
  await wide.unmount()

  const phone = await $.ui.mount({ ...narrow, surface: 'mobile' })
  expect(await phone.drawn()).toMatchObject({ type: 'Box' })
  expect(await phone.find({ type: 'Select' })).toBeUndefined()
  expect((await phone.find({ key: 'section-overview' }))?.type).toBe('Button')
  await phone.unmount()
  expect(seen.forbidden).toEqual([])
})

type Drawn = { type?: string; key?: string; props?: Record<string, unknown>; children?: unknown[] }

/** Every element of a drawn tree, outermost first, in document order. */
function elements(node: unknown, out: Drawn[] = []): Drawn[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out)
    return out
  }
  if (typeof node !== 'object' || node === null) return out
  const el = node as Drawn
  out.push(el)
  elements(el.children ?? [], out)
  return out
}

/** The element's own string children. */
function ownText(el: Drawn): string {
  return (el.children ?? []).filter((c): c is string => typeof c === 'string').join('')
}

test('cards: a round frame at 80 columns, none at 40; header above them, footer below', async ($, on) => {
  const seen = engine(on)
  await openConsole($, seen)
  const wide = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 80 }, surface: 'terminal' })
  const all = elements(await wide.drawn())
  const framed = all.filter((el) => el.type === 'Box' && el.props?.borderStyle === 'round')
  // Worker, Review and Actions.
  expect(framed).toHaveLength(3)
  expect(framed.some((box) => elements(box.children ?? []).some((el) => el.type === 'Text' && ownText(el) === 'Actions'))).toBe(true)
  const worker = framed.find((box) => elements(box.children ?? []).some((el) => el.type === 'Text' && ownText(el) === 'Worker'))
  expect(worker).toBeDefined()
  expect(elements(worker!.children ?? []).some((el) => el.type === 'Text' && ownText(el) === 'global, all worlds')).toBe(true)
  // The title row holds the title and the worlds, not the tabs; the tabs come
  // before the first card and Refresh after the last.
  const at = (pred: (el: Drawn) => boolean) => all.findIndex(pred)
  const titleRow = all.find((el) => el.type === 'Box' && (el.children ?? []).some((c) => typeof c === 'object' && c !== null && ownText(c as Drawn) === 'Self-improvement loop'))
  expect(titleRow).toBeDefined()
  const inTitle = elements(titleRow!.children ?? [])
  expect(inTitle.some((el) => el.props?.key === 'world-world-a')).toBe(true)
  expect(inTitle.some((el) => el.props?.key === 'section-overview')).toBe(false)
  const overviewTab = at((el) => el.props?.key === 'section-overview')
  const firstCard = all.indexOf(framed[0]!)
  const lastCardEnd = all.indexOf(framed.at(-1)!) + elements(framed.at(-1)!.children ?? []).length
  const refresh = at((el) => el.props?.key === 'refresh')
  expect(at((el) => ownText(el) === 'Self-improvement loop')).toBeLessThan(overviewTab)
  expect(overviewTab).toBeLessThan(firstCard)
  expect(refresh).toBeGreaterThan(lastCardEnd)
  expect(at((el) => /^refreshed .* every 10 s$/.test(ownText(el)))).toBeGreaterThan(lastCardEnd)
  await wide.unmount()

  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 }, surface: 'terminal' })
  const small = elements(await narrow.drawn())
  expect(small.some((el) => el.type === 'Text' && ownText(el) === 'Worker')).toBe(true)
  expect(small.filter((el) => el.type === 'Box' && el.props?.borderStyle !== undefined)).toEqual([])
  expect((await narrow.find({ key: 'section-select' }))?.type).toBe('Select')
  expect((await narrow.find({ key: 'world-select' }))?.type).toBe('Select')
  await narrow.unmount()
  expect(seen.forbidden).toEqual([])
})

// --- fix round 1 ----------------------------------------------------------------

const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

/** Every string anywhere in a drawn tree, props and children alike. */
function allStrings(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap(allStrings)
  if (typeof node === 'object' && node !== null) return Object.values(node).flatMap(allStrings)
  return []
}

/** Every character a drawn tree shows: string children, labels, option labels
 * and values, Code sources. */
function drawnChars(node: unknown): number {
  if (typeof node === 'string') return node.length
  if (Array.isArray(node)) return node.reduce((n: number, c) => n + drawnChars(c), 0)
  if (typeof node !== 'object' || node === null) return 0
  const el = node as { props?: Record<string, unknown>; children?: unknown[] }
  const p = el.props ?? {}
  let n = 0
  for (const k of ['label', 'source']) if (typeof p[k] === 'string') n += (p[k] as string).length
  if (Array.isArray(p.options)) for (const o of p.options as Array<{ value: string; label?: string }>) n += o.value.length + (o.label?.length ?? 0)
  return n + drawnChars(el.children ?? [])
}

test('800 long worlds and a near-cap page: a world window, the page whole, under the budget', async ($, on) => {
  const worlds = Array.from({ length: 800 }, (_, i) => `w${String(i).padStart(3, '0')}${'x'.repeat(60)}`)
  const body = `${'b'.repeat(65534)}\n`
  const seen = engine(on, { worlds, body })
  await openConsole($, seen)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'section-review' })
  await seen.clock.settle()
  await ui.press({ key: 'proposal-p-one' })
  await seen.clock.settle()
  const tree = await ui.drawn()
  expect(drawnChars(tree)).toBeLessThanOrEqual(90000)
  expect((await ui.find({ type: 'Code' }))?.text).toBe(body)
  expect(await ui.find({ type: 'Text', text: /End of the body/ })).toBeDefined()
  const worldButtons = (await ui.findAll({ type: 'Button' })).filter((b) => b.key?.startsWith('world-'))
  expect(worldButtons).toHaveLength(25)
  expect(await ui.find({ type: 'Text', text: 'Worlds 1-25 of 800:' })).toBeDefined()
  const generation = seen.state!.generation
  const requests = seen.requests.length
  await ui.press({ key: 'worlds-next' })
  await seen.clock.settle()
  expect(seen.state?.world).toBe(worlds[0])
  expect(seen.state?.generation).toBe(generation)
  expect(seen.requests.length).toBe(requests)
  expect(await ui.find({ type: 'Text', text: 'Worlds 26-50 of 800:' })).toBeDefined()
  // The current world stays in the window, marked current.
  expect((await ui.find({ key: `world-${worlds[0]}` }))?.props.label).toContain('(current)')
  expect(await ui.find({ key: `world-${worlds[30]}` })).toBeDefined()
  await ui.unmount()

  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 30 }, surface: 'terminal' })
  const select = await narrow.find({ key: 'world-select' })
  expect((select?.props.options as unknown[]).length).toBeLessThanOrEqual(26)
  expect(drawnChars(await narrow.drawn())).toBeLessThanOrEqual(90000)
  await narrow.unmount()
  expect(seen.forbidden).toEqual([])
})

test('valid world controls have unique keys and each selects its own world', async ($, on) => {
  const worlds = ['first', 'é', 'at-1']
  const seen = engine(on, { worlds })
  await openConsole($, seen)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const worldButtons = async () => (await ui.findAll({ type: 'Button' })).filter((button) => button.key?.startsWith('world-'))

  const initial = await worldButtons()
  expect(initial).toHaveLength(worlds.length)
  expect(new Set(initial.map((button) => button.key)).size).toBe(worlds.length)
  expect(initial.flatMap((button) => [button.key ?? '', String(button.props.label ?? '')]).filter((text) => UNSAFE.test(text))).toEqual([])

  for (const world of worlds) {
    const button = (await worldButtons()).find((item) => item.props.label === world || item.props.label === `${world} (current)`)
    expect(button).toBeDefined()
    await ui.press({ key: button!.key! })
    await seen.clock.settle()
    expect(seen.state?.world).toBe(world)
  }
  await ui.unmount()
  expect(seen.forbidden).toEqual([])
})

test('every lesson is reachable by its own pages', async ($, on) => {
  const seen = engine(on, { lessons: 12 })
  await openConsole($, seen)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'section-activity' })
  await seen.clock.settle()
  await ui.press({ key: 'activity-tab-lessons' })
  await seen.clock.settle()
  expect(await ui.find({ type: 'Text', text: /Lessons 1-5 of 12/ })).toBeDefined()
  await ui.press({ key: 'lessons-next' })
  await seen.clock.settle()
  await ui.press({ key: 'lessons-next' })
  await seen.clock.settle()
  expect(await ui.find({ type: 'Text', text: /Lessons 11-12 of 12/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Lesson number 12/ })).toBeDefined()
  expect(await ui.find({ key: 'lessons-next' })).toBeUndefined()
  // The reflections list did not move.
  expect(seen.state?.listOffset).toBe(0)
  await ui.unmount()
})

for (const [label, counts, drawnPending, cap] of [
  ['beyond the drawn rows', [12, 4, 8], 5, false],
  ['at the host cap', [200, 200, 0], 5, true],
] as const) {
  test(`queue counts are told apart ${label}`, async ($, on) => {
    const seen = engine(on, { queue: [...counts] })
    await openConsole($, seen)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'section-activity' })
    await seen.clock.settle()
    expect(await ui.find({ type: 'Text', text: `Pending: ${drawnPending} newest drawn of ${counts[0]} returned.` })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /^pending: pend-/ })).toHaveLength(drawnPending)
    expect(await ui.find({ type: 'Text', text: `Done: ${counts[1]} returned, none drawn here.` })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /^done: / })).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: /\bshown\b/ })).toBeUndefined()
    expect(Boolean(await ui.find({ type: 'Text', text: /full counts may be higher/ }))).toBe(cap)
    await ui.unmount()
  })
}

test('control characters from the bridge reach native Text only as symbols, with a note', async ($, on) => {
  const seen = engine(on, { lastRun: '\u001b[31mred\u0085', listError: { code: 'ConfigError', message: 'bad\u0007bell\u009b2J' } })
  await openConsole($, seen)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'section-activity' })
  await seen.clock.settle()
  // The list error is drawn in the Reflections part.
  await ui.press({ key: 'activity-tab-reflections' })
  await seen.clock.settle()
  const texts = (await ui.findAll({ type: 'Text' })).map((t) => t.text)
  expect(texts.some((t) => t.includes('last run \u241b[31mred\ufffd'))).toBe(true)
  expect(texts.some((t) => t.includes('bad\u2407bell\ufffd2J'))).toBe(true)
  expect(texts.some((t) => /control characters are shown as symbols/.test(t))).toBe(true)
  const strings = allStrings(await ui.drawn())
  expect(strings.length).toBeGreaterThan(20)
  // Positive control: the same check does see a raw ESC.
  expect(strings.concat(['\u001b']).filter((t) => UNSAFE.test(t))).toEqual(['\u001b'])
  expect(strings.filter((t) => UNSAFE.test(t))).toEqual([])
  // The stored source data is untouched: only the drawing changed.
  expect(JSON.stringify(seen.state?.results.worker)).toContain('\\u001b[31mred')
  await ui.unmount()
})
