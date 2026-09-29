// ZK-007 port of the hardened standalone slice coordinator.ts — the durable
// native task actor: admission (authorizer + store.admit), SEND_INTENT before any
// native effect, cancellation epochs, control fences, bounded event admission.
// Adapted to the host-shaped contracts in agent/types.ts (ZK-004 store port).
// — ZCode 2026-09-17
import { randomUUID } from 'node:crypto'
import { fail, attempt, unwrap, record, text, type Result, safeJson } from './errors.js'
import { quiescent, assertModel } from './native/protocol.js'
import type { AgentStore } from './store.js'
import type { ZcodeBackend } from './zcode-backend.js'
import type {
  AgentSession,
  Input,
  Operation,
  NativeEvent,
  InteractionAnswer,
  ModelSelection,
  NativeInteraction,
  NativeSnapshot,
  ForkPoint,
} from './types.js'
import type { Attachment } from './attachments.js'
export type CoordinatorLimits = {
  maxPendingEvents?: number
  maxPendingEventBytes?: number
  /**
   * #24 kick() retry policy for drain cycles that end with a queued prompt
   * still unclaimed (pre-transition failure, e.g. WORKSPACE_BUSY while another
   * session owns the native home). Exponential backoff keeps a persistent
   * failure a bounded retry instead of a zero-delay hot loop.
   */
  kickBackoff?: { baseMs?: number; maxMs?: number; maxRetries?: number }
}
export type Authorizer = (
  actorId: string,
  threadId: string,
  session: AgentSession,
) => Promise<boolean>
const uncertain = [
  'send-intent',
  'submission-unknown',
  'running',
  'waiting-interaction',
  'foreground-terminal',
  'cancel-unconfirmed',
] as const
/** Durable task actor. RPC/event lanes are separate so pre-ACK questions cannot deadlock. */
export class AgentCoordinator {
  readonly ownerNonce = randomUUID()
  private draining = new Set<string>()
  private controls = new Map<string, string>()
  private cancellationEpoch = new Map<string, number>()
  private assertOpen() {
    if (this.closed) throw fail('COORDINATOR_CLOSED', 'Admissions are stopped.')
  }
  private assertFence(sessionId: string, epoch: number, owner?: string) {
    this.assertOpen()
    if (
      (this.cancellationEpoch.get(sessionId) ?? 0) !== epoch ||
      (this.controls.has(sessionId) && this.controls.get(sessionId) !== owner)
    ) {
      throw fail('ADMISSION_FENCED', 'Native write lost its cancellation/control fence.', 'control')
    }
  }
  private active = new Map<string, string>()
  private jobs = new Set<Promise<unknown>>()
  /** #24: consecutive kick cycles per session that left a queued prompt unclaimed. */
  private kickDeferrals = new Map<string, number>()
  private readonly kickBaseMs: number
  private readonly kickMaxMs: number
  private readonly kickMaxRetries: number
  private eventTail: Promise<void> = Promise.resolve()
  private closed = false
  private errors: string[] = []
  private closing: Promise<Result<void>> | undefined
  private queuedEvents = 0
  private queuedEventBytes = 0
  constructor(
    readonly store: AgentStore,
    readonly backend: ZcodeBackend,
    readonly authorize: Authorizer,
    limits: CoordinatorLimits = {},
  ) {
    const maxCount = limits.maxPendingEvents ?? 1024
    const maxBytes = limits.maxPendingEventBytes ?? 8 * 1024 * 1024
    this.kickBaseMs = limits.kickBackoff?.baseMs ?? 500
    this.kickMaxMs = limits.kickBackoff?.maxMs ?? 30_000
    this.kickMaxRetries = limits.kickBackoff?.maxRetries ?? 64
    if (![maxCount, maxBytes].every((n) => Number.isSafeInteger(n) && n > 0))
      throw fail('CONFIG_INVALID', 'Event limits must be positive safe integers.')
    if (
      !Number.isSafeInteger(this.kickBaseMs) ||
      this.kickBaseMs <= 0 ||
      !Number.isSafeInteger(this.kickMaxMs) ||
      this.kickMaxMs < this.kickBaseMs ||
      !Number.isSafeInteger(this.kickMaxRetries) ||
      this.kickMaxRetries < 0
    ) {
      throw fail('CONFIG_INVALID', 'Kick backoff limits are invalid.')
    }
    backend.onEvent((sessionId, event) => {
      if (this.closed) return
      let bytes: number
      try {
        bytes = Buffer.byteLength(safeJson(event, maxBytes))
      } catch {
        this.halt('EVENT_BACKLOG_LIMIT')
        return
      }
      if (this.queuedEvents >= maxCount || this.queuedEventBytes + bytes > maxBytes) {
        this.halt('EVENT_BACKLOG_LIMIT')
        return
      }
      this.queuedEvents++
      this.queuedEventBytes += bytes
      const generation = backend.generation
      this.eventTail = this.eventTail
        .then(async () => {
          // The transport generation is captured from the owned client,
          // not trusted from the native event payload.
          if (this.closed || (generation !== null && generation !== backend.generation)) return
          await this.event(sessionId, event)
        })
        .catch(() => this.halt('EVENT_STATE_WRITE_FAILED'))
        .finally(() => {
          this.queuedEvents--
          this.queuedEventBytes -= bytes
        })
    })
  }
  private halt(code: string) {
    if (this.closed) return
    this.closed = true
    this.note(code)
    this.launch(async () => {
      await this.backend.dispose()
      for (const [sessionId, opId] of this.active) {
        const op = await this.store.operation(opId)
        if (
          op &&
          (op.state === 'preparing' || uncertain.includes(op.state as (typeof uncertain)[number]))
        ) {
          await this.store.transition(op.id, [op.state], 'submission-unknown')
          await this.store.sessionState(sessionId, 'recovery-required')
        }
      }
      // Resource fences stay in place after overload or durable-state failure.
    })
  }
  private async releaseSettled(sessionId: string) {
    if (this.backend.ownedSessionId === sessionId)
      await this.store.releaseWorkspace(sessionId, this.ownerNonce)
    else await this.store.release(sessionId, this.ownerNonce)
  }
  get diagnostics() {
    return [...this.errors]
  }
  private note(code: string) {
    this.errors.push(code)
    if (this.errors.length > 256) {
      this.errors.shift()
    }
  }
  private async intent(
    op: Operation,
    expected: readonly import('./types.js').OperationState[],
    generation?: string,
  ) {
    if (
      !(await this.store.transition(
        op.id,
        expected,
        'send-intent',
        generation ? { generation } : {},
      ))
    ) {
      throw fail('OPERATION_NOT_CLAIMED', 'Operation no longer owns its native write.', 'control')
    }
  }
  private launch(fn: () => Promise<void>) {
    const p = fn()
      .catch(() => {
        this.note('COORDINATOR_FAILURE')
      })
      .finally(() => this.jobs.delete(p))
    this.jobs.add(p)
  }
  async ingest(input: Input): Promise<Result<Operation>> {
    return attempt(async () => {
      if (this.closed) {
        throw fail('COORDINATOR_CLOSED', 'Admissions are stopped.')
      }
      const session = await this.store.session(input.sessionId)
      if (!session || session.backend !== 'zcode') {
        throw fail('BACKEND_MISMATCH', 'This coordinator only controls native ZCode sessions.')
      }
      if (!(await this.authorize(input.actorId, input.threadId, session))) {
        throw fail('ACTOR_UNAUTHORIZED', 'The actual actor is not authorized for this session.')
      }
      this.assertOpen()
      // Refuse attachment guidance before admission and before any native control write.
      if (input.kind === 'guide' && input.payload !== undefined && input.payload !== null) {
        throw fail('GUIDE_ATTACHMENTS_UNSUPPORTED', 'Guidance accepts plain text only.', 'control')
      }
      const admitted = await this.store.admit(input)
      if (!admitted.created) {
        return admitted.operation
      }
      if (input.kind === 'prompt') {
        // #24: a fresh admission restarts the kick retry cycle (also revives a
        // queue whose retries were exhausted while the blocker persisted).
        this.kickDeferrals.delete(session.id)
        this.kick(session.id)
      } else {
        this.launch(() => this.control(session, admitted.operation))
      }
      return admitted.operation
    })
  }
  private kick(sessionId: string) {
    if (!this.closed && !this.draining.has(sessionId)) {
      this.draining.add(sessionId)
      this.launch(async () => {
        let progressed = false
        try {
          progressed = await this.drain(sessionId)
        } finally {
          this.draining.delete(sessionId)
          const current = await this.store.session(sessionId)
          // #26: the queue re-read after a drain only looks at live/queued
          // states — not the session's whole operation history.
          const queue = await this.store.operations(sessionId, {
            states: [...uncertain, 'preparing', 'queued'],
          })
          if (
            current?.state === 'idle' &&
            !queue.some(
              (o) =>
                uncertain.includes(o.state as (typeof uncertain)[number]) ||
                o.state === 'preparing',
            ) &&
            queue.some((o) => o.kind === 'prompt' && o.state === 'queued')
          ) {
            if (progressed) {
              // FIFO chain: the previous cycle submitted work; keep draining
              // immediately (historical behavior, never backed off).
              this.kickDeferrals.delete(sessionId)
              this.kick(sessionId)
              return
            }
            // #24: a queued prompt survived the cycle unclaimed — a recurring
            // pre-transition failure. Back off exponentially and bound the
            // retry count instead of re-kicking at zero delay forever.
            const failures = (this.kickDeferrals.get(sessionId) ?? 0) + 1
            if (failures > this.kickMaxRetries) {
              this.note('KICK_RETRY_EXHAUSTED')
              return
            }
            this.kickDeferrals.set(sessionId, failures)
            const waitMs = Math.min(this.kickBaseMs * 2 ** (failures - 1), this.kickMaxMs)
            const timer = setTimeout(() => {
              this.kick(sessionId)
            }, waitMs)
            timer.unref?.()
          } else {
            this.kickDeferrals.delete(sessionId)
          }
        }
      })
    }
  }
  /**
   * #29: prepare returns the authoritative snapshot it already read — the
   * caller's submit/control quiescence and model gates reuse it instead of
   * re-reading a session that no native write has touched in between.
   */
  private async prepare(session: AgentSession): Promise<{
    session: AgentSession
    snapshot: NativeSnapshot
  }> {
    await this.store.acquire(session, this.ownerNonce)
    if (!session.nativeSessionId) {
      if (session.state !== 'unbound') {
        throw fail(
          'CREATE_UNKNOWN',
          'Previous native creation needs recovery; no automatic retry.',
          'recover',
          'possible',
        )
      }
      await this.store.sessionState(session.id, 'creating-intent')
      session = { ...session, state: 'creating-intent' }
      const prepared = await this.backend.prepare(session)
      await this.store.bindNative(session.id, prepared.nativeSessionId, prepared.fingerprint)
      session = (await this.store.session(session.id))!
      return { session, snapshot: prepared.snapshot }
    }
    const resumed = await this.backend.prepare(
      session,
      (await this.store.streamCursor(session.id, 'legacy'))?.sequence ?? -1,
    )
    return { session, snapshot: resumed.snapshot }
  }
  /** One drain cycle. Returns true when native work was submitted this cycle. */
  private async drain(sessionId: string): Promise<boolean> {
    let op: Operation | null = null
    const epoch = this.cancellationEpoch.get(sessionId) ?? 0
    try {
      let session = await this.store.session(sessionId)
      if (
        !session ||
        !['unbound', 'idle'].includes(session.state) ||
        this.controls.has(sessionId)
      ) {
        return false
      }
      // #26: drain only decides between live/uncertain work and the next
      // queued prompt — include 'queued' so the picker below can find it.
      const operations = await this.store.operations(sessionId, {
        states: [...uncertain, 'preparing', 'queued'],
      })
      if (
        operations.some(
          (o) =>
            uncertain.includes(o.state as (typeof uncertain)[number]) || o.state === 'preparing',
        )
      ) {
        return false
      }
      op = operations.find((o) => o.kind === 'prompt' && o.state === 'queued') ?? null
      if (!op) {
        return false
      }
      await this.store.acquire(session, this.ownerNonce)
      if (!(await this.store.transition(op.id, ['queued'], 'preparing'))) {
        return false
      }
      this.active.set(sessionId, op.id)
      assertModel(session.model, op.model)
      this.assertFence(sessionId, epoch)
      const prepared = await this.prepare(session)
      this.assertFence(sessionId, epoch)
      session = prepared.session
      // #29: this snapshot is the submit-time quiescence/model read — no
      // native write happened since prepare read it.
      assertModel(prepared.snapshot.model, session.model)
      if (!quiescent(prepared.snapshot)) {
        throw fail(
          'NATIVE_BUSY',
          'Native activity must be reconciled before a new prompt.',
          'recover',
          'possible',
        )
      }
      // Cancellation/idle controls may have arrived while create/resume was awaiting RPC.
      const latest = await this.store.session(sessionId)
      if (this.closed || this.controls.has(sessionId) || latest?.state !== 'idle') {
        throw fail('ADMISSION_FENCED', 'Native submission was fenced before write.', 'control')
      }
      const generation = text(this.backend.generation)
      if (!(await this.store.transition(op.id, ['preparing'], 'send-intent', { generation }))) {
        return false
      }
      await this.store.sessionState(sessionId, 'running')
      let attachments: Attachment[] = []
      if (op.payload !== null && op.payload !== undefined) {
        const payload = record(op.payload)
        if (payload.attachments !== undefined) {
          if (!Array.isArray(payload.attachments)) {
            throw fail('ATTACHMENT_UNSUPPORTED', 'Invalid attachment list.')
          }
          attachments = payload.attachments as Attachment[]
        }
      }
      this.assertFence(sessionId, epoch)
      await this.backend.submit(session, op.text, attachments, prepared.snapshot)
      // Events may already have committed terminal state before the ACK arrives.
      await this.store.transition(op.id, ['send-intent'], 'running', { generation })
      return true
    } catch (error) {
      // Cancellation owns settlement of the invalidated send, including a lost
      // ACK aborted by the backend fence. Do not overwrite its paused state.
      if ((this.cancellationEpoch.get(sessionId) ?? 0) !== epoch) return false
      const row = op ? await this.store.operation(op.id) : null
      if (row && row.state === 'preparing') {
        await this.store.transition(row.id, ['preparing'], 'rejected')
        await this.store.sessionState(sessionId, 'paused')
        const stopped = await this.backend.disposeSession(sessionId)
        if (stopped.ok) {
          await this.store.release(sessionId, this.ownerNonce)
        }
      } else if (
        row &&
        ['send-intent', 'running', 'waiting-interaction', 'foreground-terminal'].includes(row.state)
      ) {
        await this.store.transition(row.id, [row.state], 'submission-unknown')
        await this.store.sessionState(sessionId, 'recovery-required')
        // Keep resource fences after uncertain submission even if owned runtime can be stopped.
        await this.backend.disposeSession(sessionId)
      }
      this.note(error instanceof Error && 'code' in error ? String(error.code) : 'PREPARE_FAILED')
      return false
    }
  }
  private async control(session: AgentSession, op: Operation) {
    const epoch = this.cancellationEpoch.get(session.id) ?? 0
    const concurrent = ['guide', 'cancel', 'answer'].includes(op.kind)
    if (!concurrent && this.controls.has(session.id)) {
      await this.store.transition(op.id, ['queued'], 'rejected')
      return
    }
    if (!concurrent) {
      this.controls.set(session.id, op.id)
    }
    try {
      if (op.kind === 'cancel') {
        this.controls.set(session.id, op.id)
        this.cancellationEpoch.set(session.id, epoch + 1)
        await this.store.sessionState(session.id, 'paused')
        await this.intent(op, ['queued'])
        session = (await this.store.session(session.id))!
        const result = await this.backend.cancel(session, op.id)
        if (result.ok) {
          for (const other of await this.store.operations(session.id, {
            states: [...uncertain, 'preparing'],
          }))
            if (
              other.id !== op.id &&
              (uncertain.includes(other.state as (typeof uncertain)[number]) ||
                other.state === 'preparing')
            ) {
              await this.store.transition(other.id, [other.state], 'cancelled')
            }
          await this.store.transition(op.id, ['send-intent'], 'completed')
          await this.store.release(session.id, this.ownerNonce)
          this.active.delete(session.id)
        } else {
          await this.store.transition(op.id, ['send-intent'], 'cancel-unconfirmed')
          this.note(result.error.code)
        }
        return
      }
      this.assertFence(session.id, epoch, concurrent ? undefined : op.id)
      if (op.kind === 'guide') {
        if (!this.active.has(session.id)) {
          throw fail('NATIVE_IDLE', 'Guidance requires an active admitted native turn.', 'control')
        }
        await this.intent(op, ['queued'], text(this.backend.generation))
        this.assertFence(session.id, epoch)
        await this.backend.guide(session, op.id, op.text)
        await this.store.transition(op.id, ['send-intent'], 'running')
        return
      }
      if (op.kind === 'answer') {
        const payload = record(op.payload)
        const id = text(payload.interactionId)
        const request = this.backend.pendingInteractions.find((r) => r.id === id)
        if (!request || request.sessionId !== session.id || request.threadId !== op.threadId) {
          throw fail('INTERACTION_STALE', 'Native interaction is no longer available.', 'control')
        }
        const answer = payload.answer as InteractionAnswer
        // Validate schema before consuming the one-use interaction or writing its journal intent.
        this.backend.profile.codec.answer(request.kind, request.schema, answer)
        await this.store.consumeInteraction(request, op.threadId, text(this.backend.generation))
        await this.intent(op, ['queued'])
        this.assertFence(session.id, epoch)
        await this.backend.answer(request, answer)
        await this.store.transition(op.id, ['send-intent'], 'completed')
        const activeId = this.active.get(session.id)
        if (activeId) {
          await this.store.transition(activeId, ['waiting-interaction'], 'running')
        }
        return
      }
      // #26: the model-order guard only compares against queued prompts.
      const ops = await this.store.operations(session.id, { states: ['queued'] })
      if (
        op.kind === 'model' &&
        ops.some(
          (other) => other.kind === 'prompt' && other.order < op.order && other.state === 'queued',
        )
      ) {
        throw fail(
          'NATIVE_BUSY',
          'Model change cannot overtake an earlier queued prompt.',
          'control',
        )
      }
      if (
        ops.some(
          (other) =>
            other.id !== op.id &&
            (uncertain.includes(other.state as (typeof uncertain)[number]) ||
              other.state === 'preparing'),
        )
      ) {
        throw fail('NATIVE_BUSY', 'Idle control is fenced by another operation.', 'control')
      }
      if (!(await this.store.transition(op.id, ['queued'], 'preparing'))) {
        return
      }
      this.assertFence(session.id, epoch, op.id)
      const prepared = await this.prepare(session)
      this.assertFence(session.id, epoch, op.id)
      session = prepared.session
      // #29: the prepare-time snapshot is the control quiescence read.
      if (!quiescent(prepared.snapshot)) {
        throw fail('NATIVE_BUSY', 'Control requires authoritative native quiescence.', 'control')
      }
      let point: ForkPoint | undefined
      if (op.kind === 'fork') {
        point = await this.backend.forkPoint(session)
      }
      this.assertFence(session.id, epoch, op.id)
      await this.intent(op, ['preparing'], text(this.backend.generation))
      this.assertFence(session.id, epoch, op.id)
      if (op.kind === 'compact') {
        await this.backend.compact(session, prepared.snapshot)
      } else if (op.kind === 'model') {
        const model = record(op.payload) as ModelSelection
        text(model.modelId)
        text(model.providerId)
        text(model.revision)
        await this.backend.switchModel(session, model, prepared.snapshot)
        await this.store.setModel(session.id, model)
      } else if (op.kind === 'fork' && point) {
        const nativeId = await this.backend.fork(session, op.id, point)
        const child: AgentSession = {
          ...session,
          id: `zc:${randomUUID()}`,
          nativeSessionId: nativeId,
          state: 'orphan-bound',
        }
        // Persist native child BEFORE a future Discord sibling-thread creation can fail.
        await this.store.insertSession(child, session.id)
        await this.store.transition(op.id, ['send-intent'], 'completed', {
          outcome: { hostSessionId: child.id, nativeSessionId: nativeId },
        })
      } else {
        throw fail('CAPABILITY_UNSUPPORTED', 'Control is not supported.', 'control')
      }
      await this.store.transition(op.id, ['send-intent'], 'completed')
      await this.releaseSettled(session.id)
    } catch (error) {
      const row = await this.store.operation(op.id)
      if (row && !['completed', 'failed', 'cancelled', 'rejected'].includes(row.state)) {
        const unknown = row.state === 'send-intent' || row.state === 'running'
        const definite =
          error instanceof Error &&
          'code' in error &&
          ['CONTROL_STALE', 'CONTROL_REJECTED', 'NATIVE_IDLE'].includes(String(error.code))
        await this.store.transition(
          row.id,
          [row.state],
          unknown && !definite ? 'submission-unknown' : 'rejected',
        )
        if (unknown && !definite) {
          await this.store.sessionState(session.id, 'recovery-required')
        }
      }
      this.note(error instanceof Error && 'code' in error ? String(error.code) : 'CONTROL_FAILED')
    } finally {
      // Concurrent guidance/answers must never release another operation's fence.
      if (this.controls.get(session.id) === op.id) this.controls.delete(session.id)
      if (!concurrent) {
        // A settled control unfenced the session; restart the cycle cleanly.
        this.kickDeferrals.delete(session.id)
        this.kick(session.id)
      }
    }
  }
  private async event(sessionId: string, event: NativeEvent) {
    const session = await this.store.session(sessionId)
    if (!session) {
      return
    }
    if (event.type === 'parts') {
      await this.store.view(sessionId, event.cursor, event.parts, session.controllerThreadId)
      return
    }
    if (event.type === 'diagnostic') {
      this.note(event.code)
      return
    }
    if (event.type === 'interaction') {
      const opId = this.active.get(sessionId) ?? null
      if (!opId) {
        throw fail(
          'UNEXPECTED_INTERACTION',
          'No active admission owns this native interaction.',
          'control',
          'possible',
        )
      }
      await this.store.addInteraction(event.request, opId)
      await this.store.transition(opId, ['send-intent', 'running'], 'waiting-interaction', {
        generation: event.request.generation,
      })
      return
    }
    if (event.type === 'interaction-closed') {
      await this.store.closeInteraction(event.id)
      return
    }
    if (event.type === 'guide-applied') {
      const guide = await this.store.operation(event.commandId)
      if (
        guide?.sessionId === sessionId &&
        guide.kind === 'guide' &&
        guide.generation !== null &&
        guide.generation === this.backend.generation
      ) {
        await this.store.transition(guide.id, ['send-intent', 'running'], 'completed')
      }
      return
    }
    if (event.type === 'guide-admitted') {
      return
    }
    const activeId = this.active.get(sessionId)
    if (!activeId) {
      return
    }
    const op = await this.store.operation(activeId)
    if (!op) {
      return
    }
    if (event.type === 'turn-started') {
      if (!['send-intent', 'running', 'waiting-interaction'].includes(op.state)) {
        return
      }
      if (op.nativeTurnId && op.nativeTurnId !== event.turnId) {
        throw fail(
          'UNEXPECTED_TURN',
          'Native execution changed before prior activity settled.',
          'recover',
          'possible',
        )
      }
      await this.store.transition(
        op.id,
        [op.state],
        op.state === 'waiting-interaction' ? 'waiting-interaction' : 'running',
        { turnId: event.turnId, generation: text(this.backend.generation) },
      )
      return
    }
    if (event.type === 'disconnected') {
      if (uncertain.includes(op.state as (typeof uncertain)[number])) {
        await this.store.transition(op.id, [op.state], 'submission-unknown')
        await this.store.sessionState(sessionId, 'recovery-required')
        await this.backend.disposeSession(sessionId)
      }
      return
    }
    if (event.type === 'terminal') {
      if (
        op.nativeTurnId !== event.turnId ||
        !['running', 'waiting-interaction', 'send-intent'].includes(op.state)
      ) {
        return
      }
      await this.store.transition(op.id, [op.state], 'foreground-terminal', {
        outcome: { outcome: event.outcome },
      })
      await this.reconcile(sessionId)
      return
    }
    if (event.type === 'activity' && op.state === 'foreground-terminal') {
      await this.reconcile(sessionId)
    }
  }
  async reconcile(sessionId: string) {
    const session = await this.store.session(sessionId)
    const opId = this.active.get(sessionId)
    if (!session || !opId) {
      return
    }
    const op = await this.store.operation(opId)
    if (!op || op.state !== 'foreground-terminal') {
      return
    }
    const snapshot = await this.backend.inspect(session)
    if (
      !quiescent(snapshot) ||
      snapshot.terminal?.turnId !== op.nativeTurnId ||
      this.backend.pendingInteractions.length
    ) {
      return
    }
    const committed = await this.store.finishTurn(
      sessionId,
      op.id,
      text(op.nativeTurnId),
      snapshot.terminal.outcome,
    )
    if (!committed) return // cancellation/recovery may have won while readback awaited
    this.active.delete(sessionId)
    if (committed.reusable) await this.releaseSettled(sessionId)
    if (committed.completed && !this.controls.has(sessionId)) {
      // A verified settled turn is progress: restart the kick cycle cleanly.
      this.kickDeferrals.delete(sessionId)
      this.kick(sessionId)
    }
  }
  /** Explicitly restart unsent FIFO after cancellation; never replays accepted/unknown work. */
  async resumeQueue(sessionId: string, threadId: string, actorId: string): Promise<Result<void>> {
    return attempt(async () => {
      this.assertOpen()
      const epoch = this.cancellationEpoch.get(sessionId) ?? 0
      const session = await this.store.session(sessionId)
      if (
        !session ||
        session.controllerThreadId !== threadId ||
        !(await this.authorize(actorId, threadId, session))
      ) {
        throw fail('ACTOR_UNAUTHORIZED', 'Actor cannot resume this session.')
      }
      if (
        (await this.store.operations(sessionId, { states: [...uncertain] })).some((o) =>
          uncertain.includes(o.state as (typeof uncertain)[number]),
        )
      ) {
        throw fail(
          'RECOVERY_REQUIRED',
          'Resolve uncertain operations before queue resumption.',
          'recover',
          'possible',
        )
      }
      this.assertFence(sessionId, epoch)
      const prepared = await this.prepare(session)
      this.assertFence(sessionId, epoch)
      // #29: the prepare-time snapshot is the resumption quiescence read.
      if (!quiescent(prepared.snapshot)) {
        throw fail('NATIVE_BUSY', 'Native activity has not settled.', 'control')
      }
      this.assertFence(sessionId, epoch)
      await this.store.sessionState(sessionId, 'idle')
      this.assertFence(sessionId, epoch)
      // Explicit resumption is user-confirmed progress; retry from a clean slate.
      this.kickDeferrals.delete(sessionId)
      this.kick(sessionId)
    })
  }
  async settle() {
    // Events can schedule cleanup/queue jobs while an earlier batch settles.
    for (;;) {
      await Promise.all([...this.jobs])
      const tail = this.eventTail
      await tail
      if (!this.jobs.size && tail === this.eventTail) return
    }
  }
  close(): Promise<Result<void>> {
    return (this.closing ??= this.shutdown())
  }
  private async shutdown(): Promise<Result<void>> {
    this.closed = true
    const result = await this.backend.dispose()
    await this.settle()
    for (const [sessionId, opId] of this.active) {
      const op = await this.store.operation(opId)
      if (op && uncertain.includes(op.state as (typeof uncertain)[number])) {
        await this.store.transition(opId, [op.state], 'submission-unknown')
        await this.store.sessionState(sessionId, 'recovery-required')
      }
    }
    if (result.ok) {
      for (const lease of await this.store.leases()) {
        const sessionId = text(lease.agent_session_id)
        if (
          !(await this.store.operations(sessionId, { states: [...uncertain] })).some((o) =>
            uncertain.includes(o.state as (typeof uncertain)[number]),
          )
        ) {
          await this.store.release(sessionId, this.ownerNonce)
        }
      }
    }
    return result
  }
}
