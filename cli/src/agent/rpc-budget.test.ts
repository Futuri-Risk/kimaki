// #29 RPC-budget suite — admission/model-change session/read budget (≤2 per
// cycle) and bounded cancel-settle reads (no 20 ms full-snapshot polling loop;
// per-task background cancels issued together). Real ZcodeBackend + spawned
// SYNTHETIC fake-app-server on the same lane as lifecycle.test.ts; counts come
// from the fixture's calls.jsonl RPC log. — ZCode 2026-09-28
import { describe, onTestFinished, test } from 'vitest'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

import { AgentCoordinator } from './coordinator.js'
import { ZcodeBackend, type NativeProfile } from './zcode-backend.js'
import { fileHash } from './native/process.js'
import { createStoreHarness } from './test-harness.js'
import { fakeCodec } from './fixtures/fake-codec.js'

const entry = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url))

async function until<T>(
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  message: string,
  timeout = 25000, // win32 job-keeper startup adds seconds per launch (ZK-016)
): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const r = await fn()
    if (r) {
      return r
    }
    await delay(10)
  }
  throw new Error(`Timed out: ${message}`)
}

type Scenario = 'normal' | 'ignore-stop'
type LoggedCall = { method: string }

async function rpcHarness(scenario: Scenario = 'normal', timeoutMs = 20000) {
  const h = await createStoreHarness()
  const home = h.session.workspace.nativeHomeIdentity
  const exeHash = await fileHash(process.execPath)
  const entryHash = await fileHash(entry)
  const profile: NativeProfile = {
    id: 'test-profile',
    revision: 'r1',
    enabled: true,
    mode: 'build',
    codec: fakeCodec,
    allowSynthetic: true,
    preferences: {
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: false,
    },
    display: 'legacy',
    launch: (cwd) => ({
      executable: process.execPath,
      args: [entry, home, scenario],
      executableSha256: exeHash,
      entryPath: entry,
      entrySha256: entryHash,
      cwd,
      environment: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      graceMs: 100,
      startupMs: 20000, // win32 job-keeper startup (ZK-016)
    }),
    timeoutMs,
    cancelGraceMs: 150,
    imageCapability: false,
    attachmentRoot: path.join(h.root, 'attachments'),
    redact: (value) => value,
  }
  const backend = new ZcodeBackend(profile)
  const coordinator = new AgentCoordinator(
    h.store,
    backend,
    async (actor, thread, s) => actor === 'actor-1' && thread === s.controllerThreadId,
  )
  onTestFinished(async () => {
    await coordinator.close().catch(() => undefined)
    await delay(50).catch(() => undefined)
  })
  const submit = async (
    sourceId: string,
    text: string,
    kind: 'prompt' | 'cancel' | 'model' = 'prompt',
    payload?: unknown,
  ) => {
    const r = await coordinator.ingest(h.input(sourceId, text, kind, payload))
    assert.equal(r.ok, true, JSON.stringify(r.ok ? '' : r.error.toJSON()))
    return r.value
  }
  const waitForState = async (opId: string, state: string) =>
    until(async () => (await h.store.operation(opId))?.state === state, state)
  // The fake server appends one line per received request to calls.jsonl.
  const calls = async (): Promise<LoggedCall[]> => {
    try {
      return (await readFile(path.join(home, 'calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LoggedCall)
    } catch {
      return []
    }
  }
  const count = (list: LoggedCall[], method: string) =>
    list.filter((c) => c.method === method).length
  const ticksStopped = async (name: string) => {
    const file = path.join(h.session.workspace.canonicalDirectory, `${name}.ticks`)
    const size = (await stat(file)).size
    await delay(150)
    assert.equal((await stat(file)).size, size, `${name} worker kept writing after cancel`)
  }
  return { ...h, backend, coordinator, submit, waitForState, calls, count, ticksStopped }
}

describe('ZcodeBackend RPC budget (real owned process, synthetic codec)', () => {
  test(
    'prompt admission stays within the session/read budget (cold and warm)',
    { timeout: 90000 },
    async () => {
      const h = await rpcHarness()
      const first = await h.submit('one', 'first')
      await h.waitForState(first.id, 'completed')
      await h.coordinator.settle()
      const cold = await h.calls()
      assert.equal(h.count(cold, 'session/create'), 1)
      assert.equal(h.count(cold, 'session/send'), 1)
      assert.ok(
        h.count(cold, 'session/read') <= 2,
        `cold admission session/read budget exceeded: ${h.count(cold, 'session/read')}`,
      )
      const second = await h.submit('two', 'second')
      await h.waitForState(second.id, 'completed')
      await h.coordinator.settle()
      const warm = (await h.calls()).slice(cold.length)
      assert.equal(h.count(warm, 'session/send'), 1)
      assert.ok(
        h.count(warm, 'session/read') <= 2,
        `warm admission session/read budget exceeded: ${h.count(warm, 'session/read')}`,
      )
    },
  )

  test(
    'model change stays within the session/read budget',
    { timeout: 90000 },
    async () => {
      const h = await rpcHarness()
      const first = await h.submit('one', 'first')
      await h.waitForState(first.id, 'completed')
      await h.coordinator.settle()
      const before = (await h.calls()).length
      const model = await h.submit('model', '', 'model', {
        providerId: 'fixture',
        modelId: 'changed-model',
        reasoning: 'high',
        revision: 'r1',
      })
      await h.waitForState(model.id, 'completed')
      await h.coordinator.settle()
      const delta = (await h.calls()).slice(before)
      assert.equal(h.count(delta, 'session/setModel'), 1)
      assert.equal(h.count(delta, 'session/setThoughtLevel'), 1)
      assert.ok(
        h.count(delta, 'session/read') <= 2,
        `model-change session/read budget exceeded: ${h.count(delta, 'session/read')}`,
      )
      assert.equal((await h.store.session(h.session.id))?.model.modelId, 'changed-model')
    },
  )

  test(
    'cancel settles an active background task with bounded reads and a dead worker',
    { timeout: 90000 },
    async () => {
      const h = await rpcHarness()
      const first = await h.submit('one', 'background')
      await h.waitForState(first.id, 'foreground-terminal')
      await h.coordinator.settle()
      // The background worker must be observably alive before cancelling.
      await until(async () => {
        try {
          return (await stat(path.join(h.session.workspace.canonicalDirectory, 'background.ticks'))).size > 0
        } catch {
          return false
        }
      }, 'background worker ticks')
      const before = (await h.calls()).length
      const cancel = await h.submit('stop', '', 'cancel')
      await h.waitForState(cancel.id, 'completed')
      const delta = (await h.calls()).slice(before)
      assert.equal(h.count(delta, 'session/cancelBackgroundTask'), 1)
      // 3 typical (pre-stop read + settle read + activity reconcile) with
      // margin for one racing reconcile readback.
      assert.ok(
        h.count(delta, 'session/read') <= 4,
        `cancel settle session/read unbounded: ${h.count(delta, 'session/read')}`,
      )
      await h.ticksStopped('background')
      assert.equal((await h.store.operation(first.id))?.state, 'cancelled')
    },
  )

  test(
    'unsettled native cancel is deadline-bound, not a 20 ms full-snapshot read loop',
    { timeout: 90000 },
    async () => {
      const h = await rpcHarness('ignore-stop')
      const first = await h.submit('one', 'hold')
      await h.waitForState(first.id, 'running')
      // The foreground worker must be observably alive before cancelling.
      await until(async () => {
        try {
          return (await stat(path.join(h.session.workspace.canonicalDirectory, 'foreground.ticks'))).size > 0
        } catch {
          return false
        }
      }, 'writer ticks')
      const before = (await h.calls()).length
      const cancel = await h.submit('stop', '', 'cancel')
      await h.waitForState(cancel.id, 'completed')
      const delta = (await h.calls()).slice(before)
      // Old behavior polled a full snapshot every 20 ms until the 150 ms grace
      // (~8 session/read per cancel); the budget forbids that storm.
      assert.ok(
        h.count(delta, 'session/read') <= 3,
        `cancel settle session/read storm: ${h.count(delta, 'session/read')}`,
      )
      await h.ticksStopped('foreground')
      assert.equal((await h.store.operation(first.id))?.state, 'cancelled')
    },
  )
})
