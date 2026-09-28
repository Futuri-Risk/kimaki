// SWARM #23 POSIX containment drills — plain Node, ZERO dependencies, so the
// ticket's acceptance scenario runs anywhere POSIX node exists (WSL, CI)
// without the pnpm toolchain. Scenario (ticket #23 acceptance): SIGKILL the
// supervisor — no stop message, no signal handlers, nothing — and assert the
// detached native tree (child + grandchild) dies within a stated bound
// (TREE_DEAD_BOUND_MS). Pre-fix, the detached session leader survives: only a
// live supervisor could ever signal it. Also drills the clean-stop path so the
// fix cannot regress normal shutdown. Stands alone:
//   node supervision-posix-drill.mjs        (exit 0 = pass, 1 = fail)
// and is imported by supervision-posix.test.ts for POSIX CI runs.
// — ZCode 2026-09-28
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const supervisorPath = fileURLToPath(new URL('./supervisor.js', import.meta.url))
/** Stated bound: keeper EOF detect + SIGTERM + 5s grace + SIGKILL + reap. */
export const TREE_DEAD_BOUND_MS = 10000
const READY_BOUND_MS = 25000

/** Alive means schedulable AND not a zombie (a zombie is dead; its liveness
 * would false-fail the drill under an init that reaps slowly). POSIX-only:
 * reads /proc — called only from the POSIX drills. */
function alive(pid) {
  try {
    process.kill(pid, 0)
  } catch (e) {
    return e.code !== 'ESRCH'
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
    return state !== 'Z'
  } catch {
    return true
  }
}

async function until(fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await delay(50)
  }
  return false
}

/** Long-lived native stand-in that spawns a grandchild, proving tree
 * containment (same shape as the ZK-016 win32 drill stand-in). */
async function nativeScript(dir) {
  const script = path.join(dir, 'native-standin.mjs')
  await writeFile(
    script,
    [
      "import { spawn } from 'node:child_process'",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "process.stdout.write('native-ready ' + process.pid + ' ' + grandchild.pid + '\\n')",
      'setInterval(() => {}, 1000)',
    ].join('\n'),
    'utf8',
  )
  return script
}

function startSupervisor(cwd) {
  const child = spawn(process.execPath, [supervisorPath], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  })
  let output = ''
  child.stdout.on('data', (c) => {
    output += c.toString()
  })
  const stderr = []
  child.stderr.on('data', (c) => stderr.push(c.toString()))
  return { child, readOutput: () => output, stderrText: () => stderr.join('') }
}

async function startTree(dir) {
  const script = await nativeScript(dir)
  const io = startSupervisor(dir)
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`supervisor ready timeout; stderr: ${io.stderrText()}`)),
      READY_BOUND_MS,
    )
    io.child.on('message', (m) => {
      const value = m
      if (value?.type === 'ready' && typeof value.pid === 'number') {
        clearTimeout(timer)
        resolve()
      }
      if (value?.type === 'failure') {
        clearTimeout(timer)
        reject(new Error(`supervisor reported failure; stderr: ${io.stderrText()}`))
      }
    })
  })
  io.child.send({
    type: 'start',
    executable: process.execPath,
    args: [script],
    cwd: dir,
    env: {},
    graceMs: 5000,
  })
  await ready
  const nativeLine = await until(
    () => /native-ready (\d+) (\d+)/.test(io.readOutput()),
    READY_BOUND_MS,
  )
  if (!nativeLine) {
    throw new Error(`native stand-in never reported ready; stderr: ${io.stderrText()}`)
  }
  const [, nativePidRaw, grandchildPidRaw] = io.readOutput().match(/native-ready (\d+) (\d+)/)
  return { io, nativePid: Number(nativePidRaw), grandchildPid: Number(grandchildPidRaw) }
}

/** Best-effort sweep so a FAILING drill never leaks the tree it created. */
function sweepTree(pids) {
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* group may not exist; the direct kill below is the fallback */
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/** Drill 1 — the ticket's acceptance scenario: SIGKILL the supervisor, assert
 * the detached native tree dies within TREE_DEAD_BOUND_MS. */
export async function drillBrutalSupervisorDeath() {
  if (process.platform === 'win32') {
    throw new Error('POSIX-only drill; run under WSL/POSIX CI')
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'zk23-posix-'))
  let tree
  try {
    tree = await startTree(dir)
    const { io, nativePid, grandchildPid } = tree
    if (!(alive(nativePid) && alive(grandchildPid))) {
      throw new Error(`native tree not alive before supervisor kill (${nativePid}/${grandchildPid})`)
    }
    const beganAt = Date.now()
    process.kill(io.child.pid, 'SIGKILL')
    await new Promise((resolve) => io.child.once('exit', resolve))
    const dead = await until(
      () => !alive(nativePid) && !alive(grandchildPid),
      TREE_DEAD_BOUND_MS,
    )
    const elapsedMs = Date.now() - beganAt
    if (!dead) {
      throw new Error(
        `orphaned native tree after supervisor SIGKILL: pid ${nativePid} grandchild ${grandchildPid} still alive after ${elapsedMs}ms (bound ${TREE_DEAD_BOUND_MS}ms)`,
      )
    }
    return { elapsedMs, nativePid, grandchildPid }
  } finally {
    sweepTree(
      tree ? [tree.nativePid, tree.grandchildPid] : [],
    )
    if (tree && tree.io.child.exitCode === null) tree.io.child.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
}

/** Drill 2 — the normal path must not regress: stop message, supervisor exit 0,
 * tree dead within bound. */
export async function drillCleanStop() {
  if (process.platform === 'win32') {
    throw new Error('POSIX-only drill; run under WSL/POSIX CI')
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'zk23-posix-'))
  let tree
  try {
    tree = await startTree(dir)
    const { io, nativePid, grandchildPid } = tree
    if (!(alive(nativePid) && alive(grandchildPid))) {
      throw new Error(`native tree not alive before stop (${nativePid}/${grandchildPid})`)
    }
    const beganAt = Date.now()
    const exited = new Promise((resolve) => io.child.once('exit', (c) => resolve(c)))
    io.child.send({ type: 'stop' })
    const code = await exited
    if (code !== 0) {
      throw new Error(`supervisor exit code ${code} on clean stop; stderr: ${io.stderrText()}`)
    }
    const dead = await until(
      () => !alive(nativePid) && !alive(grandchildPid),
      TREE_DEAD_BOUND_MS,
    )
    const elapsedMs = Date.now() - beganAt
    if (!dead) {
      throw new Error(
        `native tree survived clean stop: pid ${nativePid} grandchild ${grandchildPid} after ${elapsedMs}ms`,
      )
    }
    return { elapsedMs, nativePid, grandchildPid }
  } finally {
    sweepTree(
      tree ? [tree.nativePid, tree.grandchildPid] : [],
    )
    if (tree && tree.io.child.exitCode === null) tree.io.child.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
}

export async function runDrills() {
  const drills = [
    ['brutal-supervisor-death', drillBrutalSupervisorDeath],
    ['clean-stop', drillCleanStop],
  ]
  const results = []
  let failed = false
  for (const [name, fn] of drills) {
    try {
      const detail = await fn()
      results.push({ drill: name, ok: true, ...detail })
      console.log(`PASS ${name} ${JSON.stringify(detail)}`)
    } catch (e) {
      failed = true
      results.push({ drill: name, ok: false, error: String(e?.message ?? e) })
      console.log(`FAIL ${name} ${JSON.stringify({ error: String(e?.message ?? e) })}`)
    }
  }
  return { ok: !failed, results }
}

const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  if (process.platform === 'win32') {
    console.log('SKIP posix-only drill host is win32')
    process.exit(0)
  }
  const outcome = await runDrills()
  process.exit(outcome.ok ? 0 : 1)
}
