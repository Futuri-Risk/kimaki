import { fail, record, text, integer } from './errors.js'
import type { ForkPoint, ModelSelection, NativeSnapshot, InteractionAnswer } from './types.js'
export function workspaceParams(workspacePath: string, workspaceKey: string) {
  return { workspacePath: text(workspacePath), workspaceKey: text(workspaceKey) }
}
export function createdSessionId(result: unknown): string {
  return text(record(record(result).session).sessionId, 'native session ID')
}
export function v4Command(input: {
  clientId: string
  sessionId: string
  operationId: string
  connectionId: string
  type: 'sendText' | 'stop' | 'forkAssistant'
  text?: string
  point?: ForkPoint
  now?: number
}) {
  const base = {
    commandId: text(input.operationId),
    clientId: text(input.clientId),
    sessionId: text(input.sessionId),
    connectionId: text(input.connectionId),
    clientMode: 'desktop-continuous',
    issuedAt: input.now ?? Date.now(),
  }
  if (input.type === 'sendText') {
    return {
      ...base,
      type: 'sendText',
      payload: { text: text(input.text, 'guide text'), requestedDelivery: 'guide' },
    }
  }
  if (input.type === 'forkAssistant') {
    const p = input.point
    if (!p) {
      throw fail('FORK_POINT_INVALID', 'A validated fork point is required.', 'control')
    }
    return {
      ...base,
      type: 'forkAssistant',
      payload: { target: { rowId: integer(p.rowId), entityId: text(p.entityId) } },
      baseRevision: integer(p.revision),
      baseLogEpoch: text(p.logEpoch),
    }
  }
  return { ...base, type: 'stop', payload: {} }
}
export function acceptedV4(value: unknown): Record<string, unknown> {
  const result = record(value)
  if (result.status === 'stale') {
    throw fail('CONTROL_STALE', 'Native control target is stale; revalidate it.', 'control')
  }
  if (result.status === 'rejected' || result.status === 'noop') {
    throw fail('CONTROL_REJECTED', 'Native control did not apply.', 'control')
  }
  if (result.status !== 'accepted' && result.status !== 'duplicate') {
    throw fail('CONTROL_UNKNOWN', 'Native control outcome is unknown.', 'control', 'possible')
  }
  return result
}
export function forkedSessionId(value: unknown) {
  return text(record(acceptedV4(value).result).sessionId, 'fork session ID')
}
export function assertModel(actual: ModelSelection, expected: ModelSelection) {
  if (
    actual.providerId !== expected.providerId ||
    actual.modelId !== expected.modelId ||
    actual.reasoning !== expected.reasoning
  ) {
    throw fail(
      'MODEL_SWITCH_FAILED',
      'Native model or reasoning readback did not match.',
      'control',
      'possible',
    )
  }
}
/** Codecs must be certified separately from transport. No guessed session/read schema. */
export interface CompatibilityCodec {
  readonly id: string
  readonly evidence: 'synthetic' | 'native-certified'
  forkPoint(result: unknown): ForkPoint
  snapshot(result: unknown, sessionId: string): NativeSnapshot
  interaction(
    method: string,
    params: unknown,
  ): {
    kind: 'permission' | 'question' | 'plan-approval'
    schema: unknown
  }
  answer(
    kind: 'permission' | 'question' | 'plan-approval',
    schema: unknown,
    answer: InteractionAnswer,
  ): unknown
}
export function quiescent(state: NativeSnapshot): boolean {
  return state.foreground === null && state.background.length === 0 && !state.goalActive
}
