// Debug probe (NOT certification evidence): does a real turn execute when the
// app-server is spawned from the FULL desktop env instead of the runner's
// curated allowlist? One tiny sentinel turn, result printed to stdout.
// — ZCode 2026-09-19, orchestration session
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const KIMAKI = 'C:/Dev/kimaki-zcode'
const executable = 'C:/Program Files/nodejs/node.exe'
const entryPath = 'C:\\Users\\Cody\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'
const workspace = process.argv[4] === 'runnerws'
  ? String.raw`C:\Users\Cody\AppData\Local\Temp\zk16-n07n08-sentinel`
  : path.join(tmpdir(), 'zk-n07-env-probe-ws')
await mkdir(workspace, { recursive: true })

const procmod = await import('file:///' + KIMAKI + '/cli/dist/agent/native/process.js')
const { startOwnedRuntime } = procmod
const { fileHash } = procmod
const { NativeClient } = await import('file:///' + KIMAKI + '/cli/dist/agent/native/client.js')
const { fail } = await import('file:///' + KIMAKI + '/cli/dist/agent/native/errors.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const notifications = []
let disconnected = null

const envMode = process.argv[2] ?? 'full'
const mode = process.argv[3] ?? 'none'
const HOST_ENV_ALLOWLIST = [
  'ALLUSERSPROFILE', 'APPDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMPUTERNAME',
  'COMSPEC', 'DRIVERDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'NUMBER_OF_PROCESSORS',
  'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'PROGRAMW6432', 'SESSIONNAME', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'TEMP', 'TMP', 'USERNAME', 'USERPROFILE', 'WINDIR',
]
let environment
if (envMode === 'curated') {
  environment = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (!HOST_ENV_ALLOWLIST.includes(k.toUpperCase())) continue
    if (/^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(k)) continue
    environment[k] = v
  }
} else if (mode === 'curated+zcode') {
  environment = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (!HOST_ENV_ALLOWLIST.includes(k.toUpperCase()) && !k.toUpperCase().startsWith('ZCODE_')) continue
    if (/^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(k)) continue
    environment[k] = v
  }
} else if (envMode === 'curated+profile' || envMode === 'curated+profile+zcode') {
  environment = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (!HOST_ENV_ALLOWLIST.includes(k.toUpperCase())) continue
    if (/^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*)$/i.test(k)) continue
    environment[k] = v
  }
  // The runner's --env profile overrides (from win-cody-zcode-cjs.json + the corrected auth re-probe)
  environment.HOME = 'C:\\Users\\Cody'
  environment.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = 'C:\\Users\\Cody\\AppData\\Local\\Programs\\ZCode\\resources\\config\\provider\\zcode-builtin.json'
  environment.ZCODE_DATA_BASE_DIR = 'C:\\Filen\\Reference\\Tech\\AI\\Claude\\ZCode Data'
  if (envMode === 'curated+profile+zcode') {
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k.toUpperCase().startsWith('ZCODE_')) environment[k] = v
    }
  }
} else {
  environment = { ...process.env }
}
console.log('ENV MODE:', mode, 'vars:', Object.keys(environment).length)

const t0 = Date.now()
const runtimeResult = await startOwnedRuntime({
  executable,
  entryPath,
  args: [entryPath, 'app-server'],
  cwd: workspace,
  executableSha256: await fileHash(executable),
  entrySha256: await fileHash(entryPath),
  environment, // the experiment variable
  startupMs: 30000,
  graceMs: 5000,
})
if (!runtimeResult.ok) {
  console.error('LAUNCH FAILED:', JSON.stringify(runtimeResult.error))
  process.exit(1)
}
const runtime = runtimeResult.value
console.log('LAUNCH ok pid=' + runtime.pid, 'envVars=' + Object.keys(process.env).length)

const client = new NativeClient({
  input: runtime.input,
  output: runtime.output,
  timeoutMs: 30000,
  onNotification: (method, params) => {
    notifications.push({ at: Date.now() - t0, method })
    if (method.includes('turn') || method.includes('Turn')) console.log('NOTI', method)
  },
  onRequest: async (id, method) => {
    console.log('REVERSE-REQ', method)
    if (method === 'session/requestRuntimePreferences') {
      return { ok: true, value: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false } }
    }
    return { ok: false, error: fail('HOST_REFUSED', 'probe refuses ' + method, 'control', 'none') }
  },
  onDisconnect: (e) => { disconnected = String(e) },
})

if (mode === 'list' || mode === 'listws') {
  const W = { workspacePath: workspace, workspaceKey: workspace }
  const lst = await client.request('session/list', { workspace: W, includeArchived: false, limit: 1 })
  console.log('LIST ok=', lst.ok, JSON.stringify(lst.ok ? lst.value : lst.error).slice(0, 200))
  await sleep(300)
}
const create = await client.request('session/create', { workspace: { workspacePath: workspace, workspaceKey: workspace }, mode: 'build' })
if (!create.ok) { console.error('CREATE FAILED:', JSON.stringify(create.error)); process.exit(1) }
const sid = create.value?.session?.sessionId
console.log('CREATED', sid)

if (mode === 'sub' || mode === 'sub+model') {
  const legacy = await client.request('session/subscribe', { sessionId: sid, deliveryKind: 'desktop-continuous', includeSnapshot: true, afterSeq: 0 })
  const v4 = await client.request('v4/conversation/subscribe', { topic: `conversation/${sid}`, connectionId: client.generation, clientMode: 'desktop-continuous' })
  console.log('SUBSCRIBE legacy=', legacy.ok, 'v4=', v4.ok, JSON.stringify(v4.ok ? v4.value : v4.error))
  await sleep(1500)
}
if (mode === 'model' || mode === 'sub+model') {
  let advertised = null
  for (let i = 0; i < 12 && !advertised; i++) {
    const r = await client.request('session/read', { sessionId: sid })
    const m = r.ok && r.value?.settings?.model ? r.value.settings.model : null
    if (m && ((m.current && m.current.providerId) || (Array.isArray(m.available) && m.available.length))) advertised = m
    else await sleep(1000)
  }
  if (!advertised) { console.log('NO ADVERTISED MODEL — cannot run model mode'); process.exit(4) }
  const entry = advertised.current?.providerId ? advertised.current : advertised.available[0]
  const ref = entry.ref ?? entry
  const meta = (advertised.available || []).find((a) => a.ref && a.ref.providerId === ref.providerId && a.ref.modelId === ref.modelId)
  const reasoningLevel = meta?.reasoning?.defaultLevel ?? entry.options?.reasoningLevel
  const set = await client.request('session/setModel', { sessionId: sid, model: { providerId: ref.providerId, modelId: ref.modelId, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) }, persistAsWorkspaceLastUsed: false })
  console.log('SETMODEL ok=', set.ok, JSON.stringify(set.ok ? set.value : set.error).slice(0, 300))
}

const task = 'zk16 debug probe ' + Date.now() + ': create a file named SENTINEL-PROBE.txt containing exactly the word ok. Do nothing else.'
const send = await client.request('session/send', { sessionId: sid, content: task })
console.log('SEND accepted=', send.ok && send.value?.accepted === true, JSON.stringify(send.ok ? send.value : send.error))

let lastStatus = null
let settled = false
for (let i = 0; i < 150; i++) {
  await sleep(1000)
  const r = await client.request('session/read', { sessionId: sid })
  if (!r.ok) { console.log('READ-ERR', JSON.stringify(r.error)); break }
  const st = r.value?.projection?.status
  const tc = r.value?.projection?.turnCount
  if (st !== lastStatus) { console.log('STATUS', String(st), 'turnCount=', String(tc), 'atMs=', Date.now() - t0); lastStatus = st }
  const pending = r.value?.runtime?.pendingRequestIds
  if (st && st !== 'running' && Array.isArray(pending) && pending.length === 0) { settled = true; break }
}
let sentinel = null
try { sentinel = (await readFile(path.join(workspace, 'SENTINEL-PROBE.txt'), 'utf8')).trim() } catch { sentinel = null }
console.log('VERDICT', JSON.stringify({
  settledMs: settled ? Date.now() - t0 : null,
  disconnected,
  notifications: notifications.slice(0, 12),
  sentinelWritten: sentinel,
  verdict: sentinel === 'ok' ? 'TURN EXECUTED' : 'TURN DID NOT EXECUTE',
}))
runtime.onExit(() => {})
process.exit(sentinel === 'ok' ? 0 : 2)
