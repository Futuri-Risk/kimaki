// #27 regression tests (ZCode 2026-09-28). The ticket fixed two waste classes:
// (a) importing coordinator fixtures from a *.test.ts file re-registered the
//     whole coordinator suite inside every importer — fixtures now live in the
//     non-test module test-harness.ts and the legacy coordinator.test.js import
//     path is a side-effect-light shim;
// (b) every store-backed test paid a fresh 48-statement schema bootstrap and an
//     always-exhausted cleanup retry that leaked its temp dir — the schema is
//     now initialized once per worker and file-copied, and cleanup releases WAL
//     handles so roots are actually removed.
// These tests pin both invariants so the waste cannot quietly return.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStoreHarness, harnessDiagnostics } from './test-harness.js'
import { validateAgentSchemaIntegrity, AGENT_SCHEMA_VERSION } from './schema-gate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)

/** Roots created by tests in this file — the final test proves they were removed. */
const roots: string[] = []

test('template copies carry the complete stamped agent schema and stay in WAL mode', async () => {
  const h = await createStoreHarness()
  roots.push(h.root)
  // Throws SCHEMA_CORRUPT if any table/index is missing from the copied template.
  await validateAgentSchemaIntegrity(h.client)
  const version = await h.client.execute(
    "SELECT version FROM agent_schema_versions WHERE component='agent-backend'",
  )
  assert.equal(Number(version.rows[0]?.version), AGENT_SCHEMA_VERSION)
  // Production parity: the copied file must still be in WAL journal mode.
  const mode = await h.client.execute('PRAGMA journal_mode')
  assert.equal(String(mode.rows[0]?.journal_mode).toLowerCase(), 'wal')
  // The session fixture is live in the copy, not carried over as stale data.
  assert.equal((await h.store.session(h.session.id))?.id, 'zc:session-1')
})

test('the schema bootstrap runs once per worker, not once per harness', async () => {
  const initializationsBefore = harnessDiagnostics.schemaInitializations
  const creationsBefore = harnessDiagnostics.harnessCreations
  const a = await createStoreHarness()
  const b = await createStoreHarness()
  roots.push(a.root, b.root)
  assert.equal(harnessDiagnostics.schemaInitializations, initializationsBefore)
  assert.equal(harnessDiagnostics.harnessCreations - creationsBefore, 2)
  assert.notEqual(a.root, b.root)
})

test('the coordinator contract suite is registered exactly once across cli/src', async () => {
  const suiteTitle = 'AgentCoordinator (in-process fake-native)'
  const srcRoot = path.join(__dirname, '..')
  const tsFiles: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.ts')) tsFiles.push(full)
    }
  }
  await walk(srcRoot)
  const registrants: string[] = []
  for (const file of tsFiles) {
    // This test file necessarily contains the title in its own assertion.
    if (path.resolve(file) === path.resolve(fileURLToPath(import.meta.url))) continue
    if ((await readFile(file, 'utf-8')).includes(suiteTitle)) registrants.push(file)
  }
  assert.deepEqual(
    registrants.map((f) => path.relative(srcRoot, f).replace(/\\/g, '/')),
    ['agent/coordinator-contract.test.ts'],
    'the coordinator suite title may exist in exactly one file — anything else re-registers it',
  )
})

test('coordinator.test.ts is a side-effect-light re-export shim, not a suite', async () => {
  const source = await readFile(path.join(__dirname, 'coordinator.test.ts'), 'utf-8')
  assert.match(
    source,
    /export \{[^}]*FakeBackend[^}]*coordinatorHarness[^}]*\} from '\.\/test-harness\.js'/,
    'the shim must keep re-exporting the shared fixtures for legacy importers',
  )
  assert.doesNotMatch(
    source,
    /\bdescribe\s*\(/,
    'registering a describe block in coordinator.test.ts would re-execute it inside lease-contention.test.ts and btw-native.test.ts',
  )
})

test('a harness lifecycle leaves no temp dir behind once the process exits', async () => {
  // The Windows truth (#27 measurement): libsql's native binding holds the DB
  // file past client.close(), so per-test rm cannot succeed in-process — the
  // harness registers every root with a process-'exit' sweep instead. Prove
  // the sweep really removes the dir by running a harness in a child process
  // and checking its root after that process dies.
  const cliRoot = path.join(__dirname, '..', '..')
  const fixture = path.join(__dirname, 'harness-exit-sweep.fixture.mts')
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', fixture],
    { cwd: cliRoot, timeout: 60_000 },
  )
  const root = stdout.split(/\r?\n/).find((line) => line.startsWith('ROOT:'))?.slice(5)
  assert.ok(root, `fixture did not report its root (stdout: ${JSON.stringify(stdout)})`)
  // On win32 the exit hook spawns a detached janitor that removes the root a
  // moment after the fixture process dies; poll for it instead of asserting
  // immediately.
  const deadline = Date.now() + 15_000
  while (existsSync(root) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert.equal(
    existsSync(root),
    false,
    'the post-exit sweep must remove the harness temp root once the process is gone',
  )
})
