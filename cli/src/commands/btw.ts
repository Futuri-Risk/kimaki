// /btw command - Fork the current session with full context and send a new prompt.
// Unlike /fork, this does not replay past messages in Discord. It just creates
// a new thread, forks the entire session (no messageID), and immediately
// dispatches the user's prompt so the forked session starts working right away.

import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type ThreadChannel,
  MessageFlags,
} from 'discord.js'
import crypto from 'node:crypto'
import {
  getThreadSession,
  setThreadSession,
  getThreadWorktreeOrWorkspace,
  createPendingWorkspace,
  setWorkspaceReady,
} from '../database.js'
import { resolveWorkingDirectory, resolveTextChannel, sendThreadMessage } from '../discord-utils.js'
import { getOrCreateRuntime } from '../session-handler/thread-session-runtime.js'
import { createLogger, LogPrefix } from '../logger.js'
import type { CommandContext } from './types.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { copyCurrentSessionModel } from './model.js'
import type { DiscordFileAttachment } from '../message-formatting.js'
import { resolveBackend } from '../agent/registry.js'
import { lookupBackendSidecar } from '../agent/host-sidecar.js'
import { getNativeCoordinator } from '../agent/host-coordinator.js'
import { NATIVE_FORK_CAPABILITY } from '../agent/native-profile.js'

const logger = createLogger(LogPrefix.FORK)

/**
 * ZK-011: conversation-only native /btw. The V4 forkAssistant control runs
 * BEFORE the Discord thread exists (no orphan threads); the child session is
 * persisted orphan-bound and activates ONLY through an explicit controller
 * binding to the new thread. No legacy filesystem restore is ever used, and
 * the capability stays refused until a certified profile enables it (ZK-016).
 * Returns 'not-native' so OpenCode-backed threads keep the existing flow.
 */
export async function forkSessionToNativeBtwThread({
  sourceThread,
  projectDirectory,
  prompt,
  modelPrompt = prompt,
  userId,
  username,
  appId,
  agent,
  images,
}: {
  sourceThread: ThreadChannel
  projectDirectory: string
  prompt: string
  modelPrompt?: string
  userId: string
  username: string
  appId: string | undefined
  agent?: string
  images?: DiscordFileAttachment[]
}): Promise<{ thread: ThreadChannel; forkedSessionId: string } | Error | 'not-native'> {
  const sessionId = await getThreadSession(sourceThread.id)
  if (!sessionId) {
    return 'not-native'
  }
  const backend = await resolveBackend(lookupBackendSidecar, sessionId)
  if (backend !== 'zcode') {
    return 'not-native'
  }
  const coordinator = await getNativeCoordinator()
  if (!coordinator) {
    return new Error('The native runtime is not available right now.')
  }
  if (coordinator.backend.profile.preferences[NATIVE_FORK_CAPABILITY] !== true) {
    return new Error(
      '/btw on native sessions requires the certified fork capability (ZK-016). Refusing instead of guessing a fork point.',
    )
  }
  if (images && images.length > 0) {
    return new Error('Attachments are not supported on native forks yet.')
  }
  const forked = await coordinator.ingest({
    sessionId,
    threadId: sourceThread.id,
    actorId: userId,
    source: 'discord',
    sourceId: `${userId}:btw:${crypto.randomUUID()}`,
    kind: 'fork',
    text: '',
  })
  if (!forked.ok) {
    return new Error(`Native fork refused (${forked.error.code}): ${forked.error.message}`)
  }
  await coordinator.settle()
  const forkOp = await coordinator.store.operation(forked.value.id)
  if (forkOp?.state !== 'completed') {
    return new Error(
      `Native fork ended in state \`${forkOp?.state ?? 'unknown'}\`; nothing was created.`,
    )
  }
  const child = await coordinator.store.latestChildSession(sessionId)
  if (!child || !child.nativeSessionId) {
    return new Error('Native fork completed without a persisted child session.')
  }
  const textChannel = await resolveTextChannel(sourceThread)
  if (!textChannel) {
    return new Error('Could not resolve parent text channel')
  }
  const channelId = sourceThread.parentId || sourceThread.id
  const thread = await textChannel.threads.create({
    name: `btw: ${prompt}`.slice(0, 100),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: `btw native fork from session ${sessionId}`,
  })
  // Routing before user-visible work, then EXPLICIT activation: the fork RPC's
  // returned native child id is the readback; controller binding is the only
  // path out of orphan-bound.
  await setThreadSession(thread.id, child.id)
  await coordinator.store.bindController(child.id, thread.id)

  const sourceThreadLink = `<#${sourceThread.id}>`
  await Promise.all([
    thread.members.add(userId).catch((error) => {
      logger.warn('Could not add fork member:', error)
    }),
    sendThreadMessage(
      thread,
      `Reusing context from ${sourceThreadLink} to answer prompt...\n${prompt}`,
    ),
  ])
  logger.log(
    `Created native btw fork session ${child.id} (native ${child.nativeSessionId}) in thread ${thread.id} from source thread ${sourceThread.id} (session ${sessionId})`,
  )
  const wrappedPrompt = [
    `The user asked a side question while you were working on another task.`,
    `This is a forked session whose ONLY goal is to answer this question.`,
    `Do NOT continue, resume, or reference the previous task. Only answer the question below.`,
    ``,
    `Parent session: ${sessionId} (thread <#${sourceThread.id}>)`,
    `Do NOT send messages to the parent session unless the user explicitly asks you to.`,
    ``,
    modelPrompt,
  ].join('\n')
  const dispatch = await coordinator.ingest({
    sessionId: child.id,
    threadId: thread.id,
    actorId: userId,
    source: 'discord',
    sourceId: `${userId}:btw-prompt:${crypto.randomUUID()}`,
    kind: 'prompt',
    text: wrappedPrompt,
  })
  if (!dispatch.ok) {
    logger.error('Native fork dispatch failed:', dispatch.error.toJSON())
    await sendThreadMessage(
      thread,
      'Could not dispatch the request to the native runtime. Send your request again in this thread.',
    )
  }
  return {
    thread,
    forkedSessionId: child.id,
  }
}

export async function forkSessionToBtwThread({
  sourceThread,
  projectDirectory,
  sdkDirectory,
  prompt,
  modelPrompt = prompt,
  userId,
  username,
  appId,
  agent,
  images,
}: {
  sourceThread: ThreadChannel
  projectDirectory: string
  /** Worktree directory when forking from a worktree thread, otherwise same as projectDirectory */
  sdkDirectory: string
  prompt: string
  modelPrompt?: string
  userId: string
  username: string
  appId: string | undefined
  agent?: string
  images?: DiscordFileAttachment[]
}): Promise<{ thread: ThreadChannel; forkedSessionId: string } | Error> {
  // ZK-011: native sessions take the conversation-only fork path; OpenCode
  // threads keep the flow below untouched.
  const native = await forkSessionToNativeBtwThread({
    sourceThread,
    projectDirectory,
    prompt,
    modelPrompt,
    userId,
    username,
    appId,
    agent,
    images,
  })
  if (native !== 'not-native') {
    return native
  }

  // Parallelize: session lookup + opencode init + parent channel resolve are independent
  const [sessionId, getClientResult, textChannel] = await Promise.all([
    getThreadSession(sourceThread.id),
    initializeOpencodeForDirectory(projectDirectory),
    resolveTextChannel(sourceThread),
  ])

  if (!sessionId) {
    return new Error('No active session in this thread')
  }
  if (getClientResult instanceof Error) {
    return new Error(`Failed to fork session: ${getClientResult.message}`, {
      cause: getClientResult,
    })
  }
  if (!textChannel) {
    return new Error('Could not resolve parent text channel')
  }

  // Fork must succeed before creating the Discord thread to avoid orphan threads
  const forkResponse = await getClientResult().session.fork({
    sessionID: sessionId,
    directory: sdkDirectory,
  })
  if (!forkResponse.data) {
    return new Error('Failed to fork session')
  }
  const forkedSession = forkResponse.data
  const channelId = sourceThread.parentId || sourceThread.id

  await copyCurrentSessionModel({
    sourceSessionId: sessionId,
    targetSessionId: forkedSession.id,
    channelId,
    appId,
    getClient: getClientResult,
    directory: sdkDirectory,
  })

  const thread = await textChannel.threads.create({
    name: `btw: ${prompt}`.slice(0, 100),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: `btw fork from session ${sessionId}`,
  })

  // DB mapping must complete before user-visible actions so the thread is routable
  await setThreadSession(thread.id, forkedSession.id)
  const sourceWorkspace = await getThreadWorktreeOrWorkspace(sourceThread.id)
  if (sourceWorkspace?.status === 'ready' && sourceWorkspace.workspace_directory) {
    await createPendingWorkspace({
      threadId: thread.id,
      workspaceType: sourceWorkspace.workspace_type,
      workspaceName: sourceWorkspace.workspace_name ?? '',
      projectDirectory,
    })
    await setWorkspaceReady({
      threadId: thread.id,
      workspaceId: sourceWorkspace.workspace_id ?? undefined,
      workspaceDirectory: sourceWorkspace.workspace_directory,
    })
  }

  // Parallelize: member add and status message are independent best-effort actions
  const sourceThreadLink = `<#${sourceThread.id}>`
  await Promise.all([
    thread.members.add(userId).catch((error) => {
      logger.warn('Could not add fork member:', error)
    }),
    sendThreadMessage(
      thread,
      `Reusing context from ${sourceThreadLink} to answer prompt...\n${prompt}`,
    ),
  ])

  logger.log(
    `Created btw fork session ${forkedSession.id} in thread ${thread.id} from source thread ${sourceThread.id} (session ${sessionId})`,
  )

  // Parent context stays in the user prompt only. Do NOT pass parentSessionId
  // into enqueueIncoming: that would inject a parent block into the system
  // message and bust prompt cache shared with the parent session.
  const wrappedPrompt = [
    `The user asked a side question while you were working on another task.`,
    `This is a forked session whose ONLY goal is to answer this question.`,
    `Do NOT continue, resume, or reference the previous task. Only answer the question below.`,
    ``,
    `Parent session: ${sessionId} (thread <#${sourceThread.id}>)`,
    `Do NOT send messages to the parent session unless the user explicitly asks you to.`,
    ``,
    modelPrompt,
  ].join('\n')

  const runtime = getOrCreateRuntime({
    threadId: thread.id,
    thread,
    projectDirectory,
    sdkDirectory,
    channelId,
    appId,
    sessionId: forkedSession.id,
  })
  await runtime
    .enqueueIncoming({
      prompt: wrappedPrompt,
      agent,
      images,
      userId,
      username,
      appId,
      mode: 'opencode',
    })
    .catch(async (error) => {
      logger.error('Fork dispatch failed:', error)
      await sendThreadMessage(
        thread,
        'Could not send the request to OpenCode. Send your request again in this thread.',
      )
    })

  return {
    thread,
    forkedSessionId: forkedSession.id,
  }
}

export async function handleBtwCommand({ command, appId }: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (
    channel.type !== ChannelType.PublicThread &&
    channel.type !== ChannelType.PrivateThread &&
    channel.type !== ChannelType.AnnouncementThread
  ) {
    await command.reply({
      content: 'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const threadChannel = channel

  const prompt = command.options.getString('prompt', true)

  const resolved = await resolveWorkingDirectory({
    channel: threadChannel,
  })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const { projectDirectory, workingDirectory } = resolved

  await command.deferReply({ flags: MessageFlags.Ephemeral })

  try {
    const result = await forkSessionToBtwThread({
      sourceThread: threadChannel,
      projectDirectory,
      sdkDirectory: workingDirectory,
      prompt,
      userId: command.user.id,
      username: command.user.displayName,
      appId,
    })

    if (result instanceof Error) {
      await command.editReply(result.message)
      return
    }

    await command.editReply(`Session forked! Continue in ${result.thread.toString()}`)
  } catch (error) {
    logger.error('Error in /btw:', error)
    await command.editReply(
      `Failed to fork session: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
