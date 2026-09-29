// ZK-015 native-chain e2e: the REAL bot loop + DigitalDiscord twin + spawned
// SYNTHETIC fake-app-server through the plain-spawn fixture launcher (owned
// launch stays PLATFORM_UNCERTIFIED on win32 by design; coordinator-behavior
// scenarios target the backend contract, not process supervision). Proves the
// full chain — Discord message → thread intent → zc: session → coordinator
// admission → fake native server → projector → outbox renderer → Discord text —
// with ZERO OpenCode initialization on native routes, and restart resuming the
// same native session id. — ZCode 2026-09-18

import { beforeAll, afterAll, test, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'

// Zero-OC spy: every initializeOpencodeForDirectory call is counted; the whole
// suite must finish with zero. (Delegates to the real implementation so any
// legitimate OpenCode use elsewhere would still work — and be VISIBLE.)
const opencodeInits: string[] = []
vi.mock('./opencode.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    initializeOpencodeForDirectory: async (...args: unknown[]) => {
      opencodeInits.push(String(args[0]))
      return (actual['initializeOpencodeForDirectory'] as (...a: unknown[]) => unknown)(...args)
    },
  }
})

import { setDataDir } from './config.js'
import { store } from './store.js'
import { setBotToken, initDatabase, closeDatabase, setChannelDirectory } from './database.js'
import { startDiscordBot } from './discord-bot.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { initTestGitRepo } from './test-utils.js'
import { fakeCodec } from './agent/fixtures/fake-codec.js'
import { registerNativeProfile, syntheticProfile } from './agent/native-profile.js'
import { getNativeCoordinator, resetNativeCoordinator } from './agent/host-coordinator.js'
import { setNativeRuntimeLauncherForTests } from './agent/host-coordinator.js'
import { plainSpawnLauncher } from './agent/zcode-backend.js'
import { fileHash } from './agent/native/process.js'
import { waitForBotMessageContaining } from './test-utils.js'

const TEST_USER_ID = '535922349652836367'
const CHANNEL_ID = '960000000000000001'

const fixture = new URL('./agent/fixtures/fake-app-server.mjs', import.meta.url).pathname
  // Windows URL pathname keeps a leading slash: strip it for an absolute path.
  .replace(/^\/([A-Za-z]:)/, '$1')

type NativeState = {
  creates: number
  resumes: number
  sends: Array<{ sessionId: string; content: string }>
}

const ctx = {
  discord: undefined as unknown as DigitalDiscord,
  botClient: undefined as unknown as Client,
  root: '',
  nativeHome: '',
  projectDirectory: '',
  previousVerbosity: null as string | null,
  nativeThreadId: undefined as string | undefined,
}

beforeAll(async () => {
  // Unique run root per boot: the fake app-server persists its state file,
  // and stale state (or a live child from an aborted run holding handles)
  // would bleed into create/send counts or block cleanup on Windows.
  const root = path.resolve(process.cwd(), 'tmp', `zcode-native-e2e-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  const projectDirectory = path.join(root, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })
  initTestGitRepo(projectDirectory)
  const nativeHome = path.join(root, 'native-home')
  fs.mkdirSync(nativeHome, { recursive: true })
  Object.assign(ctx, { root, nativeHome, projectDirectory })

  process.env['KIMAKI_LOCK_PORT'] = '52777'
  setDataDir(dataDir)
  ctx.previousVerbosity = store.getState().defaultVerbosity
  store.setState({ defaultVerbosity: 'tools_and_text' })

  ctx.discord = new DigitalDiscord({
    guild: { name: 'zcode-native Guild', ownerId: TEST_USER_ID },
    channels: [{ id: CHANNEL_ID, name: 'zcode-native', type: ChannelType.GuildText }],
    users: [{ id: TEST_USER_ID, username: 'zcode-native-tester' }],
    dbUrl: `file:${path.join(dataDir, 'digital-discord.db')}`,
  })
  await ctx.discord.start()

  const hrana = await startHranaServer({ dbPath: path.join(dataDir, 'discord-sessions.db') })
  if (hrana instanceof Error) {
    throw hrana
  }
  process.env['KIMAKI_DB_URL'] = hrana
  await initDatabase()
  await setBotToken(ctx.discord.botUserId, ctx.discord.botToken)
  await setChannelDirectory({
    channelId: CHANNEL_ID,
    directory: projectDirectory,
    channelType: 'text',
  })

  // Native profile: SYNTHETIC fake-app-server behind the plain-spawn fixture
  // launcher; channel default frozen to zcode so new threads bind natively.
  setNativeRuntimeLauncherForTests(plainSpawnLauncher())
  const exeHash = await fileHash(process.execPath)
  const entryHash = await fileHash(fixture)
  registerNativeProfile(
    syntheticProfile({
      id: 'zcode-primary',
      revision: 'e2e-r1',
      codec: fakeCodec,
      attachmentRoot: path.join(root, 'attachments'),
      launch: (cwd: string) => ({
        executable: process.execPath,
        args: [fixture, nativeHome],
        executableSha256: exeHash,
        entryPath: fixture,
        entrySha256: entryHash,
        cwd,
        environment: { PATH: process.env.PATH ?? '' },
        graceMs: 300,
        startupMs: 8000,
      }),
    }),
  )
  const coordinator = await getNativeCoordinator()
  expect(coordinator).toBeTruthy()
  await coordinator!.store.setDefault('channel', CHANNEL_ID, 'zcode', 'zcode-primary')

  ctx.botClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
    rest: { api: ctx.discord.restUrl, version: '10' },
  })
  await startDiscordBot({
    token: ctx.discord.botToken,
    appId: ctx.discord.botUserId,
    discordClient: ctx.botClient,
  })
}, 30_000)

afterAll(async () => {
  try {
    await (await getNativeCoordinator())?.close()
  } catch {
    // already closed
  }
  resetNativeCoordinator()
  setNativeRuntimeLauncherForTests(null)
  void ctx.botClient?.destroy()
  await closeDatabase().catch(() => undefined)
  await stopHranaServer().catch(() => undefined)
  await ctx.discord?.stop().catch(() => undefined)
  delete process.env['KIMAKI_LOCK_PORT']
  delete process.env['KIMAKI_DB_URL']
  // Best-effort: a just-killed fixture child can briefly hold handles on
  // Windows; timestamped roots make leftovers harmless.
  try {
    fs.rmSync(ctx.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch {
    // left for the OS temp cleaner
  }
  if (ctx.previousVerbosity) {
    store.setState({ defaultVerbosity: ctx.previousVerbosity as never })
  }
})

async function nativeState(): Promise<NativeState> {
  return JSON.parse(await readFile(path.join(ctx.nativeHome, 'native.json'), 'utf8')) as NativeState
}

test(
  'native thread turn renders end-to-end with zero OpenCode initialization',
  { timeout: 20_000 },
  async () => {
    await ctx.discord.channel(CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'Reply with exactly: native-hello',
    })

    const thread = await ctx.discord.channel(CHANNEL_ID).waitForThread({
      timeout: 8_000,
      predicate: (t) => Boolean(t.name?.includes('native-hello')),
    })
    ctx.nativeThreadId = thread.id

    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'Done ✓',
      timeout: 12_000,
    })

    // The native side saw exactly one create and one send for this turn.
    const state = await nativeState()
    expect(state.creates).toBe(1)
    expect(state.sends.some((s) => s.content.includes('native-hello'))).toBe(true)

    // Zero OpenCode on native routes — the whole suite so far.
    expect(opencodeInits).toEqual([])
  },
)

test(
  'restart resumes the same native session — no fresh create, one send per turn',
  { timeout: 20_000 },
  async () => {
    const before = await nativeState()
    const firstSessionId = before.sends[0]!.sessionId

    // Simulated bot restart of the native controller: dispose, then let the
    // next admission rebuild over the SAME durable store.
    const coordinator = await getNativeCoordinator()
    await coordinator!.close()
    resetNativeCoordinator()
    const rebuilt = await getNativeCoordinator()
    expect(rebuilt).toBeTruthy()

    const threadId = ctx.nativeThreadId!
    await ctx.discord.thread(threadId).user(TEST_USER_ID).sendMessage({
      content: 'Reply with exactly: native-second',
    })

    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId,
      userId: TEST_USER_ID,
      text: 'Done ✓ Reply with exactly: native-second',
      timeout: 12_000,
    })

    const after = await nativeState()
    expect(after.creates).toBe(1)
    expect(after.sends.length).toBe(2)
    expect(new Set(after.sends.map((s) => s.sessionId))).toEqual(new Set([firstSessionId]))
    expect(opencodeInits).toEqual([])
  },
)
