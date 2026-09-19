/** Capture-backed CompatibilityCodec for the real ZCode Protocol app-server
 * (ZK-016). snapshot() parses ONLY the shape pinned from real captures
 * (fixtures/native-captured-zk16.json; evidence/zk16-{win32,linux}) — no
 * fake-session-v1 assumptions, no invented fields. Anything not yet captured
 * FAILS CLOSED with a named error (checklist: "unknown/lacking evidence refuses
 * execution"; "do not fill absent background/goal fields with false merely to
 * pass quiescent()").
 *
 * Captured divergences fixed here and in the bridge (never by weakening
 * direct-run semantics):
 *  - Identity is read from result.session.sessionId ONLY. projection.sessionId
 *    carried the cosmetic value "unknown" in every captured frame and is never
 *    consulted for identity (zk16 divergence #2).
 *  - The post-create reverse request session/requestRuntimePreferences is
 *    answered by the backend bridge from profile preferences
 *    (zcode-backend reverse()); the pinned envelope is regression-tested in
 *    captured-codec.test.ts (zk16 divergence #1).
 *
 * evidence stays 'synthetic' until the mechanical enablement rule flips the
 * OWNING PROFILE per passing rows — this codec alone certifies nothing; rows
 * N07+ (interaction/fork/turn shapes) are pending and their parsers fail
 * closed. — ZCode 2026-09-18 */
import { fail, integer, record, text } from './errors.js'
import type { CompatibilityCodec } from './protocol.js'
import type { NativeSnapshot } from './types.js'

/** Parse the captured session/read (== session/create body) shape. */
export function parseCapturedSnapshot(result: unknown, expectedSessionId: string): NativeSnapshot {
  const r = record(result)
  const protocol = record(r.protocol)
  if (protocol.name !== 'ZCode Protocol' || integer(protocol.version, 'protocol version') < 1) {
    throw fail('SCHEMA_INVALID', 'Native read is not a ZCode Protocol v1 body.')
  }  // Identity: session.sessionId only. projection.sessionId is cosmetic
  // ("unknown" in every captured frame) and deliberately never read.
  const session = record(r.session)
  const sessionId = text(session.sessionId, 'native session ID')
  if (sessionId !== expectedSessionId) {
    throw fail('SCHEMA_INVALID', 'Native read identity differs from the bound native session.')
  }
  const workspace = record(session.workspace)
  const runtime = record(r.runtime)
  const pendingRequestIds = runtime.pendingRequestIds
  const goalVerifications = runtime.goalVerifications
  if (
    !Array.isArray(pendingRequestIds) ||
    !Array.isArray(goalVerifications) ||
    integer(runtime.eventSeq, 'runtime eventSeq')
  ) {
    throw fail('SCHEMA_INVALID', 'Native read runtime activity state is incomplete.')
  }
  const projection = record(r.projection)
  const status = text(projection.status, 'projection status')
  const activeToolCalls = projection.activeToolCalls
  const backgroundJobs = projection.backgroundJobs
  if (!Array.isArray(activeToolCalls) || !Array.isArray(backgroundJobs)) {
    throw fail('SCHEMA_INVALID', 'Native read projection activity state is incomplete.')
  }
  // Quiescence must be EVIDENCE-based: the captured shape proves idle only via
  // status:"idle" plus empty activity arrays. Any busy/active shape has not
  // been captured yet (paid rows N07/N11/N12 own those captures), so it refuses
  // instead of fabricating a foreground id, background ids or goal state.
  const busy =
    status !== 'idle' ||
    pendingRequestIds.length > 0 ||
    activeToolCalls.length > 0 ||
    backgroundJobs.length > 0 ||
    goalVerifications.length > 0
  if (busy) {
    throw fail(
      'SCHEMA_INVALID',
      'Active native execution/background/goal state is not captured yet (ZK-016 N07+ pending); refusing to fabricate activity fields.',
    )
  }
  const settings = record(r.settings)
  const modelSettings = record(settings.model)
  if (!Array.isArray(modelSettings.available)) {
    throw fail('SCHEMA_INVALID', 'Native read settings.model.available is missing.')
  }
  // The captured (unauthenticated) profile advertises no current model. A
  // NativeSnapshot without a model selection cannot pass assertModel, so the
  // honest outcome is a named refusal — N05's authenticated capture will pin
  // the real current-model field and extend this parser.
  if (modelSettings.current === undefined) {
    throw fail(
      'MODEL_UNADVERTISED',
      'Captured native read carries no current model (unauthenticated config home); model selection cannot be read from this shape.',
      'control',
    )
  }
  return {
    sessionId,
    workspacePath: text(workspace.workspacePath, 'native workspace path'),
    workspaceKey: text(workspace.workspaceKey, 'native workspace key'),
    // parseCurrentModel (below) — kept separate so the capture-gate above stays
    // readable. Never reached while modelSettings.current is undefined.
    model: parseCurrentModel(modelSettings),
    foreground: null,
    background: [],
    goalActive: false,
    terminal: null, // no terminal field exists in the captured shape; absence is preserved as "no evidence", never "completed"
  }
}

/** Parse the advertised current model from settings.model. Captured 2026-09-19
 * (authenticated catalog, fixtures/native-captured-zk16.json
 * authenticatedModelSettings): current = {providerId, modelId,
 * options?:{reasoningLevel}}. `revision` is a HOST-side change-detection value
 * derived deterministically from the wire identity (not a wire field). */
function parseCurrentModel(modelSettings: Record<string, unknown>): NativeSnapshot['model'] {
  const current = record(modelSettings.current)
  const providerId = text(current.providerId, 'current model providerId')
  const modelId = text(current.modelId, 'current model modelId')
  const options = current.options === undefined ? undefined : record(current.options)
  const reasoning = options?.reasoningLevel
  return {
    providerId,
    modelId,
    ...(reasoning === undefined
      ? {}
      : { reasoning: text(reasoning, 'current model reasoningLevel') }),
    revision: `${providerId}/${modelId}${reasoning === undefined ? '' : `@${String(reasoning)}`}`,
  }
}

export const capturedCodec: CompatibilityCodec = {
  id: 'captured-native-zk16',
  // Deliberately NOT 'native-certified': only the free-row read shapes are
  // captured; turn/interaction/fork shapes wait on N07+. The flip happens with
  // the owning profile per the mechanical enablement rule, never here.
  evidence: 'synthetic',
  snapshot(value, expected) {
    return parseCapturedSnapshot(value, text(expected, 'expected native session ID'))
  },
  forkPoint() {
    throw fail(
      'FORK_POINT_INVALID',
      'No captured v4/conversation/rowsRange schema yet (ZK-016 N14 pending); fork stays disabled.',
      'control',
    )
  },
  interaction() {
    throw fail(
      'INTERACTION_UNSUPPORTED',
      'No captured native interaction schema yet (ZK-016 N08/N09 pending); unknown schemas fail closed.',
      'control',
    )
  },
  answer() {
    throw fail(
      'ANSWER_INVALID',
      'No captured native answer schema yet (ZK-016 N08/N09 pending).',
      'control',
    )
  },
}
