/** ZK-016 certification row-runner — free rows N01–N05 + N18 (protocol half),
 * paid rows N07–N17 double-gated on the RECORDED 2026-09-18 opt-in
 * (docs/zcode-integration/PAID-ROWS-DECISION.md) AND an explicit
 * --paid-optin-recorded flag, with hard caps (≤3 model turns/row, ≤30 total)
 * enforced against a persistent spend ledger. N06 is out of scope (the
 * workspace/updateProviderRegistry method does not exist in bundle 0.16.5).
 * Launches the real native app-server via the owned runtime, drives the
 * checklist sequences, and writes sanitized captured evidence per row.
 * Divergences are recorded, never guessed around. Requires a built CLI
 * (pnpm --filter kimaki build). — ZCode 2026-09-18 */
import path from 'node:path'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'

const FREE_ROWS = {
  N01: 'startup/readiness + session/list (read-only)',
  N02: 'session/create + identity readback',
  N03: 'session/read full schema capture',
  N04: 'session/subscribe + v4/conversation/subscribe',
  N05: 'session/setModel + readback (config only, no inference)',
  // N18 protocol half is FREE (no inference): unsubscribe + owned-process stop.
  N18: 'v4/conversation/unsubscribe + graceful/abrupt owned-process shutdown (no inference)',
}
// Paid rows (real model turns). N06 excluded (out of scope per opt-in; method
// absent in bundle 0.16.5). N15 additionally requires an image-capable model.
const PAID_ROWS = {
  N07: 'first paid text/tool turn on a disposable sentinel task',
  N08: 'permission denial + explicit allow-once',
  N09: 'native question and plan round trip',
  N10: 'active text guidance via v4/command sendText',
  N11: 'stop with a real background writer',
  N12: 'background and goal settlement',
  N13: 'idle native compact',
  N14: 'conversation-only fork via rowsRange',
  N15: 'image byte + resume retention (only if an image-capable model is advertised)',
  N16: 'same SID after clean restart',
  N17: 'failure/restart resume with list omission',
}
const ALLOWED_ROWS = { ...FREE_ROWS, ...PAID_ROWS }
const TURN_CAP_PER_ROW = 3
const TURN_CAP_TOTAL = 30
const RECORDED_MARKER = '## RECORDED 2026-09-18'
const ALLOWED_METHODS = new Set([
  'session/list',
  'session/create',
  'session/read',
  'session/subscribe',
  'session/setModel',
  'v4/conversation/subscribe',
  'v4/conversation/unsubscribe',
  // paid-row methods (still individually allowed; rows themselves are gated):
  'session/send',
  'session/events',
  'session/messages',
  'session/setMode',
  'session/setThoughtLevel',
  'session/stop',
  'session/subagents',
  'session/goal',
  'session/fork',
  'session/compact',
  'session/resume',
  'session/cancelBackgroundTask',
  'v4/conversation/rowsRange',
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
    'Usage: node tools/certify.mjs --executable <node> --entry <zcode.cjs> --workspace <dir> --out <evidence-dir> [--rows N01,N02,N03,N04,N05,N18 | paid rows N07..N17] [--mode build] [--timeout 20000] [--env KEY=VALUE ...] [--paid-optin-recorded] [--task <sentinel task text>]',
  )
  process.exit(2)
}
const paidOptinFlag = process.argv.includes('--paid-optin-recorded')
const taskText = arg('task')

// ---- Paid-row gate (mechanical, hard): RECORDED section + explicit flag + caps.
const DECISION_PATH = path.resolve(import.meta.dirname, '../docs/zcode-integration/PAID-ROWS-DECISION.md')
const SPEND_PATH = path.resolve(import.meta.dirname, '../docs/zcode-integration/evidence/zk16-paid-spend.json')
async function recordedOptinPresent() {
  try {
    const text = await readFile(DECISION_PATH, 'utf8')
    return text.includes(RECORDED_MARKER)
  } catch {
    return false
  }
}
async function loadSpend() {
  try {
    return JSON.parse(await readFile(SPEND_PATH, 'utf8'))
  } catch {
    return { totalTurns: 0, perRow: {}, updatedAt: null, note: ' Certification spend ledger (model turns per paid row).' }
  }
}
async function saveSpend(spend) {
  spend.updatedAt = new Date().toISOString()
  await mkdir(path.dirname(SPEND_PATH), { recursive: true })
  await writeFile(SPEND_PATH, JSON.stringify(spend, null, 2))
}
const requestedPaid = rows.filter((r) => PAID_ROWS[r])
if (requestedPaid.length) {
  if (requestedPaid.includes('N06')) {
    console.error("N06 refused: third-party registry is out of scope per the RECORDED opt-in (and workspace/updateProviderRegistry does not exist in bundle 0.16.5).")
    process.exit(2)
  }
  if (!paidOptinFlag) {
    console.error('PAID-GATE: paid rows requested without --paid-optin-recorded. Refusing (RECORDED 2026-09-18 opt-in requires the explicit acknowledgment flag).')
    process.exit(2)
  }
  if (!(await recordedOptinPresent())) {
    console.error(`PAID-GATE: ${RECORDED_MARKER} section missing from ${DECISION_PATH}. Refusing paid rows.`)
    process.exit(2)
  }
  const spend = await loadSpend()
  for (const row of requestedPaid) {
    const spent = spend.perRow[row] ?? 0
    if (spent >= TURN_CAP_PER_ROW) {
      console.error(`CAP_EXCEEDED: row ${row} already spent ${spent}/${TURN_CAP_PER_ROW} model turns (ledger ${SPEND_PATH}). Hard stop.`)
      process.exit(2)
    }
  }
  if ((spend.totalTurns ?? 0) >= TURN_CAP_TOTAL) {
    console.error(`CAP_EXCEEDED: total paid turns ${spend.totalTurns}/${TURN_CAP_TOTAL} (ledger ${SPEND_PATH}). Hard stop.`)
    process.exit(2)
  }
  // Sentinel rule: paid rows run only in disposable workspaces under the system temp dir.
  const norm = path.resolve(workspace).toLowerCase()
  const tmp = path.resolve(tmpdir()).toLowerCase()
  if (!norm.startsWith(tmp + path.sep)) {
    console.error(`SENTINEL-GATE: paid rows require the workspace to be a disposable directory under the system temp dir (${tmp}). Refusing '${workspace}'.`)
    process.exit(2)
  }
}
// Model-turn accounting shared by all paid drivers. Exceeding a cap exits hard.
let capExceeded = false
async function countModelTurn(row) {
  const spend = await loadSpend()
  spend.perRow[row] = (spend.perRow[row] ?? 0) + 1
  spend.totalTurns = (spend.totalTurns ?? 0) + 1
  await saveSpend(spend)
  const spent = spend.perRow[row]
  console.log(`TURN-SPEND ${row}: ${spent}/${TURN_CAP_PER_ROW} (total ${spend.totalTurns}/${TURN_CAP_TOTAL})`)
  if (spent > TURN_CAP_PER_ROW || spend.totalTurns > TURN_CAP_TOTAL) {
    capExceeded = true
  }
}

for (const row of rows) {
  if (!ALLOWED_ROWS[row]) {
    console.error(`Unknown or refused row '${row}'. Free rows: ${Object.keys(FREE_ROWS).join(', ')}. Paid rows (gated): ${Object.keys(PAID_ROWS).join(', ')}. N06 is out of scope.`)
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

/** Liveness with ESRCH discrimination (Node semantics on win32: signals coerce
 * to forceful kill; no /proc anywhere). */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code !== 'ESRCH'
  }
}
async function until(fn, ms, step = 50) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(step)
  }
  return false
}
/** Supervisor pid of the owned native child: its direct parent. win32 via CIM,
 * linux via /proc/<pid>/status PPid. */
function supervisorPidOf(nativePid) {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${nativePid}").ParentProcessId`],
        { windowsHide: true },
        (error, stdout) => {
          const pid = Number.parseInt(String(stdout).trim(), 10)
          resolve(!error && Number.isSafeInteger(pid) && pid > 0 ? pid : null)
        },
      )
    })
  }
  if (process.platform === 'linux') {
    return readFile(`/proc/${nativePid}/status`, 'utf8').then((text) => {
      const m = /^PPid:\s+(\d+)\s*$/m.exec(text)
      return m ? Number.parseInt(m[1], 10) : null
    }, () => null)
  }
  return Promise.resolve(null)
}
/** N18 abrupt leg on a self-contained second runtime: supervisor dies without a
 * stop message; keeper containment must end the whole native tree. */
async function abruptContainmentProbe() {
  const probe = { approach: 'kill supervisor (no stop message); keeper stdin EOF -> TerminateJobObject / group kill' }
  try {
    const second = await startOwnedRuntime({
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
    if (!second.ok) {
      return { ...probe, skipped: `second launch failed: ${second.error.code}` }
    }
    const nativePid = second.value.pid
    const supervisorPid = await supervisorPidOf(nativePid)
    Object.assign(probe, { nativePid, supervisorPid })
    if (!supervisorPid || !alive(supervisorPid)) {
      second.value.stop().catch(() => undefined)
      return { ...probe, skipped: 'supervisor pid not resolvable on this platform' }
    }
    process.kill(supervisorPid, 'SIGKILL') // brutal: no stop message, no graceful anything
    const treeDown = await until(() => !alive(nativePid), 10000)
    Object.assign(probe, {
      treeDown,
      treeDownWithinMs: 10000,
      exitObserved: await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 2000)
        second.value.onExit(() => {
          clearTimeout(t)
          resolve(true)
        })
      }),
    })
    // POSIX containment gap (recorded, never hidden): a brutally killed
    // supervisor cannot signal the process group, so the native tree can be
    // orphaned. The probe never leaks it — clean up directly and say so.
    if (!treeDown && alive(nativePid)) {
      probe.orphanedNativeTree = true
      try {
        if (process.platform !== 'win32') {
          try { process.kill(-nativePid, 'SIGKILL') } catch { /* group may be gone */ }
        }
        process.kill(nativePid, 'SIGKILL')
        probe.orphanCleanup = { attempted: true, dead: await until(() => !alive(nativePid), 5000) }
      } catch (e) {
        probe.orphanCleanup = { attempted: true, error: String(e?.message ?? e) }
      }
    }
    // Reap the probe runtime bookkeeping; the supervisor is already dead so this
    // settles immediately (CANCEL_UNCONFIRMED is expected and recorded as such).
    const reap = await second.value.stop()
    probe.reap = reap.ok ? { ok: true } : { code: reap.error.code }
    return probe
  } catch (error) {
    return { ...probe, error: String(error?.message ?? error) }
  }
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
  const needsSession = (row) => !['N01', 'N02'].includes(row)
  if (!sessionId && rows.some(needsSession)) {
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
    } else if (rows.some((r) => PAID_ROWS[r]) || rows.includes('N18')) {
      // Paid/N18 rows own their session: creating one is free (no inference).
      const create = await call('N02', 'session/create', { workspace: W, mode })
      sessionId =
        create && create.result && typeof create.result === 'object' && create.result.session
          ? create.result.session.sessionId
          : null
      log.sessionIdSource = 'session/create (row-owned sentinel session)'
    }
    if (!sessionId) {
      record('session-setup', { skipped: 'no native session id available (list empty; create not permitted for free-only rows besides N02/N18)' })
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
    // Advertised model comes from the readback itself — never invented. The
    // catalog may populate asynchronously, so poll session/read on a bounded
    // clock (config-only reads; no inference anywhere in this row).
    const pollStarted = Date.now()
    let before = null
    let advertised = null
    const pollTimeline = []
    while (Date.now() - pollStarted < 12000) {
      before = await client.request('session/read', { sessionId })
      const model =
        before.ok && before.value && typeof before.value === 'object' && before.value.settings
          ? before.value.settings.model
          : null
      const hasAvailable = model && Array.isArray(model.available) && model.available.length > 0
      const hasCurrent = model && model.current && typeof model.current === 'object'
      advertised = hasAvailable || hasCurrent ? model : null
      pollTimeline.push({
        atMs: Date.now() - pollStarted,
        available: model && Array.isArray(model.available) ? model.available.length : 'missing',
        hasCurrent: Boolean(hasCurrent),
      })
      if (advertised) break
      await sleep(1000)
    }
    const beforeModel = before?.ok && before?.value?.model ? before.value.model : null
    const selection = advertised ?? (beforeModel && beforeModel.providerId ? beforeModel : null)
    if (selection) {
      const providerId = selection.providerId ?? selection.current?.providerId
      const modelId = selection.modelId ?? selection.current?.modelId
      const set = await call('N05', 'session/setModel', {
        sessionId,
        model: { providerId, modelId },
        runtimeModel: 'FULL_IF_REQUIRED',
        persistAsWorkspaceLastUsed: false,
      })
      const after = await call('N05', 'session/read', { sessionId })
      record('N05', {
        description: ALLOWED_ROWS.N05,
        advertisedModel: redact(selection),
        set,
        readback: after,
        pollTimeline,
      })
    } else {
      record('N05', {
        description: ALLOWED_ROWS.N05,
        skipped: 'no advertised model in session/read readback after 12s poll',
        pollTimeline,
        settingsModel: redact(
          before?.ok && before?.value?.settings ? before.value.settings.model : null,
        ),
      })
    }
  }

  if (sessionId && rows.includes('N18')) {
    // Protocol unsubscribe (free — no inference): subscribe afresh, unsubscribe
    // the returned subscription, prove no stale deliveries, then stop the owned
    // process gracefully and abruptly (supervisor kill -> keeper containment).
    const framesBefore = log.notifications.filter((n) => n.method === 'v4/conversation/frame').length
    const sub = await call('N18', 'v4/conversation/subscribe', {
      topic: `conversation/${sessionId}`,
      connectionId: client.generation,
      clientMode: 'desktop-continuous',
    })
    await sleep(400)
    const ack =
      sub && sub.result && typeof sub.result === 'object' && sub.result.ack
        ? sub.result.ack
        : null
    const subscriptionId = ack && typeof ack.subscriptionId === 'string' ? ack.subscriptionId : null
    const unsubscribe = subscriptionId
      ? await call('N18', 'v4/conversation/unsubscribe', {
          topic: `conversation/${sessionId}`,
          connectionId: client.generation,
          subscriptionId,
        })
      : { skipped: 'no subscriptionId in subscribe ack' }
    await sleep(1200) // stale-delivery observation window
    const framesAfterUnsubscribe = log.notifications
      .filter((n) => n.method === 'v4/conversation/frame')
      .slice(framesBefore)
    const n18 = {
      description: ALLOWED_ROWS.N18,
      subscribe: sub,
      unsubscribe,
      staleDeliveries: { framesAfterUnsubscribe: framesAfterUnsubscribe.length, frames: redact(framesAfterUnsubscribe) },
    }
    // Abrupt leg: a fresh owned runtime, then kill the SUPERVISOR process (no
    // stop message) — keeper stdin EOF must TerminateJobObject the whole native
    // tree (the containment contract proven by supervision-win32.test.ts).
    const abrupt = await abruptContainmentProbe()
    record('N18', { ...n18, abrupt })
  }

  // ---- Paid rows (each reached only after the mechanical gate above passed).
  // A model turn is counted ONLY on an accepted session/send. Cap breach sets
  // capExceeded; the runner then records CAP_EXCEEDED and exits hard (finally
  // block still stops the owned process cleanly).
  const advertisedModel = async () => {
    const read = await client.request('session/read', { sessionId })
    const model =
      read.ok && read.value && typeof read.value === 'object' && read.value.settings
        ? read.value.settings.model
        : null
    const current = model && model.current && typeof model.current === 'object' ? model.current : null
    return current && current.providerId && current.modelId
      ? current
      : model && Array.isArray(model.available) && model.available.length
        ? model.available[0]
        : null
  }

  if (sessionId && rows.includes('N07')) {
    const task = taskText ?? `zk16-n07 sentinel ${new Date().toISOString()}: create a file named SENTINEL-${Date.now()}.txt containing the single word ok. Do nothing else.`
    const model = await advertisedModel()
    if (!model) {
      record('N07', {
        description: PAID_ROWS.N07,
        notRun: 'MODEL_UNAVAILABLE',
        detail: 'no current/advertised model for this session — provider access must be materialized for the headless profile first (see evidence/zk16-auth-probe.md). No turn spent.',
      })
    } else {
      const send = await call('N07', 'session/send', {
        sessionId,
        content: task,
        runtimeModel: 'FULL_IF_REQUIRED',
      })
      const accepted = send && send.result && send.result.accepted === true
      if (accepted) await countModelTurn('N07')
      // Bounded capture window: stream events + settle, then read back.
      const settleStart = Date.now()
      const sawTerminal = await until(async () => {
        const r = await client.request('session/read', { sessionId })
        return (
          r.ok &&
          r.value &&
          typeof r.value === 'object' &&
          r.value.projection &&
          r.value.projection.status !== 'running' &&
          r.value.runtime &&
          Array.isArray(r.value.runtime.pendingRequestIds) &&
          r.value.runtime.pendingRequestIds.length === 0
        )
      }, 60000, 1000)
      const readback = await call('N07', 'session/read', { sessionId })
      record('N07', {
        description: PAID_ROWS.N07,
        task: { text: task, unique: true, workspaceUnderTmp: true },
        advertisedModel: redact(model),
        send,
        turnCounted: Boolean(accepted),
        settle: { sawTerminal, withinMs: Date.now() - settleStart },
        readback,
        sentinelCheck: { note: 'filesystem diff of the sentinel workspace is captured separately below', workspace: workspace },
      })
    }
  }

  for (const [row, reason] of [
    ['N08', 'requires a captured native permission-request schema (codec fails closed until N08 capture); needs model turns to provoke the request'],
    ['N09', 'requires captured question/plan schemas; unknown schemas fail closed by design'],
    ['N10', 'requires an active controlled turn and the captured v4 command-event correlation (turn.steerQueued/steerDrained)'],
    ['N11', 'requires an active background writer from N07-class task and captured stop/cancel event shapes'],
    ['N12', 'requires the captured background/goal settlement shapes (do not invent goal enums)'],
    ['N13', 'requires session/compact response capture (paid turn needed first to have context to compact)'],
    ['N14', 'requires a captured v4/conversation/rowsRange page schema (forkPoint codec fails closed today)'],
    ['N15', 'requires an advertised image-capable model and the captured attachment schema'],
    ['N16', 'requires resume capture; depends on a completed paid session from N07-class runs'],
    ['N17', 'requires controlled ACK-drop capture; depends on N16 state'],
  ]) {
    if (rows.includes(row) && !log.rows[row]) {
      record(row, {
        description: PAID_ROWS[row],
        notRun: 'CAPTURE_SCHEMA_PENDING',
        detail: `${reason}. Ordered after N07 per the codec-per-divergence rule.`,
      })
    }
  }
  if (capExceeded) {
    log.capExceeded = {
      code: 'CAP_EXCEEDED',
      perRowCap: TURN_CAP_PER_ROW,
      totalCap: TURN_CAP_TOTAL,
      ledger: SPEND_PATH,
    }
    console.error('CAP_EXCEEDED: stopping certification run — hard cap reached (see ledger).')
  }
} finally {
  const stopResult = await runtime.stop()
  await sleep(300)
  // N18 graceful-leg evidence: confirmed stop AND the native pid actually gone.
  log.stop = {
    ok: stopResult.ok,
    ...(stopResult.ok ? {} : { error: stopResult.error.toJSON() }),
    nativePid: runtime.pid,
    nativePidLivenessAfterStop: alive(runtime.pid) ? 'ALIVE (containment failure)' : 'dead',
  }
  log.disconnected = disconnected
  log.stderrTail = redact((runtime.stderrLines?.() ?? []).slice(-40))
  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'certify-capture.json'), JSON.stringify(log, null, 2))
  console.log(`Evidence: ${path.join(outDir, 'certify-capture.json')}`)
  if (capExceeded) process.exitCode = 3
}
