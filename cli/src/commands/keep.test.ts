// Tests for /keep command helpers.

import { describe, expect, test } from 'vitest'
import { KEEP_CHOICES } from './keep.js'

describe('KEEP_CHOICES', () => {
  test('matches the auto_archive_duration values Discord accepts', () => {
    // https://discord.com/developers/docs/resources/channel#modify-channel
    const validDurations = [60, 1440, 4320, 10080]
    expect(KEEP_CHOICES.map((choice) => choice.minutes)).toEqual(
      validDurations,
    )
  })

  test('has unique labels', () => {
    const labels = KEEP_CHOICES.map((choice) => choice.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})
