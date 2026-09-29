// Static native launch-profile inventory (ZK-016 N00 / ZK-018). Read-only:
// hashes and records, never launches the native runtime and never flips
// certified — certification only comes from captured evidence per the
// NATIVE_CERTIFICATION_CHECKLIST rows. Mirrors verifyLaunch's static rules
// but reports per-check instead of throwing; the launch path in process.ts
// keeps its own hard refusal. — ZCode 2026-09-18

import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

/** The single supported native launch form: entry script + `app-server`. */
export const CERTIFIED_APP_SERVER_ARG = 'app-server'

export type DoctorCheckStatus = 'PASS' | 'FAIL' | 'BLOCKED'

export type DoctorCheck = {
  id: string
  status: DoctorCheckStatus
  detail: string
}

export type DoctorPackageEvidence = {
  source: string
  name: string | null
  version: string | null
}

export type DoctorReport = {
  scope: 'static-only'
  nativeExecutionPerformed: false
  certified: false
  host: { platform: string; arch: string; node: string }
  executable: string
  executableSha256: string | null
  entryPath: string
  entrySha256: string | null
  entryBytes: number | null
  packageEvidence: DoctorPackageEvidence | null
  workspace: string
  args: readonly string[]
  launchProfile: DoctorCheck
  checks: readonly DoctorCheck[]
  staticInventory: 'PASS' | 'FAIL'
  next: string
}

async function sha256(filename: string): Promise<string> {
  return createHash('sha256').update(await readFile(filename)).digest('hex')
}

/** Adjacent package.json evidence only; absence is an explicit unavailable
 * marker, never a failure — certification does not derive from it. */
async function packageEvidence(entryPath: string): Promise<DoctorPackageEvidence | null> {
  for (const dir of [path.dirname(entryPath), path.dirname(path.dirname(entryPath))]) {
    const candidate = path.join(dir, 'package.json')
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf8')) as {
        name?: unknown
        version?: unknown
      }
      return {
        source: candidate,
        name: typeof parsed.name === 'string' ? parsed.name : null,
        version: typeof parsed.version === 'string' ? parsed.version : null,
      }
    } catch {
      // try next candidate, then report unavailable
    }
  }
  return null
}

export async function runDoctorInventory(input: {
  executable: string
  entryPath: string
  workspace: string
  environmentKeys?: readonly string[]
  /** Injected for tests; defaults to the real platform. */
  platform?: string
}): Promise<DoctorReport> {
  const platform = input.platform ?? process.platform
  const checks: DoctorCheck[] = []
  const fail = (id: string, detail: string) => checks.push({ id, status: 'FAIL', detail })
  const pass = (id: string, detail: string) => checks.push({ id, status: 'PASS', detail })

  const absolute = [input.executable, input.entryPath, input.workspace].every((p) =>
    path.isAbsolute(p),
  )
  if (absolute) pass('paths-absolute', 'Executable, entry and workspace paths are absolute.')
  else fail('paths-absolute', 'Executable, entry and workspace paths must all be absolute.')

  let executable = input.executable
  let entryPath = input.entryPath
  let workspace = input.workspace
  if (absolute) {
    try {
      ;[executable, entryPath, workspace] = await Promise.all([
        realpath(input.executable),
        realpath(input.entryPath),
        realpath(input.workspace),
      ])
    } catch {
      fail('paths-canonical', 'Executable, entry or workspace does not exist.')
    }
    if (checks.every((c) => c.id !== 'paths-canonical')) {
      if (workspace !== input.workspace) {
        fail('paths-canonical', 'Workspace path must be canonical (realpath-equal).')
      } else {
        pass('paths-canonical', 'Resolved paths are canonical; workspace realpath-equal.')
      }
    }
  }

  if (absolute && checks.some((c) => c.id === 'paths-canonical' && c.status === 'PASS')) {
    const outsideWorkspace = [executable, entryPath].every((item) => {
      const relative = path.relative(workspace, item)
      return relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)
    })
    if (outsideWorkspace) {
      pass('workspace-separation', 'Executable and entry live outside the task workspace.')
    } else {
      fail('workspace-separation', 'Native executable/entry must not come from the task workspace.')
    }
  }

  let executableSha256: string | null = null
  let entrySha256: string | null = null
  let entryBytes: number | null = null
  if (absolute && checks.some((c) => c.id === 'paths-canonical' && c.status === 'PASS')) {
    try {
      // #31: the three reads are independent — hash concurrently.
      ;[executableSha256, entrySha256, entryBytes] = await Promise.all([
        sha256(executable),
        sha256(entryPath),
        stat(entryPath).then((s) => s.size),
      ])
      pass('fingerprints', 'SHA-256 fingerprints recorded for executable and entry.')
    } catch {
      fail('fingerprints', 'Executable or entry could not be read for fingerprinting.')
    }
  }

  const args = [entryPath, CERTIFIED_APP_SERVER_ARG]
  if (
    args.length === 2 &&
    args[0] === entryPath &&
    args[1] === CERTIFIED_APP_SERVER_ARG &&
    args.every((a) => typeof a === 'string' && !a.includes('\0'))
  ) {
    pass('args-shape', `Supported launch form: <node> <entry> ${CERTIFIED_APP_SERVER_ARG}.`)
  } else {
    fail('args-shape', 'Launch argument vector does not match the supported form.')
  }

  const environmentKeys = input.environmentKeys ?? []
  const unsafeEnv = environmentKeys.filter((name) =>
    /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(name),
  )
  if (unsafeEnv.length === 0) {
    pass('environment-safe', 'No dynamic-loader injection variables in profile environment.')
  } else {
    fail('environment-safe', `Unsafe environment variables present: ${unsafeEnv.join(', ')}.`)
  }

  const launchProfile: DoctorCheck =
    platform === 'win32'
      ? {
          id: 'platform-support',
          status: 'BLOCKED',
          detail:
            'WINDOWS-SUPERVISED — owned launch runs through the job-object supervisor (ZK-016); capability still requires per-row certification evidence.',
        }
      : {
          id: 'platform-support',
          status: 'PASS',
          detail:
            'Owned-launch platform; doctor still performs no launch — readiness is a separate certification row (N01).',
        }
  checks.push(launchProfile)

  const evidence = await packageEvidence(entryPath).catch(() => null)

  const staticInventory = checks.every((c) => c.status !== 'FAIL') ? 'PASS' : 'FAIL'
  return {
    scope: 'static-only',
    nativeExecutionPerformed: false,
    certified: false,
    host: { platform, arch: process.arch, node: process.version },
    executable,
    executableSha256,
    entryPath,
    entrySha256,
    entryBytes,
    packageEvidence: evidence,
    workspace,
    args,
    launchProfile,
    checks,
    staticInventory,
    next:
      'Static inventory only. Certification requires the NATIVE_CERTIFICATION_CHECKLIST rows (captured sanitized traces + codec fixtures); paid rows N07+ additionally need recorded opt-in and cost limits. This report does not enable ZCode.',
  }
}
