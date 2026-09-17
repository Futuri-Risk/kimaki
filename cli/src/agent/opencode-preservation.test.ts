// ZK-006: OpenCode preservation pin. Default-off must mean byte-for-byte OpenCode
// semantics, not "tests still pass": the OpenCode controller stays completely
// native-unaware, default resolution is opencode everywhere, nothing is written to
// the agent sidecar on the default path, and no host module can launch the native
// runtime. Source-level assertions back the behavioral ones (H30 convention).
// — ZCode 2026-09-17
import { test, describe } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveIngressBackend, gateThreadMessage } from './ingress-gate.js'
import { resolveBackend } from './registry.js'
import { getRawDbClient, closeDb } from '../db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(__dirname, '..')

function walkTsFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) {
      continue
    }
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, files)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(full)
    }
  }
  return files
}

describe('ZK-006 pin — the OpenCode controller stays native-unaware (default-off coupling = 0)', () => {
  test('thread-session-runtime imports nothing from the agent boundary', () => {
    for (const module of [
      'session-handler/thread-session-runtime.ts',
      'session-handler/thread-runtime-state.ts',
      'session-handler/event-stream-state.ts',
      'external-opencode-sync.ts',
      'opencode.ts',
    ]) {
      const source = readFileSync(path.join(srcRoot, module), 'utf8')
      assert.equal(
        /from '\.\.\/(?:agent)\//.test(source) || /from '\.\/(?:agent)\//.test(source),
        false,
        `${module} must not import the agent boundary — the seam lives entirely in the ingress layer`,
      )
    }
  })

  test('no host module outside src/agent references the native supervisor or mints zc: ids', () => {
    // schema.ts is declarative: it mirrors the agent tables (ZK-004), including
    // the partial index over the reserved zc: namespace — that is DDL, not minting.
    const declarativeAllowlist = new Set(['schema.ts'])
    const offenders: string[] = []
    for (const file of walkTsFiles(srcRoot)) {
      const rel = path.relative(srcRoot, file).replaceAll('\\', '/')
      if (rel.startsWith('agent/')) {
        continue
      }
      const source = readFileSync(file, 'utf8')
      if (/native\/(supervisor|process|client)/.test(source)) {
        offenders.push(`${rel}: native runtime reference`)
      }
      if (/['"]zc:/.test(source) && !declarativeAllowlist.has(rel)) {
        offenders.push(`${rel}: literal zc: id`)
      }
    }
    assert.deepEqual(offenders, [])
  })

  test('retryLastUserPrompt stays an OpenCode-controller method, never a native fallback', () => {
    const runtime = readFileSync(
      path.join(srcRoot, 'session-handler/thread-session-runtime.ts'),
      'utf8',
    )
    assert.match(runtime, /async retryLastUserPrompt\(\)/)
    // The runtime is only reachable through getOrCreateRuntime; the zc: refusal in
    // discord-bot.ts fires BEFORE that call (index ordering pin).
    const discordBot = readFileSync(path.join(srcRoot, 'discord-bot.ts'), 'utf8')
    const refusalIndex = discordBot.indexOf('gateThreadMessage(threadBackend)')
    const runtimeIndex = discordBot.indexOf('getOrCreateRuntime({')
    assert.ok(refusalIndex > 0, 'zc: message refusal present in discord-bot.ts')
    assert.ok(
      refusalIndex < runtimeIndex,
      'zc: message refusal must precede the first getOrCreateRuntime call site',
    )
  })
})

describe('ZK-006 pin — default backend resolution is opencode everywhere', () => {
  test('no session, pending-workspace empty id, and legacy ids never resolve native', async () => {
    const emptyLookup = async () => undefined
    assert.equal(await resolveIngressBackend(null, emptyLookup), null)
    assert.equal(await resolveIngressBackend(undefined, emptyLookup), null)
    assert.equal(await resolveIngressBackend('', emptyLookup), null)
    assert.equal(await resolveIngressBackend('ses_legacy_1', emptyLookup), 'opencode')
    assert.equal(await resolveBackend(emptyLookup, 'ses_legacy_2'), 'opencode')
    // A zcode sidecar behind a LEGACY-looking id still wins — routing trusts the
    // durable store, not the id shape.
    assert.equal(
      await resolveBackend(async () => ({ backend: 'zcode' }), 'ses_bound'),
      'zcode',
    )
  })

  test('gate decisions for every non-zcode backend are allow', () => {
    assert.equal(gateThreadMessage(null).kind, 'allow')
    assert.equal(gateThreadMessage('opencode').kind, 'allow')
  })
})

describe('ZK-006 pin — the default path writes no agent sidecar state', () => {
  test('schema bootstrap creates the agent tables but leaves them empty (journal only)', async () => {
    const client = await getRawDbClient()
    const tables = [
      'agent_schema_versions',
      'agent_sessions',
      'agent_backend_defaults',
      'agent_thread_intents',
      'agent_operations',
      'agent_stream_state',
      'agent_interactions',
      'agent_attachments',
      'agent_outbox',
      'agent_workspace_leases',
    ]
    for (const table of tables) {
      const exists = await client.execute(
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='${table}'`,
      )
      assert.equal(Number(exists.rows[0]?.n ?? 0), 1, `${table} exists after bootstrap`)
      const count = await client.execute(`SELECT COUNT(*) AS n FROM ${table}`)
      const n = Number(count.rows[0]?.n ?? 0)
      if (table === 'agent_schema_versions') {
        assert.equal(n, 1, 'exactly one component version row is stamped')
      } else {
        assert.equal(n, 0, `${table} must stay empty on the OpenCode default path`)
      }
    }
    await closeDb()
  })
})
