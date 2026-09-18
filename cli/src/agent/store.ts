// Durable agent sidecar store — ZK-004 port of the hardened standalone slice store.ts.
// Schema creation/migration ownership moved to the host: Drizzle-generated schema.sql +
// agent/schema-gate.ts version/integrity gate in db.ts. All admission/CAS/lease/outbox
// invariants are preserved verbatim. — ZAI 2026-09-17
import { randomUUID, createHash } from 'node:crypto'
import { fail, text, integer, record, safeJson } from './errors.js'
import { transaction, type SqlClient, type SqlTransaction, type SqlRow } from './sql.js'
import type {
  AgentSession,
  Input,
  Operation,
  OperationState,
  DisplayPart,
  Cursor,
  NativeInteraction,
  ModelSelection,
} from './types.js'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const q = (sql: string, ...args: (string | number | null)[]) => ({ sql, args })
function parseModel(value: unknown): ModelSelection {
  const model = record(value)
  return {
    providerId: text(model.providerId),
    modelId: text(model.modelId),
    revision: text(model.revision),
    ...(model.reasoning === undefined ? {} : { reasoning: text(model.reasoning) }),
  }
}
function parseOperation(r: SqlRow): Operation {
  if (
    ![
      'queued',
      'preparing',
      'send-intent',
      'submission-unknown',
      'running',
      'waiting-interaction',
      'foreground-terminal',
      'completed',
      'failed',
      'cancelled',
      'rejected',
      'cancel-unconfirmed',
    ].includes(String(r.state))
  ) {
    throw fail('STATE_CORRUPT', 'Unknown operation state requires recovery.', 'recover', 'possible')
  }
  const saved = record(JSON.parse(text(r.payload_json)))
  return {
    model: parseModel(saved.model),
    id: text(r.id),
    sessionId: text(r.agent_session_id),
    threadId: text(r.controller_thread_id),
    actorId: text(r.authorized_actor_id),
    source: text(r.source_type) as Input['source'],
    sourceId: text(r.source_id),
    kind: text(r.operation_kind) as Input['kind'],
    state: text(r.state) as OperationState,
    text: typeof saved.text === 'string' ? saved.text : '',
    payload: saved.payload,
    originalHash: text(r.original_hash),
    normalizedHash: text(r.normalized_hash),
    order: integer(r.queue_order),
    nativeTurnId: typeof r.native_turn_id === 'string' ? r.native_turn_id : null,
    generation: typeof r.connection_generation === 'string' ? r.connection_generation : null,
  }
}
function parseSession(r: SqlRow): AgentSession {
  return {
    id: text(r.id),
    backend: text(r.backend_type) as AgentSession['backend'],
    nativeSessionId: typeof r.native_session_id === 'string' ? r.native_session_id : null,
    profileId: text(r.profile_id),
    profileRevision: text(r.profile_revision),
    controllerThreadId: text(r.controller_thread_id),
    state: text(r.state),
    model: parseModel(JSON.parse(text(r.model_json))),
    workspace: {
      projectDirectory: text(r.project_directory),
      canonicalDirectory: text(r.canonical_directory),
      nativeWorkspacePath: text(r.native_workspace_path),
      nativeWorkspaceKey: text(r.native_workspace_key),
      ownerMachineId: text(r.owner_machine_id),
      nativeHomeIdentity: text(r.native_home_identity),
    },
  }
}
export class AgentStore {
  constructor(
    readonly db: SqlClient,
    readonly ownerMachineId: string,
    private readonly secretValues: readonly string[] = [],
  ) {}
  private protect(value: unknown) {
    const s = safeJson(value)
    if (
      this.secretValues.some(
        (secret) =>
          secret.length > 0 &&
          (s.includes(secret) || s.includes(JSON.stringify(secret).slice(1, -1))),
      )
    ) {
      throw fail('SECRET_IN_STATE', 'A selected credential must not be persisted in backend state.')
    }
    return s
  }
  async insertSession(session: AgentSession, parent: string | null = null) {
    if (
      session.backend !== 'zcode' ||
      !session.id.startsWith('zc:') ||
      session.workspace.ownerMachineId !== this.ownerMachineId
    ) {
      throw fail('OWNER_MISMATCH', 'Invalid native session ownership.')
    }
    const w = session.workspace
    const now = Date.now()
    await this.db.execute(
      q(
        `INSERT INTO agent_sessions (id,backend_type,native_session_id,native_home_identity,owner_machine_id,project_directory,canonical_directory,native_workspace_path,native_workspace_key,profile_id,profile_revision,controller_thread_id,state,model_json,parent_agent_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        session.id,
        session.backend,
        session.nativeSessionId,
        w.nativeHomeIdentity,
        w.ownerMachineId,
        w.projectDirectory,
        w.canonicalDirectory,
        w.nativeWorkspacePath,
        w.nativeWorkspaceKey,
        session.profileId,
        session.profileRevision,
        session.controllerThreadId,
        session.state,
        this.protect(session.model),
        parent,
        now,
        now,
      ),
    )
  }
  async session(id: string): Promise<AgentSession | null> {
    const r = (await this.db.execute(q('SELECT * FROM agent_sessions WHERE id=?', id))).rows[0]
    if (!r) {
      if (id.startsWith('zc:')) {
        throw fail(
          'SESSION_SIDECAR_MISSING',
          'Reserved ZCode session has no binding; OpenCode fallback is prohibited.',
          'recover',
        )
      }
      return null
    }
    const s = parseSession(r)
    if (s.workspace.ownerMachineId !== this.ownerMachineId) {
      throw fail('OWNER_MISMATCH', 'Native session belongs to another machine.', 'recover')
    }
    return s
  }
  async sessionState(id: string, state: string) {
    await this.db.execute(
      q('UPDATE agent_sessions SET state=?,updated_at=? WHERE id=?', state, Date.now(), id),
    )
  }
  async bindNative(id: string, nativeId: string, fingerprint: string) {
    const r = await this.db.execute(
      q(
        "UPDATE agent_sessions SET native_session_id=?,runtime_fingerprint=?,state='idle',updated_at=? WHERE id=? AND native_session_id IS NULL AND state='creating-intent'",
        text(nativeId),
        fingerprint,
        Date.now(),
        id,
      ),
    )
    if (r.rowsAffected !== 1) {
      throw fail(
        'SESSION_BIND_CONFLICT',
        'Native binding was not committed.',
        'recover',
        'possible',
      )
    }
  }
  async setModel(id: string, model: ModelSelection) {
    await this.db.execute(
      q(
        'UPDATE agent_sessions SET model_json=?,updated_at=? WHERE id=?',
        this.protect(model),
        Date.now(),
        id,
      ),
    )
  }
  async setDefault(
    scope: 'global' | 'channel',
    scopeId: string,
    backend: 'opencode' | 'zcode',
    profileId: string | null,
  ) {
    await this.db.execute(
      q(
        `INSERT INTO agent_backend_defaults(scope_type,scope_id,backend_type,profile_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(scope_type,scope_id) DO UPDATE SET backend_type=excluded.backend_type,profile_id=excluded.profile_id,updated_at=excluded.updated_at`,
        scope,
        scopeId,
        backend,
        profileId,
        Date.now(),
      ),
    )
  }
  async freezeIntent(threadId: string, channelId: string, globalScopeId: string) {
    return transaction(this.db, async (tx) => {
      const existing = (
        await tx.execute(q('SELECT * FROM agent_thread_intents WHERE thread_id=?', threadId))
      ).rows[0]
      if (existing) {
        return existing
      }
      const r = (
        await tx.execute(
          q(
            `SELECT * FROM agent_backend_defaults WHERE (scope_type='channel' AND scope_id=?) OR (scope_type='global' AND scope_id=?) ORDER BY CASE scope_type WHEN 'channel' THEN 0 ELSE 1 END LIMIT 1`,
            channelId,
            globalScopeId,
          ),
        )
      ).rows[0]
      const backend = r ? text(r.backend_type) : 'opencode'
      const profile = r && typeof r.profile_id === 'string' ? r.profile_id : null
      const now = Date.now()
      await tx.execute(
        q(
          `INSERT INTO agent_thread_intents(thread_id,backend_type,profile_id,owner_machine_id,state,created_at,updated_at) VALUES(?,?,?,?,'workspace-pending',?,?)`,
          threadId,
          backend,
          profile,
          this.ownerMachineId,
          now,
          now,
        ),
      )
      return (await tx.execute(q('SELECT * FROM agent_thread_intents WHERE thread_id=?', threadId)))
        .rows[0]!
    })
  }
  async admit(input: Input): Promise<{
    operation: Operation
    created: boolean
  }> {
    const admittedContent = this.protect({ text: input.text, payload: input.payload ?? null })
    const now = Date.now()
    return transaction(this.db, async (tx) => {
      const row = (await tx.execute(q('SELECT * FROM agent_sessions WHERE id=?', input.sessionId)))
        .rows[0]
      if (
        !row ||
        row.owner_machine_id !== this.ownerMachineId ||
        row.controller_thread_id !== input.threadId
      ) {
        throw fail('ACTOR_UNAUTHORIZED', 'This thread does not control the native session.')
      }
      const old = (
        await tx.execute(
          q(
            'SELECT * FROM agent_operations WHERE agent_session_id=? AND source_type=? AND source_id=? AND operation_kind=?',
            input.sessionId,
            input.source,
            input.sourceId,
            input.kind,
          ),
        )
      ).rows[0]
      if (old) {
        const oldPayload = record(JSON.parse(text(old.payload_json)))
        if (
          this.protect({ text: oldPayload.text, payload: oldPayload.payload }) !==
            admittedContent ||
          old.authorized_actor_id !== input.actorId
        ) {
          throw fail('ADMISSION_CONFLICT', 'An admitted source cannot change its actor or content.')
        }
        return { operation: parseOperation(old), created: false }
      }
      const pending = Number(
        (
          await tx.execute(
            q(
              "SELECT COUNT(*) AS n FROM agent_operations WHERE agent_session_id=? AND state NOT IN ('completed','failed','cancelled','rejected')",
              input.sessionId,
            ),
          )
        ).rows[0]?.n,
      )
      if (input.kind === 'prompt' && pending >= 256) {
        throw fail('QUEUE_LIMIT', 'Native admission queue is full; no task was submitted.')
      }
      const pendingControls = Number(
        (
          await tx.execute(
            q(
              "SELECT COUNT(*) AS n FROM agent_operations WHERE agent_session_id=? AND operation_kind<>'prompt' AND state NOT IN ('completed','failed','cancelled','rejected')",
              input.sessionId,
            ),
          )
        ).rows[0]?.n,
      )
      if (input.kind !== 'prompt' && input.kind !== 'cancel' && pendingControls >= 64) {
        throw fail('CONTROL_LIMIT', 'Pending native controls must settle first.')
      }
      if (
        input.kind === 'cancel' &&
        (
          await tx.execute(
            q(
              "SELECT id FROM agent_operations WHERE agent_session_id=? AND operation_kind='cancel' AND state IN ('queued','preparing','send-intent','running') LIMIT 1",
              input.sessionId,
            ),
          )
        ).rows.length
      ) {
        throw fail('CANCEL_IN_PROGRESS', 'A native cancellation is already in progress.')
      }
      const stored = this.protect({
        text: input.text,
        payload: input.payload ?? null,
        model: parseModel(JSON.parse(text(row.model_json))),
      })
      const order = Number(
        (
          await tx.execute(
            q(
              'SELECT COALESCE(MAX(queue_order),0)+1 AS n FROM agent_operations WHERE agent_session_id=?',
              input.sessionId,
            ),
          )
        ).rows[0]?.n,
      )
      const id = randomUUID()
      await tx.execute(
        q(
          `INSERT INTO agent_operations(id,agent_session_id,source_type,source_id,operation_kind,controller_thread_id,authorized_actor_id,payload_json,original_hash,normalized_hash,state,queue_order,profile_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?)`,
          id,
          input.sessionId,
          input.source,
          input.sourceId,
          input.kind,
          input.threadId,
          input.actorId,
          stored,
          hash(input.originalText ?? input.text),
          hash(input.text),
          order,
          typeof row.profile_revision === 'string' ? row.profile_revision : null,
          now,
          now,
        ),
      )
      return {
        operation: parseOperation(
          (await tx.execute(q('SELECT * FROM agent_operations WHERE id=?', id))).rows[0]!,
        ),
        created: true,
      }
    })
  }
  async operation(id: string) {
    const r = (await this.db.execute(q('SELECT * FROM agent_operations WHERE id=?', id))).rows[0]
    return r ? parseOperation(r) : null
  }
  async operations(sessionId: string) {
    return (
      await this.db.execute(
        q(
          'SELECT * FROM agent_operations WHERE agent_session_id=? ORDER BY queue_order',
          sessionId,
        ),
      )
    ).rows.map(parseOperation)
  }
  async transition(
    id: string,
    expected: readonly OperationState[],
    next: OperationState,
    detail: {
      turnId?: string
      generation?: string
      outcome?: unknown
    } = {},
  ): Promise<boolean> {
    if (!expected.length) {
      return false
    }
    const now = Date.now()
    const placeholders = expected.map(() => '?').join(',')
    const r = await this.db.execute(
      q(
        `UPDATE agent_operations SET state=?,updated_at=?,native_turn_id=COALESCE(?,native_turn_id),connection_generation=COALESCE(?,connection_generation),outcome_json=COALESCE(?,outcome_json),send_intent_at=CASE WHEN ?='send-intent' THEN ? ELSE send_intent_at END,terminal_at=CASE WHEN ? IN ('completed','failed','cancelled','rejected') THEN ? ELSE terminal_at END WHERE id=? AND state IN (${placeholders})`,
        next,
        now,
        detail.turnId ?? null,
        detail.generation ?? null,
        detail.outcome === undefined ? null : this.protect(detail.outcome),
        next,
        now,
        next,
        now,
        id,
        ...expected,
      ),
    )
    return r.rowsAffected === 1
  }
  async acquire(session: AgentSession, ownerNonce: string) {
    await transaction(this.db, async (tx) => {
      for (const resource of [
        `workspace:${session.workspace.canonicalDirectory}`,
        `home:${session.workspace.nativeHomeIdentity}`,
      ]) {
        const row = (
          await tx.execute(q('SELECT * FROM agent_workspace_leases WHERE resource=?', resource))
        ).rows[0]
        if (row && (row.owner_nonce !== ownerNonce || row.agent_session_id !== session.id)) {
          throw fail(
            'WORKSPACE_BUSY',
            'A managed native writer or recovery fence owns this resource.',
          )
        }
        if (!row) {
          await tx.execute(
            q(
              'INSERT INTO agent_workspace_leases(resource,agent_session_id,owner_nonce,acquired_at) VALUES(?,?,?,?)',
              resource,
              session.id,
              ownerNonce,
              Date.now(),
            ),
          )
        }
      }
    })
  }
  async release(sessionId: string, ownerNonce: string) {
    await this.db.execute(
      q(
        'DELETE FROM agent_workspace_leases WHERE agent_session_id=? AND owner_nonce=?',
        sessionId,
        ownerNonce,
      ),
    )
  }
  async releaseWorkspace(sessionId: string, ownerNonce: string) {
    // A quiescent turn may release the worktree, but the native home is
    // still owned by its resident app-server until confirmed retirement.
    await this.db.execute(
      q(
        "DELETE FROM agent_workspace_leases WHERE agent_session_id=? AND owner_nonce=? AND resource GLOB 'workspace:*'",
        sessionId,
        ownerNonce,
      ),
    )
  }
  async finishTurn(
    sessionId: string,
    operationId: string,
    turnId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
  ) {
    return transaction(this.db, async (tx) => {
      const session = (
        await tx.execute(q('SELECT state FROM agent_sessions WHERE id=?', sessionId))
      ).rows[0]
      const op = (
        await tx.execute(
          q(
            'SELECT state,native_turn_id FROM agent_operations WHERE id=? AND agent_session_id=?',
            operationId,
            sessionId,
          ),
        )
      ).rows[0]
      if (
        !session ||
        session.state === 'paused' ||
        !op ||
        op.state !== 'foreground-terminal' ||
        op.native_turn_id !== turnId
      )
        return null
      const now = Date.now()
      const guides = (
        await tx.execute(
          q(
            "SELECT id FROM agent_operations WHERE agent_session_id=? AND operation_kind='guide' AND state IN ('send-intent','running','submission-unknown')",
            sessionId,
          ),
        )
      ).rows
      await tx.execute(
        q(
          "UPDATE agent_operations SET state=?,updated_at=?,terminal_at=? WHERE id=? AND state='foreground-terminal'",
          outcome,
          now,
          now,
          operationId,
        ),
      )
      for (const guide of guides)
        await tx.execute(
          q(
            "UPDATE agent_operations SET state='submission-unknown',updated_at=? WHERE id=?",
            now,
            text(guide.id),
          ),
        )
      const recovery = guides.length > 0 || session.state === 'recovery-required'
      await tx.execute(
        q(
          'UPDATE agent_sessions SET state=?,updated_at=? WHERE id=?',
          recovery ? 'recovery-required' : outcome === 'completed' ? 'idle' : 'paused',
          now,
          sessionId,
        ),
      )
      return { reusable: !recovery, completed: outcome === 'completed' && !recovery }
    })
  }
  async leases() {
    return (await this.db.execute('SELECT * FROM agent_workspace_leases')).rows
  }
  async recover(sessionId: string) {
    await transaction(this.db, async (tx) => {
      await tx.execute(
        q(
          "UPDATE agent_operations SET state='submission-unknown',updated_at=? WHERE agent_session_id=? AND state IN ('send-intent','running','waiting-interaction','foreground-terminal')",
          Date.now(),
          sessionId,
        ),
      )
      await tx.execute(
        q(
          "UPDATE agent_interactions SET state='stale',updated_at=? WHERE agent_session_id=? AND state='pending'",
          Date.now(),
          sessionId,
        ),
      )
      await tx.execute(
        q(
          "UPDATE agent_outbox SET state='delivery-unknown',updated_at=? WHERE agent_session_id=? AND state='sending'",
          Date.now(),
          sessionId,
        ),
      )
    })
  }
  async addInteraction(request: NativeInteraction, operationId: string | null) {
    await this.db.execute(
      q(
        `INSERT INTO agent_interactions(id,agent_session_id,operation_id,connection_generation,native_request_id_json,kind,state,safe_request_json,controller_thread_id,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?)`,
        request.id,
        request.sessionId,
        operationId,
        request.generation,
        safeJson(request.requestId),
        request.kind,
        this.protect(request.schema),
        request.threadId,
        request.expiresAt,
        Date.now(),
        Date.now(),
      ),
    )
  }
  async consumeInteraction(request: NativeInteraction, threadId: string, generation: string) {
    const r = await this.db.execute(
      q(
        "UPDATE agent_interactions SET state='answered',updated_at=? WHERE id=? AND controller_thread_id=? AND connection_generation=? AND state='pending' AND expires_at>?",
        Date.now(),
        request.id,
        threadId,
        generation,
        Date.now(),
      ),
    )
    if (r.rowsAffected !== 1) {
      throw fail('INTERACTION_STALE', 'This native request is no longer active.', 'control')
    }
  }
  async closeInteraction(id: string) {
    await this.db.execute(
      q(
        "UPDATE agent_interactions SET state='stale',updated_at=? WHERE id=? AND state='pending'",
        Date.now(),
        id,
      ),
    )
  }
  async view(sessionId: string, cursor: Cursor, parts: readonly DisplayPart[], threadId: string) {
    await transaction(this.db, async (tx) => {
      const saved = (
        await tx.execute(
          q(
            'SELECT * FROM agent_stream_state WHERE agent_session_id=? AND stream_kind=?',
            sessionId,
            cursor.stream,
          ),
        )
      ).rows[0]
      // Fresh connection sequence is not compared to an unrelated generation.
      if (
        saved &&
        saved.connection_generation === cursor.generation &&
        saved.log_epoch === cursor.epoch &&
        Number(saved.sequence) >= cursor.sequence
      ) {
        return
      }
      const previous =
        saved && typeof saved.snapshot_json === 'string'
          ? record(JSON.parse(saved.snapshot_json))
          : {}
      for (const part of parts) {
        const prior = previous[part.id]
        const encoded = this.protect(part)
        if (prior && this.protect(prior) === encoded) {
          continue
        }
        previous[part.id] = part
        if (part.delivery === 'snapshot' || part.state === 'streaming') {
          continue
        }
        const revision = Number(
          (
            await tx.execute(
              q(
                'SELECT COALESCE(MAX(content_revision),0)+1 AS n FROM agent_outbox WHERE thread_id=? AND display_part_id=?',
                threadId,
                part.id,
              ),
            )
          ).rows[0]?.n,
        )
        const pending = (
          await tx.execute(
            q(
              "SELECT id FROM agent_outbox WHERE thread_id=? AND display_part_id=? AND state='pending' LIMIT 1",
              threadId,
              part.id,
            ),
          )
        ).rows[0]
        if (pending) {
          await tx.execute(
            q(
              "UPDATE agent_outbox SET payload_json=?,content_revision=?,updated_at=? WHERE id=? AND state='pending'",
              encoded,
              revision,
              Date.now(),
              text(pending.id),
            ),
          )
          continue
        }
        const count = Number(
          (
            await tx.execute(
              q(
                "SELECT COUNT(*) AS n FROM agent_outbox WHERE agent_session_id=? AND state<>'sent'",
                sessionId,
              ),
            )
          ).rows[0]?.n,
        )
        if (count >= 2048) {
          throw fail(
            'OUTBOX_LIMIT',
            'Discord delivery backlog requires reconciliation.',
            'render',
            'possible',
          )
        }
        await tx.execute(
          q(
            `INSERT INTO agent_outbox(id,agent_session_id,thread_id,display_part_id,content_revision,payload_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?)`,
            randomUUID(),
            sessionId,
            threadId,
            part.id,
            revision,
            encoded,
            Date.now(),
            Date.now(),
          ),
        )
      }
      await tx.execute(
        q(
          `INSERT INTO agent_stream_state(agent_session_id,stream_kind,log_epoch,connection_generation,sequence,revision,snapshot_json,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(agent_session_id,stream_kind) DO UPDATE SET log_epoch=excluded.log_epoch,connection_generation=excluded.connection_generation,sequence=excluded.sequence,revision=excluded.revision,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at`,
          sessionId,
          cursor.stream,
          cursor.epoch,
          cursor.generation,
          cursor.sequence,
          cursor.revision ?? null,
          this.protect(previous),
          Date.now(),
        ),
      )
    })
  }
  async streamCursor(sessionId: string, stream: 'legacy' | 'v4'): Promise<Cursor | null> {
    const row = (
      await this.db.execute(
        q(
          'SELECT * FROM agent_stream_state WHERE agent_session_id=? AND stream_kind=?',
          sessionId,
          stream,
        ),
      )
    ).rows[0]
    return row
      ? {
          stream,
          generation: text(row.connection_generation),
          epoch: typeof row.log_epoch === 'string' ? row.log_epoch : '',
          sequence: integer(row.sequence),
          ...(row.revision === null || row.revision === undefined
            ? {}
            : { revision: integer(row.revision) }),
        }
      : null
  }
  async outbox() {
    return (
      await this.db.execute(
        "SELECT * FROM agent_outbox WHERE state IN ('pending','delivery-unknown') ORDER BY created_at,content_revision",
      )
    ).rows
  }
  async claimOutbox(id: string, expectedRevision?: number) {
    // Selection and coalescing race: claim only the payload revision actually read.
    return (
      (
        await this.db.execute(
          q(
            "UPDATE agent_outbox SET state='sending',updated_at=? WHERE id=? AND state='pending' AND (? IS NULL OR content_revision=?)",
            Date.now(),
            id,
            expectedRevision ?? null,
            expectedRevision ?? null,
          ),
        )
      ).rowsAffected === 1
    )
  }
  async receipt(id: string, messageId: string | null) {
    await this.db.execute(
      q(
        "UPDATE agent_outbox SET state=?,discord_message_id=?,updated_at=? WHERE id=? AND state IN ('sending','delivery-unknown')",
        messageId ? 'sent' : 'delivery-unknown',
        messageId,
        Date.now(),
        id,
      ),
    )
  }
  async suppressOutbox(id: string) {
    // Verbosity-hidden or empty part: this revision has nothing to deliver.
    // Terminal like a receipt, but no Discord message exists for it.
    await this.db.execute(
      q(
        "UPDATE agent_outbox SET state='sent',updated_at=? WHERE id=? AND state IN ('pending','sending')",
        Date.now(),
        id,
      ),
    )
  }
  async sentGroup(threadId: string, displayPartId: string, beforeRevision: number) {
    // Receipt group (comma-joined Discord message ids) of the latest sent
    // revision of this part below beforeRevision — the edit-in-place target.
    const row = (
      await this.db.execute(
        q(
          "SELECT discord_message_id FROM agent_outbox WHERE thread_id=? AND display_part_id=? AND content_revision<? AND state='sent' AND discord_message_id IS NOT NULL AND discord_message_id<>'' ORDER BY content_revision DESC LIMIT 1",
          threadId,
          displayPartId,
          beforeRevision,
        ),
      )
    ).rows[0]
    if (!row) {
      return null
    }
    const ids = String(row.discord_message_id)
      .split(',')
      .filter((part) => part.length > 0)
    return ids.length ? ids : null
  }
  async clearQueue(sessionId: string) {
    return (
      await this.db.execute(
        q(
          "UPDATE agent_operations SET state='cancelled',updated_at=? WHERE agent_session_id=? AND state='queued' AND operation_kind='prompt'",
          Date.now(),
          sessionId,
        ),
      )
    ).rowsAffected
  }
}
