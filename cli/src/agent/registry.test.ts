// Ported from the hardened standalone slice (registry subset of tests/core.test.mjs) —
// ZK-003, ZAI 2026-09-17. Backend resolution, capability guard, receiver preservation.
import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
import {
  OpenCodeBackend,
  isZcodeSessionId,
  requireCommand,
  resolveBackend,
  type SidecarLookup,
} from './registry.js'

describe('resolveBackend', () => {
  const lookup: SidecarLookup = async (sessionId) =>
    sessionId === 'zc:session-1' ? { backend: 'zcode' } : sessionId === 'ses_native' ? { backend: 'zcode' } : sessionId === 'ses_old' ? undefined : sessionId.startsWith('zc:') ? undefined : { backend: 'opencode' }

  test('backend identity fallback only for old IDs; missing zc fails', async () => {
    assert.equal(await resolveBackend(lookup, 'ses_old'), 'opencode')
    assert.equal(await resolveBackend(lookup, 'ses_native'), 'zcode')
    assert.equal(await resolveBackend(lookup, 'zc:session-1'), 'zcode')
    await assert.rejects(() => resolveBackend(lookup, 'zc:missing'), {
      code: 'SESSION_SIDECAR_MISSING',
    })
  })

  test('reserved prefix detection', () => {
    assert.equal(isZcodeSessionId('zc:x'), true)
    assert.equal(isZcodeSessionId('ses_x'), false)
  })
})

describe('requireCommand', () => {
  test('unknown/native command cannot fall through to OpenCode', () => {
    for (const cmd of ['undo', 'redo', 'share', 'agent', 'login', 'mcp', 'foo-agent', 'new-worktree'])
      assert.throws(() => requireCommand('zcode', cmd, () => true), {
        code: 'CAPABILITY_UNSUPPORTED',
      })
    // OpenCode keeps its full legacy surface regardless of the capability probe.
    requireCommand('opencode', 'anything', () => false)
  })

  test('native commands require the profile capability', () => {
    requireCommand('zcode', 'compact', () => true)
    assert.throws(() => requireCommand('zcode', 'compact', () => false), {
      code: 'CAPABILITY_UNSUPPORTED',
    })
  })
})

describe('OpenCodeBackend forwarding wrapper', () => {
  test('preserves service receiver, args and result', () => {
    const calls: { self: unknown; args: unknown[] }[] = []
    const service = {
      n: 7,
      submit(...args: unknown[]) {
        calls.push({ self: this, args })
        return 42
      },
    }
    const backend = new OpenCodeBackend(service)
    assert.equal(backend.call('submit', 'a', { b: 2 }), 42)
    assert.equal(calls[0]?.self, service)
    assert.deepEqual(calls[0]?.args, ['a', { b: 2 }])
  })

  test('missing service method fails closed', () => {
    const backend = new OpenCodeBackend<{ nope: () => void }>({} as { nope: () => void })
    assert.throws(() => backend.call('nope'), { code: 'CAPABILITY_UNSUPPORTED' })
  })
})
