import type { Readable, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { NdjsonDecoder, type Envelope } from './ndjson.js'
import { AgentError, fail, type Result, ok, safeJson } from './errors.js'
import type { RpcId } from './types.js'
type Pending = {
  resolve: (value: Result<unknown>) => void
  timer: NodeJS.Timeout
  removeAbort: () => void
}
type Write = {
  text: string
  bytes: number
  resolve: (r: Result<void>) => void
  active: () => boolean
}
export type RequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}
export type ClientOptions = {
  input: Writable
  output: Readable
  maxFrameBytes?: number
  maxPending?: number
  maxWriteBytes?: number
  maxWriteCount?: number
  maxReverse?: number
  timeoutMs?: number
  onNotification: (method: string, params: unknown) => void
  onRequest: (
    id: RpcId,
    method: string,
    params: unknown,
    signal: AbortSignal,
  ) => Promise<Result<unknown>>
  onDisconnect: (error: AgentError) => void
  onResponseWritten?: (id: RpcId, result: Result<void>) => void
}
export class NativeClient {
  readonly generation = randomUUID()
  private seq = 0
  private pending = new Map<RpcId, Pending>()
  private reverse = new Map<RpcId, AbortController>()
  private queue: Write[] = []
  private queuedBytes = 0
  private writing = false
  private currentWrite: Write | undefined
  private closed = false
  private decoder: NdjsonDecoder
  constructor(private readonly options: ClientOptions) {
    for (const value of [
      options.maxFrameBytes,
      options.maxPending,
      options.maxWriteBytes,
      options.maxWriteCount,
      options.maxReverse,
      options.timeoutMs,
    ]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        throw fail('CONFIG_INVALID', 'Native client limits must be positive finite integers.')
    }
    if (options.timeoutMs !== undefined && options.timeoutMs > 2147483647)
      throw fail('CONFIG_INVALID', 'Native client timeout exceeds the timer range.')
    this.decoder = new NdjsonDecoder(options.maxFrameBytes)
    options.output.on('data', this.onData)
    options.output.once('end', this.onEnd)
    options.output.once('close', this.onPipeClose)
    options.output.once('error', this.onError)
    options.input.once('error', this.onError)
    options.input.once('close', this.onPipeClose)
  }
  get isClosed() {
    return this.closed
  }
  get pendingCount() {
    return this.pending.size
  }
  request(
    method: string,
    params: unknown,
    settings: RequestOptions = {},
  ): Promise<Result<unknown>> {
    if (this.closed) {
      return Promise.resolve({
        ok: false,
        error: fail('PROCESS_EXITED', 'Native connection is closed.', 'control', 'possible'),
      })
    }
    if (
      settings.timeoutMs !== undefined &&
      (!Number.isSafeInteger(settings.timeoutMs) ||
        settings.timeoutMs < 1 ||
        settings.timeoutMs > 2147483647)
    ) {
      return Promise.resolve({
        ok: false,
        error: fail(
          'CONFIG_INVALID',
          'Request deadline must be a positive supported integer.',
          'control',
        ),
      })
    }
    if (!method || this.pending.size >= (this.options.maxPending ?? 128)) {
      return Promise.resolve({
        ok: false,
        error: fail('RPC_LIMIT', 'Native request limit reached.', 'control'),
      })
    }
    if (settings.signal?.aborted) {
      return Promise.resolve({
        ok: false,
        error: fail('ABORTED', 'Request cancelled before writing.', 'control'),
      })
    }
    const id = ++this.seq
    return new Promise((resolve) => {
      const settleAbort = () =>
        this.settle(id, {
          ok: false,
          error: fail(
            'ABORTED',
            'Request aborted; delivery may be uncertain.',
            'control',
            'possible',
          ),
        })
      const timer = setTimeout(
        () =>
          this.settle(id, {
            ok: false,
            error: fail(
              'RPC_TIMEOUT',
              'Native response deadline expired; do not replay.',
              'control',
              'possible',
            ),
          }),
        settings.timeoutMs ?? this.options.timeoutMs ?? 30000,
      )
      this.pending.set(id, {
        resolve,
        timer,
        removeAbort: () => settings.signal?.removeEventListener('abort', settleAbort),
      })
      settings.signal?.addEventListener('abort', settleAbort, { once: true })
      void this.write({ id, method, params }, () => this.pending.has(id)).then((result) => {
        if (!result.ok) {
          this.settle(id, result)
        }
      })
    })
  }
  respond(id: RpcId, result: unknown): Promise<Result<void>> {
    return this.write({ id, result })
  }
  respondError(id: RpcId, code: number, message: string): Promise<Result<void>> {
    return this.write({ id, error: { code, message } })
  }
  private write(payload: unknown, active = () => true): Promise<Result<void>> {
    if (this.closed) {
      return Promise.resolve({
        ok: false,
        error: fail('PROCESS_EXITED', 'Native connection is closed.', 'control', 'possible'),
      })
    }
    let encoded: string
    try {
      encoded = safeJson(payload, this.options.maxFrameBytes ?? 8388608) + '\n'
    } catch {
      return Promise.resolve({
        ok: false,
        error: fail('FRAME_TOO_LARGE', 'Outgoing native frame exceeds its limit.', 'control'),
      })
    }
    const bytes = Buffer.byteLength(encoded)
    if (
      this.queuedBytes + bytes > (this.options.maxWriteBytes ?? 16777216) ||
      this.queue.length >= (this.options.maxWriteCount ?? 256)
    ) {
      return Promise.resolve({
        ok: false,
        error: fail('WRITE_LIMIT', 'Native write queue is full.', 'control'),
      })
    }
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        const error = fail(
          'WRITE_TIMEOUT',
          'Native pipe write timed out; delivery may be uncertain.',
          'control',
          'possible',
        )
        complete({ ok: false, error })
        this.disconnect(error)
      }, this.options.timeoutMs ?? 30000)
      const complete = (result: Result<void>) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      this.queue.push({ text: encoded, bytes, resolve: complete, active })
      this.queuedBytes += bytes
      this.pump()
    })
  }
  private pump() {
    if (this.writing || this.closed) {
      return
    }
    const item = this.queue.shift()
    if (!item) {
      return
    }
    if (!item.active()) {
      this.queuedBytes -= item.bytes
      item.resolve({
        ok: false,
        error: fail('ABORTED', 'Request expired before queued write.', 'control'),
      })
      this.pump()
      return
    }
    this.writing = true
    this.currentWrite = item
    try {
      this.options.input.write(item.text, (error) => {
        if (this.currentWrite === item) {
          this.currentWrite = undefined
          this.writing = false
          this.queuedBytes -= item.bytes
        }
        if (error) {
          item.resolve({
            ok: false,
            error: fail('PIPE_FAILED', 'Native write failed.', 'control', 'possible'),
          })
          this.disconnect()
        } else {
          item.resolve(ok(undefined))
        }
        this.pump()
      })
    } catch {
      // A custom/failed Writable may throw before invoking its callback.
      // Never leak raw transport exceptions or leave pending writes alive.
      this.disconnect(fail('PIPE_FAILED', 'Native write failed.', 'control', 'possible'))
    }
  }
  private settle(id: RpcId, result: Result<unknown>) {
    const p = this.pending.get(id)
    if (!p) {
      return
    }
    this.pending.delete(id)
    clearTimeout(p.timer)
    p.removeAbort()
    p.resolve(result)
  }
  private onData = (chunk: Buffer) => {
    if (this.closed) {
      return
    }
    try {
      for (const frame of this.decoder.push(chunk)) this.handle(frame)
    } catch {
      this.disconnect(
        fail('FRAME_INVALID', 'Native stream requires reconciliation.', 'control', 'possible'),
      )
    }
  }
  private handle(frame: Envelope) {
    if (this.closed) {
      return
    }
    if (frame.type === 'response') {
      this.settle(frame.id, ok(frame.result))
      return
    }
    if (frame.type === 'error') {
      this.settle(frame.id, {
        ok: false,
        error: fail(
          `NATIVE_${frame.error.code}`,
          'Native RPC rejected the request.',
          'control',
          'possible',
        ),
      })
      return
    }
    if (frame.type === 'notification') {
      this.options.onNotification(frame.method, frame.params)
      return
    }
    if (this.reverse.has(frame.id) || this.reverse.size >= (this.options.maxReverse ?? 32)) {
      this.disconnect(
        fail('REVERSE_LIMIT', 'Duplicate or excessive native interaction.', 'control', 'possible'),
      )
      return
    }
    const abort = new AbortController()
    this.reverse.set(frame.id, abort)
    const timer = setTimeout(() => abort.abort(), this.options.timeoutMs ?? 30000)
    const aborted = new Promise<Result<unknown>>((resolve) =>
      abort.signal.addEventListener(
        'abort',
        () =>
          resolve({
            ok: false,
            error: fail('INPUT_TIMEOUT', 'Native interaction expired.', 'control'),
          }),
        { once: true },
      ),
    )
    void Promise.race([
      Promise.resolve().then(() =>
        this.options.onRequest(frame.id, frame.method, frame.params, abort.signal),
      ),
      aborted,
    ])
      .catch(
        (): Result<unknown> => ({
          ok: false,
          error: fail('INTERACTION_FAILED', 'Native interaction failed.', 'control'),
        }),
      )
      .then(async (result) => {
        if (this.closed) {
          return
        }
        const written = result.ok
          ? await this.respond(frame.id, result.value)
          : await this.respondError(
              frame.id,
              -32601,
              'Unsupported, denied or expired host interaction',
            )
        this.options.onResponseWritten?.(frame.id, written)
      })
      .catch(() => {
        this.disconnect(
          fail(
            'HOST_CALLBACK_FAILED',
            'Native reply observer failed; connection retired.',
            'control',
            'possible',
          ),
        )
      })
      .finally(() => {
        clearTimeout(timer)
        this.reverse.delete(frame.id)
      })
  }
  private onEnd = () => {
    const r = this.decoder.finish()
    this.disconnect(r.ok ? undefined : r.error)
  }
  private onError = () => this.disconnect()
  private onPipeClose = () => this.disconnect()
  disconnect(
    error = fail(
      'PROCESS_EXITED',
      'Native connection closed; execution may be uncertain.',
      'control',
      'possible',
    ),
  ) {
    if (this.closed) {
      return
    }
    this.closed = true
    this.options.output.off('data', this.onData)
    this.options.output.off('end', this.onEnd)
    // Keep error listeners until explicit disposal so late pipe errors are handled.
    for (const id of this.pending.keys()) this.settle(id, { ok: false, error })
    for (const ctl of this.reverse.values()) ctl.abort()
    if (this.currentWrite) {
      const item = this.currentWrite
      this.currentWrite = undefined
      this.writing = false
      this.queuedBytes -= item.bytes
      item.resolve({ ok: false, error })
    }
    for (const item of this.queue.splice(0)) {
      this.queuedBytes -= item.bytes
      item.resolve({ ok: false, error })
    }
    try {
      this.options.onDisconnect(error)
    } catch {
      // All pending state is already settled. Observer failure must not
      // interrupt pipe disposal or leak a raw host exception.
    }
  }
  dispose() {
    this.disconnect()
    this.options.output.destroy()
    this.options.input.destroy()
  }
}
