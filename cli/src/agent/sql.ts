// Transactional SQL port for the durable agent sidecar — ZK-004, ZAI 2026-09-17.
// Ported from the hardened standalone slice sql.ts. The port intentionally targets the
// RAW @libsql/client connection (never the Drizzle object under an unchecked cast); the
// adapter below is the only bridge. Remote COMMIT ambiguity stays the caller's concern:
// a network-lost COMMIT may have committed, so this port surfaces the throw and callers
// keep their uncertainty fences (do not infer rollback).

import type { Client, Transaction as LibsqlTransaction } from '@libsql/client'

export type SqlValue = string | number | null
export type Statement = string | {
  sql: string
  args: readonly SqlValue[]
}
export type SqlRow = Record<string, unknown>
export type SqlResult = {
  rows: readonly SqlRow[]
  rowsAffected: number
}
export interface SqlTransaction {
  execute(statement: Statement): Promise<SqlResult>
  commit(): Promise<void>
  rollback(): Promise<void>
}
export interface SqlClient {
  execute(statement: Statement): Promise<SqlResult>
  transaction(mode: 'write'): Promise<SqlTransaction>
}

/** Bridge the raw libSQL client onto the small SqlClient surface the store uses. */
export function libsqlSqlClient(client: Client): SqlClient {
  return {
    async execute(statement: Statement): Promise<SqlResult> {
      const result = typeof statement === 'string'
        ? await client.execute(statement)
        : await client.execute({ sql: statement.sql, args: statement.args as never[] })
      return {
        rows: result.rows as readonly SqlRow[],
        rowsAffected: result.rowsAffected,
      }
    },
    async transaction(mode: 'write'): Promise<SqlTransaction> {
      const tx: LibsqlTransaction = await client.transaction(mode)
      return {
        async execute(statement: Statement): Promise<SqlResult> {
          const result = typeof statement === 'string'
            ? await tx.execute(statement)
            : await tx.execute({ sql: statement.sql, args: statement.args as never[] })
          return {
            rows: result.rows as readonly SqlRow[],
            rowsAffected: result.rowsAffected,
          }
        },
        commit: () => tx.commit(),
        rollback: () => tx.rollback(),
      }
    },
  }
}

export async function transaction<T>(client: SqlClient, fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
  const tx = await client.transaction('write')
  try {
    const value = await fn(tx)
    await tx.commit()
    return value
  } catch (error) {
    await tx.rollback()
    throw error
  }
}
