// ZK-015 host message wiring for native sessions: ordinary thread messages,
// CLI-injected prompts, and scheduled wakes admit through the SAME coordinator
// (one admission → ≤1 native submission); attachments stage through the
// hardened pipeline; outbox rows flush through the ZK-008 renderer with real
// Discord ports. OpenCode is never touched on these routes. — ZCode 2026-09-18
import { randomUUID } from 'node:crypto'
import type { Client, Message, ThreadChannel } from 'discord.js'
import { getThreadSession, upsertThreadSession } from '../database.js'
import { resolveBackend } from './registry.js'
import { lookupBackendSidecar, countActiveNativeOperations } from './host-sidecar.js'
import { getNativeCoordinator } from './host-coordinator.js'
import { getOwnerMachineId } from './host-identity.js'
import { ingestScheduled } from './schedule-bridge.js'
import { OutboxRenderer, type RendererPorts, type DeliveryProbe } from './renderer.js'
import { stageDiscordAttachments } from './attachment-pipeline.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import type { AgentCoordinator } from './coordinator.js'
import type { Attachment } from './attachments.js'
import type { Input } from './types.js'

// ── Discord client seam ─────────────────────────────────────────────────────

let discordClient: Client | null = null

/** The bot registers its client at startup; tests inject a fake. Default null = inert. */
export function setNativeDiscordClient(client: Client | null): void {
  discordClient = client
}

async function resolveThread(threadId: string): Promise<ThreadChannel | null> {
  if (!discordClient) {
    return null
  }
  try {
    const channel = await discordClient.channels.fetch(threadId)
    return channel?.isThread() ? channel : null
  } catch {
    return null
  }
}

/**
 * Real Discord delivery ports for the ZK-008 renderer: sends carry nonces and
 * silent flags with no mention parsing; verification matches nonces and exact
 * content over a bounded recent-message fetch; edits and deletes target known
 * ids. Absence from the bounded fetch is not proof of non-delivery (the
 * renderer already refuses to resend on a miss).
 */
export function createDiscordRendererPorts(): RendererPorts {
  return {
    send: async (delivery) => {
      const thread = await resolveThread(delivery.threadId)
      if (!thread) {
        throw new Error(`thread ${delivery.threadId} is not resolvable`)
      }
      const sent = await thread.send({
        content: delivery.content,
        nonce: delivery.nonce,
        flags: SILENT_MESSAGE_FLAGS,
        allowedMentions: delivery.allowedMentions,
      })
      return { id: sent.id }
    },
    edit: async (delivery) => {
      const thread = await resolveThread(delivery.threadId)
      if (!thread) {
        throw new Error(`thread ${delivery.threadId} is not resolvable`)
      }
      const message = await thread.messages.fetch(delivery.messageId).catch(() => null)
      if (!message) {
        throw new Error(`message ${delivery.messageId} is not resolvable`)
      }
      await message.edit({ content: delivery.content, allowedMentions: delivery.allowedMentions })
    },
    delete: async (threadId, messageId) => {
      const thread = await resolveThread(threadId)
      if (!thread) {
        return
      }
      const message = await thread.messages.fetch(messageId).catch(() => null)
      await message?.delete().catch(() => undefined)
    },
    verify: async (threadId, probe: DeliveryProbe) => {
      const thread = await resolveThread(threadId)
      if (!thread) {
        return null
      }
      const recent = await thread.messages.fetch({ limit: 50 }).catch(() => null)
      if (!recent) {
        return null
      }
      const byId = new Map(recent.map((m) => [m.id, m]))
      const ids: string[] = []
      for (let i = 0; i < probe.byNonce.length + probe.byId.length; i++) {
        ids.push('')
      }
      for (const entry of probe.byNonce) {
        const found = [...recent.values()].find(
          (m) => (m as { nonce?: unknown }).nonce === entry.nonce,
        )
        if (!found || found.content !== entry.content) {
          return null
        }
        ids[entry.index] = found.id
      }
      for (const entry of probe.byId) {
        const found = byId.get(entry.id)
        if (!found || found.content !== entry.content) {
          return null
        }
        ids[entry.index] = found.id
      }
      return { ids }
    },
  }
}

let rendererSingleton: OutboxRenderer | undefined

/** Lazily constructed renderer over the real Discord ports. */
export function getNativeOutboxRenderer(coordinator: AgentCoordinator): OutboxRenderer {
  rendererSingleton ??= new OutboxRenderer(coordinator.store, createDiscordRendererPorts())
  return rendererSingleton
}

/** Test seam. */
export function resetNativeOutboxRenderer(): void {
  rendererSingleton = undefined
}

/**
 * Flush a session's outbox after admissions. Runs until the outbox drains or
 * the active work settles, so a turn's parts reach Discord without a separate
 * cron: every call is bounded and safe to re-run.
 */
export async function flushNativeOutbox(
  coordinator: AgentCoordinator,
  sessionId: string,
  rounds = 8,
): Promise<void> {
  const renderer = getNativeOutboxRenderer(coordinator)
  for (let i = 0; i < rounds; i++) {
    await renderer.flush()
    if ((await countActiveNativeOperations(sessionId)) === 0) {
      await renderer.flush()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await renderer.flush()
}

// ── Message ingestion ───────────────────────────────────────────────────────

export type IngestSource = 'discord' | 'schedule' | 'cli'

export type NativeIngestResult =
  | { kind: 'not-native' }
  | { kind: 'offline' }
  | { kind: 'rejected'; code: string; message: string }
  | { kind: 'submitted'; source: IngestSource }

/**
 * The single message admission for native threads. `sourceKey` is the stable
 * dedupe identity (Discord message id, schedule run key, CLI marker) so a
 * redelivered wake or retried send maps to the SAME operation.
 */
export async function ingestNativeThreadMessage(args: {
  threadId: string
  actorId: string
  text: string
  source: IngestSource
  sourceKey: string
  attachments?: ReadonlyArray<{ filename: string; mimeType: string; url: string }>
}): Promise<NativeIngestResult> {
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
  return ingestWithCoordinator(coordinator, {
    sessionId,
    threadId: args.threadId,
    actorId: args.actorId,
    text: args.text,
    source: args.source,
    sourceKey: args.sourceKey,
    attachments: args.attachments,
  })
}

/** Direct ingest for callers holding a coordinator (tests, bot wiring). */
export async function ingestWithCoordinator(
  coordinator: AgentCoordinator,
  args: {
    sessionId: string
    threadId: string
    actorId: string
    text: string
    source: IngestSource
    sourceKey: string
    attachments?: ReadonlyArray<{ filename: string; mimeType: string; url: string }>
  },
): Promise<NativeIngestResult> {
  let staged: Attachment[] = []
  if (args.attachments && args.attachments.length > 0) {
    const outcome = await stageDiscordAttachments({
      store: coordinator.store,
      sessionId: args.sessionId,
      attachmentRoot: coordinator.backend.profile.attachmentRoot,
      files: args.attachments,
    })
    staged = outcome.staged
  }
  const input: Input = {
    sessionId: args.sessionId,
    threadId: args.threadId,
    actorId: args.actorId,
    source: args.source,
    sourceId: args.sourceKey,
    kind: 'prompt',
    text: args.text,
    ...(staged.length > 0 ? { payload: { attachments: staged } } : {}),
  }
  const result = await coordinator.ingest(input)
  if (!result.ok) {
    return { kind: 'rejected', code: result.error.code, message: result.error.message }
  }
  // Deliver the turn's parts, then keep flushing behind the queue until the
  // session settles. Failures surface as visible reply text, never resends.
  void flushNativeOutbox(coordinator, args.sessionId).catch(() => undefined)
  return { kind: 'submitted', source: args.source }
}

/**
 * Scheduled-marker ingest: the marker footer on the bot's own scheduled
 * message identifies the wake; the run key keeps restart redelivery a no-op.
 */
export async function ingestScheduledMessage(
  coordinator: AgentCoordinator,
  args: {
    sessionId: string
    threadId: string
    runKey: string
    prompt: string
    actorId?: string
  },
): Promise<NativeIngestResult> {
  const result = await ingestScheduled(coordinator, {
    sessionId: args.sessionId,
    threadId: args.threadId,
    runKey: args.runKey,
    prompt: args.prompt,
    actorId: args.actorId ?? 'schedule',
  })
  if (result.kind === 'submitted') {
    void flushNativeOutbox(coordinator, args.sessionId).catch(() => undefined)
    return { kind: 'submitted', source: 'schedule' }
  }
  if (result.kind === 'rejected') {
    return result
  }
  return result
}

/**
 * Read-only channel backend default (agent_backend_defaults) — consulted
 * BEFORE any coordinator need so default-off (OpenCode) channels fall through
 * with zero native side effects or writes.
 */
export async function agentChannelBackendDefault(
  channelId: string,
): Promise<{ backend: 'opencode' | 'zcode'; profileId: string | null } | null> {
  const { getRawDbClient } = await import('../db.js')
  const { libsqlSqlClient } = await import('./sql.js')
  const client = libsqlSqlClient(await getRawDbClient())
  const row = (
    await client.execute({
      sql: "SELECT backend_type, profile_id FROM agent_backend_defaults WHERE (scope_type='channel' AND scope_id=?) OR (scope_type='global' AND scope_id='global') ORDER BY CASE scope_type WHEN 'channel' THEN 0 ELSE 1 END LIMIT 1",
      args: [channelId],
    })
  ).rows[0]
  if (!row) {
    return null
  }
  return {
    backend: String(row.backend_type) === 'zcode' ? 'zcode' : 'opencode',
    profileId: typeof row.profile_id === 'string' ? row.profile_id : null,
  }
}

export type NativeThreadSession =
  | { kind: 'created'; sessionId: string }
  | { kind: 'existing'; sessionId: string }
  | { kind: 'not-native' }
  | { kind: 'offline' }

/**
 * Bind a NEW thread to a native session when the channel's frozen intent says
 * zcode (agent_thread_intents rows are written by the same durable host writer
 * the coordinator uses; a pending workspace never falls back to repo root).
 */
export async function ensureNativeThreadSession(args: {
  threadId: string
  channelId: string
  projectDirectory: string
}): Promise<NativeThreadSession> {
  const existing = await getThreadSession(args.threadId)
  if (existing) {
    const backend = await resolveBackend(lookupBackendSidecar, existing)
    return backend === 'zcode' ? { kind: 'existing', sessionId: existing } : { kind: 'not-native' }
  }
  // Default-off first: an OpenCode channel falls through with no native
  // writes and no coordinator construction (byte-identical baseline behavior).
  const channelDefault = await agentChannelBackendDefault(args.channelId)
  if (!channelDefault || channelDefault.backend !== 'zcode') {
    return { kind: 'not-native' }
  }
  const coordinator = await getNativeCoordinator()
  if (!coordinator) {
    // The channel is native-configured but the runtime is off: visible.
    return { kind: 'offline' }
  }
  const intent = await coordinator.store.freezeIntent(args.threadId, args.channelId, 'global')
  if (String(intent.backend_type) !== 'zcode') {
    return { kind: 'not-native' }
  }
  const profileId = typeof intent.profile_id === 'string' ? intent.profile_id : 'zcode-primary'
  const { resolveNativeProfile } = await import('./native-profile.js')
  const profile = resolveNativeProfile(profileId)
  if (!profile?.enabled || !profile.defaultModel) {
    // No certified default selection: refuse rather than inventing a model.
    return { kind: 'offline' }
  }
  const machineId = await getOwnerMachineId()
  const session = await coordinator.store.createNativeSession({
    threadId: args.threadId,
    projectDirectory: args.projectDirectory,
    ownerMachineId: machineId,
    profileId,
    profileRevision: profile.revision,
    model: profile.defaultModel,
  })
  await upsertThreadSession({ threadId: args.threadId, sessionId: session.id, source: 'kimaki' })
  return { kind: 'created', sessionId: session.id }
}
