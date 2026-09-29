// ZK-009 native interaction bridge: Discord component surface for native
// permission/question/plan-approval reverse requests. Every prompt carries a
// fresh opaque one-use interaction id (minted by the backend per native RPC,
// so a reused numeric native id can never revive an old UI token — H25/H26);
// answers travel ONLY as coordinator kind:'answer' ingests back to the
// original native RPC via the codec. There is deliberately NO autoapprove and
// no timeout auto-answer: a native request can be answered solely by an
// explicit authorized user action (deny is itself an explicit answer). — ZCode
// 2026-09-18
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  type ThreadChannel,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js'
import type { AgentCoordinator } from './coordinator.js'
import type { InteractionAnswer, NativeEvent, NativeInteraction } from './types.js'
import { fail, type Result } from './errors.js'
import { NOTIFY_MESSAGE_FLAGS } from '../discord-utils.js'
import { resolveThreadBackendByChannelId } from './ingress-gate.js'

export const NATIVE_INTERACTION_PREFIX = 'zci:'
const DISCORD_CUSTOM_ID_LIMIT = 100

export type PermissionControl = 'allow-once' | 'deny' | 'approve' | 'reject'

/** Component id codec: `zci:<opaque-id>:<control>` or `zci:<opaque-id>:q:<question-id>`. */
export function interactionCustomId(interactionId: string, control: PermissionControl): string {
  const id = `${NATIVE_INTERACTION_PREFIX}${interactionId}:${control}`
  if (id.length > DISCORD_CUSTOM_ID_LIMIT) {
    throw new Error(`interaction custom id exceeds ${DISCORD_CUSTOM_ID_LIMIT} chars`)
  }
  return id
}

export function questionCustomId(interactionId: string, questionId: string): string | null {
  const id = `${NATIVE_INTERACTION_PREFIX}${interactionId}:q:${questionId}`
  return id.length <= DISCORD_CUSTOM_ID_LIMIT ? id : null
}

export type ParsedComponent =
  | { interactionId: string; control: PermissionControl; questionId?: undefined }
  | { interactionId: string; control: 'question'; questionId: string }

export function parseInteractionCustomId(customId: string): ParsedComponent | null {
  if (!customId.startsWith(NATIVE_INTERACTION_PREFIX)) {
    return null
  }
  const rest = customId.slice(NATIVE_INTERACTION_PREFIX.length)
  const questionAt = rest.indexOf(':q:')
  if (questionAt >= 0) {
    const interactionId = rest.slice(0, questionAt)
    const questionId = rest.slice(questionAt + 3)
    if (!interactionId || interactionId.includes(':') || !questionId || questionId.includes(':')) {
      return null
    }
    return { interactionId, control: 'question', questionId }
  }
  const colon = rest.indexOf(':')
  if (colon <= 0 || colon !== rest.lastIndexOf(':')) {
    return null
  }
  const interactionId = rest.slice(0, colon)
  const control = rest.slice(colon + 1) as PermissionControl
  if (!['allow-once', 'deny', 'approve', 'reject'].includes(control)) {
    return null
  }
  return { interactionId, control }
}

/** Renderer-neutral prompt views; the Discord adapter turns these into components. */
export type PromptView =
  | {
      kind: 'permission'
      interactionId: string
      threadId: string
      toolCallId: string
      toolName: string
      summary: string
    }
  | {
      kind: 'plan-approval'
      interactionId: string
      threadId: string
      title: string
    }
  | {
      kind: 'question'
      interactionId: string
      threadId: string
      questions: Array<{ id: string; label: string; options: string[]; multiple: boolean }>
    }
  | {
      kind: 'unsupported'
      interactionId: string
      threadId: string
      reason: string
    }

function bounded(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Shape a native request into a renderable view. Unknown/uncertified schemas
 * fail CLOSED: an `unsupported` view with no answerable component — the native
 * question/plan schemas are synthetic until ZK-016 captures real ones, and a
 * wrong guess would let a UI answer the wrong RPC.
 */
export function interactionPromptView(request: NativeInteraction): PromptView {
  const base = { interactionId: request.id, threadId: request.threadId }
  if (request.kind === 'permission') {
    const schema = request.schema as Record<string, unknown> | null
    if (!schema || typeof schema.toolCallId !== 'string' || typeof schema.toolName !== 'string') {
      return {
        kind: 'unsupported',
        ...base,
        reason: 'Permission request schema is not certified for native UI.',
      }
    }
    return {
      kind: 'permission',
      ...base,
      toolCallId: bounded(schema.toolCallId, 80),
      toolName: bounded(schema.toolName, 80),
      summary: bounded(schema.input ?? {}, 512),
    }
  }
  if (request.kind === 'plan-approval') {
    const schema = request.schema as Record<string, unknown> | null
    if (!schema || schema.kind !== 'plan') {
      return {
        kind: 'unsupported',
        ...base,
        reason: 'Plan approval schema is not certified for native UI.',
      }
    }
    return {
      kind: 'plan-approval',
      ...base,
      title: bounded(schema.title ?? 'Native plan approval', 200),
    }
  }
  const schema = request.schema as Record<string, unknown> | null
  const questions = schema && Array.isArray(schema.questions) ? schema.questions : null
  if (!schema || schema.kind !== 'questions' || !questions) {
    return {
      kind: 'unsupported',
      ...base,
      reason: 'Question schema is not certified for native UI.',
    }
  }
  const shaped: Array<{ id: string; label: string; options: string[]; multiple: boolean }> = []
  const seen = new Set<string>()
  for (const entry of questions) {
    const q = entry as Record<string, unknown>
    if (!q || typeof q.id !== 'string' || q.id.length === 0 || seen.has(q.id)) {
      return {
        kind: 'unsupported',
        ...base,
        reason: 'Question schema is not certified for native UI.',
      }
    }
    // Options become both Discord labels and select values, so what a user
    // picks is byte-identical to what the native codec validates; duplicate or
    // oversized options cannot round-trip and fail closed here.
    const options =
      Array.isArray(q.options) &&
      q.options.length > 0 &&
      q.options.length <= 25 &&
      q.options.every((o) => typeof o === 'string' && o.length > 0 && o.length <= 100) &&
      new Set(q.options as string[]).size === (q.options as string[]).length
        ? (q.options as string[])
        : null
    if (!options) {
      return {
        kind: 'unsupported',
        ...base,
        reason: 'Question schema is not certified for native UI.',
      }
    }
    if (!questionCustomId(request.id, q.id)) {
      return {
        kind: 'unsupported',
        ...base,
        reason: 'Native question id does not fit a Discord component id.',
      }
    }
    seen.add(q.id)
    shaped.push({
      id: q.id,
      label: bounded(q.question ?? q.header ?? q.id, 1600),
      options,
      multiple: q.multiple === true,
    })
  }
  if (shaped.length === 0) {
    return {
      kind: 'unsupported',
      ...base,
      reason: 'Question schema is not certified for native UI.',
    }
  }
  return { kind: 'question', ...base, questions: shaped }
}

export type ComponentSelection = { control: 'allow-once' | 'deny' | 'approve' | 'reject' }

/** Map a user component action to the native answer shape; the codec has the final word. */
export function answerFromSelection(selection: ComponentSelection): InteractionAnswer {
  if (selection.control === 'allow-once' || selection.control === 'deny') {
    return { kind: 'permission', decision: selection.control }
  }
  return { kind: 'plan-approval', approved: selection.control === 'approve' }
}

export type BridgePorts = {
  sendPrompt: (threadId: string, view: PromptView) => Promise<void>
  sendNotice: (threadId: string, text: string) => Promise<void>
}

export class InteractionBridge {
  private offered = new Map<string, NativeInteraction>()
  // A native question RPC is answered ONCE with values for every question, so
  // per-question select fires are collected here until the set is complete.
  private collected = new Map<string, Record<string, readonly string[]>>()

  constructor(readonly ports: BridgePorts) {}

  /** Host observer tap (wired via backend.onHostEvent in host-coordinator). */
  async handleNativeEvent(sessionId: string, event: NativeEvent): Promise<void> {
    if (event.type === 'interaction') {
      this.offered.set(event.request.id, event.request)
      await this.ports.sendPrompt(event.request.threadId, interactionPromptView(event.request))
    } else if (event.type === 'interaction-closed') {
      this.offered.delete(event.id)
      this.collected.delete(event.id)
    }
  }

  /**
   * Discord component fire → one authorized, one-use answer through the
   * coordinator. Every denial surfaces as an error Result; nothing here can
   * resend, auto-answer, or touch an OpenCode permission path.
   *
   * Question requests collect one selection per question and submit a single
   * native answer once every question has a value (the native codec answers
   * the whole RPC, not individual questions).
   */
  async submitFromComponent(args: {
    coordinator: AgentCoordinator
    sessionId: string
    actorId: string
    threadId: string
    customId: string
    selected?: string[]
  }): Promise<Result<{ acknowledged: true; submitted: boolean }>> {
    const parsed = parseInteractionCustomId(args.customId)
    if (!parsed) {
      return {
        ok: false,
        error: fail('COMPONENT_UNKNOWN', 'Unknown native interaction component.', 'control'),
      }
    }
    const request = this.offered.get(parsed.interactionId)
    if (!request || request.threadId !== args.threadId || request.sessionId !== args.sessionId) {
      return {
        ok: false,
        error: fail('INTERACTION_GONE', 'This native request is no longer active.', 'control'),
      }
    }
    let answer: InteractionAnswer
    if (parsed.control === 'question') {
      const questionIds = Array.isArray(
        (request.schema as Record<string, unknown> | null)?.questions,
      )
        ? ((request.schema as Record<string, unknown>).questions as unknown[])
            .map((q) => (q as Record<string, unknown> | null)?.id)
            .filter((id): id is string => typeof id === 'string')
        : []
      if (questionIds.length === 0) {
        return {
          ok: false,
          error: fail('ANSWER_REJECTED', 'Native question set is empty.', 'control'),
        }
      }
      const stored = this.collected.get(parsed.interactionId) ?? {}
      if (stored[parsed.questionId] === undefined) {
        stored[parsed.questionId] = args.selected ?? []
        this.collected.set(parsed.interactionId, stored)
      }
      if (!questionIds.every((id) => stored[id] !== undefined)) {
        return { ok: true, value: { acknowledged: true, submitted: false } }
      }
      answer = { kind: 'question', values: stored }
    } else {
      answer = answerFromSelection({ control: parsed.control })
    }
    // The coordinator re-verifies actor/thread authorization, codec answer
    // validity, and the durable one-use consume; the backend replies to the
    // ORIGINAL native RPC id. Operation identity is actor+interaction: the
    // same user legitimately answers several requests in one session, and a
    // reused numeric native id under a fresh opaque token is a distinct op.
    const result = await args.coordinator.ingest({
      sessionId: args.sessionId,
      threadId: args.threadId,
      actorId: args.actorId,
      source: 'discord',
      sourceId: `${args.actorId}:${parsed.interactionId}`,
      kind: 'answer',
      text: '',
      payload: { interactionId: parsed.interactionId, answer },
    })
    if (!result.ok) {
      return result
    }
    // Ingest acceptance only queues the answer; wait for its durable outcome.
    // A non-completed terminal (expired request, consumed one-use, invalid
    // codec answer) is a denial — never an automatic retry.
    await args.coordinator.settle()
    const final = await args.coordinator.store.operation(result.value.id)
    if (!final || final.state === 'completed') {
      this.offered.delete(parsed.interactionId)
      this.collected.delete(parsed.interactionId)
      return { ok: true, value: { acknowledged: true, submitted: true } }
    }
    return {
      ok: false,
      error: fail(
        'ANSWER_REJECTED',
        'The native answer was rejected (request expired, already answered, or invalid).',
        'control',
      ),
    }
  }
}

let bridgePorts: BridgePorts = {
  sendPrompt: async () => {},
  sendNotice: async () => {},
}

/** Host seam: the bot registers real Discord rendering at startup. Default no-op keeps the bridge inert. */
export function setInteractionBridgePorts(ports: BridgePorts): void {
  bridgePorts = ports
}

let bridgeSingleton: InteractionBridge | undefined

export function getInteractionBridge(): InteractionBridge {
  bridgeSingleton ??= new InteractionBridge(bridgePorts)
  return bridgeSingleton
}

/** Test seam — production never resets. */
export function resetInteractionBridge(): void {
  bridgeSingleton = undefined
}

// ── Discord adapter ────────────────────────────────────────────────────────

function permissionRow(view: Extract<PromptView, { kind: 'permission' }>) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(interactionCustomId(view.interactionId, 'allow-once'))
      .setLabel('Allow once')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(interactionCustomId(view.interactionId, 'deny'))
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger),
  )
}

function planRow(view: Extract<PromptView, { kind: 'plan-approval' }>) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(interactionCustomId(view.interactionId, 'approve'))
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(interactionCustomId(view.interactionId, 'reject'))
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  )
}

/**
 * Real Discord rendering: prompts are plain notification messages with one
 * button row (or one select menu per question) whose custom ids carry only the
 * short opaque interaction id — the server resolves everything else.
 */
export function createDiscordInteractionPorts(
  resolveThread: (threadId: string) => Promise<ThreadChannel | null>,
): BridgePorts {
  return {
    sendPrompt: async (threadId, view) => {
      const thread = await resolveThread(threadId)
      if (!thread) {
        return
      }
      if (view.kind === 'permission') {
        await thread.send({
          content: `**Native permission request** — \`${view.toolName}\` (\`${view.toolCallId}\`)\n\`\`\`\n${view.summary}\n\`\`\``,
          components: [permissionRow(view)],
          flags: NOTIFY_MESSAGE_FLAGS,
          allowedMentions: { parse: [] },
        })
        return
      }
      if (view.kind === 'plan-approval') {
        await thread.send({
          content: `**Native plan approval** — ${view.title}`,
          components: [planRow(view)],
          flags: NOTIFY_MESSAGE_FLAGS,
          allowedMentions: { parse: [] },
        })
        return
      }
      if (view.kind === 'question') {
        for (const question of view.questions) {
          const customId = questionCustomId(view.interactionId, question.id)
          if (!customId) {
            continue
          }
          const menu = new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder('Select an answer')
            .addOptions(question.options.slice(0, 25).map((label) => ({ label, value: label })))
          if (question.multiple) {
            menu.setMinValues(1)
            menu.setMaxValues(question.options.length)
          }
          await thread.send({
            content: question.label,
            components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
            flags: NOTIFY_MESSAGE_FLAGS,
            allowedMentions: { parse: [] },
          })
        }
        return
      }
      await thread.send({
        content: `**Native interaction unavailable** — ${view.reason}`,
        flags: NOTIFY_MESSAGE_FLAGS,
        allowedMentions: { parse: [] },
      })
    },
    sendNotice: async (threadId, text) => {
      const thread = await resolveThread(threadId)
      if (!thread) {
        return
      }
      await thread.send({
        content: text,
        flags: MessageFlags.SuppressNotifications,
        allowedMentions: { parse: [] },
      })
    },
  }
}

// ── Component ingress (interaction-handler routing) ────────────────────────

/**
 * Host routing target for `zci:` components: resolve the channel's session,
 * refuse anything that is not a live native session, then submit through the
 * bridge. Denials are visible and consume nothing.
 */
export async function handleNativeInteractionComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  const threadId = interaction.channelId ?? undefined
  const refuse = async (content: string) => {
    if (interaction.isRepliable()) {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined)
    }
  }
  if (!threadId) {
    await refuse('This interaction has no channel context.')
    return
  }
  const backend = await resolveThreadBackendByChannelId(threadId)
  if (backend !== 'zcode') {
    await refuse('Native interactions are only available on ZCode sessions.')
    return
  }
  const { getNativeCoordinator } = await import('./host-coordinator.js')
  const { getThreadSession } = await import('../database.js')
  const coordinator = await getNativeCoordinator()
  const sessionId = await getThreadSession(threadId)
  if (!coordinator || !sessionId) {
    await refuse('The native runtime is not available right now.')
    return
  }
  const result = await getInteractionBridge().submitFromComponent({
    coordinator,
    sessionId,
    actorId: interaction.user.id,
    threadId,
    customId: interaction.customId,
    selected: interaction.isStringSelectMenu() ? interaction.values : undefined,
  })
  if (result.ok) {
    if (interaction.isRepliable()) {
      await interaction.update({ components: [] }).catch(() => undefined)
    }
    return
  }
  const code = (result.error as Error & { code?: string }).code ?? 'INTERACTION_FAILED'
  await refuse(
    code === 'COMPONENT_UNKNOWN' ||
      code === 'INTERACTION_GONE' ||
      code === 'INTERACTION_STALE' ||
      code === 'ANSWER_REJECTED'
      ? 'This native request is no longer active or the answer was rejected.'
      : `Native interaction failed (${code}).`,
  )
}
