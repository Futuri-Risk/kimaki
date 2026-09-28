// ZK-009 interaction-bridge contract tests, run against a REAL coordinator +
// in-process fake-native backend: opaque one-use ids, actor/thread binding,
// double-fire and stale-component denial, reused numeric RPC ids getting fresh
// tokens (H25/H26), no autoapprove (negative), fail-closed unknown schemas, and
// answer round-trips through the codec to the original native RPC. The
// coordinator's lane requires an active admission to own an interaction, so
// every live test runs inside a held turn (the realistic shape).
// — ZCode 2026-09-18
import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

import {
  InteractionBridge,
  interactionCustomId,
  interactionPromptView,
  parseInteractionCustomId,
  questionCustomId,
  type BridgePorts,
  type PromptView,
} from './interaction-bridge.js'
import { coordinatorHarness } from './test-harness.js'
import type { NativeEvent, NativeInteraction } from './types.js'

function recordPorts() {
  const views: Array<{ threadId: string; view: PromptView }> = []
  const notices: Array<{ threadId: string; text: string }> = []
  const ports: BridgePorts = {
    sendPrompt: async (threadId, view) => {
      views.push({ threadId, view })
    },
    sendNotice: async (threadId, text) => {
      notices.push({ threadId, text })
    },
  }
  return { ports, views, notices }
}

function request(overrides: Partial<NativeInteraction> = {}): NativeInteraction {
  return {
    id: 'i-1',
    sessionId: 'session-1',
    generation: 'g1',
    requestId: '7',
    kind: 'permission',
    schema: { toolCallId: 'tc1', toolName: 'bash', input: { command: 'rm -rf /tmp/x' } },
    expiresAt: Date.now() + 60_000,
    threadId: 'thread-1',
    ...overrides,
  }
}

async function bridgeHarness() {
  const h = await coordinatorHarness()
  const channel = recordPorts()
  const bridge = new InteractionBridge(channel.ports)
  const originalEmit = h.backend.emit.bind(h.backend)
  h.backend.emit = (event: NativeEvent) => {
    originalEmit(event)
    void bridge.handleNativeEvent(h.session.id, event)
  }
  /** Offer a request from inside a held turn and wait for the op to pause. */
  const offerDuringTurn = async (req: NativeInteraction) => {
    h.backend.held = true
    const originalSubmit = h.backend.submit.bind(h.backend)
    h.backend.submit = async (session, input, attachments) => {
      h.backend.submit = originalSubmit
      await originalSubmit(session, input, attachments)
      h.backend.offerInteraction({ ...req, sessionId: h.session.id })
    }
    const op = await h.submit('ask', 'permission')
    await h.waitForState(op.id, 'waiting-interaction')
    return op
  }
  return { ...h, channel, bridge, offerDuringTurn }
}

describe('interaction custom id codec', () => {
  test('round-trips permission/plan controls and question selectors within 100 chars', () => {
    for (const control of ['allow-once', 'deny', 'approve', 'reject'] as const) {
      const id = interactionCustomId('0f0e0d0c-1111-2222-3333-444455556666', control)
      assert.ok(id.length <= 100)
      assert.deepEqual(parseInteractionCustomId(id), {
        interactionId: '0f0e0d0c-1111-2222-3333-444455556666',
        control,
      })
    }
    const question = questionCustomId('0f0e0d0c-1111-2222-3333-444455556666', 'q1')
    assert.ok(question && question.length <= 100)
    assert.deepEqual(parseInteractionCustomId(question!), {
      interactionId: '0f0e0d0c-1111-2222-3333-444455556666',
      control: 'question',
      questionId: 'q1',
    })
  })

  test('rejects garbage, foreign prefixes, and empty question ids', () => {
    assert.equal(parseInteractionCustomId('zci:'), null)
    assert.equal(parseInteractionCustomId('permission_once:hash'), null)
    assert.equal(parseInteractionCustomId('zci:id:mystery'), null)
    assert.equal(parseInteractionCustomId('zci::allow-once'), null)
    assert.equal(parseInteractionCustomId('zci:id:q:'), null)
    assert.equal(parseInteractionCustomId('zci:id:q:ok:extra'), null)
  })
})

describe('prompt view shaping (fail-closed on unknown schemas)', () => {
  test('permission, plan, and certified question schemas render views', () => {
    const p = interactionPromptView(request())
    assert.equal(p.kind, 'permission')
    assert.equal(p.toolName, 'bash')
    assert.ok(p.summary.includes('rm -rf'))

    const plan = interactionPromptView(
      request({ id: 'i-2', kind: 'plan-approval', schema: { kind: 'plan', title: 'Refactor' } }),
    )
    assert.equal(plan.kind, 'plan-approval')
    assert.equal(plan.title, 'Refactor')

    const question = interactionPromptView(
      request({
        id: 'i-3',
        kind: 'question',
        schema: {
          kind: 'questions',
          questions: [{ id: 'q1', question: 'Pick one', options: ['A', 'B'] }],
        },
      }),
    )
    assert.equal(question.kind, 'question')
    assert.deepEqual(question.questions[0]!.options, ['A', 'B'])
  })

  test('unknown or non-round-trippable schemas fail closed with no answerable component', () => {
    assert.equal(
      interactionPromptView(request({ schema: { toolCallId: 1, toolName: 'bash' } })).kind,
      'unsupported',
    )
    assert.equal(
      interactionPromptView(request({ kind: 'plan-approval', schema: { kind: 'mystery' } })).kind,
      'unsupported',
    )
    assert.equal(
      interactionPromptView(request({ kind: 'question', schema: { kind: 'weird' } })).kind,
      'unsupported',
    )
    // Duplicate options, oversized options, and question ids that do not fit a
    // Discord custom id cannot be answered byte-identically, so they stay
    // unsupported rather than guessing a mapping.
    assert.equal(
      interactionPromptView(
        request({
          kind: 'question',
          schema: { kind: 'questions', questions: [{ id: 'q1', options: ['A', 'A'] }] },
        }),
      ).kind,
      'unsupported',
    )
    assert.equal(
      interactionPromptView(
        request({
          kind: 'question',
          schema: { kind: 'questions', questions: [{ id: 'q1', options: ['x'.repeat(101)] }] },
        }),
      ).kind,
      'unsupported',
    )
    assert.equal(
      interactionPromptView(
        request({
          kind: 'question',
          schema: { kind: 'questions', questions: [{ id: 'q'.repeat(91), options: ['A'] }] },
        }),
      ).kind,
      'unsupported',
    )
  })
})

describe('InteractionBridge over a real coordinator', () => {
  test('permission component answers the original native RPC once and resumes the turn', async () => {
    const h = await bridgeHarness()
    await h.offerDuringTurn(request())
    assert.equal(h.channel.views.length, 1)
    const view = h.channel.views[0]!.view
    assert.equal(view.kind, 'permission')
    assert.equal(view.threadId, 'thread-1')

    const result = await h.bridge.submitFromComponent({
      coordinator: h.coordinator,
      sessionId: h.session.id,
      actorId: 'actor-1',
      threadId: 'thread-1',
      customId: interactionCustomId('i-1', 'allow-once'),
    })
    assert.equal(result.ok, true, JSON.stringify(result.ok ? '' : result.error.toJSON()))
    await h.waitForState((await h.store.operations(h.session.id)).at(-1)!.id, 'completed')
    assert.equal(h.backend.pendingInteractions.length, 0)
    await h.coordinator.close()
  })

  test('a double-fired component is denied and answers exactly once', async () => {
    const h = await bridgeHarness()
    const op = await h.offerDuringTurn(request())
    const args = {
      coordinator: h.coordinator,
      sessionId: h.session.id,
      actorId: 'actor-1',
      threadId: 'thread-1',
      customId: interactionCustomId('i-1', 'deny'),
    }
    const first = await h.bridge.submitFromComponent(args)
    assert.equal(first.ok, true)
    // Discord redelivers the same component: denied, nothing re-answered.
    const second = await h.bridge.submitFromComponent(args)
    assert.equal(second.ok, false)
    assert.equal(!second.ok && second.error.code, 'INTERACTION_GONE')
    // The held turn keeps the prompt op running; only the answer op finished.
    assert.equal((await h.store.operation(op.id))?.state, 'running')
    assert.equal(h.backend.pendingInteractions.length, 0)
    await h.coordinator.close()
  })

  test('wrong actor is denied and the request stays answerable by the right actor', async () => {
    const h = await bridgeHarness()
    await h.offerDuringTurn(request())
    const denied = await h.bridge.submitFromComponent({
      coordinator: h.coordinator,
      sessionId: h.session.id,
      actorId: 'actor-2',
      threadId: 'thread-1',
      customId: interactionCustomId('i-1', 'allow-once'),
    })
    assert.equal(denied.ok, false)
    assert.equal(!denied.ok && denied.error.code, 'ACTOR_UNAUTHORIZED')
    assert.equal(h.backend.pendingInteractions.length, 1)
    const allowed = await h.bridge.submitFromComponent({
      coordinator: h.coordinator,
      sessionId: h.session.id,
      actorId: 'actor-1',
      threadId: 'thread-1',
      customId: interactionCustomId('i-1', 'allow-once'),
    })
    assert.equal(allowed.ok, true)
    await h.coordinator.close()
  })

  test('unknown custom ids and foreign threads are refused without touching native state', async () => {
    const h = await bridgeHarness()
    await h.offerDuringTurn(request())
    const unknown = await h.bridge.submitFromComponent({
      coordinator: h.coordinator,
      sessionId: h.session.id,
      actorId: 'actor-1',
      threadId: 'thread-1',
      customId: 'zci:missing:allow-once',
    })
    assert.equal(unknown.ok, false)
    assert.equal(!unknown.ok && unknown.error.code, 'INTERACTION_GONE')
    const foreignThread = await h.bridge.submitFromComponent({
      coordinator: h.coordinator,
      sessionId: h.session.id,
      actorId: 'actor-1',
      threadId: 'thread-elsewhere',
      customId: interactionCustomId('i-1', 'allow-once'),
    })
    assert.equal(foreignThread.ok, false)
    assert.equal(!foreignThread.ok && foreignThread.error.code, 'INTERACTION_GONE')
    assert.equal(h.backend.pendingInteractions.length, 1)
    await h.coordinator.close()
  })

  test('H25/H26: reused numeric native RPC id gets a fresh opaque token; the old one cannot answer', async () => {
    const h = await bridgeHarness()
    const op = await h.offerDuringTurn(request({ id: 'opaque-round-1', requestId: '7' }))
    const round1 = await h.bridge.submitFromComponent({
      coordinator: h.coordinator,
      sessionId: h.session.id,
      actorId: 'actor-1',
      threadId: 'thread-1',
      customId: interactionCustomId('opaque-round-1', 'allow-once'),
    })
    assert.equal(round1.ok, true)
    // The turn is still held, so the op is active: a NEW native request reusing
    // numeric RPC id 7 arrives under a fresh opaque id.
    h.backend.offerInteraction(
      request({ id: 'opaque-round-2', sessionId: h.session.id, requestId: '7' }),
    )
    // The coordinator's event lane must persist the new interaction (and move
    // the held op back to waiting-interaction) before any answer can consume it.
    await h.waitForState(op.id, 'waiting-interaction')
    const replay = await h.bridge.submitFromComponent({
      coordinator: h.coordinator,
      sessionId: h.session.id,
      actorId: 'actor-1',
      threadId: 'thread-1',
      customId: interactionCustomId('opaque-round-1', 'allow-once'),
    })
    assert.equal(replay.ok, false)
    assert.equal(!replay.ok && replay.error.code, 'INTERACTION_GONE')
    const round2 = await h.bridge.submitFromComponent({
      coordinator: h.coordinator,
      sessionId: h.session.id,
      actorId: 'actor-1',
      threadId: 'thread-1',
      customId: interactionCustomId('opaque-round-2', 'deny'),
    })
    assert.equal(round2.ok, true)
    assert.equal(h.backend.pendingInteractions.length, 0)
    await h.coordinator.close()
  })

  test('no autoapprove: rendering and waiting alone never answer the request', async () => {
    const h = await bridgeHarness()
    const op = await h.offerDuringTurn(request({ expiresAt: Date.now() + 300 }))
    await delay(500)
    assert.equal(
      h.backend.pendingInteractions.length,
      1,
      'request must wait for an explicit user answer',
    )
    assert.equal((await h.store.operation(op.id))?.state, 'waiting-interaction')
    await h.coordinator.close()
  })

  test('expired request is denied at the durable consume even with a valid component id', async () => {
    const h = await bridgeHarness()
    await h.offerDuringTurn(request({ expiresAt: Date.now() - 1 }))
    const expired = await h.bridge.submitFromComponent({
      coordinator: h.coordinator,
      sessionId: h.session.id,
      actorId: 'actor-1',
      threadId: 'thread-1',
      customId: interactionCustomId('i-1', 'allow-once'),
    })
    assert.equal(expired.ok, false)
    assert.equal(!expired.ok && expired.error.code, 'ANSWER_REJECTED')
    await h.coordinator.close()
  })

  test('question select answers flow as structured values the codec accepts', async () => {
    const h = await bridgeHarness()
    await h.offerDuringTurn(
      request({
        id: 'i-q',
        kind: 'question',
        schema: {
          kind: 'questions',
          questions: [
            { id: 'q1', question: 'Pick one', options: ['Ship it', 'Hold'] },
            { id: 'q2', question: 'Risk?', options: ['low', 'high'], multiple: true },
          ],
        },
      }),
    )
    assert.equal(h.channel.views[0]!.view.kind, 'question')
    // The native question RPC answers ONCE with every question's value: the
    // first select records, the second completes the single native answer.
    const partial = await h.bridge.submitFromComponent({
      coordinator: h.coordinator,
      sessionId: h.session.id,
      actorId: 'actor-1',
      threadId: 'thread-1',
      customId: questionCustomId('i-q', 'q1')!,
      selected: ['Ship it'],
    })
    assert.equal(partial.ok, true)
    assert.deepEqual(partial.ok && partial.value, { acknowledged: true, submitted: false })
    assert.equal(
      h.backend.pendingInteractions.length,
      1,
      'nothing answered until the set is complete',
    )
    const complete = await h.bridge.submitFromComponent({
      coordinator: h.coordinator,
      sessionId: h.session.id,
      actorId: 'actor-1',
      threadId: 'thread-1',
      customId: questionCustomId('i-q', 'q2')!,
      selected: ['low', 'high'],
    })
    assert.equal(complete.ok, true, JSON.stringify(complete.ok ? '' : complete.error.toJSON()))
    assert.deepEqual(complete.ok && complete.value, { acknowledged: true, submitted: true })
    assert.equal(h.backend.pendingInteractions.length, 0)
    await h.coordinator.close()
  })

  test('plan approval buttons map to an explicit approved/rejected answer', async () => {
    const h = await bridgeHarness()
    await h.offerDuringTurn(
      request({
        id: 'i-plan',
        kind: 'plan-approval',
        schema: { kind: 'plan', title: 'Refactor renderer' },
      }),
    )
    const rejected = await h.bridge.submitFromComponent({
      coordinator: h.coordinator,
      sessionId: h.session.id,
      actorId: 'actor-1',
      threadId: 'thread-1',
      customId: interactionCustomId('i-plan', 'reject'),
    })
    assert.equal(rejected.ok, true)
    assert.equal(h.backend.pendingInteractions.length, 0)
    await h.coordinator.close()
  })
})
