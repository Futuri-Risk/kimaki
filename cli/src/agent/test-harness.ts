// Test harness for the durable agent sidecar — ZK-004, ZAI 2026-09-17.
// Creates a REAL file-backed libSQL database, bootstraps it through the same generated
// schema.sql the production migrateSchema uses, and finalizes the agent schema gate.
// Replaces the standalone node:sqlite adapter; H47/H48 adapter-defect classes do not
// apply to the real client.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createClient, type Client } from '@libsql/client'
import { onTestFinished } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { finalizeAgentSchema } from './schema-gate.js'
import { libsqlSqlClient, type SqlClient } from './sql.js'
import { AgentStore } from './store.js'
import type { OperationKind } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Load the generated schema.sql exactly like db.ts migrateSchema does. */
export async function loadSchemaStatements(): Promise<string[]> {
  const sql = await readFile(path.join(__dirname, '../schema.sql'), 'utf-8')
  return sql
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(
      (s) =>
        s.length > 0 && !/^CREATE\s+TABLE\s+["']?sqlite_sequence["']?\s*\(/i.test(s),
    )
}

export type StoreHarness = {
  root: string
  client: Client
  db: SqlClient
  store: AgentStore
  session: {
    id: string
    backend: 'zcode'
    nativeSessionId: string | null
    workspace: {
      projectDirectory: string
      canonicalDirectory: string
      nativeWorkspacePath: string
      nativeWorkspaceKey: string
      ownerMachineId: string
      nativeHomeIdentity: string
    }
    profileId: string
    profileRevision: string
    controllerThreadId: string
    state: string
    model: { providerId: string; modelId: string; reasoning: string; revision: string }
  }
  input: (
    sourceId: string,
    content: string,
    kind?: OperationKind,
    payload?: unknown,
  ) => {
    sessionId: string
    threadId: string
    actorId: string
    source: 'discord'
    sourceId: string
    kind: OperationKind
    text: string
    payload?: unknown
  }
}

export async function createStoreHarness(options: { secretValues?: string[] } = {}): Promise<StoreHarness> {
  const root = await mkdtemp(path.join(tmpdir(), 'kimaki-agent-test-'))
  const client = createClient({ url: `file:${path.join(root, 'host.db').replace(/\\/g, '/')}` })
  onTestFinished(async () => {
    client.close()
    // Windows can briefly hold WAL/shm handles after close; cleanup is best-effort
    // (the OS temp cleaner is the backstop).
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
  for (const statement of await loadSchemaStatements()) {
    await client.execute(statement)
  }
  await finalizeAgentSchema(client)
  const db = libsqlSqlClient(client)
  const store = new AgentStore(db, 'test-machine', options.secretValues ?? [])
  const repo = path.join(root, 'repo')
  const home = path.join(root, 'native')
  const session: StoreHarness['session'] = {
    id: 'zc:session-1',
    backend: 'zcode',
    nativeSessionId: null,
    workspace: {
      projectDirectory: repo,
      canonicalDirectory: repo,
      nativeWorkspacePath: repo,
      nativeWorkspaceKey: repo,
      ownerMachineId: 'test-machine',
      nativeHomeIdentity: home,
    },
    profileId: 'test-profile',
    profileRevision: 'r1',
    controllerThreadId: 'thread-1',
    state: 'unbound',
    model: { providerId: 'fixture', modelId: 'fixture-model', reasoning: 'high', revision: 'r1' },
  }
  await store.insertSession(session)
  const input: StoreHarness['input'] = (sourceId, content, kind = 'prompt', payload) => ({
    sessionId: session.id,
    threadId: 'thread-1',
    actorId: 'actor-1',
    source: 'discord',
    sourceId,
    kind,
    text: content,
    ...(payload === undefined ? {} : { payload }),
  })
  return { root, client, db, store, session, input }
}
