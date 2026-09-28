import { describe, expect, it, vi } from 'vitest'
import { isoDaysFromToday, localIsoDate, localIsoToday } from '../src/shared/dates'
import { normalizeDate } from '../src/shared/accounting'

// Ledger dates belong to the user's calendar day, not to the UTC instant.
// The old "new Date().toISOString().split('T')[0]" idiom returned the
// previous day during the first hours of the morning in UTC+ zones (South
// Africa runs UTC+2); these tests pin the local-calendar behaviour.
describe('local ISO date helpers', () => {
  it('localIsoDate round-trips the calendar fields the Date was built from', () => {
    const samples: Array<[number, number, number]> = [
      [2026, 3, 15],
      [2024, 12, 31],
      [2027, 1, 1],
      [2026, 2, 28],
    ]
    for (const [y, m, d] of samples) {
      for (const h of [0, 1, 12, 22, 23]) {
        const instant = new Date(y, m - 1, d, h, 30)
        const expected = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        expect(localIsoDate(instant)).toBe(expected)
      }
    }
  })

  it('localIsoToday returns the current local day under a frozen clock at 00:30', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 15, 0, 30))
    expect(localIsoToday()).toBe('2026-03-15')
    vi.useRealTimers()
  })

  it('isoDaysFromToday rolls across month and year boundaries locally', () => {
    expect(isoDaysFromToday(30, new Date(2026, 0, 20))).toBe('2026-02-19')
    expect(isoDaysFromToday(30, new Date(2026, 11, 15))).toBe('2027-01-14')
    expect(isoDaysFromToday(-1, new Date(2026, 2, 1))).toBe('2026-02-28')
  })

  it('normalizeDate falls back to the local day, not the UTC day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 15, 0, 30))
    expect(normalizeDate('')).toBe('2026-03-15')
    vi.useRealTimers()
  })
})
