// Native profile registry (ZK-007). The ONLY way a native runtime becomes
// selectable: an explicit profile with enabled=true. The default registry is
// empty and the default profile is disabled — default-off is structural, not a
// flag check. The synthetic codec exists for fake-native tests (ZK-007/015);
// capture-backed codecs arrive only with ZK-016 certification. — ZCode 2026-09-17

import type { CompatibilityCodec } from './native/protocol.js'
import type { ModelSelection } from './types.js'
import type { NativeProfile } from './zcode-backend.js'

export type { NativeProfile }

/** Launch profile fields a certified profile must supply (ZK-016 populates them). */
export type CertifiedLaunchFields = {
  executable: string
  executableSha256: string
  entryPath: string
  entrySha256: string
  args: readonly string[]
  environment: Readonly<Record<string, string>>
}

const profiles = new Map<string, NativeProfile>()

export function registerNativeProfile(profile: NativeProfile): void {
  profiles.set(profile.id, profile)
}

export function resolveNativeProfile(id: string): NativeProfile | undefined {
  return profiles.get(id)
}

export function registeredNativeProfiles(): readonly NativeProfile[] {
  return [...profiles.values()]
}

/**
 * Build a synthetic (fake-native) profile. `allowSynthetic` is only ever set
 * here, under an explicit test launch closure — the production path has no
 * synthetic codec, so ZcodeBackend.prepare refuses with RUNTIME_UNCERTIFIED.
 */
/** Profile preference that enables the conversation-only fork capability.
 * Certified profiles set it only with a captured rowsRange schema (ZK-016 N14);
 * until then every /btw on a native session refuses visibly. — ZK-011 */
export const NATIVE_FORK_CAPABILITY = 'forkAssistantEnabled'

export function syntheticProfile(input: {
  id: string
  revision: string
  codec: CompatibilityCodec
  launch: NativeProfile['launch']
  timeoutMs?: number
  cancelGraceMs?: number
  attachmentRoot: string
  modelOverlay?: (selection: ModelSelection) => unknown
  redact?: (value: string) => string
}): NativeProfile {
  return {
    id: input.id,
    revision: input.revision,
    enabled: true,
    mode: 'build',
    codec: input.codec,
    allowSynthetic: true,
    preferences: {
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: false,
    },
    display: 'legacy',
    launch: input.launch,
    timeoutMs: input.timeoutMs ?? 5000,
    cancelGraceMs: input.cancelGraceMs ?? 150,
    imageCapability: false,
    defaultModel: {
      providerId: 'fixture',
      modelId: 'fixture-model',
      reasoning: 'high',
      revision: 'r1',
    },
    attachmentRoot: input.attachmentRoot,
    ...(input.modelOverlay ? { modelOverlay: input.modelOverlay } : {}),
    redact: input.redact ?? ((value) => value),
  }
}
