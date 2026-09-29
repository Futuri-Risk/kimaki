// #24 regression tests: cross-session native-home lease contention and kick()
// retry bounding. (a) A session that settled a turn and idles must retire its
// native-home lease to a second session on the same machine — no permanent
// WORKSPACE_BUSY. (b) A queued prompt that survives a drain cycle unclaimed
// (recurring pre-transition failure, e.g. WORKSPACE_BUSY while another session
// runs) backs off exponentially with a bounded retry count instead of a
// zero-delay hot retry loop. Store-level transfer semantics pin the fence
// edges: same-nonce only, quiescent owner only, home resource only.
// — ZCode 2026-09-28
import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { AgentCoordinator, type Authorizer } from './coordinator.js'
import { createStoreHarness } from './test-harness.js'
import { FakeBackend } from './coordinator.test.js'
import { fail } from './errors.js'
import type { SqlClient } from './sql.js'
import type { AgentSession, NativeEvent, NativeSnapshot, Operation } from './types.js'

async function until(
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
 * FakeBackend routes every event to the hardcoded 'zc:session-1'. This
 * subclass routes events to whichever session the coordinator last prepared
 * (exactly what the real backend's owned connection does) so two sessions can
 * take turns through one coordinator. coordinator.test.ts stays untouched.
 */
class RoutedBackend extends FakeBackend {
  attached: string | null = null
  private routed: ((sessionId: string, event: NativeEvent) => void) | null = null
  private nextNative = 0
  override onEvent(listener: (sessionId: string, event: NativeEvent) => void): void {
    this.routed = listener
    super.onEvent(listener)
  }
  override emit(event: NativeEvent): void {
    ;(this.routed ?? (() => {}))(this.attached ?? 'zc:session-1', event)
  }
  override async prepare(session: AgentSession): Promise<{
    nativeSessionId: string
    fingerprint: string
    snapshot: NativeSnapshot
  }> {
    this.attached = session.id
    const prepared = await super.prepare(session)
    // The real backend creates a DISTINCT native session per host session; the
    // fake's constant 'native-1' would violate the store's UNIQUE
    // (backend,machine,home,native_session_id) constraint on second bind.
    if (!session.nativeSessionId) {
      this.nextNative++
      return { ...prepared, nativeSessionId: `native-${this.nextNative}` }
    }
    return prepared
  }
  override get ownedSessionId(): string | null {
    return this.attached ?? 'zc:session-1'
  }
}

async function contentionHarness(limits: ConstructorParameters<typeof AgentCoordinator>[3] = {}) {
  const h = await createStoreHarness()
  const backend = new RoutedBackend(h.session, h.root)
  const authorize: Authorizer = (actorId, threadId, session) =>
    Promise.resolve(actorId === 'actor-1' && threadId === session.controllerThreadId)
  const coordinator = new AgentCoordinator(h.store, backend as never, authorize, limits)
  // Session B: same machine and native home as A, different project directory,
  // so the native-home lease is the only contended resource.
  const repoB = path.join(h.root, 'repo-b')
  await mkdir(repoB, { recursive: true })
  const sessionB: AgentSession = {
    ...h.session,
    id: 'zc:session-2',
    controllerThreadId: 'thread-2',
    workspace: {
      ...h.session.workspace,
      projectDirectory: repoB,
      canonicalDirectory: repoB,
      nativeWorkspacePath: repoB,
      nativeWorkspaceKey: repoB,
    },
  }
  await h.store.insertSession(sessionB)
  const submit = async (
    sessionId: 'zc:session-1' | 'zc:session-2',
    sourceId: string,
    text: string,
  ): Promise<Operation> => {
    const input =
      sessionId === 'zc:session-1'
        ? h.input(sourceId, text)
        : {
            sessionId,
            threadId: 'thread-2',
            actorId: 'actor-1',
            source: 'discord' as const,
            sourceId,
            kind: 'prompt' as const,
            text,
          }
    const result = await coordinator.ingest(input)
    assert.equal(result.ok, true, JSON.stringify(result.ok ? '' : result.error.toJSON()))
    return result.value
  }
  const waitForState = async (opId: string, state: string) => {
    await until(async () => (await h.store.operation(opId))?.state === state, `${opId} → ${state}`)
  }
  const leaseRow = async (resource: string) =>
    (await h.store.leases()).find((r) => String(r.resource) === resource) ?? null
  return {
    ...h,
    backend,
    coordinator,
    sessionB,
    submit,
    waitForState,
    leaseRow,
    homeResource: `home:${h.session.workspace.nativeHomeIdentity}`,
  }
}

/** Count every store-read statement hitting the DB (lower bound on cycles). */
function countStatements(h: { db: SqlClient }) {
  let statements = 0
  const original = h.db.execute.bind(h.db)
  h.db.execute = async (statement) => {
    statements++
    return original(statement)
  }
  return () => statements
}

describe('#24 native-home lease retirement (cross-session contention)', () => {
  test('a settled idle session transfers its home lease: the second session is admitted, not WORKSPACE_BUSY', async () => {
    const h = await contentionHarness()
    // Session A runs a turn to completion and idles.
    const a = await h.submit('zc:session-1', 'a', 'first turn')
    await h.waitForState(a.id, 'completed')
    await h.coordinator.settle()
    // Steady state per releaseSettled: the workspace lease is released but the
    // native home stays with its resident session — the pre-#24 deadlock state.
    const held = await h.leaseRow(h.homeResource)
    assert.ok(held, 'home lease exists after the settled turn')
    assert.equal(String(held.agent_session_id), h.session.id)
    // Session B, same machine and home, MUST now be admitted (#24 acceptance).
    const b = await h.submit('zc:session-2', 'b', 'second session turn')
    await h.waitForState(b.id, 'completed')
    assert.deepEqual(h.backend.submits, ['first turn', 'second session turn'])
    assert.equal(String((await h.leaseRow(h.homeResource))!.agent_session_id), h.sessionB.id)
    await h.coordinator.close()
  })

  test('a queued second session waits without hot-looping while the first runs, then runs after settle', async () => {
    const h = await contentionHarness({ kickBackoff: { baseMs: 20, maxMs: 40, maxRetries: 50 } })
    const read = countStatements(h)
    // B settles first and owns the idle home; A takes it over for a long turn.
    const b1 = await h.submit('zc:session-2', 'b1', 'b first')
    await h.waitForState(b1.id, 'completed')
    await h.coordinator.settle()
    assert.equal(String((await h.leaseRow(h.homeResource))!.agent_session_id), h.sessionB.id)
    h.backend.held = true
    const a = await h.submit('zc:session-1', 'a', 'long turn')
    await h.waitForState(a.id, 'running')
    assert.equal(String((await h.leaseRow(h.homeResource))!.agent_session_id), h.session.id)
    // B queues behind the active home owner. Pre-#24 this re-kicked at zero
    // delay (~5 statements per cycle, unbounded); the backoff bounds it.
    const before = read()
    const b2 = await h.submit('zc:session-2', 'b2', 'waiting turn')
    await delay(700)
    const inWindow = read() - before
    assert.equal((await h.store.operation(b2.id))?.state, 'queued')
    assert.ok(
      inWindow < 250,
      `DB statements in the 700ms window must be bounded (hot loop = 1000+), got ${inWindow}`,
    )
    // The blocker settles; B is admitted via its backed-off retry.
    h.backend.held = false
    h.backend.finishTurn('t2')
    await h.waitForState(b2.id, 'completed')
    assert.deepEqual(h.backend.submits, ['b first', 'long turn', 'waiting turn'])
    await h.coordinator.close()
  })
})

describe('#24 kick() retry bounding for recurring pre-transition failures', () => {
  test('exhausts bounded retries, stops querying, and a fresh admission revives the queue', async () => {
    const h = await contentionHarness({ kickBackoff: { baseMs: 5, maxMs: 10, maxRetries: 3 } })
    const read = countStatements(h)
    // Warm A into the settled-idle steady state (the state the hot loop hits).
    const warm = await h.submit('zc:session-1', 'warm', 'warm turn')
    await h.waitForState(warm.id, 'completed')
    await h.coordinator.settle()
    // Deterministic recurring pre-transition failure: acquire always refuses.
    const realAcquire = h.store.acquire.bind(h.store)
    let acquireCalls = 0
    h.store.acquire = async () => {
      acquireCalls++
      throw fail('WORKSPACE_BUSY', 'forced pre-transition failure')
    }
    const blocked = await h.submit('zc:session-1', 'blocked', 'blocked prompt')
    await delay(400)
    const frozenAcquires = acquireCalls
    assert.equal((await h.store.operation(blocked.id))?.state, 'queued')
    assert.ok(frozenAcquires >= 2, `expected several bounded retries, got ${frozenAcquires}`)
    assert.ok(h.coordinator.diagnostics.includes('KICK_RETRY_EXHAUSTED'))
    // Snapshot AFTER the assertion queries above (they count too) — the retry
    // loop has stopped, so no further DB traffic for the queued prompt.
    const frozenStatements = read()
    await delay(300)
    assert.equal(read(), frozenStatements, 'statements after exhaustion must be frozen')
    assert.equal(acquireCalls, frozenAcquires)
    // A fresh admission restarts the cycle and the queue drains FIFO.
    h.store.acquire = realAcquire
    const revived = await h.submit('zc:session-1', 'revived', 'after recovery')
    await h.waitForState(blocked.id, 'completed')
    await h.waitForState(revived.id, 'completed')
    assert.deepEqual(h.backend.submits, ['warm turn', 'blocked prompt', 'after recovery'])
    await h.coordinator.close()
  })
})

describe('#24 store-level home transfer semantics', () => {
  test('same-nonce home transfer requires a durably quiescent owner; workspace leases never transfer', async () => {
    const h = await createStoreHarness()
    const sibling = async (id: string, directory: string) => {
      const session: AgentSession = {
        ...h.session,
        id,
        workspace: {
          ...h.session.workspace,
          projectDirectory: directory,
          canonicalDirectory: directory,
          nativeWorkspacePath: directory,
          nativeWorkspaceKey: directory,
        },
      }
      await h.store.insertSession(session)
      return session
    }
    const b = await sibling('zc:sibling-b', path.join(h.root, 'dir-b'))
    const c = await sibling('zc:sibling-c', path.join(h.root, 'dir-c'))
    await h.store.acquire(h.session, 'n1')
    // 'unbound' (never settled) is not a quiescent owner — no transfer.
    await assert.rejects(() => h.store.acquire(b, 'n1'), { code: 'WORKSPACE_BUSY' })
    await h.store.sessionState(h.session.id, 'idle')
    // Quiescent owner + same coordinator nonce: the home transfers.
    await h.store.acquire(b, 'n1')
    const home = `home:${h.session.workspace.nativeHomeIdentity}`
    assert.equal(String((await h.store.leases()).find((r) => String(r.resource) === home)!.agent_session_id), b.id)
    // A different nonce never takes over, even from a quiescent owner.
    await h.store.sessionState(b.id, 'idle')
    await assert.rejects(() => h.store.acquire(c, 'n2'), { code: 'WORKSPACE_BUSY' })
    // A queued (non-terminal) operation makes the owner non-quiescent again.
    await h.store.admit({
      sessionId: b.id,
      threadId: 'thread-1',
      actorId: 'actor-1',
      source: 'discord',
      sourceId: 's1',
      kind: 'prompt',
      text: 'pending work',
    })
    await assert.rejects(() => h.store.acquire(c, 'n1'), { code: 'WORKSPACE_BUSY' })
    // Workspace leases are strict even for a quiescent same-nonce owner.
    const sameDir = await sibling('zc:sibling-d', h.session.workspace.canonicalDirectory)
    await assert.rejects(() => h.store.acquire(sameDir, 'n1'), { code: 'WORKSPACE_BUSY' })
  })
})
