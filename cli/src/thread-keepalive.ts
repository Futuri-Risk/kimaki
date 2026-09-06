import {
  DiscordAPIError,
  RESTJSONErrorCodes,
  type Client,
  type ThreadChannel,
} from 'discord.js'
import {
  deleteThreadKeepalive,
  getThreadKeepalive,
  listThreadKeepalives,
  type ThreadKeepalive,
} from './database.js'
import { createLogger, LogPrefix } from './logger.js'
import { notifyError } from './sentry.js'

const logger = createLogger(LogPrefix.DISCORD)

export const THREAD_KEEPALIVE_POLL_MS = 5 * 60 * 1000
const MAX_RENEWAL_MARGIN_MS = 15 * 60 * 1000

let keepaliveInterval: ReturnType<typeof setInterval> | null = null
let activeSweep: Promise<void> | null = null
let stopped = true
const threadOperations = new Map<string, Promise<unknown>>()

export async function runThreadKeepaliveOperation<T>(
  threadId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = threadOperations.get(threadId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  threadOperations.set(threadId, current)
  try {
    return await current
  } finally {
    if (threadOperations.get(threadId) === current) {
      threadOperations.delete(threadId)
    }
  }
}

export function shouldRenewThreadKeepalive({
  archiveTimestamp,
  durationMinutes,
  now = Date.now(),
}: {
  archiveTimestamp: number | null
  durationMinutes: number
  now?: number
}): boolean {
  if (archiveTimestamp === null) return true
  const durationMs = durationMinutes * 60 * 1000
  const renewalMarginMs = Math.min(MAX_RENEWAL_MARGIN_MS, durationMs / 4)
  return archiveTimestamp + durationMs - now <= renewalMarginMs
}

export async function renewKeptThread({
  discordClient,
  keepalive,
  now = Date.now(),
  isCancelled = () => false,
}: {
  discordClient: Client<true>
  keepalive: ThreadKeepalive
  now?: number
  isCancelled?: () => boolean
}): Promise<void> {
  await runThreadKeepaliveOperation(keepalive.thread_id, async () => {
    let channel
    try {
      channel = await discordClient.channels.fetch(keepalive.thread_id)
    } catch (error) {
      if (
        error instanceof DiscordAPIError
        && error.code === RESTJSONErrorCodes.UnknownChannel
      ) {
        await deleteThreadKeepalive(keepalive.thread_id)
        logger.log(`[KEEP] Removed deleted thread ${keepalive.thread_id}`)
        return
      }
      throw error
    }

    if (!channel?.isThread()) {
      await deleteThreadKeepalive(keepalive.thread_id)
      logger.warn(`[KEEP] Removed unavailable thread ${keepalive.thread_id}`)
      return
    }

    const currentKeepalive = await getThreadKeepalive(keepalive.thread_id)
    if (!currentKeepalive || isCancelled()) return

    let thread = channel as ThreadChannel
    if (thread.autoArchiveDuration !== currentKeepalive.duration_minutes) {
      thread = await thread.setAutoArchiveDuration(
        currentKeepalive.duration_minutes,
        '/keep automatic renewal',
      )
    }

    if (thread.archived) {
      if (isCancelled()) return
      await thread.setArchived(false, '/keep automatic renewal')
      logger.log(`[KEEP] Unarchived kept thread ${thread.id}`)
      return
    }

    if (!shouldRenewThreadKeepalive({
      archiveTimestamp: thread.archiveTimestamp,
      durationMinutes: currentKeepalive.duration_minutes,
      now,
    })) {
      return
    }

    if (isCancelled()) return
    const archived = await thread.setArchived(true, '/keep automatic renewal')
    await archived.setArchived(false, '/keep automatic renewal')
    logger.log(`[KEEP] Renewed thread ${thread.id}`)
  })
}

export function startThreadKeepalive({
  discordClient,
  appId,
}: {
  discordClient: Client<true>
  appId: string
}): void {
  if (keepaliveInterval) return
  stopped = false

  const sweep = async () => {
    if (stopped) return
    const keepalives = await listThreadKeepalives(appId)
    for (const keepalive of keepalives) {
      if (stopped) break
      await renewKeptThread({
        discordClient,
        keepalive,
        isCancelled: () => stopped,
      }).catch((error) => {
        const wrapped = new Error(
          `Failed to renew kept thread ${keepalive.thread_id}`,
          { cause: error },
        )
        logger.warn(`[KEEP] ${wrapped.message}`)
        void notifyError(wrapped, 'Thread keepalive renewal failed')
      })
    }
  }

  const runSweep = () => {
    if (activeSweep || stopped) return
    activeSweep = sweep().finally(() => {
      activeSweep = null
    })
  }

  runSweep()
  keepaliveInterval = setInterval(runSweep, THREAD_KEEPALIVE_POLL_MS)
}

export async function stopThreadKeepalive(): Promise<void> {
  stopped = true
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval)
    keepaliveInterval = null
  }
  await activeSweep
  activeSweep = null
}
