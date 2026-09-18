/** ZK-016 certification row-runner — FREE ROWS ONLY (N01–N05; N06 needs a
 * third-party profile; N07+ are PAID and hard-refused here until recorded
 * Cody opt-in + cost limits exist). Launches the real native app-server via
 * the owned runtime, drives the checklist's read-only/create/subscribe/setModel
 * sequences, and writes sanitized captured evidence per row. Divergences are
 * recorded, never guessed around. Requires a built CLI (pnpm --filter kimaki
 * build). — ZCode 2026-09-18 */
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const ALLOWED_ROWS = {
  N01: 'startup/readiness + session/list (read-only)',
  N02: 'session/create + identity readback',
  N03: 'session/read full schema capture',
  N04: 'session/subscribe + v4/conversation/subscribe',
  N05: 'session/setModel + readback (config only, no inference)',
}
const ALLOWED_METHODS = new Set([
  'session/list',
  'session/create',
  'session/read',
  'session/subscribe',
  'session/setModel',
  'v4/conversation/subscribe',
])

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}

const executable = arg('executable')
const entryPath = arg('entry')
const workspace = arg('workspace')
const outDir = arg('out')
const rows = (arg('rows') ?? 'N01')
  .split(',')
  .map((r) => r.trim().toUpperCase())
  .filter(Boolean)
const mode = arg('mode') ?? 'build'
const timeoutMs = Number(arg('timeout') ?? 20000)
// Repeatable --env KEY=VALUE: the certified profile's environment (recorded in
// evidence + profile manifest). Loader-injection vars are rejected by verifyLaunch.
const environment = {}
for (let i = 0; i < process.argv.length - 1; i++) {
  if (process.argv[i] === '--env' && process.argv[i + 1]?.includes('=')) {
    const eq = process.argv[i + 1].indexOf('=')
    environment[process.argv[i + 1].slice(0, eq)] = process.argv[i + 1].slice(eq + 1)
  }
}

if (!executable || !entryPath || !workspace || !outDir || !rows.length) {
  console.error(
    'Usage: node tools/certify.mjs --executable <node> --entry <zcode.cjs> --workspace <dir> --out <evidence-dir> [--rows N01,N02,N03,N04,N05] [--mode build] [--timeout 20000] [--env KEY=VALUE ...]',
  )
  process.exit(2)
}
for (const row of rows) {
  if (!ALLOWED_ROWS[row]) {
    console.error(`Unknown or refused row '${row}'. Free rows: ${Object.keys(ALLOWED_ROWS).join(', ')}. N07+ (paid) require recorded opt-in.`)
    process.exit(2)
  }
}

const { fileHash, startOwnedRuntime } = await import('../cli/dist/agent/native/process.js')
const { NativeClient } = await import('../cli/dist/agent/native/client.js')
const { fail } = await import('../cli/dist/agent/native/errors.js')

/** Allowlisted redaction: private paths collapse to ~; long blobs truncate. */
const HOME_PATTERNS = [
  [/\/home\/[^/"]+/g, '~/'],
  [/\/mnt\/c\/Users\/[^/"]+/g, '~win'],
  [/C:\\\\Users\\\\[^\\\\"]+/g, '~win'],
  [/C:\\Users\\[^\\"]+/g, '~win'],
]
function redact(value, depth = 0) {
  if (depth > 12) return '[depth]'
  if (typeof value === 'string') {
    let s = value
    for (const [pattern, replacement] of HOME_PATTERNS) s = s.replace(pattern, replacement)
    return s.length > 512 ? `${s.slice(0, 256)}…[truncated ${s.length}b]` : s
  }
  if (Array.isArray(value)) return value.slice(0, 64).map((v) => redact(v, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value).slice(0, 128)) out[k] = redact(v, depth + 1)
    return out
  }
  return value
}

const log = {
  startedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  profile: {
    executable,
    executableSha256: await fileHash(executable),
    entryPath,
    entrySha256: await fileHash(entryPath),
    args: [entryPath, 'app-server'],
    environment,
    cwd: workspace,
  },
  rows: {},
  envelopeLog: [],
  stderrTail: [],
  reverseRequests: [],
  notifications: [],
  classification: 'captured',
  redaction: 'allowlisted: home paths -> ~; strings >512b truncated',
}

const push = (arr, entry) => {
  arr.push(redact(entry))
  if (arr.length > 400) arr.splice(0, arr.length - 400)
}

const runtimeResult = await startOwnedRuntime({
  executable,
  entryPath,
  args: [entryPath, 'app-server'],
  cwd: workspace,
  executableSha256: log.profile.executableSha256,
  entrySha256: log.profile.entrySha256,
  environment,
  startupMs: 30000,
  graceMs: 5000,
})
if (!runtimeResult.ok) {
  log.launch = { ok: false, error: runtimeResult.error.toJSON() }
  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'certify-capture.json'), JSON.stringify(log, null, 2))
  console.error(`Launch failed: ${runtimeResult.error.code} — ${runtimeResult.error.message}`)
  process.exit(1)
}
const runtime = runtimeResult.value
log.launch = { ok: true, pid: runtime.pid }
runtime.onExit(() => client.disconnect())
let disconnected = null
const client = new NativeClient({
  input: runtime.input,
  output: runtime.output,
  timeoutMs,
  onNotification: (method, params) => {
    push(log.notifications, { at: Date.now(), method, params })
    log.envelopeLog.push({ dir: 'in', kind: 'notification', method })
  },
  onRequest: async (id, method, params) => {
    push(log.reverseRequests, { at: Date.now(), id, method, params })
    log.envelopeLog.push({ dir: 'in', kind: 'request', id, method })
    // Certification runner never auto-allows host requests — explicit refusal.
    return { ok: false, error: fail('HOST_REFUSED', `Certification runner refuses host request ${method}.`, 'control', 'none') }
  },
  onDisconnect: (error) => {
    disconnected = error.toJSON()
  },
})
log.client = { generation: client.generation }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function call(row, method, params) {
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, error: { code: 'ROW_REFUSED', safeMessage: `Method ${method} outside free certification rows.` } }
  }
  log.envelopeLog.push({ dir: 'out', kind: 'request', method })
  const started = Date.now()
  const result = await client.request(method, params)
  const entry = { at: new Date().toISOString(), method, params: redact(params), ms: Date.now() - started }
  if (result.ok) entry.result = redact(result.value)
  else entry.error = result.error.toJSON()
  return entry
}
function record(row, evidence) {
  log.rows[row] = evidence
  console.log(`${row}: ${JSON.stringify(evidence).slice(0, 220)}`)
}

try {
  await sleep(700) // capture startup emissions before first request
  const W = { workspacePath: workspace, workspaceKey: workspace }

  if (rows.includes('N01')) {
    record('N01', {
      description: ALLOWED_ROWS.N01,
      startupEmissions: { notifications: log.notifications.length, reverseRequests: log.reverseRequests.length },
      list: await call('N01', 'session/list', { workspace: W, includeArchived: false, limit: 1 }),
    })
  }

  let sessionId = null
  if (rows.includes('N02')) {
    const create = await call('N02', 'session/create', { workspace: W, mode })
    record('N02', { description: ALLOWED_ROWS.N02, create, mode })
    sessionId =
      create && create.result && typeof create.result === 'object' && create.result.session
        ? create.result.session.sessionId
        : null
    if (sessionId) log.sessionId = sessionId
  }
  if (!sessionId && (rows.includes('N03') || rows.includes('N04') || rows.includes('N05'))) {
    const listed = await client.request('session/list', { workspace: W, includeArchived: false, limit: 1 })
    const candidate =
      listed.ok && listed.value && typeof listed.value === 'object'
        ? Array.isArray(listed.value.sessions) && listed.value.sessions[0]
          ? listed.value.sessions[0].sessionId
          : typeof listed.value.sessionId === 'string'
            ? listed.value.sessionId
            : null
        : null
    if (candidate) {
      sessionId = candidate
      log.sessionIdSource = 'session/list (pre-existing)'
    } else {
      record('N03/N04/N05', { skipped: 'no native session id available (N02 not run or create failed)' })
    }
  }

  if (sessionId && rows.includes('N03')) {
    record('N03', { description: ALLOWED_ROWS.N03, read: await call('N03', 'session/read', { sessionId }) })
  }

  if (sessionId && rows.includes('N04')) {
    const legacy = await call('N04', 'session/subscribe', {
      sessionId,
      deliveryKind: 'desktop-continuous',
      includeSnapshot: true,
      afterSeq: 0,
    })
    const v4 = await call('N04', 'v4/conversation/subscribe', {
      topic: `conversation/${sessionId}`,
      connectionId: client.generation,
      clientMode: 'desktop-continuous',
    })
    await sleep(1500) // initial frames + ordering relative to ACK
    record('N04', {
      description: ALLOWED_ROWS.N04,
      legacy,
      v4,
      framesAfterAck: { notifications: log.notifications.length, reverseRequests: log.reverseRequests.length },
    })
  }

  if (sessionId && rows.includes('N05')) {
    // Advertised model comes from the readback itself — never invented.
    const before = await client.request('session/read', { sessionId })
    const advertised =
      before.ok && before.value && typeof before.value === 'object' && before.value.model
        ? before.value.model
        : null
    if (advertised && advertised.providerId && advertised.modelId) {
      const set = await call('N05', 'session/setModel', {
        sessionId,
        model: { providerId: advertised.providerId, modelId: advertised.modelId },
        runtimeModel: 'FULL_IF_REQUIRED',
        persistAsWorkspaceLastUsed: false,
      })
      const after = await call('N05', 'session/read', { sessionId })
      record('N05', { description: ALLOWED_ROWS.N05, advertisedModel: redact(advertised), set, readback: after })
    } else {
      record('N05', { description: ALLOWED_ROWS.N05, skipped: 'no advertised model in session/read readback', read: redact(before.ok ? before.value : before.error.toJSON()) })
    }
  }
} finally {
  const stopResult = await runtime.stop()
  await sleep(300)
  log.stop = stopResult.ok ? { ok: true } : { ok: false, error: stopResult.error.toJSON() }
  log.disconnected = disconnected
  log.stderrTail = redact((runtime.stderrLines?.() ?? []).slice(-40))
  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'certify-capture.json'), JSON.stringify(log, null, 2))
  console.log(`Evidence: ${path.join(outDir, 'certify-capture.json')}`)
}
