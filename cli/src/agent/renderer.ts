// ZK-008 adaptation of the standalone slice renderer.ts onto Kimaki's
// formatter/split helpers: native outbox rows are formatted with the host
// formatPart (via a Part adapter), split with prepareThreadMessageChunks, and
// delivered as Discord message groups — new revisions edit the previous group
// in place (repeated tails replace, never append). Receipts describe the exact
// sent revision as the full message-id group; uncertain REST outcomes stay
// delivery-unknown and reconcile only through a verified lookup, which never
// authorizes a resend or a new native task. — ZCode 2026-09-18
import { createHash } from 'node:crypto'
import { integer, record, text } from './errors.js'
import type { AgentStore } from './store.js'
import type { DisplayPart } from './types.js'
import type { Part } from '@opencode-ai/sdk/v2'
import type { VerbosityLevel } from '../schema.js'
import { FILE_EDIT_PREFIX, formatPart, isEssentialToolName } from '../message-formatting.js'
import { DISCORD_MESSAGE_MAX_LENGTH, prepareThreadMessageChunks } from '../discord-utils.js'

export type DiscordDelivery = {
  threadId: string
  content: string
  nonce: string
  allowedMentions: { parse: never[] }
}

/** Where each expected chunk of a delivery should be provably observable. */
export type DeliveryProbe = {
  byNonce: Array<{ nonce: string; content: string; index: number }>
  byId: Array<{ id: string; content: string; index: number }>
}

export type RendererPorts = {
  /** Adapt to Kimaki's thread.send (silent flags, no mention parsing); do not build another bot. */
  send: (delivery: DiscordDelivery) => Promise<{ id: string }>
  edit: (delivery: DiscordDelivery & { messageId: string }) => Promise<void>
  delete: (threadId: string, messageId: string) => Promise<void>
  /**
   * Verified lookup over bounded recent history: return the ordered message-id
   * group when EVERY probe entry is observable with exactly the expected
   * content, null otherwise. Absence from a bounded search is not proof of
   * non-delivery — callers must not resend.
   */
  verify: (threadId: string, probe: DeliveryProbe) => Promise<{ ids: string[] } | null>
}

export function discordNonce(outboxId: string) {
  return createHash('sha256').update(outboxId).digest('hex').slice(0, 25)
}

// Running native tools carry their serialized input in the text tail; parse it
// best-effort so bash titles and tool summaries match the host formatter.
function nativeToolInput(part: DisplayPart): Record<string, unknown> {
  try {
    const value = JSON.parse(part.text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

// The SDK Part union carries per-tool state fields the native side does not
// model; the adapter only populates what formatPart reads.
function asHostPart(part: DisplayPart): Part {
  if (part.kind === 'text' || part.kind === 'reasoning') {
    return { type: part.kind, text: part.text } as Part
  }
  if (part.kind === 'file-change') {
    return {
      type: 'tool',
      tool: 'edit',
      state: { status: 'completed', input: {} },
    } as unknown as Part
  }
  return {
    type: 'tool',
    tool: part.toolName ?? 'tool',
    state: {
      status:
        part.state === 'error'
          ? 'error'
          : part.state === 'done' || part.state === 'cancelled'
            ? 'completed'
            : 'running',
      input: nativeToolInput(part),
    },
  } as unknown as Part
}

// Mirrors sendPartMessage's verbosity gate (thread-session-runtime): default
// hides thinking, read-only tools, and bash without side effects.
function visibleAtVerbosity(part: DisplayPart, verbosity: VerbosityLevel): boolean {
  if (verbosity === 'tools_and_text') {
    return true
  }
  if (part.kind === 'text' || part.kind === 'notice') {
    return true
  }
  if (verbosity === 'text_only') {
    return false
  }
  if (part.kind === 'reasoning') {
    return false
  }
  if (part.kind === 'file-change') {
    return true
  }
  if (!isEssentialToolName(part.toolName ?? '')) {
    return false
  }
  if (part.toolName === 'bash') {
    return nativeToolInput(part).hasSideEffect !== false
  }
  return true
}

function formatFileChange(part: DisplayPart): string {
  const line = part.text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line ? `${FILE_EDIT_PREFIX}${line}` : ''
}

export class OutboxRenderer {
  constructor(
    readonly store: AgentStore,
    readonly ports: RendererPorts,
    readonly options: {
      verbosity?: VerbosityLevel
      redact?: (s: string) => string
      maxLength?: number
    } = {},
  ) {}

  private chunksFor(part: DisplayPart): string[] {
    const verbosity = this.options.verbosity ?? 'text_and_essential_tools'
    if (!visibleAtVerbosity(part, verbosity)) {
      return []
    }
    const formatted =
      part.kind === 'file-change' ? formatFileChange(part) : formatPart(asHostPart(part))
    const content = (this.options.redact ?? ((s: string) => s))(formatted)
    if (!content.trim()) {
      return []
    }
    return prepareThreadMessageChunks(content, this.options.maxLength ?? DISCORD_MESSAGE_MAX_LENGTH)
  }

  /** #30: pass a sessionId to scope delivery to one session's rows. */
  async flush(sessionId?: string): Promise<void> {
    for (const row of await this.store.outbox(sessionId)) {
      const id = text(row.id)
      const threadId = text(row.thread_id)
      const revision = integer(row.content_revision)
      const part = record(JSON.parse(text(row.payload_json))) as DisplayPart
      const chunks = this.chunksFor(part)
      if (row.state === 'delivery-unknown') {
        await this.reconcile(id, threadId, text(row.display_part_id), revision, chunks)
        continue
      }
      // Selection and coalescing race (H01): claim only the revision read.
      if (!(await this.store.claimOutbox(id, revision))) {
        continue
      }
      if (chunks.length === 0) {
        await this.store.suppressOutbox(id)
        continue
      }
      const previous = await this.store.sentGroup(threadId, text(row.display_part_id), revision)
      try {
        const ids = previous ? [...previous] : []
        const editCount = Math.min(ids.length, chunks.length)
        for (let i = 0; i < editCount; i++) {
          await this.ports.edit({
            threadId,
            content: chunks[i]!,
            nonce: discordNonce(`${id}#${i}`),
            allowedMentions: { parse: [] },
            messageId: ids[i]!,
          })
        }
        for (const surplus of ids.splice(chunks.length)) {
          await this.ports.delete(threadId, surplus)
        }
        for (let i = editCount; i < chunks.length; i++) {
          ids.push(
            (
              await this.ports.send({
                threadId,
                content: chunks[i]!,
                nonce: discordNonce(`${id}#${i}`),
                allowedMentions: { parse: [] },
              })
            ).id,
          )
        }
        await this.store.receipt(id, ids.join(','))
      } catch {
        await this.store.receipt(id, null)
      }
    }
  }

  private async reconcile(
    id: string,
    threadId: string,
    displayPartId: string,
    revision: number,
    chunks: string[],
  ): Promise<void> {
    if (chunks.length === 0) {
      // Nothing further to deliver for this revision (verbosity changed after
      // the uncertain attempt); already-confirmed messages are left as-is.
      await this.store.suppressOutbox(id)
      return
    }
    const previous = await this.store.sentGroup(threadId, displayPartId, revision)
    const probe: DeliveryProbe = { byNonce: [], byId: [] }
    const editCount = previous ? Math.min(previous.length, chunks.length) : 0
    if (previous) {
      for (let i = 0; i < editCount; i++) {
        probe.byId.push({ id: previous[i]!, content: chunks[i]!, index: i })
      }
    }
    for (let i = editCount; i < chunks.length; i++) {
      probe.byNonce.push({ nonce: discordNonce(`${id}#${i}`), content: chunks[i]!, index: i })
    }
    const verified = await this.ports.verify(threadId, probe)
    if (verified) {
      await this.store.receipt(id, verified.ids.join(','))
    }
    // A miss from a bounded lookup is not proof of non-delivery: the row stays
    // delivery-unknown. Never resend, never start a native task from here.
  }
}
