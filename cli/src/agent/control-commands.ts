// ZK-010 native control surface for host commands: /abort, /compact, /queue,
// /clear-queue and /model branch here BEFORE any OpenCode runtime call. Every
// control is a durable coordinator operation — cancel keeps ownership until a
// verified stop, compact never sends an OpenCode summarize prompt, queued
// prompts live in agent_operations (FIFO, cleared only pre-intent), and model
// state is only ever what the native runtime confirmed by readback.
// — ZCode 2026-09-18
import { randomUUID } from 'node:crypto'
import { getThreadSession } from '../database.js'
import { resolveBackend } from './registry.js'
import { lookupBackendSidecar } from './host-sidecar.js'
import { getNativeCoordinator } from './host-coordinator.js'
import type { Input, ModelSelection } from './types.js'

export type NativeControlKind = 'cancel' | 'compact' | 'guide'

export type NativeControlOutcome =
  | { kind: 'not-native' }
  | { kind: 'offline' }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'done'; state: string }

/**
 * Resolve the channel's session; when it is a native (zc:) session, run the
 * control through the coordinator and report its DURABLE terminal state.
 * Returns 'not-native' so OpenCode-backed commands keep their own flow.
 */
export async function runNativeControl(args: {
  threadId: string
  actorId: string
  kind: NativeControlKind
  text?: string
  payload?: unknown
}): Promise<NativeControlOutcome> {
  const resolved = await resolveNativeSession(args.threadId)
  if (!resolved || resolved.backend !== 'zcode') {
    return { kind: 'not-native' }
  }
  const coordinator = await getNativeCoordinator()
  if (!coordinator) {
    return { kind: 'offline' }
  }
  // Controls are idempotent per actor+kind: a repeat while one is pending
  // dedupes to the same operation instead of stacking a second control.
  const input: Input = {
    sessionId: resolved.sessionId,
    threadId: args.threadId,
    actorId: args.actorId,
    source: 'discord',
    sourceId: `${args.actorId}:${args.kind}`,
    kind: args.kind,
    text: args.text ?? '',
    ...(args.payload !== undefined ? { payload: args.payload } : {}),
  }
  const result = await coordinator.ingest(input)
  if (!result.ok) {
    return { kind: 'rejected', code: result.error.code, message: result.error.message }
  }
  await coordinator.settle()
  const final = await coordinator.store.operation(result.value.id)
  return { kind: 'done', state: final?.state ?? 'unknown' }
}

/** Queue a prompt on a native session durably (FIFO behind any active turn). */
export async function queueNativePrompt(args: {
  threadId: string
  actorId: string
  text: string
}): Promise<NativeControlOutcome & { position?: number }> {
  const resolved = await resolveNativeSession(args.threadId)
  if (!resolved || resolved.backend !== 'zcode') {
    return { kind: 'not-native' }
  }
  const coordinator = await getNativeCoordinator()
  if (!coordinator) {
    return { kind: 'offline' }
  }
  const input: Input = {
    sessionId: resolved.sessionId,
    threadId: args.threadId,
    actorId: args.actorId,
    source: 'discord',
    // Each queued message is its own admission; the uuid keeps the dedupe key
    // per-message (content changes are otherwise admission conflicts).
    sourceId: `${args.actorId}:queue:${randomUUID()}`,
    kind: 'prompt',
    text: args.text,
  }
  const result = await coordinator.ingest(input)
  if (!result.ok) {
    return { kind: 'rejected', code: result.error.code, message: result.error.message }
  }
  const queued = await coordinator.store.operations(resolved.sessionId)
  const position = queued
    .filter((o) => o.kind === 'prompt' && o.state === 'queued')
    .findIndex((o) => o.id === result.value.id)
  await coordinator.settle()
  const final = await coordinator.store.operation(result.value.id)
  return {
    kind: 'done',
    state: final?.state ?? 'unknown',
    ...(position >= 0 ? { position: position + 1 } : {}),
  }
}

/**
 * Clear queued (pre-intent) native prompts only. Returns the removed count, or
 * null when the thread is not a native session.
 */
export async function clearNativeQueue(args: { threadId: string }): Promise<number | null> {
  const resolved = await resolveNativeSession(args.threadId)
  if (!resolved || resolved.backend !== 'zcode') {
    return null
  }
  const coordinator = await getNativeCoordinator()
  if (!coordinator) {
    return 0
  }
  return coordinator.store.clearQueue(resolved.sessionId)
}

/**
 * The native model state for display: only what a previous switchModel readback
 * confirmed (the coordinator persists setModel AFTER the native runtime
 * echoes the selection). Nothing OpenCode-advertised is ever shown for zc:.
 */
export async function nativeModelStatus(args: {
  threadId: string
}): Promise<
  { kind: 'not-native' } | { kind: 'offline' } | { kind: 'model'; model: ModelSelection }
> {
  const resolved = await resolveNativeSession(args.threadId)
  if (!resolved || resolved.backend !== 'zcode') {
    return { kind: 'not-native' }
  }
  const coordinator = await getNativeCoordinator()
  if (!coordinator) {
    return { kind: 'offline' }
  }
  const session = await coordinator.store.session(resolved.sessionId)
  if (!session) {
    return { kind: 'offline' }
  }
  return { kind: 'model', model: session.model }
}

/** Cheap detection so commands can defer their reply before a slow control runs. */
export async function isNativeThread(threadId: string): Promise<boolean> {
  const resolved = await resolveNativeSession(threadId)
  return resolved?.backend === 'zcode'
}

async function resolveNativeSession(
  threadId: string,
): Promise<{ sessionId: string; backend: 'opencode' | 'zcode' } | null> {
  const sessionId = await getThreadSession(threadId)
  if (!sessionId) {
    return null
  }
  return { sessionId, backend: await resolveBackend(lookupBackendSidecar, sessionId) }
}

/** Human-readable outcome for command replies. */
export function describeNativeControl(outcome: NativeControlOutcome): string | null {
  if (outcome.kind === 'not-native') {
    return null
  }
  if (outcome.kind === 'offline') {
    return 'The native runtime is not available right now.'
  }
  if (outcome.kind === 'rejected') {
    return `Native control refused (${outcome.code}): ${outcome.message}`
  }
  if (outcome.state === 'cancel-unconfirmed') {
    return 'Stop could not be verified — the session stays locked for recovery. No further work will be submitted.'
  }
  if (outcome.state === 'completed') {
    return '✓ Native control applied.'
  }
  return `Native control ended in state \`${outcome.state}\`.`
}
