// SWARM #23 regression — POSIX supervisor-death containment. Before the fix,
// an abrupt supervisor kill (SIGKILL, OOM, any group-wide kill) orphaned the
// detached native process tree: the child was its own session leader and only
// a LIVE supervisor could ever signal the group — win32 had the job keeper,
// POSIX had nothing. The fix is a POSIX keeper (twin of the win32 one): a
// detached node process whose stdin the supervisor holds; ANY supervisor death
// EOFs that stdin and the keeper terminates the watched process group
// (SIGTERM → grace → SIGKILL).
// (1)/(2) POSIX drills: SIGKILL the supervisor and assert the tree dies within
//   the stated bound (the ticket's acceptance scenario), plus the clean-stop
//   path stays green. They live in supervision-posix-drill.mjs — zero-dep
//   plain Node so the drill also runs standalone without the pnpm toolchain
//   (executed under WSL Ubuntu, node v20.20.2, during this fix: pre-fix
//   brutal drill orphaned past 10000ms; post-fix tree dead in 2ms). Skipped
//   on win32.
// (3) wiring tests run EVERYWHERE — the code-level guarantee the ticket asks
//   for on non-POSIX hosts: the spawned twin supervisor.js must actually
//   carry the POSIX keeper wiring (EOF watch active on POSIX builds), the
//   twins must stay in sync, and the process.ts containment note must tell
//   the new truth.
// — ZCode 2026-09-28
import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  drillBrutalSupervisorDeath,
  drillCleanStop,
  TREE_DEAD_BOUND_MS,
} from './supervision-posix-drill.mjs'

const posixOnly = process.platform !== 'win32' ? test : test.skip
const twinJsPath = fileURLToPath(new URL('./supervisor.js', import.meta.url))
const twinTsPath = fileURLToPath(new URL('./supervisor.ts', import.meta.url))
const processTsPath = fileURLToPath(new URL('./process.ts', import.meta.url))

describe('SWARM #23 POSIX supervisor-death containment', () => {
  posixOnly(
    'brutal supervisor SIGKILL still contains the native tree',
    { timeout: 90000 },
    async () => {
      const detail = await drillBrutalSupervisorDeath()
      assert.ok(
        detail.elapsedMs <= TREE_DEAD_BOUND_MS,
        `tree died in ${detail.elapsedMs}ms, bound ${TREE_DEAD_BOUND_MS}ms`,
      )
    },
  )

  posixOnly(
    'clean stop terminates the native tree on POSIX',
    { timeout: 90000 },
    async () => {
      const detail = await drillCleanStop()
      assert.ok(
        detail.elapsedMs <= TREE_DEAD_BOUND_MS,
        `tree died in ${detail.elapsedMs}ms, bound ${TREE_DEAD_BOUND_MS}ms`,
      )
    },
  )

  test('spawned twin wires the EOF watch and group kill (code-level, POSIX builds)', async () => {
    const src = await readFile(twinJsPath, 'utf8')
    // The keeper script exists and watches stdin for the supervisor's death.
    assert.match(src, /const KEEPER_JS = String\.raw/)
    assert.ok(
      src.includes("process.stdin.on('end', () => { if (!stopping) terminate() })"),
      'keeper must terminate the watched group on stdin EOF (supervisor death)',
    )
    // EOF containment is a process-GROUP kill, escalating TERM → KILL.
    assert.ok(
      src.includes("try { process.kill(-watched.pgid, 'SIGTERM') } catch {}"),
      'keeper must SIGTERM the watched process group',
    )
    assert.ok(
      src.includes("try { process.kill(-watched.pgid, 'SIGKILL') } catch {}"),
      'keeper must escalate to SIGKILL',
    )
    // Arming is acked: containment is provably held before 'ready' goes out.
    assert.ok(src.includes('WATCH-OK '), 'keeper must ack WATCH with WATCH-OK')
    assert.ok(
      src.includes('isWin ? await assignToJob(pid) : await watchGroup(pid)'),
      'containment arming must run on BOTH platforms, not win32 only',
    )
    // Keeper boot is not win32-gated (the pre-fix bug: `if (isWin) { try { await startKeeper() ...`).
    assert.doesNotMatch(
      src,
      /if \(isWin\)\s*\{\s*try\s*\{\s*await startKeeper\(\)/,
      'keeper startup must not be gated on isWin',
    )
    assert.match(src, /await startKeeper\(\)/, 'keeper startup must be awaited in begin()')
    // The keeper must survive a group-wide kill of the supervisor: own session.
    assert.match(
      src,
      /spawn\(process\.execPath, \['-e', KEEPER_JS\], \{\s*stdio: \['pipe', 'pipe', 'pipe'\],\s*detached: true,?\s*\}\)/,
      'POSIX keeper must spawn detached (own session)',
    )
  })

  test('keeper script is identical in the .ts twin and the spawned .js twin', async () => {
    // The keeper body contains no backticks, so the first backtick after the
    // opening IS the closing one (the twins differ only in `String.raw ` spacing
    // and the trailing `;` — both outside the capture).
    const extract = (src: string) => src.match(/const KEEPER_JS = String\.raw\s*`([\s\S]*?)`/)?.[1]
    const fromTs = extract(await readFile(twinTsPath, 'utf8'))
    const fromJs = extract(await readFile(twinJsPath, 'utf8'))
    assert.ok(fromTs && fromJs, 'KEEPER_JS must exist in both twins')
    assert.equal(
      fromTs,
      fromJs,
      'supervisor.ts and the spawned supervisor.js must carry the same keeper script',
    )
  })

  test('process.ts containment note covers the POSIX keeper and keeps the honest caveat', async () => {
    const src = await readFile(processTsPath, 'utf8')
    assert.match(
      src,
      /POSIX.*keeper|keeper.*POSIX/is,
      'containment note must describe the POSIX keeper',
    )
    assert.match(
      src,
      /escape into their own session.*stronger OS containment; not certified here/s,
      'note must keep the honest not-certified caveat for escaped descendants',
    )
  })
})
