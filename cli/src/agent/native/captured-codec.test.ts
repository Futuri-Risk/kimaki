// ZK-016 codec regression fixtures — the captured divergences from the free-row
// certification (N01–N04, win32 + linux/WSL2), pinned as source tests:
//  1. identity comes from result.session.sessionId; projection.sessionId is the
//     cosmetic value "unknown" in every captured frame and must never become
//     session identity;
//  2. the real server sends a reverse session/requestRuntimePreferences after
//     create; the envelope (string server id "server-1", runtime-materialization
//     scope) is answered by the bridge from profile preferences.
// Fixture: fixtures/native-captured-zk16.json — generated from
// docs/zcode-integration/evidence/zk16-{win32,linux}/certify-capture.json.
// Changing a captured field there invalidates these assertions on purpose.
// — ZCode 2026-09-18
import { describe, onTestFinished, test } from 'vitest'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { capturedCodec } from './captured-codec.js'
import { createdSessionId } from './protocol.js'
import { NativeClient } from './client.js'

const fixtureUrl = new URL('../fixtures/native-captured-zk16.json', import.meta.url)
type Fixture = {
  sessionId: string
  sessionReadResult: Record<string, unknown>
  reverseRequestFrame: { id: string; method: string; params: Record<string, unknown> }
  v4SubscribeResult: { ack: Record<string, unknown> }
  authenticatedModelSettings: Record<string, unknown>
}
const fixture: Fixture = await readFile(fixtureUrl, 'utf8').then(JSON.parse)

describe('authenticated catalog (captured 2026-09-19 after zcode login)', () => {
  const authed = {
    ...fixture.sessionReadResult,
    settings: {
      ...(fixture.sessionReadResult as { settings: Record<string, unknown> }).settings,
      model: fixture.authenticatedModelSettings,
    },
  }

  test('snapshot parses the authenticated current model with derived revision', () => {
    const snap = capturedCodec.snapshot(authed, fixture.sessionId)
    assert.equal(snap.model.providerId, 'zai-api')
    assert.equal(snap.model.modelId, 'GLM-5.3')
    assert.equal(snap.model.reasoning, 'max')
    assert.equal(snap.model.revision, 'zai-api/GLM-5.3@max')
    assert.equal(snap.sessionId, fixture.sessionId)
    assert.equal(snap.foreground, null)
  })

  test('unauthenticated shape still refuses with MODEL_UNADVERTISED (both captures pinned)', () => {
    assert.throws(
      () => capturedCodec.snapshot(fixture.sessionReadResult, fixture.sessionId),
      (e: { code: string }) => e.code === 'MODEL_UNADVERTISED',
    )
  })
})

describe('captured divergence #2 — projection.sessionId is never identity', () => {
  test('createdSessionId reads result.session.sessionId from the captured create body', () => {
    assert.equal(createdSessionId(fixture.sessionReadResult), fixture.sessionId)
    assert.notEqual(
      (fixture.sessionReadResult as { projection: { sessionId: string } }).projection.sessionId,
      fixture.sessionId,
      'fixture sanity: the captured projection sessionId really is the divergent value',
    )
  })

  test('snapshot keeps real identity and refuses the cosmetic "unknown" as expected id', () => {
    // Identity parse succeeds (progresses past identity to the known model gate).
    assert.throws(
      () => capturedCodec.snapshot(fixture.sessionReadResult, fixture.sessionId),
      (e: { code: string }) => e.code === 'MODEL_UNADVERTISED',
      'captured unauthenticated read has no current model; identity parse must proceed to that named gate',
    )
    assert.throws(
      () => capturedCodec.snapshot(fixture.sessionReadResult, 'unknown'),
      (e: { code: string }) => e.code === 'SCHEMA_INVALID',
      'the projection.sessionId cosmetic value must not be accepted as native identity',
    )
  })
})

describe('captured divergence #1 — session/requestRuntimePreferences reverse request', () => {
  test('envelope matches the pinned capture and the reply preserves the string server id', async () => {
    const writes: unknown[] = []
    const output = new PassThrough()
    const input = new Writable({
      write(data, _enc, done) {
        writes.push(JSON.parse(data.toString()))
        done()
      },
    })
    let seen: { id: unknown; method: string; params: unknown } | undefined
    const c = new NativeClient({
      input,
      output,
      timeoutMs: 2000,
      onNotification: () => {},
      onRequest: async (id, method, params) => {
        seen = { id, method, params }
        // The bridge contract (zcode-backend reverse()): answer from profile
        // preferences, never via the interaction codec.
        return {
          ok: true as const,
          value: {
            nativeSearchEnhancementsEnabled: false,
            memoryEnabled: false,
            askUserQuestionAutoResolutionEnabled: false,
          },
        }
      },
      onDisconnect: () => {},
    })
    onTestFinished(() => c.dispose())
    output.write(JSON.stringify(fixture.reverseRequestFrame) + '\n')
    await delay(50)
    assert.ok(seen, 'reverse request reached the host callback')
    assert.equal(seen?.id, fixture.reverseRequestFrame.id, 'string server id preserved end to end')
    assert.equal(seen?.method, 'session/requestRuntimePreferences')
    assert.deepEqual(seen?.params, fixture.reverseRequestFrame.params)
    assert.deepEqual(seen?.params, {
      sessionId: fixture.sessionId,
      scope: 'runtime-materialization',
    })
    await delay(50)
    const reply = writes.find((w) => (w as { id?: unknown }).id === fixture.reverseRequestFrame.id)
    assert.ok(reply, 'reply envelope carries the original server request id')
    assert.ok(
      (reply as { result?: unknown }).result !== undefined,
      'bridge answered with preferences (result envelope)',
    )
  })
})

describe('captured snapshot parser — evidence-based quiescence, fail-closed growth', () => {
  test('captured read is quiescent up to the model gate; busy mutations fail closed', () => {
    const base = fixture.sessionReadResult
    const proj = base.projection as Record<string, unknown>
    const run = base.runtime as Record<string, unknown>
    const busyCases: Array<[string, Record<string, unknown>]> = [
      ['projection.status running', { ...base, projection: { ...proj, status: 'running' } }],
      ['runtime.pendingRequestIds nonempty', { ...base, runtime: { ...run, pendingRequestIds: ['req-1'] } }],
      ['projection.activeToolCalls nonempty', { ...base, projection: { ...proj, activeToolCalls: [{}] } }],
      ['projection.backgroundJobs nonempty', { ...base, projection: { ...proj, backgroundJobs: ['job-1'] } }],
      ['runtime.goalVerifications nonempty', { ...base, runtime: { ...run, goalVerifications: [{}] } }],
    ]
    for (const [name, mutated] of busyCases) {
      assert.throws(
        () => capturedCodec.snapshot(mutated, fixture.sessionId),
        (e: { code: string }) => e.code === 'SCHEMA_INVALID',
        `uncaptured busy shape "${name}" must refuse instead of fabricating activity fields`,
      )
    }
  })

  test('foreign protocol discriminator and identity mismatch fail closed', () => {
    const base = fixture.sessionReadResult as Record<string, unknown>
    assert.throws(
      () => capturedCodec.snapshot({ ...base, protocol: { name: 'Other', version: 1 } }, fixture.sessionId),
      (e: { code: string }) => e.code === 'SCHEMA_INVALID',
    )
    assert.throws(
      () =>
        capturedCodec.snapshot(
          { ...base, session: { ...(base.session as Record<string, unknown>), sessionId: 'sess_other' } },
          fixture.sessionId,
        ),
      (e: { code: string }) => e.code === 'SCHEMA_INVALID',
    )
  })

  test('unauthenticated capture has no current model — named refusal, never a fallback mapping', () => {
    assert.throws(
      () => capturedCodec.snapshot(fixture.sessionReadResult, fixture.sessionId),
      (e: { code: string; message: string }) =>
        e.code === 'MODEL_UNADVERTISED' && /no current model/.test(e.message),
    )
  })

  test('v4 subscribe ack shape matches the pinned capture contract (ack.subscriptionId/logEpoch)', () => {
    const ack = fixture.v4SubscribeResult.ack
    assert.equal(typeof ack.subscriptionId, 'string')
    assert.equal(typeof ack.logEpoch, 'string')
    assert.equal(ack.mode, 'snapshot')
  })
})

describe('uncertified capabilities fail closed', () => {
  test('fork/interaction/answer refuse until N08/N09/N14 capture their shapes', () => {
    assert.throws(() => capturedCodec.forkPoint({}), /N14/)
    assert.throws(
      () => capturedCodec.interaction('interaction/requestPermission', {}),
      /N08\/N09/,
    )
    assert.throws(() => capturedCodec.answer('permission', {}, { kind: 'permission', decision: 'deny' }))
    assert.equal(capturedCodec.evidence, 'synthetic', 'nothing is certified by this codec alone')
  })
})
