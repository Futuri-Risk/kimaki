// Schema gate tests — ZK-004 port of standalone migration/store guards (H04/H27/H28/H29
// adapted to the Drizzle-generated DDL + semantic validation). ZAI 2026-09-17.
import { describe, onTestFinished, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient, type Client } from '@libsql/client'
import {
  AGENT_TABLES,
  finalizeAgentSchema,
  preBootstrapAgentSchemaGate,
  upgradeAgentSchemaV1ToV2,
  validateAgentSchemaIntegrity,
} from './schema-gate.js'
import { loadSchemaStatements } from './test-harness.js'

async function freshClient(): Promise<Client> {
  const root = await mkdtemp(path.join(tmpdir(), 'kimaki-gate-test-'))
  const client = createClient({ url: `file:${path.join(root, 'gate.db').replace(/\\/g, '/')}` })
  onTestFinished(async () => {
    client.close()
    for (let i = 0; i < 5; i++) {
      try {
        await rm(root, { recursive: true, force: true })
        return
      } catch {
        await delay(50)
      }
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  })
  return client
}

async function bootstrap(client: Client) {
  for (const statement of await loadSchemaStatements()) {
    await client.execute(statement)
  }
  await finalizeAgentSchema(client)
}

/** The standalone slice's v1 interactions shape: full UNIQUE on the RPC id. */
async function buildV1Database(client: Client) {
  await client.execute(`CREATE TABLE agent_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL)`)
  await client.execute(`INSERT INTO agent_schema_versions VALUES ('agent-backend', 1)`)
  for (const table of AGENT_TABLES) {
    if (table === 'agent_schema_versions' || table === 'agent_interactions') continue
    await client.execute(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`)
  }
  await client.execute(`CREATE TABLE agent_interactions (
    id TEXT PRIMARY KEY, agent_session_id TEXT NOT NULL, operation_id TEXT,
    connection_generation TEXT NOT NULL, native_request_id_json TEXT NOT NULL,
    kind TEXT NOT NULL, state TEXT NOT NULL, safe_request_json TEXT NOT NULL,
    controller_thread_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(agent_session_id,connection_generation,native_request_id_json)
  )`)
  // v1's table-level UNIQUE means a real v1 database can only ever hold DISTINCT
  // native request ids — the F06 limitation v2 removes.
  await client.execute(`INSERT INTO agent_interactions VALUES
    ('i1','zc:s','o1','g1','0','permission','answered','{}','t',9999999999,1,1),
    ('i2','zc:s','o2','g1','1','question','pending','{}','t',9999999999,2,2)`)
}

describe('preBootstrapAgentSchemaGate', () => {
  test('fresh database with no agent tables is a no-op', async () => {
    const client = await freshClient()
    await preBootstrapAgentSchemaGate(client)
  })

  test('agent tables without a version table are refused, not adopted', async () => {
    const client = await freshClient()
    await client.execute('CREATE TABLE agent_sessions(id TEXT)')
    await assert.rejects(() => preBootstrapAgentSchemaGate(client), {
      code: 'SCHEMA_UNSUPPORTED',
    })
  })

  test('newer and missing version stamps refuse before any write', async () => {
    for (const version of [3, null]) {
      const client = await freshClient()
      await client.execute(
        'CREATE TABLE agent_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL)',
      )
      if (version !== null) {
        await client.execute({
          sql: 'INSERT INTO agent_schema_versions VALUES (?,?)',
          args: ['agent-backend', version],
        })
      }
      // emulate a stamped db with tables present
      await client.execute('CREATE TABLE agent_sessions (id TEXT)')
      await assert.rejects(() => preBootstrapAgentSchemaGate(client), {
        code: 'SCHEMA_UNSUPPORTED',
      })
    }
  })

  test('H04 a stamped schema missing the operation journal is refused, not recreated', async () => {
    const client = await freshClient()
    await bootstrap(client)
    await client.execute('DROP TABLE agent_operations')
    await assert.rejects(() => preBootstrapAgentSchemaGate(client), {
      code: 'SCHEMA_CORRUPT',
    })
  })

  test('H29 a version stamp cannot authorize a missing pending-interaction index', async () => {
    const client = await freshClient()
    await bootstrap(client)
    await client.execute('DROP INDEX agent_interactions_pending_id')
    await assert.rejects(() => preBootstrapAgentSchemaGate(client), {
      code: 'SCHEMA_CORRUPT',
    })
  })

  test('v1 standalone databases require explicit conversion; startup refuses them', async () => {
    const client = await freshClient()
    await buildV1Database(client)
    await assert.rejects(() => preBootstrapAgentSchemaGate(client), {
      code: 'SCHEMA_UNSUPPORTED',
    })
  })
})

describe('upgradeAgentSchemaV1ToV2', () => {
  test('H27 history is preserved byte-for-byte and pending index becomes partial', async () => {
    const client = await freshClient()
    await buildV1Database(client)
    const before = await client.execute(
      "SELECT * FROM agent_interactions ORDER BY id",
    )
    await upgradeAgentSchemaV1ToV2(client)
    const after = await client.execute("SELECT * FROM agent_interactions ORDER BY id")
    assert.deepEqual(after.rows, before.rows)
    // A completed RPC id may now repeat while another request is pending only.
    await client.execute(
      "INSERT INTO agent_interactions VALUES ('i3','zc:s',NULL,'g1','0','permission','pending','{}','t',9999999999,3,3)",
    )
    await assert.rejects(
      () =>
        client.execute(
          "INSERT INTO agent_interactions VALUES ('i4','zc:s',NULL,'g1','0','permission','pending','{}','t',9999999999,4,4)",
        ),
      /UNIQUE/,
    )
  })

  test('H28 a failed conversion leaves the v1 tables and version intact', async () => {
    const client = await freshClient()
    await buildV1Database(client)
    const originalTransaction = client.transaction.bind(client)
    let once = true
    ;(client as { transaction: typeof client.transaction }).transaction = (async (mode?: 'read' | 'write') => {
      const tx = await originalTransaction(mode as 'write')
      return {
        execute: (statement: never) => {
          const sql = typeof statement === 'string' ? statement : (statement as { sql: string }).sql
          if (once && sql.includes('DROP TABLE agent_interactions')) {
            once = false
            throw new Error('injected conversion failure')
          }
          return tx.execute(statement as never)
        },
        commit: () => tx.commit(),
        rollback: () => tx.rollback(),
        close: () => tx.close(),
      }
    }) as typeof client.transaction
    await assert.rejects(() => upgradeAgentSchemaV1ToV2(client), /injected conversion failure/)
    ;(client as { transaction: typeof client.transaction }).transaction = originalTransaction
    const version = await client.execute('SELECT version FROM agent_schema_versions')
    assert.equal(Number(version.rows[0]?.version), 1)
    const count = await client.execute('SELECT COUNT(*) AS n FROM agent_interactions')
    assert.equal(Number(count.rows[0]?.n), 2)
  })
})

describe('finalizeAgentSchema', () => {
  test('bootstrap + finalize is idempotent and stamps v2', async () => {
    const client = await freshClient()
    await bootstrap(client)
    await bootstrap(client)
    const row = await client.execute(
      "SELECT version FROM agent_schema_versions WHERE component='agent-backend'",
    )
    assert.equal(Number(row.rows[0]?.version), 2)
    await validateAgentSchemaIntegrity(client)
  })

  test('bootstrap creates all ten agent tables and preserves legacy rows', async () => {
    const client = await freshClient()
    await client.execute('CREATE TABLE thread_sessions(thread_id TEXT PRIMARY KEY,session_id TEXT)')
    await client.execute("INSERT INTO thread_sessions VALUES('old-thread','ses_old')")
    await bootstrap(client)
    const preserved = await client.execute(
      "SELECT session_id FROM thread_sessions WHERE thread_id='old-thread'",
    )
    assert.equal(preserved.rows[0]?.session_id, 'ses_old')
    const count = await client.execute(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'agent_%' AND type='table'",
    )
    assert.equal(Number(count.rows[0]?.n), 10)
  })

  test('finalize refuses when bootstrap produced no agent tables', async () => {
    const client = await freshClient()
    await assert.rejects(() => finalizeAgentSchema(client), { code: 'SCHEMA_CORRUPT' })
  })
})
