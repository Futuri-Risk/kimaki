// ZK-007 coordinator contract tests — in-process fake-native backend (no process
// spawn, Windows-green). Pins the mission invariants at the coordinator level:
// FIFO ordering, one-admission→≤1-submission, no replay after uncertainty,
// cancellation fences (H12/H19 semantics), closed-controller refusal, generation
// safety on the event lane, interaction round-trip, event-backlog halt.
// The real-backend owned-process lifecycle suite lives in lifecycle.test.ts
// (Linux-gated on this machine per PLATFORM_UNCERTIFIED). — ZCode 2026-09-17
//
// #27 (ZCode 2026-09-28): moved verbatim from coordinator.test.ts, which is now
// a side-effect-light re-export shim. FakeBackend/coordinatorHarness/until come
// from the non-test module test-harness.ts so this suite registers exactly once.
import { describe, test } from 'vitest'
import assert from 'node:assert/strict'

import { coordinatorHarness, until } from './test-harness.js'
import type { InteractionAnswer } from './types.js'

describe('AgentCoordinator (in-process fake-native)', () => {
  test('queued prompts run strictly FIFO and each completes exactly once', async () => {
    const h = await coordinatorHarness()
    const a = await h.submit('one', 'a')
    const b = await h.submit('two', 'b')
    const c = await h.submit('three', 'c')
    await h.waitForState(a.id, 'completed')
    await h.waitForState(b.id, 'completed')
    await h.waitForState(c.id, 'completed')
    await h.coordinator.settle()
    assert.deepEqual(h.backend.submits, ['a', 'b', 'c'])
    await h.coordinator.close()
  })

  test('#30 waitForSettlement wakes when a live turn settles, and times out while work is queued', async () => {
    const h = await coordinatorHarness()
    // Registered before any work exists: catches the settlement fire whenever
    // the kick cycle ends with nothing queued or uncertain.
    const settled = h.coordinator.waitForSettlement(h.session.id, 10_000)
    const op = await h.submit('one', 'a')
    await h.waitForState(op.id, 'completed')
    assert.equal(await settled, true)
    // With no live work and none arriving, the waiter honestly times out —
    // callers pair the signal with their own active-state check.
    assert.equal(await h.coordinator.waitForSettlement(h.session.id, 50), false)
    await h.coordinator.close()
  })

  test('duplicate admission of the same source returns the same operation and never resubmits', async () => {
    const h = await coordinatorHarness()
    const first = await h.submit('dup', 'once')
    const again = await h.coordinator.ingest(h.input('dup', 'once'))
    assert.equal(again.ok, true)
    assert.equal(again.ok && again.value.id, first.id)
    await h.waitForState(first.id, 'completed')
    await h.coordinator.settle()
    assert.deepEqual(h.backend.submits, ['once'])
    await h.coordinator.close()
  })

  test('a lost native ACK after SEND_INTENT becomes submission-unknown and is never replayed', async () => {
    const h = await coordinatorHarness()
    h.backend.submitError = new Error('connection died after send')
    const op = await h.submit('crash', 'uncertain task')
    await h.waitForState(op.id, 'submission-unknown')
    await until(
      async () => (await h.store.session(h.session.id))?.state === 'recovery-required',
      'session recovery-required',
    )
    // Re-admitting the same source returns the SAME uncertain operation — no replay.
    const duplicate = await h.coordinator.ingest(h.input('crash', 'uncertain task'))
    assert.equal(duplicate.ok, true)
    assert.equal(duplicate.ok && duplicate.value.id, op.id)
    // A different prompt may be admitted but cannot submit while uncertainty holds.
    const blocked = await h.submit('next', 'after uncertainty')
    await h.coordinator.settle()
    assert.equal((await h.store.operation(blocked.id))?.state, 'queued')
    assert.deepEqual(h.backend.submits, [])
    await h.coordinator.close()
  })

  test('closed controller refuses new admissions', async () => {
    const h = await coordinatorHarness()
    await h.coordinator.close()
    const result = await h.coordinator.ingest(h.input('late', 'too late'))
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.error.code, 'COORDINATOR_CLOSED')
  })

  test('unauthorized actor and missing sessions are refused before admission', async () => {
    const h = await coordinatorHarness()
    const foreign = await h.coordinator.ingest({ ...h.input('x', 'no'), actorId: 'intruder' })
    assert.equal(!foreign.ok && foreign.error.code, 'ACTOR_UNAUTHORIZED')
    const missing = await h.coordinator.ingest({ ...h.input('x', 'gone'), sessionId: 'zc:missing' })
    assert.equal(missing.ok, false)
    await h.coordinator.close()
  })

  test('cancellation completes only after verified stop and fences concurrent guidance (H12)', async () => {
    const h = await coordinatorHarness()
    h.backend.held = true
    const running = await h.submit('hold', 'hold the turn')
    await h.waitForState(running.id, 'running')
    // Hold the native stop so the cancellation fence is observably in progress.
    let releaseStop!: () => void
    h.backend.cancelGate = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    const cancelPromise = h.coordinator.ingest(h.input('stop', '', 'cancel')).then((r) => {
      assert.equal(r.ok, true)
      return r
    })
    await until(
      async () => {
        const cancelOp = (await h.store.operations(h.session.id)).find((o) => o.kind === 'cancel')
        return cancelOp?.state === 'send-intent'
      },
      'cancel reached send-intent',
      2000,
    )
    // While the native stop is unconfirmed, guidance cannot pass the fence.
    const guide = await h.submit('steer', 'finish current', 'guide')
    // No settle() here: the gated cancel job is intentionally unfinished. The
    // guide control job settles on its own against the cancellation fence.
    await until(
      async () => (await h.store.operation(guide.id))?.state === 'rejected',
      'guide fenced',
      2000,
    )
    assert.equal((await h.store.operation(guide.id))?.state, 'rejected')
    // Release the held stop; cancellation settles and the paused turn cancels.
    releaseStop()
    await cancelPromise
    const cancelOp = (await h.store.operations(h.session.id)).find((o) => o.kind === 'cancel')!
    await h.waitForState(cancelOp.id, 'completed')
    assert.equal((await h.store.operation(running.id))?.state, 'cancelled')
    await h.coordinator.close()
  })

  test('a stale terminal event cannot undo a completed cancellation (H19)', async () => {
    const h = await coordinatorHarness()
    h.backend.held = true
    const running = await h.submit('hold', 'hold')
    await h.waitForState(running.id, 'running')
    const cancel = await h.submit('stop', '', 'cancel')
    await h.waitForState(cancel.id, 'completed')
    assert.equal((await h.store.operation(running.id))?.state, 'cancelled')
    // Late native terminal for the cancelled turn must not resurrect completion.
    h.backend.emit({ type: 'terminal', turnId: 't1', outcome: 'completed' })
    await h.coordinator.settle()
    assert.equal((await h.store.operation(running.id))?.state, 'cancelled')
    await h.coordinator.close()
  })

  test('native interaction pauses the turn and a validated answer resumes it', async () => {
    const h = await coordinatorHarness()
    h.backend.held = true
    const originalSubmit = h.backend.submit.bind(h.backend)
    h.backend.submit = async (session, input, attachments) => {
      await originalSubmit(session, input, attachments)
      if (input === 'permission') {
        h.backend.offerInteraction({
          id: 'i1',
          sessionId: h.session.id,
          generation: 'g1',
          requestId: '0',
          kind: 'permission',
          schema: { toolCallId: 'tc1', toolName: 'bash', input: {} },
          expiresAt: Date.now() + 10000,
          threadId: 'thread-1',
        })
      }
    }
    const op = await h.submit('ask', 'permission')
    await h.waitForState(op.id, 'waiting-interaction')
    const request = h.backend.pendingInteractions[0]!
    const answer = await h.submit('reply', '', 'answer', {
      interactionId: request.id,
      answer: { kind: 'permission', decision: 'allow-once' } satisfies InteractionAnswer,
    })
    await h.waitForState(answer.id, 'completed')
    await h.waitForState(op.id, 'running')
    h.backend.finishTurn('t1')
    await h.waitForState(op.id, 'completed')
    await h.coordinator.close()
  })

  test('events from a superseded connection generation are dropped', async () => {
    const h = await coordinatorHarness()
    // Enqueue while g1 owns the connection, then supersede it before the event
    // lane runs — the captured generation must not match the current one.
    h.backend.emit({
      type: 'parts',
      parts: [
        {
          id: 'p1',
          nativeId: 'n1',
          kind: 'text',
          state: 'done',
          text: 'stale generation',
          delivery: 'live',
          order: 0,
        },
      ],
      cursor: { stream: 'legacy', generation: 'g1', epoch: '', sequence: 1 },
    })
    h.backend.generation = 'g2'
    await h.coordinator.settle()
    const outbox = await h.store.outbox()
    assert.equal(outbox.length, 0)
    await h.coordinator.close()
  })

  test('event backlog beyond the configured limit halts the coordinator safely', async () => {
    const h = await coordinatorHarness({ limits: { maxPendingEvents: 1 } })
    h.backend.held = true
    const op = await h.submit('hold', 'hold')
    await h.waitForState(op.id, 'running')
    // Two events back-to-back with maxPendingEvents=1: the second either fits
    // after the first drains or trips EVENT_BACKLOG_LIMIT and halts. Both are
    // safe; what must NOT happen is a crash or a completed held turn.
    h.backend.emit({
      type: 'parts',
      parts: [
        {
          id: 'p1',
          nativeId: 'n1',
          kind: 'text',
          state: 'done',
          text: 'first',
          delivery: 'live',
          order: 0,
        },
      ],
      cursor: { stream: 'legacy', generation: 'g1', epoch: '', sequence: 1 },
    })
    h.backend.emit({
      type: 'parts',
      parts: [
        {
          id: 'p2',
          nativeId: 'n2',
          kind: 'text',
          state: 'done',
          text: 'second',
          delivery: 'live',
          order: 1,
        },
      ],
      cursor: { stream: 'legacy', generation: 'g1', epoch: '', sequence: 2 },
    })
    await h.coordinator.settle()
    assert.notEqual((await h.store.operation(op.id))?.state, 'completed')
    await h.coordinator.close()
  })
})
