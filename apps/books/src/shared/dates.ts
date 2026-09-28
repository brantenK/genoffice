// Local-calendar date helpers for Zano Books.
// A ledger date belongs to the user's calendar day, not to the UTC instant:
// the previous "new Date().toISOString().split('T')[0]" idiom produced the
// previous day during the first hours of the morning in UTC+ zones (South
// Africa runs UTC+2) and the next day late in the evening in UTC- zones.

/** Formats a Date using its local calendar fields, ISO YYYY-MM-DD. */
export function localIsoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** The local calendar day of `now`, in ISO YYYY-MM-DD form. */
export function localIsoToday(now: Date = new Date()): string {
  return localIsoDate(now)
}

/** The local calendar day `days` days from `now` (negative allowed), ISO form. */
export function isoDaysFromToday(days: number, now: Date = new Date()): string {
  const shifted = new Date(now)
  shifted.setDate(shifted.getDate() + days)
  return localIsoDate(shifted)
}
