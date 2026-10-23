// Native engine test for the console's control transport. It runs under
// `claude plugin test` against the throwaway probe plugin scripts/test-native.ts
// builds from ./probe.ts, which calls the real readControl. Each test answers
// the probe's process.run from beneath, so the engine itself carries the
// request, the result and every refusal.
//
// The probe plugin's root is laid out with spaces and quotes in its path.

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const TYPED = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const INERT_ENV = {
  HOME: '/nonexistent/sil-native-test/home',
  SIL_STATE_DIR: '/nonexistent/sil-native-test/state',
  SIL_DATA_DIR: '/nonexistent/sil-native-test/data',
  SIL_CONFIG_DIR: '/nonexistent/sil-native-test/config',
}

const SECRET = 'sk-native-secret-0123456789'
const DENIED = `denied by the native test ${SECRET}`

const REQUEST = {
  version: 1,
  requestId: 'native-req',
  reads: [
    { id: 'status', op: 'worker.status', args: {} },
    { id: 'log', op: 'logs.tail', args: { name: 'worker', lines: 5 } },
  ],
}

function envelope(results: Record<string, unknown>, requestId = REQUEST.requestId): string {
  return `${JSON.stringify({ version: 1, requestId, results })}\n`
}

const NOTE = 'zażółć gęślą jaźń 🦀'
const GOOD = envelope({
  status: { ok: true, value: { pending: 2, note: NOTE } },
  log: { ok: false, error: { code: 'not_found', message: 'no worker log yet', retryable: false } },
})

type Run = { argv: readonly string[]; init?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number } }
type Answer =
  | { deny: string }
  | { exitCode: number; stdout: string; stderr?: string; isStdoutTruncated?: boolean; isStderrTruncated?: boolean }

function bridge(on: On, answer: Answer) {
  mock.env(on, INERT_ENV)
  const runs: Run[] = []
  on('process.run', (_, e) => {
    runs.push({ argv: [...e.argv], init: e.init })
    if ('deny' in answer) return { deny: answer.deny }
    return {
      value: {
        exitCode: answer.exitCode,
        stdout: answer.stdout,
        stderr: answer.stderr ?? '',
        isStdoutTruncated: answer.isStdoutTruncated ?? false,
        isStderrTruncated: answer.isStderrTruncated ?? false,
      },
    }
  })
  return runs
}

async function probe($: Engine, input: unknown): Promise<any> {
  const ran = await $.command.run({ command: 'sil-transport-probe', args: JSON.stringify(input), ...TYPED })
  return JSON.parse(ran.text ?? 'null')
}

test('readControl launches the loaded root by argv and decodes a whole response', async ($, on) => {
  const runs = bridge(on, { exitCode: 0, stdout: GOOD })
  const out = await probe($, { request: REQUEST })

  expect(runs).toHaveLength(1)
  const call = runs[0]!
  const script = call.argv[1]!
  const pluginRoot = script.slice(0, -'/scripts/sil'.length)
  expect(call.argv).toEqual(['/bin/sh', `${pluginRoot}/scripts/sil`, 'ops'])
  // The fixture root really holds the awkward characters, and they arrive as one argument.
  expect(pluginRoot).toContain(' ')
  expect(pluginRoot).toContain('"')
  expect(pluginRoot).toContain("'")
  expect(call.init?.env?.SIL_PLUGIN_ROOT).toBe(pluginRoot)
  expect(Object.keys(call.init?.env ?? {})).toEqual(['SIL_PLUGIN_ROOT'])
  expect(JSON.parse(call.init!.stdin!)).toEqual(REQUEST)
  expect(call.init?.timeoutMs).toBe(10000)

  expect(out.ok).toBe(true)
  expect(out.response.requestId).toBe('native-req')
  expect(out.response.results.status).toEqual({ ok: true, value: { pending: 2, note: NOTE } })
  expect(out.response.results.log).toEqual({
    ok: false,
    error: { code: 'not_found', message: 'no worker log yet', retryable: false },
  })
})

test('a request over the byte bound is refused before any process runs', async ($, on) => {
  const runs = bridge(on, { exitCode: 0, stdout: GOOD })
  // 70000 characters, 140000 UTF-8 bytes: over 131072 only when counted in bytes.
  const filler = 'ż'.repeat(70000)
  const out = await probe($, { request: { ...REQUEST, reads: [{ id: 'a', op: 'logs.tail', args: { filler } }] } })
  expect(out).toMatchObject({ ok: false, name: 'ControlTransportError', code: 'request_too_large' })
  expect(runs).toEqual([])
})

const FAILURES: Array<[string, Answer, string]> = [
  ['a refused process start', { deny: DENIED }, 'launch_failed'],
  ['a nonzero exit', { exitCode: 2, stdout: GOOD, stderr: `sil ops: invalid request ${SECRET}` }, 'exit_nonzero'],
  ['stdout truncated', { exitCode: 0, stdout: GOOD, isStdoutTruncated: true }, 'truncated'],
  ['stderr truncated', { exitCode: 0, stdout: GOOD, stderr: SECRET, isStderrTruncated: true }, 'truncated'],
  ['output cut before its newline', { exitCode: 0, stdout: GOOD.slice(0, -1) }, 'incomplete'],
  ['malformed JSON', { exitCode: 0, stdout: `{"version":1,${SECRET}\n` }, 'malformed_response'],
  ['a wrong request id', { exitCode: 0, stdout: envelope({ status: { ok: true, value: 1 }, log: { ok: true, value: 2 } }, 'other') }, 'request_mismatch'],
  ['a missing read', { exitCode: 0, stdout: envelope({ status: { ok: true, value: 1 } }) }, 'result_mismatch'],
]

for (const [name, answer, code] of FAILURES) {
  test(`${name} rejects visibly, without its payload`, async ($, on) => {
    const runs = bridge(on, answer)
    const out = await probe($, { request: REQUEST })
    expect(runs).toHaveLength(1)
    expect(out.ok).toBe(false)
    expect(out.name).toBe('ControlTransportError')
    expect(out.code).toBe(code)
    expect(out.message).not.toContain(SECRET)
    expect(out.message).not.toContain(NOTE)
  })
}

for (const bad of ['toJSON', 'bigint', 'cyclic'] as const) {
  test(`args that cannot be encoded (${bad}) are refused before any process runs`, async ($, on) => {
    const runs = bridge(on, { exitCode: 0, stdout: GOOD })
    const out = await probe($, { bad })
    expect(out).toEqual({
      ok: false,
      name: 'ControlTransportError',
      code: 'invalid_request',
      message: 'The control request is malformed and was not sent.',
      leaked: false,
    })
    expect(runs).toEqual([])
  })
}

test('runControlProcess hands back the envelope text, byte-exact', async ($, on) => {
  const runs = bridge(on, { exitCode: 0, stdout: GOOD })
  const raw = JSON.stringify(REQUEST)
  const out = await probe($, { raw })
  expect(runs[0]!.init?.stdin).toBe(raw)
  expect(out).toEqual({ ok: true, text: GOOD.slice(0, -1) })
})
