// Tests for /keep command helpers.

import { describe, expect, test, vi } from 'vitest'
import type { Client } from 'discord.js'
import crypto from 'node:crypto'
import { KEEP_CHOICES } from './keep.js'
import {
  renewKeptThread,
  shouldRenewThreadKeepalive,
} from '../thread-keepalive.js'
import {
  deleteThreadKeepalive,
  getThreadKeepalive,
  listThreadKeepalives,
  setThreadKeepalive,
} from '../database.js'

describe('KEEP_CHOICES', () => {
  test('matches the auto_archive_duration values Discord accepts', () => {
    // https://discord.com/developers/docs/resources/channel#modify-channel
    const validDurations = [60, 1440, 4320, 10080]
    expect(KEEP_CHOICES.map((choice) => choice.minutes)).toEqual(
      validDurations,
    )
  })

  test('has unique labels', () => {
    const labels = KEEP_CHOICES.map((choice) => choice.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('shouldRenewThreadKeepalive', () => {
  const minute = 60 * 1000

  test('waits until a thread is within the renewal margin', () => {
    expect(shouldRenewThreadKeepalive({
      archiveTimestamp: 0,
      durationMinutes: 60,
      now: 44 * minute,
    })).toBe(false)

    expect(shouldRenewThreadKeepalive({
      archiveTimestamp: 0,
      durationMinutes: 60,
      now: 45 * minute,
    })).toBe(true)
  })

  test('renews when Discord provides no archive timestamp', () => {
    expect(shouldRenewThreadKeepalive({
      archiveTimestamp: null,
      durationMinutes: 10080,
    })).toBe(true)
  })
})

describe('thread keepalive persistence', () => {
  test('upserts, lists, and disables renewal by thread', async () => {
    const threadId = `keep-test-${crypto.randomUUID()}`
    const appId = `app-${crypto.randomUUID()}`

    await setThreadKeepalive({
      threadId,
      appId,
      durationMinutes: 1440,
    })
    await setThreadKeepalive({
      threadId,
      appId,
      durationMinutes: 10080,
    })

    expect(await getThreadKeepalive(threadId)).toMatchObject({
      thread_id: threadId,
      app_id: appId,
      duration_minutes: 10080,
    })
    expect(await listThreadKeepalives(appId)).toHaveLength(1)
    expect(await deleteThreadKeepalive(threadId)).toBe(true)
    expect(await getThreadKeepalive(threadId)).toBeNull()
  })
})

describe('renewKeptThread', () => {
  test('archives and unarchives a due thread without sending a message', async () => {
    const threadId = `keep-renew-${crypto.randomUUID()}`
    const appId = `app-${crypto.randomUUID()}`
    const setUnarchived = vi.fn().mockResolvedValue(undefined)
    const archivedThread = { setArchived: setUnarchived }
    const setArchived = vi.fn().mockResolvedValue(archivedThread)
    const thread = {
      id: threadId,
      isThread: () => true,
      archived: false,
      archiveTimestamp: 0,
      autoArchiveDuration: 60,
      setArchived,
      setAutoArchiveDuration: vi.fn(),
    }
    const discordClient = {
      channels: { fetch: vi.fn().mockResolvedValue(thread) },
    } as unknown as Client<true>

    await setThreadKeepalive({ threadId, appId, durationMinutes: 60 })
    const keepalive = await getThreadKeepalive(threadId)
    expect(keepalive).not.toBeNull()

    await renewKeptThread({
      discordClient,
      keepalive: keepalive!,
      now: 45 * 60 * 1000,
    })

    expect(setArchived).toHaveBeenCalledWith(true, '/keep automatic renewal')
    expect(setUnarchived).toHaveBeenCalledWith(false, '/keep automatic renewal')
    await deleteThreadKeepalive(threadId)
  })

  test('does not mutate Discord after cancellation', async () => {
    const threadId = `keep-cancel-${crypto.randomUUID()}`
    const appId = `app-${crypto.randomUUID()}`
    const setArchived = vi.fn()
    const thread = {
      id: threadId,
      isThread: () => true,
      archived: false,
      archiveTimestamp: 0,
      autoArchiveDuration: 60,
      setArchived,
      setAutoArchiveDuration: vi.fn(),
    }
    const discordClient = {
      channels: { fetch: vi.fn().mockResolvedValue(thread) },
    } as unknown as Client<true>

    await setThreadKeepalive({ threadId, appId, durationMinutes: 60 })
    const keepalive = await getThreadKeepalive(threadId)

    await renewKeptThread({
      discordClient,
      keepalive: keepalive!,
      now: 45 * 60 * 1000,
      isCancelled: () => true,
    })

    expect(setArchived).not.toHaveBeenCalled()
    await deleteThreadKeepalive(threadId)
  })
})
