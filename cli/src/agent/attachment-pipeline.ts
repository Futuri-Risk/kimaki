// ZK-013 attachment pipeline: bridges Discord message attachments into the
// hardened staging core (agent/attachments.ts — path/byte/hash guards) with
// durable agent_attachments records, and revalidates a record against the file
// before any native read. Downloads come from the Discord CDN through the same
// fetch the host uses; secrets are never staged (the store's protect() layer
// guards persistence, staging refuses unsafe paths). — ZCode 2026-09-18
import { open, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fail } from './errors.js'
import type { AgentStore } from './store.js'
import { stageAttachment, type Attachment } from './attachments.js'

export type DiscordAttachmentSource = {
  filename: string
  mimeType: string
  url: string
}

export type StagedAttachmentSet = {
  staged: Attachment[]
  skipped: Array<{ filename: string; reason: string }>
}

/** Stage every downloadable Discord attachment durably for a native session. */
export async function stageDiscordAttachments(args: {
  store: AgentStore
  sessionId: string
  attachmentRoot: string
  files: readonly DiscordAttachmentSource[]
  limitBytes?: number
}): Promise<StagedAttachmentSet> {
  const staged: Attachment[] = []
  const skipped: Array<{ filename: string; reason: string }> = []
  for (const file of args.files) {
    try {
      const response = await fetch(file.url)
      if (!response.ok) {
        skipped.push({ filename: file.filename, reason: `download failed (${response.status})` })
        continue
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      const attachment = await stageAttachment(
        args.attachmentRoot,
        {
          filename: file.filename,
          mimeType: file.mimeType,
          bytes: buffer,
        },
        args.limitBytes,
      )
      await args.store.recordAttachment(args.sessionId, attachment)
      staged.push(attachment)
    } catch (error) {
      const code = (error as { code?: string }).code
      skipped.push({ filename: file.filename, reason: code ?? 'staging refused' })
    }
  }
  return { staged, skipped }
}

/**
 * Revalidate a durable attachment record against the file before any native
 * read: same path ownership (inside the approved root, no symlink escape),
 * same size, same hash. A record that no longer matches its file yields null
 * — the native runtime must never receive unverifiable bytes.
 */
export async function revalidateAttachment(
  root: string,
  record: {
    storagePath: string
    sizeBytes: number
    sha256: string
  },
): Promise<boolean> {
  try {
    const canonicalRoot = await realpath(root)
    const actual = await realpath(record.storagePath)
    const rel = path.relative(canonicalRoot, actual)
    if (!rel || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return false
    }
    const handle = await open(record.storagePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size !== record.sizeBytes) {
        return false
      }
      // Bounded read: a file can grow between stat and read.
      const bounded = Buffer.alloc(info.size + 1)
      let used = 0
      while (used < bounded.length) {
        const read = await handle.read(bounded, used, bounded.length - used, used)
        if (read.bytesRead === 0) break
        used += read.bytesRead
      }
      if (used !== record.sizeBytes) {
        return false
      }
      return createHash('sha256').update(bounded.subarray(0, used)).digest('hex') === record.sha256
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

/**
 * Native usage display: only numbers the native runtime actually reported are
 * shown; anything absent, malformed, or stringly-typed is explicitly
 * "unknown" — usage is NEVER fabricated as zero. — X07
 */
export function formatNativeUsage(usage: unknown): string {
  if (!usage || typeof usage !== 'object') {
    return 'unknown'
  }
  const record = usage as Record<string, unknown>
  const input = record.inputTokens
  const output = record.outputTokens
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
    return 'unknown'
  }
  if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
    return 'unknown'
  }
  return `${input} in / ${output} out`
}

/** Staging refusal for a missing file entry (used by callers for visible skips). */
export function attachmentSkipReason(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code?: string }).code)
  }
  return fail('ATTACHMENT_UNKNOWN', 'Attachment could not be staged.').message
}

/** stat-based existence probe used by retention sweeps. */
export async function attachmentExists(storagePath: string): Promise<boolean> {
  try {
    await stat(storagePath)
    return true
  } catch {
    return false
  }
}
