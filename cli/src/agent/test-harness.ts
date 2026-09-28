// Test harness for the durable agent sidecar — ZK-004, ZAI 2026-09-17.
// Creates a REAL file-backed libSQL database, bootstraps it through the same generated
// schema.sql the production migrateSchema uses, and finalizes the agent schema gate.
// Replaces the standalone node:sqlite adapter; H47/H48 adapter-defect classes do not
// apply to the real client.
//
// #27 (ZCode 2026-09-28): this is the shared NON-TEST module for agent fixtures.
// FakeBackend/coordinatorHarness/until live here (not in a *.test.ts file) so
// importing them cannot re-register another file's suites — the coordinator
// suite used to re-execute inside five importers. It also owns the per-worker
// schema template: the 48-statement bootstrap runs once per worker (single
// batch) and every harness file-copies the initialized DB instead of
// re-executing DDL. Cleanup checkpoints the WAL and closes without retry
// sleeps (libsql's native binding holds the file until the process is gone on
// Windows), and every temp root is swept after process exit — by a detached
// janitor child on win32, in-process on POSIX — instead of leaking.

import { mkdtemp, mkdir, readFile, rm, copyFile } from 'node:fs/promises'
import { rmSync, appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createClient, type Client } from '@libsql/client'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { AgentCoordinator, type Authorizer } from './coordinator.js'
import { finalizeAgentSchema } from './schema-gate.js'
import { libsqlSqlClient, type SqlClient } from './sql.js'
import { AgentStore } from './store.js'
import { fakeCodec } from './fixtures/fake-codec.js'
import type {
  OperationKind,
  AgentSession,
  NativeEvent,
  NativeInteraction,
  NativeSnapshot,
  InteractionAnswer,
  ForkPoint,
  ModelSelection,
} from './types.js'
import type { Result } from './errors.js'
import type { Attachment } from './attachments.js'
import type { NativeProfile } from './zcode-backend.js'

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
    .filter((s) => s.length > 0 && !/^CREATE\s+TABLE\s+["']?sqlite_sequence["']?\s*\(/i.test(s))
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

/**
 * Observable counters for the #27 waste regression tests: the schema bootstrap
 * must run once per worker (not once per harness) and cleanup must not leave
 * dirs pending in the deferred sweep.
 */
export const harnessDiagnostics = {
  schemaInitializations: 0,
  harnessCreations: 0,
  deferredSweepSize: 0,
}

const deferredSweep = new Set<string>()
let sweepHooked = false
let sweepManifestPath: string | null = null

/**
 * #27 measurement on this host (win32, @libsql/client 0.17.x): the native
 * binding keeps the DB file handle past client.close() — rm is EPERM after
 * close, after explicit GC — and vitest hard-kills its fork workers without
 * firing the process 'exit' event, so there is NO in-process moment where the
 * temp roots are deletable. The only reliable removal point is after the
 * handle-holding PROCESS is gone. On win32 each process therefore spawns one
 * detached undertaker child at the first deferred dir: the child watches the
 * owner PID and, once that process has died (or 30 min pass), removes every
 * deferred dir listed in the per-PID manifest. On POSIX, unlink-while-open is
 * allowed, so the in-test rm succeeds and a plain 'exit'-hook sweep is enough
 * of a backstop.
 */
function writeManifestLine(dir: string): void {
  if (!sweepManifestPath) {
    sweepManifestPath = path.join(tmpdir(), `kimaki-agent-test-sweep-${process.pid}.txt`)
  }
  try {
    appendFileSync(sweepManifestPath, dir + '\n')
  } catch {
    // best effort — the OS temp cleaner is the final backstop
  }
}

function ensureSweepHook(): void {
  if (sweepHooked) return
  sweepHooked = true
  if (process.platform === 'win32') {
    // Undertaker: outlives this (possibly hard-killed) process, then cleans.
    const script = `
      const fs = require('node:fs')
      const manifest = process.argv[1]
      const owner = Number(process.argv[2])
      const ownerAlive = () => { try { process.kill(owner, 0); return true } catch { return false } }
      const deadline = Date.now() + 30 * 60 * 1000
      const watch = () => {
        if (ownerAlive() && Date.now() < deadline) { setTimeout(watch, 1000); return }
        let dirs = []
        try { dirs = fs.readFileSync(manifest, 'utf-8').split('\\n').filter(Boolean) } catch { return }
        const attempt = (n) => {
          for (const dir of dirs) {
            try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
          }
          if (dirs.some((d) => fs.existsSync(d)) && n < 20) {
            setTimeout(() => attempt(n + 1), 500)
          } else {
            try { fs.rmSync(manifest, { force: true }) } catch {}
          }
        }
        attempt(0)
      }
      watch()
    `
    try {
      const child = spawn(
        process.execPath,
        ['-e', script, sweepManifestPath!, String(process.pid)],
        { detached: true, stdio: 'ignore' },
      )
      child.unref()
    } catch {
      // best effort — the OS temp cleaner is the final backstop
    }
  } else {
    process.on('exit', () => {
      for (const dir of deferredSweep) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // best effort
        }
      }
    })
  }
}

/** Register a dir for removal after this process is gone (see ensureSweepHook). */
function deferSweep(dir: string): void {
  deferredSweep.add(dir)
  harnessDiagnostics.deferredSweepSize = deferredSweep.size
  if (process.platform === 'win32') writeManifestLine(dir)
  ensureSweepHook()
}

function forgetSweep(dir: string): void {
  deferredSweep.delete(dir)
  harnessDiagnostics.deferredSweepSize = deferredSweep.size
}

function fileUrl(dbPath: string): string {
  return `file:${dbPath.replace(/\\/g, '/')}`
}

/**
 * Per-worker schema template (#27): one real schema bootstrap (48 statements as
 * a SINGLE batch + finalizeAgentSchema), then a wal_checkpoint(TRUNCATE) so
 * template.db is self-contained. Every harness then file-copies this DB —
 * schema, indexes and version stamp included — instead of re-running DDL.
 */
let schemaTemplate: Promise<string> | null = null

async function initSchemaTemplate(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kimaki-agent-test-template-'))
  deferSweep(root)
  const dbPath = path.join(root, 'template.db')
  const client = createClient({ url: fileUrl(dbPath) })
  try {
    await client.execute('PRAGMA journal_mode = WAL')
    await client.execute('PRAGMA busy_timeout = 5000')
    await client.batch(await loadSchemaStatements(), 'write')
    await finalizeAgentSchema(client)
    // Fold the WAL back into the main file so the copy is self-contained.
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    client.close()
  }
  harnessDiagnostics.schemaInitializations++
  return dbPath
}

function getSchemaTemplate(): Promise<string> {
  if (!schemaTemplate) {
    const init = initSchemaTemplate()
    schemaTemplate = init.catch((error: unknown) => {
      schemaTemplate = null
      throw error
    })
  }
  return schemaTemplate
}

export async function createStoreHarness(
  options: { secretValues?: string[] } = {},
): Promise<StoreHarness> {
  harnessDiagnostics.harnessCreations++
  // Exit-sweep backstop from birth: even if a test crashes before its
  // onTestFinished cleanup runs, the root is still removed at process exit.
  const root = await mkdtemp(path.join(tmpdir(), 'kimaki-agent-test-'))
  deferSweep(root)
  await copyFile(await getSchemaTemplate(), path.join(root, 'host.db'))
  const rawClient = createClient({ url: fileUrl(path.join(root, 'host.db')) })
  // busy_timeout is per-connection; WAL journal mode persists in the copied file.
  await rawClient.execute('PRAGMA busy_timeout = 5000')
  // The coordinator runs concurrent write lanes (event tail + drain + ingest)
  // against one file DB. @libsql/client's local transaction() BEGIN does not
  // honor busy_timeout in 0.17.x, so overlapping writes throw SQLITE_BUSY. The
  // bundle's node:sqlite adapter serialized these implicitly; replicate that
  // with a single-writer chain. (Host wiring in ZK-008 must provide the same
  // single-writer guarantee for production traffic.)
  let writeChain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const next = writeChain.then(job, job)
    writeChain = next.catch(() => undefined)
    return next
  }
  const client: Client = {
    execute: (stmt: Parameters<Client['execute']>[0]) => enqueue(() => rawClient.execute(stmt)),
    // Hold the single-writer chain for the WHOLE transaction. The barrier is
    // installed synchronously at call time (see serializeWrites in sql.ts for
    // the ordering argument) so nothing enqueued during BEGIN can overtake.
    transaction: (...args: []) => {
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const begin = writeChain.then(
        () => rawClient.transaction(...(args as [])),
        () => rawClient.transaction(...(args as [])),
      )
      writeChain = begin.then(
        () => held,
        () => held,
      )
      return begin.then(
        (tx) => ({
          execute: (stmt: Parameters<Client['execute']>[0]) => tx.execute(stmt as never),
          commit: async () => {
            try {
              await tx.commit()
            } finally {
              release()
            }
          },
          rollback: async () => {
            try {
              await tx.rollback()
            } finally {
              release()
            }
          },
          close: async () => {
            try {
              await tx.close()
            } finally {
              release()
            }
          },
        }),
        (error) => {
          release()
          throw error
        },
      )
    },
    batch: (stmts: Parameters<Client['batch']>[0], mode: Parameters<Client['batch']>[1]) =>
      enqueue(() => rawClient.batch(stmts, mode as never)),
    close: () => rawClient.close(),
    get closed() {
      return rawClient.closed
    },
  } as unknown as Client
  const cleanup = async (): Promise<void> => {
    // #27: release the WAL/shm sidecars BEFORE close (checkpoint folds -wal
    // into the main file; stepping out of WAL deletes the sidecars). The main
    // DB file itself stays held by libsql's native binding until process
    // exit — measured on this host: rm is EPERM after close and after GC, and
    // succeeds from the 'exit' event — so there are NO retry sleeps here
    // (the old 5×50 ms loop always exhausted and leaked every temp dir);
    // whatever rm cannot take now is swept at exit via deferSweep.
    try {
      await rawClient.execute('PRAGMA busy_timeout = 200')
    } catch {
      // already closing; best effort
    }
    try {
      await rawClient.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // open lanes can block a checkpoint; close below still releases the client
    }
    try {
      await rawClient.execute('PRAGMA journal_mode = DELETE')
    } catch {
      // same best-effort
    }
    client.close()
    try {
      await rm(root, { recursive: true, force: true })
      forgetSweep(root)
    } catch {
      // Handle held until this process is gone (win32) — the exit-time
      // janitor sweep owns it from here.
    }
  }
  try {
    // Dynamic import: 'vitest' module evaluation fails outright when this
    // module is loaded outside a vitest run (measurement scripts, spawned
    // fixtures), so a static import would make the harness vitest-only.
    const { onTestFinished } = await import('vitest')
    onTestFinished(cleanup)
  } catch {
    // Outside a vitest run: no test hook to register; the exit sweep
    // registered above is the backstop.
  }
  const db = libsqlSqlClient(client)
  const store = new AgentStore(db, 'test-machine', options.secretValues ?? [])
  const repo = path.join(root, 'repo')
  const home = path.join(root, 'native')
  // The owned-launch preflight realpaths the canonical workspace directory, so
  // the fixture repo must exist on disk exactly like a production project dir.
  // (win32 un-stall ZK-016: realpath(repo) threw ENOENT before any scenario.)
  await mkdir(repo, { recursive: true })
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

/**
 * Poll `fn` until it returns true, else throw after `timeout` ms. Shared by the
 * coordinator fixtures and their consumers (moved from coordinator.test.ts in #27).
 */
export async function until(
  fn: () => Promise<boolean> | boolean,
  message: string,
  timeout = 5000,
): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) {
      return
    }
    await delay(10)
  }
  throw new Error(`Timed out: ${message}`)
}

/**
 * In-process fake of the ZcodeBackend surface the coordinator consumes. Each
 * submit records content and (by default) auto-completes the turn through the
 * event lane exactly like the real native projector flow: turn-started →
 * terminal → authoritative snapshot terminal for the reconcile readback.
 * Lives in this non-test module so importing it never re-registers suites (#27).
 */
export class FakeBackend {
  readonly id = 'zcode' as const
  generation: string | null = 'g1'
  submits: string[] = []
  turns = 0
  held = false
  submitError: Error | null = null
  cancelResult: Result<void> = { ok: true, value: undefined }
  private listener: ((sessionId: string, event: NativeEvent) => void) | null = null
  readonly profile: NativeProfile

  constructor(session: AgentSession, attachmentRoot: string) {
    this.profile = {
      id: session.profileId,
      revision: session.profileRevision,
      enabled: true,
      mode: 'build',
      codec: fakeCodec,
      allowSynthetic: true,
      preferences: {},
      display: 'legacy',
      launch: () => {
        throw new Error('not used in-process')
      },
      timeoutMs: 5000,
      cancelGraceMs: 150,
      imageCapability: false,
      attachmentRoot,
      redact: (value) => value,
    }
  }

  onEvent(listener: (sessionId: string, event: NativeEvent) => void): void {
    this.listener = listener
  }

  emit(event: NativeEvent): void {
    this.listener?.('zc:session-1', event)
  }

  get ownedSessionId(): string | null {
    return 'zc:session-1'
  }

  get pendingInteractions(): NativeInteraction[] {
    return [...this.interactions.values()]
  }

  private interactions = new Map<string, NativeInteraction>()

  disposeSession(): Promise<Result<void>> {
    return Promise.resolve({ ok: true, value: undefined })
  }

  dispose(): Promise<Result<void>> {
    return Promise.resolve({ ok: true, value: undefined })
  }

  async prepare(
    session: AgentSession,
  ): Promise<{ nativeSessionId: string; fingerprint: string; snapshot: NativeSnapshot }> {
    return {
      nativeSessionId: session.nativeSessionId ?? 'native-1',
      fingerprint: 'f'.repeat(64),
      snapshot: this.snapshot(),
    }
  }

  snapshot(): NativeSnapshot {
    return {
      sessionId: 'native-1',
      workspacePath: 'repo',
      workspaceKey: 'repo',
      model: { providerId: 'fixture', modelId: 'fixture-model', revision: 'r1', reasoning: 'high' },
      foreground: this.pendingTurn ? { id: this.pendingTurn, state: 'running' } : null,
      background: [],
      goalActive: false,
      terminal: this.terminal,
    }
  }

  terminal: { turnId: string; outcome: 'completed' | 'failed' | 'cancelled' } | null = null
  /** Turn currently in flight; null = quiescent (the real pre-submit state). */
  pendingTurn: string | null = null

  async inspect(): Promise<NativeSnapshot> {
    return this.snapshot()
  }

  async submit(
    _session: AgentSession,
    input: string,
    _attachments: readonly Attachment[] = [],
  ): Promise<void> {
    if (this.submitError) {
      throw this.submitError
    }
    this.submits.push(input)
    this.turns++
    const turnId = `t${this.turns}`
    this.pendingTurn = turnId
    this.emit({ type: 'turn-started', turnId })
    if (!this.held) {
      this.finishTurn(turnId)
    }
  }

  finishTurn(turnId: string): void {
    this.terminal = { turnId, outcome: 'completed' }
    this.pendingTurn = null
    this.emit({ type: 'terminal', turnId, outcome: 'completed' })
  }

  /** Register a native interaction the coordinator can answer (one-use). */
  offerInteraction(request: NativeInteraction): void {
    this.interactions.set(request.id, request)
    this.emit({ type: 'interaction', request })
  }

  async guide(): Promise<void> {}

  async answer(request: NativeInteraction): Promise<void> {
    this.interactions.delete(request.id)
    this.emit({ type: 'interaction-closed', id: request.id })
  }

  async cancel(): Promise<Result<void>> {
    if (this.cancelGate) {
      await this.cancelGate
    }
    this.held = false
    this.terminal = null
    this.pendingTurn = null
    return this.cancelResult
  }

  /** Test gate: when set, the native stop hangs until the promise resolves. */
  cancelGate: Promise<void> | null = null

  async compact(): Promise<void> {}

  async switchModel(_session: AgentSession, selection: ModelSelection): Promise<ModelSelection> {
    return selection
  }

  async forkPoint(): Promise<ForkPoint> {
    return { rowId: 1, entityId: 'e1', revision: 1, logEpoch: 'epoch-1' }
  }

  async fork(): Promise<string> {
    return 'native-child-1'
  }
}

/**
 * Coordinator + store + fake native backend wired exactly like the ZK-007
 * contract tests. Shared fixture moved out of coordinator.test.ts in #27 so
 * importers no longer re-execute the coordinator suite.
 */
export async function coordinatorHarness(
  options: { limits?: { maxPendingEvents?: number; maxPendingEventBytes?: number } } = {},
) {
  const h = await createStoreHarness()
  const backend = new FakeBackend(h.session, h.root)
  const authorize: Authorizer = (actorId, threadId, session) =>
    Promise.resolve(actorId === 'actor-1' && threadId === session.controllerThreadId)
  const coordinator = new AgentCoordinator(
    h.store,
    backend as never,
    authorize,
    options.limits ?? {},
  )
  const submit = async (
    sourceId: string,
    text: string,
    kind: 'prompt' | 'guide' | 'answer' | 'cancel' | 'model' | 'compact' | 'fork' = 'prompt',
    payload?: unknown,
  ) => {
    const result = await coordinator.ingest(h.input(sourceId, text, kind, payload))
    assert.equal(result.ok, true, JSON.stringify(result.ok ? '' : result.error.toJSON()))
    return result.value
  }
  const waitForState = async (opId: string, state: string) => {
    await until(async () => (await h.store.operation(opId))?.state === state, `${opId} → ${state}`)
  }
  return { ...h, backend, coordinator, submit, waitForState }
}
