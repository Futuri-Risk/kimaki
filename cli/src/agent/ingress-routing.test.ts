// ZK-005 ingress matrix: every ingress kind × backend=zcode must refuse or gate
// WITHOUT a single OpenCode initialization/SDK call, while backend=opencode (or
// no session) keeps the baseline allow. The OpenCode module is mocked so any
// accidental init call fails the matrix, not just the unit. — ZCode 2026-09-17
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import type { Message, ThreadChannel } from 'discord.js'

const opencodeInit = vi.hoisted(() => vi.fn())

// Real module has no import-time side effects (const/let declarations only);
// spread it so transitively imported modules keep their named exports while the
// initialization entry point becomes the spy the matrix asserts on.
vi.mock('../opencode.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  initializeOpencodeForDirectory: opencodeInit,
}))

const db = vi.hoisted(() => ({
  threadSessions: new Map<string, string>(),
  activeRuns: [] as Array<{
    id: number
    session_id: string | null
    started_at: Date
    project_directory: string | null
  }>,
  finishedRuns: [] as number[],
}))

vi.mock('../database.js', () => ({
  getThreadSession: vi.fn(async (threadId: string) => db.threadSessions.get(threadId)),
  getActiveScheduledTaskRuns: vi.fn(async () => db.activeRuns),
  finishScheduledTaskRun: vi.fn(async ({ runId }: { runId: number }) => {
    db.finishedRuns.push(runId)
  }),
}))

const sidecar = vi.hoisted(() => ({
  activeOperations: 0,
  counted: [] as string[],
}))

vi.mock('./host-sidecar.js', () => ({
  lookupBackendSidecar: vi.fn(),
  countActiveNativeOperations: vi.fn(async (sessionId: string) => {
    sidecar.counted.push(sessionId)
    return sidecar.activeOperations
  }),
}))

import {
  gateThreadCommand,
  gateThreadMessage,
  isRuntimeAutocomplete,
  isRuntimeSlashCommand,
  resolveIngressBackend,
  resolveThreadBackendByChannelId,
  runtimeCommandForComponent,
  setNativeCapabilityProvider,
} from './ingress-gate.js'
import { preprocessExistingThreadMessage } from '../message-preprocessing.js'
import { hasRunningSession } from '../task-runner.js'
import { AgentError } from './native/errors.js'
import type { ScheduledTask } from '../database.js'

const zcLookup = async (sessionId: string) =>
  sessionId.startsWith('zc:') ? { backend: 'zcode' as const } : undefined

const opencodeLookup = async () => undefined

function assertZeroOpenCodeCalls() {
  assert.equal(opencodeInit.mock.calls.length, 0)
}

function fakeMessage(content: string): Message {
  return {
    content,
    mentions: { users: new Map(), roles: new Map(), channels: new Map() },
    attachments: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    reference: undefined,
    author: { id: 'u1', bot: false, displayName: 'User' },
  } as unknown as Message
}

function fakeThread(id: string): ThreadChannel {
  return { id } as unknown as ThreadChannel
}

function taskFixture(): ScheduledTask {
  return {
    id: 7,
    schedule_kind: 'cron',
    status: 'planned',
    payload_json: '{}',
    project_directory: 'C:/repo',
    cron_expr: '* * * * *',
    timezone: 'UTC',
    next_run_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  } as unknown as ScheduledTask
}

describe('ingress matrix — every ingress kind × backend=zcode refuses with zero OpenCode calls', () => {
  beforeEach(() => {
    opencodeInit.mockReset()
  })

  afterEach(() => {
    setNativeCapabilityProvider(() => false)
    db.finishedRuns = []
    sidecar.counted = []
    sidecar.activeOperations = 0
  })

  test('ordinary existing-thread message refuses visibly', async () => {
    const backend = await resolveIngressBackend('zc:matrix-1', zcLookup)
    const gate = gateThreadMessage(backend)
    assert.equal(gate.kind, 'refuse')
    assert.match(gate.kind === 'refuse' ? gate.reason : '', /native ZCode session/)
    assertZeroOpenCodeCalls()
  })

  test('.btw suffix dispatch refuses (native fork capability lands with ZK-011)', async () => {
    const backend = await resolveIngressBackend('zc:matrix-2', zcLookup)
    const gate = gateThreadCommand(backend, 'btw')
    assert.equal(gate.kind, 'refuse')
    assert.match(gate.kind === 'refuse' ? gate.reason : '', /OpenCode fallback is prohibited/)
    assertZeroOpenCodeCalls()
  })

  test('runtime slash commands refuse; host-owned slash commands are not classified runtime', async () => {
    const backend = await resolveIngressBackend('zc:matrix-3', zcLookup)
    for (const command of ['abort', 'model', 'queue', 'fork', 'share', 'undo']) {
      assert.equal(gateThreadCommand(backend, command).kind, 'refuse', command)
    }
    // Host-owned commands keep host routing (never reach the capability gate).
    for (const command of ['diff', 'new-worktree', 'add-project', 'login', 'tasks', 'vscode']) {
      assert.equal(isRuntimeSlashCommand(command), false, command)
    }
    assert.equal(isRuntimeSlashCommand('abort'), true)
    assert.equal(isRuntimeSlashCommand('fix-tests-cmd'), true)
    assert.equal(isRuntimeSlashCommand('review-skill'), true)
    assert.equal(isRuntimeSlashCommand('triage-mcp-prompt'), true)
    assert.equal(isRuntimeSlashCommand('reviewer-agent'), true)
    // Base /agent is the session agent picker (runtime); its autocomplete is the
    // plain picker feed and is NOT the quick-agent path (matches the handler).
    assert.equal(isRuntimeSlashCommand('agent'), true)
    assertZeroOpenCodeCalls()
  })

  test('autocomplete classification gates only runtime feeds', () => {
    assert.equal(isRuntimeAutocomplete('resume'), true)
    assert.equal(isRuntimeAutocomplete('queue-command'), true)
    assert.equal(isRuntimeAutocomplete('reviewer-agent'), true)
    assert.equal(isRuntimeAutocomplete('new-session'), false)
    assert.equal(isRuntimeAutocomplete('add-project'), false)
    assert.equal(isRuntimeAutocomplete('new-worktree'), false)
    assert.equal(isRuntimeAutocomplete('agent'), false)
  })

  test('component interactions map to runtime commands; host components stay free', async () => {
    assert.equal(runtimeCommandForComponent('model_select:abc'), 'model')
    assert.equal(runtimeCommandForComponent('permission_once:x'), 'permission')
    assert.equal(runtimeCommandForComponent('action_button:y'), 'action-button')
    assert.equal(runtimeCommandForComponent('ask_question:z'), 'ask-question')
    assert.equal(runtimeCommandForComponent('fork_select:q'), 'fork')
    assert.equal(runtimeCommandForComponent('mcp_toggle:m'), 'mcp')
    // Host-owned components never gate.
    assert.equal(runtimeCommandForComponent('file_upload_btn:1'), undefined)
    assert.equal(runtimeCommandForComponent('html_action:2'), undefined)
    assert.equal(runtimeCommandForComponent('transcription_apikey:3'), undefined)
    assert.equal(runtimeCommandForComponent('login_text_btn:4'), undefined)
    const backend = await resolveIngressBackend('zc:matrix-4', zcLookup)
    const modelCommand = runtimeCommandForComponent('model_select:abc')
    assert.equal(gateThreadCommand(backend, modelCommand!).kind, 'refuse')
    assertZeroOpenCodeCalls()
  })

  test('interaction gate resolves the thread backend through the thread-session mapping', async () => {
    db.threadSessions.set('thread-zc', 'zc:matrix-5')
    db.threadSessions.set('thread-oc', 'ses_opencode')
    db.threadSessions.set('thread-none', '')
    assert.equal(await resolveThreadBackendByChannelId('thread-zc', zcLookup), 'zcode')
    assert.equal(await resolveThreadBackendByChannelId('thread-oc', zcLookup), 'opencode')
    assert.equal(await resolveThreadBackendByChannelId('thread-none', zcLookup), null)
    assert.equal(await resolveThreadBackendByChannelId(undefined, zcLookup), null)
    assertZeroOpenCodeCalls()
  })

  test('preprocessing an existing zc: thread message skips OpenCode enrichment end-to-end', async () => {
    db.threadSessions.set('thread-zc', 'zc:matrix-6')
    const result = await preprocessExistingThreadMessage({
      message: fakeMessage('hello from a native thread'),
      thread: fakeThread('thread-zc'),
      projectDirectory: 'C:/repo',
      channelId: 'chan-1',
      isCliInjected: false,
      hasVoiceAttachment: false,
      appId: undefined,
    })
    assert.equal(result.skip, undefined)
    assert.equal(result.prompt, 'hello from a native thread')
    assertZeroOpenCodeCalls()
  })

  test('scheduled-task concurrency check reads the sidecar for zc: runs, never the OpenCode status endpoint', async () => {
    // Idle native run: concurrency not blocked, run finalized via the sidecar.
    db.activeRuns = [
      { id: 41, session_id: 'zc:run-1', started_at: new Date(), project_directory: 'C:/repo' },
    ]
    sidecar.activeOperations = 0
    assert.equal(await hasRunningSession(taskFixture()), false)
    assert.deepEqual(sidecar.counted, ['zc:run-1'])
    assert.deepEqual(db.finishedRuns, [41])
    assertZeroOpenCodeCalls()

    // Busy native run: concurrency blocked without a single OpenCode call.
    sidecar.activeOperations = 2
    sidecar.counted = []
    db.finishedRuns = []
    assert.equal(await hasRunningSession(taskFixture()), true)
    assert.deepEqual(sidecar.counted, ['zc:run-1'])
    assert.deepEqual(db.finishedRuns, [])
    assertZeroOpenCodeCalls()
  })
})

describe('ingress matrix — backend=opencode and no-session baselines stay unchanged', () => {
  beforeEach(() => {
    opencodeInit.mockReset()
  })

  test('ordinary messages, commands, and components on OpenCode threads allow', async () => {
    const backend = await resolveIngressBackend('ses_opencode', opencodeLookup)
    assert.equal(backend, 'opencode')
    assert.equal(gateThreadMessage(backend).kind, 'allow')
    for (const command of ['abort', 'model', 'btw', 'fork']) {
      assert.equal(gateThreadCommand(backend, command).kind, 'allow', command)
    }
    assert.equal(gateThreadMessage(null).kind, 'allow')
    assert.equal(gateThreadCommand(null, 'abort').kind, 'allow')
    assertZeroOpenCodeCalls()
  })

  test('opencode scheduled runs still query the OpenCode status endpoint (backend-driven branch, not blanket)', async () => {
    opencodeInit.mockResolvedValue(() => ({
      session: {
        status: async () => ({
          error: undefined,
          data: { ses_oc_1: { type: 'idle' } },
        }),
      },
    }))
    db.activeRuns = [
      { id: 43, session_id: 'ses_oc_1', started_at: new Date(), project_directory: 'C:/repo' },
    ]
    assert.equal(await hasRunningSession(taskFixture()), false)
    assert.equal(opencodeInit.mock.calls.length, 1)
    assert.deepEqual(db.finishedRuns, [43])
    db.finishedRuns = []
  })

  test('a zc: session without a sidecar row is an integrity failure, never an OpenCode fallback', async () => {
    await assert.rejects(
      () => resolveIngressBackend('zc:missing', async () => undefined),
      (error: unknown) => {
        assert.ok(error instanceof AgentError)
        assert.equal(error.code, 'SESSION_SIDECAR_MISSING')
        return true
      },
    )
    assertZeroOpenCodeCalls()
  })

  test('a native capability provider (ZK-008 seam) unlocks native commands only', async () => {
    const backend = await resolveIngressBackend('zc:matrix-capable', zcLookup)
    setNativeCapabilityProvider((command) => command === 'abort')
    assert.equal(gateThreadCommand(backend, 'abort').kind, 'allow')
    assert.equal(gateThreadCommand(backend, 'model').kind, 'refuse')
    setNativeCapabilityProvider(() => false)
    assert.equal(gateThreadCommand(backend, 'abort').kind, 'refuse')
    assertZeroOpenCodeCalls()
  })
})
