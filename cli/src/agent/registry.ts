// Backend selection registry — the capability-aware boundary in front of the real
// ThreadSessionRuntime (ZK-003). Default is OpenCode; ZCode exists only through an
// explicit durable sidecar. Adapted from the hardened standalone slice registry.ts;
// the AgentStore dependency is inverted into a plain sidecar lookup until the durable
// store lands (ZK-004/007). — ZAI 2026-09-17

import { fail } from './errors.js'
import type { BackendId } from './types.js'

export type { BackendId }

/** Minimal durable sidecar projection used during backend resolution. */
export type BackendSidecar = { backend: BackendId }
export type SidecarLookup = (sessionId: string) => Promise<BackendSidecar | undefined>

/** Host session IDs in the reserved native namespace. Only the native store mints them. */
export const ZCODE_SESSION_PREFIX = 'zc:'

export function isZcodeSessionId(sessionId: string): boolean {
  return sessionId.startsWith(ZCODE_SESSION_PREFIX)
}

/**
 * Resolve the backend for an existing host session ID.
 *
 * - default (no sidecar, legacy IDs): `opencode`
 * - `zc:` IDs MUST resolve to a native sidecar — a missing sidecar is an integrity
 *   failure, never permission to fall back to OpenCode (handover AC05).
 */
export async function resolveBackend(
  lookup: SidecarLookup,
  sessionId: string,
): Promise<BackendId> {
  if (isZcodeSessionId(sessionId)) {
    const sidecar = await lookup(sessionId)
    if (!sidecar) {
      throw fail(
        'SESSION_SIDECAR_MISSING',
        `No agent sidecar for reserved ${ZCODE_SESSION_PREFIX} session; OpenCode fallback is prohibited.`,
        'preflight',
      )
    }
    if (sidecar.backend !== 'zcode') {
      throw fail(
        'SESSION_SIDECAR_INVALID',
        'Agent sidecar backend mismatch for reserved native session ID.',
        'preflight',
      )
    }
    return 'zcode'
  }
  return (await lookup(sessionId))?.backend ?? 'opencode'
}

const nativeCommands = new Set([
  'abort',
  'compact',
  'model',
  'model-variant',
  'queue',
  'clear-queue',
  'guide',
  'btw',
  'fork',
  'session-id',
  'resume',
  'context-usage',
  'verbosity',
])

/**
 * Capability guard for command routing. Callers must invoke this BEFORE any legacy
 * handler obtains an OpenCode client. Host-owned commands (diff, worktree management,
 * ...) are routed to their host handlers by the dispatcher and never reach this guard.
 */
export function requireCommand(
  backend: BackendId,
  command: string,
  capability: (command: string) => boolean,
): void {
  if (backend === 'opencode') {
    return
  }
  if (!nativeCommands.has(command) || !capability(command)) {
    throw fail(
      'CAPABILITY_UNSUPPORTED',
      `/${command} is not implemented for this native profile. OpenCode fallback is prohibited.`,
      'control',
    )
  }
}

/**
 * Thin delegation preserving the supplied existing OpenCode implementation unchanged
 * (receiver, args, result). This is the extraction seam for the real typed controller
 * boundary: the actual ThreadSessionRuntime stays the OpenCode controller and is never
 * rebuilt here. The receiver-preservation property is pinned by registry.test.ts.
 */
export class OpenCodeBackend<T extends object> {
  readonly id = 'opencode'
  constructor(readonly existingServices: T) {}
  call<K extends keyof T>(
    method: K,
    ...args: T[K] extends (...args: infer A) => unknown ? A : never
  ): T[K] extends (...args: never[]) => infer R ? R : never {
    const fn = this.existingServices[method]
    if (typeof fn !== 'function') {
      throw fail('CAPABILITY_UNSUPPORTED', 'OpenCode service is unavailable.')
    }
    return Reflect.apply(fn, this.existingServices, args)
  }
}
