// ZK-008 renderer contract tests: native outbox rows are delivered through the
// adapted ports as Discord message groups with exact-revision receipts (H01),
// confirmed receipts never downgraded (H02), edit-in-place for repeated
// revisions, uncertainty reconciled only via verified lookup (miss ≠
// non-delivery, never a resend), and host verbosity rules applied at flush.
// — ZCode 2026-09-18
import { test } from 'vitest'
import assert from 'node:assert/strict'

import { OutboxRenderer, discordNonce, type DeliveryProbe, type RendererPorts } from './renderer.js'
import { createStoreHarness, type StoreHarness } from './test-harness.js'
import type { Cursor, DisplayPart } from './types.js'

function cursor(sequence: number): Cursor {
  return { stream: 'legacy', generation: 'g1', epoch: '', sequence }
}

function textPart(text: string, state: DisplayPart['state'] = 'done'): DisplayPart {
  return { id: 'p1', nativeId: 'n1', kind: 'text', state, text, delivery: 'live', order: 1 }
}

function toolPart(overrides: Partial<DisplayPart> = {}): DisplayPart {
  return {
    id: 'p-tool',
    nativeId: 'n-tool',
    kind: 'tool',
    state: 'running',
    toolName: 'bash',
    text: JSON.stringify({ command: 'npm test', hasSideEffect: true }),
    delivery: 'live',
    order: 2,
    ...overrides,
  }
}

type ChannelMessage = { id: string; threadId: string; content: string; nonce: string }

type FailPlan = { ghostFrom?: number; dropFrom?: number; editGhost?: boolean; editDrop?: boolean }

// In-memory Discord channel implementing the port contract honestly: verify
// only succeeds when every probe entry is observable with exact content.
function channelPorts(fail: FailPlan = {}) {
  const messages: ChannelMessage[] = []
  const sends: ChannelMessage[] = []
  const edits: Array<{ messageId: string; content: string }> = []
  const deletes: string[] = []
  const verifies: DeliveryProbe[] = []
  let nextId = 1
  const ports: RendererPorts = {
    send: async (delivery) => {
      const index = sends.length
      if (fail.dropFrom !== undefined && index >= fail.dropFrom) {
        throw Error('discord send dropped')
      }
      const message: ChannelMessage = {
        id: `m${nextId++}`,
        threadId: delivery.threadId,
        content: delivery.content,
        nonce: delivery.nonce,
      }
      messages.push(message)
      sends.push(message)
      if (fail.ghostFrom !== undefined && index >= fail.ghostFrom) {
        throw Error('discord send reply lost')
      }
      return { id: message.id }
    },
    edit: async (delivery) => {
      if (fail.editDrop) {
        throw Error('discord edit dropped')
      }
      const message = messages.find((m) => m.id === delivery.messageId)
      if (!message) {
        throw Error('edit target missing')
      }
      message.content = delivery.content
      edits.push({ messageId: delivery.messageId, content: delivery.content })
      if (fail.editGhost) {
        throw Error('discord edit reply lost')
      }
    },
    delete: async (_threadId, messageId) => {
      const at = messages.findIndex((m) => m.id === messageId)
      if (at >= 0) {
        messages.splice(at, 1)
      }
      deletes.push(messageId)
    },
    verify: async (threadId, probe) => {
      verifies.push(probe)
      const ids: string[] = []
      for (let i = 0; i < probe.byNonce.length + probe.byId.length; i++) {
        ids.push('')
      }
      for (const entry of probe.byNonce) {
        const found = messages.find((m) => m.threadId === threadId && m.nonce === entry.nonce)
        if (!found || found.content !== entry.content) {
          return null
        }
        ids[entry.index] = found.id
      }
      for (const entry of probe.byId) {
        const found = messages.find((m) => m.id === entry.id)
        if (!found || found.content !== entry.content) {
          return null
        }
        ids[entry.index] = found.id
      }
      return { ids }
    },
  }
  return { ports, messages, sends, edits, deletes, verifies }
}

async function outboxRow(h: StoreHarness, id: string) {
  const row = (await h.db.execute({ sql: 'SELECT * FROM agent_outbox WHERE id=?', args: [id] }))
    .rows[0]
  assert.ok(row, 'outbox row exists')
  return {
    state: String(row.state),
    discordMessageId: row.discord_message_id === null ? null : String(row.discord_message_id),
  }
}

async function pendingRow(h: StoreHarness) {
  const rows = (await h.db.execute("SELECT * FROM agent_outbox WHERE state='pending'")).rows
  assert.equal(rows.length, 1, 'exactly one pending row')
  return { id: String(rows[0]!.id) }
}

test('discord nonce is stable, within 25 chars, and distinct per chunk', () => {
  const nonce = discordNonce('long-operation-id')
  assert.equal(nonce.length, 25)
  assert.equal(nonce, discordNonce('long-operation-id'))
  assert.notEqual(nonce, discordNonce('long-operation-id#1'))
})

test('done part sends once with a receipt and never resends', async () => {
  const h = await createStoreHarness()
  const channel = channelPorts()
  const renderer = new OutboxRenderer(h.store, channel.ports)
  await h.store.view(h.session.id, cursor(1), [textPart('Done ✓ first')], 'thread-1')
  const { id } = await pendingRow(h)
  await renderer.flush()
  await renderer.flush()
  assert.equal(channel.sends.length, 1)
  assert.equal(channel.sends[0]!.content, 'Done ✓ first')
  assert.equal(channel.sends[0]!.nonce, discordNonce(`${id}#0`))
  const row = await outboxRow(h, id)
  assert.equal(row.state, 'sent')
  assert.equal(row.discordMessageId, 'm1')
})

test('long content splits into a receipt group ordered by chunk', async () => {
  const h = await createStoreHarness()
  const channel = channelPorts()
  const renderer = new OutboxRenderer(h.store, channel.ports, { maxLength: 60 })
  const long = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join(' '.repeat(12))
  await h.store.view(h.session.id, cursor(1), [textPart(long)], 'thread-1')
  const { id } = await pendingRow(h)
  await renderer.flush()
  assert.ok(channel.sends.length > 1, 'content actually split')
  assert.deepEqual(
    channel.sends.map((m) => m.nonce),
    channel.sends.map((_m, i) => discordNonce(`${id}#${i}`)),
  )
  const row = await outboxRow(h, id)
  assert.equal(row.state, 'sent')
  assert.equal(row.discordMessageId, channel.sends.map((m) => m.id).join(','))
})

test('next revision edits the previous receipt group in place instead of appending', async () => {
  const h = await createStoreHarness()
  const channel = channelPorts()
  const renderer = new OutboxRenderer(h.store, channel.ports)
  await h.store.view(h.session.id, cursor(1), [toolPart()], 'thread-1')
  await renderer.flush()
  const firstRow = (
    await h.db.execute("SELECT id,discord_message_id FROM agent_outbox WHERE state='sent'")
  ).rows[0]!
  // Tool completes: same part id, new non-streaming revision with final output.
  await h.store.view(
    h.session.id,
    cursor(2),
    [
      toolPart({
        state: 'done',
        text: JSON.stringify({ command: 'npm test', hasSideEffect: true }),
      }),
    ],
    'thread-1',
  )
  const secondId = (await pendingRow(h)).id
  await renderer.flush()
  assert.equal(channel.sends.length, 1, 'no additional messages for the same part')
  assert.equal(channel.edits.length, 1)
  assert.equal(channel.edits[0]!.messageId, String(firstRow.discord_message_id))
  const row = await outboxRow(h, secondId)
  assert.equal(row.state, 'sent')
  assert.equal(row.discordMessageId, String(firstRow.discord_message_id))
})

test('growing revision extends the group; shrinking revision deletes the surplus message', async () => {
  const h = await createStoreHarness()
  const channel = channelPorts()
  const renderer = new OutboxRenderer(h.store, channel.ports, { maxLength: 60 })
  const short = 'tiny final answer'
  const long = ['grows', 'into', 'several', 'messages', 'when', 'the', 'part', 'expands'].join(
    ' '.repeat(12),
  )
  await h.store.view(h.session.id, cursor(1), [textPart(short)], 'thread-1')
  await renderer.flush()
  assert.equal(channel.sends.length, 1)
  const firstId = channel.sends[0]!.id
  await h.store.view(h.session.id, cursor(2), [textPart(long)], 'thread-1')
  const secondId = (await pendingRow(h)).id
  await renderer.flush()
  const editedCount = channel.edits.length
  assert.ok(channel.sends.length > 1, 'revision extended the group with new chunks')
  assert.equal(
    (await outboxRow(h, secondId)).discordMessageId,
    channel.sends.map((m) => m.id).join(','),
  )
  // Third revision shrinks below a single chunk: surplus group members are deleted.
  await h.store.view(h.session.id, cursor(3), [textPart(short)], 'thread-1')
  const thirdId = (await pendingRow(h)).id
  await renderer.flush()
  assert.deepEqual(
    channel.deletes,
    channel.sends.slice(1).map((m) => m.id),
  )
  assert.equal((await outboxRow(h, thirdId)).discordMessageId, firstId)
  assert.ok(channel.edits.length > editedCount)
})

test('uncertain send stays delivery-unknown, never resends, and reconciles via verified lookup', async () => {
  const h = await createStoreHarness()
  // Lost HTTP reply: the message reached Discord but the receipt did not.
  const channel = channelPorts({ ghostFrom: 0 })
  const renderer = new OutboxRenderer(h.store, channel.ports)
  await h.store.view(h.session.id, cursor(1), [textPart('lost reply')], 'thread-1')
  const { id } = await pendingRow(h)
  await renderer.flush()
  assert.equal(channel.sends.length, 1)
  assert.equal((await outboxRow(h, id)).state, 'delivery-unknown')
  await renderer.flush()
  assert.equal(channel.sends.length, 1, 'uncertain rows never resend')
  assert.equal(channel.verifies.length, 1)
  assert.deepEqual(
    channel.verifies[0]!.byNonce.map((e) => e.nonce),
    [discordNonce(`${id}#0`)],
  )
  const row = await outboxRow(h, id)
  assert.equal(row.state, 'sent')
  assert.equal(row.discordMessageId, 'm1')
})

test('partial split uncertainty requires every chunk verified before receipt', async () => {
  const h = await createStoreHarness()
  // Chunk 0 delivered but its reply was lost; chunk 1 never reached Discord.
  const channel = channelPorts({ ghostFrom: 0, dropFrom: 1 })
  const renderer = new OutboxRenderer(h.store, channel.ports, { maxLength: 60 })
  const long = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].join(' '.repeat(12))
  await h.store.view(h.session.id, cursor(1), [textPart(long)], 'thread-1')
  const { id } = await pendingRow(h)
  await renderer.flush()
  assert.equal((await outboxRow(h, id)).state, 'delivery-unknown')
  await renderer.flush()
  assert.equal(channel.verifies.length, 1)
  // The bounded lookup finds chunk 0 but not chunk 1: no receipt, no resend.
  assert.equal((await outboxRow(h, id)).state, 'delivery-unknown')
  assert.equal(channel.sends.length, 1)
})

test('uncertain edit reconciles through verified content at a known message id', async () => {
  const h = await createStoreHarness()
  const channel = channelPorts()
  const renderer = new OutboxRenderer(h.store, channel.ports)
  await h.store.view(h.session.id, cursor(1), [toolPart()], 'thread-1')
  await renderer.flush()
  const firstId = channel.sends[0]!.id
  await h.store.view(h.session.id, cursor(2), [toolPart({ state: 'done' })], 'thread-1')
  const { id } = await pendingRow(h)
  // Make the edit uncertain through a port that applied it but lost the reply.
  const applied: RendererPorts = {
    ...channel.ports,
    edit: async (delivery) => {
      const message = channel.messages.find((m) => m.id === delivery.messageId)
      if (message) {
        message.content = delivery.content
      }
      throw Error('edit reply lost')
    },
  }
  await new OutboxRenderer(h.store, applied).flush()
  assert.equal((await outboxRow(h, id)).state, 'delivery-unknown')
  await renderer.flush()
  assert.equal(channel.verifies.length, 1)
  assert.deepEqual(
    channel.verifies[0]!.byId.map((e) => e.id),
    [firstId],
  )
  const row = await outboxRow(h, id)
  assert.equal(row.state, 'sent')
  assert.equal(row.discordMessageId, firstId)
})

test('H01 coalescing between selection and claim cannot acknowledge unsent newer text', async () => {
  const h = await createStoreHarness()
  const channel = channelPorts()
  const renderer = new OutboxRenderer(h.store, channel.ports)
  await h.store.view(h.session.id, cursor(1), [textPart('old')], 'thread-1')
  const { id } = await pendingRow(h)
  const original = h.store.claimOutbox.bind(h.store)
  let raced = false
  h.store.claimOutbox = async (claimId: string, expectedRevision?: number) => {
    if (!raced) {
      raced = true
      await h.store.view(h.session.id, cursor(2), [textPart('new')], 'thread-1')
    }
    return original(claimId, expectedRevision)
  }
  await renderer.flush()
  assert.equal(channel.sends.length, 0, 'stale revision never sent')
  assert.equal((await outboxRow(h, id)).state, 'pending')
  await renderer.flush()
  assert.equal(channel.sends.at(-1)!.content, 'new')
  assert.equal((await outboxRow(h, id)).state, 'sent')
})

test('H02 late uncertain receipt cannot downgrade a confirmed group', async () => {
  const h = await createStoreHarness()
  await h.store.view(h.session.id, cursor(1), [textPart('one')], 'thread-1')
  const { id } = await pendingRow(h)
  assert.equal(await h.store.claimOutbox(id), true)
  await h.store.receipt(id, 'confirmed-1,confirmed-2')
  await h.store.receipt(id, null)
  const row = await outboxRow(h, id)
  assert.equal(row.state, 'sent')
  assert.equal(row.discordMessageId, 'confirmed-1,confirmed-2')
})

test('host verbosity rules hide thinking, read-only tools, and side-effect-free bash', async () => {
  const h = await createStoreHarness()
  const channel = channelPorts()
  const renderer = new OutboxRenderer(h.store, channel.ports)
  await h.store.view(
    h.session.id,
    cursor(1),
    [
      {
        id: 'p-r',
        nativeId: 'n',
        kind: 'reasoning',
        state: 'done',
        text: 'private chain of thought',
        delivery: 'live',
        order: 1,
      },
      {
        id: 'p-read',
        nativeId: 'n',
        kind: 'tool',
        state: 'done',
        toolName: 'read',
        text: '',
        delivery: 'live',
        order: 2,
      },
      {
        id: 'p-ls',
        nativeId: 'n',
        kind: 'tool',
        state: 'done',
        toolName: 'bash',
        text: JSON.stringify({ command: 'ls', hasSideEffect: false }),
        delivery: 'live',
        order: 3,
      },
      toolPart(),
      {
        id: 'p-t2',
        nativeId: 'n2',
        kind: 'text',
        state: 'done',
        text: 'visible answer',
        delivery: 'live',
        order: 5,
      },
    ],
    'thread-1',
  )
  await renderer.flush()
  assert.equal(channel.sends.length, 2)
  assert.equal(channel.sends[0]!.content, '┣ bash _npm test_')
  assert.equal(channel.sends[1]!.content, 'visible answer')
  const rows = (
    await h.db.execute(
      'SELECT display_part_id,state,discord_message_id FROM agent_outbox ORDER BY display_part_id',
    )
  ).rows
  assert.deepEqual(
    rows.map((r) => [
      String(r.display_part_id),
      String(r.state),
      r.discord_message_id === null ? null : String(r.discord_message_id),
    ]),
    [
      ['p-ls', 'sent', null],
      ['p-r', 'sent', null],
      ['p-read', 'sent', null],
      ['p-t2', 'sent', 'm2'],
      ['p-tool', 'sent', 'm1'],
    ],
  )
})

test('tools_and_text shows thinking; text_only sends only text parts', async () => {
  const base: DisplayPart[] = [
    {
      id: 'p-r',
      nativeId: 'n',
      kind: 'reasoning',
      state: 'done',
      text: 'pondering',
      delivery: 'live',
      order: 1,
    },
    toolPart(),
    {
      id: 'p-t',
      nativeId: 'n',
      kind: 'text',
      state: 'done',
      text: 'answer',
      delivery: 'live',
      order: 3,
    },
  ]
  {
    const h = await createStoreHarness()
    const channel = channelPorts()
    await h.store.view(h.session.id, cursor(1), base, 'thread-1')
    await new OutboxRenderer(h.store, channel.ports, { verbosity: 'tools_and_text' }).flush()
    assert.deepEqual(
      channel.sends.map((m) => m.content),
      ['┣ thinking', '┣ bash _npm test_', 'answer'],
    )
  }
  {
    const h = await createStoreHarness()
    const channel = channelPorts()
    await h.store.view(h.session.id, cursor(1), base, 'thread-1')
    await new OutboxRenderer(h.store, channel.ports, { verbosity: 'text_only' }).flush()
    assert.deepEqual(
      channel.sends.map((m) => m.content),
      ['answer'],
    )
  }
})

test('file-change parts render with the host edit prefix', async () => {
  const h = await createStoreHarness()
  const channel = channelPorts()
  const renderer = new OutboxRenderer(h.store, channel.ports)
  await h.store.view(
    h.session.id,
    cursor(1),
    [
      {
        id: 'p-f',
        nativeId: 'n',
        kind: 'file-change',
        state: 'done',
        text: 'cli/src/agent/renderer.ts (+42-7)',
        delivery: 'live',
        order: 1,
      },
    ],
    'thread-1',
  )
  await renderer.flush()
  assert.equal(channel.sends.length, 1)
  assert.equal(channel.sends[0]!.content, '◼︎ cli/src/agent/renderer.ts (+42-7)')
})
