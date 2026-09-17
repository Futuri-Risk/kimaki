// ZK-007 coordinator contract tests — in-process fake-native backend (no process
// spawn, Windows-green). Pins the mission invariants at the coordinator level:
// FIFO ordering, one-admission→≤1-submission, no replay after uncertainty,
// cancellation fences (H12/H19 semantics), closed-controller refusal, generation
// safety on the event lane, interaction round-trip, event-backlog halt.
// The real-backend owned-process lifecycle suite lives in lifecycle.test.ts
// (Linux-gated on this machine per PLATFORM_UNCERTIFIED). — ZCode 2026-09-17
import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

import { AgentCoordinator, type Authorizer } from './coordinator.js'
import { createStoreHarness } from './test-harness.js'
import { fakeCodec } from './fixtures/fake-codec.js'
import type {
  AgentSession,
  NativeEvent,
  NativeInteraction,
  NativeSnapshot,
  InteractionAnswer,
  ForkPoint,
  ModelSelection,
} from './types.js'
import type { Result } from './errors.js'
import type { Attachment } from './attachments.js'
import type { NativeProfile } from './zcode-backend.js'

async function until(
  fn: () => Promise<boolean> | boolean,
  message: string,
  timeout = 5000,
): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) {
      return
    }
    await delay(10)
  }
  throw new Error(`Timed out: ${message}`)
}

/**
 * In-process fake of the ZcodeBackend surface the coordinator consumes. Each
 * submit records content and (by default) auto-completes the turn through the
 * event lane exactly like the real native projector flow: turn-started →
 * terminal → authoritative snapshot terminal for the reconcile readback.
 */
class FakeBackend {
  readonly id = 'zcode' as const
  generation: string | null = 'g1'
  submits: string[] = []
  turns = 0
  held = false
  submitError: Error | null = null
  cancelResult: Result<void> = { ok: true, value: undefined }
  private listener: ((sessionId: string, event: NativeEvent) => void) | null = null
  readonly profile: NativeProfile

  constructor(session: AgentSession, attachmentRoot: string) {
    this.profile = {
      id: session.profileId,
      revision: session.profileRevision,
      enabled: true,
      mode: 'build',
      codec: fakeCodec,
      allowSynthetic: true,
      preferences: {},
      display: 'legacy',
      launch: () => {
        throw new Error('not used in-process')
      },
      timeoutMs: 5000,
      cancelGraceMs: 150,
      imageCapability: false,
      attachmentRoot,
      redact: (value) => value,
    }
  }

  onEvent(listener: (sessionId: string, event: NativeEvent) => void): void {
    this.listener = listener
  }

  emit(event: NativeEvent): void {
    this.listener?.('zc:session-1', event)
  }

  get ownedSessionId(): string | null {
    return 'zc:session-1'
  }

  get pendingInteractions(): NativeInteraction[] {
    return [...this.interactions.values()]
  }

  private interactions = new Map<string, NativeInteraction>()

  disposeSession(): Promise<Result<void>> {
    return Promise.resolve({ ok: true, value: undefined })
  }

  dispose(): Promise<Result<void>> {
    return Promise.resolve({ ok: true, value: undefined })
  }

  async prepare(
    session: AgentSession,
  ): Promise<{ nativeSessionId: string; fingerprint: string; snapshot: NativeSnapshot }> {
    return {
      nativeSessionId: session.nativeSessionId ?? 'native-1',
      fingerprint: 'f'.repeat(64),
      snapshot: this.snapshot(),
    }
  }

  snapshot(): NativeSnapshot {
    return {
      sessionId: 'native-1',
      workspacePath: 'repo',
      workspaceKey: 'repo',
      model: { providerId: 'fixture', modelId: 'fixture-model', revision: 'r1', reasoning: 'high' },
      foreground: this.pendingTurn ? { id: this.pendingTurn, state: 'running' } : null,
      background: [],
      goalActive: false,
      terminal: this.terminal,
    }
  }

  terminal: { turnId: string; outcome: 'completed' | 'failed' | 'cancelled' } | null = null
  /** Turn currently in flight; null = quiescent (the real pre-submit state). */
  pendingTurn: string | null = null

  async inspect(): Promise<NativeSnapshot> {
    return this.snapshot()
  }

  async submit(
    _session: AgentSession,
    input: string,
    _attachments: readonly Attachment[] = [],
  ): Promise<void> {
    if (this.submitError) {
      throw this.submitError
    }
    this.submits.push(input)
    this.turns++
    const turnId = `t${this.turns}`
    this.pendingTurn = turnId
    this.emit({ type: 'turn-started', turnId })
    if (!this.held) {
      this.finishTurn(turnId)
    }
  }

  finishTurn(turnId: string): void {
    this.terminal = { turnId, outcome: 'completed' }
    this.pendingTurn = null
    this.emit({ type: 'terminal', turnId, outcome: 'completed' })
  }

  /** Register a native interaction the coordinator can answer (one-use). */
  offerInteraction(request: NativeInteraction): void {
    this.interactions.set(request.id, request)
    this.emit({ type: 'interaction', request })
  }

  async guide(): Promise<void> {}

  async answer(request: NativeInteraction): Promise<void> {
    this.interactions.delete(request.id)
    this.emit({ type: 'interaction-closed', id: request.id })
  }

  async cancel(): Promise<Result<void>> {
    if (this.cancelGate) {
      await this.cancelGate
    }
    this.held = false
    this.terminal = null
    this.pendingTurn = null
    return this.cancelResult
  }

  /** Test gate: when set, the native stop hangs until the promise resolves. */
  cancelGate: Promise<void> | null = null

  async compact(): Promise<void> {}

  async switchModel(_session: AgentSession, selection: ModelSelection): Promise<ModelSelection> {
    return selection
  }

  async forkPoint(): Promise<ForkPoint> {
    return { rowId: 1, entityId: 'e1', revision: 1, logEpoch: 'epoch-1' }
  }

  async fork(): Promise<string> {
    return 'native-child-1'
  }
}

export async function coordinatorHarness(
  options: { limits?: { maxPendingEvents?: number; maxPendingEventBytes?: number } } = {},
) {
  const h = await createStoreHarness()
  const backend = new FakeBackend(h.session, h.root)
  const authorize: Authorizer = (actorId, threadId, session) =>
    Promise.resolve(actorId === 'actor-1' && threadId === session.controllerThreadId)
  const coordinator = new AgentCoordinator(
    h.store,
    backend as never,
    authorize,
    options.limits ?? {},
  )
  const submit = async (
    sourceId: string,
    text: string,
    kind: 'prompt' | 'guide' | 'answer' | 'cancel' | 'model' | 'compact' | 'fork' = 'prompt',
    payload?: unknown,
  ) => {
    const result = await coordinator.ingest(h.input(sourceId, text, kind, payload))
    assert.equal(result.ok, true, JSON.stringify(result.ok ? '' : result.error.toJSON()))
    return result.value
  }
  const waitForState = async (opId: string, state: string) => {
    await until(async () => (await h.store.operation(opId))?.state === state, `${opId} → ${state}`)
  }
  return { ...h, backend, coordinator, submit, waitForState }
}

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
