// Tests for the duration/cost line under assistant answers (LKA-22).
import { describe, expect, it } from 'vitest'
import { formatCost, formatDuration, formatTurnMeta } from './turnMeta'

// Intl puts a no-break space between "US$" and the number.
const plain = (s: string | null): string | null => s && s.replace(/ /g, ' ')

describe('turn meta formatting', () => {
  it('formats durations in pt-BR', () => {
    expect(formatDuration(800)).toBe('0,8 s')
    expect(formatDuration(1240)).toBe('1,2 s')
    expect(formatDuration(12_400)).toBe('12 s')
    expect(formatDuration(59_600)).toBe('1 min 00 s')
    expect(formatDuration(125_000)).toBe('2 min 05 s')
    expect(formatDuration(3_725_000)).toBe('1 h 02 min')
  })

  it('formats costs in US dollars, pt-BR style', () => {
    expect(plain(formatCost(0.04))).toBe('US$ 0,04')
    expect(plain(formatCost(1.234))).toBe('US$ 1,23')
    expect(plain(formatCost(0.0031))).toBe('< US$ 0,01')
  })

  it('joins what the turn has and omits what it lacks', () => {
    expect(plain(formatTurnMeta({ durationMs: 12_000, costUsd: 0.04 }))).toBe('12 s · US$ 0,04')
    expect(formatTurnMeta({ durationMs: 3_000, interrupted: true })).toBe('3 s')
    expect(plain(formatTurnMeta({ costUsd: 0.1 }))).toBe('US$ 0,10')
    expect(formatTurnMeta({})).toBeNull()
    expect(formatTurnMeta(undefined)).toBeNull()
    expect(formatTurnMeta({ durationMs: 0, costUsd: 0 })).toBeNull()
  })
})
