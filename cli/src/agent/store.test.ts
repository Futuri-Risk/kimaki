// Store behavior tests — ZK-004 port of the standalone store.test.mjs + store-level
// hardening cases (H01/H02/H03/H05/H25/H26) against the REAL file-backed libSQL client.
// ZAI 2026-09-17.
import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
import { AgentStore } from './store.js'
import { libsqlSqlClient } from './sql.js'
import { createStoreHarness, type StoreHarness } from './test-harness.js'

const statement = (sql: string, ...args: (string | number | null)[]) => ({ sql, args })
const part = (text = 'hello', delivery: 'live' | 'snapshot' = 'live') => ({
  id: 'p1',
  nativeId: 'n1',
  kind: 'text' as const,
  state: 'done' as const,
  text,
  delivery,
  order: 0,
})
const cursor = (sequence = 1) => ({
  stream: 'legacy' as const,
  generation: 'g1',
  epoch: '',
  sequence,
})

describe('AgentStore admission', () => {
  test('admission is immutable and retains the initial model across later default changes', async () => {
    const h = await createStoreHarness()
    const first = await h.store.admit(h.input('same', 'task'))
    await h.store.setModel(h.session.id, { ...h.session.model, modelId: 'changed' })
    const again = await h.store.admit(h.input('same', 'task'))
    assert.equal(again.created, false)
    assert.equal(again.operation.model.modelId, 'fixture-model')
    await assert.rejects(() => h.store.admit(h.input('same', 'altered')), {
      code: 'ADMISSION_CONFLICT',
    })
    assert.equal((await h.store.admit(h.input('next', 'task'))).operation.model.modelId, 'changed')
  })

  test('H03 JSON escaping cannot hide a configured secret from persistence protection', async () => {
    const secret = 'pa\\ss"quote-\u00e9'
    const h = await createStoreHarness({ secretValues: [secret] })
    await assert.rejects(
      () => h.store.admit(h.input('m', `plain ${secret} text`)),
      { code: 'SECRET_IN_STATE' },
    )
    await assert.rejects(
      () => h.store.view(h.session.id, cursor(), [part(`contains ${secret}`)], 'thread-1'),
      { code: 'SECRET_IN_STATE' },
    )
    assert.equal((await h.store.operations(h.session.id)).length, 0)
    assert.equal((await h.store.outbox()).length, 0)
  })

  test('H05 invalid persisted operation state fails closed at read', async () => {
    const h = await createStoreHarness()
    const { operation } = await h.store.admit(h.input('m', 'once'))
    await h.client.execute(statement("UPDATE agent_operations SET state='bogus' WHERE id=?", operation.id))
    await assert.rejects(() => h.store.operation(operation.id), { code: 'STATE_CORRUPT' })
  })

  test('a full prompt queue still admits cancellation', async () => {
    const h = await createStoreHarness()
    for (let i = 0; i < 256; i++) await h.store.admit(h.input('p' + i, 'queued'))
    await assert.rejects(() => h.store.admit(h.input('overflow', 'queued')), {
      code: 'QUEUE_LIMIT',
    })
    assert.equal((await h.store.admit(h.input('stop', '', 'cancel'))).created, true)
  })
})

describe('AgentStore transitions', () => {
  test('atomic state claim permits only one sender and retains durable send intent timestamp', async () => {
    const h = await createStoreHarness()
    const { operation } = await h.store.admit(h.input('m', 'once'))
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => h.store.transition(operation.id, ['queued'], 'send-intent')),
    )
    assert.equal(claims.filter(Boolean).length, 1)
    const row = (
      await h.client.execute(statement('SELECT send_intent_at FROM agent_operations WHERE id=?', operation.id))
    ).rows[0]
    assert.ok(Number(row?.send_intent_at) > 0)
  })

  test('restart marks uncertain operations, stale questions, and unknown display delivery', async () => {
    const h = await createStoreHarness()
    const { operation } = await h.store.admit(h.input('m', 'once'))
    await h.store.transition(operation.id, ['queued'], 'send-intent')
    const request = {
      id: 'i1',
      sessionId: h.session.id,
      generation: 'old',
      requestId: 0,
      kind: 'permission' as const,
      schema: {},
      threadId: 'thread-1',
      expiresAt: Date.now() + 10000,
    }
    await h.store.addInteraction(request, operation.id)
    await h.store.view(h.session.id, cursor(), [part()], 'thread-1')
    const out = (await h.store.outbox())[0]!
    await h.store.claimOutbox(out.id as string)
    await h.store.recover(h.session.id)
    assert.equal((await h.store.operation(operation.id))?.state, 'submission-unknown')
    assert.equal(
      String((await h.client.execute('SELECT state FROM agent_interactions')).rows[0]?.state),
      'stale',
    )
    assert.equal((await h.store.outbox())[0]?.state, 'delivery-unknown')
    await assert.rejects(() => h.store.consumeInteraction(request, 'thread-1', 'old'), {
      code: 'INTERACTION_STALE',
    })
  })

  test('queue clearing removes only unsent prompts, not controls or uncertain native work', async () => {
    const h = await createStoreHarness()
    const a = (await h.store.admit(h.input('a', 'a'))).operation
    const b = (await h.store.admit(h.input('b', 'b'))).operation
    const c = (await h.store.admit(h.input('c', '', 'cancel'))).operation
    await h.store.transition(a.id, ['queued'], 'send-intent')
    assert.equal(await h.store.clearQueue(h.session.id), 1)
    assert.equal((await h.store.operation(a.id))?.state, 'send-intent')
    assert.equal((await h.store.operation(b.id))?.state, 'cancelled')
    assert.equal((await h.store.operation(c.id))?.state, 'queued')
  })
})

describe('AgentStore interactions', () => {
  test('reply validates generation, thread and one-use consumption', async () => {
    const h = await createStoreHarness()
    const request = {
      id: 'i1',
      sessionId: h.session.id,
      generation: 'g1',
      requestId: '0',
      kind: 'permission' as const,
      schema: {},
      threadId: 'thread-1',
      expiresAt: Date.now() + 10000,
    }
    await h.store.addInteraction(request, null)
    await assert.rejects(() => h.store.consumeInteraction(request, 'thread-1', 'old'), {
      code: 'INTERACTION_STALE',
    })
    await assert.rejects(() => h.store.consumeInteraction(request, 'other', 'g1'), {
      code: 'INTERACTION_STALE',
    })
    await h.store.consumeInteraction(request, 'thread-1', 'g1')
    await assert.rejects(() => h.store.consumeInteraction(request, 'thread-1', 'g1'), {
      code: 'INTERACTION_STALE',
    })
  })

  test('H25/H26 a reused native RPC id gets a new one-use interaction; two pending cannot coexist', async () => {
    const h = await createStoreHarness()
    const first = {
      id: 'i1',
      sessionId: h.session.id,
      generation: 'g1',
      requestId: 0,
      kind: 'permission' as const,
      schema: {},
      threadId: 'thread-1',
      expiresAt: Date.now() + 10000,
    }
    await h.store.addInteraction(first, null)
    await assert.rejects(
      () =>
        h.store.addInteraction(
          { ...first, id: 'i2' },
          null,
        ),
      /UNIQUE/,
    )
    await h.store.consumeInteraction(first, 'thread-1', 'g1')
    // Same numeric native ID may repeat after the prior request closed:
    await h.store.addInteraction(
      { ...first, id: 'i3' },
      null,
    )
    const states = await h.client.execute(
      'SELECT state FROM agent_interactions ORDER BY id',
    )
    assert.deepEqual(
      states.rows.map((r) => String(r.state)),
      ['answered', 'pending'],
    )
  })
})

describe('AgentStore leases', () => {
  test('workspace and native-home leases require exact owner nonce, never stale auto-takeover', async () => {
    const h = await createStoreHarness()
    await h.store.acquire(h.session, 'owner')
    await assert.rejects(() => h.store.acquire(h.session, 'other'), { code: 'WORKSPACE_BUSY' })
    await h.store.release(h.session.id, 'other')
    assert.equal((await h.store.leases()).length, 2)
    const child = {
      ...h.session,
      id: 'zc:child',
      workspace: { ...h.session.workspace, canonicalDirectory: h.session.workspace.canonicalDirectory + '-other' },
    }
    await h.store.insertSession(child)
    await assert.rejects(() => h.store.acquire(child, 'second'), { code: 'WORKSPACE_BUSY' })
    assert.equal((await h.store.leases()).length, 2)
    await h.store.release(h.session.id, 'owner')
    await h.store.acquire(child, 'second')
    assert.equal((await h.store.leases()).length, 2)
  })

  test('another machine cannot resolve or admit an existing native session', async () => {
    const h = await createStoreHarness()
    const remote = new AgentStore(h.db, 'other-machine')
    await assert.rejects(() => remote.session(h.session.id), { code: 'OWNER_MISMATCH' })
    await assert.rejects(() => remote.admit(h.input('m', 'task')), { code: 'ACTOR_UNAUTHORIZED' })
  })
})

describe('AgentStore intents and views', () => {
  test('channel defaults are frozen before asynchronous worktree setup', async () => {
    const h = await createStoreHarness()
    const initial = await h.store.freezeIntent('thread-a', 'channel', 'global')
    assert.equal((initial as { backend_type: string }).backend_type, 'opencode')
    await h.store.setDefault('global', 'global', 'zcode', 'native')
    assert.equal(
      ((await h.store.freezeIntent('thread-a', 'channel', 'global')) as { backend_type: string }).backend_type,
      'opencode',
    )
    assert.equal(
      ((await h.store.freezeIntent('thread-b', 'channel', 'global')) as { backend_type: string }).backend_type,
      'zcode',
    )
    await h.store.setDefault('channel', 'channel', 'opencode', null)
    assert.equal(
      ((await h.store.freezeIntent('thread-c', 'channel', 'global')) as { backend_type: string }).backend_type,
      'opencode',
    )
  })

  test('failed view/outbox transaction does not advance native cursor', async () => {
    const h = await createStoreHarness()
    await h.store.view(h.session.id, cursor(1), [part()], 'thread-1')
    await h.client.execute(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON agent_outbox BEGIN SELECT RAISE(ABORT,'disk full'); END",
    )
    await assert.rejects(
      () => h.store.view(h.session.id, cursor(2), [{ ...part('new'), id: 'p2' }], 'thread-1'),
      /disk full/,
    )
    assert.equal(
      Number(String((await h.client.execute('SELECT sequence FROM agent_stream_state')).rows[0]?.sequence)),
      1,
    )
    assert.equal((await h.store.outbox()).length, 1)
  })

  test('snapshot replay cannot create new live messages or duplicate cursor application', async () => {
    const h = await createStoreHarness()
    await h.store.view(h.session.id, cursor(1), [part()], 'thread-1')
    await h.store.view(h.session.id, cursor(1), [part()], 'thread-1')
    await h.store.view(h.session.id, cursor(2), [part('history', 'snapshot')], 'thread-1')
    assert.equal((await h.store.outbox()).length, 1)
  })

  test('unsent display updates coalesce without overwriting an in-flight message', async () => {
    const h = await createStoreHarness()
    await h.store.view(h.session.id, cursor(1), [part('one')], 'thread-1')
    await h.store.view(h.session.id, cursor(2), [part('two')], 'thread-1')
    const rows = await h.store.outbox()
    assert.equal(rows.length, 1)
    assert.equal(JSON.parse(String(rows[0]?.payload_json)).text, 'two')
    await h.store.claimOutbox(String(rows[0]?.id))
    await h.store.view(h.session.id, cursor(3), [part('three')], 'thread-1')
    assert.equal(
      Number(String((await h.client.execute('SELECT COUNT(*) AS n FROM agent_outbox')).rows[0]?.n)),
      2,
    )
  })
})

describe('AgentStore outbox receipts', () => {
  test('H01 claim is bound to the exact selected content revision', async () => {
    const h = await createStoreHarness()
    await h.store.view(h.session.id, cursor(1), [part('one')], 'thread-1')
    await h.store.view(h.session.id, cursor(2), [part('two')], 'thread-1')
    const rows = await h.store.outbox()
    // coalesced row now holds revision 2; a claim naming the older revision must fail
    assert.equal(await h.store.claimOutbox(String(rows[0]?.id), 1), false)
    assert.equal(await h.store.claimOutbox(String(rows[0]?.id), 2), true)
    assert.equal((await h.store.outbox()).length, 0)
  })

  test('H02 a late uncertain receipt cannot downgrade a confirmed send', async () => {
    const h = await createStoreHarness()
    await h.store.view(h.session.id, cursor(1), [part()], 'thread-1')
    const id = String((await h.store.outbox())[0]?.id)
    await h.store.claimOutbox(id)
    await h.store.receipt(id, 'discord-message')
    assert.equal((await h.store.outbox()).length, 0)
    await h.store.receipt(id, null)
    const row = (
      await h.client.execute(statement('SELECT state FROM agent_outbox WHERE id=?', id))
    ).rows[0]
    assert.equal(String(row?.state), 'sent')
  })
})

describe('AgentStore session identity', () => {
  test('missing zc sidecar fails closed; legacy IDs resolve null', async () => {
    const h: StoreHarness = await createStoreHarness()
    assert.equal(await h.store.session('ses_old'), null)
    await assert.rejects(() => h.store.session('zc:missing'), {
      code: 'SESSION_SIDECAR_MISSING',
    })
  })
})
