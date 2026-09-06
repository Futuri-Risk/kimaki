// /keep command - Set how long this thread stays unarchived after the last
// message (Discord auto_archive_duration). Pure Discord-side operation: no
// session or project directory required.

import { MessageFlags, type ThreadChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

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

  const minutes = command.options.getInteger('length', true)

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  try {
    const thread = channel as ThreadChannel
    await thread.setAutoArchiveDuration(minutes, '/keep command')
    const choice = KEEP_CHOICES.find((c) => c.minutes === minutes)
    const label = choice ? choice.label : `${minutes} minutes`
    await command.editReply({
      content: `This thread will now auto-archive **${label}** after the last message.`,
    })
    logger.log(`[KEEP] Thread ${thread.id} auto_archive_duration -> ${minutes}`)
  } catch (error) {
    logger.error('[KEEP] Failed to set auto_archive_duration:', error)
    await command.editReply({
      content: `Failed to set thread archive duration: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}
