// ZK-016 N00 doctor tests: static inventory only — no launch, no certification,
// honest BLOCKED recording for the win32 owned-launch environment gate.
// — ZCode 2026-09-18

import { afterAll, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  CERTIFIED_APP_SERVER_ARG,
  runDoctorInventory,
} from './doctor.js'

const tmpDirs: string[] = []
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })))
})

async function scratch(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `zk16-doctor-${name}-`))
  tmpDirs.push(dir)
  return dir
}

async function fixture() {
  const home = await scratch('pass')
  const exe = path.join(home, 'node.exe')
  const pkgDir = path.join(home, 'acp', 'dist')
  await mkdir(pkgDir, { recursive: true })
  const entry = path.join(pkgDir, 'cli.js')
  await writeFile(exe, 'fake-node-binary')
  await writeFile(entry, 'fake-entry-script')
  await writeFile(path.join(pkgDir, '..', 'package.json'), JSON.stringify({ name: 'fake-acp', version: '9.9.9' }))
  const workspace = await scratch('ws')
  const [rExe, rEntry, rWs] = await Promise.all([realpath(exe), realpath(entry), realpath(workspace)])
  return { executable: rExe, entryPath: rEntry, workspace: rWs }
}

describe('ZK-016 N00 doctor static inventory', () => {
  test('records fingerprints and stays uncertified without launching', async () => {
    const f = await fixture()
    const report = await runDoctorInventory({ ...f, platform: 'linux' })
    expect(report.nativeExecutionPerformed).toBe(false)
    expect(report.certified).toBe(false)
    expect(report.scope).toBe('static-only')
    expect(report.staticInventory).toBe('PASS')
    expect(report.executableSha256).toBe(
      createHash('sha256').update(await readFile(f.executable)).digest('hex'),
    )
    expect(report.entrySha256).toBe(
      createHash('sha256').update(await readFile(f.entryPath)).digest('hex'),
    )
    expect(report.args).toEqual([f.entryPath, CERTIFIED_APP_SERVER_ARG])
    expect(report.packageEvidence?.name).toBe('fake-acp')
    expect(report.packageEvidence?.version).toBe('9.9.9')
    expect(report.launchProfile.status).toBe('PASS')
    expect(report.next).toContain('N07')
  })

  test('win32 records supervised owned launch without certifying it', async () => {
    const f = await fixture()
    const report = await runDoctorInventory({ ...f, platform: 'win32' })
    expect(report.staticInventory).toBe('PASS')
    expect(report.launchProfile.status).toBe('BLOCKED')
    expect(report.launchProfile.detail).toContain('WINDOWS-SUPERVISED')
    expect(report.certified).toBe(false)
  })

  test('refuses executables inside the task workspace', async () => {
    const f = await fixture()
    const inside = path.join(f.workspace, 'node.exe')
    await writeFile(inside, 'workspace-local-binary')
    const report = await runDoctorInventory({
      executable: await realpath(inside),
      entryPath: f.entryPath,
      workspace: f.workspace,
      platform: 'linux',
    })
    expect(report.staticInventory).toBe('FAIL')
    expect(report.checks.find((c) => c.id === 'workspace-separation')?.status).toBe('FAIL')
  })

  test('refuses non-canonical workspace paths', async () => {
    const f = await fixture()
    const report = await runDoctorInventory({
      executable: f.executable,
      entryPath: f.entryPath,
      workspace: `${f.workspace}${path.sep}`,
      platform: 'linux',
    })
    expect(report.checks.find((c) => c.id === 'paths-canonical')?.status).toBe('FAIL')
    expect(report.staticInventory).toBe('FAIL')
  })

  test('refuses relative paths outright', async () => {
    const report = await runDoctorInventory({
      executable: 'node',
      entryPath: 'entry.js',
      workspace: '.',
      platform: 'linux',
    })
    expect(report.checks.find((c) => c.id === 'paths-absolute')?.status).toBe('FAIL')
    expect(report.staticInventory).toBe('FAIL')
  })

  test('rejects loader-injection environment keys', async () => {
    const f = await fixture()
    const report = await runDoctorInventory({
      ...f,
      environmentKeys: ['PATH', 'NODE_OPTIONS'],
      platform: 'linux',
    })
    expect(report.checks.find((c) => c.id === 'environment-safe')?.status).toBe('FAIL')
  })

  test('missing adjacent package.json is an unavailable marker, not a failure', async () => {
    const f = await fixture()
    const loneDir = await scratch('lone')
    const lone = path.join(loneDir, 'entry.js')
    await writeFile(lone, 'lone-entry')
    const report = await runDoctorInventory({
      executable: f.executable,
      entryPath: lone,
      workspace: f.workspace,
      platform: 'linux',
    })
    expect(report.checks.find((c) => c.id === 'paths-canonical')?.status).toBe('PASS')
    expect(report.packageEvidence).toBeNull()
    expect(report.staticInventory).toBe('PASS')
    expect(report.certified).toBe(false)
  })
})
