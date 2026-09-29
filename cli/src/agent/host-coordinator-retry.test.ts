// SWARM #21 regression: getNativeCoordinator() must not swallow a build
// failure and cache the null for the process lifetime. A transient DB/identity
// error has to be surfaced (error log) and the NEXT call must retry the build
// instead of returning the cached null — otherwise the native backend stays
// silently disabled until process restart. — ZCode 2026-09-28
import { afterEach, describe, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import type { Client } from '@libsql/client'

// Recorded logger calls (createLogger mock) and the captured real DB factory.
// All mock-shared state lives in vi.hoisted: mock factories are hoisted above
// every top-level declaration, so factories must only mutate this object,
// never reassign a module-level binding.
const mocks = vi.hoisted(() => ({
  getRawDbClientMock: vi.fn(),
  logCalls: [] as Array<{ prefix: string; level: string; args: unknown[] }>,
  real: { getRawDbClient: undefined as (() => Promise<Client>) | undefined },
}))
const { getRawDbClientMock, logCalls } = mocks

// db.js seam: host-coordinator is the only module in this graph that calls
// getRawDbClient, so overriding just that export keeps everything else real.
// Each test scripts exactly when the transient failure fires, then delegates
// to the real (KIMAKI_VITEST-isolated) client.
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  mocks.real.getRawDbClient = actual.getRawDbClient
  return {
    ...actual,
    getRawDbClient: () => getRawDbClientMock(),
  }
})

// logger.js seam: createLogger output is suppressed under KIMAKI_VITEST, so we
// record calls instead. Every other export (formatErrorWithStack, LogPrefix,
// sanitizers, ...) stays real so assertions see production-formatted text.
vi.mock('../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger.js')>()
  const record =
    (prefix: string, level: string) =>
    (...args: unknown[]) => {
      logCalls.push({ prefix, level, args })
    }
  return {
    ...actual,
    createLogger: (prefix: string) => ({
      log: record(prefix, 'log'),
      error: record(prefix, 'error'),
      warn: record(prefix, 'warn'),
      info: record(prefix, 'info'),
      debug: record(prefix, 'log'),
    }),
  }
})

import { getNativeCoordinator, resetNativeCoordinator } from './host-coordinator.js'
import { registerNativeProfile, syntheticProfile } from './native-profile.js'
import { fakeCodec } from './fixtures/fake-codec.js'
import { gateThreadCommand } from './ingress-gate.js'

/** Build failures surfaced by host-coordinator (prefix AGENT, error level). */
const surfacedBuildFailures = () =>
  logCalls.filter(
    (c) =>
      c.level === 'error' &&
      c.prefix === 'AGENT' &&
      String(c.args[0] ?? '').includes('native coordinator build failed'),
  )

function registerTestProfile(): void {
  registerNativeProfile(
    syntheticProfile({
      id: 'zcode-primary',
      revision: 'r0',
      codec: fakeCodec,
      launch: () => {
        throw new Error('never launched in this test')
      },
      attachmentRoot: '/tmp/none',
    }),
  )
}

afterEach(() => {
  resetNativeCoordinator()
  logCalls.length = 0
  getRawDbClientMock.mockReset()
})

describe('native coordinator build-failure handling (SWARM #21)', () => {
  test('transient failure: null for that call, surfaced in the log, next call rebuilds live', async () => {
    registerTestProfile()
    // The transient case from #21: the first build dies in the DB leg…
    getRawDbClientMock.mockRejectedValueOnce(
      new Error('transient DB failure: database is locked'),
    )
    // …and every later attempt delegates to the real isolated test client.
    getRawDbClientMock.mockImplementation(() => mocks.real.getRawDbClient!())

    // First call fails closed for the current call…
    assert.equal(await getNativeCoordinator(), null)
    // …but the failure is surfaced, not silent.
    const surfaced = surfacedBuildFailures()
    assert.equal(
      surfaced.length,
      1,
      `expected exactly one surfaced build failure, got ${surfaced.length}`,
    )
    assert.match(
      surfaced[0]!.args.map(String).join(' '),
      /transient DB failure/,
      'the underlying error text must reach the log',
    )

    // Second call: NOT the cached null — a live coordinator, capabilities unlocked.
    const retried = await getNativeCoordinator()
    assert.ok(
      retried,
      'retry must rebuild a live coordinator instead of caching the failure',
    )
    assert.equal(gateThreadCommand('zcode', 'abort').kind, 'allow')
    await retried.close()
  })

  test('persistent failure: every call fails closed and every failure is logged', async () => {
    registerTestProfile()
    getRawDbClientMock.mockRejectedValue(new Error('permanent DB failure'))

    assert.equal(await getNativeCoordinator(), null)
    assert.equal(await getNativeCoordinator(), null)
    assert.equal(
      surfacedBuildFailures().length,
      2,
      'each retry must surface its own failure (no silent caching)',
    )
  })
})
