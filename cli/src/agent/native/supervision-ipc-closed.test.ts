// SWARM #22 regression drills — unguarded process.send in the supervisor's
// failure paths threw ERR_IPC_CHANNEL_CLOSED synchronously when the IPC channel
// was already closed (parent death): optional chaining only covers `undefined`.
// The throw pre-empted the void stop() on the next line, so the supervisor died
// on an unhandled exception mid-stop instead of shutting down cleanly.
// (1) parent death (IPC disconnect) with a pending spawn error must still run
//     stop() to completion — clean exit, no ERR_IPC_CHANNEL_CLOSED;
// (2) the failure-notification contract with a live channel is unchanged.
// Drill (1) is win32-only, and its determinism is the job keeper's boot: the
// keeper always prints READY before reading its stdin, so begin() always
// resumes and spawns the native — with a nonexistent executable only the
// 'error' event fires (never 'spawn', so no assignToJob/keeper-stdin write
// can race in), while the channel has been closed since ~10ms after start,
// long before the keeper's Add-Type boot lets begin() resume. The unguarded
// process.send in owned.on('error') then throws on the closed channel.
// — ZCode 2026-09-28
import { describe, onTestFinished, test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn, type ChildProcess } from 'node:child_process'

const win32Only = process.platform === 'win32' ? test : test.skip
const supervisorPath = fileURLToPath(new URL('./supervisor.js', import.meta.url))

function startSupervisor(cwd: string) {
  const child: ChildProcess = spawn(process.execPath, [supervisorPath], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    // Sparse env like the ZK-016 drills; TEMP/TMP/SystemRoot keep the
    // supervisor's os.tmpdir() aligned with this test process's tmpdir().
    env: {
      PATH: process.env.PATH ?? '',
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      SystemRoot: process.env.SystemRoot,
    },
  })
  const stderr: string[] = []
  child.stderr!.on('data', (c: Buffer) => stderr.push(c.toString()))
  return { child, stderrText: () => stderr.join('') }
}

describe('SWARM #22 supervisor IPC-closed failure paths', () => {
  win32Only(
    'parent death with a pending spawn error still runs stop() cleanly',
    { timeout: 45000 },
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'zk22-sup-'))
      onTestFinished(async () => {
        await rm(dir, { recursive: true, force: true })
      })
      const { child, stderrText } = startSupervisor(dir)
      onTestFinished(() => {
        if (child.exitCode === null) child.kill()
      })
      child.send({
        type: 'start',
        executable: path.join(dir, 'missing-native-binary.exe'),
        args: [],
        cwd: dir,
        env: {},
        graceMs: 5000,
      })
      // Let the start message flush, then close the IPC channel — the
      // parent-death simulation. It lands long before the keeper's boot can
      // let begin() resume, so the channel is closed when the spawn 'error'
      // handler runs.
      await delay(10)
      child.disconnect()
      const exited = new Promise<number | null>((resolve) =>
        child.once('exit', (c) => resolve(c)),
      )
      const code = await exited
      // stop() ran to completion: its no-pid branch is the only clean-exit
      // path — the pre-fix code died on the closed-channel send instead.
      assert.equal(code, 0, `supervisor exit code; stderr: ${stderrText()}`)
      assert.doesNotMatch(
        stderrText(),
        /ERR_IPC_CHANNEL_CLOSED|Channel closed/i,
        'supervisor died on a closed-channel send instead of stopping cleanly',
      )
    },
  )

  test('spawn error with a live channel still reports failure and stops cleanly', { timeout: 45000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zk22-sup-'))
    onTestFinished(async () => {
      await rm(dir, { recursive: true, force: true })
    })
    const { child, stderrText } = startSupervisor(dir)
    onTestFinished(() => {
      if (child.exitCode === null) child.kill()
    })
    const failure = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('failure message timeout')),
        40000,
      )
      child.on('message', (m: unknown) => {
        if ((m as { type?: string })?.type === 'failure') {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    child.send({
      type: 'start',
      executable: path.join(dir, 'missing-native-binary.exe'),
      args: [],
      cwd: dir,
      env: {},
      graceMs: 5000,
    })
    await failure
    const code = await new Promise<number | null>((resolve) =>
      child.once('exit', (c) => resolve(c)),
    )
    assert.equal(code, 0, `supervisor exit code; stderr: ${stderrText()}`)
  })
})
