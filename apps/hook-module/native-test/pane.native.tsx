// Native engine test for the /sil command and its pane. It runs under
// `claude plugin test`, never under `bun test`: scripts/test-native.ts copies it
// as pane.test.tsx into a throwaway plugin holding only the manifest, the
// contract, the hook config and the built module.
//
// Hooks registered on the test's `on` sit beneath the plugin and stand for the
// engine. The ones on model, prompt, tool and filesystem calls, and on any
// process but the loaded plugin's own `sil ops` bridge, record the call and,
// where the call has a caller to refuse, deny it: the console path must reach
// none of them, and a test fails if it does. The bridge is answered with
// synthetic replies, held back when a test needs a slow one; `$.state` is the
// kit's own, and `$.clock` is a mock clock the test moves.

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

// What the engine stamps on a command the person typed at the prompt.
const TYPED = {
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

// Every variable the module may read points at a path that does not exist, so
// nothing from the real home can leak into the test.
const INERT_ENV = {
  HOME: '/nonexistent/sil-native-test/home',
  SIL_STATE_DIR: '/nonexistent/sil-native-test/state',
  SIL_DATA_DIR: '/nonexistent/sil-native-test/data',
  SIL_CONFIG_DIR: '/nonexistent/sil-native-test/config',
}

const DENIED = 'denied by the native test'

type Options = {
  register?: 'ok' | 'deny'
  open?: 'placed' | 'unplaced' | 'deny'
  /** How the engine beneath answers a pane close. */
  close?: 'ok' | 'deny' | 'throw'
  /** `deny`: `$.session.cwd()` is refused. */
  cwd?: 'ok' | 'deny'
}

/** The console's state as the plugin's contract (types/index.d.ts) declares it. */
type SilConsoleState = PluginState['self-improvement-loop']['console']

type Read = { id: string; op: string; args: Record<string, unknown> }
type Request = { version: 1; requestId: string; reads: Read[] }
type RunValue = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }

const BOOT = { worlds: ['world-a', 'world-b'], selectedWorld: 'world-a', resolutionError: null, initialized: true }
const WORKER = { pending: 4, done: 9, failed: 0, lock_held: false, last_run: '2026-10-22T11:00:00.000Z' }

/** The Overview's bounded review read: one item and the full total. */
function reviewPage(world: string, patterns: string[]) {
  return { world, total: patterns.length, offset: 0, limit: 1, items: patterns.slice(0, 1).map((pattern) => ({ pattern })) }
}

/** What `sil ops` would answer, per read: the three cheap reads, by op. */
function answerReads(request: Request): Record<string, unknown> {
  const results: Record<string, unknown> = {}
  for (const read of request.reads) {
    if (read.op === 'console.bootstrap') results[read.id] = { ok: true, value: BOOT }
    else if (read.op === 'worker.status') results[read.id] = { ok: true, value: WORKER }
    else if (read.op === 'console.page' && read.args.kind === 'review') results[read.id] = { ok: true, value: reviewPage(String(read.args.world), [`queued-in-${String(read.args.world)}`]) }
    else results[read.id] = { ok: false, error: { code: 'OpNotAllowed', message: 'not in this test', retryable: false } }
  }
  return results
}

function envelope(request: Request): RunValue {
  const body = { version: 1, requestId: request.requestId, results: answerReads(request) }
  return { exitCode: 0, stdout: `${JSON.stringify(body)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

/** The engine beneath the plugin. Returns what the test asserts on. */
function engine(on: On, options: Options = {}) {
  mock.env(on, INERT_ENV)
  const clock = mock.clock(on, { now: Date.parse('2026-10-22T12:00:00.000Z') })
  const seen = {
    registered: [] as string[],
    opened: [] as string[],
    coreCommands: [] as string[],
    logs: [] as string[],
    forbidden: [] as string[],
    /** Every request the console sent to the bridge, decoded. */
    requests: [] as Request[],
    /** Replies held back by `hold`, oldest first. */
    held: [] as Array<{ request: Request; release: (value?: RunValue) => void }>,
    /** While true, each bridge call waits for the test to release it. */
    hold: false,
    panes: [] as Array<{ id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }>,
    /** The console state as last written, seen on its way to the kit's store. */
    state: undefined as SilConsoleState | undefined,
    stateWrites: 0,
    /** While set, each console state write waits here before it reaches the kit. */
    stateHold: null as Promise<void> | null,
    clock,
  }

  // The kit holds `$.state`; this watches the console's writes pass, and
  // holds them while a test asks.
  on('state.set', { plugin: 'self-improvement-loop', key: 'console' }, async (_, e, next) => {
    if (seen.stateHold) await seen.stateHold
    seen.state = JSON.parse(JSON.stringify(e.value)) as SilConsoleState
    seen.stateWrites += 1
    return next(e)
  })

  on('command.register', (_, e) => {
    seen.registered.push(e.name)
    return options.register === 'deny' ? { deny: DENIED } : { value: { command: e.name } }
  })
  on('ui.open', (_, e) => {
    seen.opened.push(e.id)
    if (options.open === 'deny') return { deny: DENIED }
    const isPlaced = options.open !== 'unplaced'
    if (!seen.panes.some((p) => p.id === e.id)) {
      seen.panes.push({ id: e.id, title: e.title ?? e.id, isShown: isPlaced, isFocused: false, isPlaced })
    }
    if (!isPlaced) return { value: { isPlaced: false as const, reason: 'no-surface in the native test' } }
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({ value: seen.panes.map((p) => ({ ...p })) }))
  on('ui.close', (_, e) => {
    if (options.close === 'deny') return { deny: DENIED }
    if (options.close === 'throw') throw new Error('close threw beneath the plugin')
    seen.panes = seen.panes.filter((p) => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', () => (options.cwd === 'deny' ? { deny: `${DENIED} at /private/native/path` } : { value: '/work/repo' }))
  on('command.run', (_, e) => {
    seen.coreCommands.push(e.command)
    return { text: `core ran ${e.command}` }
  })

  // The one process the console may start: the loaded plugin's own bridge,
  // `/bin/sh <root>/scripts/sil ops`, read-only. Anything else is forbidden.
  on('process.run', async (_, e) => {
    const argv = [...e.argv]
    const isBridge = argv.length === 3 && argv[0] === '/bin/sh' && String(argv[1]).endsWith('/scripts/sil') && argv[2] === 'ops'
    if (!isBridge) {
      seen.forbidden.push(`process.run ${argv.join(' ')}`)
      return { deny: DENIED }
    }
    const request = JSON.parse(e.init?.stdin ?? 'null') as Request
    seen.requests.push(request)
    if (!seen.hold) return { value: envelope(request) }
    const value = await new Promise<RunValue>((resolve) => {
      seen.held.push({ request, release: (v) => resolve(v ?? envelope(request)) })
    })
    return { value }
  })

  // Calls the console must never make. Each is recorded; those with a caller
  // to refuse are denied so the module cannot read through to the real host.
  on('model.complete', () => {
    seen.forbidden.push('model.complete')
    return { deny: DENIED } as never
  })
  on('model.classify', () => {
    seen.forbidden.push('model.classify')
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
  for (const op of ['fs.read', 'fs.write', 'fs.list', 'fs.exists', 'fs.stat', 'fs.ancestors'] as const) {
    on(op, () => {
      seen.forbidden.push(op)
      return { deny: DENIED } as never
    })
  }
  return seen
}

type Seen = ReturnType<typeof engine>

async function start($: Engine) {
  return $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

/** Releases the oldest held bridge reply and lets the console run on. */
async function release(seen: Seen, value?: RunValue) {
  const next = seen.held.shift()
  if (!next) throw new Error('no held bridge reply')
  next.release(value)
  await seen.clock.settle()
}

function ops(seen: Seen): string[] {
  return [...new Set(seen.requests.flatMap((r) => r.reads.map((read) => read.op)))].sort()
}

// A plugin loaded beside the one under test that does touch the filesystem
// and a process, so the guard is shown to catch what it exists for. It runs in
// an environment of its own, so it can only be observed through the guard.
const PROBE = {
  name: 'sil-native-probe',
  register: (on: On) => {
    on('session.start', async ($, e, next) => {
      await $.fs.exists('/').catch(() => undefined)
      await $.process.run(['true']).catch(() => undefined)
      return next(e)
    })
  },
}

test('the forbidden-call guard sees filesystem and process access (positive control)', { plugins: [PROBE] }, async ($, on) => {
  const seen = engine(on)
  await start($)
  expect(seen.forbidden).toEqual(['fs.exists', 'process.run true'])
  expect(seen.requests).toEqual([])
})

test('/sil reads the bootstrap, then the owning world, and draws it on every surface', async ($, on) => {
  const seen = engine(on)

  await start($)
  expect(seen.registered).toContain('sil')
  expect(seen.requests).toEqual([])

  const ran = await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  expect(seen.opened).toContain('sil-console')
  // /sil answers for itself: core never runs a command of that name.
  expect(seen.coreCommands).not.toContain('sil')
  expect(ran.text).toBe('Opened the self-improvement loop console.')

  expect(seen.requests).toHaveLength(2)
  expect(seen.requests[0]!.reads).toEqual([
    { id: 'bootstrap', op: 'console.bootstrap', args: { cwd: '/work/repo' } },
    { id: 'worker', op: 'worker.status', args: {} },
  ])
  expect(seen.requests[1]!.reads).toContainEqual({ id: 'review', op: 'console.page', args: { world: 'world-a', kind: 'review', offset: 0, limit: 1 } })
  const state = seen.state
  expect(state).toMatchObject({ world: 'world-a', loading: false, error: null, lastSuccessAt: '2026-10-22T12:00:00.000Z' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'world-world-a' }))?.props.label).toBe('world-a (current)')
    expect((await ui.find({ type: 'Text', text: /1 staged proposal/ }))?.text).toContain('waiting for review')
    expect((await ui.find({ type: 'Text', text: /Pending: 4/ }))?.text).toContain('done: 9')
    await ui.unmount()
  }

  expect(ops(seen)).toEqual(['console.bootstrap', 'console.page', 'worker.status'])
  expect(seen.forbidden).toEqual([])
  expect(seen.logs).toEqual([])
})

test('a slow world-a reply is dropped after switching to world-b', async ($, on) => {
  const seen = engine(on)
  await start($)
  seen.hold = true
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  await release(seen) // bootstrap -> world-a
  expect(seen.held).toHaveLength(1) // the world-a read, held

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'world-world-b' })
  await seen.clock.settle()
  expect(seen.state).toMatchObject({ world: 'world-b' })
  // No overlap: world-b waits for the world-a read to end.
  expect(seen.requests).toHaveLength(2)

  await release(seen) // the late world-a reply
  const state = seen.state
  expect(state?.world).toBe('world-b')
  expect(JSON.stringify(state?.results)).not.toContain('queued-in-world-a')
  expect(seen.requests).toHaveLength(3)
  expect(seen.requests[2]!.reads).toContainEqual({ id: 'review', op: 'console.page', args: { world: 'world-b', kind: 'review', offset: 0, limit: 1 } })
  await release(seen)
  expect(JSON.stringify(seen.state?.results)).toContain('queued-in-world-b')
  expect((await ui.find({ key: 'world-world-b' }))?.props.label).toBe('world-b (current)')
  await ui.unmount()
  expect(seen.forbidden).toEqual([])
})

test('one refresh per 10 s while shown, never overlapping, none hidden or closed', async ($, on) => {
  const seen = engine(on)
  await start($)
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  expect(seen.requests).toHaveLength(2)

  await seen.clock.advance(9999)
  expect(seen.requests).toHaveLength(2)
  await seen.clock.advance(1)
  expect(seen.requests).toHaveLength(3)

  // A slow read: the next two periods start nothing of their own.
  seen.hold = true
  await seen.clock.advance(10000)
  expect(seen.requests).toHaveLength(4)
  await seen.clock.advance(10000)
  await seen.clock.advance(10000)
  expect(seen.requests).toHaveLength(4)
  seen.hold = false
  await release(seen)
  // One follow-up for the periods that passed, not one each.
  expect(seen.requests).toHaveLength(5)

  // Behind another tab: the timer runs, nothing is read.
  seen.panes[0]!.isShown = false
  await seen.clock.advance(30000)
  expect(seen.requests).toHaveLength(5)
  seen.panes[0]!.isShown = true
  await seen.clock.advance(10000)
  expect(seen.requests).toHaveLength(6)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'close' })
  await ui.unmount()
  expect(seen.panes).toEqual([])
  await seen.clock.advance(60000)
  expect(seen.requests).toHaveLength(6)
  expect(ops(seen)).toEqual(['console.bootstrap', 'console.page', 'worker.status'])
  expect(seen.forbidden).toEqual([])
})

test('a failed bridge is shown as an error and old values are labelled stale', async ($, on) => {
  const seen = engine(on)
  await start($)
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  const good = seen.state

  seen.hold = true
  await seen.clock.advance(10000)
  await release(seen, { exitCode: 1, stdout: '', stderr: 'boom sk-native-secret-0123456789', isStdoutTruncated: false, isStderrTruncated: false })
  const state = seen.state
  expect(state?.results).toEqual(good?.results)
  expect(state?.lastSuccessAt).toBe(good?.lastSuccessAt)
  expect(state?.error).toContain('exited with 1')
  expect(JSON.stringify(state)).not.toContain('sk-native-secret')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /exited with 1/ }))?.text).toContain('Error')
  // The refresh time is drawn short (12:00, or Oct 22 12:00 on another day), never as ISO.
  const stale = (await ui.find({ type: 'Text', text: /stale/ }))?.text
  expect(stale).toMatch(/last complete refresh (Oct 22 )?\d{2}:\d{2}\)/)
  expect(stale).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  expect((await ui.find({ type: 'Text', text: /Pending: 4/ }))).toBeDefined()
  await ui.unmount()
})

test('a first read that fails shows the failure and no numbers', async ($, on) => {
  const seen = engine(on)
  await start($)
  seen.hold = true
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  await release(seen, { exitCode: 2, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /exited with 2/ }))).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Pending|staged/ })).toBeUndefined()
  await ui.unmount()
})

test('after /clear the timer stops, and /sil brings it back with no session.start', async ($, on) => {
  const seen = engine(on)
  await start($)
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  const before = seen.requests.length

  await $.session.end({ reason: 'clear', sessionId: 'native-session', resume: { id: 'native-session' } } as never)
  await seen.clock.advance(60000)
  expect(seen.requests).toHaveLength(before)

  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  expect(seen.requests.length).toBe(before + 1)
  await seen.clock.advance(10000)
  expect(seen.requests.length).toBe(before + 2)
})

for (const stop of ['clear', 'close'] as const) {
  test(`a press whose state write is still held when the ${stop} lands reads nothing after`, async ($, on) => {
    const seen = engine(on)
    await start($)
    await $.command.run({ command: 'sil', ...TYPED })
    await seen.clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const before = seen.requests.length
    let open!: () => void
    seen.stateHold = new Promise<void>((r) => (open = r))
    await ui.press({ key: 'world-world-b' })
    await seen.clock.settle()
    if (stop === 'clear') {
      await $.session.end({ reason: 'clear', sessionId: 'native-session', resume: { id: 'native-session' } } as never)
    } else {
      await ui.press({ key: 'close' })
    }
    seen.stateHold = null
    open()
    await seen.clock.settle()
    await seen.clock.advance(60000)
    await ui.unmount()
    expect(seen.requests).toHaveLength(before)
    expect(seen.forbidden).toEqual([])
  })
}

test('a state read refused with a huge reason renders one bounded, printable error line', async ($, on) => {
  const seen = engine(on)
  const reason = `${'\u0007x'.repeat(60000)}tail-marker`
  on('state.get', { plugin: 'self-improvement-loop', key: 'console' }, () => ({ deny: reason }) as never)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const line = await ui.find({ type: 'Text', text: /could not be read/ })
  expect(line?.text).toContain('(shortened)')
  expect(line?.text).not.toContain('tail-marker')
  expect(line?.text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
  expect((line?.text ?? '').length).toBeLessThan(500)
  await ui.unmount()
  expect(seen.forbidden).toEqual([])
})

test('a press on the pane after /clear starts the console again at once', async ($, on) => {
  const seen = engine(on)
  await start($)
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 'native-session', resume: { id: 'native-session' } } as never)
  await seen.clock.advance(60000)
  const before = seen.requests.length
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await seen.clock.settle()
  expect(seen.requests.length).toBe(before + 1)
  await seen.clock.advance(10000)
  expect(seen.requests.length).toBe(before + 2)
  await ui.unmount()
})

test('session.start again with the pane up (a reload) keeps the world and drops the old read', async ($, on) => {
  const seen = engine(on)
  await start($)
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'world-world-b' })
  await seen.clock.settle()
  await ui.unmount()
  expect(seen.state?.world).toBe('world-b')

  seen.hold = true
  await seen.clock.advance(10000)
  expect(seen.held).toHaveLength(1)
  const generation = seen.state!.generation

  await start($)
  await seen.clock.settle()
  const after = seen.state
  expect(after?.world).toBe('world-b')
  expect(after!.generation).toBeGreaterThan(generation)

  // The read from before is answered with data that must not land.
  const old = seen.held.shift()!
  old.release({
    ...envelope(old.request),
    stdout: `${JSON.stringify({
      version: 1,
      requestId: old.request.requestId,
      results: { ...answerReads(old.request), review: { ok: true, value: reviewPage('world-b', ['stale-before-reload']) } },
    })}\n`,
  })
  await seen.clock.settle()
  expect(JSON.stringify(seen.state?.results)).not.toContain('stale-before-reload')
  seen.hold = false
  for (const h of seen.held.splice(0)) h.release()
  await seen.clock.settle()
  expect(seen.forbidden).toEqual([])
})

test('a tick queued behind a held read launches nothing after /clear', async ($, on) => {
  const seen = engine(on)
  await start($)
  seen.hold = true
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  expect(seen.held).toHaveLength(1)
  await seen.clock.advance(10000)
  await seen.clock.advance(10000)
  await $.session.end({ reason: 'clear', sessionId: 'native-session', resume: { id: 'native-session' } } as never)
  await release(seen)
  await seen.clock.advance(60000)
  expect(seen.requests).toHaveLength(1)
  expect(seen.state?.loading).toBe(false)
})

test('reopening before an old reply returns drops it and reads once for the new lifecycle', async ($, on) => {
  const seen = engine(on)
  await start($)
  seen.hold = true
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  await $.session.end({ reason: 'clear', sessionId: 'native-session', resume: { id: 'native-session' } } as never)
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  expect(seen.requests).toHaveLength(1)
  const old = seen.held.shift()!
  old.release({
    ...envelope(old.request),
    stdout: `${JSON.stringify({
      version: 1,
      requestId: old.request.requestId,
      results: { ...answerReads(old.request), bootstrap: { ok: true, value: { ...BOOT, selectedWorld: 'world-b' } } },
    })}\n`,
  })
  await seen.clock.settle()
  expect(seen.state?.world).toBeNull()
  expect(seen.requests).toHaveLength(2)
  seen.hold = false
  await release(seen)
  expect(seen.state?.world).toBe('world-a')
})

test('the Close button stops the console at once, not a tick later', async ($, on) => {
  const seen = engine(on)
  await start($)
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  const generation = seen.state!.generation
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'close' })
  await ui.unmount()
  await seen.clock.settle()
  expect(seen.panes).toEqual([])
  // Invalidated by the close itself: no tick has run since.
  expect(seen.state!.generation).toBe(generation + 1)
  expect(seen.state!.loading).toBe(false)
})

// The Close button's own path. The kit cannot raise a person's close above
// the plugin, so the ui.close hook's refusal handling is covered in
// test/ui-state.test.ts through the fake engine.
for (const mode of ['deny', 'throw'] as const) {
  test(`a Close press the engine beneath refuses (${mode}) leaves the pane refreshing`, async ($, on) => {
    const seen = engine(on, { close: mode })
    await start($)
    await $.command.run({ command: 'sil', ...TYPED })
    await seen.clock.settle()
    const before = seen.requests.length
    const generation = seen.state!.generation

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'close' })
    await ui.unmount()
    await seen.clock.settle()
    expect(seen.panes).toHaveLength(1)
    expect(seen.state!.generation).toBe(generation)
    // The refusal reached the Close button's own handler, which logs it.
    expect(seen.logs.join('\n')).toContain('could not close')

    await seen.clock.advance(10000)
    expect(seen.requests.length).toBe(before + 1)
  })
}

test('a refused session.cwd is shown as a failure, ends loading and starts no process', async ($, on) => {
  const seen = engine(on, { cwd: 'deny' })
  await start($)
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  expect(seen.requests).toEqual([])
  expect(seen.state).toMatchObject({ loading: false })
  expect(seen.state?.error).toContain('could not read the loop')
  expect(JSON.stringify(seen.state)).not.toContain('/private/native/path')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /could not read the loop/ })).toBeDefined()
  await ui.unmount()
  expect(seen.forbidden).toEqual([])
})

test('open but not placed: the timer ticks with no read until shown, and a close stops it', async ($, on) => {
  const seen = engine(on, { open: 'unplaced' })
  await start($)
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  await seen.clock.advance(30000)
  expect(seen.requests).toEqual([])
  seen.panes[0]!.isPlaced = true
  seen.panes[0]!.isShown = true
  await seen.clock.advance(10000)
  expect(seen.requests.length).toBeGreaterThan(0)
  const reads = seen.requests.length
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'close' })
  await ui.unmount()
  await seen.clock.advance(60000)
  expect(seen.requests).toHaveLength(reads)
})

test('session start with no pane open reads nothing, even as time passes', async ($, on) => {
  const seen = engine(on)
  await start($)
  await seen.clock.advance(60000)
  expect(seen.requests).toEqual([])
  expect(seen.state).toBeUndefined()
  expect(seen.forbidden).toEqual([])
})

test('a refused /sil registration is logged, and the session still starts', async ($, on) => {
  const seen = engine(on, { register: 'deny' })

  const result = await start($)
  expect(result).toEqual({ cwd: '/' })
  expect(seen.registered).toEqual(['sil'])
  expect(seen.logs).toHaveLength(1)
  expect(seen.logs[0]).toContain('/sil is unavailable')
  expect(seen.logs[0]).toContain(DENIED)
  expect(seen.forbidden).toEqual([])
})

test('a refused pane open is reported as a failure, never as success', async ($, on) => {
  const seen = engine(on, { open: 'deny' })

  await start($)
  const ran = await $.command.run({ command: 'sil', ...TYPED })
  expect(seen.opened).toEqual(['sil-console'])
  expect(ran.text).toContain('Could not open the self-improvement loop console')
  expect(ran.text).toContain(DENIED)
  expect(ran.text).not.toContain('Opened the')
  expect(seen.coreCommands).not.toContain('sil')
  expect(seen.forbidden).toEqual([])
})

test('a pane that cannot be shown yet says so', async ($, on) => {
  const seen = engine(on, { open: 'unplaced' })

  await start($)
  const ran = await $.command.run({ command: 'sil', ...TYPED })
  expect(ran.text).toContain('cannot show it yet')
  expect(ran.text).toContain('no-surface in the native test')
  expect(ran.text).not.toContain('Opened the')
  expect(seen.forbidden).toEqual([])
})

test('an unrelated command continues down the chain', async ($, on) => {
  const seen = engine(on)

  await start($)
  const ran = await $.command.run({ command: 'compact', ...TYPED })

  expect(seen.coreCommands).toEqual(['compact'])
  expect(ran.text).toBe('core ran compact')
  expect(seen.forbidden).toEqual([])
})

test('Activity sub-tabs: the Lessons view is drawn under Lessons only, and a tab press reads nothing', async ($, on) => {
  const seen = engine(on)
  await start($)
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'section-activity' })
  await seen.clock.settle()
  expect(seen.state?.activityTab).toBe('queue')
  expect(await ui.find({ key: 'activity-tab-queue' })).toBeDefined()
  expect(await ui.find({ key: 'lesson-capture' })).toBeUndefined()
  const before = seen.requests.length
  await ui.press({ key: 'activity-tab-lessons' })
  await seen.clock.settle()
  expect(seen.state?.activityTab).toBe('lessons')
  expect((await ui.find({ key: 'lesson-capture' }))?.props.label).toBe('Capture selection')
  expect(await ui.find({ type: 'Text', text: 'Curated lessons' })).toBeDefined()
  await ui.press({ key: 'activity-tab-log' })
  await seen.clock.settle()
  expect(seen.state?.activityTab).toBe('log')
  expect(await ui.find({ key: 'lesson-capture' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Worker log \(global\)/ })).toBeDefined()
  expect(seen.requests.length).toBe(before)
  await ui.unmount()
  expect(seen.forbidden).toEqual([])
})

test('an Actions button queues its plugin command through $.command.run and reads nothing', async ($, on) => {
  const seen = engine(on)
  await start($)
  await $.command.run({ command: 'sil', ...TYPED })
  await seen.clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const before = seen.requests.length
  expect((await ui.find({ key: 'action-reflect' }))?.props.label).toBe('Reflect on this session')
  await ui.press({ key: 'action-reflect' })
  await seen.clock.settle()
  // The engine beneath ran the plugin's own command once, as if typed.
  expect(seen.coreCommands).toEqual(['self-improvement-loop:reflect'])
  expect(seen.state?.commandNote).toMatchObject({ command: 'self-improvement-loop:reflect', args: '', target: null, error: null })
  expect(seen.state?.commandNote?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.1$/)
  expect((await ui.find({ type: 'Text', text: /Queued \/self-improvement-loop:reflect\. It runs in the chat once Claude is idle\./ }))).toBeDefined()
  expect(seen.logs).toEqual([])
  expect(seen.requests.length).toBe(before)
  await ui.unmount()
  expect(seen.forbidden).toEqual([])
})
