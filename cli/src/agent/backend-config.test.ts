// #25 regression suite — the production write path for agent_backend_defaults,
// existing-thread migration to the native backend, and the thread-intent
// lifecycle (workspace-pending rows are bound on success or expired, never
// stuck forever). Command layer → durable store row is exercised end-to-end
// against the REAL file-backed libSQL client (the raw host client seam and the
// thread-session bindings are the only fakes); the discord-bot.ts wiring that
// dispatches into this layer is pinned by source assertions, the established
// convention for host-module routing (workspace-fence.test.ts,
// opencode-preservation.test.ts). — ZCode 2026-09-28
import { test, describe, vi } from 'vitest'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const state = {
  rawClient: null as unknown as import('@libsql/client').Client,
  coordinator: null as import('./coordinator.js').AgentCoordinator | null,
  threadSessions: new Map<string, string>(),
}

vi.mock('../db.js', () => ({
  // The raw host client seam: production resolves the shared app database;
  // tests point it at the harness file DB so command-layer writes land in the
  // same store the coordinator freezes intents from.
  getRawDbClient: async () => state.rawClient,
}))
vi.mock('../database.js', () => ({
  getThreadSession: async (threadId: string) => state.threadSessions.get(threadId) ?? null,
  upsertThreadSession: async ({
    threadId,
    sessionId,
  }: {
    threadId: string
    sessionId: string
  }) => {
    state.threadSessions.set(threadId, sessionId)
  },
}))
vi.mock('./host-sidecar.js', () => ({
  // zc: ids resolve through the durable sidecar; legacy OpenCode ids have none.
  lookupBackendSidecar: async (sessionId: string) =>
    sessionId.startsWith('zc:') ? { backend: 'zcode' } : undefined,
  countActiveNativeOperations: async () => 0,
}))
vi.mock('./host-coordinator.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getNativeCoordinator: async () => state.coordinator,
}))
vi.mock('./host-identity.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The harness store owns its sessions as 'test-machine'.
  getOwnerMachineId: async () => 'test-machine',
}))

import {
  STALE_THREAD_INTENT_MAX_AGE_MS,
  agentChannelBackendDefault,
  configureChannelBackend,
  ensureNativeThreadSession,
  migrateThreadToNative,
  parseNativeHostCommand,
} from './message-ingest.js'
import { registerNativeProfile, syntheticProfile } from './native-profile.js'
import { fakeCodec } from './fixtures/fake-codec.js'
import { coordinatorHarness, createStoreHarness } from './test-harness.js'

const statement = (sql: string, ...args: (string | number | null)[]) => ({ sql, args })

/** Read a thread-intent row through the current harness store. */
const intentRow = (h: { db: import('./sql.js').SqlClient }, threadId: string) =>
  h.db
    .execute(statement('SELECT * FROM agent_thread_intents WHERE thread_id=?', threadId))
    .then((r) => r.rows[0])

/** Register the certified profile the default intent resolution expects. */
function registerTestProfile(attachmentRoot: string) {
  registerNativeProfile(
    syntheticProfile({
      id: 'zcode-primary',
      revision: 'r25',
      codec: fakeCodec,
      launch: () => {
        throw new Error('not used in-process')
      },
      attachmentRoot,
    }),
  )
}

describe('#25 host command parser', () => {
  test('parses the full command grammar and rejects everything else', () => {
    assert.deepEqual(parseNativeHostCommand('zc: backend zcode'), {
      kind: 'set-backend',
      backend: 'zcode',
      profileId: null,
    })
    assert.deepEqual(parseNativeHostCommand('zc:backend zcode native-profile'), {
      kind: 'set-backend',
      backend: 'zcode',
      profileId: 'native-profile',
    })
    assert.deepEqual(parseNativeHostCommand('  zc: backend opencode  '), {
      kind: 'set-backend',
      backend: 'opencode',
      profileId: null,
    })
    assert.deepEqual(parseNativeHostCommand('zc: backend ZCODE'), {
      kind: 'set-backend',
      backend: 'zcode',
      profileId: null,
    })
    assert.deepEqual(parseNativeHostCommand('zc: status'), { kind: 'status' })
    assert.deepEqual(parseNativeHostCommand('zc:status'), { kind: 'status' })
    // Not host commands at all — normal message traffic.
    assert.equal(parseNativeHostCommand('hello world'), null)
    assert.equal(parseNativeHostCommand('!shell command'), null)
    assert.equal(parseNativeHostCommand('use zc: prefix like this'), null)
    assert.equal(parseNativeHostCommand(''), null)
    assert.equal(parseNativeHostCommand('zcd: backend zcode'), null)
    // Prefixed but malformed: visible usage, never a silent fall-through.
    assert.deepEqual(parseNativeHostCommand('zc: hello'), { kind: 'unknown' })
    assert.deepEqual(parseNativeHostCommand('zc:'), { kind: 'unknown' })
    assert.deepEqual(parseNativeHostCommand('zc: backend'), { kind: 'unknown' })
    assert.deepEqual(parseNativeHostCommand('zc: backend zcode a b'), { kind: 'unknown' })
    assert.deepEqual(parseNativeHostCommand('zc: backend redis'), { kind: 'unknown' })
  })
})

describe('#25 production write path (command layer → store row)', () => {
  test('configureChannelBackend persists and updates the channel default', async () => {
    const h = await createStoreHarness()
    state.rawClient = h.client
    registerTestProfile(h.root)
    const first = await configureChannelBackend({
      channelId: 'chan-1',
      backend: 'zcode',
      profileId: 'zcode-primary',
    })
    assert.equal(first.ok, true)
    if (first.ok) {
      assert.equal(first.backend, 'zcode')
      assert.equal(first.profileId, 'zcode-primary')
    }
    const row = (
      await h.db.execute(
        statement("SELECT * FROM agent_backend_defaults WHERE scope_type='channel' AND scope_id='chan-1'"),
      )
    ).rows[0]
    assert.ok(row, 'the default row exists after the command')
    assert.equal(String(row.backend_type), 'zcode')
    assert.equal(String(row.profile_id), 'zcode-primary')

    const second = await configureChannelBackend({
      channelId: 'chan-1',
      backend: 'opencode',
      profileId: null,
    })
    assert.equal(second.ok, true)
    const flipped = (
      await h.db.execute(
        statement("SELECT * FROM agent_backend_defaults WHERE scope_type='channel' AND scope_id='chan-1'"),
      )
    ).rows[0]
    assert.ok(flipped, 'the updated default row still exists')
    assert.equal(String(flipped.backend_type), 'opencode')
    assert.equal(flipped.profile_id, null)
  })

  test('the written default is what later resolution and intent freezing read', async () => {
    const h = await createStoreHarness()
    state.rawClient = h.client
    registerTestProfile(h.root)
    await configureChannelBackend({ channelId: 'chan-r', backend: 'zcode', profileId: 'zcode-primary' })
    const resolved = await agentChannelBackendDefault('chan-r')
    assert.deepEqual(resolved, { backend: 'zcode', profileId: 'zcode-primary' })
    const intent = await h.store.freezeIntent('thread-r', 'chan-r', 'global')
    assert.equal(String((intent as { backend_type: string }).backend_type), 'zcode')
    assert.equal(String((intent as { profile_id: string | null }).profile_id), 'zcode-primary')
  })

  test('an explicitly named unknown profile refuses the write before any row lands', async () => {
    const h = await createStoreHarness()
    state.rawClient = h.client
    registerTestProfile(h.root)
    const refused = await configureChannelBackend({
      channelId: 'chan-x',
      backend: 'zcode',
      profileId: 'no-such-profile',
    })
    assert.deepEqual(refused, { ok: false, error: 'Unknown or disabled native profile: no-such-profile' })
    const rows = (await h.db.execute('SELECT COUNT(*) AS n FROM agent_backend_defaults')).rows
    assert.equal(Number(rows[0]!.n), 0)
  })
})

describe('#25 existing-thread migration', () => {
  test('an OpenCode-bound thread migrates after the channel is configured to zcode', async () => {
    const h = await coordinatorHarness()
    state.rawClient = h.client
    registerTestProfile(h.root)
    state.coordinator = h.coordinator
    state.threadSessions.clear()
    state.threadSessions.set('thread-mig', 'ses_legacy_1')
    await configureChannelBackend({ channelId: 'chan-mig', backend: 'zcode', profileId: 'zcode-primary' })

    const migration = await migrateThreadToNative({
      threadId: 'thread-mig',
      channelId: 'chan-mig',
      projectDirectory: h.session.workspace.projectDirectory,
    })
    assert.equal(migration.kind, 'migrated')
    if (migration.kind !== 'migrated') {
      return
    }
    assert.ok(migration.sessionId.startsWith('zc:'), 'the new binding is a native session id')
    assert.equal(migration.previousSessionId, 'ses_legacy_1')
    assert.equal(state.threadSessions.get('thread-mig'), migration.sessionId)
    // The rebinding is durable: the session row exists, is owned by this
    // thread, and the frozen intent completed its lifecycle.
    const session = await h.store.session(migration.sessionId)
    assert.equal(session?.controllerThreadId, 'thread-mig')
    const intent = await intentRow(h, 'thread-mig')
    assert.equal(String(intent?.state), 'bound')
    assert.equal(String(intent?.backend_type), 'zcode')
    // A repeat call is a no-op: the thread is native now.
    const again = await migrateThreadToNative({
      threadId: 'thread-mig',
      channelId: 'chan-mig',
      projectDirectory: h.session.workspace.projectDirectory,
    })
    assert.deepEqual(again, { kind: 'not-applicable' })
    await h.coordinator.close()
  })

  test('a default-off channel makes zero native writes and keeps the OpenCode route', async () => {
    const h = await coordinatorHarness()
    state.rawClient = h.client
    registerTestProfile(h.root)
    state.coordinator = h.coordinator
    state.threadSessions.clear()
    state.threadSessions.set('thread-oc', 'ses_legacy_2')

    const migration = await migrateThreadToNative({
      threadId: 'thread-oc',
      channelId: 'chan-plain',
      projectDirectory: h.session.workspace.projectDirectory,
    })
    assert.deepEqual(migration, { kind: 'not-applicable' })
    assert.equal(state.threadSessions.get('thread-oc'), 'ses_legacy_2')
    const sessions = (await h.db.execute('SELECT COUNT(*) AS n FROM agent_sessions')).rows
    assert.equal(Number(sessions[0]!.n), 1, 'only the harness fixture session exists')
    const intents = (await h.db.execute('SELECT COUNT(*) AS n FROM agent_thread_intents')).rows
    assert.equal(Number(intents[0]!.n), 0, 'no intent was frozen')
    await h.coordinator.close()
  })

  test('native runtime unavailable defers the migration instead of erroring', async () => {
    const h = await coordinatorHarness()
    state.rawClient = h.client
    registerTestProfile(h.root)
    state.coordinator = null
    state.threadSessions.clear()
    state.threadSessions.set('thread-defer', 'ses_legacy_3')
    await configureChannelBackend({ channelId: 'chan-defer', backend: 'zcode', profileId: 'zcode-primary' })

    const migration = await migrateThreadToNative({
      threadId: 'thread-defer',
      channelId: 'chan-defer',
      projectDirectory: h.session.workspace.projectDirectory,
    })
    assert.deepEqual(migration, { kind: 'unavailable' })
    assert.equal(state.threadSessions.get('thread-defer'), 'ses_legacy_3')
    await h.coordinator.close()
  })

  test('an already-native thread is never re-migrated or downgraded by an opencode config', async () => {
    const h = await coordinatorHarness()
    state.rawClient = h.client
    state.coordinator = h.coordinator
    state.threadSessions.clear()
    state.threadSessions.set('thread-native', 'zc:session-1')
    await configureChannelBackend({ channelId: 'chan-native', backend: 'opencode', profileId: null })

    const migration = await migrateThreadToNative({
      threadId: 'thread-native',
      channelId: 'chan-native',
      projectDirectory: h.session.workspace.projectDirectory,
    })
    assert.deepEqual(migration, { kind: 'not-applicable' })
    assert.equal(state.threadSessions.get('thread-native'), 'zc:session-1')
    await h.coordinator.close()
  })
})

describe('#25 new-thread intent lifecycle', () => {
  test('ensureNativeThreadSession binds the intent instead of leaving it workspace-pending', async () => {
    const h = await coordinatorHarness()
    state.rawClient = h.client
    registerTestProfile(h.root)
    state.coordinator = h.coordinator
    state.threadSessions.clear()
    await configureChannelBackend({ channelId: 'chan-new', backend: 'zcode', profileId: 'zcode-primary' })

    const started = await ensureNativeThreadSession({
      threadId: 'thread-new',
      channelId: 'chan-new',
      projectDirectory: h.session.workspace.projectDirectory,
    })
    assert.equal(started.kind, 'created')
    const intent = await intentRow(h, 'thread-new')
    assert.equal(String(intent?.state), 'bound', 'the frozen intent reached its binding')
    await h.coordinator.close()
  })
})

describe('#25 stale intent expiry', () => {
  test('expired workspace-pending rows settle as failed; fresh rows and bindings survive', async () => {
    const h = await createStoreHarness()
    state.rawClient = h.client
    await h.store.freezeIntent('thread-stale', 'chan', 'global')
    await h.store.freezeIntent('thread-fresh', 'chan', 'global')
    // Backdate the stale row past the sweep age (raw SQL, like the H05 test).
    await h.db.execute(
      statement(
        'UPDATE agent_thread_intents SET created_at=? WHERE thread_id=?',
        Date.now() - STALE_THREAD_INTENT_MAX_AGE_MS - 3_600_000,
        'thread-stale',
      ),
    )
    const expired = await h.store.expireStaleThreadIntents(STALE_THREAD_INTENT_MAX_AGE_MS)
    assert.equal(expired, 1)
    assert.equal(String((await intentRow(h, 'thread-stale'))?.state), 'failed')
    assert.equal(String((await intentRow(h, 'thread-fresh'))?.state), 'workspace-pending')
    // A successful late bind supersedes even the expired state.
    await h.store.markThreadIntentBound('thread-stale')
    assert.equal(String((await intentRow(h, 'thread-stale'))?.state), 'bound')
    // Idempotent: re-binding a bound row changes nothing.
    await h.store.markThreadIntentBound('thread-stale')
    assert.equal(String((await intentRow(h, 'thread-stale'))?.state), 'bound')
  })

  test('a config change sweeps stale intents', async () => {
    const h = await createStoreHarness()
    state.rawClient = h.client
    await h.store.freezeIntent('thread-abandoned', 'chan', 'global')
    await h.db.execute(
      statement(
        'UPDATE agent_thread_intents SET created_at=? WHERE thread_id=?',
        Date.now() - STALE_THREAD_INTENT_MAX_AGE_MS * 2,
        'thread-abandoned',
      ),
    )
    const configured = await configureChannelBackend({
      channelId: 'chan',
      backend: 'opencode',
      profileId: null,
    })
    assert.equal(configured.ok, true)
    if (configured.ok) {
      assert.equal(configured.expiredIntents, 1)
    }
    const rows = (await h.db.execute('SELECT state FROM agent_thread_intents')).rows
    assert.equal(String(rows[0]?.state), 'failed')
  })
})

describe('#25 discord-bot wiring (source pins)', () => {
  test('the host command is dispatched after the permission gate and before any session work', async () => {
    const here = fileURLToPath(new URL('./backend-config.test.ts', import.meta.url)).replace(
      /[^/\\]+$/,
      '',
    )
    const bot = await readFile(`${here}../discord-bot.ts`, 'utf8')
    // The bot routes into the agent-boundary parser/writer — it never parses
    // or mints the reserved namespace itself (ZK-006 pin stays intact).
    assert.match(bot, /parseNativeHostCommand/)
    assert.match(bot, /configureChannelBackend\(\{/)
    assert.match(bot, /migrateThreadToNative\(\{/)
    assert.equal(/['"]zc:/.test(bot), false, 'no zc: string literal in the host module')
    // The interception must follow the Kimaki permission gate...
    const permissionGate = bot.indexOf('hasKimakiBotPermission(member, message.guild)')
    const interception = bot.indexOf('if (nativeHostCommand && !isCliInjectedPrompt)')
    assert.ok(permissionGate > 0 && interception > permissionGate)
    // ...and precede the first runtime construction and the thread backend gate.
    assert.ok(interception < bot.indexOf('getOrCreateRuntime({'))
    assert.ok(interception < bot.indexOf('gateThreadMessage(threadBackend)'))
    // The mention-mode exemption covers the host command like the `!` shell.
    assert.match(bot, /!botMentioned && !isShellCommand && !nativeHostCommand/)
    // Migration fires after backend resolution and before the native ingest
    // path that admits the message into the migrated session.
    const backendResolution = bot.indexOf('resolveIngressBackend(hasExistingSession')
    const migrationHook = bot.indexOf('migrateThreadToNative({')
    const nativeIngest = bot.indexOf('ingestNativeThreadMessage({')
    assert.ok(
      backendResolution > 0 && migrationHook > backendResolution && nativeIngest > migrationHook,
      'resolve → migrate → ingest ordering',
    )
  })
})
