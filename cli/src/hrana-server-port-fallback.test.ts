// Regression tests for #20: startHranaServer must survive an unbindable
// lock port (EACCES — on Windows the hash-derived port can fall inside a
// reserved TCP exclusion range; on Unix a privileged port) by falling back
// to an OS-assigned port, while STILL failing with ServerStartError when
// the port is genuinely in use (EADDRINUSE) — falling back there would
// silently break single-instance enforcement.
//
// The Windows exclusion ranges are dynamic (Hyper-V/WSL reservations shift
// per boot), so the EACCES port is discovered at test time from
// `netsh interface ipv4 show excludedportrange protocol=tcp` and verified
// with a real bind attempt. Hosts that expose no EACCES-forced port skip
// these tests rather than fake coverage.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterAll, describe, expect, test } from 'vitest'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { ServerStartError } from './errors.js'

/** Probe-bind 127.0.0.1:port; resolves the errno code on failure, null on success. */
function probeBind(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', (err) => {
      resolve('code' in err ? (err.code as string) : 'UNKNOWN')
    })
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => {
        resolve(null)
      })
    })
  })
}

/**
 * Find a port on this host that provably fails to bind with EACCES right
 * now — win32: inside a netsh-reported exclusion range (verified by bind);
 * posix: an unprivileged bind on a privileged port. Null when the host
 * offers no such port (skip signal, not a failure).
 */
async function findEaccesPort(): Promise<number | null> {
  if (process.platform === 'win32') {
    const netsh = spawnSync(
      'netsh',
      ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'],
      { encoding: 'utf8', timeout: 10_000 },
    )
    if (netsh.error || netsh.status !== 0) {
      return null
    }
    const ranges: Array<[number, number]> = []
    for (const line of netsh.stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s*\*?\s*$/)
      if (match) {
        ranges.push([Number(match[1]), Number(match[2])])
      }
    }
    for (const [start, end] of ranges) {
      const port = Math.min(start + 10, end)
      if (port < 1024 || port > 65535) {
        continue
      }
      if ((await probeBind(port)) === 'EACCES') {
        return port
      }
    }
    return null
  }
  for (const port of [80, 443, 21, 23]) {
    if ((await probeBind(port)) === 'EACCES') {
      return port
    }
  }
  return null
}

describe('hrana-server lock-port fallback (#20)', () => {
  const dbPaths: string[] = []

  function makeDbPath(): string {
    const dbPath = path.join(
      process.cwd(),
      'tmp',
      `test-hrana-fallback-${crypto.randomUUID().slice(0, 8)}.db`,
    )
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    dbPaths.push(dbPath)
    return dbPath
  }

  afterAll(() => {
    for (const dbPath of dbPaths) {
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  })

  test(
    'falls back to an OS-assigned port when the lock port fails with EACCES',
    async (ctx) => {
      const reservedPort = await findEaccesPort()
      if (reservedPort === null) {
        ctx.skip('no EACCES-forced port available on this host')
      }

      const previousLockPort = process.env['KIMAKI_LOCK_PORT']
      process.env['KIMAKI_LOCK_PORT'] = String(reservedPort)
      try {
        const result = await startHranaServer({ dbPath: makeDbPath() })
        expect(result).not.toBeInstanceOf(Error)
        expect(typeof result).toBe('string')

        const boundPort = Number(new URL(result as string).port)
        expect(Number.isInteger(boundPort)).toBe(true)
        expect(boundPort).not.toBe(reservedPort)

        // The server must actually serve on the fallback port.
        const health = await fetch(`${result}/health`)
        expect(health.status).toBe(200)
        expect(await health.json()).toMatchObject({ status: 'ok' })
      } finally {
        await stopHranaServer()
        if (previousLockPort === undefined) {
          delete process.env['KIMAKI_LOCK_PORT']
        } else {
          process.env['KIMAKI_LOCK_PORT'] = previousLockPort
        }
      }
    },
    20_000,
  )

  test(
    'still fails with ServerStartError when the lock port is in use (EADDRINUSE)',
    async () => {
      // A raw TCP server that accepts connections but never answers /health,
      // so evictExistingInstance cannot identify or evict it.
      const occupier = net.createServer(() => {})
      await new Promise<void>((resolve) => {
        occupier.listen(0, '127.0.0.1', () => {
          resolve()
        })
      })
      const address = occupier.address()
      expect(typeof address).toBe('object')
      const occupiedPort = (address as net.AddressInfo).port

      const previousLockPort = process.env['KIMAKI_LOCK_PORT']
      process.env['KIMAKI_LOCK_PORT'] = String(occupiedPort)
      try {
        const result = await startHranaServer({ dbPath: makeDbPath() })
        expect(result).toBeInstanceOf(ServerStartError)
        expect((result as Error).message).toContain(
          `Server failed to start on port ${occupiedPort}`,
        )
        expect((result as Error).message).toContain('still in use')
      } finally {
        await stopHranaServer()
        occupier.close()
        if (previousLockPort === undefined) {
          delete process.env['KIMAKI_LOCK_PORT']
        } else {
          process.env['KIMAKI_LOCK_PORT'] = previousLockPort
        }
      }
    },
    20_000,
  )
})
