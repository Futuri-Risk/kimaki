// ZK-010 control-surface contract tests over the REAL coordinator (in-process
// fake-native backend): verified-stop cancel, native-only compact, durable FIFO
// queue with pre-intent-only clearing, readback-only model status, backend
// detection fallbacks, and source-order pins that the native branch in
// compact.ts/model.ts precedes any OpenCode server call. — ZCode 2026-09-18
import { test, expect, vi } from 'vitest'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const harnessSession = { id: 'zc:test-session' }
const harnessCoordinator: { value: import('./coordinator.js').AgentCoordinator | null } = {
  value: null,
}

vi.mock('../database.js', () => ({
  getThreadSession: async (threadId: string) =>
    threadId === 'thread-1' ? harnessSession.id : null,
}))
vi.mock('./host-sidecar.js', () => ({
  lookupBackendSidecar: async () => ({ backend: 'zcode' }),
}))
vi.mock('./host-coordinator.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getNativeCoordinator: async () => harnessCoordinator.value,
}))

import {
  clearNativeQueue,
  describeNativeControl,
  isNativeThread,
  nativeModelStatus,
  queueNativePrompt,
  runNativeControl,
} from './control-commands.js'
import { coordinatorHarness } from './test-harness.js'

async function controlHarness() {
  const h = await coordinatorHarness()
  harnessSession.id = h.session.id
  harnessCoordinator.value = h.coordinator
  return h
}

test('cancel runs the verified-stop control and reports the durable state', async () => {
  const h = await controlHarness()
  h.backend.held = true
  const op = await h.submit('one', 'work')
  await h.waitForState(op.id, 'running')
  const outcome = await runNativeControl({
    threadId: 'thread-1',
    actorId: 'actor-1',
    kind: 'cancel',
  })
  assert.equal(outcome.kind, 'done')
  assert.equal(outcome.kind === 'done' && outcome.state, 'completed')
  await h.coordinator.close()
})

test('non-native threads and a dead coordinator fall through visibly', async () => {
  const h = await controlHarness()
  assert.equal(await isNativeThread('thread-other'), false)
  const offline = await runNativeControl({
    threadId: 'thread-1',
    actorId: 'actor-1',
    kind: 'cancel',
  })
  harnessCoordinator.value = null
  const dead = await runNativeControl({ threadId: 'thread-1', actorId: 'actor-1', kind: 'cancel' })
  assert.equal(dead.kind, 'offline')
  assert.equal(describeNativeControl(dead), 'The native runtime is not available right now.')
  harnessCoordinator.value = h.coordinator
  const foreign = await runNativeControl({
    threadId: 'thread-other',
    actorId: 'actor-1',
    kind: 'cancel',
  })
  assert.equal(foreign.kind, 'not-native')
  assert.equal(describeNativeControl(foreign), null)
  assert.notEqual(offline.kind, 'not-native')
  await h.coordinator.close()
})

test('compact is native-only: control path runs and no OpenCode summarize exists in the module', async () => {
  const h = await controlHarness()
  const outcome = await runNativeControl({
    threadId: 'thread-1',
    actorId: 'actor-1',
    kind: 'compact',
  })
  assert.equal(outcome.kind, 'done')
  assert.equal(outcome.kind === 'done' && outcome.state, 'completed')
  // The native control module must not even import the OpenCode client seam.
  const source = await readFile(
    fileURLToPath(new URL('./control-commands.ts', import.meta.url)),
    'utf8',
  )
  assert.equal(source.includes("from '../opencode"), false)
  await h.coordinator.close()
})

test('queued prompts are durable FIFO and clearing removes only pre-intent prompts', async () => {
  const h = await controlHarness()
  h.backend.held = true
  const first = await queueNativePrompt({ threadId: 'thread-1', actorId: 'actor-1', text: 'first' })
  assert.equal(first.kind, 'done')
  const second = await queueNativePrompt({
    threadId: 'thread-1',
    actorId: 'actor-1',
    text: 'second',
  })
  assert.equal(second.kind, 'done')
  assert.equal(second.kind === 'done' && second.state, 'queued')
  assert.equal(second.kind === 'done' && second.position, 1)
  // The in-flight turn is NOT clearable; only the still-queued prompt is.
  const removed = await clearNativeQueue({ threadId: 'thread-1' })
  assert.equal(removed, 1)
  const ops = await h.store.operations(h.session.id)
  assert.deepEqual(
    ops.map((o) => [o.kind, o.state]),
    [
      ['prompt', 'running'],
      ['prompt', 'cancelled'],
    ],
  )
  await h.coordinator.close()
})

test('model status reports only the readback-confirmed selection', async () => {
  const h = await controlHarness()
  const status = await nativeModelStatus({ threadId: 'thread-1' })
  assert.equal(status.kind, 'model')
  const expected = h.session.model
  assert.deepEqual(status.kind === 'model' && status.model, expected)
  const foreign = await nativeModelStatus({ threadId: 'thread-other' })
  assert.equal(foreign.kind, 'not-native')
  await h.coordinator.close()
})

test('source order: native branch precedes any OpenCode server call in compact.ts and model.ts', async () => {
  const here = path.dirname(fileURLToPath(new URL('./control-commands.test.ts', import.meta.url)))
  const compact = await readFile(path.join(here, '../commands/compact.ts'), 'utf8')
  const model = await readFile(path.join(here, '../commands/model.ts'), 'utf8')
  // The native branch must run BEFORE initializeOpencodeForDirectory touches
  // the OpenCode server, so a zc: thread never spins one up for these commands.
  assert.ok(
    compact.indexOf('runNativeControl') < compact.indexOf('await initializeOpencodeForDirectory'),
  )
  assert.ok(model.indexOf('isNativeThread') < model.indexOf('await initializeOpencodeForDirectory'))
  expect(true).toBe(true)
})
