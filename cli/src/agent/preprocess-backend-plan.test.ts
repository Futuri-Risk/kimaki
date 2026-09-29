// ZK-005 slice: preprocessing backend plan — the routing decision that keeps zc:
// sessions away from OpenCode enrichment and voice side-session creation. ZAI 2026-09-17.
import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
import { resolvePreprocessBackendPlan } from '../message-preprocessing.js'

describe('resolvePreprocessBackendPlan', () => {
  test('legacy and absent sessions stay on the OpenCode plan', () => {
    assert.deepEqual(resolvePreprocessBackendPlan(null), {
      backend: 'opencode',
      hydrateOpencodeContext: true,
      allowVoiceSideSessions: true,
    })
    assert.deepEqual(resolvePreprocessBackendPlan('ses_old'), {
      backend: 'opencode',
      hydrateOpencodeContext: true,
      allowVoiceSideSessions: true,
    })
  })

  test('native zc: sessions never hydrate OpenCode context or route voice side sessions', () => {
    assert.deepEqual(resolvePreprocessBackendPlan('zc:session-1'), {
      backend: 'zcode',
      hydrateOpencodeContext: false,
      allowVoiceSideSessions: false,
    })
  })
})
