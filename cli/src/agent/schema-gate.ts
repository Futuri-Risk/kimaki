// Agent sidecar schema gate — ZK-004, ZAI 2026-09-17.
// Runs BEFORE the generic schema.sql bootstrap DDL (db.ts migrateSchema): agent tables
// that exist must carry a supported version and their declared shape; a missing journal
// or index is corruption, never permission for CREATE IF NOT EXISTS to silently
// recreate it (hardened-slice H04/H29 semantics, adapted from exact-DDL comparison to
// semantic validation because this host generates DDL through drizzle-kit).

import type { Client } from '@libsql/client'
import { fail, integer } from './errors.js'
import { transaction, libsqlSqlClient } from './sql.js'

export const AGENT_SCHEMA_COMPONENT = 'agent-backend'
export const AGENT_SCHEMA_VERSION = 2

export const AGENT_TABLES = [
  'agent_schema_versions',
  'agent_sessions',
  'agent_backend_defaults',
  'agent_thread_intents',
  'agent_operations',
  'agent_stream_state',
  'agent_interactions',
  'agent_attachments',
  'agent_outbox',
  'agent_workspace_leases',
] as const

/** Indexes whose absence invalidates a stamped version (semantic, not textual, DDL). */
const REQUIRED_INDEXES = [
  'agent_interactions_pending_id',
  'agent_operations_source_unique',
  'agent_outbox_revision_unique',
] as const

async function agentTables(client: Client): Promise<Set<string>> {
  const rows = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_%'",
  )
  return new Set(rows.rows.map((r) => String(r.name)))
}

async function indexSql(client: Client, name: string): Promise<string | undefined> {
  const rows = await client.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
    args: [name],
  })
  const sql = rows.rows[0]?.sql
  return typeof sql === 'string' ? sql : undefined
}

async function stampedVersion(client: Client): Promise<number | null> {
  const rows = await client.execute({
    sql: 'SELECT version FROM agent_schema_versions WHERE component=?',
    args: [AGENT_SCHEMA_COMPONENT],
  })
  const row = rows.rows[0]
  if (!row) return null
  return integer(row.version)
}

/**
 * Validate the semantic shape of a stamped v2 schema: every table present, required
 * indexes present, and the pending-interaction index really partial on state='pending'.
 */
export async function validateAgentSchemaIntegrity(client: Client): Promise<void> {
  const tables = await agentTables(client)
  for (const table of AGENT_TABLES) {
    if (!tables.has(table)) {
      throw fail(
        'SCHEMA_CORRUPT',
        `Versioned backend schema is missing ${table}; restore/reconcile before startup.`,
        'recover',
        'possible',
      )
    }
  }
  for (const name of REQUIRED_INDEXES) {
    const sql = await indexSql(client, name)
    if (!sql) {
      throw fail(
        'SCHEMA_CORRUPT',
        `Versioned backend schema is missing index ${name}.`,
        'recover',
        'possible',
      )
    }
  }
  const pending = await indexSql(client, 'agent_interactions_pending_id')
  if (
    !pending ||
    !/where/i.test(pending) ||
    !/state/i.test(pending) ||
    !/'pending'/.test(pending) ||
    !pending.includes('agent_session_id') ||
    !pending.includes('connection_generation') ||
    !pending.includes('native_request_id_json')
  ) {
    throw fail(
      'SCHEMA_CORRUPT',
      "agent_interactions_pending_id must be a partial unique index on (agent_session_id,connection_generation,native_request_id_json) WHERE state='pending'.",
      'recover',
      'possible',
    )
  }
}

/**
 * Pre-bootstrap gate. Safe on a completely fresh database (no agent tables → no-op;
 * bootstrap creates them and finalizeAgentSchema stamps the version). Any existing
 * agent table without a supported version refuses.
 */
export async function preBootstrapAgentSchemaGate(client: Client): Promise<void> {
  const tables = await agentTables(client)
  if (!tables.size) return
  if (!tables.has('agent_schema_versions')) {
    throw fail(
      'SCHEMA_UNSUPPORTED',
      'Backend tables have no schema version; refusing to guess.',
      'recover',
    )
  }
  const version = await stampedVersion(client)
  if (version === null) {
    throw fail(
      'SCHEMA_UNSUPPORTED',
      'Backend schema version row is missing; refusing to guess.',
      'recover',
    )
  }
  if (version === 1) {
    throw fail(
      'SCHEMA_UNSUPPORTED',
      'Backend schema v1 (standalone slice) requires an explicit conversion to v2 before startup; refusing automatic upgrade.',
      'recover',
    )
  }
  if (version !== AGENT_SCHEMA_VERSION) {
    throw fail(
      'SCHEMA_UNSUPPORTED',
      `Unknown backend schema version ${version}; database left unchanged.`,
      'recover',
    )
  }
  await validateAgentSchemaIntegrity(client)
}

/**
 * Post-bootstrap finalize: stamp the version on a fresh creation and validate the
 * generated shape. Existing stamps are never overwritten.
 */
export async function finalizeAgentSchema(client: Client): Promise<void> {
  const tables = await agentTables(client)
  if (!tables.size) {
    throw fail(
      'SCHEMA_CORRUPT',
      'Bootstrap DDL did not create the agent sidecar tables.',
      'recover',
      'possible',
    )
  }
  await client.execute({
    sql: "INSERT INTO agent_schema_versions(component,version) VALUES(?,?) ON CONFLICT(component) DO NOTHING",
    args: [AGENT_SCHEMA_COMPONENT, AGENT_SCHEMA_VERSION],
  })
  await validateAgentSchemaIntegrity(client)
}

/**
 * Explicit v1→v2 conversion for standalone-slice databases (not run at startup).
 * Rebuilds agent_interactions without lifetime RPC-ID uniqueness, preserving history
 * byte-for-byte; any failure rolls back and leaves the v1 tables intact (H27/H28).
 */
export async function upgradeAgentSchemaV1ToV2(client: Client): Promise<void> {
  const sql = libsqlSqlClient(client)
  await transaction(sql, async (tx) => {
    const version = await stampedVersion(client)
    if (version !== 1) {
      throw fail('SCHEMA_UNSUPPORTED', 'v1→v2 conversion requires a stamped v1 database.')
    }
    const columns =
      'id,agent_session_id,operation_id,connection_generation,native_request_id_json,kind,state,safe_request_json,controller_thread_id,expires_at,created_at,updated_at'
    const legacy = await client.execute(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_interactions'",
    )
    const legacySql = legacy.rows[0]?.sql
    if (typeof legacySql !== 'string') {
      throw fail('SCHEMA_CORRUPT', 'v1 agent_interactions table is missing.')
    }
    const v2Shape = legacySql
      .replace(/CREATE TABLE\s+"?agent_interactions"?/i, 'CREATE TABLE agent_interactions_v2')
      // v1 table-level uniqueness on the RPC id must not survive:
      .replace(/,\s*UNIQUE\s*\(\s*agent_session_id\s*,\s*connection_generation\s*,\s*native_request_id_json\s*\)/i, '')
    await tx.execute(v2Shape)
    await tx.execute(
      `INSERT INTO agent_interactions_v2(${columns}) SELECT ${columns} FROM agent_interactions`,
    )
    await tx.execute('DROP TABLE agent_interactions')
    await tx.execute('ALTER TABLE agent_interactions_v2 RENAME TO agent_interactions')
    await tx.execute(
      "CREATE UNIQUE INDEX agent_interactions_pending_id ON agent_interactions(agent_session_id,connection_generation,native_request_id_json) WHERE state='pending'",
    )
    await tx.execute(
      "UPDATE agent_schema_versions SET version=2 WHERE component='agent-backend' AND version=1",
    )
  })
}
