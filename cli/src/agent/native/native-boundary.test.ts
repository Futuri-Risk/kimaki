// Ported from the hardened standalone slice (H30/H31/H32/H44, adapted to the host layout) —
// ZK-002, ZAI 2026-09-17.
// Guards the host-independence of the shared native core and its diagnostic redaction.
import { describe, onTestFinished, test } from 'vitest'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { v4Command } from './protocol.js'
import { DiagnosticBuffer } from './diagnostics.js'
import { NativeClient } from './client.js'

const nativeDir = path.dirname(fileURLToPath(import.meta.url))

// H30 — native modules must not import host types, host errors or anything outside native/
test('H30 shared native modules do not import host modules', async () => {
  const files = (await readdir(nativeDir)).filter(
    (f) => f.endsWith('.ts') && f.endsWith('.test.ts') === false,
  )
  assert.ok(files.length >= 9, 'expected the native module set to be present')
  for (const file of files) {
    const source = await readFile(path.join(nativeDir, file), 'utf8')
    assert.doesNotMatch(
      source,
      /from\s+['"]\.\.\/(types|errors|store|coordinator|zcode-backend|zcode-projector|renderer|attachments|registry)\.js['"]/u,
      `${file} imports a host-shaped module`,
    )
    assert.doesNotMatch(source, /from\s+['"]\.\./u, `${file} imports above the native directory`)
    assert.doesNotMatch(
      source,
      /from\s+['"](discord\.js|drizzle-orm|@libsql|@opencode-ai|schema\.js|db\.js|config\.js)/u,
      `${file} imports a host dependency`,
    )
  }
})

test('supervisor executable sibling exists for source-mode launches', async () => {
  await readFile(path.join(nativeDir, 'supervisor.js'))
})

// H31 — caller-supplied client identity
test('H31 a shared V4 builder uses the caller client identity', () => {
  const p = v4Command({
    clientId: 'other-host',
    sessionId: 's',
    operationId: 'o',
    connectionId: 'c',
    type: 'stop',
  })
  assert.equal(p.clientId, 'other-host')
})

// H32 — bounded, redacted, complete-line diagnostics ring
test('H32 diagnostics redact whole lines, drop partial/oversized lines and remain bounded', () => {
  const buffer = new DiagnosticBuffer((s) => s.replaceAll('credential-value', '[REDACTED]'), {
    maxLineBytes: 48,
    maxBytes: 96,
    maxLines: 3,
  })
  buffer.push(Buffer.from('error cred'))
  buffer.push(Buffer.from('ential-value\n'))
  assert.deepEqual(buffer.lines(), ['error [REDACTED]'])
  buffer.push(Buffer.from('never publish this partial cred'))
  assert.equal(buffer.lines().length, 1)
  buffer.push(Buffer.from('x'.repeat(200) + 'credential-value\n'))
  assert.deepEqual(buffer.lines(), ['error [REDACTED]'])
  for (let i = 0; i < 10000; i++) buffer.push(Buffer.from('line ' + i + '\n'))
  assert.ok(buffer.lines().length <= 3)
  assert.ok(Buffer.byteLength(buffer.lines().join('\n')) <= 96)
  assert.ok(!buffer.lines().join('\n').includes('credential-value'))
  const disabled = new DiagnosticBuffer()
  disabled.push(Buffer.from('secret\n'))
  assert.deepEqual(disabled.lines(), [])
})

// H44 — a throwing reply-receipt observer is contained instead of an unhandled rejection.
// Adapted in-process from the standalone child-process proof: vitest fails the run on an
// unhandled rejection, so containment is proven by the client still closing cleanly here.
describe('H44 reply-receipt observer containment', () => {
  test('a throwing reply-receipt observer cannot break the client', async () => {
    const output = new PassThrough()
    const input = new PassThrough()
    let disconnected = false
    const c = new NativeClient({
      input,
      output,
      onNotification: () => {},
      onRequest: async () => ({ ok: true as const, value: null }),
      onResponseWritten: () => {
        throw Error('private callback content')
      },
      onDisconnect: () => {
        disconnected = true
      },
    })
    onTestFinished(() => c.dispose())
    output.write(JSON.stringify({ id: 0, method: 'question', params: {} }) + '\n')
    await delay(100)
    const closed = c.isClosed
    c.dispose()
    assert.ok(closed && disconnected, 'client must close cleanly despite a throwing observer')
  })
})
