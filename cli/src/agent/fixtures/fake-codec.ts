// ZK-007 port of the bundle fake-codec fixture (import path adapted to src).
// SYNTHETIC ONLY: session/read, rowsRange and question shapes below are test contracts.
// They are NOT captured/native-certified schemas and are intentionally not auto-enabled.
// — ZCode 2026-09-17
import { record, text, integer, fail } from '../errors.js'
import type { CompatibilityCodec } from '../native/protocol.js'

export const fakeCodec: CompatibilityCodec = {
  id: 'synthetic-native-v1',
  evidence: 'synthetic',
  snapshot(value, expected) {
    const r = record(value)
    if (r.schema !== 'fake-session-v1') {
      throw fail('SCHEMA_INVALID', 'Synthetic codec refuses non-fixture native state.')
    }
    const s = record(r.session)
    const w = record(s.workspace)
    const run = record(r.runtime)
    const model = record(run.model)
    if (
      s.sessionId !== expected ||
      !Array.isArray(run.background) ||
      typeof run.goalActive !== 'boolean' ||
      !Object.hasOwn(run, 'foreground') ||
      !Object.hasOwn(run, 'terminal')
    ) {
      throw fail('SCHEMA_INVALID', 'Incomplete native activity state.')
    }
    const foreground = run.foreground === null ? null : record(run.foreground)
    const terminal = run.terminal === null ? null : record(run.terminal)
    if (foreground && !['running', 'waiting'].includes(String(foreground.state))) {
      throw fail('SCHEMA_INVALID', 'Unknown foreground status.')
    }
    if (terminal && !['completed', 'failed', 'cancelled'].includes(String(terminal.outcome))) {
      throw fail('SCHEMA_INVALID', 'Unknown native outcome.')
    }
    return {
      sessionId: text(s.sessionId),
      workspacePath: text(w.workspacePath),
      workspaceKey: text(w.workspaceKey),
      model: {
        providerId: text(model.providerId),
        modelId: text(model.modelId),
        revision: text(model.revision),
        ...(model.reasoning ? { reasoning: text(model.reasoning) } : {}),
      },
      foreground: foreground
        ? {
            id: text(foreground.id),
            state: (['running', 'waiting'].includes(String(foreground.state))
              ? foreground.state
              : 'running') as 'running' | 'waiting',
          }
        : null,
      background: run.background.map((v) => text(v)),
      goalActive: run.goalActive,
      terminal: terminal
        ? {
            turnId: text(terminal.turnId),
            outcome: (['completed', 'failed', 'cancelled'].includes(String(terminal.outcome))
              ? terminal.outcome
              : 'completed') as 'completed' | 'failed' | 'cancelled',
          }
        : null,
    }
  },
  forkPoint(value) {
    const r = record(value)
    if (r.schema !== 'fake-rows-v1' || !Array.isArray(r.rows)) {
      throw fail('FORK_POINT_INVALID', 'Uncertified row-range shape.')
    }
    const row = [...r.rows]
      .reverse()
      .find((row) => row.kind === 'assistantText' && row.actions?.canFork)
    if (!row) {
      throw fail('FORK_POINT_INVALID', 'No forkable row.')
    }
    const meta = record(r.meta)
    return {
      rowId: integer(row.rowId),
      entityId: text(row.entityId),
      revision: integer(meta.revision),
      logEpoch: text(meta.logEpoch),
    }
  },
  interaction(method, params) {
    const p = record(params)
    if (method === 'interaction/requestPermission') {
      text(p.toolCallId)
      text(p.toolName)
      return {
        kind: 'permission' as const,
        schema: { toolCallId: p.toolCallId, toolName: p.toolName, input: p.input },
      }
    }
    const schema = p.schema && typeof p.schema === 'object' ? record(p.schema) : undefined
    if (method === 'interaction/requestUserInput' && schema?.kind === 'questions') {
      return { kind: 'question' as const, schema }
    }
    if (method === 'interaction/requestUserInput' && schema?.kind === 'plan') {
      return { kind: 'plan-approval' as const, schema }
    }
    throw fail('INTERACTION_UNSUPPORTED', 'Unknown native interaction schema.')
  },
  answer(kind, schema, answer) {
    if (!answer || answer.kind !== kind) {
      throw fail('ANSWER_INVALID', 'Wrong answer kind.')
    }
    if (answer.kind === 'permission' && kind === 'permission') {
      if (!['deny', 'allow-once'].includes(answer.decision)) {
        throw fail('ANSWER_INVALID', 'Invalid permission answer.')
      }
      return { decision: answer.decision === 'allow-once' ? 'allow' : 'deny' }
    }
    if (answer.kind === 'plan-approval' && kind === 'plan-approval') {
      if (typeof answer.approved !== 'boolean') {
        throw fail('ANSWER_INVALID', 'Invalid plan answer.')
      }
      return {
        action: answer.approved ? 'accept' : 'cancel',
        content: { answer_0: answer.approved ? 'approve' : 'reject' },
      }
    }
    if (answer.kind !== 'question' || kind !== 'question') {
      throw fail('ANSWER_INVALID', 'Wrong answer kind.')
    }
    const questions = Array.isArray(record(schema).questions)
      ? (record(schema).questions as Array<{ id: string; options?: string[] }>)
      : []
    if (!questions.length) {
      throw fail('ANSWER_INVALID', 'Invalid question schema.')
    }
    const values = record(answer.values)
    if (Object.keys(values).some((key) => !questions.some((q) => q.id === key))) {
      throw fail('ANSWER_INVALID', 'Unknown question identifier.')
    }
    for (const q of questions) {
      const v = values[q.id]
      if (
        !Array.isArray(v) ||
        !v.length ||
        !v.every((a) => typeof a === 'string' && (!q.options || q.options.includes(a)))
      ) {
        throw fail('ANSWER_INVALID', 'Invalid native question answer.')
      }
    }
    return { action: 'accept', content: { answers: values } }
  },
}
