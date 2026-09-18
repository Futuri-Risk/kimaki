// ZK-007 port of the hardened standalone slice zcode-backend.ts — the native
// ZCode controller connection: single owned process, connection generations,
// single-flight V4 subscription, quiescence readback, fenced writes. Codec and
// launch profile are injected; only the synthetic codec exists until ZK-016
// certification. — ZCode 2026-09-17
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeClient } from './native/client.js'
import { type LaunchProfile, type OwnedRuntime, startOwnedRuntime } from './native/process.js'
import {
  createdSessionId,
  workspaceParams,
  assertModel,
  v4Command,
  acceptedV4,
  forkedSessionId,
  quiescent,
  type CompatibilityCodec,
} from './native/protocol.js'
import { LegacyProjector, V4Projector } from './zcode-projector.js'
import { fail, record, text, integer, unwrap, attempt, type Result, ok } from './errors.js'
import { nativeImage, type Attachment } from './attachments.js'
import type {
  AgentSession,
  NativeEvent,
  NativeInteraction,
  InteractionAnswer,
  ModelSelection,
  ForkPoint,
  NativeSnapshot,
  RpcId,
} from './types.js'
export type NativeProfile = {
  id: string
  revision: string
  enabled: boolean
  mode: string
  codec: CompatibilityCodec
  allowSynthetic: boolean
  preferences: Readonly<Record<string, boolean | string>>
  display: 'legacy' | 'v4'
  launch: (cwd: string) => LaunchProfile
  timeoutMs: number
  cancelGraceMs: number
  imageCapability: boolean
  attachmentRoot: string
  modelOverlay?: (selection: ModelSelection) => unknown
  redact: (value: string) => string
}
type Connection = {
  session: AgentSession
  client: NativeClient
  runtime: OwnedRuntime
  legacy: LegacyProjector | null
  v4: V4Projector | null
  subscriptionId: string | null
  subscribingV4?: Promise<void>
  logEpoch: string | null
  earlyFrames: unknown[]
  retired: boolean
  writes: AbortController
  retirement?: Promise<Result<void>>
  replies: Map<RpcId, (result: Result<void>) => void>
}
type PendingInteraction = {
  request: NativeInteraction
  resolve: (value: Result<unknown>) => void
}
export class ZcodeBackend {
  readonly id = 'zcode'
  private connection: Connection | undefined
  private lifecycleEpoch = 0
  private preparing:
    | {
        key: string
        sessionId: string
        promise: Promise<{ nativeSessionId: string; fingerprint: string; snapshot: NativeSnapshot }>
      }
    | undefined
  private disposing: Promise<Result<void>> | undefined
  private write(c: Connection, method: string, params: unknown) {
    if (c !== this.connection || c.retired || c.writes.signal.aborted) {
      throw fail(
        'ADMISSION_FENCED',
        'Native write belongs to a retired or cancelling connection.',
        'control',
      )
    }
    return c.client.request(method, params, { signal: c.writes.signal })
  }
  private interactions = new Map<string, PendingInteraction>()
  private listener: (sessionId: string, event: NativeEvent) => void = () => {}
  constructor(readonly profile: NativeProfile) {}
  onEvent(listener: (sessionId: string, event: NativeEvent) => void) {
    this.listener = listener
  }
  // ZK-009: independent host observer (interaction UI bridge) — the coordinator
  // owns the single onEvent slot, so the host gets its own read-only tap.
  private hostListener: (sessionId: string, event: NativeEvent) => void = () => {}
  onHostEvent(listener: (sessionId: string, event: NativeEvent) => void) {
    this.hostListener = listener
  }
  get ownedSessionId() {
    return this.connection?.session.id ?? this.preparing?.sessionId ?? null
  }
  /** Session-scoped cleanup must never dispose another binding's process. */
  disposeSession(sessionId: string): Promise<Result<void>> {
    if (this.connection?.session.id !== sessionId && this.preparing?.sessionId !== sessionId)
      return Promise.resolve(ok(undefined))
    return this.dispose()
  }
  get generation() {
    return this.connection?.client.generation ?? null
  }
  get pendingInteractions() {
    return [...this.interactions.values()].map((p) => p.request)
  }
  private emit(c: Connection, event: NativeEvent) {
    if (!c.retired) {
      // Host-side rendering must never break the coordinator's event lane.
      try {
        this.hostListener(c.session.id, event)
      } catch {
        // Host observer failures are the host's business; the lane continues.
      }
      this.listener(c.session.id, event)
    }
  }
  private current(session: AgentSession): Connection {
    const c = this.connection
    if (
      !c ||
      c.retired ||
      c.client.isClosed ||
      c.session.id !== session.id ||
      c.session.nativeSessionId !== session.nativeSessionId
    ) {
      throw fail(
        'CONNECTION_UNAVAILABLE',
        'Native session is not attached to the current connection.',
        'recover',
        'possible',
      )
    }
    return c
  }
  async prepare(
    session: AgentSession,
    afterSequence = -1,
  ): Promise<{
    nativeSessionId: string
    fingerprint: string
    snapshot: NativeSnapshot
  }> {
    if (this.disposing) throw fail('ADMISSION_FENCED', 'Native disposal is in progress.', 'control')
    const key = JSON.stringify([
      session.id,
      session.nativeSessionId,
      session.workspace,
      session.profileId,
      session.profileRevision,
      session.model,
    ])
    if (this.preparing) {
      if (this.preparing.key !== key)
        throw fail('PROCESS_LIMIT', 'Another native session is being prepared.')
      return this.preparing.promise
    }
    const epoch = this.lifecycleEpoch
    const promise = this.prepareConnection(session, afterSequence, epoch)
      .catch(async (error) => {
        const c = this.connection
        if (c && c.session.id === session.id) await this.retire(c)
        throw error
      })
      .finally(() => {
        if (this.preparing?.promise === promise) this.preparing = undefined
      })
    this.preparing = { key, sessionId: session.id, promise }
    return promise
  }
  private async prepareConnection(
    session: AgentSession,
    afterSequence: number,
    epoch: number,
  ): Promise<{ nativeSessionId: string; fingerprint: string; snapshot: NativeSnapshot }> {
    const live = () => {
      if (epoch !== this.lifecycleEpoch)
        throw fail('ADMISSION_FENCED', 'Native startup was cancelled.', 'control')
    }
    const p = this.profile
    // Client validation must precede process ownership acquisition: a constructor
    // failure after spawn otherwise leaves no Connection for prepare's cleanup.
    if (
      !Number.isSafeInteger(p.timeoutMs) ||
      p.timeoutMs < 1 ||
      p.timeoutMs > 2147483647 ||
      !Number.isSafeInteger(p.cancelGraceMs) ||
      p.cancelGraceMs < 0 ||
      p.cancelGraceMs > 30000
    ) {
      throw fail(
        'CONFIG_INVALID',
        'Native deadlines must be finite integers; cancellation grace is bounded to 30 seconds.',
      )
    }
    if (!p.enabled || (p.codec.evidence !== 'native-certified' && !p.allowSynthetic)) {
      throw fail('RUNTIME_UNCERTIFIED', 'Native profile has not passed certification.')
    }
    if (session.profileId !== p.id || session.profileRevision !== p.revision) {
      throw fail(
        'PROFILE_MISMATCH',
        'Native profile revision changed; explicit reconciliation is required.',
      )
    }
    live()
    if (this.connection?.retired)
      throw fail(
        'CANCEL_UNCONFIRMED',
        'An earlier native process still needs ownership reconciliation.',
        'recover',
        'possible',
      )
    if (this.connection && !this.connection.retired) {
      if (this.connection.session.id === session.id && !this.connection.client.isClosed) {
        const snapshot = await this.inspect(session)
        live()
        return {
          nativeSessionId: text(session.nativeSessionId),
          fingerprint: p.launch(session.workspace.canonicalDirectory).entrySha256,
          snapshot,
        }
      }
      const old = this.connection
      if (!old.client.isClosed && !quiescent(await this.inspect(old.session))) {
        throw fail('PROCESS_LIMIT', 'The conservative native process cap is one.')
      }
      unwrap(await this.retire(old))
      live()
    }
    const launch = p.launch(session.workspace.canonicalDirectory)
    const runtime = unwrap(await startOwnedRuntime({ ...launch, diagnosticRedactor: p.redact }))
    let c: Connection
    const client = new NativeClient({
      input: runtime.input,
      output: runtime.output,
      timeoutMs: p.timeoutMs,
      onNotification: (method, params) => this.notification(c, method, params),
      onRequest: (id, method, params, signal) => this.reverse(c, id, method, params, signal),
      onResponseWritten: (id, result) => {
        const receipt = c?.replies.get(id)
        if (receipt) {
          c.replies.delete(id)
          receipt(result)
        }
      },
      onDisconnect: () => {
        if (c) {
          for (const receipt of c.replies.values())
            receipt({
              ok: false,
              error: fail(
                'ANSWER_DELIVERY_UNKNOWN',
                'Native response delivery is uncertain.',
                'control',
                'possible',
              ),
            })
          c.replies.clear()
          this.emit(c, { type: 'disconnected' })
        }
      },
    })
    c = {
      session: { ...session },
      client,
      runtime,
      legacy: null,
      v4: null,
      subscriptionId: null,
      logEpoch: null,
      earlyFrames: [],
      retired: false,
      writes: new AbortController(),
      replies: new Map(),
    }
    this.connection = c
    runtime.onExit(() => client.disconnect())
    live()
    const workspace = workspaceParams(
      session.workspace.nativeWorkspacePath,
      session.workspace.nativeWorkspaceKey,
    )
    if (session.nativeSessionId) {
      const resumed = unwrap(
        await this.write(c, 'session/resume', { sessionId: session.nativeSessionId, workspace }),
      )
      if (createdSessionId(resumed) !== session.nativeSessionId) {
        throw fail(
          'RESUME_FAILED',
          'Native resume returned a different conversation.',
          'recover',
          'possible',
        )
      }
    } else {
      if (session.state !== 'creating-intent') {
        throw fail('CREATE_NOT_ADMITTED', 'Native session creation requires persisted intent.')
      }
      c.session.nativeSessionId = createdSessionId(
        unwrap(await this.write(c, 'session/create', { workspace, mode: p.mode })),
      )
    }
    c.legacy = new LegacyProjector(
      text(c.session.nativeSessionId),
      client.generation,
      p.redact,
      afterSequence,
    )
    const snapshot = await this.inspect(c.session)
    assertModel(snapshot.model, session.model)
    const subscription = record(
      unwrap(
        await client.request('session/subscribe', {
          sessionId: c.session.nativeSessionId,
          deliveryKind: 'desktop-continuous',
          includeSnapshot: true,
          afterSeq: Math.max(0, afterSequence),
        }),
      ),
    )
    if (typeof subscription.eventSeq === 'number' && subscription.eventSeq < afterSequence) {
      throw fail(
        'CURSOR_RESET',
        'Native replay cursor reset; explicit reconciliation is required.',
        'recover',
        'possible',
      )
    }
    if (p.display === 'v4') await this.ensureV4Subscription(c)
    live()
    return {
      nativeSessionId: text(c.session.nativeSessionId),
      fingerprint: launch.entrySha256,
      snapshot,
    }
  }
  /** Conversation control needs the native publisher even when legacy owns display. */
  private ensureV4Subscription(c: Connection): Promise<void> {
    if (c.retired || c !== this.connection || c.writes.signal.aborted) {
      return Promise.reject(
        fail('ADMISSION_FENCED', 'V4 subscription belongs to a cancelling connection.', 'control'),
      )
    }
    if (c.subscriptionId) return Promise.resolve()
    if (c.subscribingV4) return c.subscribingV4
    const promise = (async () => {
      const result = record(
        unwrap(
          await this.write(c, 'v4/conversation/subscribe', {
            topic: `conversation/${c.session.nativeSessionId}`,
            connectionId: c.client.generation,
            clientMode: 'desktop-continuous',
          }),
        ),
      )
      if (c.retired || c !== this.connection || c.writes.signal.aborted) {
        throw fail('ADMISSION_FENCED', 'V4 subscription completed after cancellation.', 'control')
      }
      const ack = record(result.ack)
      c.subscriptionId = text(ack.subscriptionId)
      c.logEpoch = text(ack.logEpoch)
      if (this.profile.display === 'v4') {
        c.v4 = new V4Projector(
          text(c.session.nativeSessionId),
          c.client.generation,
          c.subscriptionId,
          c.logEpoch,
        )
        for (const frame of c.earlyFrames.splice(0)) this.v4(c, frame)
      }
    })().finally(() => {
      if (c.subscribingV4 === promise) delete c.subscribingV4
    })
    c.subscribingV4 = promise
    return promise
  }
  async inspect(session: AgentSession): Promise<NativeSnapshot> {
    const c = this.current(session)
    const state = this.profile.codec.snapshot(
      unwrap(await c.client.request('session/read', { sessionId: session.nativeSessionId })),
      text(session.nativeSessionId),
    )
    if (
      state.sessionId !== session.nativeSessionId ||
      state.workspacePath !== session.workspace.nativeWorkspacePath ||
      state.workspaceKey !== session.workspace.nativeWorkspaceKey
    ) {
      throw fail(
        'WORKSPACE_MISMATCH',
        'Native session workspace readback differs.',
        'recover',
        'possible',
      )
    }
    return state
  }
  async submit(session: AgentSession, input: string, attachments: readonly Attachment[] = []) {
    const c = this.current(session)
    const state = await this.inspect(session)
    if (!quiescent(state)) {
      throw fail(
        'NATIVE_BUSY',
        'Native foreground, background or goal continuation is active.',
        'control',
      )
    }
    assertModel(state.model, session.model)
    const images = []
    for (const attachment of attachments)
      images.push(
        await nativeImage(attachment, this.profile.attachmentRoot, this.profile.imageCapability),
      )
    const overlay = this.profile.modelOverlay?.(session.model)
    const result = record(
      unwrap(
        await this.write(c, 'session/send', {
          sessionId: session.nativeSessionId,
          content: input,
          ...(overlay ? { runtimeModel: overlay } : {}),
          ...(images.length ? { attachments: images } : {}),
        }),
      ),
    )
    if (result.accepted !== true) {
      throw fail(
        'SUBMISSION_UNKNOWN',
        'Native submission acceptance was not confirmed.',
        'submit',
        'possible',
      )
    }
  }
  async guide(session: AgentSession, operationId: string, input: string) {
    const c = this.current(session)
    await this.ensureV4Subscription(c)
    if (!(await this.inspect(session)).foreground) {
      throw fail('NATIVE_IDLE', 'Guidance requires an active native foreground.', 'control')
    }
    acceptedV4(
      unwrap(
        await this.write(
          c,
          'v4/command',
          v4Command({
            clientId: 'kimaki-zcode',
            sessionId: text(session.nativeSessionId),
            operationId,
            connectionId: c.client.generation,
            type: 'sendText',
            text: input,
          }),
        ),
      ),
    )
    // ACK delivery=queue is deliberately not used to infer failed steering.
  }
  async compact(session: AgentSession) {
    const c = this.current(session)
    if (!quiescent(await this.inspect(session))) {
      throw fail('NATIVE_BUSY', 'Compaction requires native quiescence.', 'control')
    }
    unwrap(await this.write(c, 'session/compact', { sessionId: session.nativeSessionId }))
    return this.inspect(session)
  }
  async switchModel(session: AgentSession, selection: ModelSelection) {
    const c = this.current(session)
    if (!quiescent(await this.inspect(session))) {
      throw fail('NATIVE_BUSY', 'Model changes require native quiescence.', 'control')
    }
    const overlay = this.profile.modelOverlay?.(selection)
    unwrap(
      await this.write(c, 'session/setModel', {
        sessionId: session.nativeSessionId,
        model: { providerId: selection.providerId, modelId: selection.modelId },
        persistAsWorkspaceLastUsed: false,
        ...(overlay ? { runtimeModel: overlay } : {}),
      }),
    )
    if (selection.reasoning) {
      unwrap(
        await this.write(c, 'session/setThoughtLevel', {
          sessionId: session.nativeSessionId,
          thoughtLevel: selection.reasoning,
        }),
      )
    }
    const snapshot = await this.inspect(session)
    assertModel(snapshot.model, selection)
    c.session.model = selection
    return snapshot.model
  }
  async fork(session: AgentSession, operationId: string, point: ForkPoint) {
    const c = this.current(session)
    await this.ensureV4Subscription(c)
    if (point.logEpoch !== c.logEpoch)
      throw fail('FORK_POINT_STALE', 'Fork target belongs to another native log epoch.', 'control')
    if (!quiescent(await this.inspect(session))) {
      throw fail(
        'NATIVE_BUSY',
        'This implementation serializes conversation forks at quiescence.',
        'control',
      )
    }
    // No legacy session/fork or filesystem checkpoint fallback under any circumstances.
    return forkedSessionId(
      unwrap(
        await this.write(
          c,
          'v4/command',
          v4Command({
            clientId: 'kimaki-zcode',
            sessionId: text(session.nativeSessionId),
            operationId,
            connectionId: c.client.generation,
            type: 'forkAssistant',
            point,
          }),
        ),
      ),
    )
  }
  async forkPoint(session: AgentSession): Promise<ForkPoint> {
    const c = this.current(session)
    await this.ensureV4Subscription(c)
    // Initial implementation supports a certified current window only; never guess an older row.
    const result = record(
      unwrap(
        await c.client.request('v4/conversation/rowsRange', {
          sessionId: session.nativeSessionId,
          topic: `conversation/${session.nativeSessionId}`,
          limit: 200,
        }),
      ),
    )
    const point = this.profile.codec.forkPoint(result)
    if (point.logEpoch !== c.logEpoch)
      throw fail(
        'FORK_POINT_STALE',
        'Fork-point readback differs from the subscribed native log epoch.',
        'control',
      )
    return point
  }
  async answer(request: NativeInteraction, answer: InteractionAnswer) {
    const c = this.connection
    const pending = this.interactions.get(request.id)
    if (
      !c ||
      c.retired ||
      c.writes.signal.aborted ||
      !pending ||
      c.client.generation !== request.generation ||
      pending.request.requestId !== request.requestId ||
      Date.now() >= request.expiresAt
    ) {
      throw fail('INTERACTION_STALE', 'Native interaction is not current.', 'control')
    }
    const encoded = this.profile.codec.answer(request.kind, request.schema, answer)
    // Only resolve host control completion after the exact reverse reply has been written.
    const receipt = new Promise<Result<void>>((resolve) =>
      c.replies.set(request.requestId, resolve),
    )
    this.interactions.delete(request.id)
    pending.resolve(ok(encoded))
    unwrap(await receipt)
  }
  async cancel(session: AgentSession, operationId: string): Promise<Result<void>> {
    if (this.preparing?.sessionId === session.id) return this.dispose()
    const c = this.connection
    if (!c || c.session.id !== session.id) {
      return {
        ok: false,
        error: fail('CANCEL_UNCONFIRMED', 'No owned connection to cancel.', 'control', 'possible'),
      }
    }
    c.writes.abort()
    for (const pending of this.interactions.values())
      pending.resolve({
        ok: false,
        error: fail('CANCELLED', 'Native interaction was cancelled.', 'control'),
      })
    this.interactions.clear()
    if (!c.client.isClosed) {
      try {
        const before = await this.inspect(session)
        await c.client.request(
          'v4/command',
          v4Command({
            clientId: 'kimaki-zcode',
            sessionId: text(session.nativeSessionId),
            operationId,
            connectionId: c.client.generation,
            type: 'stop',
          }),
          { timeoutMs: this.profile.cancelGraceMs },
        )
        for (const taskId of before.background)
          await c.client.request(
            'session/cancelBackgroundTask',
            { sessionId: session.nativeSessionId, taskId },
            { timeoutMs: this.profile.cancelGraceMs },
          )
        const end = Date.now() + this.profile.cancelGraceMs
        do {
          if (quiescent(await this.inspect(session))) {
            break
          }
          await delay(20)
        } while (Date.now() < end)
      } catch {
        /* A lost ACK cannot confirm stop; escalate only the owned runtime. */
      }
    }
    // Even a confirmed native stop retires the connection, invalidating every
    // previously queued write and reverse-request generation before lease release.
    return this.retire(c)
  }
  dispose(): Promise<Result<void>> {
    if (this.disposing) return this.disposing
    this.lifecycleEpoch++
    this.connection?.writes.abort()
    const preparing = this.preparing?.promise
    const promise = (async () => {
      if (preparing) await preparing.catch(() => undefined)
      const c = this.connection
      return c ? this.retire(c) : ok(undefined)
    })().finally(() => {
      if (this.disposing === promise) this.disposing = undefined
    })
    this.disposing = promise
    return promise
  }
  private retire(c: Connection): Promise<Result<void>> {
    return (c.retirement ??= this.retireConnection(c))
  }
  private async retireConnection(c: Connection): Promise<Result<void>> {
    c.retired = true
    c.writes.abort()
    for (const pending of this.interactions.values())
      pending.resolve({
        ok: false,
        error: fail('INTERACTION_STALE', 'Native connection was retired.', 'control'),
      })
    this.interactions.clear()
    if (c.subscriptionId && !c.client.isClosed) {
      await c.client.request(
        'v4/conversation/unsubscribe',
        {
          topic: `conversation/${c.session.nativeSessionId}`,
          connectionId: c.client.generation,
          subscriptionId: c.subscriptionId,
        },
        { timeoutMs: Math.min(this.profile.timeoutMs, 1000) },
      )
    }
    const result = await c.runtime.stop()
    c.client.dispose()
    // Do not drop ownership of an unconfirmed process or clear a replacement.
    if (result.ok && this.connection === c) this.connection = undefined
    return result
  }
  private notification(c: Connection, method: string, value: unknown) {
    if (!c || c.retired) {
      return
    }
    if (method === 'v4/conversation/frame') {
      if (this.profile.display !== 'v4') {
        return
      }
      if (!c.v4) {
        if (c.earlyFrames.length >= 4) {
          throw fail('VIEW_LIMIT', 'Too many early native frames.', 'control')
        }
        c.earlyFrames.push(value)
        return
      }
      this.v4(c, value)
      return
    }
    if (method === 'state.updated') {
      const notification = record(value)
      if (notification.sessionId !== c.session.nativeSessionId)
        throw fail(
          'FOREIGN_EVENT',
          'Native state notification belongs to another session.',
          'control',
        )
      // This source-observed top-level notification has no legacy replay seq.
      // Re-read authoritative state; never fabricate seq=0 or apply patch as completion.
      this.emit(c, { type: 'activity' })
      return
    }
    if (method !== 'session/event') {
      return
    }
    const e = record(value)
    if (e.sessionId !== c.session.nativeSessionId) {
      throw fail('FOREIGN_EVENT', 'Native event belongs to another session.', 'control')
    }
    if (!c.legacy) {
      throw fail(
        'EARLY_EVENT',
        'Native event arrived before its session identity was established.',
        'control',
      )
    }
    const projected = c.legacy.apply(value)
    if (!projected) {
      return
    }
    this.emit(c, {
      type: 'parts',
      parts:
        this.profile.display === 'legacy'
          ? projected.parts.map((part) => ({ ...part, id: `${c.session.id}:${part.id}` }))
          : [],
      cursor: projected.cursor,
    })
    if (e.deliveryKind === 'snapshot') {
      return
    }
    const p = record(e.payload)
    if (e.type === 'turn.started') {
      this.emit(c, { type: 'turn-started', turnId: text(e.turnId, 'native turn ID') })
    } else if (e.type === 'turn.completed' || e.type === 'turn.failed') {
      this.emit(c, {
        type: 'terminal',
        turnId: text(e.turnId, 'native turn ID'),
        outcome: e.type === 'turn.completed' ? 'completed' : 'failed',
      })
    } else if (e.type === 'turn.steerQueued' || e.type === 'turn.steerDrained') {
      // Correlation must be present, not inferred from an ACK or similar prompt text.
      if (typeof p.commandId === 'string') {
        this.emit(c, {
          type: e.type === 'turn.steerQueued' ? 'guide-admitted' : 'guide-applied',
          commandId: p.commandId,
        })
      } else {
        this.emit(c, { type: 'diagnostic', code: 'GUIDE_CORRELATION_UNCERTIFIED' })
      }
    } else if (
      e.type === 'state.updated' ||
      e.type === 'background.updated' ||
      e.type === 'session.updated'
    ) {
      this.emit(c, { type: 'activity' })
    }
  }
  private v4(c: Connection, value: unknown) {
    const result = c.v4?.apply(value)
    if (result) {
      this.emit(c, {
        type: 'parts',
        parts: result.parts.map((part) => ({
          ...part,
          id: `${c.session.id}:${part.id}`,
          text: this.profile.redact(part.text),
          ...(part.toolName === undefined ? {} : { toolName: this.profile.redact(part.toolName) }),
        })),
        cursor: result.cursor,
      })
    }
  }
  private async reverse(
    c: Connection,
    id: RpcId,
    method: string,
    value: unknown,
    signal: AbortSignal,
  ): Promise<Result<unknown>> {
    return attempt(
      async () => {
        if (method === 'session/requestRuntimePreferences') {
          return this.profile.preferences
        }
        const params = record(value)
        if (!c.session.nativeSessionId || params.sessionId !== c.session.nativeSessionId) {
          throw fail(
            'FOREIGN_INTERACTION',
            'Native interaction is not bound to this session.',
            'control',
          )
        }
        const decoded = this.profile.codec.interaction(method, params)
        const request: NativeInteraction = {
          id: randomUUID(),
          sessionId: c.session.id,
          generation: c.client.generation,
          requestId: id,
          kind: decoded.kind,
          schema: decoded.schema,
          expiresAt: Date.now() + this.profile.timeoutMs,
          threadId: c.session.controllerThreadId,
        }
        return await new Promise<unknown>((resolve, reject) => {
          const abort = () => {
            this.interactions.delete(request.id)
            this.emit(c, { type: 'interaction-closed', id: request.id })
            reject(fail('INPUT_TIMEOUT', 'Native interaction expired.', 'control'))
          }
          const finish = (result: Result<unknown>) => {
            signal.removeEventListener('abort', abort)
            this.interactions.delete(request.id)
            this.emit(c, { type: 'interaction-closed', id: request.id })
            if (result.ok) {
              resolve(result.value)
            } else {
              reject(result.error)
            }
          }
          this.interactions.set(request.id, { request, resolve: finish })
          signal.addEventListener('abort', abort, { once: true })
          this.emit(c, { type: 'interaction', request })
          if (signal.aborted) {
            abort()
          }
        })
      },
      'INTERACTION_FAILED',
      'control',
    )
  }
}
