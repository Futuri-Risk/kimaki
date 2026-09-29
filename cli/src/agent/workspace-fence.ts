// ZK-012 writer/worktree/process ownership fencing. Every managed host writer
// (`!` shell, worktree merge/delete, worktree provisioning, runtime idle
// sweeps) consults the native workspace lease before touching a working tree.
// A lease row — including one left behind by an uncertain native death as a
// recovery fence — blocks the writer: conservative refusal, never a fallback to
// the repo root, never a second concurrent managed writer. — ZCode 2026-09-18
import path from 'node:path'
import { getRawDbClient } from '../db.js'
import { getThreadSession } from '../database.js'
import { libsqlSqlClient } from './sql.js'
import { canonicalWorkspaceKey } from './store.js'
import { isZcodeSessionId } from './registry.js'
import { countActiveNativeOperations } from './host-sidecar.js'

export type NativeWriterHold = { held: false } | { held: true; sessionId: string; resource: string }

/**
 * Read-only projection of the workspace lease for a directory. The lease table
 * only ever holds NATIVE sessions (workspace:*) — OpenCode-only threads have
 * no rows, so their behavior is unchanged by construction.
 */
export async function nativeWorkspaceWriter(directory: string): Promise<NativeWriterHold> {
  const client = libsqlSqlClient(await getRawDbClient())
  // #24: point lookup on the resource PK instead of the LIKE 'workspace:%'
  // scan + JS canonical filter. Two probes cover both spellings: the canonical
  // key (what acquire writes since #24) and the legacy raw-resolved form
  // (rows written before it). Case/separator variants canonicalize into the
  // first probe, so fence matching semantics are unchanged.
  const rows = (
    await client.execute({
      sql: 'SELECT resource, agent_session_id FROM agent_workspace_leases WHERE resource IN (?,?)',
      args: [
        `workspace:${canonicalWorkspaceKey(directory)}`,
        `workspace:${path.resolve(directory)}`,
      ],
    })
  ).rows
  const row = rows[0]
  if (!row) {
    return { held: false }
  }
  return { held: true, sessionId: String(row.agent_session_id), resource: String(row.resource) }
}

/**
 * Writer fence: returns a visible refusal message when a native session (or
 * its recovery fence) owns the directory, null when the writer may proceed.
 */
export async function writerFenceRefusal(directory: string, label: string): Promise<string | null> {
  const hold = await nativeWorkspaceWriter(directory)
  if (!hold.held) {
    return null
  }
  return (
    `${label} refused: native session ${hold.sessionId} owns this workspace. ` +
    'A lease can outlive an uncertain native stop as a recovery fence; it clears only on a verified settled turn.'
  )
}

/**
 * Idle-sweep veto: a thread may dispose its runtime only when it is not a
 * native session with active (including uncertain) operations. Background,
 * goal, and control work keep ownership; uncertainty keeps the lease.
 */
export async function nativeDisposalAllowed(threadId: string): Promise<boolean> {
  const sessionId = await getThreadSession(threadId)
  if (!sessionId || !isZcodeSessionId(sessionId)) {
    return true
  }
  return (await countActiveNativeOperations(sessionId)) === 0
}
