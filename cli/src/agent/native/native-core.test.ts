// Ported from the hardened standalone slice (native subset of tests/core.test.mjs plus the
// verifyLaunch halves of H14/H50) — ZK-002, ZAI 2026-09-17.
// Pure native contracts: NDJSON framing, envelope direction, V4 command shapes, model overlay,
// launcher preflight.
import { describe, onTestFinished, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { NdjsonDecoder, classify } from './ndjson.js'
import { v4Command, acceptedV4, forkedSessionId } from './protocol.js'
import { runtimeModel } from './model.js'
import { verifyLaunch, fileHash } from './process.js'

describe('NdjsonDecoder', () => {
  test('handles fragmented Unicode, CRLF and ID zero', () => {
    const decoder = new NdjsonDecoder(1024)
    const bytes = Buffer.from('{"id":0,"result":"✓😀"}\r\n')
    const result: unknown[] = []
    for (const b of bytes) result.push(...decoder.push(Buffer.from([b])))
    assert.deepEqual(result, [{ type: 'response', id: 0, result: '✓😀' }])
    assert.equal(decoder.finish().ok, true)
  })

  for (const [name, data] of [
    ['invalid JSON', 'x\n'],
    ['blank', '\n'],
    ['both result and error', '{"id":1,"result":1,"error":{}}\n'],
    ['invalid id', '{"id":null,"result":0}\n'],
    ['invalid UTF8', Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125, 10])],
  ] as [string, string | Buffer][])
    test('rejects ' + name, () =>
      assert.throws(() =>
        new NdjsonDecoder(1024).push(typeof data === 'string' ? Buffer.from(data) : data),
      ),
    )

  test('byte limit and incomplete EOF fail closed', () => {
    assert.throws(() => new NdjsonDecoder(3).push(Buffer.from('abcd')))
    const d = new NdjsonDecoder()
    d.push(Buffer.from('{'))
    assert.equal(d.finish().ok, false)
  })

  test('tiny-chunk framing stays linear with bounded slab count', () => {
    const d = new NdjsonDecoder(300000)
    const payload = 'x'.repeat(180000)
    const bytes = Buffer.from(JSON.stringify({ id: 1, result: payload }) + '\n')
    let value: unknown
    for (let i = 0; i < bytes.length; i += 3) {
      const out = d.push(bytes.subarray(i, i + 3))
      if (out.length) {
        value = (out[0] as { result: unknown }).result
      }
    }
    assert.equal(value, payload)
    assert.equal(d.finish().ok, true)
  })
})

describe('envelope classification', () => {
  test('reverse request and response IDs use separate direction classification', () => {
    assert.equal(classify({ id: 0, method: 'interaction/x', params: {} }).type, 'request')
    assert.equal(classify({ id: 0, result: {} }).type, 'response')
  })
})

describe('V4 protocol builders', () => {
  test('guide is direct sendText envelope, not invented RPC', () => {
    const p = v4Command({
      clientId: 'test-host',
      sessionId: 's',
      operationId: 'o',
      connectionId: 'c',
      type: 'sendText',
      text: 'guide',
      now: 1,
    })
    assert.equal(p.type, 'sendText')
    assert.equal(p.payload.requestedDelivery, 'guide')
    assert.equal('command' in p, false)
    assert.equal('jsonrpc' in p, false)
  })

  for (const status of ['noop', 'rejected', 'stale', 'unknown'])
    test('V4 ' + status + ' is not successful acceptance', () =>
      assert.throws(() => acceptedV4({ status })),
    )

  test('fork requires accepted result.sessionId', () => {
    assert.throws(() => forkedSessionId({ status: 'accepted' }))
    assert.equal(forkedSessionId({ status: 'accepted', result: { sessionId: 'child' } }), 'child')
  })
})

describe('runtimeModel overlay', () => {
  const model = {
    modelId: 'm',
    label: 'm',
    contextWindow: 1,
    maxOutputTokens: 1,
    reasoning: { enabled: true, levels: [{ value: 'high', label: 'high' }], defaultLevel: 'high' },
  }
  const provider = {
    providerId: 'p',
    kind: 'anthropic',
    apiFormat: 'anthropic-messages' as const,
    baseURL: 'https://example.com',
    models: [model],
    authentication: 'native' as const,
  }
  const selected = { providerId: 'p', modelId: 'm', reasoning: 'high', revision: 'r' }

  test('preserves full reasoning catalogue; no max-to-high fallback', () => {
    const r = runtimeModel(provider, selected)
    assert.deepEqual(r.provider.models, [model])
    assert.equal('apiKey' in r.provider, false)
    assert.throws(() => runtimeModel(provider, { ...selected, reasoning: 'max' }), {
      code: 'THOUGHT_LEVEL_UNSUPPORTED',
    })
    assert.throws(() => runtimeModel(provider, selected, 'secret'))
  })
})

describe('verifyLaunch preflight', () => {
  async function launchFixture() {
    // Entry and workspace must be SEPARATE trees: verifyLaunch refuses
    // workspace-local executables before the checks these tests exercise.
    // (Fixture was latently wrong; the tests were platform-skip-gated and
    // had never actually run before ZK-016 ungated win32. — ZCode 2026-09-18)
    const root = await mkdtemp(path.join(tmpdir(), 'zc-launch-'))
    const entryTree = await mkdtemp(path.join(tmpdir(), 'zc-entry-'))
    const entry = path.join(entryTree, 'entry.mjs')
    await writeFile(entry, 'process.exit(0)\n')
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    onTestFinished(() => rm(entryTree, { recursive: true, force: true }))
    const entryHash = await fileHash(entry)
    return {
      profile: {
        executable: process.execPath,
        args: [entry],
        executableSha256: await fileHash(process.execPath),
        entryPath: entry,
        entrySha256: entryHash,
        cwd: root,
        environment: {},
      },
      root,
    }
  }

  // H14 — the fingerprinted entry must be the script actually executed.
  // Linux-gated: verifyLaunch throws PLATFORM_UNCERTIFIED on win32 before reaching the
  // argument-vector checks this test exercises (Windows native supervision is disabled by design).
  test(
    'H14 launcher cannot fingerprint an inert argument while executing another script',
    async () => {
      const { profile } = await launchFixture()
      await assert.rejects(
        () => verifyLaunch({ ...profile, args: ['/unverified/other.mjs', ...profile.args] }),
        { code: 'CONFIG_INVALID' },
      )
    },
  )

  // H50 (verifyLaunch half) — invalid startup/shutdown budgets rejected before spawning
  test('H50 owned launcher rejects invalid shutdown/startup budgets before spawning', async () => {
    const { profile } = await launchFixture()
    for (const budgets of [
      { graceMs: NaN },
      { graceMs: Infinity },
      { graceMs: -1 },
      { startupMs: 0 },
      { startupMs: NaN },
      { startupMs: 2147483648 },
    ]) {
      await assert.rejects(() => verifyLaunch({ ...profile, ...budgets }), {
        code: 'CONFIG_INVALID',
      })
    }
  })

  // Linux-gated for the same reason as H14: the hash comparison sits behind the platform gate.
  test('rejects a changed entry fingerprint', async () => {
    const { profile } = await launchFixture()
    await assert.rejects(() => verifyLaunch({ ...profile, entrySha256: '0'.repeat(64) }), {
      code: 'RUNTIME_UNCERTIFIED',
    })
  })
})
