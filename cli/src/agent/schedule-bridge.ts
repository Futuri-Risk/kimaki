// ZK-014 scheduling/restart/recovery integration. Scheduled wakes dispatch to
// native sessions with a STABLE admission identity (source 'schedule' +
// run-keyed sourceId), so the same wake re-delivered after a restart dedupes
// to the original operation instead of double-submitting. Recovery of
// uncertain native states is explicit: store.recover marks unknown intents
// and nothing here ever re-sends them. `kimaki send` needs no native branch —
// it posts a Discord message, so it flows through the same message admission
// the bot uses for every prompt. — ZCode 2026-09-18
import { getThreadSession } from '../database.js'
import { resolveBackend } from './registry.js'
import { lookupBackendSidecar } from './host-sidecar.js'
import { getNativeCoordinator } from './host-coordinator.js'
import type { AgentCoordinator } from './coordinator.js'
import type { Operation } from './types.js'

export type ScheduledDispatch =
  | { kind: 'not-native' }
  | { kind: 'offline' }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'submitted'; operation: Operation; duplicate: boolean }

/**
 * Dispatch a scheduled prompt to a native session. `runKey` must be STABLE for
 * the same logical wake across restarts (the scheduled task run id): the
 * admission dedupe (session, source='schedule', sourceId, kind) then returns
 * the original operation on redelivery — a restart never double-submits.
 */
export async function dispatchScheduledPrompt(args: {
  threadId: string
  runKey: string
  prompt: string
}): Promise<ScheduledDispatch> {
  const sessionId = await getThreadSession(args.threadId)
  if (!sessionId) {
    return { kind: 'not-native' }
  }
  const backend = await resolveBackend(lookupBackendSidecar, sessionId)
  if (backend !== 'zcode') {
    return { kind: 'not-native' }
  }
  const coordinator = await getNativeCoordinator()
  if (!coordinator) {
    return { kind: 'offline' }
  }
  return ingestScheduled(coordinator, {
    sessionId,
    threadId: args.threadId,
    runKey: args.runKey,
    prompt: args.prompt,
  })
}

/** Direct ingest for callers that already hold a coordinator (tests/wiring). */
export async function ingestScheduled(
  coordinator: AgentCoordinator,
  args: {
    sessionId: string
    threadId: string
    runKey: string
    prompt: string
    actorId?: string
  },
): Promise<ScheduledDispatch> {
  const result = await coordinator.ingest({
    sessionId: args.sessionId,
    threadId: args.threadId,
    // Scheduled prompts act machine-wide on behalf of the thread's schedule:
    // authorization is the controller-thread binding, rechecked durably by
    // store.admit.
    actorId: args.actorId ?? 'schedule',
    source: 'schedule',
    sourceId: `schedule:${args.runKey}`,
    kind: 'prompt',
    text: args.prompt,
  })
  if (!result.ok) {
    return { kind: 'rejected', code: result.error.code, message: result.error.message }
  }
  return { kind: 'submitted', operation: result.value, duplicate: result.value.state !== 'queued' }
}

export type NativeRecoveryReport = {
  sessionId: string
  state: string
  uncertain: Array<{ id: string; state: string; kind: string }>
}

/**
 * Explicit recovery surface: mark uncertain native work as submission-unknown
 * and report it visibly. NEVER re-sends: the uncertain operations keep their
 * recovery fences, and a later duplicate admission maps to the SAME operation.
 */
export async function recoverNativeSession(
  sessionId: string,
): Promise<NativeRecoveryReport | null> {
  const coordinator = await getNativeCoordinator()
  if (!coordinator) {
    return null
  }
  return recoverWithCoordinator(coordinator, sessionId)
}

/** Recovery with an injected coordinator for tests. */
export async function recoverWithCoordinator(
  coordinator: AgentCoordinator,
  sessionId: string,
): Promise<NativeRecoveryReport | null> {
  const session = await coordinator.store.session(sessionId)
  if (!session) {
    return null
  }
  await coordinator.store.recover(sessionId)
  const fresh = await coordinator.store.session(sessionId)
  const operations = await coordinator.store.operations(sessionId)
  const uncertainStates = ['submission-unknown', 'send-intent', 'cancel-unconfirmed']
  return {
    sessionId,
    state: fresh?.state ?? session.state,
    uncertain: operations
      .filter((o) => uncertainStates.includes(o.state))
      .map((o) => ({ id: o.id, state: o.state, kind: o.kind })),
  }
}

/** Human-readable recovery state for visible status replies. */
export function describeRecovery(report: NativeRecoveryReport): string {
  if (report.uncertain.length === 0 && report.state !== 'recovery-required') {
    return `Native session ${report.sessionId} is \`${report.state}\`; nothing uncertain.`
  }
  const listed = report.uncertain.map((o) => `${o.kind}→\`${o.state}\``).join(', ')
  return (
    `Native session ${report.sessionId} is \`${report.state}\` with uncertain work (${listed || 'none listed'}). ` +
    'Uncertain submissions are locked for recovery — they are never automatically re-sent.'
  )
}
