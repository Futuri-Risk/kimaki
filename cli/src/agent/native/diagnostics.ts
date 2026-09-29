import { fail } from './errors.js'
export type DiagnosticLimits = { maxLineBytes?: number; maxBytes?: number; maxLines?: number }
/** Private opt-in diagnostics. Redact complete bounded lines before retention.
 * Partial, malformed, oversized or redactor-failed lines are discarded, not truncated raw.
 * Exact-secret redaction is not a guarantee about secrets unknown to the caller. */
export class DiagnosticBuffer {
  private pending: Buffer[] = []
  private pendingBytes = 0
  private dropping = false
  private retained: string[] = []
  private retainedBytes = 0
  private readonly maxLineBytes: number
  private readonly maxBytes: number
  private readonly maxLines: number
  constructor(
    private readonly redact?: (line: string) => string,
    limits: DiagnosticLimits = {},
  ) {
    this.maxLineBytes = limits.maxLineBytes ?? 4096
    this.maxBytes = limits.maxBytes ?? 16384
    this.maxLines = limits.maxLines ?? 32
    if (
      ![this.maxLineBytes, this.maxBytes, this.maxLines].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      )
    )
      throw fail('CONFIG_INVALID', 'Diagnostic limits must be positive safe integers.')
  }
  push(chunk: Buffer) {
    if (!this.redact) return
    let offset = 0
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset)
      const stop = end === -1 ? chunk.length : end
      const length = stop - offset
      if (!this.dropping) {
        if (this.pendingBytes + length > this.maxLineBytes) {
          this.pending = []
          this.pendingBytes = 0
          this.dropping = true
        } else if (length) {
          this.pending.push(Buffer.from(chunk.subarray(offset, stop)))
          this.pendingBytes += length
        }
      }
      if (end !== -1) {
        if (!this.dropping) this.complete()
        this.pending = []
        this.pendingBytes = 0
        this.dropping = false
      }
      offset = end === -1 ? chunk.length : end + 1
    }
  }
  private complete() {
    try {
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(this.pending, this.pendingBytes),
      )
      const redacted = this.redact!(raw)
      if (typeof redacted !== 'string') return
      const line = redacted
        .replace(/[\r\n]/g, ' ')
        .replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')
      const size = Buffer.byteLength(line) + 1
      if (size > this.maxBytes) return
      this.retained.push(line)
      this.retainedBytes += size
      while (this.retained.length > this.maxLines || this.retainedBytes > this.maxBytes)
        this.retainedBytes -= Buffer.byteLength(this.retained.shift()!) + 1
    } catch {
      /* No raw partial/error data is retained. */
    }
  }
  lines(): readonly string[] {
    return [...this.retained]
  }
}
