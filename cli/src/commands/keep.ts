// /keep command - Set how long this thread stays unarchived after the last
// message (Discord auto_archive_duration). Pure Discord-side operation: no
// session or project directory required.

import { MessageFlags, type ThreadChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import {
  deleteThreadKeepalive,
  getThreadKeepalive,
  setThreadKeepalive,
} from '../database.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { runThreadKeepaliveOperation } from '../thread-keepalive.js'

const logger = createLogger(LogPrefix.INTERACTION)

// Discord only accepts these auto_archive_duration values (in minutes).
export const KEEP_CHOICES = [
  { label: '1 hour', minutes: 60 },
  { label: '24 hours', minutes: 1440 },
  { label: '3 days', minutes: 4320 },
  { label: '7 days', minutes: 10080 },
] as const

export async function handleKeepCommand({
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

  if (!channel.isThread()) {
    await command.reply({
      content: '/keep can only be used inside a thread',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const requestedMinutes = command.options.getInteger('length')
  const renew = command.options.getString('renew')

  if (requestedMinutes === null && renew === null) {
    await command.reply({
      content: 'Choose a `length`, set `renew` on, or set `renew` off',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  try {
    const thread = channel as ThreadChannel
    const result = await runThreadKeepaliveOperation(thread.id, async () => {
      if (requestedMinutes !== null) {
        await thread.setAutoArchiveDuration(requestedMinutes, '/keep command')
      }

      if (renew === 'off') {
        const disabled = await deleteThreadKeepalive(thread.id)
        return { disabled, renewalEnabled: false }
      }

      const existingKeepalive = await getThreadKeepalive(thread.id)
      const renewalEnabled = renew === 'on' || existingKeepalive !== null
      const durationMinutes = requestedMinutes
        ?? thread.autoArchiveDuration
        ?? existingKeepalive?.duration_minutes
        ?? 1440
      if (renewalEnabled) {
        await setThreadKeepalive({
          threadId: thread.id,
          appId,
          durationMinutes,
        })
      }
      return { disabled: false, renewalEnabled }
    })

    if (renew === 'off' && requestedMinutes === null) {
      await command.editReply({
        content: result.disabled
          ? 'Automatic renewal is now **off** for this thread.'
          : 'Automatic renewal was already **off** for this thread.',
      })
      return
    }

    const minutes = requestedMinutes ?? thread.autoArchiveDuration ?? 1440
    const choice = KEEP_CHOICES.find((c) => c.minutes === minutes)
    const label = choice ? choice.label : `${minutes} minutes`
    const renewSuffix = result.renewalEnabled
      ? ' Automatic renewal is **on** until you run `/keep renew:off`.'
      : renew === 'off'
        ? ' Automatic renewal is **off**.'
        : ''
    await command.editReply({
      content: `This thread will now auto-archive **${label}** after the last message.${renewSuffix}`,
    })
    logger.log(`[KEEP] Thread ${thread.id} auto_archive_duration -> ${minutes}`)
  } catch (error) {
    logger.error('[KEEP] Failed to set auto_archive_duration:', error)
    await command.editReply({
      content: `Failed to set thread archive duration: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}
