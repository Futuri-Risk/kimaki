// ZK-011 /btw native-fork contract tests over the REAL coordinator (in-process
// fake-native backend): capability-gated refusal, fork-before-thread ordering,
// orphan-bound child + explicit controller activation, prompt dispatch on the
// child, H41-style fork-point refusal, and OpenCode-path-untouched pins.
// — ZCode 2026-09-18
import { test, expect, vi, beforeEach } from 'vitest'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const threadBindings: Array<[string, string]> = []
const sessionForThread: Record<string, string | null> = { 'thread-src': 'SET-IN-TEST' }
const opencodeInits: number[] = []
const createdThreads: Array<{ name: string }> = []
const sentMessages: string[] = []
const harnessHolder: { value: import('../agent/coordinator.js').AgentCoordinator | null } = {
  value: null,
}

vi.mock('../database.js', () => ({
  getThreadSession: async (threadId: string) => sessionForThread[threadId] ?? null,
  setThreadSession: async (threadId: string, sessionId: string) => {
    threadBindings.push([threadId, sessionId])
  },
}))
const sidecarSessions = new Set<string>()
vi.mock('../agent/host-sidecar.js', () => ({
  lookupBackendSidecar: async (sessionId: string) =>
    sidecarSessions.has(sessionId) ? { backend: 'zcode' } : undefined,
}))
vi.mock('../agent/host-coordinator.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getNativeCoordinator: async () => harnessHolder.value,
}))
vi.mock('../opencode.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  initializeOpencodeForDirectory: async () => {
    opencodeInits.push(Date.now())
    throw new Error('OpenCode must not be initialized for native /btw tests')
  },
}))
vi.mock('../discord-utils.js', () => ({
  sendThreadMessage: async (_thread: unknown, content: string) => {
    sentMessages.push(content)
  },
  resolveTextChannel: async () => ({
    threads: {
      create: async (options: { name: string }) => {
        createdThreads.push({ name: options.name })
        return {
          id: 'thread-new',
          parentId: 'chan-1',
          toString: () => '<#thread-new>',
          members: { add: async () => undefined },
        }
      },
    },
  }),
}))

beforeEach(() => {
  createdThreads.length = 0
  threadBindings.length = 0
  sentMessages.length = 0
  opencodeInits.length = 0
})

import { forkSessionToNativeBtwThread } from './btw.js'
import { NATIVE_FORK_CAPABILITY } from '../agent/native-profile.js'
import { fail } from '../agent/errors.js'
import { coordinatorHarness } from '../agent/coordinator.test.js'
import type { ThreadChannel } from 'discord.js'

async function nativeHarness(enableFork: boolean) {
  const h = await coordinatorHarness()
  // The source thread must be the session's controller thread (host authorizer).
  sessionForThread[h.session.controllerThreadId] = h.session.id
  sidecarSessions.add(h.session.id)
  harnessHolder.value = h.coordinator
  const preferences = h.backend.profile.preferences as Record<string, boolean>
  preferences[NATIVE_FORK_CAPABILITY] = enableFork
  let forks = 0
  h.backend.fork = async () => {
    forks++
    return 'native-child-1'
  }
  return { ...h, forkCount: () => forks }
}

const btwArgs = (
  h: { session: { controllerThreadId: string } },
  overrides: Record<string, unknown> = {},
) => ({
  sourceThread: {
    id: h.session.controllerThreadId,
    parentId: 'chan-1',
  } as unknown as ThreadChannel,
  projectDirectory: 'C:/dev/proj',
  prompt: 'side question',
  userId: 'actor-1',
  username: 'Actor',
  appId: undefined,
  ...overrides,
})

test('native /btw forks before thread creation, activates the orphan, and dispatches on the child', async () => {
  const h = await nativeHarness(true)
  const result = await forkSessionToNativeBtwThread(btwArgs(h))
  assert.ok(
    !(result instanceof Error) && result !== 'not-native',
    result instanceof Error ? result.message : '',
  )
  const childId = result.forkedSessionId
  assert.ok(childId.startsWith('zc:'))
  assert.equal(h.forkCount(), 1)
  assert.deepEqual(
    createdThreads.map((t) => t.name),
    ['btw: side question'],
  )
  assert.deepEqual(threadBindings, [['thread-new', childId]])
  const child = await h.store.session(childId)
  assert.equal(child?.state, 'idle')
  assert.equal(child?.controllerThreadId, 'thread-new')
  assert.equal(child?.nativeSessionId, 'native-child-1')
  assert.equal(child?.backend, 'zcode')
  // The side-question prompt runs on the CHILD session through the coordinator.
  const ops = await h.store.operations(childId)
  assert.ok(
    ops.some(
      (o) =>
        o.kind === 'prompt' &&
        ['queued', 'preparing', 'send-intent', 'running', 'completed'].includes(o.state),
    ),
  )
  assert.deepEqual(opencodeInits, [])
  await h.coordinator.close()
})

test('capability off refuses visibly and creates nothing', async () => {
  const h = await nativeHarness(false)
  const result = await forkSessionToNativeBtwThread(btwArgs(h))
  assert.ok(result instanceof Error)
  assert.match(result.message, /certified fork capability/)
  assert.deepEqual(createdThreads, [])
  assert.deepEqual(threadBindings, [])
  assert.equal(await h.store.latestChildSession(h.session.id), null)
  assert.deepEqual(opencodeInits, [])
  await h.coordinator.close()
})

test('an invalid fork point (H41 semantics) rejects the control and creates no thread or child', async () => {
  const h = await nativeHarness(true)
  h.backend.forkPoint = async () => {
    throw fail('FORK_POINT_INVALID', 'No forkable row at this epoch.', 'control')
  }
  const result = await forkSessionToNativeBtwThread(btwArgs(h))
  assert.ok(result instanceof Error)
  assert.match(result.message, /rejected|refused|FORK_POINT/)
  assert.deepEqual(createdThreads, [])
  assert.deepEqual(threadBindings, [])
  assert.equal(await h.store.latestChildSession(h.session.id), null)
  await h.coordinator.close()
})

test('controller activation is one-shot: only an orphan-bound child can bind', async () => {
  const h = await nativeHarness(true)
  const result = await forkSessionToNativeBtwThread(btwArgs(h))
  assert.ok(!(result instanceof Error) && result !== 'not-native')
  await assert.rejects(() => h.store.bindController(result.forkedSessionId, 'thread-other'), {
    code: 'SESSION_NOT_ORPHAN',
  } as never)
  await h.coordinator.close()
})

test('attachments on native forks fail closed', async () => {
  const h = await nativeHarness(true)
  const result = await forkSessionToNativeBtwThread(btwArgs(h, { images: [{}] as never }))
  assert.ok(result instanceof Error)
  assert.match(result.message, /Attachments are not supported/)
  assert.deepEqual(createdThreads, [])
  await h.coordinator.close()
})

test('non-native sessions fall through to the OpenCode flow untouched', async () => {
  sessionForThread['thread-src'] = 'ses_opencode_123'
  const result = await forkSessionToNativeBtwThread(
    btwArgs({ session: { controllerThreadId: 'thread-src' } } as never),
  )
  assert.equal(result, 'not-native')
})

test('source pin: OpenCode fork call remains after the native branch', async () => {
  const source = (await readFile(fileURLToPath(new URL('./btw.ts', import.meta.url)), 'utf8')).replace(/[\s]+/g, ' ')
  // Native branch first; the OpenCode session.fork call still present below it
  // (whitespace-normalized so formatting cannot break the pin).
  assert.ok(
    source.indexOf('forkSessionToNativeBtwThread({') <
      source.indexOf('session.fork({ sessionID: sessionId'),
  )
  assert.ok(source.includes('initializeOpencodeForDirectory(projectDirectory)'))
  expect(true).toBe(true)
})
