// Per-install machine identity for the native agent sidecar (ZK-007).
// The durable store scopes native sessions and leases by owner machine; a
// stable UUID persisted once in the kimaki data dir (mirroring the bot_tokens
// client_id pattern) is the identity. Generated locally, never shared, and
// unrelated to any credential. — ZCode 2026-09-17

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from '../config.js'

let cachedId: string | null = null
let pending: Promise<string> | null = null

export function getOwnerMachineId(): Promise<string> {
  if (cachedId) {
    return Promise.resolve(cachedId)
  }
  pending ??= (async () => {
    const dir = getDataDir()
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'agent-machine-id')
    try {
      const existing = fs.readFileSync(file, 'utf8').trim()
      if (/^[0-9a-f-]{36}$/i.test(existing)) {
        cachedId = existing
        return existing
      }
    } catch {
      // Missing or unreadable — mint below.
    }
    const id = randomUUID()
    try {
      // O_EXCL: never overwrite an id another process just minted.
      const handle = fs.openSync(file, 'wx')
      try {
        fs.writeFileSync(handle, id)
      } finally {
        fs.closeSync(handle)
      }
    } catch {
      // Lost the race or read-only dir: adopt whatever is on disk if valid.
      try {
        const existing = fs.readFileSync(file, 'utf8').trim()
        if (/^[0-9a-f-]{36}$/i.test(existing)) {
          cachedId = existing
          return existing
        }
      } catch {
        // Fall through and use the in-memory id (single-process machines).
      }
    }
    cachedId = id
    return id
  })()
  return pending
}
