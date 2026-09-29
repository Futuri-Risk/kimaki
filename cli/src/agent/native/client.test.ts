// Ported from the hardened standalone slice (tests/client.test.mjs) — ZK-002, ZAI 2026-09-17.
// NativeClient transport regressions: correlation, deadlines, reverse RPC, limits, close paths.
import { describe, onTestFinished, test } from 'vitest'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeClient } from './client.js'

async function until(fn: () => unknown, message = 'condition', timeout = 6000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const r = await fn()
    if (r) return r
    await delay(10)
  }
  throw Error('Timed out: ' + message)
}

function client(overrides: Record<string, unknown> = {}) {
  const writes: unknown[] = []
  const output = new PassThrough()
  const input = new Writable({
    write(data, _enc, done) {
      writes.push(JSON.parse(data.toString()))
      done()
    },
  })
  const options = {
    input,
    output,
    timeoutMs: 50,
    onNotification: () => {},
    onRequest: async () => ({ ok: true as const, value: { decision: 'deny' } }),
    onDisconnect: () => {},
    ...overrides,
  }
  const c = new NativeClient(options as ConstructorParameters<typeof NativeClient>[0])
  onTestFinished(() => c.dispose())
  return { c, writes, output, input: options.input as Writable }
}

function emit(output: PassThrough, value: unknown) {
  output.write(JSON.stringify(value) + '\n')
}

describe('NativeClient', () => {
  test('pending registration precedes immediate response on native pipe', async () => {
    const output = new PassThrough()
    const input = new Writable({
      write(bytes, _encoding, done) {
        const r = JSON.parse(bytes.toString())
        emit(output, { id: r.id, result: 'immediate' })
        done()
      },
    })
    const { c } = client({ input, output })
    assert.deepEqual(await c.request('read', {}), { ok: true, value: 'immediate' })
    assert.equal(c.pendingCount, 0)
  })

  test('timeout settles pending once and late native reply cannot revive it', async () => {
    const { c, output, writes } = client()
    const r = await c.request('read', {})
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.error.code, 'RPC_TIMEOUT')
    assert.equal(c.pendingCount, 0)
    emit(output, { id: (writes[0] as { id: number }).id, result: 'late' })
    assert.equal(c.pendingCount, 0)
  })

  test('abort before write does not put a request onto native stdin', async () => {
    const { c, writes } = client()
    const signal = AbortSignal.abort()
    assert.equal((await c.request('send', {}, { signal })).ok, false)
    assert.equal(writes.length, 0)
  })

  test('reverse request sharing outgoing numeric ID does not consume its response', async () => {
    let reverse: { id: number; method: string } | undefined
    const { c, output, writes } = client({
      onRequest: async (id: number, method: string) => {
        reverse = { id, method }
        return { ok: true as const, value: { allowed: false } }
      },
    })
    const promise = c.request('session/read', {})
    emit(output, { id: 1, method: 'interaction/requestPermission', params: {} })
    await until(() => writes.length === 2, 'reverse reply')
    assert.equal(c.pendingCount, 1)
    assert.equal(reverse?.id, 1)
    emit(output, { id: 1, result: 'outgoing response' })
    const settled = await promise
    assert.ok(settled.ok)
    assert.equal(settled.value, 'outgoing response')
  })

  test('reverse interaction does not block notifications or unrelated response processing', async () => {
    let resolve: (v: { ok: true; value: unknown }) => void
    let notifications = 0
    const gate = new Promise<{ ok: true; value: unknown }>((r) => (resolve = r))
    const { c, output } = client({
      timeoutMs: 1000,
      onRequest: () => gate,
      onNotification: () => notifications++,
    })
    emit(output, { id: 0, method: 'question', params: {} })
    const promise = c.request('read', {})
    emit(output, { method: 'progress', params: {} })
    emit(output, { id: 1, result: 42 })
    const settled = await promise
    assert.ok(settled.ok)
    assert.equal(settled.value, 42)
    assert.equal(notifications, 1)
    resolve!({ ok: true, value: {} })
  })

  test('serialized backpressure skips queued requests whose admission has expired', async () => {
    const writes: unknown[] = []
    const callbacks: (() => void)[] = []
    const input = new Writable({
      highWaterMark: 1,
      write(bytes, _encoding, done) {
        writes.push(JSON.parse(bytes.toString()))
        callbacks.push(done)
      },
    })
    const { c, output } = client({ input, timeoutMs: 1000 })
    const a = c.request('first', {})
    const b = c.request('expired', {}, { timeoutMs: 20 })
    assert.equal((await b).ok, false)
    assert.equal(writes.length, 1)
    callbacks.shift()!()
    emit(output, { id: 1, result: true })
    assert.equal((await a).ok, true)
    await delay(10)
    assert.equal(writes.length, 1)
  })

  test('reverse reply is confirmed only after its serialized write callback', async () => {
    let writeCallback: (() => void) | undefined
    let confirmed = false
    const input = new Writable({
      write(_bytes, _encoding, done) {
        writeCallback = done
      },
    })
    const { output } = client({ input, onResponseWritten: () => (confirmed = true) })
    emit(output, { id: 0, method: 'permission', params: {} })
    await until(() => writeCallback, 'queued reverse reply')
    assert.equal(confirmed, false)
    writeCallback!()
    await until(() => confirmed, 'confirmed reverse write')
  })

  test('malformed frame closes the connection and rejects all pending requests', async () => {
    const { c, output } = client()
    const a = c.request('a', {})
    const b = c.request('b', {})
    output.write('bad json\n')
    assert.equal(((await a) as { error: { code: string } }).error.code, 'FRAME_INVALID')
    assert.equal(((await b) as { error: { code: string } }).error.code, 'FRAME_INVALID')
    assert.equal(c.pendingCount, 0)
    assert.equal(c.isClosed, true)
  })

  test('outgoing limits reject oversize and excessive pending requests', async () => {
    const { c, writes } = client({ maxPending: 1, maxFrameBytes: 120, timeoutMs: 1000 })
    assert.equal(
      ((await c.request('large', { text: 'x'.repeat(200) })) as { error: { code: string } }).error
        .code,
      'FRAME_TOO_LARGE',
    )
    assert.equal(writes.length, 0)
    const first = c.request('one', {})
    assert.equal(
      ((await c.request('two', {})) as { error: { code: string } }).error.code,
      'RPC_LIMIT',
    )
    c.dispose()
    assert.equal((await first).ok, false)
  })

  test('EOF with incomplete frame fails pending request rather than inventing assistant output', async () => {
    const { c, output } = client()
    const p = c.request('read', {})
    output.end('{')
    assert.equal(((await p) as { error: { code: string } }).error.code, 'FRAME_INVALID')
  })

  test('a blocked reverse reply has a write deadline and reports uncertain delivery', async () => {
    let receipt: { ok: boolean; error?: { code: string } } | undefined
    const input = new Writable({
      write(_bytes, _encoding, _done) {},
    })
    const { c, output } = client({
      input,
      timeoutMs: 40,
      onResponseWritten: (_id: number, result: { ok: boolean; error?: { code: string } }) =>
        (receipt = result),
    })
    emit(output, { id: 0, method: 'permission', params: {} })
    await until(() => receipt, 'write timeout receipt')
    assert.equal(receipt!.ok, false)
    assert.equal(receipt!.error?.code, 'WRITE_TIMEOUT')
    assert.equal(c.isClosed, true)
  })

  // H43 — throwing disconnect observer cannot interrupt client cleanup
  test('H43 a throwing disconnect observer cannot interrupt client cleanup', async () => {
    const output = new PassThrough()
    const input = new PassThrough()
    const c = new NativeClient({
      input,
      output,
      onNotification: () => {},
      onRequest: async () => ({ ok: true as const, value: null }),
      onDisconnect: () => {
        throw Error('private observer error')
      },
    })
    const pending = c.request('read', {})
    assert.doesNotThrow(() => c.dispose())
    assert.equal((await pending).ok, false)
    assert.equal(c.isClosed, true)
    assert.equal(input.destroyed, true)
    assert.equal(output.destroyed, true)
  })

  // H45 — invalid constructor limits rejected before installing handlers
  test('H45 client limits reject non-finite and invalid values before installing handlers', () => {
    for (const key of ['maxPending', 'maxReverse', 'maxWriteBytes', 'maxWriteCount', 'timeoutMs'])
      for (const value of [0, -1, NaN, Infinity, 1.5]) {
        const output = new PassThrough()
        const input = new PassThrough()
        let c: NativeClient | undefined
        try {
          assert.throws(
            () => {
              c = new NativeClient({
                input,
                output,
                [key]: value,
                onNotification: () => {},
                onRequest: async () => ({ ok: true as const, value: null }),
                onDisconnect: () => {},
              } as ConstructorParameters<typeof NativeClient>[0])
            },
            { code: 'CONFIG_INVALID' },
          )
          assert.equal(output.listenerCount('data'), 0)
        } finally {
          c?.dispose()
        }
      }
  })

  // H46 — invalid per-request deadline rejected before any native bytes are sent
  test('H46 invalid per-request deadline is rejected before native bytes are sent', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let bytes = 0
    input.on('data', (b) => (bytes += b.length))
    const c = new NativeClient({
      input,
      output,
      onNotification: () => {},
      onRequest: async () => ({ ok: true as const, value: null }),
      onDisconnect: () => {},
    })
    try {
      for (const timeoutMs of [0, -1, NaN, Infinity, 2147483648]) {
        const r = await c.request('effect', {}, { timeoutMs })
        assert.equal(r.ok, false)
        assert.equal(!r.ok && r.error.code, 'CONFIG_INVALID')
      }
      assert.equal(bytes, 0)
      assert.equal(c.pendingCount, 0)
    } finally {
      c.dispose()
    }
  })
})
