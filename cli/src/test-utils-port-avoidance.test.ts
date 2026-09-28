// Regression tests for #20 (test-utils side):
// 1. chooseAvailableLockPort must skip ports that sit inside Windows
//    reserved TCP exclusion ranges (dynamic Hyper-V/WSL reservations) —
//    the raw hash-derived chooseLockPort can land inside one, and binding
//    then fails with EACCES.
// 2. normalizeFooterDuration must rewrite the wall-clock duration token in
//    run footers so inline snapshots do not flake on machine speed.

import { spawnSync } from 'node:child_process'
import net from 'node:net'
import { describe, expect, test } from 'vitest'
import {
  chooseAvailableLockPort,
  chooseLockPort,
  normalizeFooterDuration,
} from './test-utils.js'

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

function getWindowsExcludedRanges(): Array<[number, number]> {
  if (process.platform !== 'win32') {
    return []
  }
  const netsh = spawnSync(
    'netsh',
    ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'],
    { encoding: 'utf8', timeout: 10_000 },
  )
  if (netsh.error || netsh.status !== 0) {
    return []
  }
  const ranges: Array<[number, number]> = []
  for (const line of netsh.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*\*?\s*$/)
    if (match) {
      ranges.push([Number(match[1]), Number(match[2])])
    }
  }
  return ranges
}

describe('chooseAvailableLockPort avoids reserved ranges (#20)', () => {
  test(
    'returns a bindable port outside every reserved range when the hash-derived port is reserved',
    async (ctx) => {
      const ranges = getWindowsExcludedRanges()
      if (ranges.length === 0) {
        ctx.skip('no reserved TCP exclusion ranges reported on this host')
      }
      const inReservedRange = (port: number) => {
        return ranges.some(([start, end]) => {
          return port >= start && port <= end
        })
      }

      // Find a key whose deterministic port lands inside a reserved range.
      let key: string | null = null
      for (let i = 0; i < 20_000 && key === null; i += 1) {
        const candidate = `reserved-port-key-${i}`
        if (inReservedRange(chooseLockPort({ key: candidate }))) {
          key = candidate
        }
      }
      if (key === null) {
        ctx.skip('no hash-derived key lands inside a reserved range')
      }

      const chosen = await chooseAvailableLockPort({ key: key as string })
      expect(inReservedRange(chosen)).toBe(false)
      // And it is genuinely bindable, not just outside the reported list.
      expect(await probeBind(chosen)).toBeNull()
    },
    30_000,
  )
})

describe('normalizeFooterDuration (#20)', () => {
  test('rewrites the duration token in run footers to <1s', () => {
    expect(
      normalizeFooterDuration(
        '> *project ⋅ main ⋅ 2s ⋅ 0% ⋅ agent-model-v2 ⋅ **test-agent*** <@1>',
      ),
    ).toBe(
      '> *project ⋅ main ⋅ <1s ⋅ 0% ⋅ agent-model-v2 ⋅ **test-agent*** <@1>',
    )
    expect(
      normalizeFooterDuration('> *project ⋅ main ⋅ 1s ⋅ 12% ⋅ model* <@2>'),
    ).toBe('> *project ⋅ main ⋅ <1s ⋅ 12% ⋅ model* <@2>')
    expect(
      normalizeFooterDuration('> *project ⋅ main ⋅ 1m 30s ⋅ 5% ⋅ model* <@2>'),
    ).toBe('> *project ⋅ main ⋅ <1s ⋅ 5% ⋅ model* <@2>')
    expect(
      normalizeFooterDuration('> *project ⋅ main ⋅ <1s ⋅ 0% ⋅ model* <@2>'),
    ).toBe('> *project ⋅ main ⋅ <1s ⋅ 0% ⋅ model* <@2>')
  })

  test('leaves non-footer text untouched', () => {
    const text = [
      '--- from: user (tester)',
      'what is 2s plus 1s?',
      '--- from: assistant (Bot)',
      '> took about 1m 30s overall',
      '> *using provider/model ⋅ agent*',
    ].join('\n')
    expect(normalizeFooterDuration(text)).toBe(text)
  })
})
