// ZK-016 Windows supervision drills — the job-object keeper contract on win32:
// (1) owned launch ready + clean stop kills the native tree; (2) brutal
// supervisor death (no stop message) still contains the tree — keeper stdin
// closes, the job handle releases, the OS kills every descendant.
// Win32-only by nature; skipped elsewhere. — ZCode 2026-09-18
import { describe, onTestFinished, test } from 'vitest'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node:child_process'

const win32Only = process.platform === 'win32' ? test : test.skip
const supervisorPath = fileURLToPath(new URL('./supervisor.js', import.meta.url))

/** Long-lived native stand-in that spawns a grandchild, proving tree containment. */
async function nativeScript(dir: string) {
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

async function childrenOf(pid: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").ProcessId`,
      ],
      { windowsHide: true },
      (error, stdout) => {
        if (error) reject(error)
        else
          resolve(
            stdout
              .toString()
              .split(/\s+/)
              .map((v) => Number.parseInt(v, 10))
              .filter((v) => Number.isSafeInteger(v) && v > 0),
          )
      },
    )
  })
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function until(fn: () => boolean | undefined, ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await delay(50)
  }
  return false
}

function startSupervisor(cwd: string) {
  const child = spawn(process.execPath, [supervisorPath], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH ?? '' },
  })
  let output = ''
  child.stdout!.on('data', (c: Buffer) => {
    output += c.toString()
  })
  const stderr: string[] = []
  child.stderr!.on('data', (c: Buffer) => stderr.push(c.toString()))
  return { child, readOutput: () => output, stderrLines: () => stderr }
}

async function waitReady(io: { readOutput: () => string; stderrLines: () => string[] }, ms = 20000) {
  const ok = await until(() => io.readOutput().includes('native-ready'), ms)
  assert.ok(ok, `native stand-in never reported ready; stderr: ${io.stderrLines().join('')}`)
}

describe('ZK-016 win32 job-object supervision', () => {
  win32Only('clean stop terminates the native tree', { timeout: 45000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zk16-sup-'))
    onTestFinished(async () => {
      const { rm } = await import('node:fs/promises')
      await rm(dir, { recursive: true, force: true })
    })
    const script = await nativeScript(dir)
    const io = startSupervisor(dir)
    const { child } = io
    onTestFinished(() => {
      if (child.exitCode === null) child.kill()
    })
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('supervisor ready timeout')), 25000)
      child.on('message', (m: unknown) => {
        const value = m as { type?: string; pid?: number }
        if (value?.type === 'ready' && typeof value.pid === 'number') {
          clearTimeout(timer)
          resolve()
        }
        if (value?.type === 'failure') {
          clearTimeout(timer)
          reject(new Error('supervisor reported failure'))
        }
      })
    })
    child.send({
      type: 'start',
      executable: process.execPath,
      args: [script],
      cwd: dir,
      env: {},
      graceMs: 5000,
    })
    await ready
    await waitReady(io)
    const [, nativePidRaw, grandchildPidRaw] = io.readOutput().match(/native-ready (\d+) (\d+)/) ?? []
    const nativePid = Number(nativePidRaw)
    const grandchildPid = Number(grandchildPidRaw)
    assert.ok(alive(nativePid) && alive(grandchildPid), 'native tree alive before stop')
    const exited = new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)))
    child.send({ type: 'stop' })
    const code = await exited
    assert.equal(code, 0, `supervisor exit code; stderr: ${io.stderrLines().join('')}`)
    const treeGone = await until(
      () => !alive(nativePid) && !alive(grandchildPid),
      8000,
    )
    assert.ok(treeGone, `native pid ${nativePid} / grandchild ${grandchildPid} survived clean stop`)
  })

  win32Only('brutal supervisor death still contains the native tree', { timeout: 45000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zk16-sup-'))
    onTestFinished(async () => {
      const { rm } = await import('node:fs/promises')
      await rm(dir, { recursive: true, force: true })
    })
    const script = await nativeScript(dir)
    const io = startSupervisor(dir)
    const { child } = io
    onTestFinished(() => {
      if (child.exitCode === null) child.kill()
    })
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('supervisor ready timeout')), 25000)
      child.on('message', (m: unknown) => {
        const value = m as { type?: string }
        if (value?.type === 'ready') {
          clearTimeout(timer)
          resolve()
        }
        if (value?.type === 'failure') {
          clearTimeout(timer)
          reject(new Error('supervisor reported failure'))
        }
      })
    })
    child.send({
      type: 'start',
      executable: process.execPath,
      args: [script],
      cwd: dir,
      env: {},
      graceMs: 5000,
    })
    await ready
    await waitReady(io)
    const [, nativePidRaw, grandchildPidRaw] = io.readOutput().match(/native-ready (\d+) (\d+)/) ?? []
    const nativePid = Number(nativePidRaw)
    const grandchildPid = Number(grandchildPidRaw)
    assert.ok(alive(nativePid) && alive(grandchildPid), 'native tree alive before supervisor kill')
    // Brutal kill: no stop message, no graceful anything.
    const { execFile: kill } = await import('node:child_process')
    await new Promise<void>((resolve) =>
      kill('taskkill.exe', ['/F', '/PID', String(child.pid)], { windowsHide: true }, () => resolve()),
    )
    const treeGone = await until(
      () => !alive(nativePid) && !alive(grandchildPid),
      10000,
    )
    assert.ok(
      treeGone,
      `orphaned native tree after supervisor death: pid ${nativePid} grandchild ${grandchildPid}`,
    )
  })

  win32Only('grandchild existence is observable (drill sanity)', { timeout: 30000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'zk16-sup-'))
    onTestFinished(async () => {
      const { rm } = await import('node:fs/promises')
      await rm(dir, { recursive: true, force: true })
    })
    const script = await nativeScript(dir)
    const io = startSupervisor(dir)
    const { child } = io
    onTestFinished(() => {
      if (child.exitCode === null) child.kill()
    })
    const ready = new Promise<void>((resolve) => {
      child.on('message', (m: unknown) => {
        if ((m as { type?: string })?.type === 'ready') resolve()
      })
    })
    child.send({
      type: 'start',
      executable: process.execPath,
      args: [script],
      cwd: dir,
      env: {},
      graceMs: 5000,
    })
    await ready
    await waitReady(io)
    const [, nativePidRaw] = io.readOutput().match(/native-ready (\d+) (\d+)/) ?? []
    const kids = await childrenOf(Number(nativePidRaw))
    assert.ok(kids.length > 0, 'native stand-in has an observable grandchild')
    child.send({ type: 'stop' })
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  })
})
