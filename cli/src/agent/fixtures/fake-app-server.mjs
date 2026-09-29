// SYNTHETIC native child fixture (ZK-007 port). It executes the test's sentinel
// effect itself, never the host. — ZCode 2026-09-17
/** SYNTHETIC native child. It executes the test's sentinel effect itself, never the host. */
import readline from 'node:readline';
import { readFile, writeFile, rename, appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
const home = process.argv[2];
const scenario = process.argv[3] ?? 'normal';
await mkdir(home, { recursive: true });
const file = path.join(home, 'native.json');
let state;
try {
    state = JSON.parse(await readFile(file, 'utf8'));
}
catch {
    state = { sessions: {}, sends: [], creates: 0, resumes: 0, compactions: 0, answers: [] };
}
let saveTail = Promise.resolve();
function save() {
    const body = JSON.stringify(state);
    saveTail = saveTail.then(async () => {
        await writeFile(file + '.tmp', body);
        await rename(file + '.tmp', file);
    });
    return saveTail;
}
function send(value) {
    process.stdout.write(JSON.stringify(value) + '\n');
}
function reply(id, result) {
    send({ id, result });
}
const requests = new Map();
let reverseId = 0;
const workers = new Map();
function host(method, params) {
    const id = scenario === 'reuse-reverse-id' ? 0 : reverseId++;
    const promise = new Promise((resolve, reject) => requests.set(id, { resolve, reject }));
    send({ id, method, params });
    return promise;
}
async function event(s, type, payload = {}, turnId = s.foreground?.id ?? s.terminal?.turnId) {
    s.seq++;
    await save();
    send({ method: 'session/event', params: { sessionId: s.sessionId, seq: s.seq, type, payload, ...(turnId ? { turnId } : {}) } });
}
async function stopWorker(id) {
    const worker = workers.get(id);
    if (!worker) {
        return;
    }
    workers.delete(id);
    await new Promise(resolve => {
        worker.once('exit', resolve);
        worker.kill('SIGTERM');
    });
}
function worker(s, name) {
    const child = spawn(process.execPath, ['-e', `const fs=require('fs');setInterval(()=>fs.appendFileSync(process.argv[1],'tick\\n'),25)`, path.join(s.workspace.workspacePath, name + '.ticks')], { stdio: 'ignore' });
    workers.set(name, child);
    return name;
}
async function finish(s, turnId, outcome = 'completed') {
    s.foreground = null;
    s.terminal = { turnId, outcome };
    await save();
    await event(s, outcome === 'completed' ? 'turn.completed' : 'turn.failed', { usage: { inputTokens: 13, outputTokens: 7 } }, turnId);
}
async function execute(id, p) {
    const s = state.sessions[p.sessionId];
    if (!s) {
        throw Error('missing session');
    }
    const turnId = randomUUID();
    s.foreground = { id: turnId, state: 'running' };
    s.terminal = null;
    state.sends.push({ sessionId: s.sessionId, content: p.content, attachments: p.attachments ?? [] });
    await save();
    await event(s, 'turn.started', { messageId: turnId }, turnId);
    await event(s, 'model.streaming', { kind: 'reasoning_delta', delta: 'Inspecting safely.', assistantMessageId: turnId }, turnId);
    if (p.content === 'permission' || p.content === 'question' || p.content === 'plan') {
        s.foreground.state = 'waiting';
        await save();
        const method = p.content === 'permission' ? 'interaction/requestPermission' : 'interaction/requestUserInput';
        const params = p.content === 'permission' ? { sessionId: s.sessionId, toolCallId: 'permission-tool', toolName: 'Bash', input: { command: 'write one sentinel' } } : { sessionId: s.sessionId, schema: p.content === 'plan' ? { kind: 'plan' } : { kind: 'questions', questions: [{ id: 'choice', options: ['yes', 'no'] }] } };
        const answer = await host(method, params);
        state.answers.push({ method, answer });
        await save();
        if (answer.decision === 'deny' || answer.action === 'cancel') {
            reply(id, { accepted: true });
            await finish(s, turnId, 'failed');
            return;
        }
        s.foreground.state = 'running';
        await save();
    }
    if (p.content === 'hold' || p.content === 'background' || p.content === 'goal') {
        if (p.content === 'hold') {
            worker(s, 'foreground');
            reply(id, { accepted: true });
            return;
        }
        if (p.content === 'background') {
            s.background = [worker(s, 'background')];
        }
        if (p.content === 'goal') {
            s.goalActive = true;
        }
    }
    await event(s, 'tool.updated', { kind: 'started', toolCallId: turnId + '-tool', toolName: 'Bash', input: { command: 'append sentinel' } }, turnId);
    await appendFile(path.join(s.workspace.workspacePath, 'effects.txt'), p.content + '\n');
    if (p.content === 'crash-after-write') {
        await save();
        process.exit(23);
    }
    if (p.content !== 'complete-before-ack') {
        reply(id, { accepted: true });
    }
    await event(s, 'tool.updated', { kind: 'result', toolCallId: turnId + '-tool', toolName: 'Bash', result: { success: true, content: 'one native write' } }, turnId);
    await event(s, 'model.streaming', { kind: 'text_delta', delta: 'Done ✓ ', assistantMessageId: turnId }, turnId);
    await event(s, 'model.streaming', { kind: 'text_delta', delta: p.content, assistantMessageId: turnId }, turnId);
    if (scenario === 'slow') {
        await delay(60);
    }
    await finish(s, turnId);
    if (p.content === 'complete-before-ack') {
        await delay(80);
        reply(id, { accepted: true });
    }
}
async function handle(r) {
    if (r.method) {
        await appendFile(path.join(home, 'calls.jsonl'), JSON.stringify({ method: r.method, params: r.params }) + '\n');
    }
    const p = r.params ?? {};
    const s = state.sessions[p.sessionId];
    switch (r.method) {
        case 'session/create': {
            if (scenario === 'prefs-before-create') {
                await host('session/requestRuntimePreferences', {});
            }
            const sid = 'native-' + randomUUID();
            state.creates++;
            state.sessions[sid] = { sessionId: sid, workspace: p.workspace, model: { providerId: 'fixture', modelId: 'fixture-model', reasoning: 'high', revision: 'r1' }, foreground: null, background: [], goalActive: false, terminal: null, seq: 0 };
            await save();
            reply(r.id, { session: state.sessions[sid] });
            return;
        }
        case 'session/resume':
            if (scenario === 'resume-reject' || !s) {
                throw Error('resume rejected');
            }
            state.resumes++;
            await save();
            reply(r.id, { session: s });
            return;
        case 'session/read':
            if (!s) {
                throw Error('missing session');
            }
            reply(r.id, { schema: 'fake-session-v1', session: { sessionId: s.sessionId, workspace: s.workspace }, runtime: { model: s.model, foreground: s.foreground, background: s.background, goalActive: s.goalActive, terminal: s.terminal } });
            return;
        case 'session/subscribe': {
            if (scenario === 'replay-history' && s.terminal) {
                send({ method: 'session/event', params: { sessionId: s.sessionId, seq: s.seq - 1, type: 'model.streaming', turnId: s.terminal.turnId, payload: { kind: 'text_delta', delta: 'REPLAY MUST NOT DISPLAY', assistantMessageId: s.terminal.turnId } } });
                send({ method: 'session/event', params: { sessionId: s.sessionId, seq: s.seq, type: 'turn.completed', turnId: s.terminal.turnId, payload: {} } });
            }
            reply(r.id, { eventSeq: s.seq, snapshot: {} });
            return;
        }
        case 'session/send':
            await execute(r.id, p);
            return;
        case 'session/setModel':
            s.model = { ...s.model, ...p.model };
            await save();
            reply(r.id, { accepted: true });
            return;
        case 'session/setThoughtLevel':
            if (!['high', 'max'].includes(p.thoughtLevel)) {
                throw Error('unsupported reasoning');
            }
            s.model.reasoning = p.thoughtLevel;
            await save();
            reply(r.id, { accepted: true });
            return;
        case 'session/compact':
            state.compactions++;
            await save();
            reply(r.id, { accepted: true });
            return;
        case 'session/cancelBackgroundTask':
            await stopWorker(p.taskId);
            s.background = s.background.filter(x => x !== p.taskId);
            await save();
            reply(r.id, { accepted: true });
            await event(s, 'state.updated', {});
            return;
        case 'v4/conversation/rowsRange':
            reply(r.id, { schema: 'fake-rows-v1', meta: { revision: 1, logEpoch: 'epoch-1' }, rows: [{ kind: 'assistantText', rowId: 42, entityId: 'assistant-final', actions: { canFork: true } }] });
            return;
        case 'v4/conversation/subscribe':
            reply(r.id, { ack: { subscriptionId: 'sub-1', logEpoch: 'epoch-1' } });
            return;
        case 'v4/conversation/unsubscribe':
            reply(r.id, { accepted: true });
            return;
        case 'v4/command': {
            if (p.type === 'sendText') {
                if (p.payload.requestedDelivery !== 'guide') {
                    throw Error('unsupported delivery');
                }
                reply(r.id, { status: 'accepted', result: { delivery: 'queue' } });
                const correlation = scenario === 'uncorrelated-guide' ? {} : { commandId: p.commandId };
                await event(s, 'turn.steerQueued', { delivery: 'guide', ...correlation });
                await event(s, 'turn.steerDrained', { injectedMessageIds: ['guide-native'], ...correlation });
                if (p.payload.text === 'finish-current') {
                    const turnId = s.foreground.id;
                    await stopWorker('foreground');
                    await finish(s, turnId);
                }
                return;
            }
            if (p.type === 'stop') {
                if (scenario === 'ignore-stop') {
                    reply(r.id, { status: 'accepted' });
                    return;
                }
                const turnId = s.foreground?.id;
                await stopWorker('foreground');
                s.foreground = null;
                s.goalActive = false;
                if (turnId) {
                    s.terminal = { turnId, outcome: 'cancelled' };
                }
                await save();
                reply(r.id, { status: 'accepted' });
                return; // deliberately NO legacy terminal event
            }
            if (p.type === 'forkAssistant') {
                if (p.baseRevision !== 1 || p.baseLogEpoch !== 'epoch-1' || p.payload.target.rowId !== 42 || p.payload.target.entityId !== 'assistant-final') {
                    reply(r.id, { status: 'stale', revisionAtDecision: 1 });
                    return;
                }
                const sid = 'fork-' + randomUUID();
                state.sessions[sid] = { ...s, sessionId: sid, foreground: null, background: [], seq: 0 };
                await save();
                reply(r.id, { status: 'accepted', result: { sessionId: sid } });
                return;
            }
            throw Error('unsupported command');
        }
        default: throw Error('unsupported RPC');
    }
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
    let r;
    try {
        r = JSON.parse(line);
    }
    catch {
        process.exit(20);
    }
    if (!Object.hasOwn(r, 'method')) {
        const pending = requests.get(r.id);
        if (pending) {
            requests.delete(r.id);
            if (r.error) {
                pending.reject(Error('host error'));
            }
            else {
                pending.resolve(r.result);
            }
        }
        return;
    }
    void handle(r).catch(() => send({ id: r.id, error: { code: -32601, message: 'synthetic native rejection' } }));
});
let closing = false;
async function shutdown() {
    if (closing) {
        return;
    }
    closing = true;
    await Promise.all([...workers.keys()].map(stopWorker));
    await saveTail;
    process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.stdin.on('end', () => void shutdown());
