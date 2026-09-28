// ZK-014 scheduling/recovery contract tests at the store/coordinator level:
// the same scheduled wake re-delivered after a simulated restart dedupes to
// the ORIGINAL operation (never a second native task), a corrupted wake is
// refused as an admission conflict, recovery marks unknown intents visibly
// and never auto-replays them. — ZCode 2026-09-18
import { test, expect, vi } from 'vitest'
import assert from 'node:assert/strict'

const state = { sessionForThread: null as string | null }
vi.mock('../database.js', () => ({
  getThreadSession: async () => state.sessionForThread,
}))
vi.mock('./host-sidecar.js', () => ({
  lookupBackendSidecar: async () => ({ backend: 'zcode' }),
}))
vi.mock('./host-coordinator.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getNativeCoordinator: async () => null,
}))

import { AgentCoordinator } from './coordinator.js'
import { coordinatorHarness, FakeBackend } from './test-harness.js'
import { describeRecovery, ingestScheduled, recoverWithCoordinator } from './schedule-bridge.js'

const SCHEDULE_INPUT = {
  threadId: 'thread-1',
  runKey: 'run-9',
  prompt: 'nightly report',
  actorId: 'actor-1',
}

test('the same scheduled wake never double-submits across a simulated restart', async () => {
  const h = await coordinatorHarness()
  state.sessionForThread = h.session.id
  const first = await ingestScheduled(h.coordinator, { sessionId: h.session.id, ...SCHEDULE_INPUT })
  assert.equal(first.kind, 'submitted')
  assert.equal(first.kind === 'submitted' && first.duplicate, false)
  await h.waitForState(first.kind === 'submitted' ? first.operation.id : '', 'completed')
  await h.coordinator.settle()
  assert.deepEqual(h.backend.submits, ['nightly report'])

  // Simulated restart: a NEW coordinator and backend over the SAME durable
  // store; the wake is re-delivered with the same stable run key.
  await h.coordinator.close()
  const backend2 = new FakeBackend(h.session, h.root)
  const coordinator2 = new AgentCoordinator(h.store, backend2 as never, async () => true)
  const second = await ingestScheduled(coordinator2, { sessionId: h.session.id, ...SCHEDULE_INPUT })
  assert.equal(second.kind, 'submitted')
  assert.equal(
    second.kind === 'submitted' && second.operation.id,
    first.kind === 'submitted' && first.operation.id,
  )
  assert.equal(second.kind === 'submitted' && second.duplicate, true)
  await coordinator2.settle()
  assert.deepEqual(backend2.submits, [], 'restart must never re-send the same scheduled wake')
  await coordinator2.close()
})

test('a corrupted wake (same identity, different content) is an admission conflict', async () => {
  const h = await coordinatorHarness()
  const first = await ingestScheduled(h.coordinator, { sessionId: h.session.id, ...SCHEDULE_INPUT })
  assert.equal(first.kind, 'submitted')
  const corrupted = await ingestScheduled(h.coordinator, {
    sessionId: h.session.id,
    ...SCHEDULE_INPUT,
    prompt: 'tampered payload',
  })
  assert.equal(corrupted.kind, 'rejected')
  assert.equal(corrupted.kind === 'rejected' && corrupted.code, 'ADMISSION_CONFLICT')
  await h.coordinator.close()
})

test('recovery marks uncertain intents visibly and never auto-replays them', async () => {
  const h = await coordinatorHarness()
  // An admitted prompt stuck mid-submission (crash window).
  const admitted = await h.store.admit(h.input('wake-1', 'uncertain work'))
  await h.db.execute({
    sql: "UPDATE agent_operations SET state='send-intent' WHERE id=?",
    args: [admitted.operation.id],
  })
  const report = await recoverWithCoordinator(h.coordinator, h.session.id)
  assert.ok(report)
  assert.equal(report.sessionId, h.session.id)
  assert.deepEqual(
    report.uncertain.map((o) => [o.kind, o.state]),
    [['prompt', 'submission-unknown']],
  )
  assert.match(describeRecovery(report), /never automatically re-sent/)

  // The same wake after recovery maps to the SAME unknown operation: no
  // second native task, no silent fresh run.
  const again = await h.store.admit(h.input('wake-1', 'uncertain work'))
  assert.equal(again.created, false)
  assert.equal(again.operation.id, admitted.operation.id)
  assert.equal(again.operation.state, 'submission-unknown')
  await h.coordinator.settle()
  assert.deepEqual(h.backend.submits, [])
  await h.coordinator.close()
})

test('a failed resume never silently fresh-creates (lifecycle-pinned, restated at bridge level)', async () => {
  const h = await coordinatorHarness()
  // Bind a native session with one completed turn first.
  const bound = await ingestScheduled(h.coordinator, {
    sessionId: h.session.id,
    ...SCHEDULE_INPUT,
    runKey: 'bind-1',
  })
  await h.waitForState(bound.kind === 'submitted' ? bound.operation.id : '', 'completed')
  const nativeId = (await h.store.session(h.session.id))?.nativeSessionId
  assert.ok(nativeId)
  await h.coordinator.close()

  // Restart where resume REFUSES: the op must fail visibly and the existing
  // native binding must survive intact — never a silent fresh create.
  const backend2 = new FakeBackend(h.session, h.root)
  backend2.prepare = async () => {
    throw Object.assign(new Error('native refused resume'), { code: 'RESUME_REJECTED' })
  }
  const coordinator2 = new AgentCoordinator(h.store, backend2 as never, async () => true)
  const refused = await ingestScheduled(coordinator2, {
    sessionId: h.session.id,
    ...SCHEDULE_INPUT,
    runKey: 'after-1',
  })
  assert.equal(refused.kind, 'submitted')
  await coordinator2.settle()
  const op = await coordinator2.store.operation(
    refused.kind === 'submitted' ? refused.operation.id : '',
  )
  assert.ok(['failed', 'rejected', 'submission-unknown'].includes(op?.state ?? ''), op?.state)
  assert.equal((await coordinator2.store.session(h.session.id))?.nativeSessionId, nativeId)
  await coordinator2.close()
})
