/** Internal subprocess only. Never run the native runtime in the bot's process group.
 * POSIX: the native child is a detached session leader; stop() signals its whole
 * process group, and (SWARM #23) a detached keeper in its own session watches the
 * supervisor's life — when the supervisor dies however abruptly (SIGKILL, OOM, or
 * a group-wide kill), the keeper's stdin EOFs and it terminates the watched
 * process group (SIGTERM → grace → SIGKILL). Windows (ZK-016, 2026-09-18):
 * containment is a Job Object held by a PowerShell keeper subprocess.
 * Containment is ACTIVE, not close-based: on keeper stdin EOF (supervisor
 * death), EXIT, or KILL the keeper calls TerminateJobObject, which provably
 * kills every assigned process and descendant (KILL_ON_JOB_CLOSE proved
 * unverifiable on this build, so it is set best-effort but never trusted). — ZCode */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
let native;
let stopping = false;
let graceMs = 5000;
let nativeExited = false;
const isWin = process.platform === 'win32';
/** Best-effort parent notification. On a closed IPC channel (parent death)
 * process.send does not merely return false — Node 24 also queues an 'error'
 * emit on the process object (node:internal/child_process:781) that, with no
 * listener, crashes the supervisor mid-stop and orphans the native child; older
 * nodes throw ERR_IPC_CHANNEL_CLOSED synchronously instead. Guard on
 * process.connected — the same flag send() checks, and this function is
 * synchronous, so it cannot flip between guard and send. A failed
 * notification must never pre-empt the stop() that follows. — SWARM #22 */
function notifyParent(message) {
    if (!process.connected) {
        return;
    }
    try {
        process.send?.(message);
    }
    catch {
        /* sync closed-channel throw: notification is best-effort */
    }
}
/** P/Invoke job keeper: holds one job; ADD <pid> assigns it. */
const KEEPER_PS1 = String.raw `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ZKJobKeeper {
  [DllImport("kernel32.dll")] public static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr h, int i, IntPtr li, int len);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a, bool inh, int pid);
  [DllImport("kernel32.dll")] public static extern bool TerminateJobObject(IntPtr h, uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
"@
$job = [ZKJobKeeper]::CreateJobObject([IntPtr]::Zero, $null)
$bytes = New-Object Byte[] 64
$li = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(64)
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $li, 64)
[System.Runtime.InteropServices.Marshal]::WriteInt32($li, 56, 0x2000)
$limitsSet = [ZKJobKeeper]::SetInformationJobObject($job, 2, $li, 64)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($li)
if (-not $limitsSet) { Write-Output 'SETUP-FAIL'; exit 1 }
Write-Output 'READY'
$reason = 'eof'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line -eq 'EXIT') { $reason = 'exit'; break }
  if ($line -eq 'KILL') { $reason = 'kill'; break }
  if ($line.StartsWith('ADD ')) {
    $target = 0
    if (-not [int]::TryParse($line.Substring(4), [ref]$target)) { Write-Output "ADD-FAIL $line"; continue }
    $proc = [ZKJobKeeper]::OpenProcess(0x0101, $false, $target)
    if ($proc -eq [IntPtr]::Zero) { Write-Output "ADD-FAIL $target"; continue }
    $assigned = [ZKJobKeeper]::AssignProcessToJobObject($job, $proc)
    $null = [ZKJobKeeper]::CloseHandle($proc)
    Write-Output "ADD-OK $target $assigned"
  }
}
$null = [ZKJobKeeper]::TerminateJobObject($job, 7)
Write-Output "DONE $reason"
$null = [ZKJobKeeper]::CloseHandle($job)
`;
/** POSIX twin of KEEPER_PS1 (SWARM #23): a detached node keeper that owns one
 * watched process group; WATCH <pgid> arms it. The supervisor holds the write
 * end of our stdin, so ANY supervisor death — SIGKILL, OOM, a group-wide kill —
 * EOFs our stdin and we terminate the watched group (SIGTERM → 5s grace →
 * SIGKILL → 2s reap). Detached is what makes this work: a group-wide kill of
 * the supervisor cannot reach a keeper in its own session. — ZCode */
const KEEPER_JS = String.raw `
const watched = { pgid: 0 }
let stopping = false
const alive = () => {
  if (!watched.pgid) return false
  try { process.kill(-watched.pgid, 0); return true } catch (e) { return e.code !== 'ESRCH' }
}
const poll = (endMs, next) => {
  if (!alive() || Date.now() > endMs) next()
  else setTimeout(() => poll(endMs, next), 20)
}
const terminate = () => {
  if (!watched.pgid || !alive()) process.exit(0)
  try { process.kill(-watched.pgid, 'SIGTERM') } catch {}
  poll(Date.now() + 5000, () => {
    if (alive()) { try { process.kill(-watched.pgid, 'SIGKILL') } catch {} }
    poll(Date.now() + 2000, () => process.exit(0))
  })
}
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line === 'KILL') { stopping = true; terminate(); return }
    if (line.startsWith('WATCH ')) {
      watched.pgid = Number(line.slice(6))
      process.stdout.write('WATCH-OK ' + watched.pgid + '\n')
    }
  }
})
process.stdin.on('end', () => { if (!stopping) terminate() })
process.stdout.write('READY\n')
`;
let keeper;
let keeperScript;
const keeperLineListeners = new Set();
function onKeeperLine(fn) {
    keeperLineListeners.add(fn);
    return () => keeperLineListeners.delete(fn);
}
function startKeeper() {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('job keeper startup timed out')), 15000);
        try {
            if (isWin) {
                const script = path.join(tmpdir(), `zk-job-keeper-${process.pid}-${Date.now()}.ps1`);
                keeperScript = script;
                writeFileSync(script, KEEPER_PS1, 'utf8');
                keeper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            }
            else {
                keeper = spawn(process.execPath, ['-e', KEEPER_JS], {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    detached: true,
                });
            }
        }
        catch (error) {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        const lines = readline.createInterface({ input: keeper.stdout });
        lines.on('line', (line) => {
            for (const fn of [...keeperLineListeners])
                fn(line.trim());
        });
        const off = onKeeperLine((line) => {
            if (line === 'READY') {
                clearTimeout(timer);
                off();
                resolve();
            }
        });
        keeper.on('exit', () => {
            clearTimeout(timer);
            reject(new Error('job keeper exited before becoming ready'));
        });
        keeper.stderr.on('data', () => {
            /* diagnostics only; keeper failures surface via exit/timeout */
        });
        keeper.on('exit', () => {
            // Watchdog: a keeper that dies while the native child lives means lost
            // containment (outside the normal model) — kill the direct child hard.
            if (native?.pid && !nativeExited && !stopping) {
                signal(native.pid, 'SIGKILL');
                process.exitCode = 70;
            }
        });
    });
}
function assignToJob(pid) {
    if (!keeper)
        return Promise.resolve(false);
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            off();
            resolve(false);
        }, 10000);
        const off = onKeeperLine((line) => {
            if (line === `ADD-OK ${pid} True`) {
                clearTimeout(timer);
                off();
                resolve(true);
            }
            else if (line === `ADD-OK ${pid} False` ||
                line === `ADD-FAIL ${pid}` ||
                line.startsWith(`ADD-FAIL ${pid} `)) {
                clearTimeout(timer);
                off();
                resolve(false);
            }
        });
        keeper.stdin.write(`ADD ${pid}\n`);
    });
}
/** POSIX arming: hand the native process group to the keeper and require its
 * WATCH-OK ack — the EOF-watch containment is provably armed before we report
 * the runtime ready. — SWARM #23 */
function watchGroup(pgid) {
    if (!keeper)
        return Promise.resolve(false);
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            off();
            resolve(false);
        }, 10000);
        const off = onKeeperLine((line) => {
            if (line === `WATCH-OK ${pgid}`) {
                clearTimeout(timer);
                off();
                resolve(true);
            }
        });
        keeper.stdin.write(`WATCH ${pgid}\n`);
    });
}
async function releaseKeeper() {
    if (!keeper)
        return;
    try {
        keeper.stdin.write('KILL\n');
    }
    catch {
        /* stdin already closed: keeper terminates the job on EOF anyway */
    }
    const end = Date.now() + 8000;
    while (keeper.exitCode === null && Date.now() < end)
        await delay(20);
    keeper.kill();
    keeper = undefined;
    if (keeperScript) {
        try {
            ;
            (await import('node:fs/promises')).rm(keeperScript, { force: true });
        }
        catch {
            /* best-effort temp cleanup */
        }
    }
}
function alive(pid) {
    try {
        process.kill(isWin ? pid : -pid, 0);
        return true;
    }
    catch (e) {
        return e.code !== 'ESRCH';
    }
}
function signal(pid, name) {
    try {
        process.kill(isWin ? pid : -pid, name);
    }
    catch (e) {
        if (e.code !== 'ESRCH') {
            process.exitCode = 70;
        }
    }
}
async function stop() {
    if (stopping) {
        return;
    }
    stopping = true;
    const pid = native?.pid;
    if (!pid) {
        await releaseKeeper();
        process.exit(0);
        return;
    }
    signal(pid, 'SIGTERM');
    const end = Date.now() + graceMs;
    while (alive(pid) && Date.now() < end)
        await delay(20);
    if (alive(pid)) {
        signal(pid, 'SIGKILL');
    }
    // Keeper termination is belt-and-braces on both platforms: the job object
    // (win32) or the watched-group kill (POSIX) takes anything the direct
    // signal missed (descendants). — SWARM #23
    await releaseKeeper();
    const killEnd = Date.now() + 2000;
    while (alive(pid) && Date.now() < killEnd)
        await delay(20);
    process.exit(alive(pid) || !nativeExited ? 70 : 0);
}
process.on('disconnect', () => {
    void stop();
});
process.on('SIGTERM', () => {
    void stop();
});
process.on('SIGINT', () => {
    void stop();
});
process.stdin.on('error', () => {
    void stop();
});
process.stdout.on('error', () => {
    void stop();
});
process.on('message', (input) => {
    if (!input || typeof input !== 'object') {
        return;
    }
    const value = input;
    if (value.type === 'stop') {
        void stop();
        return;
    }
    if (value.type !== 'start' || native || stopping) {
        return;
    }
    if (typeof value.executable !== 'string' ||
        typeof value.cwd !== 'string' ||
        !Array.isArray(value.args) ||
        !value.args.every((a) => typeof a === 'string') ||
        !value.env ||
        typeof value.env !== 'object') {
        process.exit(70);
        return;
    }
    if (typeof value.graceMs === 'number') {
        graceMs = Math.max(50, Math.min(value.graceMs, 30000));
    }
    const begin = async () => {
        // Keeper is mandatory on both platforms (SWARM #23): win32 job object,
        // POSIX EOF-watched process group. Refuse to own the runtime without it.
        try {
            await startKeeper();
        }
        catch {
            notifyParent({ type: 'failure' });
            void stop();
            return;
        }
        native = spawn(value.executable, value.args, {
            cwd: value.cwd,
            env: value.env,
            detached: !isWin,
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(isWin ? { windowsHide: true } : {}),
        });
        const owned = native;
        owned.on('error', () => {
            notifyParent({ type: 'failure' });
            void stop();
        });
        owned.stdin.on('error', () => {
            void stop();
        });
        owned.on('exit', () => {
            nativeExited = true;
            void stop();
        });
        process.stdin.pipe(owned.stdin);
        owned.stdout.pipe(process.stdout);
        owned.stderr.pipe(process.stderr);
        owned.once('spawn', async () => {
            const pid = owned.pid;
            if (pid !== undefined) {
                // Containment arming is mandatory on both platforms: job object on
                // win32, EOF-watched process group on POSIX. No ack means we refuse
                // to own the process unsupervised.
                const contained = isWin ? await assignToJob(pid) : await watchGroup(pid);
                if (!contained && !stopping) {
                    notifyParent({ type: 'failure' });
                    void stop();
                    return;
                }
            }
            if (!stopping)
                notifyParent({ type: 'ready', pid });
        });
    };
    void begin();
});
