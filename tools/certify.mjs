/** ZK-016 certification row-runner — free rows N01–N05 + N18 (protocol half),
 * paid rows N07–N17 double-gated on the RECORDED 2026-09-18 opt-in
 * (docs/zcode-integration/PAID-ROWS-DECISION.md) AND an explicit
 * --paid-optin-recorded flag, with hard caps (≤3 model turns/row, ≤30 total)
 * enforced against a persistent spend ledger. N06 is out of scope (the
 * workspace/updateProviderRegistry method does not exist in bundle 0.16.5).
 * N09–N17 drivers (2026-09-29) validate every request/response against shapes
 * extracted from the installed bundle's zod schemas plus the r5 captures
 * (evidence/zk16-win32-n07n08-r5: permission envelopes, send/readback, settle
 * timings) and FAIL CLOSED with a named error whenever a runtime shape is
 * unknown — never guessing around a divergence. Restart rows (N15/N16/N17)
 * reuse a session that already executed a turn (seeded in-row, counted against
 * that row's cap) because the 2026-09-28 N16 run proved an unexecuted session
 * is never persisted (resume → -32004 sessionUnavailable; list empty).
 * Launches the real native app-server via the owned runtime, drives the
 * checklist sequences, and writes sanitized captured evidence per row.
 * Divergences are recorded, never guessed around. Requires a built CLI
 * (pnpm --filter kimaki build). — ZCode 2026-09-18 */
import path from 'node:path'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

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
  N15R: 'post-resume image visual recall (operator re-gate 2026-09-30: artifact-ref retention contract; requires --session of the N15 session)',
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
  // N10/N11/N14 controls ride the v4 command lane (checklist C-prefix params).
  'v4/command',
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
// The owned runtime receives EXACTLY the environment it is handed (supervisor
// replacement semantics — least privilege by design). N07 evidence proved a
// bare 3-var env starves the agent CLI grandchild (it cannot resolve its home
// or auth; protocol rows N01–N04 still pass), so the runner composes the
// launch env as: curated safe host allowlist + explicit profile overrides.
// Secrets never pass (denylist under any case variant), loader-injection vars
// are excluded (verifyLaunch would refuse them anyway), and evidence records
// only the explicit override deltas, never the base env.
const HOST_ENV_ALLOWLIST = [
  'ALLUSERSPROFILE', 'APPDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMPUTERNAME',
  'COMSPEC', 'DRIVERDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS',
  'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SESSIONNAME', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'TEMP', 'TMP', 'USERNAME', 'USERPROFILE', 'WINDIR',
]
const baseEnv = {}
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue
  const upper = k.toUpperCase()
  if (!HOST_ENV_ALLOWLIST.includes(upper)) continue
  if (/^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(k)) continue
  baseEnv[k] = v
}
const launchEnvironment = { ...baseEnv, ...environment }

if (!executable || !entryPath || !workspace || !outDir || !rows.length) {
  console.error(
    'Usage: node tools/certify.mjs --executable <node> --entry <zcode.cjs> --workspace <dir> --out <evidence-dir> [--rows N01,N02,N03,N04,N05,N18 | paid rows N07..N17] [--mode build] [--timeout 20000] [--env KEY=VALUE ...] [--paid-optin-recorded] [--task <sentinel task text>] [--session <existing native sessionId> (N13/N15/N16/N17 reuse a turn-bearing session instead of seeding one in-row)]',
  )
  process.exit(2)
}
const paidOptinFlag = process.argv.includes('--paid-optin-recorded')
const taskText = arg('task')
const sessionArg = arg('session')

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
  environment: launchEnvironment,
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
// N08 machinery: what the runner does when the runtime asks permission.
// 'refuse' (default, captured-not-answered) | 'deny' | 'allow' (allow-once).
let permissionPolicy = 'refuse'
// Restart rows (N15/N16/N17) track their second owned runtimes here so the
// finally block can stop any that a throwing driver left alive.
const secondRuntimes = []
// Captured answer schema (bundle 0.16.5 zod jL): {decision:
// 'allow'|'deny'|'escalate'|'modify', reason?, modifiedInput?, permissionUpdates?}
// .strict() — extra keys are refused by the runtime. Omitted permissionUpdates
// is what makes an 'allow' answer allow-ONCE (no persistent grant recorded).
const PERMISSION_DECISIONS = new Set(['allow', 'deny', 'escalate', 'modify'])
function validatePermissionAnswer(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return 'answer must be an object'
  for (const k of Object.keys(answer)) {
    if (!['decision', 'reason', 'modifiedInput', 'permissionUpdates'].includes(k)) return `unknown key '${k}' (schema is strict)`
  }
  if (!PERMISSION_DECISIONS.has(answer.decision)) return "decision must be 'allow'|'deny'|'escalate'|'modify'"
  if (answer.reason !== undefined && typeof answer.reason !== 'string') return 'reason must be a string when present'
  return null
}
// N09 machinery: interaction/requestUserInput is the native question AND
// plan-approval reverse request (bundle zod CYe answer: {action:
// 'accept'|'decline'|'cancel', content?, reason?} .strict()). The request
// params shape (bundle HZa/JZa senders): {input, prompt, questions[{header,
// multiSelect, options[{description,label,preview?,value}], question}],
// requestId, schema:{toolName}|{interaction:'plan_approval',toolName},
// sessionId, origin?, toolCallId, toolName, turnId}. Question answers ride
// content.answers keyed by question text (answer_0/answer fallbacks exist in
// the bundle's normalizer); plan approval content.answers is keyed by the
// fixed plan question 'Review this implementation plan.' -> 'approve'.
// Like permissions: captured by default, answered only when a driver arms the
// policy, exactly ONCE per arming (one-use reply).
let userInputPolicy = { mode: 'refuse' }
function validateUserInputRequest(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'params must be an object'
  for (const k of Object.keys(params)) {
    if (!['input', 'prompt', 'questions', 'requestId', 'schema', 'sessionId', 'origin', 'toolCallId', 'toolName', 'turnId'].includes(k)) {
      return `unknown key '${k}' (requestUserInput schema is strict; refusing to guess)`
    }
  }
  if (!Array.isArray(params.questions) || params.questions.length === 0) return 'questions missing or empty'
  for (const q of params.questions) {
    if (!q || typeof q !== 'object') return 'question entry must be an object'
    if (typeof q.question !== 'string' || typeof q.header !== 'string') return 'question/header must be strings'
    if (!Array.isArray(q.options) || q.options.length === 0) return 'options missing or empty'
    for (const o of q.options) {
      if (!o || typeof o !== 'object' || typeof o.label !== 'string' || typeof o.value !== 'string') {
        return 'option label/value must be strings'
      }
    }
  }
  if (!params.schema || typeof params.schema !== 'object' || typeof params.schema.toolName !== 'string') {
    return 'schema.toolName missing'
  }
  if (typeof params.requestId !== 'string') return 'requestId missing'
  return null
}
function validateUserInputAnswer(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return 'answer must be an object'
  for (const k of Object.keys(answer)) {
    if (!['action', 'content', 'reason'].includes(k)) return `unknown key '${k}' (answer schema is strict)`
  }
  if (!['accept', 'decline', 'cancel'].includes(answer.action)) return "action must be 'accept'|'decline'|'cancel'"
  if (answer.content !== undefined && (typeof answer.content !== 'object' || answer.content === null || Array.isArray(answer.content))) {
    return 'content must be an object when present'
  }
  if (answer.reason !== undefined && typeof answer.reason !== 'string') return 'reason must be a string when present'
  return null
}
/** Shared reverse-request handling for a client of any generation. Captures
 * user-input requests; answers ONCE when a driver armed the policy. */
async function handleUserInputRequest(params, gen = 1) {
  log.userInputRequests = log.userInputRequests || []
  push(log.userInputRequests, { at: Date.now(), params, ...(gen !== 1 ? { gen } : {}) })
  if (userInputPolicy.mode === 'answer' && !userInputPolicy.used) {
    userInputPolicy.used = true
    const answer = userInputPolicy.buildAnswer(params)
    const invalid = validateUserInputAnswer(answer)
    if (invalid) {
      return { ok: false, error: fail('ANSWER_INVALID', `Refusing to send invalid user-input answer: ${invalid}`, 'control', 'none') }
    }
    return { ok: true, value: answer }
  }
  return {
    ok: false,
    error: fail('HOST_REFUSED', `Certification runner refuses user-input request (policy=${userInputPolicy.mode}${userInputPolicy.used ? '; one-use answer already sent' : ''}; captured only).`, 'control', 'none'),
  }
}
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
    // Captured divergence fix (zk16): the runtime answers this reverse request
    // at create AND at each execution materialization; refusing it stalls the
    // turn (proven by the first N07 run — accepted but zero execution). Answer
    // with the profile preferences exactly like the backend bridge does.
    // Genuine interactions (permission/question/plan) are still refused and
    // only captured until their rows add validated answering.
    if (method === 'session/requestRuntimePreferences') {
      return {
        ok: true,
        value: {
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: false,
        },
      }
    }
    if (method === 'interaction/requestPermission') {
      // Captured request shape (bundle zod): {input, reason, requestId,
      // riskLevel, sessionId, origin?, options[{optionId,label,kind}],
      // toolCallId, toolName, turnId}. Answered only when a driver sets the
      // policy; answered ONCE per request (allow = allow-ONCE, no
      // permissionUpdates → no persistent grant ever recorded).
      log.permissionRequests = log.permissionRequests || []
      push(log.permissionRequests, { at: Date.now(), params })
      if (permissionPolicy === 'allow' || permissionPolicy === 'deny') {
        const answer = {
          decision: permissionPolicy,
          reason: `ZK-016 N08 ${permissionPolicy === 'allow' ? 'allow-once' : 'denial'} leg — disposable sentinel workspace, RECORDED 2026-09-18 opt-in`,
        }
        const invalid = validatePermissionAnswer(answer)
        if (invalid) {
          return { ok: false, error: fail('ANSWER_INVALID', `Refusing to send invalid permission answer: ${invalid}`, 'control', 'none') }
        }
        return { ok: true, value: answer }
      }
      return { ok: false, error: fail('HOST_REFUSED', 'Certification runner refuses permission request (policy=refuse; captured only).', 'control', 'none') }
    }
    if (method === 'interaction/requestUserInput') {
      // N09 lane: question + plan-approval reverse requests. Captured always;
      // answered at most once per arming via the shared policy helper.
      return handleUserInputRequest(params)
    }
    // Certification runner never auto-allows host requests — explicit refusal.
    return { ok: false, error: fail('HOST_REFUSED', `Certification runner refuses host request ${method}.`, 'control', 'none') }
  },
  onDisconnect: (error) => {
    disconnected = error.toJSON()
  },
})
log.client = { generation: client.generation }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function call(row, method, params, c = client) {
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, error: { code: 'ROW_REFUSED', safeMessage: `Method ${method} outside free certification rows.` } }
  }
  log.envelopeLog.push({ dir: 'out', kind: 'request', method })
  const started = Date.now()
  const result = await c.request(method, params)
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
      environment: launchEnvironment,
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
  if (sessionArg) {
    // Operator-supplied native session (N13/N15/N16/N17 reuse a turn-bearing
    // session instead of seeding one in-row). Validated against session/read
    // before any row drives it — an unreadable SID is a hard skip, never guessed.
    // 2026-09-29 N13 run-1 discovery: a persisted turn-bearing session is
    // VISIBLE in session/list but cold read/send answer NATIVE_-32004 until it
    // is RESUMED into this runtime (the N16 restart mechanism). Resume once,
    // then re-read; still unreadable → hard skip.
    let check = await client.request('session/read', { sessionId: sessionArg })
    if (!check.ok && String(check.error?.code ?? '').includes('32004')) {
      const resumed = await client.request('session/resume', { sessionId: sessionArg, workspace: W })
      log.sessionArgResume = resumed.ok ? { ok: true, keys: Object.keys(resumed.value ?? {}) } : resumed.error.toJSON()
      if (resumed.ok) check = await client.request('session/read', { sessionId: sessionArg })
    }
    if (!check.ok) {
      record('session-setup', {
        skipped: `--session ${sessionArg} unreadable`,
        error: check.error.toJSON(),
      })
    } else {
      sessionId = sessionArg
      log.sessionId = sessionId
      log.sessionIdSource = '--session argument (operator-supplied, turn-bearing reuse)'
      const ws = check.value?.session?.workspace?.workspacePath
      log.sessionArgWorkspace = ws ?? null
      const norm = (p) => path.resolve(String(p)).toLowerCase()
      log.sessionArgWorkspaceMatchesWorkspace = typeof ws === 'string' && norm(ws) === norm(workspace)
    }
  }
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

  // ---- Shared paid-row driver helpers (N09–N17). Shapes cited per driver are
  // extracted from the installed bundle's zod schemas (2026-09-29 session) and
  // the r5 captures; every parse fails closed with a named error.
  /** Current projection snapshot via session/read (config-only). */
  async function projectionNow(c = client, sid = sessionId) {
    const r = await c.request('session/read', { sessionId: sid })
    if (!r.ok || !r.value || typeof r.value !== 'object') return { ok: false, error: r.error.toJSON() }
    return { ok: true, projection: r.value.projection ?? null, runtime: r.value.runtime ?? null, session: r.value.session ?? null, settings: r.value.settings ?? null, messages: r.value.messages ?? null }
  }
  /** Generalized two-stage settle (the 2026-09-19 dead-on-arrival fix, extended
   * for turn-bearing sessions): stage 1 waits for liveness RELATIVE TO A
   * BASELINE (fresh sessions: turnCount 0 -> >=1; reused sessions: revision or
   * turnCount must ADVANCE, else a stale 'idle' projection would read as a
   * false terminal); stage 2 waits for terminal + no pending reverse work. */
  async function settleTurn(c = client, sid = sessionId, baseline = null) {
    const start = Date.now()
    const base =
      baseline ??
      (await (async () => {
        const p = await projectionNow(c, sid)
        return p.ok ? { turnCount: p.projection?.turnCount ?? 0, stateRevision: p.runtime?.stateRevision ?? 0 } : { turnCount: 0, stateRevision: 0 }
      })())
    // 2026-09-29 N09 run-1 postmortem: session/send acceptance ITSELF bumps
    // stateRevision, so a pre-send baseline makes revAdvanced fire instantly —
    // stage 1 passed on the lagging idle projection, stage 2 read a FALSE
    // terminal in 200ms, and the next leg's send hit the still-live turn
    // (NATIVE_-32010). stateRevision is therefore NOT liveness evidence;
    // liveness is status 'running' or an advanced turnCount (turns only).
    const sawRunning = await until(async () => {
      const p = await projectionNow(c, sid)
      if (!p.ok || !p.projection) return false
      const turnAdvanced = typeof p.projection.turnCount === 'number' && p.projection.turnCount > base.turnCount
      return p.projection.status === 'running' || turnAdvanced
    }, 20000, 250)
    const runningAtMs = sawRunning ? Date.now() - start : null
    const sawTerminal = sawRunning
      ? await until(async () => {
          const p = await projectionNow(c, sid)
          return (
            p.ok &&
            p.projection &&
            p.projection.status !== 'running' &&
            p.runtime &&
            Array.isArray(p.runtime.pendingRequestIds) &&
            p.runtime.pendingRequestIds.length === 0
          )
        }, 180000, 1000)
      : false
    return { sawRunning, runningAtMs, sawTerminal, withinMs: Date.now() - start, baseline: base }
  }
  const readFileOrNull = (p) => readFile(p, 'utf8').then((t) => t.trim()).catch(() => null)
  const listWorkspaceFiles = async () => {
    const fs = await import('node:fs')
    return fs.promises.readdir(workspace).then((files) => files.filter((f) => !f.startsWith('.')).sort()).catch(() => null)
  }
  /** N13/N15/N16/N17 precondition: the session must already have executed a
   * turn (the 2026-09-28 N16 run proved unexecuted sessions are never
   * persisted — resume answers -32004 sessionUnavailable). If turnCount < 1,
   * seed exactly one sentinel turn, counted against THIS row's cap. */
  async function ensureTurnBearingSession(row) {
    const before = await projectionNow()
    const turnCount = before.ok && before.projection ? before.projection.turnCount : null
    if (typeof turnCount === 'number' && turnCount >= 1) {
      return { reused: true, turnCount, workspaceCheck: before.ok && before.session ? { workspacePath: before.session.workspace?.workspacePath ?? null, matchesWorkspace: String(before.session.workspace?.workspacePath ?? '').toLowerCase() === path.resolve(workspace).toLowerCase() } : null }
    }
    const task = `zk16-${row.toLowerCase()} seed ${Date.now()}: create a file named SENTINEL-${row}.txt containing exactly the word ok. Do nothing else.`
    const permAtStart = (log.permissionRequests || []).length
    permissionPolicy = 'allow'
    const send = await call(row, 'session/send', { sessionId, content: task })
    const accepted = send && send.result && send.result.accepted === true
    if (accepted) await countModelTurn(row)
    const settle = await settleTurn()
    permissionPolicy = 'refuse'
    const sentinel = await readFileOrNull(path.join(workspace, `SENTINEL-${row}.txt`))
    const after = await projectionNow()
    return {
      reused: false,
      seededBy: row,
      send: redact(send),
      accepted,
      settle,
      permissionsAnswered: (log.permissionRequests || []).length - permAtStart,
      sentinel: { file: `SENTINEL-${row}.txt`, content: sentinel },
      turnCount: after.ok && after.projection ? after.projection.turnCount : null,
    }
  }
  /** v4/conversation/subscribe on the given client; returns the captured ack
   * shape {subscriptionId, mode?, logEpoch, ...} or a named error. */
  async function v4Subscribe(c = client, sid = sessionId) {
    const res = await c.request('v4/conversation/subscribe', {
      topic: `conversation/${sid}`,
      connectionId: c.generation,
      clientMode: 'desktop-continuous',
    })
    const ack = res.ok && res.value && typeof res.value === 'object' && res.value.ack && typeof res.value.ack === 'object' ? res.value.ack : null
    const subscriptionId = ack && typeof ack.subscriptionId === 'string' ? ack.subscriptionId : null
    const logEpoch = ack && typeof ack.logEpoch === 'string' ? ack.logEpoch : null
    return { ok: res.ok && Boolean(subscriptionId) && Boolean(logEpoch), subscriptionId, logEpoch, ack: ack ? redact(ack) : null, error: res.ok ? null : res.error.toJSON() }
  }
  /** v4/conversation/rowsRange (bundle zod I0r params {sessionId, clientMode?,
   * beforeRowId?, limit 1..200}); validates the captured result sEc {rows[],
   * atSeq, atRevision, atLogEpoch, hasMore} fail-closed. */
  async function rowsRangePage(row, c = client, sid = sessionId, beforeRowId = undefined) {
    const params = { sessionId: sid, topic: `conversation/${sid}`, limit: 200, ...(beforeRowId !== undefined ? { beforeRowId } : {}) }
    const res = await call(row, 'v4/conversation/rowsRange', params, c)
    const v = res.result
    const issue = !v || typeof v !== 'object'
      ? 'result missing'
      : ['rows', 'atSeq', 'atRevision', 'atLogEpoch', 'hasMore'].some((k) => !(k in v))
        ? `result missing sEc keys (got ${Object.keys(v).join(',')})`
        : !Array.isArray(v.rows)
          ? 'rows not an array'
          : v.rows.some((r) => !r || typeof r !== 'object' || typeof r.rowId !== 'number')
            ? 'row entry missing numeric rowId (base row schema Wj)'
            : null
    return { entry: res, valid: !issue, issue, rows: issue ? null : v.rows, meta: issue ? null : { atSeq: v.atSeq, atRevision: v.atRevision, atLogEpoch: v.atLogEpoch, hasMore: v.hasMore } }
  }
  /** v4/command with the checklist C-prefix params + bundle envelope keys.
   * Validates the ACK against bundle zod Ues {commandId, status, reasonCode?,
   * message?, revisionAtDecision, result?} fail-closed. */
  async function v4CommandSend(row, type, extra = {}) {
    const params = {
      commandId: `zk16-${row.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      clientId: 'kimaki-zcode',
      sessionId,
      issuedAt: Date.now(),
      connectionId: client.generation,
      clientMode: 'desktop-continuous',
      type,
      ...extra,
    }
    const entry = await call(row, 'v4/command', params)
    const ack = entry.result
    const issue = !ack || typeof ack !== 'object'
      ? 'ack missing'
      : Object.keys(ack).some((k) => !['memoryEnabled', 'ttftExcluded', 'commandId', 'status', 'reasonCode', 'message', 'revisionAtDecision', 'result'].includes(k))
        ? `unknown ack key(s) ${Object.keys(ack).filter((k) => !['memoryEnabled', 'ttftExcluded', 'commandId', 'status', 'reasonCode', 'message', 'revisionAtDecision', 'result'].includes(k)).join(',')}`
        : !['accepted', 'rejected', 'stale', 'duplicate', 'noop', 'failed'].includes(ack.status)
          ? `unknown status '${ack.status}'`
          : typeof ack.revisionAtDecision !== 'number'
            ? 'revisionAtDecision missing/non-number'
            : null
    return { entry, ack, valid: !issue, issue, commandId: params.commandId }
  }
  /** Second owned runtime + gen-2 client for restart rows (N15/N16/N17).
   * Shares the log arrays (gen: 2) and both interaction policies. Every launch
   * is tracked (module-scope secondRuntimes) so the finally block can never
   * leak a second owned process. */
  async function startSecondRuntime() {
    const second = await startOwnedRuntime({
      executable,
      entryPath,
      args: [entryPath, 'app-server'],
      cwd: workspace,
      executableSha256: log.profile.executableSha256,
      entrySha256: log.profile.entrySha256,
      environment: launchEnvironment,
      startupMs: 30000,
      graceMs: 5000,
    })
    if (!second.ok) return { ok: false, error: second.error.toJSON() }
    secondRuntimes.push(second.value)
    const client2 = new NativeClient({
      input: second.value.input,
      output: second.value.output,
      timeoutMs,
      onNotification: (method, params) => {
        push(log.notifications, { at: Date.now(), method, params, gen: 2 })
        log.envelopeLog.push({ dir: 'in', kind: 'notification', method, gen: 2 })
      },
      onRequest: async (id, method, params) => {
        push(log.reverseRequests, { at: Date.now(), id, method, params, gen: 2 })
        log.envelopeLog.push({ dir: 'in', kind: 'request', id, method, gen: 2 })
        if (method === 'session/requestRuntimePreferences') {
          return { ok: true, value: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false } }
        }
        if (method === 'interaction/requestPermission') {
          log.permissionRequests = log.permissionRequests || []
          push(log.permissionRequests, { at: Date.now(), params, gen: 2 })
          if (permissionPolicy === 'allow' || permissionPolicy === 'deny') {
            const answer = { decision: permissionPolicy, reason: `ZK-016 gen-2 ${permissionPolicy} leg — disposable sentinel workspace, RECORDED 2026-09-18 opt-in` }
            const invalid = validatePermissionAnswer(answer)
            if (invalid) return { ok: false, error: fail('ANSWER_INVALID', `Refusing to send invalid permission answer: ${invalid}`, 'control', 'none') }
            return { ok: true, value: answer }
          }
          return { ok: false, error: fail('HOST_REFUSED', 'Certification runner refuses permission request (policy=refuse; captured only).', 'control', 'none') }
        }
        if (method === 'interaction/requestUserInput') return handleUserInputRequest(params, 2)
        return { ok: false, error: fail('HOST_REFUSED', `Certification runner refuses host request ${method}.`, 'control', 'none') }
      },
      onDisconnect: () => {},
    })
    return { ok: true, runtime: second.value, client: client2 }
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
      const hasCurrent = model && model.current && model.current.providerId
      const hasAvailable = model && Array.isArray(model.available) && model.available.length > 0
      advertised = hasCurrent || hasAvailable ? model : null
      pollTimeline.push({
        atMs: Date.now() - pollStarted,
        available: model && Array.isArray(model.available) ? model.available.length : 'missing',
        hasCurrent: Boolean(hasCurrent),
      })
      if (advertised) break
      await sleep(1000)
    }
    if (advertised) {
      // Captured schema (bundle zod OKe/mo): {sessionId, model:{providerId,
      // modelId, options?:{reasoningLevel}}, expectedRevision?,
      // persistAsWorkspaceLastUsed} .strict() — runtimeModel is NOT part of
      // the native protocol (checklist carried it over from the ACP layer).
      const entry = advertised.current?.providerId
        ? advertised.current
        : advertised.available[0]
      const ref = entry.ref ?? entry
      const meta = advertised.available.find(
        (a) => a.ref && a.ref.providerId === ref.providerId && a.ref.modelId === ref.modelId,
      )
      const reasoningLevel = meta?.reasoning?.defaultLevel ?? entry.options?.reasoningLevel
      const set = await call('N05', 'session/setModel', {
        sessionId,
        model: {
          providerId: ref.providerId,
          modelId: ref.modelId,
          ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
        },
        persistAsWorkspaceLastUsed: false,
      })
      const after = await call('N05', 'session/read', { sessionId })
      const readbackModel =
        after.result && after.result.settings ? after.result.settings.model : null
      const exact =
        readbackModel?.current?.providerId === ref.providerId &&
        readbackModel?.current?.modelId === ref.modelId &&
        (reasoningLevel
          ? readbackModel?.current?.options?.reasoningLevel === reasoningLevel
          : true)
      record('N05', {
        description: ALLOWED_ROWS.N05,
        advertisedModel: redact(advertised),
        requested: redact({ ...ref, ...(reasoningLevel ? { reasoningLevel } : {}) }),
        set,
        readback: after,
        exactReadback: exact,
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
    // Catalog populates asynchronously after create (observed 2-10s on
    // bundle 0.16.9); a single read races it and reports MODEL_UNAVAILABLE.
    // Poll bounded — config-only reads, no inference.
    let model = null
    for (let i = 0; i < 20 && !model; i++) {
      const read = await client.request('session/read', { sessionId })
      model =
        read.ok && read.value && typeof read.value === 'object' && read.value.settings
          ? read.value.settings.model
          : null
      const hasCurrent = model && model.current && model.current.providerId
      const hasAvailable = model && Array.isArray(model.available) && model.available.length
      if (hasCurrent || hasAvailable) break
      model = null
      await sleep(1000)
    }
    const current = model && model.current && model.current.providerId ? model.current : null
    if (current) return current
    if (model && Array.isArray(model.available) && model.available.length) {
      return model.available[0].ref ?? model.available[0]
    }
    return null
  }

  if (sessionId && rows.includes('N07')) {
    const task = taskText ?? `zk16-n07 sentinel ${Date.now()}: create a file named SENTINEL-N07.txt containing exactly the word ok. Do nothing else.`
    const model = await advertisedModel()
    if (!model) {
      record('N07', {
        description: PAID_ROWS.N07,
        notRun: 'MODEL_UNAVAILABLE',
        detail: 'no current/advertised model for this session. No turn spent.',
      })
    } else {
      // Captured schema (bundle zod TKe): {sessionId, content, ...}.strict() —
      // no runtimeModel key exists on the native protocol (divergence vs the
      // checklist/ACP vocabulary, recorded in the matrix).
      // N07 runs with allow-once answering so the sentinel write can complete;
      // the deny leg is N08's row (checklist order: N07 turn, N08 deny/allow).
      const permAtStart = (log.permissionRequests || []).length
      permissionPolicy = 'allow'
      const send = await call('N07', 'session/send', { sessionId, content: task })
      const accepted = send && send.result && send.result.accepted === true
      if (accepted) await countModelTurn('N07')
      // Bounded capture window: wait for the turn to settle, then read back.
      // IMPORTANT (2026-09-19 dead-on-arrival cluster fix): the projection
      // LAGS the accepted send by ~1-3s (status stays 'idle', turnCount 0
      // while context_initialization runs). Reading it immediately yields a
      // FALSE terminal — the runner then fires the next send into a live turn
      // ('active prompt exists') and stops the runtime mid-turn, killing it
      // in infancy (zero inference, no model-io). Stage 1: wait for liveness
      // (status 'running' or turnCount >= 1). Stage 2: only then wait terminal.
      const settleStart = Date.now()
      const sawRunning = await until(async () => {
        const r = await client.request('session/read', { sessionId })
        return (
          r.ok &&
          r.value &&
          typeof r.value === 'object' &&
          r.value.projection &&
          (r.value.projection.status === 'running' || r.value.projection.turnCount >= 1)
        )
      }, 20000, 250)
      const runningAtMs = sawRunning ? Date.now() - settleStart : null
      const sawTerminal = sawRunning
        ? await until(async () => {
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
          }, 180000, 1000)
        : false
      const readback = await call('N07', 'session/read', { sessionId })
      const fs = await import('node:fs')
      const sentinel = path.join(workspace, 'SENTINEL-N07.txt')
      const sentinelAfter = await fs.promises
        .readFile(sentinel, 'utf8')
        .then((t) => ({ exists: true, content: t.trim() }))
        .catch(() => ({ exists: false }))
      const listing = await fs.promises
        .readdir(workspace)
        .then((files) => files.filter((f) => !f.startsWith('.')))
      record('N07', {
        description: PAID_ROWS.N07,
        task: { text: task, unique: true, workspaceUnderTmp: true },
        advertisedModel: redact(model),
        send,
        turnCounted: Boolean(accepted),
        settle: { sawRunning, runningAtMs, sawTerminal, withinMs: Date.now() - settleStart },
        readback,
        permissions: {
          policy: 'allow-once (N08 machinery)',
          requestsAnswered: (log.permissionRequests || []).length - permAtStart,
        },
        sentinel: { file: 'SENTINEL-N07.txt', ...sentinelAfter, workspaceFiles: listing },
      })
      permissionPolicy = 'refuse'
    }
  }

  if (sessionId && rows.includes('N08')) {
    // Permission denial + explicit allow-once, per checklist N08: answer the
    // ORIGINAL native RPC id with a codec-validated deny, then an explicit
    // allow-once on a NEW request. Two row-owned turns (2 of this row's
    // 3-turn cap). Pass = deny leg leaves NO file + allow leg writes the file.
    const modelN08 = await advertisedModel()
    if (!modelN08) {
      record('N08', { description: PAID_ROWS.N08, notRun: 'MODEL_UNAVAILABLE', detail: 'no current/advertised model. No turn spent.' })
    } else {
      const readFileOrNull = (p) =>
        readFile(p, 'utf8').then((t) => t.trim()).catch(() => null)
      const settleTurn = async () => {
        const start = Date.now()
        const sawRunning = await until(async () => {
          const r = await client.request('session/read', { sessionId })
          return (
            r.ok &&
            r.value &&
            typeof r.value === 'object' &&
            r.value.projection &&
            (r.value.projection.status === 'running' || r.value.projection.turnCount >= 1)
          )
        }, 20000, 250)
        const runningAtMs = sawRunning ? Date.now() - start : null
        const saw = sawRunning
          ? await until(async () => {
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
            }, 180000, 1000)
          : false
        return { sawRunning, runningAtMs, sawTerminal: saw, withinMs: Date.now() - start }
      }
      // Leg A — denial: answer the real request with decision 'deny'.
      const permBeforeDeny = (log.permissionRequests || []).length
      permissionPolicy = 'deny'
      const taskDeny = `zk16-n08 deny ${Date.now()}: create a file named SENTINEL-N08-DENY.txt containing exactly the word ok. Do nothing else.`
      const sendDeny = await call('N08', 'session/send', { sessionId, content: taskDeny })
      if (sendDeny && sendDeny.result && sendDeny.result.accepted === true) await countModelTurn('N08')
      const settleDeny = await settleTurn()
      const denyFile = await readFileOrNull(path.join(workspace, 'SENTINEL-N08-DENY.txt'))
      // Leg B — explicit allow-once on a fresh request.
      const permBeforeAllow = (log.permissionRequests || []).length
      permissionPolicy = 'allow'
      const taskAllow = `zk16-n08 allow ${Date.now()}: create a file named SENTINEL-N08-ALLOW.txt containing exactly the word ok. Do nothing else.`
      const sendAllow = await call('N08', 'session/send', { sessionId, content: taskAllow })
      if (sendAllow && sendAllow.result && sendAllow.result.accepted === true) await countModelTurn('N08')
      const settleAllow = await settleTurn()
      const allowFile = await readFileOrNull(path.join(workspace, 'SENTINEL-N08-ALLOW.txt'))
      permissionPolicy = 'refuse'
      record('N08', {
        description: PAID_ROWS.N08,
        denyLeg: {
          send: sendDeny,
          settle: settleDeny,
          fileWritten: denyFile !== null,
          fileContent: denyFile,
          permissionRequestsCaptured: (log.permissionRequests || []).length - permBeforeDeny,
        },
        allowLeg: {
          send: sendAllow,
          settle: settleAllow,
          fileWritten: allowFile !== null,
          fileContent: allowFile,
          permissionRequestsCaptured: (log.permissionRequests || []).length - permBeforeAllow,
        },
        permissionRequestSample: redact((log.permissionRequests || []).slice(-1)[0] ?? null),
        pass: denyFile === null && allowFile !== null && settleDeny.sawTerminal && settleAllow.sawTerminal,
      })
    }
  }

  if (sessionId && rows.includes('N09')) {
    // Checklist N09 — question and plan round trip. Cause a GENUINE native
    // question (AskUserQuestion -> interaction/requestUserInput) and a plan
    // approval (ExitPlanMode in plan mode -> requestUserInput with schema.
    // interaction='plan_approval'); reply to their ORIGINAL reverse-request ids
    // with answers validated against the bundle answer schema (CYe). Never
    // session/send the answer. A leg where the model never asks is NOT a pass.
    const modelN09 = await advertisedModel()
    if (!modelN09) {
      record('N09', { description: PAID_ROWS.N09, notRun: 'MODEL_UNAVAILABLE', detail: 'no current/advertised model. No turn spent.' })
    } else {
      // Leg A — question. The model must ask via AskUserQuestion; the runner
      // answers the FIRST captured question once, choosing the first option.
      const permBeforeA = (log.permissionRequests || []).length
      const uiBeforeA = (log.userInputRequests || []).length
      userInputPolicy = {
        mode: 'answer',
        used: false,
        buildAnswer: (params) => {
          const invalid = validateUserInputRequest(params)
          if (invalid) return { action: 'decline', reason: `ZK-016 N09 fail-closed: ${invalid}` }
          const q = params.questions[0]
          const chosen = q.options[0]
          return { action: 'accept', content: { answers: { [q.question]: chosen.value }, answer_0: chosen.value } }
        },
      }
      permissionPolicy = 'allow' // the post-answer file write is a tool side effect
      const taskQ = `zk16-n09 question ${Date.now()}: Use the AskUserQuestion tool exactly once to ask me: "Which color should the file be?" with options "red" and "blue". After you receive my answer, create a file named SENTINEL-N09.txt containing exactly the chosen color word and nothing else. Do nothing else.`
      const baseA = await projectionNow()
      const baselineA = baseA.ok ? { turnCount: baseA.projection?.turnCount ?? 0, stateRevision: baseA.runtime?.stateRevision ?? 0 } : { turnCount: 0, stateRevision: 0 }
      const sendQ = await call('N09', 'session/send', { sessionId, content: taskQ })
      const acceptedQ = sendQ && sendQ.result && sendQ.result.accepted === true
      if (acceptedQ) await countModelTurn('N09')
      const settleQ = await settleTurn(client, sessionId, baselineA)
      const questionFile = await readFileOrNull(path.join(workspace, 'SENTINEL-N09.txt'))
      const uiAfterA = (log.userInputRequests || []).slice(uiBeforeA)
      userInputPolicy = { mode: 'refuse' }
      const questionLeg = {
        send: sendQ,
        settle: settleQ,
        userInputsCaptured: uiAfterA.length,
        userInputSample: redact(uiAfterA[0] ?? null),
        answeredOnce: uiAfterA.length >= 1,
        asked: uiAfterA.some((u) => {
          const p = u.params
          return p && Array.isArray(p.questions) && !(p.schema && p.schema.interaction === 'plan_approval')
        }),
        file: { written: questionFile !== null, content: questionFile },
        permissionsAnswered: (log.permissionRequests || []).length - permBeforeA,
      }
      // Leg B — plan approval. Plan mode via session/setMode (config-only),
      // ExitPlanMode triggers the plan_approval requestUserInput; answer
      // accept/approve (bundle QZa path: content.answers keyed by the fixed
      // plan question -> 'approve').
      const setModePlan = await call('N09', 'session/setMode', { sessionId, mode: 'plan' })
      const permBeforeB = (log.permissionRequests || []).length
      const uiBeforeB = (log.userInputRequests || []).length
      userInputPolicy = {
        mode: 'answer',
        used: false,
        buildAnswer: (params) => {
          const invalid = validateUserInputRequest(params)
          if (invalid) return { action: 'decline', reason: `ZK-016 N09 fail-closed: ${invalid}` }
          if (!(params.schema && params.schema.interaction === 'plan_approval')) {
            return { action: 'decline', reason: 'ZK-016 N09 plan leg expected schema.interaction=plan_approval; refusing to answer a different form' }
          }
          return { action: 'accept', content: { answers: { 'Review this implementation plan.': 'approve' } } }
        },
      }
      permissionPolicy = 'allow'
      const taskP = `zk16-n09 plan ${Date.now()}: Call the ExitPlanMode tool exactly once with the one-line plan "create SENTINEL-N09-PLAN.txt containing ok". After the plan is approved, create the file SENTINEL-N09-PLAN.txt containing exactly the word ok. Do nothing else.`
      const baseB = await projectionNow()
      const baselineB = baseB.ok ? { turnCount: baseB.projection?.turnCount ?? 0, stateRevision: baseB.runtime?.stateRevision ?? 0 } : { turnCount: 0, stateRevision: 0 }
      const sendP = await call('N09', 'session/send', { sessionId, content: taskP })
      const acceptedP = sendP && sendP.result && sendP.result.accepted === true
      if (acceptedP) await countModelTurn('N09')
      const settleP = await settleTurn(client, sessionId, baselineB)
      const planFile = await readFileOrNull(path.join(workspace, 'SENTINEL-N09-PLAN.txt'))
      const uiAfterB = (log.userInputRequests || []).slice(uiBeforeB)
      userInputPolicy = { mode: 'refuse' }
      permissionPolicy = 'refuse'
      const setModeBuild = await call('N09', 'session/setMode', { sessionId, mode: 'build' })
      const planLeg = {
        setModePlan,
        send: sendP,
        settle: settleP,
        userInputsCaptured: uiAfterB.length,
        userInputSample: redact(uiAfterB[0] ?? null),
        planApprovalAsked: uiAfterB.some((u) => u.params?.schema?.interaction === 'plan_approval'),
        answeredOnce: uiAfterB.length >= 1,
        file: { written: planFile !== null, content: planFile },
        permissionsAnswered: (log.permissionRequests || []).length - permBeforeB,
        setModeBack: setModeBuild,
      }
      record('N09', {
        description: PAID_ROWS.N09,
        turnsCounted: Number(Boolean(acceptedQ)) + Number(Boolean(acceptedP)),
        questionLeg,
        planLeg,
        // The ORIGINAL turn must continue after the answer (terminal settle with
        // the sentinel written by the model, never an outer LLM answer).
        pass:
          questionLeg.asked &&
          questionLeg.answeredOnce &&
          settleQ.sawTerminal &&
          questionLeg.file.written &&
          planLeg.planApprovalAsked &&
          planLeg.answeredOnce &&
          settleP.sawTerminal &&
          planLeg.file.written,
      })
    }
  }

  if (sessionId && rows.includes('N10')) {
    // Checklist N10 — active text guidance. While a controlled task is
    // demonstrably active, send v4/command C-prefix params, type:sendText,
    // payload:{text, requestedDelivery:"guide"}. Capture the command decision
    // (ACK Ues: status + revisionAtDecision + result.inputAccepted.delivery)
    // and the steer correlation (turn.steerQueued/turn.steerDrained in the
    // session/events lane, or their captured absence — never invented).
    const modelN10 = await advertisedModel()
    if (!modelN10) {
      record('N10', { description: PAID_ROWS.N10, notRun: 'MODEL_UNAVAILABLE', detail: 'no current/advertised model. No turn spent.' })
    } else {
      const sub = await v4Subscribe()
      const permBefore = (log.permissionRequests || []).length
      permissionPolicy = 'allow'
      const task = `zk16-n10 ${Date.now()}: Run ONE bash command that sleeps 25 seconds and then creates a file named SENTINEL-N10.txt containing exactly the word ok, and wait for it to finish. Do nothing else.`
      const base = await projectionNow()
      const baseline = base.ok ? { turnCount: base.projection?.turnCount ?? 0, stateRevision: base.runtime?.stateRevision ?? 0 } : { turnCount: 0, stateRevision: 0 }
      const send = await call('N10', 'session/send', { sessionId, content: task })
      const accepted = send && send.result && send.result.accepted === true
      if (accepted) await countModelTurn('N10')
      // Stage 1 liveness ONLY (guide must land while the turn is demonstrably
      // active — the sleep gives a wide window).
      const active = await until(async () => {
        const p = await projectionNow()
        return p.ok && p.projection && p.projection.status === 'running'
      }, 20000, 200)
      const guideText = `Guidance: do not wait for the sleep to finish. Create the file SENTINEL-N10-GUIDE.txt containing exactly the word steered, then finish immediately.`
      const guide = active ? await v4CommandSend('N10', 'sendText', { payload: { text: guideText, requestedDelivery: 'guide' } }) : null
      const guideAck = guide && guide.valid ? guide.ack : null
      const settle = await settleTurn(client, sessionId, baseline)
      const fileMain = await readFileOrNull(path.join(workspace, 'SENTINEL-N10.txt'))
      const fileGuide = await readFileOrNull(path.join(workspace, 'SENTINEL-N10-GUIDE.txt'))
      permissionPolicy = 'refuse'
      // Steer correlation from the legacy event lane (bundle enum L5i includes
      // turn.steerQueued / turn.steerDrained; their absence is recorded).
      const events = await call('N10', 'session/events', { sessionId, limit: 200 })
      const eventRows = events.result && Array.isArray(events.result.events) ? events.result.events : []
      const steerKinds = eventRows.filter((e) => e && typeof e === 'object' && typeof e.kind === 'string' && e.kind.startsWith('turn.steer')).map((e) => redact(e))
      record('N10', {
        description: PAID_ROWS.N10,
        v4Subscription: { ok: sub.ok, logEpoch: sub.logEpoch, subscriptionId: sub.subscriptionId },
        send,
        turnCounted: Boolean(accepted),
        activeWhenGuided: Boolean(active),
        guide: guide
          ? { valid: guide.valid, issue: guide.issue, ack: redact(guideAck), commandId: guide.commandId, delivery: guideAck?.result?.delivery ?? null, status: guideAck?.status ?? null, revisionAtDecision: guideAck?.revisionAtDecision ?? null }
          : { skipped: 'turn never demonstrably active (stage-1 liveness window elapsed)' },
        settle,
        steer: { kindsObserved: [...new Set(eventRows.map((e) => e?.kind).filter(Boolean))], steerEvents: steerKinds, correlated: steerKinds.length > 0 },
        sentinels: { main: { written: fileMain !== null, content: fileMain }, guide: { written: fileGuide !== null, content: fileGuide } },
        permissionsAnswered: (log.permissionRequests || []).length - permBefore,
        // PASS is the command decision on an active turn + captured
        // correlation evidence — never model obedience to the guide text.
        pass: Boolean(active && guide && guide.valid && guideAck && ['accepted', 'duplicate'].includes(guideAck.status) && settle.sawTerminal),
      })
    }
  }

  if (sessionId && rows.includes('N11')) {
    // Checklist N11 — stop with a real background writer. Spawn a background
    // bash ticker, let the foreground turn settle, then stop via v4/command
    // type:stop (C-prefix params) and cancel every recorded owned background
    // task id via session/cancelBackgroundTask {sessionId, taskId}; prove the
    // ticks CEASED. No workspace release on ACK alone.
    const modelN11 = await advertisedModel()
    if (!modelN11) {
      record('N11', { description: PAID_ROWS.N11, notRun: 'MODEL_UNAVAILABLE', detail: 'no current/advertised model. No turn spent.' })
    } else {
      const sub = await v4Subscribe()
      const permBefore = (log.permissionRequests || []).length
      permissionPolicy = 'allow'
      const task = `zk16-n11 ${Date.now()}: Start exactly ONE background bash task that runs this command and does not block you: for i in $(seq 1 120); do echo $i >> TICK-N11.txt; sleep 1; done . Return immediately after starting it. Do nothing else.`
      const base = await projectionNow()
      const baseline = base.ok ? { turnCount: base.projection?.turnCount ?? 0, stateRevision: base.runtime?.stateRevision ?? 0 } : { turnCount: 0, stateRevision: 0 }
      const send = await call('N11', 'session/send', { sessionId, content: task })
      const accepted = send && send.result && send.result.accepted === true
      if (accepted) await countModelTurn('N11')
      const settle = await settleTurn(client, sessionId, baseline)
      permissionPolicy = 'refuse'
      // Bounded wait for the background job to materialize in the projection
      // (captured shape so far: backgroundJobs always []; entries are expected
      // to carry taskId per bundle qsr — validated, never guessed).
      let backgroundJobs = []
      const jobsSeen = await until(async () => {
        const p = await projectionNow()
        backgroundJobs = p.ok && p.projection && Array.isArray(p.projection.backgroundJobs) ? p.projection.backgroundJobs : []
        return backgroundJobs.length > 0
      }, 20000, 500)
      const tickFile = path.join(workspace, 'TICK-N11.txt')
      const ticksBefore = await readFileOrNull(tickFile)
      const jobShapeIssue = backgroundJobs.length && backgroundJobs.some((j) => !j || typeof j !== 'object' || typeof j.taskId !== 'string')
        ? 'backgroundJobs entry missing string taskId (bundle qsr) — cancel leg refused'
        : null
      const taskIds = jobShapeIssue ? [] : backgroundJobs.map((j) => j.taskId)
      const stop = await v4CommandSend('N11', 'stop', { payload: {} })
      const cancels = []
      for (const taskId of taskIds) {
        cancels.push({ taskId, result: await call('N11', 'session/cancelBackgroundTask', { sessionId, taskId }) })
      }
      // Cessation window: the ticker appends once per second; 4s with a stable
      // count is cessation evidence.
      await sleep(4000)
      const ticksAfter = await readFileOrNull(tickFile)
      await sleep(2500)
      const ticksAfter2 = await readFileOrNull(tickFile)
      const subagents = await call('N11', 'session/subagents', { sessionId, endedLimit: 50 })
      const finalRead = await projectionNow()
      const cancelResultShape = cancels.map((c) => {
        const v = c.result.result
        const issue = !v || typeof v !== 'object'
          ? 'result missing'
          : ['cancelled', 'status', 'taskId'].some((k) => !(k in v))
            ? `missing X5i keys (got ${v ? Object.keys(v).join(',') : 'null'})`
            : null
        return { taskId: c.taskId, cancelled: issue ? null : v.cancelled === true, status: issue ? null : v.status, shapeIssue: issue }
      })
      record('N11', {
        description: PAID_ROWS.N11,
        v4Subscription: { ok: sub.ok, logEpoch: sub.logEpoch },
        send,
        turnCounted: Boolean(accepted),
        settle,
        backgroundJobs: { observed: jobsSeen, count: backgroundJobs.length, shapeIssue: jobShapeIssue, jobs: redact(backgroundJobs), taskIds },
        stopCommand: { valid: stop.valid, issue: stop.issue, ack: redact(stop.ack ?? null) },
        cancels: redact(cancels),
        cancelResultShape,
        ticks: { before: ticksBefore, after4s: ticksAfter, after65s: ticksAfter2, ceased: ticksAfter !== null && ticksAfter2 !== null && ticksAfter === ticksAfter2 },
        subagents,
        finalStatus: finalRead.ok && finalRead.projection ? finalRead.projection.status : null,
        permissionsAnswered: (log.permissionRequests || []).length - permBefore,
        pass:
          settle.sawTerminal &&
          jobsSeen &&
          !jobShapeIssue &&
          stop.valid &&
          ['accepted', 'duplicate', 'noop'].includes(stop.ack?.status) &&
          cancelResultShape.length > 0 &&
          cancelResultShape.every((c) => c.cancelled === true && !c.shapeIssue) &&
          ticksBefore !== null &&
          ticksAfter !== null &&
          ticksAfter2 !== null &&
          ticksAfter === ticksAfter2,
      })
    }
  }

  if (sessionId && rows.includes('N12')) {
    // Checklist N12 — background and goal settlement. Goal work via the
    // installed mechanism only: session/goal with bundle zsr actions
    // {show,set,replace,pause,resume,clear} — enums from the bundle, never
    // analogy. Inspect session/subagents {sessionId, endedLimit:50}; capture
    // goalVerifications settlement; explicit verified cancellation via clear.
    const modelN12 = await advertisedModel()
    if (!modelN12) {
      record('N12', { description: PAID_ROWS.N12, notRun: 'MODEL_UNAVAILABLE', detail: 'no current/advertised model. No turn spent.' })
    } else {
      const goalResultShape = (v) => {
        const issue = !v || typeof v !== 'object'
          ? 'result missing'
          : ['response', 'snapshot'].some((k) => !(k in v))
            ? `missing Y5i keys (got ${v ? Object.keys(v).join(',') : 'null'})`
            : typeof v.response !== 'string'
              ? 'response not a string'
              : null
        return { issue, startedTurn: issue ? null : v.startedTurn === true }
      }
      const permBefore = (log.permissionRequests || []).length
      permissionPolicy = 'allow'
      const objective = `The file GOAL-N12.txt exists containing exactly the word done. Verify it and then stop working on the goal.`
      const goalSet = await call('N12', 'session/goal', { sessionId, action: 'set', objective })
      const setShape = goalResultShape(goalSet.result)
      if (setShape.startedTurn) await countModelTurn('N12') // goal set started a continuation turn (conservative count)
      const base = await projectionNow()
      const baseline = base.ok ? { turnCount: base.projection?.turnCount ?? 0, stateRevision: base.runtime?.stateRevision ?? 0 } : { turnCount: 0, stateRevision: 0 }
      const settle1 = await settleTurn(client, sessionId, baseline)
      const goalFile = await readFileOrNull(path.join(workspace, 'GOAL-N12.txt'))
      const readAfterSet = await projectionNow()
      // 2026-09-29 N12 run-1 postmortem: the goal continuation keeps an ACTIVE
      // PROMPT after the projection is already idle+terminal — session/goal
      // show/clear were both rejected NATIVE_-32010 while verification was
      // still in flight (pendingRequestIds does not cover the goal lane).
      // Bounded wait for goal-lane RPC quiescence: show must stop rejecting.
      let showQuietValue = null
      let showLastError = null
      const showQuiet = await until(async () => {
        const s = await client.request('session/goal', { sessionId, action: 'show' })
        if (s.ok) {
          showQuietValue = s.value
          return true
        }
        showLastError = s.error.toJSON()
        return false
      }, 120000, 2000)
      const goalShow = showQuiet
        ? { at: new Date().toISOString(), method: 'session/goal', params: redact({ sessionId, action: 'show' }), result: redact(showQuietValue), note: 'first show after bounded goal-lane quiescence wait' }
        : await call('N12', 'session/goal', { sessionId, action: 'show' })
      if (!showQuiet) log.rows.N12GoalLaneNeverQuiet = { waitedMs: 120000, lastError: showLastError }
      // Explicit verified cancellation: clear, then prove the goal lane is idle.
      const goalClear = await call('N12', 'session/goal', { sessionId, action: 'clear' })
      const clearShape = goalResultShape(goalClear.result)
      if (clearShape.startedTurn) await countModelTurn('N12')
      const settle2 =
        clearShape.startedTurn === true
          ? await settleTurn(client, sessionId, baseline)
          : { skipped: 'clear did not start a continuation turn — nothing to settle' }
      permissionPolicy = 'refuse'
      const subagents = await call('N12', 'session/subagents', { sessionId, endedLimit: 50 })
      const readFinal = await projectionNow()
      record('N12', {
        description: PAID_ROWS.N12,
        goalSet: { raw: redact(goalSet), shape: setShape },
        settleAfterSet: settle1,
        goalFile: { written: goalFile !== null, content: goalFile },
        goalState: {
          goalVerifications: readAfterSet.ok ? redact(readAfterSet.runtime?.goalVerifications ?? []) : null,
          status: readAfterSet.ok && readAfterSet.projection ? readAfterSet.projection.status : null,
          turnCount: readAfterSet.ok && readAfterSet.projection ? readAfterSet.projection.turnCount : null,
        },
        subagents,
        goalShow: redact(goalShow),
        goalClear: { raw: redact(goalClear), shape: clearShape },
        settleAfterClear: settle2,
        finalState: readFinal.ok ? { status: readFinal.projection?.status ?? null, turnCount: readFinal.projection?.turnCount ?? null, goalVerifications: redact(readFinal.runtime?.goalVerifications ?? []) } : null,
        permissionsAnswered: (log.permissionRequests || []).length - permBefore,
        // Foreground terminal while job/goal active, then settlement or
        // explicit verified cancellation — shapes above, no invented enums.
        // Some observable goal activity is required (a started continuation
        // turn or recorded verifications); a trivially idle goal lane is not
        // settlement evidence.
        goalActivityObserved:
          setShape.startedTurn === true ||
          (readAfterSet.ok && Array.isArray(readAfterSet.runtime?.goalVerifications) && readAfterSet.runtime.goalVerifications.length > 0),
        pass:
          !setShape.issue &&
          !clearShape.issue &&
          (setShape.startedTurn === true || (readAfterSet.ok && Array.isArray(readAfterSet.runtime?.goalVerifications) && readAfterSet.runtime.goalVerifications.length > 0)) &&
          settle1.sawTerminal &&
          (settle2.skipped ? true : settle2.sawTerminal) &&
          typeof subagents.result === 'object' && subagents.result !== null,
      })
    }
  }

  if (sessionId && rows.includes('N13')) {
    // Checklist N13 — idle native compact. Quiescence first (two-stage settle
    // to terminal), session/compact {sessionId}, validate the captured result
    // (bundle Z5i {response, snapshot, compact?{state accepted|already_running}}),
    // then session/read: preserved SID/workspace/model, no automatic
    // continuation (status stays idle, no new user input follows).
    const seed = await ensureTurnBearingSession('N13')
    if (!seed.reused && !seed.accepted) {
      record('N13', { description: PAID_ROWS.N13, notRun: 'SEED_TURN_FAILED', detail: 'no turn-bearing session; seeding turn was not accepted. No compact attempted.', seed })
    } else {
      // Quiescence check (seed already settled): direct projection check, with
      // a full two-stage settle only if work is still visibly active.
      const q0 = await projectionNow()
      let quiescent = q0.ok && q0.projection && q0.projection.status !== 'running' && Array.isArray(q0.runtime?.pendingRequestIds) && q0.runtime.pendingRequestIds.length === 0
      const settle0 = quiescent ? { alreadyIdle: true } : await settleTurn()
      const pre = await projectionNow()
      const preBaseline = pre.ok ? { turnCount: pre.projection?.turnCount ?? 0, stateRevision: pre.runtime?.stateRevision ?? 0 } : { turnCount: 0, stateRevision: 0 }
      const compact = await call('N13', 'session/compact', { sessionId })
      const v = compact.result
      const issue = !v || typeof v !== 'object'
        ? 'result missing'
        : Object.keys(v).some((k) => !['response', 'snapshot', 'compact'].includes(k))
          ? `unknown key(s) ${Object.keys(v).filter((k) => !['response', 'snapshot', 'compact'].includes(k)).join(',')} (Z5i is strict)`
          : typeof v.response !== 'string'
            ? 'response not a string'
            : v.compact !== undefined && (!v.compact || typeof v.compact !== 'object' || !['accepted', 'already_running'].includes(v.compact.state))
              ? 'compact.state not accepted|already_running'
              : null
      if (!issue) await countModelTurn('N13') // compact runs the native summarizer — conservatively counted as a model turn
      const settle1 = await settleTurn(client, sessionId, preBaseline)
      const post = await projectionNow()
      const preSession = pre.ok ? pre.session : null
      const postSession = post.ok ? post.session : null
      record('N13', {
        description: PAID_ROWS.N13,
        seed,
        quiescentBefore: settle0,
        preState: pre.ok ? { sessionId: preSession?.sessionId ?? null, workspace: preSession?.workspace ?? null, model: redact(pre.settings?.model?.current ?? null), turnCount: pre.projection?.turnCount ?? null, messageCount: Array.isArray(pre.messages) ? pre.messages.length : null } : { error: pre.error },
        compact: { raw: redact(compact), shapeIssue: issue, compactState: v && v.compact ? v.compact.state : null },
        settleAfter: settle1,
        postState: post.ok ? { sessionId: postSession?.sessionId ?? null, workspace: postSession?.workspace ?? null, model: redact(post.settings?.model?.current ?? null), turnCount: post.projection?.turnCount ?? null, messageCount: Array.isArray(post.messages) ? post.messages.length : null, status: post.projection?.status ?? null } : { error: post.error },
        identityPreserved:
          pre.ok && post.ok &&
          preSession?.sessionId === postSession?.sessionId &&
          JSON.stringify(redact(preSession?.workspace ?? null)) === JSON.stringify(redact(postSession?.workspace ?? null)) &&
          JSON.stringify(redact(pre.settings?.model?.current ?? null)) === JSON.stringify(redact(post.settings?.model?.current ?? null)),
        noAutomaticContinuation: post.ok && post.projection ? post.projection.status === 'idle' : null,
        pass: !issue && settle1.sawTerminal && (post.ok && postSession?.sessionId === sessionId && post.projection?.status === 'idle'),
      })
    }
  }

  if (sessionId && rows.includes('N14')) {
    // Checklist N14 — conversation-only fork. rowsRange page schema (sEc),
    // paging via beforeRowId when hasMore, CAS fork via v4/command
    // type:forkAssistant payload{target{rowId,entityId}} baseRevision+
    // baseLogEpoch (bundle wPe REQUIRES both for CAS commands), nested child
    // SID from ACK result (Bes forkAssistant variant), child readback, and an
    // unchanged filesystem. No legacy session/fork, no guessed row metadata.
    const seed = await ensureTurnBearingSession('N14')
    if (!seed.reused && !seed.accepted) {
      record('N14', { description: PAID_ROWS.N14, notRun: 'SEED_TURN_FAILED', detail: 'no turn-bearing session; seeding turn was not accepted. No fork attempted.', seed })
    } else {
      // Quiescence before fork (seed already settled): direct projection check;
      // full two-stage settle only if work is still visibly active.
      const q0 = await projectionNow()
      const quiescent = q0.ok && q0.projection && q0.projection.status !== 'running' && Array.isArray(q0.runtime?.pendingRequestIds) && q0.runtime.pendingRequestIds.length === 0
      const settle0 = quiescent ? { alreadyIdle: true } : await settleTurn()
      const sub = await v4Subscribe()
      const filesBefore = await listWorkspaceFiles()
      const page1 = await rowsRangePage('N14')
      let page2 = null
      if (page1.valid && page1.meta.hasMore && page1.rows.length > 0) {
        page2 = await rowsRangePage('N14', client, sessionId, page1.rows[0].rowId)
      }
      const allRows = [...(page1.rows ?? []), ...(page2?.rows ?? [])]
      const kindCensus = {}
      for (const r of allRows) kindCensus[r.kind] = (kindCensus[r.kind] ?? 0) + 1
      const forkable = allRows.filter((r) => r.kind === 'assistantText' && typeof r.entityId === 'string' && r.entityId && r.actions && r.actions.canFork === true)
      let target = forkable.length ? forkable[forkable.length - 1] : null
      if (!sub.ok) {
        record('N14', { description: PAID_ROWS.N14, notRun: 'V4_SUBSCRIBE_FAILED', detail: 'no publisher logEpoch for the CAS fork; refusing to guess one.', subscribe: sub, seed })
      } else if (!page1.valid) {
        record('N14', { description: PAID_ROWS.N14, notRun: 'CAPTURE_SCHEMA_PENDING', detail: `rowsRange page schema unknown: ${page1.issue}. Fork stays disabled.`, seed, settle: settle0 })
      } else if (!target) {
        record('N14', {
          description: PAID_ROWS.N14,
          notRun: 'NO_FORKABLE_ROW',
          detail: 'no assistantText row with entityId + actions.canFork=true in the captured page (refusing to fork a row the server did not mark forkable).',
          kindCensus,
          rowsSample: redact(allRows.slice(0, 8)),
          seed,
        })
      } else {
        // CAS freshness: re-read the page right before the command; the fork
        // must target the CURRENT revision/epoch (stale -> CONTROL_STALE).
        let cas = null
        let attempt = 0
        for (; attempt < 3; attempt++) {
          const fresh = await rowsRangePage('N14')
          const sameTarget = fresh.valid && fresh.rows.some((r) => r.rowId === target.rowId && r.entityId === target.entityId)
          if (fresh.valid && sameTarget) {
            cas = fresh
            break
          }
          if (fresh.valid) {
            const again = fresh.rows.filter((r) => r.kind === 'assistantText' && typeof r.entityId === 'string' && r.entityId && r.actions && r.actions.canFork === true)
            if (again.length) target = again[again.length - 1]
            cas = fresh
            break
          }
        }
        if (!cas || !cas.valid) {
          record('N14', { description: PAID_ROWS.N14, notRun: 'CAS_REVALIDATION_FAILED', detail: `rowsRange re-read invalid on every attempt: ${cas ? cas.issue : 'no attempt succeeded'}.`, seed })
        } else {
          const fork = await v4CommandSend('N14', 'forkAssistant', {
            payload: { target: { rowId: target.rowId, entityId: target.entityId } },
            baseRevision: cas.meta.atRevision,
            baseLogEpoch: cas.meta.atLogEpoch,
          })
          const ack = fork.valid ? fork.ack : null
          const result = ack && ack.result && typeof ack.result === 'object' ? ack.result : null
          const childSid = result && result.type === 'forkAssistant' && typeof result.sessionId === 'string' ? result.sessionId : null
          const filesAfter = await listWorkspaceFiles()
          let childRead = null
          if (childSid) {
            const r = await client.request('session/read', { sessionId: childSid })
            childRead = r.ok ? redact({ sessionId: r.value?.session?.sessionId ?? null, status: r.value?.session?.status ?? null, workspace: r.value?.session?.workspace ?? null, model: r.value?.settings?.model?.current ?? null, turnCount: r.value?.projection?.turnCount ?? null }) : r.error.toJSON()
          }
          record('N14', {
            description: PAID_ROWS.N14,
            seed,
            settle: settle0,
            subscribe: { logEpoch: sub.logEpoch, subscriptionId: sub.subscriptionId },
            rowsRange: { page1: { valid: page1.valid, issue: page1.issue, meta: page1.meta, rowCount: page1.rows?.length ?? null }, page2: page2 ? { valid: page2.valid, meta: page2.meta, rowCount: page2.rows?.length ?? null } : null, kindCensus },
            target: target ? redact({ rowId: target.rowId, entityId: target.entityId, kind: target.kind, actions: target.actions ?? null }) : null,
            casAttempt: attempt,
            casMeta: cas.meta,
            epochMatchesSubscribe: cas.meta.atLogEpoch === sub.logEpoch,
            fork: { valid: fork.valid, issue: fork.issue, ack: redact(ack), childSid, resultType: result?.type ?? null, revisionAtDecision: ack?.revisionAtDecision ?? null },
            childRead,
            filesystem: { before: filesBefore, after: filesAfter, unchanged: JSON.stringify(filesBefore) === JSON.stringify(filesAfter) },
            pass: Boolean(
              fork.valid && ack && ack.status === 'accepted' && childSid && childSid !== sessionId &&
              childRead && typeof childRead === 'object' && !('code' in childRead) &&
              JSON.stringify(filesBefore) === JSON.stringify(filesAfter),
            ),
          })
        }
      }
    }
  }

  if (sessionId && rows.includes('N15')) {
    // Checklist N15 — image byte + resume retention. Only when the runtime
    // advertises an image-capable model (settings.model.available[].properties
    // .inputFormat.supportsImage — confirmed at runtime, never assumed). Sends
    // a fixed 1x1 PNG byte (sha256 recorded) via the captured attachment shape
    // (bundle Rar image: {kind,filename,mimeType,sizeBytes,dataBase64}
    // .strict()), proves the native retention echo (rows) and re-proves it
    // after a clean restart + session/resume with one explicit follow-up turn.
    const read15 = await projectionNow()
    const available15 = read15.ok && read15.settings && Array.isArray(read15.settings.model?.available) ? read15.settings.model.available : []
    const current15 = read15.ok ? read15.settings?.model?.current ?? null : null
    const entry15 = available15.find((a) => a && a.ref && current15 && a.ref.providerId === current15.providerId && a.ref.modelId === current15.modelId) ?? null
    const supportsImage = entry15?.properties?.inputFormat?.supportsImage === true
    if (!current15 || !entry15) {
      record('N15', { description: PAID_ROWS.N15, notRun: 'MODEL_UNAVAILABLE', detail: 'no current advertised model entry to inspect for image support. No turn spent.' })
    } else if (!supportsImage) {
      record('N15', { description: PAID_ROWS.N15, notRun: 'IMAGE_UNAVAILABLE', detail: 'current model does not advertise properties.inputFormat.supportsImage=true at runtime. Row refuses by design.', model: redact(current15), inputFormat: redact(entry15.properties?.inputFormat ?? null) })
    } else {
      // Fixed 1x1 transparent PNG (70 bytes) — deterministic bytes, hashed.
      const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
      const pngBytes = Buffer.from(pngBase64, 'base64')
      const pngSha256 = createHash('sha256').update(pngBytes).digest('hex')
      const attachment = { kind: 'image', filename: 'zk16-n15.png', mimeType: 'image/png', sizeBytes: pngBytes.length, dataBase64: pngBase64 }
      const permBefore = (log.permissionRequests || []).length
      permissionPolicy = 'allow'
      const task = `zk16-n15 ${Date.now()}: Look at the attached image. Reply with exactly one word naming what kind of visual it is (a dot). Then create a file named SENTINEL-N15.txt containing exactly that one word. Do nothing else.`
      const base = await projectionNow()
      const baseline = base.ok ? { turnCount: base.projection?.turnCount ?? 0, stateRevision: base.runtime?.stateRevision ?? 0 } : { turnCount: 0, stateRevision: 0 }
      const send = await call('N15', 'session/send', { sessionId, content: task, attachments: [attachment] })
      const accepted = send && send.result && send.result.accepted === true
      if (accepted) await countModelTurn('N15')
      const settle = await settleTurn(client, sessionId, baseline)
      const sentinel = await readFileOrNull(path.join(workspace, 'SENTINEL-N15.txt'))
      permissionPolicy = 'refuse'
      const sub = await v4Subscribe()
      const page = await rowsRangePage('N15')
      const echoRows = page.valid ? page.rows.filter((r) => r.kind === 'userInput' && Array.isArray(r.attachments) && r.attachments.length > 0) : []
      const echo = echoRows.length
        ? {
            found: true,
            attachments: redact(echoRows.flatMap((r) => r.attachments)),
            byteMatch: echoRows.some((r) => r.attachments.some((a) => a.bytes === attachment.sizeBytes && a.fileName === attachment.filename)),
          }
        : { found: false, detail: 'no userInput row carried an attachments[] echo in the captured page (retention NOT observed)' }
      // Resume retention: clean restart, same SID, echo must survive; one
      // explicit follow-up turn proves the image stayed in native context.
      const stopA = await runtime.stop()
      const second = await startSecondRuntime()
      if (!second.ok) {
        record('N15', {
          description: PAID_ROWS.N15,
          send,
          turnCounted: Boolean(accepted),
          settle,
          sentinel: { written: sentinel !== null, content: sentinel },
          image: { sha256: pngSha256, sizeBytes: pngBytes.length },
          retentionEcho: echo,
          restart: { stop: stopA.ok ? { ok: true } : { error: stopA.error.toJSON() }, secondLaunch: second.error },
          notRun: 'SECOND_LAUNCH_FAILED',
          detail: 'restart leg failed; retention-after-resume not tested.',
        })
      } else {
        const { runtime: runtime2, client: client2 } = second
        const resume = await client2.request('session/resume', { sessionId, workspace: W })
        const resumedId = resume.ok && resume.value && typeof resume.value === 'object' ? resume.value.session?.sessionId ?? null : null
        const page2 = await rowsRangePage('N15', client2)
        const echoRows2 = page2.valid ? page2.rows.filter((r) => r.kind === 'userInput' && Array.isArray(r.attachments) && r.attachments.length > 0) : []
        const echoAfterResume = echoRows2.length ? { found: true, byteMatch: echoRows2.some((r) => r.attachments.some((a) => a.bytes === attachment.sizeBytes)) } : { found: false }
        const permBefore2 = (log.permissionRequests || []).length
        permissionPolicy = 'allow'
        const followup = `Reply with exactly the same one word again. Do nothing else.`
        const base2 = await projectionNow(client2)
        const baseline2 = base2.ok ? { turnCount: base2.projection?.turnCount ?? 0, stateRevision: base2.runtime?.stateRevision ?? 0 } : { turnCount: 0, stateRevision: 0 }
        const send2 = await call('N15', 'session/send', { sessionId, content: followup }, client2)
        const accepted2 = send2 && send2.result && send2.result.accepted === true
        if (accepted2) await countModelTurn('N15')
        const settle2 = await settleTurn(client2, sessionId, baseline2)
        permissionPolicy = 'refuse'
        const readFinal = await projectionNow(client2)
        record('N15', {
          description: PAID_ROWS.N15,
          model: { current: redact(current15), supportsImage, inputFormat: redact(entry15.properties?.inputFormat ?? null) },
          image: { sha256: pngSha256, sizeBytes: pngBytes.length, mimeType: attachment.mimeType },
          attachmentSent: redact(attachment),
          send,
          turnCounted: Boolean(accepted),
          settle,
          sentinel: { written: sentinel !== null, content: sentinel },
          retentionEcho: echo,
          restart: {
            stop: stopA.ok ? { ok: true } : { error: stopA.error.toJSON() },
            resume: resume.ok ? { sameSid: resumedId === sessionId } : resume.error.toJSON(),
            echoAfterResume,
            followUp: { send: send2, accepted: accepted2 === true, settle: settle2 },
            finalTurnCount: readFinal.ok ? readFinal.projection?.turnCount ?? null : null,
          },
          permissionsAnswered: (log.permissionRequests || []).length - permBefore + ((log.permissionRequests || []).length - permBefore2),
          pass: Boolean(
            accepted && settle.sawTerminal && echo.found && echo.byteMatch &&
            resume.ok && resumedId === sessionId && echoAfterResume.found && echoAfterResume.byteMatch &&
            accepted2 && settle2.sawTerminal,
          ),
        })
        client2.dispose()
        const reap = await runtime2.stop()
        log.rows.N15.runtime2Stop = reap.ok ? { ok: true } : { error: reap.error.toJSON() }
        log.rows.N15.runtime2PidLivenessAfterStop = alive(runtime2.pid) ? 'ALIVE' : 'dead'
      }
    }
  }

  if (sessionId && rows.includes('N15R')) {
    // N15R — operator re-gate (decided 2026-09-30 by the goal-continuation
    // session, within the recorded caps; NO ledger amendment). Ruling: the
    // native retention echo is an ARTIFACT-STORE REFERENCE
    // (zcode-artifact://<session>/…, mime, stored bytes) — byte-identity of
    // the client's upload is not a protocol guarantee (same divergence class
    // as N05's runtimeModel). The re-gated contract: (a) the artifact-ref
    // echo is present in the session rows, (b) it survives resume into a
    // fresh owned runtime (the --session cold-resume above IS the restart
    // leg), and (c) ONE post-resume follow-up turn demonstrates visual
    // recall of the image. Counts against N15's remaining row cap (2/3 →
    // 3/3) via countModelTurn('N15').
    const page = await rowsRangePage('N15R')
    const echoRows = page.valid ? page.rows.filter((r) => r.kind === 'userInput' && Array.isArray(r.attachments) && r.attachments.length > 0) : []
    const refEcho = echoRows.length
      ? {
          found: true,
          attachments: redact(echoRows.flatMap((r) => r.attachments)),
          refMatch: echoRows.some((r) => r.attachments.some((a) => typeof a.ref === 'string' && a.ref.startsWith('zcode-artifact://') && a.mime === 'image/png')),
        }
      : { found: false, detail: 'no userInput row carried an attachments[] echo (retention NOT observed)' }
    const followup = 'Earlier in this conversation you were shown a tiny attached image. Reply with exactly one word naming what that image showed. Do nothing else.'
    const base = await projectionNow()
    const baseline = base.ok ? { turnCount: base.projection?.turnCount ?? 0, stateRevision: base.runtime?.stateRevision ?? 0 } : { turnCount: 0, stateRevision: 0 }
    const send = await call('N15R', 'session/send', { sessionId, content: followup })
    const accepted = send && send.result && send.result.accepted === true
    if (accepted) await countModelTurn('N15')
    const settle = await settleTurn(client, sessionId, baseline)
    const page2 = await rowsRangePage('N15R')
    const assistantTexts = page2.valid ? page2.rows.filter((r) => r.kind === 'assistantText' && typeof r.text === 'string').map((r) => r.text) : []
    const lastText = assistantTexts.length ? assistantTexts[assistantTexts.length - 1] : null
    const visualRecall = Boolean(lastText && /\bdot\b/i.test(lastText))
    record('N15R', {
      description: PAID_ROWS.N15R,
      operatorRuling:
        '2026-09-30: byte-identity is not the protocol retention contract; the artifact-ref echo + post-resume visual recall is. Combined with the 2026-09-29 N15 capture (image accepted, first-turn visual round-trip sentinel "dot", clean restart, same-SID resume, ref echo pre+post restart), this row completes the re-gated N15 evidence.',
      resumedSession: sessionId,
      retentionEcho: refEcho,
      send,
      turnCounted: Boolean(accepted),
      settle,
      followUpAssistantText: lastText === null ? null : lastText.slice(0, 400),
      visualRecall,
      pass: Boolean(refEcho.found && refEcho.refMatch && accepted && settle.sawTerminal && visualRecall),
    })
  }


  if (sessionId && rows.includes('N16')) {
    // Same SID after clean restart. The 2026-09-28 run (evidence
    // zk16-win32-n16) proved an unexecuted session is NEVER persisted: resume
    // answered -32004 sessionUnavailable and session/list came back empty.
    // Fix: the row now reuses a TURN-BEARING session — seeded in-row (counted
    // against this row's cap) or supplied via --session. Restart itself is
    // config-only: capture state, stop cleanly, fresh runtime + NEW client
    // generation, resume the SAME sessionId, verify identity/model/workspace,
    // resubscribe from the saved cursor.
    const seed = await ensureTurnBearingSession('N16')
    if (!seed.reused && !seed.accepted) {
      record('N16', { description: PAID_ROWS.N16, notRun: 'SEED_TURN_FAILED', detail: 'no turn-bearing session; seeding turn was not accepted (unexecuted sessions are never persisted — 2026-09-28 evidence). Restart leg not attempted.', seed })
    } else {
      const before = await client.request('session/read', { sessionId })
      const modelBefore =
        before.ok && before.value && before.value.settings ? before.value.settings.model : null
      const sub = await client.request('session/subscribe', {
        sessionId,
        deliveryKind: 'desktop-continuous',
        includeSnapshot: true,
        afterSeq: 0,
      })
      const cursor = sub.ok && sub.value ? sub.value.eventSeq : null
      log.rows.N16 = { stage: 'pre-restart', sessionId, cursor, model: redact(modelBefore), seed }
      const stopA = await runtime.stop()
      const oldGeneration = client.generation
      await sleep(500)
      const second = await startSecondRuntime()
      if (!second.ok) {
        log.rows.N16.stage2 = { launchFailed: second.error }
      } else {
        const { runtime: runtime2, client: client2 } = second
        const resume = await client2.request('session/resume', { sessionId, workspace: W })
        const resumedOk = resume.ok && resume.value ? resume.value : null
        const resumedId = resumedOk
          ? (resumedOk.session && resumedOk.session.sessionId) || resumedOk.sessionId || null
          : null
        const read2 = await client2.request('session/read', { sessionId })
        const model2 =
          read2.ok && read2.value && read2.value.settings ? read2.value.settings.model : null
        const sub2 = await client2.request('session/subscribe', {
          sessionId,
          deliveryKind: 'desktop-continuous',
          includeSnapshot: false,
          afterSeq: cursor ?? 0,
        })
        const list2 = await client2.request('session/list', { workspace: W, includeArchived: false, limit: 10 })
        log.rows.N16.stage2 = {
          stop: stopA.ok ? { ok: true } : { error: stopA.error.toJSON() },
          resume: redact(resume.ok ? { keys: Object.keys(resumedOk || {}) } : resume.error.toJSON()),
          sameSidResumed: resumedId === sessionId,
          readbackModelMatches: JSON.stringify(redact(model2)) === JSON.stringify(redact(modelBefore)),
          resubscribeWithSavedCursor: redact(sub2.ok ? { eventSeq: (sub2.value && sub2.value.eventSeq) || null } : sub2.error.toJSON()),
          listContainsSession: redact(list2.ok ? list2.value : list2.error.toJSON()),
          newGeneration: client2.generation,
          oldGeneration,
          oldClientClosedAfterStop: client.isClosed,
        }
        client2.dispose()
        const reap = await runtime2.stop()
        log.rows.N16.stage2.stop2 = reap.ok ? { ok: true } : { error: reap.error.toJSON() }
        log.rows.N16.stage2.newPidLivenessAfterStop = alive(runtime2.pid) ? 'ALIVE' : 'dead'
      }
      record('N16', {
        ...log.rows.N16,
        pass: Boolean(
          log.rows.N16.stage2 &&
            !log.rows.N16.stage2.launchFailed &&
            log.rows.N16.stage2.sameSidResumed === true &&
            log.rows.N16.stage2.readbackModelMatches === true &&
            log.rows.N16.stage2.stop2?.ok === true &&
            log.rows.N16.stage2.newPidLivenessAfterStop === 'dead',
        ),
      })
    }
  }

  if (sessionId && rows.includes('N17')) {
    // Checklist N17 — failure/restart resume with list omission. Controlled
    // connection drop mid-send (the "or connection" variant: the send is fired
    // and the owned process stopped before any ACK can arrive; acceptance is
    // UNKNOWN, so the turn is conservatively COUNTED — never under-counted),
    // restart WITHOUT resending, then resume the known SID directly even if
    // session/list omits it. Existing filesystem effects must survive, no
    // whole-task replay may occur, and the orphan outcome is explicit.
    const seed = await ensureTurnBearingSession('N17')
    if (!seed.reused && !seed.accepted) {
      record('N17', { description: PAID_ROWS.N17, notRun: 'SEED_TURN_FAILED', detail: 'no turn-bearing session; seeding turn was not accepted. Drop/restart leg not attempted.', seed })
    } else {
      const pre = await projectionNow()
      const messagesBefore = pre.ok && Array.isArray(pre.messages) ? pre.messages.length : null
      const turnCountBefore = pre.ok && pre.projection ? pre.projection.turnCount : null
      const sentinelPath = path.join(workspace, 'SENTINEL-N17.txt')
      const sentinelBefore = await readFileOrNull(sentinelPath)
      // Controlled drop: fire the send, flush window, kill the connection via
      // the owned-process stop. The pending request settles as an error; its
      // acceptance can never be observed from this side.
      const dropTask = `zk16-n17 drop ${Date.now()}: create a file named SENTINEL-N17-B.txt containing exactly the word dropped. Do nothing else.`
      const droppedSend = client.request('session/send', { sessionId, content: dropTask })
      await sleep(250) // bounded flush window; the race is inherent and recorded
      const dropStopStarted = Date.now()
      const stopA = await runtime.stop()
      const droppedResult = await droppedSend
      // Acceptance unknown → conservative count (never under-count a possibly
      // admitted model turn).
      await countModelTurn('N17')
      const second = await startSecondRuntime()
      if (!second.ok) {
        record('N17', {
          description: PAID_ROWS.N17,
          seed,
          preState: { messagesBefore, turnCountBefore, sentinelBefore },
          drop: { task: dropTask, result: droppedResult.ok ? redact(droppedResult.value) : droppedResult.error.toJSON(), stopMs: Date.now() - dropStopStarted, stop: stopA.ok ? { ok: true } : { error: stopA.error.toJSON() } },
          notRun: 'SECOND_LAUNCH_FAILED',
          detail: 'restart failed; list-omission/resume leg not tested.',
        })
      } else {
        const { runtime: runtime2, client: client2 } = second
        const list2 = await client2.request('session/list', { workspace: W, includeArchived: false, limit: 10 })
        const listedSids = list2.ok && list2.value && Array.isArray(list2.value.sessions) ? list2.value.sessions.map((s) => s && s.sessionId) : null
        const listOmits = Array.isArray(listedSids) ? !listedSids.includes(sessionId) : null
        // Resume the known SID DIRECTLY — no resend, whatever the list said.
        const resume = await client2.request('session/resume', { sessionId, workspace: W })
        const resumedId = resume.ok && resume.value && typeof resume.value === 'object' ? resume.value.session?.sessionId ?? null : null
        const post = await projectionNow(client2)
        const messagesAfter = post.ok && Array.isArray(post.messages) ? post.messages.length : null
        const turnCountAfter = post.ok && post.projection ? post.projection.turnCount : null
        const sentinelAfter = await readFileOrNull(sentinelPath)
        const orphanFile = await readFileOrNull(path.join(workspace, 'SENTINEL-N17-B.txt'))
        // Whole-task replay check: at most ONE new user/assistant pair beyond
        // the pre-drop message count (the dropped send, IF admitted and run,
        // settles as one pair; a duplicated history means replay).
        const maxExpectedMessages = (messagesBefore ?? 0) + 2
        record('N17', {
          description: PAID_ROWS.N17,
          seed,
          preState: { messagesBefore, turnCountBefore, sentinelBefore },
          drop: {
            task: dropTask,
            result: droppedResult.ok ? redact(droppedResult.value) : droppedResult.error.toJSON(),
            stopMs: Date.now() - dropStopStarted,
            stop: stopA.ok ? { ok: true } : { error: stopA.error.toJSON() },
            acceptance: 'UNKNOWN (connection dropped pre-ACK; conservatively counted as a spent turn)',
          },
          restart: {
            list: list2.ok ? { sessionIds: listedSids, omitsKnownSid: listOmits } : list2.error.toJSON(),
            resume: resume.ok ? { sameSid: resumedId === sessionId, keys: Object.keys(resume.value ?? {}) } : resume.error.toJSON(),
            postState: { messagesAfter, turnCountAfter, status: post.ok && post.projection ? post.projection.status : null },
            noWholeTaskReplay: messagesBefore !== null && messagesAfter !== null ? messagesAfter <= maxExpectedMessages : null,
            filesystemEffects: { sentinelBefore, sentinelAfter, intact: sentinelBefore === sentinelAfter },
            orphanOutcome: { dropFileWritten: orphanFile !== null, dropFileContent: orphanFile, interpretation: orphanFile !== null ? 'dropped send WAS admitted and settled server-side (recorded, not replayed by the runner)' : 'dropped send never started (no effects)' },
          },
          pass: Boolean(
            resume.ok && resumedId === sessionId && sentinelBefore === sentinelAfter &&
            messagesBefore !== null && messagesAfter !== null && messagesAfter <= maxExpectedMessages,
          ),
        })
        client2.dispose()
        const reap = await runtime2.stop()
        log.rows.N17.runtime2Stop = reap.ok ? { ok: true } : { error: reap.error.toJSON() }
        log.rows.N17.runtime2PidLivenessAfterStop = alive(runtime2.pid) ? 'ALIVE' : 'dead'
      }
    }
  }

  // Safety net: a selected paid row with no recorded evidence means its driver
  // never reached a record() (e.g. session unavailable). The drivers themselves
  // record named notRun/shape outcomes — this loop never fabricates a PASS.
  for (const [row, reason] of [
    ['N08', 'driver ran without recording (permission legs incomplete)'],
    ['N09', 'driver ran without recording (question/plan legs incomplete)'],
    ['N10', 'driver ran without recording (guide leg incomplete)'],
    ['N11', 'driver ran without recording (stop/cancel leg incomplete)'],
    ['N12', 'driver ran without recording (goal settlement leg incomplete)'],
    ['N13', 'driver ran without recording (compact leg incomplete)'],
    ['N14', 'driver ran without recording (rowsRange/fork leg incomplete)'],
    ['N15', 'driver ran without recording (image leg incomplete)'],
    ['N16', 'driver ran without recording (restart leg incomplete)'],
    ['N17', 'driver ran without recording (drop/restart leg incomplete)'],
  ]) {
    if (rows.includes(row) && !log.rows[row]) {
      record(row, {
        description: PAID_ROWS[row],
        notRun: 'CAPTURE_SCHEMA_PENDING',
        detail: `${reason}. Shapes fail closed; nothing is claimed without captured evidence.`,
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
  // Restart rows stop their second runtimes in-row; this is the leak guard for
  // a driver that throws between launch and its own stop (stop() is memoized,
  // so an in-row stop followed by this one is a no-op).
  log.secondRuntimeStops = []
  for (const second of secondRuntimes) {
    const reap = await second.stop()
    log.secondRuntimeStops.push(reap.ok ? { ok: true, pid: second.pid } : { error: reap.error.toJSON(), pid: second.pid })
  }
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
