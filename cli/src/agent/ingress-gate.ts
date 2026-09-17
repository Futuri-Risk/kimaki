// Ingress gate — the single backend/capability policy point every Discord
// entrypoint consults BEFORE any runtime work (ZK-005). A zc: session can never
// fall through to an OpenCode path here, and an unavailable native capability
// produces a visible refusal instead of a silent fallback. Host-owned commands
// and components keep host routing (diff, worktree/project management, shell,
// credentials, uploads) — they never touch an agent runtime.
//
// The capability provider is a seam for ZK-008: until the native coordinator
// registers real capabilities, every native command reports unsupported, which
// is the honest visible refusal for this build. — ZCode 2026-09-17

import { AgentError } from './native/errors.js'
import { requireCommand, resolveBackend, type BackendId } from './registry.js'
import { lookupBackendSidecar } from './host-sidecar.js'
import { getThreadSession } from '../database.js'

export type IngressDecision =
  | { kind: 'allow'; backend: BackendId | null }
  | { kind: 'refuse'; backend: BackendId; reason: string }

/** User-facing refusal when the message needs the native runtime itself. */
export const NATIVE_RUNTIME_UNAVAILABLE =
  'This thread is bound to a native ZCode session. The native runtime is not ' +
  'available in this build yet, so nothing was sent — OpenCode fallback is ' +
  'prohibited for ZCode sessions.'

/** Slash commands whose handler drives the thread's agent session. */
export const RUNTIME_SLASH_COMMANDS = new Set([
  'abort',
  'compact',
  'share',
  'fork',
  'fork-subagent',
  'btw',
  'model',
  'model-variant',
  'agent',
  'queue',
  'clear-queue',
  'queue-command',
  'undo',
  'redo',
  'verbosity',
  'context-usage',
  'session-id',
  'resume',
  'mcp',
])

/** Dynamic registered commands (suffix-built) that send prompts to a session. */
export const RUNTIME_COMMAND_SUFFIXES = ['-agent', '-cmd', '-skill', '-mcp-prompt']

/** Autocomplete for runtime commands (feeds the same handlers). */
export const RUNTIME_AUTOCOMPLETE_COMMANDS = new Set(['resume', 'queue-command'])

/** Component customId prefixes whose handler drives the thread's agent session,
 * mapped to the canonical command name used in the refusal message. */
export const RUNTIME_COMPONENT_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['fork_select:', 'fork'],
  ['fork_subagent_select:', 'fork-subagent'],
  ['model_provider:', 'model'],
  ['model_select:', 'model'],
  ['model_scope:', 'model'],
  ['model_variant:', 'model-variant'],
  ['variant_quick:', 'model-variant'],
  ['variant_scope:', 'model-variant'],
  ['agent_select:', 'agent'],
  ['verbosity_select:', 'verbosity'],
  ['ask_question:', 'ask-question'],
  ['mcp_toggle:', 'mcp'],
  ['permission_once:', 'permission'],
  ['permission_always:', 'permission'],
  ['permission_reject:', 'permission'],
  ['action_button:', 'action-button'],
])

type CapabilityProvider = (command: string) => boolean

// No native capability is wired until the ZK-008 coordinator registers a profile.
let nativeCapability: CapabilityProvider = () => false

/** ZK-008 seam: register the native profile's command capabilities. */
export function setNativeCapabilityProvider(provider: CapabilityProvider): void {
  nativeCapability = provider
}

export function isRuntimeSlashCommand(commandName: string): boolean {
  return (
    RUNTIME_SLASH_COMMANDS.has(commandName) ||
    (commandName !== 'agent' &&
      RUNTIME_COMMAND_SUFFIXES.some((suffix) => commandName.endsWith(suffix)))
  )
}

export function isRuntimeAutocomplete(commandName: string): boolean {
  return (
    RUNTIME_AUTOCOMPLETE_COMMANDS.has(commandName) ||
    (commandName !== 'agent' && commandName.endsWith('-agent'))
  )
}

export function runtimeCommandForComponent(customId: string): string | undefined {
  for (const [prefix, command] of RUNTIME_COMPONENT_COMMANDS) {
    if (customId.startsWith(prefix)) {
      return command
    }
  }
  return undefined
}

function refuseFromError(error: unknown, backend: BackendId): IngressDecision {
  const reason = error instanceof AgentError ? error.message : String(error)
  return { kind: 'refuse', backend, reason }
}

/**
 * Resolve the backend for a thread's session ID (null when the thread has no
 * session yet — new-session flows stay on host routing until ZK-007 minting).
 * A zc: ID without a sidecar row throws SESSION_SIDECAR_MISSING: that is an
 * integrity failure the caller must surface, never permission to use OpenCode.
 */
export async function resolveIngressBackend(
  sessionId: string | null | undefined,
  lookup: (sessionId: string) => Promise<{ backend: BackendId } | undefined> = lookupBackendSidecar,
): Promise<BackendId | null> {
  if (!sessionId) {
    return null
  }
  return resolveBackend(lookup, sessionId)
}

/** Ordinary messages (and sleep wakes / CLI-injected sends) on an existing session. */
export function gateThreadMessage(backend: BackendId | null): IngressDecision {
  if (backend === 'zcode') {
    return { kind: 'refuse', backend, reason: NATIVE_RUNTIME_UNAVAILABLE }
  }
  return { kind: 'allow', backend }
}

/** Commands dispatched against an existing session (`!`-style host shells excluded). */
export function gateThreadCommand(backend: BackendId | null, command: string): IngressDecision {
  if (backend !== 'zcode') {
    return { kind: 'allow', backend }
  }
  try {
    requireCommand('zcode', command, nativeCapability)
  } catch (error) {
    return refuseFromError(error, 'zcode')
  }
  return { kind: 'allow', backend }
}

/**
 * Resolve a thread's backend from its Discord channel/thread ID.
 * Non-runtime interactions never reach this — callers classify first.
 */
export async function resolveThreadBackendByChannelId(
  threadId: string | undefined,
  lookup?: Parameters<typeof resolveIngressBackend>[1],
): Promise<BackendId | null> {
  if (!threadId) {
    return null
  }
  return resolveIngressBackend(await getThreadSession(threadId), lookup)
}
