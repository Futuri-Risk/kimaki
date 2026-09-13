// Unit tests for /rename pure helpers.

import { describe, expect, test } from 'vitest'
import {
  buildThreadName,
  extractTicketRef,
  preservePrefix,
} from './rename.js'

describe('extractTicketRef', () => {
  test('extracts repo#n shorthand', () => {
    expect(extractTicketRef('working forge-ops#58 today')).toEqual({
      org: null,
      repo: 'forge-ops',
      number: 58,
    })
  })

  test('extracts owner/repo#n shorthand', () => {
    expect(extractTicketRef('filed projects/skills#1 for this')).toEqual({
      org: 'projects',
      repo: 'skills',
      number: 1,
    })
  })

  test('extracts from gitea issue url', () => {
    expect(
      extractTicketRef('see http://127.0.0.1:3000/projects/kimaki/issues/1'),
    ).toEqual({
      org: 'projects',
      repo: 'kimaki',
      number: 1,
    })
  })

  test('url wins over shorthand in same text', () => {
    const text = 'forge-ops#12 mentioned plus http://127.0.0.1:3000/projects/kimaki/issues/1'
    expect(extractTicketRef(text)?.repo).toBe('kimaki')
  })

  test('ignores the T#n thread-name convention form', () => {
    expect(extractTicketRef('kimaki T#41: session cache misses')).toBeNull()
  })

  test('ignores discord channel mentions and long ids', () => {
    expect(extractTicketRef('join <#1547905160641122377> now')).toBeNull()
  })

  test('ignores markdown headers', () => {
    expect(extractTicketRef('## 12 steps')).toBeNull()
  })

  test('ignores #12345 bare mentions', () => {
    expect(extractTicketRef('channel #123456 is open')).toBeNull()
  })
})

describe('buildThreadName', () => {
  test('formats per convention', () => {
    expect(
      buildThreadName({ tag: 'skills', number: 3, title: 'Reorganize into domains' }),
    ).toBe('skills T#3: Reorganize into domains')
  })

  test('collapses whitespace in title', () => {
    expect(
      buildThreadName({ tag: 'kimaki', number: 41, title: ' session   cache\nmisses ' }),
    ).toBe('kimaki T#41: session cache misses')
  })

  test('caps at 100 chars', () => {
    const name = buildThreadName({
      tag: 'skills',
      number: 3,
      title: 'x'.repeat(200),
    })
    expect(name.length).toBe(100)
  })
})

describe('preservePrefix', () => {
  test('keeps worktree prefix', () => {
    expect(preservePrefix('⬦ old name', 'skills T#3: domains')).toBe(
      '⬦ skills T#3: domains',
    )
  })

  test('keeps btw prefix', () => {
    expect(preservePrefix('btw: old', 'new name')).toBe('btw: new name')
  })

  test('no-op when no preserved prefix', () => {
    expect(preservePrefix('plain old', 'new name')).toBe('new name')
  })

  test('caps combined length at 100', () => {
    const name = preservePrefix('⬦ old', 'y'.repeat(200))
    expect(name.length).toBe(100)
    expect(name.startsWith('⬦ ')).toBe(true)
  })
})
