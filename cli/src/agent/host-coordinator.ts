// Host construction seam for the native controller (ZK-007). This is the ONLY
// place a real AgentCoordinator is built: durable store over the host DB with a
// single-writer guarantee, per-install machine identity, and the host Authorizer
// (controller-thread binding; Discord-level permission already passed at ingress;
// store.admit re-verifies thread + machine ownership durably).
//
// DEFAULT-OFF: nothing in production registers a native profile, so
// getNativeCoordinator() returns null and the ZK-005 ingress gate keeps refusing
// every native command (capability provider unset). This becomes reachable only
// when ZK-016 certification registers a certified profile and ZK-008 wires the
// runtime bridge. — ZCode 2026-09-17

import { AgentCoordinator, type Authorizer } from './coordinator.js'
import { AgentStore } from './store.js'
import { ZcodeBackend, type NativeProfile } from './zcode-backend.js'
import { libsqlSqlClient, serializeWrites } from './sql.js'
import { getRawDbClient } from '../db.js'
import { getOwnerMachineId } from './host-identity.js'
import { resolveNativeProfile } from './native-profile.js'
import { setNativeCapabilityProvider } from './ingress-gate.js'
import type { LaunchProfile, OwnedRuntime } from './native/process.js'
import type { Result } from './errors.js'
import { getInteractionBridge } from './interaction-bridge.js'
import { createLogger, formatErrorWithStack, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.AGENT)

/**
 * Host authorization: the acting Discord user must target the session's
 * controller thread. Actor identity binding and machine/thread ownership are
 * re-verified durably by store.admit; this gate only refuses obvious mismatches
 * before any state write.
 */
export const hostAuthorizer: Authorizer = (actorId, threadId, session) =>
  Promise.resolve(actorId.length > 0 && session.controllerThreadId === threadId)

// ZK-015 test seam: e2e suites inject the plain-spawn fixture launcher so the
// real backend can drive a spawned fake app-server on win32. Production never
// sets it — the certified owned launcher stays the default.
let runtimeLauncherOverride: ((profile: LaunchProfile) => Promise<Result<OwnedRuntime>>) | undefined

export function setNativeRuntimeLauncherForTests(
  launcher: ((profile: LaunchProfile) => Promise<Result<OwnedRuntime>>) | null,
): void {
  runtimeLauncherOverride = launcher ?? undefined
  resetNativeCoordinator()
}

let coordinatorPromise: Promise<AgentCoordinator | null> | undefined

async function buildCoordinator(): Promise<AgentCoordinator | null> {
  const profile: NativeProfile | undefined = resolveNativeProfile('zcode-primary')
  if (!profile || !profile.enabled) {
    return null
  }
  const [client, machineId] = await Promise.all([getRawDbClient(), getOwnerMachineId()])
  const store = new AgentStore(serializeWrites(libsqlSqlClient(client)), machineId)
  const backend = new ZcodeBackend(profile, runtimeLauncherOverride)
  const built = new AgentCoordinator(store, backend, hostAuthorizer)
  // ZK-009: the interaction bridge observes native events on its own read-only
  // tap (prompt rendering); answers come back through coordinator ingests.
  backend.onHostEvent((sessionId, event) => {
    void getInteractionBridge().handleNativeEvent(sessionId, event)
  })
  // Capabilities unlock only with a live coordinator behind them.
  setNativeCapabilityProvider(() => true)
  return built
}

/**
 * Lazily constructed singleton; null while native stays default-off.
 * A build failure is fail-closed for the CURRENT call only: it is logged and
 * the cache slot is cleared, so the next call retries the build instead of
 * leaving the native backend silently disabled until process restart.
 * Consumers are human-paced (one build attempt per native command), so a
 * per-call retry cannot hot-loop. — SWARM #21
 */
export function getNativeCoordinator(): Promise<AgentCoordinator | null> {
  coordinatorPromise ??= buildCoordinator().catch((error: unknown) => {
    logger.error(
      'native coordinator build failed; will retry on next call',
      formatErrorWithStack(error),
    )
    coordinatorPromise = undefined
    return null
  })
  return coordinatorPromise
}

/** Test/reset seam — production code never calls this. */
export function resetNativeCoordinator(): void {
  coordinatorPromise = undefined
  setNativeCapabilityProvider(() => false)
}
