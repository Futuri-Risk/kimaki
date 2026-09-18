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
import { getInteractionBridge } from './interaction-bridge.js'

/**
 * Host authorization: the acting Discord user must target the session's
 * controller thread. Actor identity binding and machine/thread ownership are
 * re-verified durably by store.admit; this gate only refuses obvious mismatches
 * before any state write.
 */
export const hostAuthorizer: Authorizer = (actorId, threadId, session) =>
  Promise.resolve(actorId.length > 0 && session.controllerThreadId === threadId)

let coordinatorPromise: Promise<AgentCoordinator | null> | undefined

async function buildCoordinator(): Promise<AgentCoordinator | null> {
  const profile: NativeProfile | undefined = resolveNativeProfile('zcode-primary')
  if (!profile || !profile.enabled) {
    return null
  }
  const [client, machineId] = await Promise.all([getRawDbClient(), getOwnerMachineId()])
  const store = new AgentStore(serializeWrites(libsqlSqlClient(client)), machineId)
  const backend = new ZcodeBackend(profile)
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

/** Lazily constructed singleton; null while native stays default-off. */
export function getNativeCoordinator(): Promise<AgentCoordinator | null> {
  coordinatorPromise ??= buildCoordinator().catch(() => null)
  return coordinatorPromise
}

/** Test/reset seam — production code never calls this. */
export function resetNativeCoordinator(): void {
  coordinatorPromise = undefined
  setNativeCapabilityProvider(() => false)
}
