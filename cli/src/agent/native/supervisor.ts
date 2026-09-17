/** Internal subprocess only. Never run the native runtime in the bot's process group. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
let native: ChildProcessWithoutNullStreams | undefined
let stopping = false
let graceMs = 5000
let nativeExited = false
function alive(pid: number) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(-pid, name)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
      process.exitCode = 70
    }
  }
}
async function stop() {
  if (stopping) {
    return
  }
  stopping = true
  const pid = native?.pid
  if (!pid) {
    process.exit(0)
    return
  }
  signal(pid, 'SIGTERM')
  const end = Date.now() + graceMs
  while (alive(pid) && Date.now() < end) await delay(20)
  if (alive(pid)) {
    signal(pid, 'SIGKILL')
  }
  const killEnd = Date.now() + 2000
  while (alive(pid) && Date.now() < killEnd) await delay(20)
  process.exit(alive(pid) || !nativeExited ? 70 : 0)
}
process.on('disconnect', () => {
  void stop()
})
process.on('SIGTERM', () => {
  void stop()
})
process.on('SIGINT', () => {
  void stop()
})
process.stdin.on('error', () => {
  void stop()
})
process.stdout.on('error', () => {
  void stop()
})
process.on('message', (input: unknown) => {
  if (!input || typeof input !== 'object') {
    return
  }
  const value = input as Record<string, unknown>
  if (value.type === 'stop') {
    void stop()
    return
  }
  if (value.type !== 'start' || native || stopping) {
    return
  }
  if (
    typeof value.executable !== 'string' ||
    typeof value.cwd !== 'string' ||
    !Array.isArray(value.args) ||
    !value.args.every((a) => typeof a === 'string') ||
    !value.env ||
    typeof value.env !== 'object'
  ) {
    process.exit(70)
    return
  }
  if (typeof value.graceMs === 'number') {
    graceMs = Math.max(50, Math.min(value.graceMs, 30000))
  }
  native = spawn(value.executable, value.args, {
    cwd: value.cwd,
    env: value.env as NodeJS.ProcessEnv,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const owned = native
  owned.on('error', () => {
    process.send?.({ type: 'failure' })
    void stop()
  })
  owned.stdin.on('error', () => {
    void stop()
  })
  owned.on('exit', () => {
    nativeExited = true
    void stop()
  })
  process.stdin.pipe(owned.stdin)
  owned.stdout.pipe(process.stdout)
  owned.stderr.pipe(process.stderr)
  owned.once('spawn', () => {
    process.send?.({ type: 'ready', pid: owned.pid })
  })
})
