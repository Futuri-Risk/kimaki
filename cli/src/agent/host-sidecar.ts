// Read-only projections of the durable agent sidecar for ingress routing (ZK-005).
// These queries are deliberately ownership-free: routing only needs to know WHICH
// backend owns a session, never whether this machine may drive it — ownership is
// the native coordinator's preflight (ZK-008). The full AgentStore stays the only
// write path. — ZCode 2026-09-17

import { getRawDbClient } from '../db.js'
import { libsqlSqlClient } from './sql.js'
import type { BackendSidecar } from './registry.js'

/**
 * Backend projection of a host session ID from agent_sessions.
 * Missing row → undefined (legacy OpenCode IDs have no sidecar row by design).
 */
export async function lookupBackendSidecar(sessionId: string): Promise<BackendSidecar | undefined> {
  const client = libsqlSqlClient(await getRawDbClient())
  const row = (
    await client.execute({
      sql: 'SELECT backend_type FROM agent_sessions WHERE id=?',
      args: [sessionId],
    })
  ).rows[0]
  if (!row) {
    return undefined
  }
  return { backend: String(row.backend_type) as BackendSidecar['backend'] }
}

/**
 * Count non-terminal native operations for a native session. Used by the
 * task-runner concurrency check so a `zc:` run never asks the OpenCode server
 * whether a native session is busy. 0 when the sidecar has no operations.
 */
export async function countActiveNativeOperations(sessionId: string): Promise<number> {
  const client = libsqlSqlClient(await getRawDbClient())
  const result = await client.execute({
    sql: "SELECT COUNT(*) AS n FROM agent_operations WHERE agent_session_id=? AND state NOT IN ('completed','failed','cancelled','rejected')",
    args: [sessionId],
  })
  return Number(result.rows[0]?.n ?? 0)
}
