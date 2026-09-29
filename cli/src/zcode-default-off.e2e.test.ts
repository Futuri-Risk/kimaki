// ZK-015 default-off comparison e2e: with NO native profile registered (the
// shipping default), the bot behaves exactly as the OpenCode baseline — a
// standard deterministic-provider turn through the real bot loop — and the
// native coordinator stays null. This is the same suite machinery every
// queue-advanced e2e uses, so an unchanged pass here IS the baseline
// comparison. — ZCode 2026-09-18

import { describe, test, expect } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { waitForBotMessageContaining, waitForFooterMessage } from './test-utils.js'
import { getNativeCoordinator } from './agent/host-coordinator.js'

const TEXT_CHANNEL_ID = '970000000000000002'

const e2eTest = describe

e2eTest('zcode default-off: bot is the OpenCode baseline', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'zcode-default-off-e2e',
    dirName: 'zcode-default-off-e2e',
    username: 'zcode-default-off-tester',
  })

  test(
    'a standard turn replies through OpenCode unchanged and the native runtime stays off',
    { timeout: 20_000 },
    async () => {
      // Default-off means default-off: no coordinator exists at all.
      expect(await getNativeCoordinator()).toBeNull()

      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: default-off-hello',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 8_000,
        predicate: (t) => Boolean(t.name?.includes('default-off-hello')),
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'ok',
        timeout: 8_000,
      })

      // Footer lands as it always does on the OpenCode path.
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 8_000,
        afterMessageIncludes: 'ok',
      })

      // Still off after a full turn.
      expect(await getNativeCoordinator()).toBeNull()
    },
  )
})
