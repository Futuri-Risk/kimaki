// /rename command - Manually rename a thread, applying the {TAG} T#n: title
// convention (forge-ops#74). Deterministic when a ticket reference is found
// in recent messages (Gitea API when configured); cheap-LLM fallback otherwise.
// Manual-trigger only: kimaki's rename-respect (thread-session-runtime) locks
// any non-synced rename permanently, so one invocation per thread is enough.

import {
  ChannelType,
  MessageFlags,
  type ThreadChannel,
} from 'discord.js'
import { GoogleGenAI } from '@google/genai'
import type { CommandContext } from './types.js'
import { getGeminiApiKey } from '../database.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { PRESERVED_THREAD_PREFIXES } from '../session-handler/thread-session-runtime.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.RENAME)

const DISCORD_THREAD_NAME_MAX = 100
const GEMINI_TEXT_MODEL = 'gemini-3.6-flash'
const RENAME_TIMEOUT_MS = 5000
const MESSAGES_TO_SCAN = 30

export type TicketRef = {
  org: string | null
  repo: string
  number: number
}

const GITEA_ISSUE_URL_PATTERN =
  /([\w.-]+)\/([\w-]+)\/issues\/(\d{1,6})/
const TICKET_SHORTHAND_PATTERN =
  /(?<![\w/#])(?:([\w-]+)\/)?([a-z][a-z0-9-]{0,38})#(\d{1,6})(?![\d])/

/**
 * Extract a ticket reference from one message text.
 * Matches `owner/repo#n`, `repo#n`, and Gitea issue URLs.
 * The `T#n` tag form is deliberately excluded (lowercase-only repo match),
 * so already-conventional thread names don't match themselves.
 */
export function extractTicketRef(text: string): TicketRef | null {
  const urlMatch = GITEA_ISSUE_URL_PATTERN.exec(text)
  if (urlMatch) {
    const [, org, repo, number] = urlMatch
    if (org && repo && number) {
      return { org, repo, number: Number(number) }
    }
  }
  const shortMatch = TICKET_SHORTHAND_PATTERN.exec(text)
  if (shortMatch) {
    const [, org, repo, number] = shortMatch
    if (repo && number) {
      return { org: org ?? null, repo, number: Number(number) }
    }
  }
  return null
}

/** Build the convention name: `{TAG} T#n: {title}`, capped at 100 chars. */
export function buildThreadName({
  tag,
  number,
  title,
}: {
  tag: string
  number: number
  title: string
}): string {
  const cleanTitle = title.replace(/\s+/g, ' ').trim()
  return `${tag} T#${number}: ${cleanTitle}`.slice(0, DISCORD_THREAD_NAME_MAX)
}

/** Keep prefixes like `⬦ ` / `btw: ` / `Fork: ` across manual renames. */
export function preservePrefix(currentName: string, newName: string): string {
  const prefix =
    PRESERVED_THREAD_PREFIXES.find((p) => currentName.startsWith(p)) ?? ''
  return `${prefix}${newName}`.slice(0, DISCORD_THREAD_NAME_MAX)
}

async function fetchIssueTitle(ref: TicketRef): Promise<string | null> {
  const base = process.env.GITEA_URL ?? 'http://127.0.0.1:3000'
  const org = ref.org ?? 'projects'
  const url = `${base}/api/v1/repos/${org}/${ref.repo}/issues/${ref.number}`
  const headers: Record<string, string> = {}
  const token = process.env.GITEA_TOKEN
  if (token) {
    headers.Authorization = `token ${token}`
  }
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(RENAME_TIMEOUT_MS),
    })
    if (!response.ok) {
      logger.warn(
        `[RENAME] Gitea API ${response.status} for ${org}/${ref.repo}#${ref.number}`,
      )
      return null
    }
    const data = (await response.json()) as { title?: unknown }
    return typeof data.title === 'string' && data.title.trim()
      ? data.title.trim()
      : null
  } catch (error) {
    logger.warn(
      `[RENAME] Gitea API fetch failed for ${org}/${ref.repo}#${ref.number}:`,
      error,
    )
    return null
  }
}

async function generateNameWithGemini({
  appId,
  transcript,
  ref,
}: {
  appId: string
  transcript: string
  ref: TicketRef | null
}): Promise<string | null> {
  const dbKey = await getGeminiApiKey(appId).catch(() => null)
  const apiKey = dbKey ?? process.env.GEMINI_API_KEY ?? null
  if (!apiKey) {
    return null
  }
  const ai = new GoogleGenAI({ apiKey })
  const systemInstruction = ref
    ? `You rename a Discord thread about ticket ${ref.repo}#${ref.number}. Reply with ONLY the new thread name in the exact format: ${ref.repo} T#${ref.number}: <short descriptive title under 50 characters>. No quotes, no markdown, no explanation.`
    : 'You rename a Discord thread based on its recent messages. Reply with ONLY a clean descriptive title of at most 8 words. No quotes, no markdown, no explanation.'
  try {
    const response = await ai.models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: transcript.slice(-6000),
      config: {
        systemInstruction,
        temperature: 0.2,
        maxOutputTokens: 60,
      },
    })
    const text = response.text
    if (!text) {
      return null
    }
    const cleaned = text
      .replace(/[\r\n]+/g, ' ')
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned) {
      return null
    }
    if (
      ref &&
      !cleaned.toLowerCase().startsWith(`${ref.repo} t#${ref.number}:`)
    ) {
      // Model ignored the format — force it deterministically.
      return buildThreadName({
        tag: ref.repo,
        number: ref.number,
        title: cleaned,
      })
    }
    return cleaned.slice(0, DISCORD_THREAD_NAME_MAX)
  } catch (error) {
    logger.warn('[RENAME] Gemini naming failed:', error)
    return null
  }
}

export async function handleRenameCommand({
  command,
  appId,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  if (!isThread) {
    await command.reply({
      content: '/rename can only be used inside a thread',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: MessageFlags.Ephemeral })
  const thread = channel as ThreadChannel

  const explicitName = command.options.getString('name')?.trim() ?? null
  let newName = explicitName
  let source = 'explicit'

  if (!newName) {
    const fetched = await thread.messages
      .fetch({ limit: MESSAGES_TO_SCAN })
      .catch((e) => {
        logger.warn('[RENAME] Failed to fetch thread messages:', e)
        return null
      })
    const ordered = fetched
      ? [...fetched.values()].sort(
          (a, b) => b.createdTimestamp - a.createdTimestamp,
        )
      : []
    const ref = extractTicketRef(
      ordered.find((m) => m.content && extractTicketRef(m.content))?.content ??
        '',
    )

    if (ref) {
      const title = await fetchIssueTitle(ref)
      if (title) {
        newName = buildThreadName({
          tag: ref.repo,
          number: ref.number,
          title,
        })
        source = `ticket ${ref.repo}#${ref.number}`
      }
    }

    if (!newName) {
      const transcript = ordered
        .filter((m) => m.content)
        .map((m) => `${m.author.username}: ${m.content.slice(0, 300)}`)
        .join('\n')
      newName = await generateNameWithGemini({ appId, transcript, ref })
      source = ref
        ? `gemini + ${ref.repo}#${ref.number}`
        : 'gemini'
    }
  }

  if (!newName) {
    await command.editReply(
      'Could not generate a name (no ticket reference found and no Gemini key configured — set one with /gemini-apikey). Use `/rename name:<text>` to set one directly.',
    )
    return
  }

  const finalName = preservePrefix(thread.name, newName)
  if (finalName === thread.name) {
    await command.editReply(`Thread is already named: **${finalName}**`)
    return
  }

  const renameResult = await Promise.race([
    thread.setName(finalName).then(
      () => 'ok' as const,
      (e: unknown) => new Error('Rename failed', { cause: e }),
    ),
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), RENAME_TIMEOUT_MS)
    }),
  ])

  if (renameResult === 'timeout') {
    await command.editReply(
      'Rename timed out — Discord rate-limits thread renames (~2 per 10 minutes). Try again in a few minutes.',
    )
    return
  }
  if (renameResult instanceof Error) {
    logger.warn('[RENAME] setName failed:', renameResult)
    await command.editReply(
      'Rename failed — likely a Discord rate limit (~2 per 10 minutes). Try again in a few minutes, or use `/rename name:<text>`.',
    )
    return
  }

  logger.log(`[RENAME] Renamed thread ${thread.id} to "${finalName}" (${source})`)
  await command.editReply(
    `Renamed:\n**${thread.name}** → **${finalName}**\n_(source: ${source})_`,
  )
}
