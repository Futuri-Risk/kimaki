// ZK-008 projector contract tests (ported from the standalone slice core +
// hardening suites): snapshot/delta cursor rules, repeated-tail replacement,
// bounded row buffers, stale-row non-resurrection (H08), revision monotonicity
// (H35), and presentation-only projection (a projected part can never carry
// execution state). — ZCode 2026-09-18
import { test } from 'vitest'
import assert from 'node:assert/strict'

import { LegacyProjector, V4Projector } from './zcode-projector.js'

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof Error, 'projector failures carry an Error')
    return (error as Error & { code?: string }).code ?? ''
  }
  assert.fail('expected a projector failure')
}

function frame(sequence: number, payload: Record<string, unknown>) {
  return {
    topic: 'conversation/s',
    subscriptionId: 'sub',
    frame: {
      topic: 'conversation/s',
      subscriptionId: 'sub',
      fromSeq: sequence,
      toSeq: sequence,
      payload,
    },
  }
}

function snapshotFrame(sequence: number, rows: unknown[], extra: Record<string, unknown> = {}) {
  return frame(sequence, { kind: 'snapshot', snapshot: { rows: { window: rows }, ...extra } })
}

test('V4 snapshots are presentation-only and never manufacture completion', () => {
  const p = new V4Projector('s', 'g', 'sub', 'e')
  const result = p.apply(
    snapshotFrame(0, [
      { rowId: 1, entityId: 't', kind: 'turnHeader', state: 'completedInterrupted' },
      { rowId: 2, entityId: 'a', kind: 'assistantText', state: 'done', text: 'old' },
    ]),
  )
  assert.ok(result)
  assert.equal(result.parts.length, 1)
  assert.equal(result.parts[0]!.delivery, 'snapshot')
  assert.equal('state' in result, false)
})

test('V4 row deltas accumulate, duplicates are idempotent, and gaps refuse', () => {
  const p = new V4Projector('s', 'g', 'sub', 'e')
  p.apply(
    snapshotFrame(0, [
      { rowId: 2, entityId: 'a', kind: 'assistantText', state: 'streaming', text: 'a' },
    ]),
  )
  const delta = frame(1, {
    kind: 'deltas',
    deltas: [{ op: 'row.delta', rowId: 2, path: 'text', append: 'b' }],
  })
  assert.equal(p.apply(delta)!.parts[0]!.text, 'ab')
  assert.equal(p.apply(delta), null)
  // Repeated tails replace rather than append: a full upsert wins over deltas.
  assert.equal(
    p.apply(
      frame(2, {
        kind: 'deltas',
        deltas: [
          {
            op: 'row.upserted',
            row: { rowId: 2, entityId: 'a', kind: 'assistantText', state: 'done', text: 'abc' },
          },
        ],
      }),
    )!.parts[0]!.text,
    'abc',
  )
  assert.equal(
    code(() => p.apply(frame(4, { kind: 'deltas', deltas: [] }))),
    'CURSOR_GAP',
  )
})

test('V4 tool rows project running and error states with bounded output tails', () => {
  const p = new V4Projector('s', 'g', 'sub', 'e')
  const result = p.apply(
    snapshotFrame(0, [
      {
        rowId: 1,
        entityId: 'tool-1',
        kind: 'toolCall',
        toolName: 'bash',
        status: 'running',
        inputText: '{"command":"npm test"}',
      },
      {
        rowId: 2,
        entityId: 'tool-2',
        kind: 'toolCall',
        toolName: 'bash',
        status: 'error',
        output: { text: 'boom' },
      },
    ]),
  )
  assert.ok(result)
  assert.equal(result.parts.length, 2)
  const [running, errored] = result.parts
  assert.equal(running!.kind, 'tool')
  assert.equal(running!.state, 'running')
  assert.equal(running!.text, '{"command":"npm test"}')
  assert.equal(errored!.state, 'error')
  assert.equal(errored!.text, 'boom')
})

test('foreign V4 subscription frames are refused', () => {
  const p = new V4Projector('s', 'g', 'sub', 'e')
  const foreign = snapshotFrame(0, [])
  ;(foreign.frame as Record<string, unknown>).subscriptionId = 'other'
  assert.equal(
    code(() => p.apply(foreign)),
    'FOREIGN_FRAME',
  )
})

test('H08 V4 resnapshot rebuilds the row registry without resurrecting omitted stale rows', () => {
  const p = new V4Projector('s', 'g', 'sub', 'epoch')
  p.apply(
    snapshotFrame(0, [
      { rowId: 1, entityId: 'old', kind: 'assistantText', text: 'old', state: 'streaming' },
    ]),
  )
  p.apply(snapshotFrame(2, []))
  assert.equal(
    code(() =>
      p.apply(
        frame(3, {
          kind: 'deltas',
          deltas: [{ op: 'row.delta', rowId: 1, path: 'text', append: 'wrong' }],
        }),
      ),
    ),
    'ROW_RESYNC_REQUIRED',
  )
})

test('H35 snapshot revision is retained and cannot regress within an epoch', () => {
  const p = new V4Projector('s', 'g', 'sub', 'e')
  const snap = (sequence: number, revision: number) =>
    snapshotFrame(sequence, [], { logEpoch: 'e', revision })
  assert.equal(p.apply(snap(1, 9))!.cursor.revision, 9)
  assert.equal(
    code(() => p.apply(snap(2, 8))),
    'REVISION_REGRESSION',
  )
  assert.equal(p.apply(snap(3, 10))!.cursor.revision, 10)
  assert.equal(p.apply(snap(2, 8)), null)
})

test('V4 epoch change requires resubscription', () => {
  const p = new V4Projector('s', 'g', 'sub', 'e1')
  p.apply(snapshotFrame(0, []))
  assert.equal(
    code(() => p.apply(snapshotFrame(1, [], { logEpoch: 'e2' }))),
    'EPOCH_CHANGED',
  )
})

test('V4 row buffer is bounded and refuses beyond maxRows', () => {
  const p = new V4Projector('s', 'g', 'sub', 'e', 2)
  p.apply(
    snapshotFrame(0, [
      { rowId: 1, entityId: 'a', kind: 'assistantText', state: 'done', text: 'a' },
      { rowId: 2, entityId: 'b', kind: 'assistantText', state: 'done', text: 'b' },
    ]),
  )
  assert.equal(
    code(() =>
      p.apply(
        frame(1, {
          kind: 'deltas',
          deltas: [
            {
              op: 'row.upserted',
              row: { rowId: 3, entityId: 'c', kind: 'assistantText', state: 'done', text: 'c' },
            },
          ],
        }),
      ),
    ),
    'VIEW_LIMIT',
  )
})

test('legacy repeated stdout tails replace rather than append', () => {
  const p = new LegacyProjector('s', 'g')
  const event = (seq: number, tail: string) => ({
    sessionId: 's',
    seq,
    type: 'tool.updated',
    payload: { kind: 'progress', toolCallId: 't', toolName: 'bash', stdoutTail: tail },
  })
  p.apply(event(1, 'abc'))
  assert.equal(p.apply(event(2, 'abc'))!.parts[0]!.text, 'abc')
})

test('H09 malformed legacy event does not consume its sequence', () => {
  const p = new LegacyProjector('s', 'g')
  assert.equal(
    code(() =>
      p.apply({
        sessionId: 's',
        seq: 1,
        type: 'model.streaming',
        payload: { kind: 'text_delta', assistantMessageId: 'a', delta: 42 },
      }),
    ),
    'FRAME_INVALID',
  )
  const good = p.apply({
    sessionId: 's',
    seq: 1,
    type: 'model.streaming',
    payload: { kind: 'text_delta', assistantMessageId: 'a', delta: 'good' },
  })
  assert.equal(good!.parts[0]!.text, 'good')
})

test('legacy foreign events are refused', () => {
  const p = new LegacyProjector('s', 'g')
  assert.equal(
    code(() => p.apply({ sessionId: 'other', seq: 1, type: 'turn.completed', payload: {} })),
    'FOREIGN_EVENT',
  )
})

test('legacy turn completion finishes streaming parts without inventing content', () => {
  const p = new LegacyProjector('s', 'g')
  p.apply({
    sessionId: 's',
    seq: 1,
    type: 'model.streaming',
    payload: { kind: 'text_delta', assistantMessageId: 'a', delta: 'partial' },
  })
  const done = p.apply({ sessionId: 's', seq: 2, type: 'turn.completed', payload: {} })
  assert.equal(done!.parts[0]!.state, 'done')
  assert.equal(done!.parts[0]!.text, 'partial')
})
