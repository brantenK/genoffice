// Closing-date parsing + live countdown helpers.
// RFP closing dates arrive as raw extracted text like
// "30 November 2026 at 11:00", "2026-11-30", "30/11/2026 11:00" — this
// module turns that into a real Date, a live "closes in 3d 4h" label,
// and the recommended target submission time (24h before closing).
import { useEffect, useState } from 'react'

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
}

/** Recommended lead time: submit a full day before closing. */
export const SUBMIT_EARLY_HOURS = 24

function timeParts(s: string): { hours: number; minutes: number } | null {
  // "at 11:00", "11h00" (SA style), "11:00:30", "11.30 am"
  const m = s.match(/(?:at\s+)?(\d{1,2})\s*[:.h]\s*(\d{2})(?::\d{2})?\s*(am|pm)?/i)
  if (!m) return null
  let hours = parseInt(m[1], 10)
  const minutes = parseInt(m[2], 10)
  if (hours > 24 || minutes > 59) return null
  const mer = m[3]?.toLowerCase()
  if (mer === 'pm' && hours < 12) hours += 12
  if (mer === 'am' && hours === 12) hours = 0
  return { hours, minutes }
}

/**
 * Parse raw extracted closing-date text into a Date. Handles:
 *  - "30 November 2026 at 11:00"
 *  - "30 November 2026"
 *  - "2026-11-30 11:00" / ISO
 *  - "30/11/2026 (11:00)" / "30-11-2026"
 *  - "November 30, 2026 at 11:00"
 */
export function parseClosingDate(raw: string | null | undefined): Date | null {
  if (!raw) return null
  const s = raw.trim()
  if (s.length < 4 || s.length > 120) return null

  // strip trailing junk like "(late submissions will not be accepted)"
  const clean = s.replace(/[()].*?\)/g, ' ').replace(/\s{2,}/g, ' ').trim()

  // ISO / numeric YYYY-MM-DD
  let m = clean.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) {
    const t = timeParts(clean.slice(m.index! + m[0].length))
    const d = new Date(
      parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
      t?.hours ?? 23, t?.minutes ?? 59
    )
    return isNaN(d.getTime()) ? null : d
  }

  // "30 November 2026" / "30 Nov 2026"
  m = clean.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s*,?\s*(\d{4})/)
  if (m) {
    const month = MONTHS[m[2].toLowerCase()]
    if (month !== undefined) {
      const t = timeParts(clean.slice(m.index! + m[0].length))
      const d = new Date(parseInt(m[3], 10), month, parseInt(m[1], 10), t?.hours ?? 23, t?.minutes ?? 59)
      return isNaN(d.getTime()) ? null : d
    }
  }

  // "November 30, 2026" / "Nov 30 2026"
  m = clean.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})/)
  if (m) {
    const month = MONTHS[m[1].toLowerCase()]
    if (month !== undefined) {
      const t = timeParts(clean.slice(m.index! + m[0].length))
      const d = new Date(parseInt(m[3], 10), month, parseInt(m[2], 10), t?.hours ?? 23, t?.minutes ?? 59)
      return isNaN(d.getTime()) ? null : d
    }
  }

  // "30/11/2026" or "30-11-2026" (SA day-first convention)
  m = clean.match(/(\d{1,2})[/](\d{1,2})[/](\d{2,4})/)
  if (m) {
    const year = parseInt(m[3].length === 2 ? `20${m[3]}` : m[3], 10)
    const t = timeParts(clean.slice(m.index! + m[0].length))
    const d = new Date(year, parseInt(m[2], 10) - 1, parseInt(m[1], 10), t?.hours ?? 23, t?.minutes ?? 59)
    return isNaN(d.getTime()) ? null : d
  }

  // last resort: let Date try (returns NaN-safe null)
  const fallback = new Date(clean)
  return isNaN(fallback.getTime()) ? null : fallback
}

export type DeadlineUrgency = 'closed' | 'urgent' | 'soon' | 'comfortable'

export interface DeadlineStatus {
  date: Date | null
  urgency: DeadlineUrgency
  /** e.g. "3d 4h" or "2h 15m" or "Closed 5d ago" */
  countdownLabel: string
  /** "Mon, 30 Nov 2026, 11:00" */
  formatted: string
  /** target submission time (24h before closing), if date known */
  submitBy: Date | null
  /** true when now is inside the final 24h window */
  insideSubmitWindow: boolean
}

/** Human "3d 4h" / "4h 15m" / "12m" style delta. */
export function formatDelta(ms: number): string {
  const abs = Math.abs(ms)
  const mins = Math.floor(abs / 60_000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return `${days}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${mins % 60}m`
  return `${mins}m`
}

export function deadlineStatus(raw: string | null | undefined, now: Date = new Date()): DeadlineStatus {
  const date = parseClosingDate(raw)
  if (!date) {
    return {
      date: null,
      urgency: 'comfortable',
      countdownLabel: '',
      formatted: raw?.trim() ?? '',
      submitBy: null,
      insideSubmitWindow: false
    }
  }

  const diff = date.getTime() - now.getTime()
  const formatted = date.toLocaleString('en-ZA', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })

  if (diff <= 0) {
    return {
      date,
      urgency: 'closed',
      countdownLabel: `Closed ${formatDelta(diff)} ago`,
      formatted,
      submitBy: null,
      insideSubmitWindow: false
    }
  }

  const submitBy = new Date(date.getTime() - SUBMIT_EARLY_HOURS * 3_600_000)
  const insideSubmitWindow = now >= submitBy
  const urgency: DeadlineUrgency = diff < 7 * 86_400_000 ? 'urgent' : insideSubmitWindow ? 'soon' : 'comfortable'

  return {
    date,
    urgency,
    countdownLabel: `closes in ${formatDelta(diff)}`,
    formatted,
    submitBy,
    insideSubmitWindow
  }
}

/** Ticking clock hook — re-renders the caller every `intervalMs` (default 60s). */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/** Tailwind classes for the urgency badge. */
export function urgencyClasses(u: DeadlineUrgency): string {
  switch (u) {
    case 'closed':
      return 'bg-slate-200 text-slate-600'
    case 'urgent':
      return 'bg-red-100 text-red-700 ring-1 ring-red-200'
    case 'soon':
      return 'bg-amber-100 text-amber-800 ring-1 ring-amber-200'
    default:
      return 'bg-emerald-100 text-emerald-700'
  }
}
