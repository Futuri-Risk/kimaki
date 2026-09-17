/** Compiled mirror of supervisor.ts, committed so source-mode execution (tsx/vitest)
 *  can spawn it next to the .ts sources: process.ts resolves './supervisor.js' relative
 *  to import.meta.url. When editing supervisor.ts, re-emit this file with tsc. It is
 *  excluded from the host tsc build to avoid a duplicate-output collision. — ZAI 2026-09-17 */
/** Internal subprocess only. Never run the native runtime in the bot's process group. */
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
let native
let stopping = false
let graceMs = 5000
let nativeExited = false
function alive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (e) {
    return e.code !== 'ESRCH'
  }
}
function signal(pid, name) {
  try {
    process.kill(-pid, name)
  } catch (e) {
    if (e.code !== 'ESRCH') {
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
process.on('message', (input) => {
  if (!input || typeof input !== 'object') {
    return
  }
  const value = input
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
    env: value.env,
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
//# sourceMappingURL=supervisor.js.map
