import { fail, record, type Result, ok } from './errors.js'
import type { RpcId } from './types.js'
export type Envelope =
  | {
      type: 'request'
      id: RpcId
      method: string
      params: unknown
    }
  | {
      type: 'notification'
      method: string
      params: unknown
    }
  | {
      type: 'response'
      id: RpcId
      result: unknown
    }
  | {
      type: 'error'
      id: RpcId
      error: {
        code: number
        message: string
      }
    }
export function classify(value: unknown): Envelope {
  const obj = record(value, 'RPC envelope')
  const hasId = Object.hasOwn(obj, 'id')
  const hasMethod = Object.hasOwn(obj, 'method')
  if (
    hasId &&
    !(
      (typeof obj.id === 'string' && obj.id.length > 0) ||
      (typeof obj.id === 'number' && Number.isSafeInteger(obj.id))
    )
  ) {
    throw fail('FRAME_INVALID', 'Invalid RPC identifier.', 'control')
  }
  const id = obj.id as RpcId
  if (hasMethod) {
    if (
      typeof obj.method !== 'string' ||
      !obj.method ||
      Object.hasOwn(obj, 'result') ||
      Object.hasOwn(obj, 'error')
    ) {
      throw fail('FRAME_INVALID', 'Invalid RPC request.', 'control')
    }
    return hasId
      ? { type: 'request', id, method: obj.method, params: obj.params }
      : { type: 'notification', method: obj.method, params: obj.params }
  }
  if (!hasId || Object.hasOwn(obj, 'result') === Object.hasOwn(obj, 'error')) {
    throw fail('FRAME_INVALID', 'Invalid RPC response.', 'control')
  }
  if (Object.hasOwn(obj, 'error')) {
    const e = record(obj.error, 'RPC error')
    if (
      typeof e.code !== 'number' ||
      !Number.isSafeInteger(e.code) ||
      typeof e.message !== 'string'
    ) {
      throw fail('FRAME_INVALID', 'Invalid RPC error.', 'control')
    }
    return { type: 'error', id, error: { code: e.code, message: e.message } }
  }
  return { type: 'response', id, result: obj.result }
}
/** Byte-bounded framing before UTF-8 decoding; no quadratic concatenation on tiny chunks. */
export class NdjsonDecoder {
  private chunks: Buffer[] = []
  private head: Buffer | undefined
  private used = 0
  private bytes = 0
  private failed = false
  constructor(readonly maxFrameBytes = 8 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw fail('CONFIG_INVALID', 'Frame limit must be positive.')
    }
  }
  push(chunk: Uint8Array): Envelope[] {
    if (this.failed) {
      throw fail('FRAME_INVALID', 'Decoder is closed.', 'control')
    }
    const out: Envelope[] = []
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let start = 0
    try {
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] !== 10) {
          continue
        }
        this.add(buffer.subarray(start, i))
        let line = Buffer.concat(
          this.head ? [...this.chunks, this.head.subarray(0, this.used)] : this.chunks,
          this.bytes,
        )
        this.chunks = []
        this.head = undefined
        this.used = 0
        this.bytes = 0
        start = i + 1
        if (line.at(-1) === 13) {
          line = line.subarray(0, -1)
        }
        if (line.length === 0) {
          throw fail('FRAME_INVALID', 'Empty native frame.', 'control')
        }
        out.push(classify(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))))
      }
      this.add(buffer.subarray(start))
      return out
    } catch {
      this.failed = true
      this.chunks = []
      this.head = undefined
      this.used = 0
      this.bytes = 0
      throw fail('FRAME_INVALID', 'Malformed or oversized native frame.', 'control')
    }
  }
  private add(chunk: Buffer) {
    if (this.bytes + chunk.length > this.maxFrameBytes) {
      throw fail('FRAME_INVALID', 'Native frame exceeds byte limit.', 'control')
    }
    if (!chunk.length) {
      return
    }
    this.bytes += chunk.length
    let offset = 0
    while (offset < chunk.length) {
      if (!this.head || this.used === this.head.length) {
        if (this.head) {
          this.chunks.push(this.head)
        }
        this.head = Buffer.allocUnsafe(Math.min(this.maxFrameBytes, 65536))
        this.used = 0
      }
      const take = Math.min(this.head.length - this.used, chunk.length - offset)
      chunk.copy(this.head, this.used, offset, offset + take)
      this.used += take
      offset += take
    }
  }
  finish(): Result<void> {
    if (this.bytes !== 0 || this.failed) {
      this.failed = true
      return {
        ok: false,
        error: fail('FRAME_INVALID', 'Incomplete native frame at EOF.', 'control'),
      }
    }
    this.failed = true
    return ok(undefined)
  }
}
