// ZK-007 port of the hardened standalone slice zcode-projector.ts (display
// projectors: legacy event stream + V4 conversation frames). Presentation only —
// projected parts can never settle execution state. — ZCode 2026-09-17
import { fail, record, text, integer } from './errors.js'
import type { Cursor, DisplayPart } from './types.js'
/** Presentation only: turnHeader rows can NEVER finish a native execution. */
export class V4Projector {
  private rows = new Map<number, Record<string, unknown>>()
  private sequence = -1
  private revision: number | undefined
  constructor(
    readonly sessionId: string,
    readonly generation: string,
    readonly subscriptionId: string,
    readonly epoch: string,
    readonly maxRows = 10000,
  ) {}
  apply(value: unknown): {
    cursor: Cursor
    parts: DisplayPart[]
  } | null {
    const outer = record(value)
    const frame = record(outer.frame)
    const topic = `conversation/${this.sessionId}`
    if (
      frame.topic !== topic ||
      frame.subscriptionId !== this.subscriptionId ||
      (outer.topic !== undefined && outer.topic !== topic) ||
      (outer.subscriptionId !== undefined && outer.subscriptionId !== this.subscriptionId)
    ) {
      throw fail(
        'FOREIGN_FRAME',
        'Native frame belongs to another subscription.',
        'control',
        'possible',
      )
    }
    const from = integer(frame.fromSeq)
    const to = integer(frame.toSeq)
    if (to < from) {
      throw fail('FRAME_INVALID', 'Invalid native sequence range.', 'control', 'possible')
    }
    const payload = record(frame.payload)
    if (to <= this.sequence) {
      return null
    }
    if (payload.kind !== 'snapshot' && from !== this.sequence + 1) {
      throw fail('CURSOR_GAP', 'Native frame gap requires a fresh snapshot.', 'recover', 'possible')
    }
    // Rebuild the decoder's row registry on authoritative resnapshot. Persisted
    // presentation history is separate and is not erased by a partial window.
    const candidate =
      payload.kind === 'snapshot' ? new Map<number, Record<string, unknown>>() : new Map(this.rows)
    const parts: DisplayPart[] = []
    let observedRevision = this.revision
    const upsert = (value: unknown, snapshot: boolean) => {
      const row = record(value)
      const id = integer(row.rowId)
      text(row.kind)
      if (!candidate.has(id) && candidate.size >= this.maxRows) {
        throw fail(
          'VIEW_LIMIT',
          'Native view is full; archive/resync before continuing.',
          'recover',
          'possible',
        )
      }
      candidate.set(id, row)
      const part = this.part(row, snapshot)
      if (part) {
        parts.push(part)
      }
    }
    if (payload.kind === 'snapshot') {
      const snap = record(payload.snapshot)
      if (snap.revision !== undefined) {
        observedRevision = integer(snap.revision, 'publisher snapshot revision')
        if (this.revision !== undefined && observedRevision < this.revision)
          throw fail(
            'REVISION_REGRESSION',
            'Publisher revision regressed within one epoch; resubscribe.',
            'recover',
            'possible',
          )
      }
      if (snap.logEpoch !== undefined && snap.logEpoch !== this.epoch) {
        throw fail('EPOCH_CHANGED', 'Native epoch changed; resubscribe.', 'recover', 'possible')
      }
      const rows = record(snap.rows).window
      if (!Array.isArray(rows)) {
        throw fail('FRAME_INVALID', 'Invalid native row window.', 'control')
      }
      // Omitted historical display parts survive in the host view store, not
      // in the live row-id decoder (row IDs may have been reassigned).
      for (const row of rows) upsert(row, true)
    } else if (payload.kind === 'deltas') {
      if (!Array.isArray(payload.deltas)) {
        throw fail('FRAME_INVALID', 'Invalid native row operations.', 'control')
      }
      for (const value of payload.deltas) {
        const op = record(value)
        if (op.op === 'row.appended' || op.op === 'row.upserted') {
          upsert(op.row, false)
        } else if (op.op === 'row.delta') {
          const id = integer(op.rowId)
          const previous = candidate.get(id)
          if (!previous || op.path !== 'text' || typeof op.append !== 'string') {
            throw fail(
              'ROW_RESYNC_REQUIRED',
              'Unknown native row delta requires resynchronization.',
              'recover',
              'possible',
            )
          }
          upsert({ ...previous, text: String(previous.text ?? '') + op.append }, false)
        } else if (op.op !== 'state.updated') {
          throw fail(
            'ROW_RESYNC_REQUIRED',
            'Unrecognized native row operation.',
            'recover',
            'possible',
          )
        }
      }
    } else {
      throw fail('FRAME_INVALID', 'Unknown native view payload.', 'control', 'possible')
    }
    this.rows = candidate
    this.sequence = to
    this.revision = observedRevision
    return {
      cursor: {
        stream: 'v4',
        generation: this.generation,
        epoch: this.epoch,
        sequence: to,
        ...(observedRevision === undefined ? {} : { revision: observedRevision }),
      },
      parts,
    }
  }
  private part(row: Record<string, unknown>, snapshot: boolean): DisplayPart | null {
    const kind = row.kind
    if (!['assistantText', 'reasoning', 'toolCall', 'fileChange'].includes(String(kind))) {
      return null
    }
    const rowId = integer(row.rowId)
    const nativeId = text(row.entityId, 'row entity ID')
    const base = {
      id: `${this.sessionId}:${this.epoch}:${nativeId}`,
      nativeId,
      order: rowId,
      delivery: snapshot ? ('snapshot' as const) : ('live' as const),
    }
    if (kind === 'assistantText' || kind === 'reasoning') {
      if (typeof row.text !== 'string' || row.text.length > 1000000) {
        throw fail('VIEW_LIMIT', 'Invalid or oversized native text.', 'control')
      }
      return {
        ...base,
        kind: kind === 'assistantText' ? 'text' : 'reasoning',
        state: row.state === 'done' ? 'done' : 'streaming',
        text: row.text,
      }
    }
    if (kind === 'fileChange') {
      return {
        ...base,
        kind: 'file-change',
        state: 'done',
        text: typeof row.text === 'string' ? row.text.slice(0, 65536) : 'Native file change',
      }
    }
    const output = row.output && typeof row.output === 'object' ? record(row.output) : {}
    const input =
      typeof row.inputText === 'string' ? row.inputText : JSON.stringify(row.input ?? {})
    const toolName = text(row.toolName, 'native tool name')
    return {
      ...base,
      kind: 'tool',
      toolName,
      state:
        row.status === 'success'
          ? 'done'
          : row.status === 'error'
            ? 'error'
            : row.status === 'running'
              ? 'running'
              : 'streaming',
      text: (typeof output.text === 'string' ? output.text : input).slice(-65536),
    }
  }
}
export class LegacyProjector {
  private parts = new Map<string, DisplayPart>()
  private order = 0
  private sequence = -1
  constructor(
    readonly sessionId: string,
    readonly generation: string,
    readonly redact: (s: string) => string = (s) => s,
    afterSequence = -1,
  ) {
    this.sequence = afterSequence
  }
  apply(value: unknown): {
    cursor: Cursor
    parts: DisplayPart[]
  } | null {
    const e = record(value)
    if (e.sessionId !== this.sessionId) {
      throw fail('FOREIGN_EVENT', 'Native event belongs to another session.', 'control', 'possible')
    }
    const sequence = integer(e.seq)
    if (sequence <= this.sequence) {
      return null
    }
    const originalParts = this.parts
    const originalOrder = this.order
    this.parts = new Map(originalParts)
    try {
      const p = record(e.payload)
      const changed: DisplayPart[] = []
      const delivery: DisplayPart['delivery'] = e.deliveryKind === 'snapshot' ? 'snapshot' : 'live'
      if (
        e.type === 'model.streaming' &&
        (p.kind === 'text_delta' || p.kind === 'reasoning_delta')
      ) {
        const nativeId =
          text(p.assistantMessageId, 'native assistant message ID') +
          (p.kind === 'reasoning_delta' ? ':reasoning' : ':text')
        const id = `${this.sessionId}:${nativeId}`
        const prior = this.parts.get(id)
        if (typeof p.delta !== 'string') {
          throw fail('FRAME_INVALID', 'Native text delta is invalid.', 'control')
        }
        const content = (prior?.text ?? '') + p.delta
        if (content.length > 1000000 || (!prior && this.parts.size >= 10000)) {
          throw fail('VIEW_LIMIT', 'Native view exceeds configured bounds.', 'control', 'possible')
        }
        const part: DisplayPart = {
          id,
          nativeId,
          kind: p.kind === 'text_delta' ? 'text' : 'reasoning',
          state: 'streaming',
          text: this.redact(content),
          delivery,
          order: prior?.order ?? ++this.order,
        }
        this.parts.set(id, part)
        changed.push(part)
      } else if (e.type === 'tool.updated') {
        if (p.kind === 'batch') {
          if (!Array.isArray(p.updates)) {
            throw fail('FRAME_INVALID', 'Invalid native tool batch.', 'control')
          }
          for (const item of p.updates) this.tool(record(item), delivery, changed)
        } else {
          this.tool(p, delivery, changed)
        }
      } else if (e.type === 'turn.completed' || e.type === 'turn.failed') {
        for (const [id, part] of this.parts)
          if (part.state === 'streaming' && (part.kind === 'text' || part.kind === 'reasoning')) {
            const next = { ...part, state: 'done' as const, delivery }
            this.parts.set(id, next)
            changed.push(next)
          }
      }
      this.sequence = sequence
      return {
        cursor: { stream: 'legacy', generation: this.generation, epoch: '', sequence },
        parts: changed,
      }
    } catch (error) {
      this.parts = originalParts
      this.order = originalOrder
      throw error
    }
  }
  private tool(p: Record<string, unknown>, delivery: 'live' | 'snapshot', changed: DisplayPart[]) {
    const nativeId = text(p.toolCallId, 'native tool ID')
    const id = `${this.sessionId}:${nativeId}`
    const prior = this.parts.get(id)
    const name = typeof p.toolName === 'string' ? p.toolName : prior?.toolName
    if (!name) {
      throw fail('FRAME_INVALID', 'Native tool name is missing.', 'control')
    }
    if (!prior && this.parts.size >= 10000) {
      throw fail('VIEW_LIMIT', 'Too many native tool observations.', 'control')
    }
    let output = prior?.text ?? ''
    if (typeof p.stdoutTail === 'string' || typeof p.stderrTail === 'string') {
      output = String(p.stdoutTail ?? '') + String(p.stderrTail ?? '')
    } else if (p.result !== undefined) {
      output = typeof p.result === 'string' ? p.result : JSON.stringify(p.result)
    } else if (p.input !== undefined) {
      output = JSON.stringify(p.input)
    }
    const state =
      p.kind === 'result'
        ? 'done'
        : p.kind === 'error'
          ? 'error'
          : p.kind === 'scheduled'
            ? 'streaming'
            : 'running'
    const part: DisplayPart = {
      id,
      nativeId,
      kind: 'tool',
      toolName: this.redact(name),
      state,
      text: this.redact(output).slice(-65536),
      delivery,
      order: prior?.order ?? ++this.order,
    }
    this.parts.set(id, part)
    changed.push(part)
  }
}
