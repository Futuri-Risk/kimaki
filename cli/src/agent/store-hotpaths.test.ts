// #26 (ZCode 2026-09-29): regression guard for store read/write hotpaths.
// (a) view() coalesces streaming parts per (session, stream) instead of
//     re-parsing and re-writing the whole snapshot per delta; a part with
//     outbox effects still flushes synchronously and merges the buffer.
// (b) operations({ states }) filters at SQL level; the unfiltered call keeps
//     returning full history for recovery/replay.
// The streaming coalescing contract: the snapshot is a projection cache — the
// native event stream replays from the persisted cursor, so deferring a
// streaming write only delays the cache, while a terminal part must never be
// deferred (persistence before effects).
import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
import { createStoreHarness } from './test-harness.js'

const cursor = (sequence: number) => ({
  stream: 'legacy' as const,
  generation: 'g1',
  epoch: '',
  sequence,
})
const streamingPart = (id: string, text: string, order = 0) => ({
  id,
  nativeId: `n-${id}`,
  kind: 'text' as const,
  state: 'streaming' as const,
  text,
  delivery: 'live' as const,
  order,
})
const terminalPart = (id: string, text: string, order = 0) => ({
  id,
  nativeId: `n-${id}`,
  kind: 'text' as const,
  state: 'done' as const,
  text,
  delivery: 'live' as const,
  order,
})

async function snapshotParts(h: Awaited<ReturnType<typeof createStoreHarness>>) {
  const rows = (
    await h.store.db.execute({
      sql: 'SELECT snapshot_json FROM agent_stream_state WHERE agent_session_id=? AND stream_kind=?',
      args: [h.session.id, 'legacy'],
    })
  ).rows
  const raw = rows[0]?.snapshot_json
  return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, { text: string }>) : null
}

describe('#26 view() streaming coalescing', () => {
  test('a burst of streaming deltas writes nothing until flushed, then lands once with the final cursor', async () => {
    const h = await createStoreHarness()
    for (let i = 1; i <= 30; i++) {
      await h.store.view(
        h.session.id,
        cursor(i),
        [streamingPart('p1', `delta ${i}`)],
        'thread-1',
      )
    }
    // Deferred: neither the cursor row nor the snapshot has been written.
    assert.equal(await h.store.streamCursor(h.session.id, 'legacy'), null)
    assert.equal(await snapshotParts(h), null)

    await h.store.flushView(h.session.id)
    const cur = await h.store.streamCursor(h.session.id, 'legacy')
    assert.equal(cur?.sequence, 30, 'flush persists the latest buffered cursor')
    const parts = await snapshotParts(h)
    assert.equal(parts?.['p1']?.text, 'delta 30', 'the latest delta of a part wins')
  })

  test('a terminal part flushes the buffered streaming parts synchronously in one write', async () => {
    const h = await createStoreHarness()
    await h.store.view(h.session.id, cursor(2), [streamingPart('p1', 'partial text')], 'thread-1')
    // Not yet durable — then a terminal part arrives in the same stream.
    await h.store.view(h.session.id, cursor(3), [terminalPart('p2', 'final answer')], 'thread-1')

    const cur = await h.store.streamCursor(h.session.id, 'legacy')
    assert.equal(cur?.sequence, 3, 'terminal parts are never deferred')
    const parts = await snapshotParts(h)
    assert.equal(parts?.['p1']?.text, 'partial text', 'buffered streaming part flushed with it')
    assert.equal(parts?.['p2']?.text, 'final answer')
    // The terminal part carried outbox effects: exactly one pending outbox row.
    assert.equal((await h.store.outbox()).length, 1)
  })

  test('cursor regression after a flush leaves the snapshot untouched', async () => {
    const h = await createStoreHarness()
    await h.store.view(h.session.id, cursor(10), [terminalPart('p1', 'done')], 'thread-1')
    await h.store.view(h.session.id, cursor(4), [streamingPart('p2', 'stale')], 'thread-1')
    await h.store.flushView(h.session.id)
    const cur = await h.store.streamCursor(h.session.id, 'legacy')
    assert.equal(cur?.sequence, 10)
    const parts = await snapshotParts(h)
    assert.equal(parts?.['p2'], undefined, 'a stale-sequence flush must not resurrect old parts')
  })
})

describe('#26 operations() state filtering', () => {
  test('states filter returns only requested lifecycles in queue order; unfiltered keeps history', async () => {
    const h = await createStoreHarness()
    const a = await h.store.admit(h.input('one', 'task'))
    const b = await h.store.admit(h.input('two', 'task'))
    const c = await h.store.admit(h.input('three', 'task'))
    await h.store.transition(b.operation.id, ['queued'], 'preparing')
    await h.store.transition(c.operation.id, ['queued'], 'rejected')

    const queued = await h.store.operations(h.session.id, { states: ['queued'] })
    assert.deepEqual(
      queued.map((o) => o.id),
      [a.operation.id],
      'only the still-queued operation is returned',
    )
    const live = await h.store.operations(h.session.id, {
      states: ['queued', 'preparing', 'rejected'],
    })
    assert.equal(live.length, 3)
    assert.deepEqual(
      live.map((o) => o.state),
      ['queued', 'preparing', 'rejected'],
      'filtered results keep queue order',
    )
    const all = await h.store.operations(h.session.id)
    assert.equal(all.length, 3, 'the unfiltered call still returns full history')
    void b
  })
})
