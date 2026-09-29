// #28 (ZCode 2026-09-28): regression guard for the vitest projects split.
//
// The pre-#28 config forced `pool: 'forks', maxForks: 1` globally, serializing
// every test file (including sub-millisecond pure-logic suites and the ~10s
// collect phase) behind the process-spawning e2e lane — src/agent alone went
// from ~102s to ~52s once unit files ran in parallel forks (see ticket #28
// for the before/after). These tests pin the structural properties that make
// that safe, so a well-meaning "simplify the config" change cannot silently
// regress to full serialization or, worse, drop the KIMAKI_VITEST isolation
// from one project (tests would then touch the real ~/.kimaki).

import { describe, test } from 'vitest'
import assert from 'node:assert/strict'
// The config lives at the package root, outside tsconfig rootDir=src, so tsc
// cannot resolve it as a module — vitest itself loads it fine at runtime.
// @ts-expect-error TS2307 outside the tsc program
import config from '../vitest.config'

type ProjectLike = {
  test?: {
    name?: unknown
    env?: Record<string, unknown>
    include?: unknown
    exclude?: unknown
    pool?: unknown
    poolOptions?: { forks?: { maxForks?: unknown } }
  }
}

const rootTest = (config as { test?: { projects?: ProjectLike[] } }).test
const projects = rootTest?.projects ?? []
const byName = new Map(
  projects.flatMap((p) => (typeof p.test?.name === 'string' ? [[p.test.name, p] as const] : [])),
)
const unit = byName.get('unit')
const e2e = byName.get('e2e')

describe('#28 vitest config projects split', () => {
  test('exactly the unit and e2e projects are defined under test.projects', () => {
    assert.equal(projects.length, 2, 'config must define exactly the unit and e2e projects')
    assert.ok(unit, 'a project named "unit" must exist')
    assert.ok(e2e, 'a project named "e2e" must exist')
  })

  test('every project injects KIMAKI_VITEST=1 (real ~/.kimaki must stay untouchable)', () => {
    for (const project of projects) {
      assert.equal(
        project.test?.env?.['KIMAKI_VITEST'],
        '1',
        `project ${String(project.test?.name)} must set env KIMAKI_VITEST=1`,
      )
    }
  })

  test('e2e project runs the *.e2e.test.ts lane on a single fork (hard isolation)', () => {
    assert.ok(
      (e2e?.test?.include as string[] | undefined)?.includes('src/**/*.e2e.test.ts'),
      'e2e project must include src/**/*.e2e.test.ts',
    )
    assert.equal(e2e?.test?.pool, 'forks')
    assert.equal(e2e?.test?.poolOptions?.forks?.maxForks, 1, 'e2e lane must stay serialized')
  })

  test('unit project pools pure-logic files in parallel forks', () => {
    assert.ok(
      (unit?.test?.include as string[] | undefined)?.includes('src/**/*.test.ts'),
      'unit project must include src/**/*.test.ts',
    )
    assert.equal(unit?.test?.pool, 'forks')
    const maxForks = unit?.test?.poolOptions?.forks?.maxForks
    assert.ok(
      typeof maxForks === 'number' && maxForks > 1,
      `unit lane must allow more than one fork (got ${String(maxForks)}) — a single fork re-serializes the whole package`,
    )
  })

  test('no test file can run in both projects (unit excludes exactly the e2e glob)', () => {
    for (const glob of (e2e?.test?.include as string[] | undefined) ?? []) {
      assert.ok(
        (unit?.test?.exclude as string[] | undefined)?.includes(glob),
        `unit project must exclude ${glob} or that file would execute twice per run`,
      )
    }
  })
})
