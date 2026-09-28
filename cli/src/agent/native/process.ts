import { DiagnosticBuffer } from './diagnostics.js'
import { spawn } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import { attempt, fail, record, type Result, ok } from './errors.js'
export type LaunchProfile = {
  executable: string
  args: readonly string[]
  executableSha256: string
  entryPath: string
  entrySha256: string
  cwd: string
  environment: Readonly<Record<string, string>>
  graceMs?: number
  startupMs?: number
  diagnosticRedactor?: (line: string) => string
}
export type OwnedRuntime = {
  input: Writable
  output: Readable
  pid: number
  stop: () => Promise<Result<void>>
  onExit: (fn: () => void) => void
  stderrBytes: () => number
  stderrLines: () => readonly string[]
}
export async function fileHash(filename: string) {
  return createHash('sha256')
    .update(await readFile(filename))
    .digest('hex')
}
export async function verifyLaunch(profile: LaunchProfile) {
  if (
    (profile.startupMs !== undefined &&
      (!Number.isSafeInteger(profile.startupMs) ||
        profile.startupMs < 1 ||
        profile.startupMs > 2147483647)) ||
    (profile.graceMs !== undefined &&
      (!Number.isSafeInteger(profile.graceMs) || profile.graceMs < 0 || profile.graceMs > 30000))
  ) {
    throw fail('CONFIG_INVALID', 'Invalid native startup or shutdown deadline.')
  }
  if (process.platform === 'win32') {
    // ZK-016 2026-09-18: Windows supervision is implemented (supervisor job
    // object with a kill-on-close keeper). The gate is now the ordinary
    // fingerprint checks below; capability still comes from certification rows.
  }
  if (![profile.executable, profile.entryPath, profile.cwd].every(path.isAbsolute)) {
    throw fail('CONFIG_INVALID', 'Use absolute executable, entry and workspace paths.')
  }
  const [exe, entry, cwd] = await Promise.all([
    realpath(profile.executable),
    realpath(profile.entryPath),
    realpath(profile.cwd),
  ])
  if (cwd !== profile.cwd) {
    throw fail('WORKSPACE_MISMATCH', 'Workspace must be canonical.')
  }
  for (const item of [exe, entry]) {
    const relative = path.relative(cwd, item)
    if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) {
      throw fail('UNTRUSTED_EXECUTABLE', 'Native executable must not come from the task workspace.')
    }
  }
  if (
    profile.args[0] !== profile.entryPath ||
    profile.args.some((a) => typeof a !== 'string' || a.includes('\0'))
  ) {
    throw fail('CONFIG_INVALID', 'Invalid native argument vector.')
  }
  if (
    (await fileHash(exe)) !== profile.executableSha256 ||
    (await fileHash(entry)) !== profile.entrySha256
  ) {
    throw fail('RUNTIME_UNCERTIFIED', 'Native executable or entry fingerprint changed.')
  }
  for (const name of Object.keys(profile.environment))
    if (/^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(name)) {
      throw fail('ENV_UNSAFE', 'Dynamic loader injection variables are forbidden.')
    }
}
/** Independent IPC supervisor survives bot death and terminates its owned process
 * tree — POSIX: the supervisor's detached session group, plus a detached keeper
 * that kills the group when the supervisor's stdin EOFs, however the supervisor
 * dies (SWARM #23); Windows: job object via keeper (ZK-016). Descendants that
 * escape into their own session (setsid) or out of the job still require
 * stronger OS containment; not certified here. */
export async function startOwnedRuntime(profile: LaunchProfile): Promise<Result<OwnedRuntime>> {
  const outcome = await attempt(async () => {
    await verifyLaunch(profile)
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./supervisor.js', import.meta.url))],
      {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      },
    )
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw fail('STARTUP_FAILED', 'Supervisor pipes are unavailable.')
    }
    let stderrBytes = 0
    const diagnostics = new DiagnosticBuffer(profile.diagnosticRedactor)
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + chunk.length)
      diagnostics.push(chunk)
    })
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', resolve)
      child.once('error', () => resolve(null))
    })
    let stopping: Promise<Result<void>> | undefined
    const stop = () =>
      (stopping ??= (async () => {
        if (child.connected) {
          child.send({ type: 'stop' }, () => {})
        }
        let timeout: NodeJS.Timeout | undefined
        const code = await Promise.race([
          exited,
          new Promise<null>((resolve) => {
            timeout = setTimeout(
              () => resolve(null),
              Math.max(50, Math.min(profile.graceMs ?? 5000, 30000)) + 3500,
            )
          }),
        ])
        if (timeout) {
          clearTimeout(timeout)
        }
        return code === 0
          ? ok(undefined)
          : {
              ok: false as const,
              error: fail(
                'CANCEL_UNCONFIRMED',
                'Owned process group could not be confirmed stopped.',
                'control',
                'possible',
              ),
            }
      })())
    const nativePid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(fail('STARTUP_FAILED', 'Native supervisor startup timed out.'))
        void stop()
      }, profile.startupMs ?? 60000)
      const onError = () => {
        clearTimeout(timer)
        reject(fail('STARTUP_FAILED', 'Native supervisor failed.'))
      }
      child.once('error', onError)
      child.once('exit', onError)
      child.on('message', (message) => {
        const m = record(message)
        if (m.type === 'ready' && typeof m.pid === 'number') {
          clearTimeout(timer)
          child.off('exit', onError)
          resolve(m.pid)
        }
        if (m.type === 'failure') {
          clearTimeout(timer)
          reject(fail('STARTUP_FAILED', 'Native runtime failed to start.'))
        }
      })
      child.send({
        type: 'start',
        executable: profile.executable,
        args: profile.args,
        cwd: profile.cwd,
        env: profile.environment,
        graceMs: profile.graceMs ?? 5000,
      })
    })
    return {
      input: child.stdin,
      output: child.stdout,
      pid: nativePid,
      stop,
      stderrBytes: () => stderrBytes,
      stderrLines: () => diagnostics.lines(),
      onExit: (fn: () => void) => {
        void exited.then(fn)
      },
    }
  }, 'STARTUP_FAILED')
  // Preflight refusals (verifyLaunch) keep their specific codes — callers
  // distinguish RUNTIME_UNCERTIFIED from a real startup failure. — ZK-016
  if (!outcome.ok && outcome.error.code === 'STARTUP_FAILED') {
    try {
      await verifyLaunch(profile)
    } catch (preflight) {
      return { ok: false, error: preflight as import('./errors.js').AgentError }
    }
  }
  return outcome
}
