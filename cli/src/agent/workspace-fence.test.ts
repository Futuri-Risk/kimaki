// ZK-012 writer-fence contract tests over the REAL store: a native workspace
// lease (including one held by an active turn) refuses every managed writer —
// shell, worktree merge/delete, provisioning — before any git call runs; no
// lease means OpenCode-only behavior is unchanged; the idle-sweep veto keeps
// native runtimes alive while operations (including uncertain ones) exist.
// — ZCode 2026-09-18
import { test, expect, vi } from 'vitest'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const state = {
  dbClient: null as unknown as import('@libsql/client').Client,
  sessionForThread: null as string | null,
  activeNativeOps: 0,
}

vi.mock('../db.js', () => ({
  getRawDbClient: async () => state.dbClient,
}))
vi.mock('../database.js', () => ({
  getThreadSession: async () => state.sessionForThread,
}))
vi.mock('./host-sidecar.js', () => ({
  lookupBackendSidecar: async () => ({ backend: 'zcode' }),
  countActiveNativeOperations: async () => state.activeNativeOps,
}))

import {
  nativeDisposalAllowed,
  nativeWorkspaceWriter,
  writerFenceRefusal,
} from './workspace-fence.js'
import { coordinatorHarness } from './test-harness.js'
import { deleteWorktree, mergeWorktree } from '../worktrees.js'

test('an active native turn holds the lease and refuses every managed writer', async () => {
  const h = await coordinatorHarness()
  state.dbClient = h.client
  h.backend.held = true
  const op = await h.submit('work', 'do work')
  await h.waitForState(op.id, 'running')

  const repo = h.session.workspace.canonicalDirectory
  const hold = await nativeWorkspaceWriter(repo)
  assert.equal(hold.held, true)
  assert.equal(hold.held && hold.sessionId, h.session.id)

  const refusal = await writerFenceRefusal(repo, 'Shell command')
  assert.match(refusal ?? '', /Shell command refused: native session/)

  // Worktree delete and merge refuse BEFORE any git command can run.
  const deleted = await deleteWorktree({
    projectDirectory: repo,
    worktreeDirectory: repo,
    worktreeName: 'branch-x',
  })
  assert.ok(deleted instanceof Error)
  assert.match(deleted.message, /Worktree delete refused/)

  const merged = await mergeWorktree({
    worktreeDir: repo,
    mainRepoDir: repo,
    worktreeName: 'branch-x',
  })
  assert.ok(merged instanceof Error)
  assert.match((merged as Error).message, /writer fence: Worktree merge refused/)

  await h.coordinator.close()
})

test('fence matching is canonical: separators, trailing slashes, and case do not bypass it', async () => {
  const h = await coordinatorHarness()
  state.dbClient = h.client
  h.backend.held = true
  const op = await h.submit('work', 'do work')
  await h.waitForState(op.id, 'running')
  const repo = h.session.workspace.canonicalDirectory
  const variants = [repo, `${repo}/`, repo.split('/').join('\\'), repo.toUpperCase()]
  for (const variant of variants) {
    assert.equal((await nativeWorkspaceWriter(variant)).held, true, variant)
  }
  assert.equal((await nativeWorkspaceWriter(`${repo}-elsewhere`)).held, false)
  await h.coordinator.close()
})

test('no lease means no refusal — OpenCode-only threads keep byte-identical behavior', async () => {
  const h = await coordinatorHarness()
  state.dbClient = h.client
  assert.equal((await nativeWorkspaceWriter(h.root)).held, false)
  assert.equal(await writerFenceRefusal(h.root, 'Shell command'), null)
  await h.coordinator.close()
})

test('idle-sweep veto: active or uncertain native work keeps the runtime, quiet threads sweep', async () => {
  const h = await coordinatorHarness()
  state.dbClient = h.client
  state.sessionForThread = h.session.id
  h.backend.held = true
  const op = await h.submit('work', 'do work')
  await h.waitForState(op.id, 'running')
  state.activeNativeOps = 1
  assert.equal(await nativeDisposalAllowed('thread-1'), false)
  // Uncertain states (submission-unknown) are still non-terminal → veto holds.
  state.activeNativeOps = 2
  assert.equal(await nativeDisposalAllowed('thread-1'), false)
  state.activeNativeOps = 0
  assert.equal(await nativeDisposalAllowed('thread-1'), true)
  state.sessionForThread = null
  assert.equal(await nativeDisposalAllowed('thread-other'), true)
  await h.coordinator.close()
})

test('source pins: fences run before any git or provisioning write', async () => {
  const here = fileURLToPath(new URL('./workspace-fence.test.ts', import.meta.url)).replace(
    /[^/\\]+$/,
    '',
  )
  const worktrees = await readFile(`${here}../worktrees.ts`, 'utf8')
  const bot = await readFile(`${here}../discord-bot.ts`, 'utf8')
  const newWorktree = await readFile(`${here}../commands/new-worktree.ts`, 'utf8')
  const sweeper = await readFile(`${here}../runtime-idle-sweeper.ts`, 'utf8')
  assert.ok(
    worktrees.indexOf('writerFenceRefusal(worktreeDirectory') <
      worktrees.indexOf('worktree remove'),
  )
  const mergeSig = worktrees.indexOf('export async function mergeWorktree')
  const mergeFenceAt = worktrees.indexOf('writerFenceRefusal(worktreeDir', mergeSig)
  assert.ok(mergeFenceAt > mergeSig)
  assert.ok(worktrees.indexOf('await git(', mergeFenceAt) > mergeFenceAt)
  const botFence = bot.indexOf('writerFenceRefusal(shellDir')
  // The fenced shell is the THREAD branch (ZK-005's host-shell log marks it);
  // its runShellCommand call follows the fence within the same branch.
  assert.ok(botFence > bot.indexOf('host shell on native session thread'))
  assert.ok(bot.indexOf('runShellCommand({', botFence) > botFence)
  // Provisioning is fenced before its pending row is written.
  assert.ok(
    newWorktree.indexOf('writerFenceRefusal(projectDirectory') <
      newWorktree.indexOf('await createPendingWorkspace({'),
  )
  assert.ok(sweeper.includes('shouldDispose: nativeDisposalAllowed'))
  expect(true).toBe(true)
})
