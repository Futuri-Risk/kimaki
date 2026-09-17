/** Operational errors are returned as values at the public boundary; never replay tasks. */
export type Phase = 'preflight' | 'control' | 'submit' | 'execute' | 'recover' | 'render'
export type Effects = 'none' | 'possible' | 'confirmed'
export class AgentError extends Error {
  readonly automaticTaskReplayAllowed = false
  constructor(
    readonly code: string,
    message: string,
    readonly phase: Phase = 'preflight',
    readonly effects: Effects = 'none',
  ) {
    super(message)
    this.name = 'AgentError'
  }
  toJSON() {
    return {
      code: this.code,
      safeMessage: this.message,
      phase: this.phase,
      effects: this.effects,
      automaticTaskReplayAllowed: false,
    }
  }
}
export type Result<T> =
  | {
      ok: true
      value: T
    }
  | {
      ok: false
      error: AgentError
    }
export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const fail = (
  code: string,
  message: string,
  phase: Phase = 'preflight',
  effects: Effects = 'none',
): AgentError => new AgentError(code, message, phase, effects)
export async function attempt<T>(
  fn: () => Promise<T>,
  code = 'INTERNAL_ERROR',
  phase: Phase = 'preflight',
  effects: Effects = 'none',
): Promise<Result<T>> {
  try {
    return ok(await fn())
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof AgentError
          ? error
          : fail(code, 'Operation failed; inspect private diagnostics.', phase, effects),
    }
  }
}
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw result.error
  }
  return result.value
}
export function record(value: unknown, context = 'object'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('SCHEMA_INVALID', `Invalid ${context}.`, 'control')
  }
  return value as Record<string, unknown>
}
export function text(value: unknown, context = 'string'): string {
  if (typeof value !== 'string' || !value.length) {
    throw fail('SCHEMA_INVALID', `Invalid ${context}.`, 'control')
  }
  return value
}
export function integer(value: unknown, context = 'integer'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw fail('SCHEMA_INVALID', `Invalid ${context}.`, 'control')
  }
  return value
}
export function safeJson(value: unknown, maxBytes = 1048576): string {
  const encoded = JSON.stringify(value)
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > maxBytes) {
    throw fail('STATE_TOO_LARGE', 'State exceeds its storage bound.')
  }
  return encoded
}
export function redactor(secrets: readonly string[]): (input: string) => string {
  const needles = secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length)
  return (input) => needles.reduce((out, secret) => out.split(secret).join('[REDACTED]'), input)
}
