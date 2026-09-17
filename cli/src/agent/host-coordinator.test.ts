// ZK-007 host wiring tests: machine identity stability, default-off coordinator
// construction (null + capabilities refused), serializeWrites single-writer
// guarantee, and the host authorizer's controller-thread binding.
// — ZCode 2026-09-17
import { afterEach, describe, test } from 'vitest'
import assert from 'node:assert/strict'
import { createClient } from '@libsql/client'
import { onTestFinished } from 'vitest'

import { getOwnerMachineId } from './host-identity.js'
import { getNativeCoordinator, hostAuthorizer, resetNativeCoordinator } from './host-coordinator.js'
import { serializeWrites, libsqlSqlClient } from './sql.js'
import { gateThreadCommand } from './ingress-gate.js'
import { registerNativeProfile } from './native-profile.js'
import { syntheticProfile } from './native-profile.js'
import { fakeCodec } from './fixtures/fake-codec.js'

afterEach(() => {
  resetNativeCoordinator()
})

describe('machine identity (ZK-007)', () => {
  test('stable UUID per install, persisted in the data dir', async () => {
    const first = await getOwnerMachineId()
    assert.match(first, /^[0-9a-f-]{36}$/i)
    assert.equal(await getOwnerMachineId(), first)
  })
})

describe('native coordinator construction (ZK-007)', () => {
  test('default-off: no registered profile → null coordinator and capabilities still refused', async () => {
    resetNativeCoordinator()
    assert.equal(await getNativeCoordinator(), null)
    // The capability provider must remain unset: every native command refuses.
    assert.equal(gateThreadCommand('zcode', 'abort').kind, 'refuse')
    assert.equal(gateThreadCommand('zcode', 'model').kind, 'refuse')
  })

  test('a registered enabled profile constructs a live coordinator and unlocks capabilities', async () => {
    resetNativeCoordinator()
    registerNativeProfile(
      syntheticProfile({
        id: 'zcode-primary',
        revision: 'r0',
        codec: fakeCodec,
        launch: () => {
          throw new Error('never launched in this test')
        },
        attachmentRoot: '/tmp/none',
      }),
    )
    const coordinator = await getNativeCoordinator()
    assert.ok(coordinator)
    // Capability provider active while the coordinator is live.
    assert.equal(gateThreadCommand('zcode', 'abort').kind, 'allow')
    await coordinator.close()
    resetNativeCoordinator()
  })
})

describe('host authorizer (ZK-007)', () => {
  test('binds the Discord actor to the session controller thread', async () => {
    const session = {
      controllerThreadId: 'thread-1',
    } as never
    assert.equal(await hostAuthorizer('user-1', 'thread-1', session), true)
    assert.equal(await hostAuthorizer('user-1', 'thread-other', session), false)
    assert.equal(await hostAuthorizer('', 'thread-1', session), false)
  })
})

describe('serializeWrites single-writer guarantee (ZK-007)', () => {
  test('concurrent transactions and writes never collide with SQLITE_BUSY', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const root = await mkdtemp(path.join(tmpdir(), 'kimaki-serw-'))
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    })
    const raw = createClient({ url: `file:${path.join(root, 't.db').replace(/\\/g, '/')}` })
    const client = serializeWrites(libsqlSqlClient(raw))
    await client.execute('CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)')
    // N transactions + interleaved writes, all fired at once: the chain must
    // order them without SQLITE_BUSY and commit every row.
    const jobs = Array.from({ length: 12 }, (_, i) =>
      i % 3 === 0
        ? client.execute({ sql: "INSERT INTO t VALUES (?, 'w')", args: [`w${i}`] })
        : client.transaction('write').then(async (tx) => {
            await tx.execute({ sql: "INSERT INTO t VALUES (?, 'tx')", args: [`t${i}`] })
            await tx.commit()
          }),
    )
    await Promise.all(jobs)
    const result = await client.execute('SELECT COUNT(*) AS n FROM t')
    assert.equal(Number(result.rows[0]?.n ?? 0), 12)
  })
})
