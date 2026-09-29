// ZK-015 message-wiring integration tests (in-process fake-native backend +
// fake Discord client): a native thread message admits through the
// coordinator exactly once, renders through the outbox with real receipt
// semantics, queues FIFO behind a held turn, dedupes redelivery by message id,
// stages attachments, maps scheduled markers to run-keyed admissions, and
// stays OpenCode-free by construction. — ZCode 2026-09-18
import { test, expect, vi } from 'vitest'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const state = {
  sessionForThread: null as string | null,
  coordinator: null as import('./coordinator.js').AgentCoordinator | null,
  threadBindings: [] as Array<[string, string]>,
  fetchCalls: [] as string[],
}
vi.mock('../database.js', () => ({
  getThreadSession: async () => state.sessionForThread,
  upsertThreadSession: async ({ threadId, sessionId }: { threadId: string; sessionId: string }) => {
    state.threadBindings.push([threadId, sessionId])
  },
}))
vi.mock('./host-sidecar.js', () => ({
  lookupBackendSidecar: async () => ({ backend: 'zcode' }),
  countActiveNativeOperations: async () => 0,
}))
vi.mock('./host-coordinator.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getNativeCoordinator: async () => state.coordinator,
}))
vi.mock('../opencode.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  initializeOpencodeForDirectory: async () => {
    throw new Error('OpenCode must never initialize for native message wiring')
  },
}))

import {
  flushNativeOutbox,
  ingestNativeThreadMessage,
  ingestScheduledMessage,
  resetNativeOutboxRenderer,
  setNativeDiscordClient,
} from './message-ingest.js'
import { coordinatorHarness } from './test-harness.js'
import type { Cursor, DisplayPart } from './types.js'

type FakeMessage = {
  id: string
  content: string
  nonce?: string
  edited: number
  deleted: boolean
  edit: (options: { content?: string }) => Promise<void>
  delete: () => Promise<void>
}

function fakeDiscord() {
  const messages = new Map<string, FakeMessage>()
  const sends: Array<{ content: string; nonce?: string }> = []
  let counter = 0
  const thread = {
    id: 'thread-1',
    isThread: () => true,
    send: async (options: { content: string; nonce?: string }) => {
      const id = `m${++counter}`
      const message: FakeMessage = {
        id,
        content: options.content,
        nonce: options.nonce,
        edited: 0,
        deleted: false,
        edit: async (editOptions) => {
          const target = messages.get(id)!
          target.content = editOptions.content ?? target.content
          target.edited++
        },
        delete: async () => {
          messages.get(id)!.deleted = true
        },
      }
      messages.set(id, message)
      sends.push({ content: options.content, nonce: options.nonce })
      return message
    },
    messages: {
      fetch: async (query: string | { limit: number }) => {
        if (typeof query === 'string') {
          return messages.get(query) ?? null
        }
        return new Map(messages)
      },
    },
  }
  const client = {
    channels: {
      fetch: async (id: string) => (id === 'thread-1' ? thread : null),
    },
  }
  setNativeDiscordClient(client as never)
  return { sends, messages }
}

function cursor(sequence: number): Cursor {
  return { stream: 'legacy', generation: 'g1', epoch: '', sequence }
}

function part(text: string, id = 'p1', order = 1): DisplayPart {
  return { id, nativeId: id, kind: 'text', state: 'done', text, delivery: 'live', order }
}

async function wiringHarness() {
  const h = await coordinatorHarness()
  state.sessionForThread = h.session.id
  state.coordinator = h.coordinator
  const discord = fakeDiscord()
  return { ...h, discord }
}

test('a native thread message submits once, renders through the outbox, and leaves a receipt', async () => {
  const h = await wiringHarness()
  const ingest = await ingestNativeThreadMessage({
    threadId: 'thread-1',
    actorId: 'actor-1',
    text: 'summarize the repo',
    source: 'discord',
    sourceKey: 'msg-100',
  })
  assert.equal(ingest.kind, 'submitted')
  await h.coordinator.settle()
  assert.deepEqual(h.backend.submits, ['summarize the repo'])
  // The projector's output lands in the outbox; the wiring flush renders it.
  await h.store.view(h.session.id, cursor(1), [part('Done ✓ summarized')], 'thread-1')
  await flushNativeOutbox(h.coordinator, h.session.id, 1)
  assert.equal(h.discord.sends.length, 1)
  assert.equal(h.discord.sends[0]!.content, 'Done ✓ summarized')
  const rows = (await h.db.execute('SELECT state, discord_message_id FROM agent_outbox')).rows
  assert.equal(String(rows[0]!.state), 'sent')
  assert.equal(String(rows[0]!.discord_message_id), 'm1')
  await h.coordinator.close()
})

test('redelivery of the same message id dedupes to one submission', async () => {
  const h = await wiringHarness()
  for (let i = 0; i < 3; i++) {
    const ingest = await ingestNativeThreadMessage({
      threadId: 'thread-1',
      actorId: 'actor-1',
      text: 'do the thing',
      source: 'discord',
      sourceKey: 'msg-200',
    })
    assert.equal(ingest.kind, 'submitted')
  }
  await h.coordinator.settle()
  assert.deepEqual(h.backend.submits, ['do the thing'])
  await h.coordinator.close()
})

test('messages queue strictly FIFO behind a held turn', async () => {
  const h = await wiringHarness()
  h.backend.held = true
  const first = await ingestNativeThreadMessage({
    threadId: 'thread-1',
    actorId: 'actor-1',
    text: 'first',
    source: 'discord',
    sourceKey: 'msg-a',
  })
  const second = await ingestNativeThreadMessage({
    threadId: 'thread-1',
    actorId: 'actor-1',
    text: 'second',
    source: 'discord',
    sourceKey: 'msg-b',
  })
  assert.equal(first.kind, 'submitted')
  assert.equal(second.kind, 'submitted')
  h.backend.held = false
  h.backend.finishTurn('t1')
  await h.coordinator.settle()
  await h.coordinator.settle()
  assert.deepEqual(h.backend.submits, ['first', 'second'])
  await h.coordinator.close()
})

test('scheduled markers admit under the schedule source with run-keyed dedupe', async () => {
  const h = await wiringHarness()
  const first = await ingestScheduledMessage(h.coordinator, {
    sessionId: h.session.id,
    threadId: 'thread-1',
    runKey: 'run-41',
    prompt: 'nightly report',
    actorId: 'actor-1',
  })
  assert.deepEqual(first, { kind: 'submitted', source: 'schedule' })
  const again = await ingestScheduledMessage(h.coordinator, {
    sessionId: h.session.id,
    threadId: 'thread-1',
    runKey: 'run-41',
    prompt: 'nightly report',
    actorId: 'actor-1',
  })
  assert.equal(again.kind, 'submitted')
  await h.coordinator.settle()
  assert.deepEqual(h.backend.submits, ['nightly report'])
  const op = (await h.store.operations(h.session.id))[0]!
  assert.equal(op.source, 'schedule')
  await h.coordinator.close()
})

test('attachments stage through the hardened pipeline before admission', async () => {
  const h = await wiringHarness()
  vi.stubGlobal('fetch', (async (url: string) => {
    state.fetchCalls.push(url)
    return new Response(new Uint8Array([1, 2, 3]))
  }) as unknown as typeof fetch)
  try {
    const ingest = await ingestNativeThreadMessage({
      threadId: 'thread-1',
      actorId: 'actor-1',
      text: 'look at this',
      source: 'discord',
      sourceKey: 'msg-att',
      attachments: [
        {
          filename: 'data.bin',
          mimeType: 'application/octet-stream',
          url: 'https://cdn.example/data.bin',
        },
      ],
    })
    assert.equal(ingest.kind, 'submitted')
    assert.deepEqual(state.fetchCalls, ['https://cdn.example/data.bin'])
    const rows = (await h.db.execute('SELECT COUNT(*) AS n FROM agent_attachments')).rows
    assert.equal(Number(rows[0]!.n), 1)
    await h.coordinator.settle()
    assert.deepEqual(h.backend.submits, ['look at this'])
  } finally {
    vi.unstubAllGlobals()
  }
  await h.coordinator.close()
})

test('default-off: without a coordinator the ingest is visibly offline and nothing submits', async () => {
  const h = await wiringHarness()
  state.coordinator = null
  const offline = await ingestNativeThreadMessage({
    threadId: 'thread-1',
    actorId: 'actor-1',
    text: 'hello',
    source: 'discord',
    sourceKey: 'msg-off',
  })
  assert.deepEqual(offline, { kind: 'offline' })
  assert.deepEqual(h.backend.submits, [])
  state.sessionForThread = null
  const foreign = await ingestNativeThreadMessage({
    threadId: 'thread-2',
    actorId: 'actor-1',
    text: 'hello',
    source: 'discord',
    sourceKey: 'msg-x',
  })
  assert.deepEqual(foreign, { kind: 'not-native' })
  state.coordinator = h.coordinator
  await h.coordinator.close()
})

test('message wiring never imports the OpenCode seam', async () => {
  const here = fileURLToPath(new URL('./message-ingest.test.ts', import.meta.url)).replace(
    /[^/\\]+$/,
    '',
  )
  const source = await readFile(`${here}message-ingest.ts`, 'utf8')
  assert.equal(source.includes("from '../opencode"), false)
  resetNativeOutboxRenderer()
  setNativeDiscordClient(null)
  expect(true).toBe(true)
})
