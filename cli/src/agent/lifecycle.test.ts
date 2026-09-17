// ZK-007 real-backend lifecycle suite — the ported bundle lifecycle tests against
// the actual ZcodeBackend + spawned SYNTHETIC fake-app-server (owned process
// launch). Owned launch is PLATFORM_UNCERTIFIED on Windows by design, so this
// suite is Linux-gated on this machine (visible skips, mirroring the ZK-002
// convention). The in-process coordinator contracts run cross-platform in
// coordinator.test.ts. Not ported: owner-process/journal-owner SIGKILL children —
// supervisor kill semantics are covered by the ZK-002 native suite (gated) and
// the durable send-intent recovery by store.test.ts + coordinator.test.ts.
// — ZCode 2026-09-17
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

const linuxOnly = process.platform === 'win32' ? test.skip : test
const entry = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url))

async function until<T>(
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  message: string,
  timeout = 6000,
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

type Scenario = 'normal' | 'resume-reject' | 'uncorrelated-guide' | 'ignore-stop' | 'replay-history'

async function lifecycleHarness(scenario: Scenario = 'normal', timeoutMs = 5000) {
  const h = await createStoreHarness()
  const home = h.session.workspace.nativeHomeIdentity
  const repo = h.session.workspace.canonicalDirectory
  const exeHash = await fileHash(process.execPath)
  const entryHash = await fileHash(entry)
  const launchProfile = NativeProfileLaunch(entry, home, scenario, exeHash, entryHash)
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
    launch: launchProfile,
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
  const coordinators = [coordinator]
  const track = (c: AgentCoordinator) => coordinators.push(c)
  const submit = async (
    sourceId: string,
    text: string,
    kind: 'prompt' | 'guide' | 'answer' | 'cancel' | 'model' = 'prompt',
    payload?: unknown,
  ) => {
    const r = await coordinator.ingest(h.input(sourceId, text, kind, payload))
    assert.equal(r.ok, true, JSON.stringify(r.ok ? '' : r.error.toJSON()))
    return r.value
  }
  const completed = async (opId: string, state = 'completed') => {
    await until(async () => (await h.store.operation(opId))?.state === state, state)
  }
  const closeAll = async () => {
    for (const c of coordinators.reverse()) {
      await c.close()
    }
    await delay(50)
  }
  // vitest cleanup that works with the skip-gate
  onTestFinished(async () => {
    for (const c of coordinators) {
      await c.close().catch(() => undefined)
    }
    await delay(50).catch(() => undefined)
  })
  const native = async () =>
    JSON.parse(await readFile(path.join(home, 'native.json'), 'utf8')) as {
      creates: number
      resumes: number
      sends: Array<{ sessionId: string; content: string }>
      answers: unknown[]
      sessions: Record<string, { model: { modelId: string } }>
    }
  const scenarioLaunch = (scenarioOverride: Scenario) => (cwd: string) => ({
    ...launchProfile(cwd),
    args: [entry, home, scenarioOverride],
  })
  return {
    ...h,
    backend,
    coordinator,
    track,
    submit,
    completed,
    closeAll,
    native,
    baseProfile: () => profile,
    resumeRejectProfile: () => ({ ...profile, launch: scenarioLaunch('resume-reject') }),
    replayProfile: () => ({ ...profile, launch: scenarioLaunch('replay-history') }),
  }
}

function NativeProfileLaunch(
  entryPath: string,
  home: string,
  scenario: Scenario,
  exeHash: string,
  entryHash: string,
): NativeProfile['launch'] {
  return (cwd) => ({
    executable: process.execPath,
    args: [entryPath, home, scenario],
    executableSha256: exeHash,
    entryPath,
    entrySha256: entryHash,
    cwd,
    environment: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    graceMs: 100,
    startupMs: 3000,
  })
}

describe('ZcodeBackend lifecycle (real owned process, synthetic codec)', () => {
  linuxOnly(
    'graceful restart resumes the persisted native SID and never replays the old prompt',
    async () => {
      const h = await lifecycleHarness()
      const first = await h.submit('one', 'first')
      await h.completed(first.id)
      await h.coordinator.settle()
      const nativeId = (await h.store.session(h.session.id))?.nativeSessionId
      assert.equal((await h.coordinator.close()).ok, true)
      const backend = new ZcodeBackend(h.baseProfile())
      const resumed = new AgentCoordinator(h.store, backend, async (a) => a === 'actor-1')
      h.track(resumed)
      const second = await resumed.ingest(h.input('two', 'second'))
      assert.equal(second.ok, true)
      await until(
        async () =>
          (await h.store.operation(second.ok ? second.value.id : ''))?.state === 'completed',
        'second completed',
      )
      const state = await h.native()
      assert.equal(state.creates, 1)
      assert.equal(state.resumes, 1)
      assert.deepEqual(
        state.sends.map((s) => s.sessionId),
        [nativeId, nativeId],
      )
      assert.deepEqual(
        state.sends.map((s) => s.content),
        ['first', 'second'],
      )
      await h.closeAll()
    },
  )

  linuxOnly('failed native resume does not silently create another session', async () => {
    const h = await lifecycleHarness()
    const first = await h.submit('one', 'first')
    await h.completed(first.id)
    await h.coordinator.settle()
    const id = (await h.store.session(h.session.id))?.nativeSessionId
    await h.coordinator.close()
    const profile = h.resumeRejectProfile()
    const backend = new ZcodeBackend(profile)
    const resumed = new AgentCoordinator(h.store, backend, async () => true)
    h.track(resumed)
    const second = await resumed.ingest(h.input('two', 'must not start'))
    assert.equal(second.ok, true)
    await until(
      async () => (await h.store.operation(second.ok ? second.value.id : ''))?.state === 'rejected',
      'rejected',
    )
    assert.equal((await h.store.session(h.session.id))?.nativeSessionId, id)
    const state = await h.native()
    assert.equal(state.creates, 1)
    assert.equal(state.sends.length, 1)
    await h.closeAll()
  })

  linuxOnly(
    'stale native approval cannot answer a new request with a reused numeric RPC ID',
    async () => {
      const h = await lifecycleHarness()
      const first = await h.submit('one', 'permission')
      const old = await until(() => h.backend.pendingInteractions[0], 'first permission')
      const answer = await h.submit('answer', '', 'answer', {
        interactionId: old.id,
        answer: { kind: 'permission', decision: 'allow-once' },
      })
      await h.completed(answer.id)
      await h.completed(first.id)
      await h.coordinator.settle()
      await h.coordinator.close()
      const backend = new ZcodeBackend(h.baseProfile())
      const resumed = new AgentCoordinator(h.store, backend, async () => true)
      h.track(resumed)
      const next = await resumed.ingest(h.input('two', 'permission'))
      assert.equal(next.ok, true)
      const current = await until(() => backend.pendingInteractions[0], 'new permission')
      assert.equal(current.requestId, old.requestId)
      assert.notEqual(current.generation, old.generation)
      await assert.rejects(
        () => backend.answer(old, { kind: 'permission', decision: 'allow-once' }),
        {
          code: 'INTERACTION_STALE',
        },
      )
      assert.equal((await h.native()).answers.length, 1)
      await h.closeAll()
    },
  )

  linuxOnly(
    'unconfirmed guide application is fenced, not silently converted into another prompt',
    async () => {
      const h = await lifecycleHarness('uncorrelated-guide')
      const first = await h.submit('one', 'hold')
      await h.completed(first.id, 'running')
      const guide = await h.submit('guide', 'finish-current', 'guide')
      await h.completed(first.id)
      await h.completed(guide.id, 'submission-unknown')
      assert.equal((await h.store.session(h.session.id))?.state, 'recovery-required')
      assert.ok((await h.store.leases()).length > 0)
      assert.equal((await h.native()).sends.length, 1)
      assert.ok(h.coordinator.diagnostics.includes('GUIDE_CORRELATION_UNCERTIFIED'))
      await h.closeAll()
    },
  )

  linuxOnly(
    'unresponsive native stop escalates only the owned group and confirms cessation of writes',
    async () => {
      const h = await lifecycleHarness('ignore-stop')
      const first = await h.submit('one', 'hold')
      await h.completed(first.id, 'running')
      const ticks = path.join(h.session.workspace.canonicalDirectory, 'foreground.ticks')
      await until(async () => {
        try {
          return (await stat(ticks)).size > 0
        } catch {
          return false
        }
      }, 'writer ticks')
      const cancel = await h.submit('stop', '', 'cancel')
      await h.completed(cancel.id)
      const size = (await stat(ticks)).size
      await delay(150)
      assert.equal((await stat(ticks)).size, size)
      assert.equal((await h.store.operation(first.id))?.state, 'cancelled')
      await h.closeAll()
    },
  )

  linuxOnly(
    'changed fingerprint refuses before any native process or task submission',
    async () => {
      const h = await lifecycleHarness()
      const profile = {
        ...h.baseProfile(),
        launch: (cwd: string) => ({ ...h.baseProfile().launch(cwd), entrySha256: '0'.repeat(64) }),
      }
      const backend = new ZcodeBackend(profile)
      await assert.rejects(() => backend.prepare({ ...h.session, state: 'creating-intent' }), {
        code: 'RUNTIME_UNCERTIFIED',
      })
      await assert.rejects(
        () => readFile(path.join(h.session.workspace.nativeHomeIdentity, 'native.json')),
        { code: 'ENOENT' },
      )
      await h.closeAll()
    },
  )

  linuxOnly(
    'persisted legacy cursor prevents old live-labelled events reappearing after restart',
    async () => {
      const h = await lifecycleHarness()
      const first = await h.submit('one', 'first')
      await h.completed(first.id)
      await h.coordinator.settle()
      const prior = (await h.store.streamCursor(h.session.id, 'legacy'))?.sequence
      await h.coordinator.close()
      const profile = h.replayProfile()
      const backend = new ZcodeBackend(profile)
      const resumed = new AgentCoordinator(h.store, backend, async () => true)
      h.track(resumed)
      const next = await resumed.ingest(h.input('two', 'second'))
      assert.equal(next.ok, true)
      await until(
        async () => (await h.store.operation(next.ok ? next.value.id : ''))?.state === 'completed',
        'completed',
      )
      const out = await h.db.execute('SELECT payload_json FROM agent_outbox')
      assert.ok(!out.rows.some((r) => String(r.payload_json).includes('REPLAY MUST NOT DISPLAY')))
      assert.equal(
        out.rows.filter((r) => String(r.payload_json).includes('Done ✓ first')).length,
        1,
      )
      const calls = (
        await readFile(path.join(h.session.workspace.nativeHomeIdentity, 'calls.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method: string; params: { afterSeq?: number } })
      assert.equal(
        calls.filter((c) => c.method === 'session/subscribe').at(-1)?.params.afterSeq,
        prior,
      )
      await h.closeAll()
    },
  )
})
